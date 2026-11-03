'use strict';

// The dispatcher: turns due reminders into brrr pushes. Safe to run from several processes at once
// (the systemd timer and the web server both run it every minute) because every step claims rows:
//
//   1. Record due occurrences. Reminders whose cursor (next_fire_at) has passed are locked
//      (FOR UPDATE SKIP LOCKED). For each occurrence a delivery row is inserted per recipient
//      (unique per occurrence and recipient), and the cursor moves to the next occurrence, all in one
//      transaction. A crash before COMMIT records nothing; after COMMIT the deliveries exist.
//   2. Send. Pending deliveries are claimed by switching them to 'sending' in one UPDATE. Each is sent,
//      then marked 'sent', or put back to 'pending' with a back-off until its give-up time, after which
//      it is 'failed'. A claim left behind by a process that died is taken over after CLAIM_STALE_MS.
//
// Delivery is at-least-once: if a process dies between brrr accepting a push and the row being marked
// sent, the push goes again. For a reminder, a rare duplicate beats a missed one.
//
// After downtime, only the most recent missed occurrence of a reminder is sent (marked late), and only
// within the give-up window. Older ones are recorded as 'missed', so nobody gets a burst of stale pushes.

const brrr = require('./brrr');
const { withTransaction } = require('./db');
const schedule = require('./schedule');

const { core, zoned } = schedule;

const MINUTE = 60 * 1000;
const CLAIM_STALE_MS = 5 * MINUTE;
const LATE_AFTER_MS = 10 * MINUTE; // the timer can fire up to a minute late; beyond this, say "was due"
const SEND_BATCH = 10;
const MAX_STEPS_PER_REMINDER = 5000;
const PRUNE_EVERY_MS = 6 * 60 * MINUTE;

function defaultConfig(env = process.env) {
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  };
  return {
    giveUpMs: num(env.DELIVERY_GIVE_UP_HOURS, 12, 0.25, 72) * 60 * MINUTE,
    retentionDays: num(env.RETENTION_DAYS, 180, 7, 3650),
    appPublicUrl: String(env.APP_PUBLIC_URL || '').trim() || null,
    icon: brrr.iconUrl(env.BRRR_ICON_URL),
  };
}

// Back-off after the n-th failed attempt: 1, 2, 4, 8, 16, 32, then every 60 minutes.
function backoffMs(attempts) {
  return Math.min(60, 2 ** Math.max(0, attempts - 1)) * MINUTE;
}

async function recipientsOf(client, reminderId) {
  const { rows } = await client.query(
    `SELECT m.id, m.name
       FROM reminder_recipients rr
       JOIN family_members m ON m.id = rr.member_id AND m.archived_at IS NULL
      WHERE rr.reminder_id = $1
      ORDER BY m.id`,
    [reminderId],
  );
  return rows;
}

