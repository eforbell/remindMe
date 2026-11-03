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
  let firedCount = Number(row.fired_count);
  let cursor = { date: row.next_fire_date, at: new Date(row.next_fire_at) };
  const max = row.max_occurrences == null ? null : Number(row.max_occurrences);
  for (let i = 0; cursor && cursor.at <= now && i < MAX_STEPS_PER_REMINDER; i += 1) {
    due.push({ no: firedCount, date: cursor.date, at: cursor.at, isLast: max != null && firedCount === max - 1 });
    firedCount += 1;
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
  }

  const ended = cursor == null;
  await client.query(
    `UPDATE reminders
        SET fired_count = $2, next_fire_date = $3, next_fire_at = $4, last_fired_at = $5,
            status = CASE WHEN $6 THEN 'completed' ELSE status END,
            ended_at = CASE WHEN $6 THEN $7 ELSE ended_at END,
            version = version + 1, updated_at = $7
      WHERE id = $1`,
    [row.id, firedCount, cursor ? cursor.date : null, cursor ? cursor.at : null, due[due.length - 1].at, ended, now],
  );
  return { delivered, missed };
}

async function recordDueReminders(pool, now, config) {
  let delivered = 0;
  let missed = 0;
  let reminders = 0;
  for (;;) {
    const batch = await withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM reminders
          WHERE status = 'active' AND next_fire_at <= $1
          ORDER BY next_fire_at, id
          LIMIT 25
          FOR UPDATE SKIP LOCKED`,
        [now],
      );
      for (const row of rows) {
        const out = await recordDue(client, row, now, config);
        delivered += out.delivered;
        missed += out.missed;
      }
      return rows.length;
    });
    reminders += batch;
    if (batch < 25) break;
  }
  return { reminders, delivered, missed };
}

async function finish(pool, id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(`UPDATE deliveries SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
}

async function sendOne(pool, delivery, now, sendImpl) {
  const { rows } = await pool.query(
    `SELECT r.status AS reminder_status, m.archived_at, c.target_secret
       FROM deliveries d
       JOIN reminders r ON r.id = d.reminder_id
       JOIN family_members m ON m.id = d.member_id
       LEFT JOIN member_notification_channels c ON c.member_id = d.member_id
      WHERE d.id = $1`,
    [delivery.id],
  );
  const ctx = rows[0];
  if (!ctx || ctx.reminder_status === 'deleted' || ctx.archived_at) {
    await finish(pool, delivery.id, { status: 'cancelled', claimed_at: null, next_attempt_at: null });
    return 'cancelled';
  }
  if (now >= new Date(delivery.give_up_at)) {
    await finish(pool, delivery.id, {
      status: 'failed', claimed_at: null, next_attempt_at: null,
      last_error: delivery.last_error || 'Gave up: the give-up time passed before it could be sent.',
    });
    return 'failed';
  }
  try {
    const res = await sendImpl(ctx.target_secret, delivery.payload);
    await finish(pool, delivery.id, { status: 'sent', sent_at: new Date(), claimed_at: null, next_attempt_at: null, response_status: res?.status || 200, last_error: null });
    await pool.query('UPDATE member_notification_channels SET last_ok_at = now(), last_error = NULL, last_error_at = NULL WHERE member_id = $1', [delivery.member_id]);
    return 'sent';
  } catch (err) {
    const message = String(err?.message || err).slice(0, 300);
    const retryAt = new Date(now.getTime() + backoffMs(Number(delivery.attempts)));
    const giveUp = retryAt >= new Date(delivery.give_up_at);
    await finish(pool, delivery.id, {
      status: giveUp ? 'failed' : 'pending',
      next_attempt_at: giveUp ? null : retryAt,
      claimed_at: null,
      response_status: err?.status || null,
      last_error: message,
    });
    if (ctx.target_secret) {
      await pool.query('UPDATE member_notification_channels SET last_error = $2, last_error_at = now() WHERE member_id = $1', [delivery.member_id, message]);
    }
    return giveUp ? 'failed' : 'retry';
  }
}

async function sendPending(pool, { now: clock, sendImpl, deadline }) {
  const counts = { sent: 0, retry: 0, failed: 0, cancelled: 0 };
  while (Date.now() < deadline) {
    const now = clock();
    const { rows } = await pool.query(
      `UPDATE deliveries d
          SET status = 'sending', claimed_at = $1, attempts = d.attempts + 1, updated_at = now()
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
} = {}) {
  const started = now();
  const deadline = Date.now() + budgetMs;
  const recorded = await recordDueReminders(pool, started, config);
  const sent = await sendPending(pool, { now, sendImpl, deadline });
  const pruned = await pruneIfDue(pool, started, config);
  const summary = { at: started.toISOString(), source, ...recorded, ...sent, pruned };
  await setConfig(pool, 'dispatch_last_run', JSON.stringify({ at: started.toISOString(), source }));
  return summary;
}

// Runs a pass a few seconds after every minute boundary until stop() is called.
function startTicker(pool, { log = console, ...options } = {}) {
  let timer = null;
  let stopped = false;
  let running = false;
  const schedule = () => {
    if (stopped) return;
    const ms = MINUTE - (Date.now() % MINUTE) + 3000;
    timer = setTimeout(tick, ms);
    timer.unref?.();
  };
  const tick = async () => {
    if (running) return schedule();
    running = true;
    try {
      const s = await runPass(pool, { source: 'web', ...options });
      if (s.reminders || s.sent || s.retry || s.failed || s.missed) log.log(`[dispatch] ${JSON.stringify(s)}`);
    } catch (err) {
      log.error(`[dispatch] pass failed: ${err.message}`);
    } finally {
      running = false;
      schedule();
    }
  };
  schedule();
  return { stop() { stopped = true; clearTimeout(timer); } };
}

async function lastRun(pool) {
  const { rows } = await pool.query("SELECT value FROM app_config WHERE key = 'dispatch_last_run'");
  if (!rows[0]) return null;
  try { return JSON.parse(rows[0].value); } catch { return null; }
}

module.exports = { runPass, startTicker, lastRun, defaultConfig, backoffMs, CLAIM_STALE_MS, LATE_AFTER_MS };