// Step 1 for one locked reminder row.
async function recordDue(client, row, now, config) {
  const due = [];
  let firedCount = Number(row.fired_count); // position in the current series (for its count)
  let seq = Number(row.occurrence_seq); // the delivery identity: never reused, even after a restart
  let cursor = { date: row.next_fire_date, at: new Date(row.next_fire_at) };
  const max = row.max_occurrences == null ? null : Number(row.max_occurrences);
  for (let i = 0; cursor && cursor.at <= now && i < MAX_STEPS_PER_REMINDER; i += 1) {
    due.push({ no: seq, date: cursor.date, at: cursor.at, isLast: max != null && firedCount === max - 1 });
    firedCount += 1;
    seq += 1;
    cursor = max != null && firedCount >= max ? null : schedule.nextAfter(row, cursor.date);
  }
  if (!due.length) return { delivered: 0, missed: 0 };

  const recipients = await recipientsOf(client, row.id);
  let creatorName = null;
  if (row.created_by != null) {
    const { rows } = await client.query('SELECT name FROM family_members WHERE id = $1', [row.created_by]);
    creatorName = rows[0]?.name || null;
  }
  const today = zoned.toWall(now, row.timezone).date;
  const time = schedule.hhmm(row.time_of_day);
  let delivered = 0;
  let missed = 0;

  for (const [index, occ] of due.entries()) {
    const giveUpAt = new Date(occ.at.getTime() + config.giveUpMs);
    const sendable = index === due.length - 1 && now < giveUpAt;
    for (const member of recipients) {
      const payload = brrr.buildPayload({
        text: row.text,
        level: row.level,
        wallTime: time,
        wallDate: occ.date,
        today,
        late: now - occ.at > LATE_AFTER_MS,
        fromName: creatorName && row.created_by !== member.id ? creatorName : null,
        isLast: occ.isLast && row.freq !== 'once',
        threadId: `remind-me-${row.id}`,
        openUrl: config.appPublicUrl,
        expiresAt: giveUpAt,
        icon: config.icon,
      });
      const { rowCount } = await client.query(
        `INSERT INTO deliveries
           (reminder_id, occurrence_no, member_id, scheduled_for, payload, status, next_attempt_at, give_up_at, last_error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (reminder_id, occurrence_no, member_id) DO NOTHING`,
        [row.id, occ.no, member.id, occ.at, payload, sendable ? 'pending' : 'missed',
          sendable ? now : null, giveUpAt,
          sendable ? null : (index === due.length - 1 ? 'The scheduler was down past the give-up window.' : 'Skipped: a later reminder in the series was also due.')],
      );
      if (rowCount) { if (sendable) delivered += 1; else missed += 1; }
    }
    if (sendable) {
      // A newer occurrence supersedes older ones still waiting to retry (only the latest is worth sending).
      await client.query(
        `UPDATE deliveries SET status = 'missed', next_attempt_at = NULL, updated_at = now(),
                last_error = 'Superseded: a later reminder in the series was due.'
          WHERE reminder_id = $1 AND occurrence_no < $2 AND status = 'pending'`,
        [row.id, occ.no],
      );
    }
  }

  const ended = cursor == null;
  await client.query(
    `UPDATE reminders
        SET fired_count = $2, occurrence_seq = $8, next_fire_date = $3, next_fire_at = $4, last_fired_at = $5,
            status = CASE WHEN $6 THEN 'completed' ELSE status END,
            ended_at = CASE WHEN $6 THEN $7 ELSE ended_at END,
            version = version + 1, updated_at = $7
      WHERE id = $1`,
    [row.id, firedCount, cursor ? cursor.date : null, cursor ? cursor.at : null, due[due.length - 1].at, ended, now, seq],
  );
  return { delivered, missed };
}

// Each reminder is recorded inside its own savepoint, so one that throws (a bug, bad data) is logged and
// skipped without blocking the rest of its batch; it stays due and is tried again next pass.
async function recordDueReminders(pool, now, config, log = console) {
  let delivered = 0;
  let missed = 0;
  let reminders = 0;
  let errors = 0;
  const skip = new Set();
  for (;;) {
    const { recorded, picked } = await withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM reminders
          WHERE status = 'active' AND next_fire_at <= $1 AND NOT (id = ANY($2::int[]))
          ORDER BY next_fire_at, id
          LIMIT 25
          FOR UPDATE SKIP LOCKED`,
        [now, [...skip]],
      );
      let ok = 0;
      for (const row of rows) {
        await client.query('SAVEPOINT one_reminder');
        try {
          const out = await recordDue(client, row, now, config);
          await client.query('RELEASE SAVEPOINT one_reminder');
          delivered += out.delivered;
          missed += out.missed;
          ok += 1;
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT one_reminder');
          skip.add(row.id);
          errors += 1;
          log.error(`[dispatch] reminder ${row.id} could not be recorded: ${err.message}`);
        }
      }
      return { recorded: ok, picked: rows.length };
    });
    reminders += recorded;
    if (picked < 25) break;
  }
  return { reminders, delivered, missed, recordErrors: errors };
}

// Settles a claimed delivery, but only if this process still holds the claim: a process that stalled
// past CLAIM_STALE_MS and lost the row to another must not overwrite the other's result.
// Returns true when the row was updated.
async function finish(pool, delivery, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  const { rowCount } = await pool.query(
    `UPDATE deliveries SET ${sets}, claim_token = NULL, claimed_at = NULL, updated_at = now()
      WHERE id = $1 AND claim_token = $2 AND status = 'sending'`,
    [delivery.id, delivery.claim_token, ...keys.map((k) => fields[k])],
  );
  return rowCount === 1;
}

// A push that only gets through on a retry well after its time says so ("Was due …"), like one recorded late.
function latePayload(delivery, timezone, now) {
  const payload = delivery.payload;
  const scheduled = new Date(delivery.scheduled_for);
  if (now - scheduled <= LATE_AFTER_MS || String(payload.message || '').startsWith('Was due')) return payload;
  const due = zoned.toWall(scheduled, timezone);
  const today = zoned.toWall(now, timezone).date;
  const day = due.date === today ? '' : `${core.formatDateFriendly(due.date, today).replace(/^(Yesterday|Tomorrow)$/, (w) => w.toLowerCase())} `;
  return { ...payload, message: `Was due ${day}${payload.message}` };
}

async function sendOne(pool, delivery, now, sendImpl) {
  const { rows } = await pool.query(
    `SELECT r.status AS reminder_status, r.timezone, m.archived_at, c.target_secret
       FROM deliveries d
       JOIN reminders r ON r.id = d.reminder_id
       JOIN family_members m ON m.id = d.member_id
       LEFT JOIN member_notification_channels c ON c.member_id = d.member_id
      WHERE d.id = $1`,
    [delivery.id],
  );
  const ctx = rows[0];
  if (!ctx || ctx.reminder_status === 'deleted' || ctx.archived_at) {
    await finish(pool, delivery, { status: 'cancelled', next_attempt_at: null });
    return 'cancelled';
  }
  if (now >= new Date(delivery.give_up_at)) {
    await finish(pool, delivery, {
      status: 'failed', next_attempt_at: null,
      last_error: delivery.last_error || 'Gave up: the give-up time passed before it could be sent.',
    });
    return 'failed';
  }
  try {
    const res = await sendImpl(ctx.target_secret, latePayload(delivery, ctx.timezone, now));
    if (!(await finish(pool, delivery, { status: 'sent', sent_at: new Date(), next_attempt_at: null, response_status: res?.status || 200, last_error: null }))) return 'lost';
    await pool.query('UPDATE member_notification_channels SET last_ok_at = now(), last_error = NULL, last_error_at = NULL WHERE member_id = $1', [delivery.member_id]);
    return 'sent';
  } catch (err) {
    const message = String(err?.message || err).slice(0, 300);
    const retryAt = new Date(now.getTime() + backoffMs(Number(delivery.attempts)));
    const giveUp = retryAt >= new Date(delivery.give_up_at);
    const settled = await finish(pool, delivery, {
      status: giveUp ? 'failed' : 'pending',
      next_attempt_at: giveUp ? null : retryAt,
      response_status: err?.status || null,
      last_error: message,
    });
    if (!settled) return 'lost';
    if (ctx.target_secret) {
      await pool.query('UPDATE member_notification_channels SET last_error = $2, last_error_at = now() WHERE member_id = $1', [delivery.member_id, message]);
    }
    return giveUp ? 'failed' : 'retry';
  }
}

async function sendPending(pool, { now: clock, sendImpl, deadline }) {
  const counts = { sent: 0, retry: 0, failed: 0, cancelled: 0, lost: 0 };
  while (Date.now() < deadline) {
    const now = clock();
    const { rows } = await pool.query(
      `UPDATE deliveries d
          SET status = 'sending', claimed_at = $1, claim_token = gen_random_uuid(), attempts = d.attempts + 1, updated_at = now()
         FROM (
           SELECT id FROM deliveries
            WHERE (status = 'pending' AND next_attempt_at <= $1)
               OR (status = 'sending' AND claimed_at < $2)
            ORDER BY scheduled_for, id
            LIMIT ${SEND_BATCH}
            FOR UPDATE SKIP LOCKED
         ) pick
        WHERE d.id = pick.id
      RETURNING d.*`,
      [now, new Date(now.getTime() - CLAIM_STALE_MS)],
    );
    if (!rows.length) break;
    const results = await Promise.all(rows.map((d) => sendOne(pool, d, now, sendImpl).catch((err) => {
      console.error(`[dispatch] delivery ${d.id}: ${err.message}`);
      return 'error';
    })));
    for (const r of results) if (counts[r] != null) counts[r] += 1;
  }
  return counts;
}

async function setConfig(pool, key, value) {
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

async function pruneIfDue(pool, now, config) {
  const { rows } = await pool.query("SELECT value FROM app_config WHERE key = 'last_prune_at'");
  const last = rows[0] ? new Date(rows[0].value) : null;
  if (last && now - last < PRUNE_EVERY_MS) return null;
  const cutoff = new Date(now.getTime() - config.retentionDays * 24 * 60 * MINUTE);
  const d = await pool.query(
    "DELETE FROM deliveries WHERE status IN ('sent', 'failed', 'missed', 'cancelled') AND scheduled_for < $1",
    [cutoff],
  );
  const r = await pool.query(
    "DELETE FROM reminders WHERE status IN ('completed', 'deleted') AND updated_at < $1",
    [cutoff],
  );
  await setConfig(pool, 'last_prune_at', now.toISOString());
  return { deliveries: d.rowCount, reminders: r.rowCount };
}

// One full pass. `source` names who ran it ('timer' or 'web') for the health check.
async function runPass(pool, {
  source = 'manual',
  now = () => new Date(),
  sendImpl = brrr.send,
  config = defaultConfig(),
  budgetMs = 45 * 1000,
  log = console,
} = {}) {
  const started = now();
  const deadline = Date.now() + budgetMs;
  // Recording and sending are independent: a failure in one must not stop the other (retries included).
  let recorded = { reminders: 0, delivered: 0, missed: 0, recordErrors: 0 };
  let recordError = null;
  try { recorded = await recordDueReminders(pool, started, config, log); } catch (err) { recordError = err; }
  const sent = await sendPending(pool, { now, sendImpl, deadline });
  let pruned = null;
  try { pruned = await pruneIfDue(pool, started, config); } catch (err) { log.error(`[dispatch] prune failed: ${err.message}`); }
  if (recordError) throw recordError; // no heartbeat: recording is broken, and the health check should say so
  await setConfig(pool, 'dispatch_last_run', JSON.stringify({ at: started.toISOString(), source }));
  return { at: started.toISOString(), source, ...recorded, ...sent, pruned };
}

// Runs a pass a few seconds after every minute boundary until stop() is called.
function startTicker(pool, { log = console, ...options } = {}) {
  let timer = null;
  let stopped = false;
  let running = null; // the in-flight pass, if any
  const schedule = () => {
    if (stopped) return;
    const ms = MINUTE - (Date.now() % MINUTE) + 3000;
    timer = setTimeout(tick, ms);
    timer.unref?.();
  };
  const tick = async () => {
    if (running || stopped) return schedule();
    running = runPass(pool, { source: 'web', log, ...options })
      .then((s) => { if (s.reminders || s.sent || s.retry || s.failed || s.missed || s.recordErrors) log.log(`[dispatch] ${JSON.stringify(s)}`); })
      .catch((err) => log.error(`[dispatch] pass failed: ${err.message}`));
    await running;
    running = null;
    schedule();
  };
  schedule();
  // stop() resolves once any pass in flight has finished, so shutdown never cuts a send off between brrr
  // accepting it and the row being marked sent (which would mean a duplicate later).
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      return running || Promise.resolve();
    },
  };
}

async function lastRun(pool) {
  const { rows } = await pool.query("SELECT value FROM app_config WHERE key = 'dispatch_last_run'");
  if (!rows[0]) return null;
  try { return JSON.parse(rows[0].value); } catch { return null; }
}

module.exports = { runPass, startTicker, lastRun, defaultConfig, backoffMs, CLAIM_STALE_MS, LATE_AFTER_MS };
