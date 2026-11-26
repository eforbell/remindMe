'use strict';

// The dispatcher: turns due reminders into brrr pushes. Safe to run from several processes at once
// (the systemd timer and the web server both run it every minute) because every step claims rows:
//
//   1. Record due occurrences. Reminders whose cursor (next_fire_at) has passed are locked
//      (FOR UPDATE SKIP LOCKED). For each occurrence a delivery row is inserted per recipient
//      (unique per occurrence and recipient), and the cursor moves to the next occurrence, all in one
//      transaction. A crash before COMMIT records nothing; after COMMIT the deliveries exist.
//   2. Follow-up alerts ("Until acknowledged" re-alerts and snoozes, see lib/acks.js and
//      docs/plan-ack-and-snooze.md). A delivery whose cursor (follow_up_at) is due gets one new alert row
//      (alert_no = follow_ups + 1), and its cursor moves on, in one transaction. The alert is an ordinary
//      pending row, so it is never lost by being claimed before it is sent.
//   3. Send. Pending deliveries are claimed by switching them to 'sending' in one UPDATE. Each is sent,
//      then marked 'sent', or put back to 'pending' with a back-off until its give-up time, after which
//      it is 'failed'. A claim left behind by a process that died is taken over after CLAIM_STALE_MS.
//
// Delivery is at-least-once: if a process dies between brrr accepting a push and the row being marked
// sent, or a send times out after it got through, the push goes again. For a reminder, a rare duplicate
// beats a missed one. Every attempt at a delivery carries the same Idempotency-Key, so a gateway that
// honors it (Home Push) answers a retry "already sent" instead of pushing twice.
//
// After downtime, only the most recent missed occurrence of a reminder is sent (marked late), and only
// within the give-up window. Older ones are recorded as 'missed', so nobody gets a burst of stale pushes.
//
// Optional mirror (PUSH_MIRROR_URL, see lib/mirror.js): when a delivery is first attempted, a copy goes to
// a second brrr-compatible gateway for the members who have a mirror key. Each delivery is mirrored at most
// once (claimed by a conditional UPDATE of mirror_claimed_at) and the outcome is recorded on the delivery.
// The mirror never changes a delivery's status, retries or timing:
//   - sends never wait for their mirror; mirrors are settled once at the end of the pass, with a cap;
//   - mirror bookkeeping uses at most MIRROR_DB_SLOTS pool connections, each statement with server-side
//     lock and statement timeouts, so it can't starve or stall marking brrr sends as sent.

const crypto = require('crypto');
const brrr = require('./brrr');
const acks = require('./acks');
const mirror = require('./mirror');
const { withTransaction } = require('./db');
const schedule = require('./schedule');

const { core, zoned } = schedule;

const MINUTE = 60 * 1000;
const CLAIM_STALE_MS = 5 * MINUTE;
const LATE_AFTER_MS = 10 * MINUTE; // the timer can fire up to a minute late; beyond this, say "was due"
const SEND_BATCH = 10;
const MAX_STEPS_PER_REMINDER = 5000;
const MIRROR_DB_SLOTS = 2;      // of the pool's 8 connections, at most this many ever do mirror bookkeeping
const MIRROR_SETTLE_MS = 4000;  // end-of-pass wait for mirrors: 45 s budget + this stays inside shutdown's 50 s
const PRUNE_EVERY_MS = 6 * 60 * MINUTE;
const FOLLOW_UP_BATCH = 25;
const MIN_ALERT_WINDOW_MIN = 15;  // every follow-up alert gets at least this long to be sent (> CLAIM_STALE_MS)
const SNOOZE_WINDOW_MIN = 30;
// The newest migration this code needs. A pass started before the web service has applied it (the timer can
// run new code in that minute) does nothing, rather than claim rows it then can't send.
const REQUIRED_MIGRATION = '0006_ack_and_snooze.sql';

function defaultConfig(env = process.env) {
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  };
  return {
    giveUpMs: num(env.DELIVERY_GIVE_UP_HOURS, 12, 0.25, 72) * 60 * MINUTE,
    retentionDays: num(env.RETENTION_DAYS, 180, 7, 3650),
    // The tap-through link. Off unless TAP_OPENS_APP=true: a reminder has usually fired and gone by the time
    // it's tapped, so the app's home page doesn't show it. Without a link, Home Push shows the reminder itself.
    appPublicUrl: String(env.TAP_OPENS_APP || '').trim().toLowerCase() === 'true'
      ? String(env.APP_PUBLIC_URL || '').trim() || null
      : null,
    icon: brrr.iconUrl(env.BRRR_ICON_URL),
    mirrorUrl: mirror.mirrorUrl(env.PUSH_MIRROR_URL),
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
  const every = row.ack_required ? row.realert_every_min : null;
  const realertFor = row.ack_required ? row.realert_for_min : null;
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
      // send_key is generated here rather than by the column default, so a later PR can put the delivery's
      // action token (which is derived from it) into this payload, built before the row exists.
      const { rowCount } = await client.query(
        `INSERT INTO deliveries
           (reminder_id, occurrence_no, member_id, scheduled_for, payload, status, next_attempt_at, give_up_at, last_error,
            send_key, realert_every_min, realert_for_min)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (reminder_id, occurrence_no, member_id, alert_no) DO NOTHING`,
        [row.id, occ.no, member.id, occ.at, payload, sendable ? 'pending' : 'missed',
          sendable ? now : null, giveUpAt,
          sendable ? null : (index === due.length - 1 ? 'The scheduler was down past the give-up window.' : 'Skipped: a later reminder in the series was also due.'),
          crypto.randomUUID(), every, realertFor],
      );
      if (rowCount) { if (sendable) delivered += 1; else missed += 1; }
    }
    if (sendable) {
      // A newer sendable occurrence supersedes older first pushes still waiting to retry (only the latest is
      // worth sending). 'sending' too: the worker holding one then fails its send-time check.
      await client.query(
        `UPDATE deliveries SET status = 'missed', next_attempt_at = NULL, claim_token = NULL, claimed_at = NULL, updated_at = now(),
                last_error = 'Superseded: a later reminder in the series was due.'
          WHERE reminder_id = $1 AND occurrence_no < $2 AND alert_no = 0 AND status IN ('pending', 'sending')`,
        [row.id, occ.no],
      );
    }
  }

  // Any later occurrence, sent or missed, ends older deliveries' follow-ups (every member), and their unsent
  // follow-up alerts are missed. Older first pushes are left to the sendable-only rule above: a newer
  // occurrence recorded missed must not discard an older push that still has time to retry.
  const lastNo = due[due.length - 1].no;
  const { rows: older } = await client.query(
    `SELECT id FROM deliveries
      WHERE reminder_id = $1 AND occurrence_no < $2 AND alert_no = 0
        AND (follow_up_ended IS NULL OR follow_up_ended = 'expired')
      ORDER BY id`,
    [row.id, lastNo],
  );
  await acks.endFollowUps(client, older.map((d) => d.id), 'superseded', {
    unsentStatus: 'missed', note: 'Superseded: a later reminder in the series was due.',
  });

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

// Step 2 for one locked delivery (alert_no = 0) whose follow-up is due. Returns 'created' or 'expired'.
async function followUpOne(client, d, now) {
  const kind = d.follow_up_kind;
  const deadline = Math.min(
    new Date(d.follow_up_horizon).getTime(),
    kind === 'nag' ? new Date(d.follow_up_until).getTime() : Infinity,
  );
  // Too late (downtime): end it with no alert. Deadlines are hard: no nag is created after follow_up_until and
  // no alert after the horizon. Cursors are placed at least CURSOR_LEAD_MS before them, so only a pass delayed
  // by downtime lands here. Expiry is soft: it only stops new alerts.
  if (now.getTime() > deadline) {
    await acks.endFollowUps(client, [d.id], 'expired');
    return 'expired';
  }
  const alertNo = Number(d.follow_ups) + 1;
  const every = d.realert_every_min == null ? null : Number(d.realert_every_min);
  // Every alert gets at least MIN_ALERT_WINDOW_MIN to be sent, so none is created already expired and a claim
  // left by a dispatcher that died is recovered inside it. The horizon limits creating alerts, not sending them.
  const windowMin = kind === 'nag' ? Math.max(MIN_ALERT_WINDOW_MIN, every || 0) : SNOOZE_WINDOW_MIN;
  const giveUpAt = new Date(now.getTime() + windowMin * MINUTE);
  const due = zoned.toWall(new Date(d.scheduled_for), d.timezone);
  const payload = brrr.buildFollowUpPayload(d.payload, {
    kind, alertNo, wallTime: due.time, wallDate: due.date, today: zoned.toWall(now, d.timezone).date, expiresAt: giveUpAt,
  });
  await client.query(
    `INSERT INTO deliveries
       (reminder_id, occurrence_no, member_id, alert_no, alert_kind, scheduled_for, payload, status, next_attempt_at, give_up_at, send_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10)
     ON CONFLICT (reminder_id, occurrence_no, member_id, alert_no) DO NOTHING`,
    [d.reminder_id, d.occurrence_no, d.member_id, alertNo, kind, d.scheduled_for, payload, now, giveUpAt, crypto.randomUUID()],
  );
  // Older alerts not yet sent are missed, so a retrying alert never lands after its successor. One a worker
  // holds ('sending') can no longer be finished by it, and is never reclaimed.
  await client.query(
    `UPDATE deliveries SET status = 'missed', next_attempt_at = NULL, claim_token = NULL, claimed_at = NULL,
            last_error = 'A newer alert was due.', updated_at = now()
      WHERE reminder_id = $1 AND occurrence_no = $2 AND member_id = $3 AND alert_no BETWEEN 1 AND $4 - 1
        AND status IN ('pending', 'sending')`,
    [d.reminder_id, d.occurrence_no, d.member_id, alertNo],
  );
  // Move the cursor on, from now rather than from the old cursor: one alert after downtime, not a burst.
  // With "Until acknowledged" the next nag is due in `every` minutes; once that would pass follow_up_until the
  // cursor is cleared and the delivery is expired (soft: the alert just created, the last, still sends).
  // After a snooze on a normal reminder the cursor is simply cleared, so a later snooze is still possible.
  const next = every ? new Date(now.getTime() + every * MINUTE) : null;
  const more = next && next.getTime() <= new Date(d.follow_up_until).getTime() - acks.CURSOR_LEAD_MS;
  await client.query(
    `UPDATE deliveries SET follow_ups = $2, follow_up_at = $3, follow_up_kind = CASE WHEN $3::timestamptz IS NULL THEN follow_up_kind ELSE 'nag' END,
            follow_up_ended = CASE WHEN $4 THEN ${acks.END_SQL("'expired'")} ELSE follow_up_ended END, updated_at = now()
      WHERE id = $1`,
    [d.id, alertNo, more ? next : null, Boolean(every) && !more],
  );
  return 'created';
}

// Step 2: creates the follow-up alerts that are due. One transaction per batch. The SELECT locks each delivery
// and, with KEY SHARE, its reminder and member, all with SKIP LOCKED: inserting an alert takes foreign-key locks
// on those two, and delete and archive lock them before the deliveries, so waiting on either here could
// deadlock. Instead a delivery whose reminder or member is busy is skipped until the next pass, and the insert's
// foreign-key checks find locks this transaction already holds.
async function createFollowUps(pool, now, log = console) {
  let created = 0;
  let expired = 0;
  let errors = 0;
  const skip = new Set();
  for (;;) {
    const picked = await withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT d.*, r.timezone FROM deliveries d
           JOIN reminders r ON r.id = d.reminder_id
           JOIN family_members m ON m.id = d.member_id
          WHERE d.alert_no = 0 AND d.follow_up_at <= $1 AND d.acked_at IS NULL AND d.follow_up_ended IS NULL
            AND NOT (d.id = ANY($2::bigint[]))
          ORDER BY d.follow_up_at, d.id
          LIMIT ${FOLLOW_UP_BATCH}
          FOR UPDATE OF d SKIP LOCKED
          FOR KEY SHARE OF r, m SKIP LOCKED`,
        [now, [...skip]],
      );
      for (const d of rows) {
        await client.query('SAVEPOINT one_follow_up');
        try {
          const out = await followUpOne(client, d, now);
          await client.query('RELEASE SAVEPOINT one_follow_up');
          if (out === 'created') created += 1; else expired += 1;
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT one_follow_up');
          skip.add(String(d.id));
          errors += 1;
          log.error(`[dispatch] follow-up for delivery ${d.id} could not be created: ${err.message}`);
        }
      }
      return rows.length;
    });
    if (picked < FOLLOW_UP_BATCH) break;
  }
  return { follow_ups: created, follow_ups_expired: expired, followUpErrors: errors };
}

// Seconds the oldest follow-up alert that is due has been waiting to be sent, or 0. For the health check: a
// stalled send queue shows even while the heartbeat stays fresh.
async function followUpLag(pool, now = new Date()) {
  const { rows } = await pool.query(
    `SELECT min(next_attempt_at) AS oldest FROM deliveries
      WHERE alert_no > 0 AND status = 'pending' AND next_attempt_at <= $1`,
    [now],
  );
  return rows[0].oldest ? Math.max(0, Math.round((now - new Date(rows[0].oldest)) / 1000)) : 0;
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

// Marks the first push (alert_no = 0) sent and, in the same UPDATE, sets its deadlines (t0 = sent_at; COALESCE, so a
// snooze that came first keeps its own) and arms the first nag for "Until acknowledged". It arms only if nothing
// stopped the delivery meanwhile (Got it, supersession and cancellation are written in any status) and no
// follow-up has started yet (a snooze already set the cursor).
async function finishDelivery(pool, delivery, fields) {
  const now = fields.sent_at;
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 4}`).join(', ');
  const armed = 'realert_every_min IS NOT NULL AND acked_at IS NULL AND follow_up_ended IS NULL AND follow_up_at IS NULL AND follow_ups = 0';
  const { rowCount } = await pool.query(
    `UPDATE deliveries SET ${sets}, ${acks.DEADLINE_SQL('$3::timestamptz')},
            follow_up_at = CASE WHEN ${armed} THEN $3::timestamptz + make_interval(mins => realert_every_min) ELSE follow_up_at END,
            follow_up_kind = CASE WHEN ${armed} THEN 'nag' ELSE follow_up_kind END,
            claim_token = NULL, claimed_at = NULL, updated_at = now()
      WHERE id = $1 AND claim_token = $2 AND status = 'sending'`,
    [delivery.id, delivery.claim_token, now, ...keys.map((k) => fields[k])],
  );
  return rowCount === 1;
}

// A push that only gets through on a retry well after its time says so ("Was due …"), like one recorded late.
function latePayload(delivery, timezone, now) {
  const payload = delivery.payload;
  if (Number(delivery.alert_no) > 0) return payload; // a follow-up alert carries its own wording
  const scheduled = new Date(delivery.scheduled_for);
  if (now - scheduled <= LATE_AFTER_MS || String(payload.message || '').startsWith('Was due')) return payload;
  const due = zoned.toWall(scheduled, timezone);
  const today = zoned.toWall(now, timezone).date;
  const day = due.date === today ? '' : `${core.formatDateFriendly(due.date, today).replace(/^(Yesterday|Tomorrow)$/, (w) => w.toLowerCase())} `;
  return { ...payload, message: `Was due ${day}${payload.message}` };
}

// Mirror bookkeeping runs here: a short transaction on one of at most MIRROR_DB_SLOTS connections, with
// server-side timeouts, so a lock or a slow database can delay the mirror but never the brrr path.
let mirrorDbBusy = 0;
const mirrorDbWaiting = [];
async function withMirrorDb(pool, fn) {
  if (mirrorDbBusy >= MIRROR_DB_SLOTS) await new Promise((resolve) => mirrorDbWaiting.push(resolve));
  mirrorDbBusy += 1;
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SET LOCAL statement_timeout = '3s'");
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } finally {
    mirrorDbBusy -= 1;
    mirrorDbWaiting.shift()?.();
  }
}

// Mirrors one delivery, at most once ever. Never throws: the mirror must not affect the brrr delivery.
async function mirrorOnce(pool, delivery, payload, secret, base, mirrorImpl, log) {
  try {
    const claimed = await withMirrorDb(pool, async (c) => (await c.query(
      'UPDATE deliveries SET mirror_claimed_at = now() WHERE id = $1 AND mirror_claimed_at IS NULL RETURNING id',
      [delivery.id],
    )).rowCount === 1);
    if (!claimed) return 'skipped';
    let status = null;
    let id = null;
    let error = null;
    try {
      ({ status, id } = await mirrorImpl(base, secret, payload));
    } catch (err) {
      status = err?.status || null;
      error = mirror.redact(err?.message || err, secret);
    }
    // Two separate transactions: the delivery row is never held while waiting on any other lock, so
    // brrr marking the same delivery as sent waits at most for one single-row UPDATE.
    await withMirrorDb(pool, (c) => c.query(
      'UPDATE deliveries SET mirror_done_at = now(), mirror_status = $2, mirror_id = $3, mirror_error = $4 WHERE id = $1',
      [delivery.id, status, id || null, error],
    ));
    await withMirrorDb(pool, (c) => (error
      ? c.query('UPDATE member_mirror_channels SET last_error = $2, last_error_at = now() WHERE member_id = $1', [delivery.member_id, error])
      : c.query('UPDATE member_mirror_channels SET last_ok_at = now(), last_error = NULL, last_error_at = NULL WHERE member_id = $1', [delivery.member_id])));
    return error ? 'mirror_failed' : 'mirrored';
  } catch (err) {
    log.error(`[dispatch] mirror for delivery ${delivery.id}: ${mirror.redact(err.message, secret)}`);
    return 'mirror_failed';
  }
}

// The check made immediately before a row is handed to the push service, in one query: this worker still holds
// it (Got it, a snooze or a stop may have taken it since it was claimed), a follow-up alert's delivery is still
// open, the reminder isn't deleted, and the member is still one of its recipients (so a private reminder never
// goes to someone taken off it, even on a retry). Returns the send context, or why not to send.
async function sendCheck(pool, delivery) {
  const { rows } = await pool.query(
    `SELECT d.status = 'sending' AND d.claim_token = $2 AS owned,
            r.status AS reminder_status, r.timezone, m.archived_at,
            EXISTS (SELECT 1 FROM reminder_recipients rr WHERE rr.reminder_id = d.reminder_id AND rr.member_id = d.member_id) AS recipient,
            d.alert_no = 0 OR (d0.acked_at IS NULL AND d0.follow_up_ended IS DISTINCT FROM 'superseded'
                               AND d0.follow_up_ended IS DISTINCT FROM 'cancelled') AS open,
            c.target_secret, mc.target_secret AS mirror_secret
       FROM deliveries d
       JOIN reminders r ON r.id = d.reminder_id
       JOIN family_members m ON m.id = d.member_id
       LEFT JOIN deliveries d0 ON d0.reminder_id = d.reminder_id AND d0.occurrence_no = d.occurrence_no
                              AND d0.member_id = d.member_id AND d0.alert_no = 0
       LEFT JOIN member_notification_channels c ON c.member_id = d.member_id
       LEFT JOIN member_mirror_channels mc ON mc.member_id = d.member_id
      WHERE d.id = $1`,
    [delivery.id, delivery.claim_token],
  );
  const ctx = rows[0];
  if (!ctx || !ctx.owned) return { skip: 'lost' };
  if (ctx.reminder_status === 'deleted' || ctx.archived_at || !ctx.recipient || !ctx.open) return { skip: 'cancelled' };
  return { ctx };
}

async function sendOne(pool, delivery, now, { sendImpl, mirrorImpl, config, log, onMirror, clock }) {
  const { ctx, skip } = await sendCheck(pool, delivery);
  if (skip === 'lost') return 'lost'; // no longer ours: leave it alone
  if (skip) {
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
  const payload = latePayload(delivery, ctx.timezone, now);
  // Not awaited here: the pass settles all mirrors at its end, so the brrr path never waits on them.
  // Follow-up alerts are never mirrored: the mirror compares first pushes.
  if (config.mirrorUrl && ctx.mirror_secret && Number(delivery.alert_no) === 0) {
    onMirror(mirrorOnce(pool, delivery, payload, ctx.mirror_secret, config.mirrorUrl, mirrorImpl, log));
  }
  return sendBrrr(pool, delivery, ctx, payload, now, sendImpl, clock);
}

async function sendBrrr(pool, delivery, ctx, payload, now, sendImpl, clock) {
  try {
    // One random key per delivery row (send_key), the same on every attempt: a retry after a send that got
    // through but timed out is answered "already sent" by a gateway that honors it, instead of buzzing again.
    const res = await sendImpl(ctx.target_secret, payload, { idempotencyKey: `remind-me-${delivery.send_key}` });
    // One completion time for sent_at and, on a first push, the deadlines and the first nag.
    const fields = { status: 'sent', sent_at: clock(), next_attempt_at: null, response_status: res?.status || 200, last_error: null };
    const settled = Number(delivery.alert_no) === 0 ? await finishDelivery(pool, delivery, fields) : await finish(pool, delivery, fields);
    if (!settled) return 'lost';
    await pool.query('UPDATE member_notification_channels SET last_ok_at = now(), last_error = NULL, last_error_at = NULL WHERE member_id = $1', [delivery.member_id]);
    return 'sent';
  } catch (err) {
    const message = String(err?.message || err).slice(0, 300);
    const retryAt = new Date(now.getTime() + backoffMs(Number(delivery.attempts)));
    const giveUp = retryAt >= new Date(delivery.give_up_at);
    // The row and the member's channel error in one transaction, with one failure time. A Got it that would
    // mark this row sent locks it first, so it either sees this failure (and may clear the channel error it
    // wrote) or comes first, and then finish() updates nothing and no stale error is written back.
    const settled = await withTransaction(pool, async (client) => {
      const ok = await finish(client, delivery, {
        status: giveUp ? 'failed' : 'pending',
        next_attempt_at: giveUp ? null : retryAt,
        response_status: err?.status || null,
        last_error: message,
        last_failed_at: new Date(),
      });
      if (ok && ctx.target_secret) {
        await client.query(
          `UPDATE member_notification_channels c SET last_error = $2, last_error_at = d.last_failed_at
             FROM deliveries d WHERE c.member_id = $1 AND d.id = $3`,
          [delivery.member_id, message, delivery.id],
        );
      }
      return ok;
    });
    if (!settled) return 'lost';
    return giveUp ? 'failed' : 'retry';
  }
}

async function sendPending(pool, { now: clock, sendImpl, mirrorImpl, config, log, deadline, mirrors, shouldStop, afterClaim }) {
  const counts = { sent: 0, retry: 0, failed: 0, cancelled: 0, lost: 0, mirrored: 0, mirror_failed: 0 };
  const onMirror = (p) => mirrors.push(p.then((r) => { if (counts[r] != null) counts[r] += 1; }));
  // shouldStop: once shutdown begins, no new batch is claimed; only the batch in flight finishes, which is
  // bounded by the send timeout, so the process never exits between brrr accepting a push and marking it.
  while (Date.now() < deadline && !shouldStop()) {
    const now = clock();
    // Earliest give-up first. Among first pushes that is still scheduled order (give_up_at = scheduled_for +
    // DELIVERY_GIVE_UP_HOURS); a follow-up alert's window is short, so it goes ahead of an old backlog instead
    // of ageing out behind it.
    const { rows } = await pool.query(
      `UPDATE deliveries d
          SET status = 'sending', claimed_at = $1, claim_token = gen_random_uuid(), attempts = d.attempts + 1, updated_at = now()
         FROM (
           SELECT id FROM deliveries
            WHERE (status = 'pending' AND next_attempt_at <= $1)
               OR (status = 'sending' AND claimed_at < $2)
            ORDER BY give_up_at, id
            LIMIT ${SEND_BATCH}
            FOR UPDATE SKIP LOCKED
         ) pick
        WHERE d.id = pick.id
      RETURNING d.*`,
      [now, new Date(now.getTime() - CLAIM_STALE_MS)],
    );
    if (!rows.length) break;
    if (afterClaim) await afterClaim(rows); // tests: act between the claim and the send-time check
    const results = await Promise.all(rows.map((d) => sendOne(pool, d, now, { sendImpl, mirrorImpl, config, log, onMirror, clock }).catch((err) => {
      console.error(`[dispatch] delivery ${d.id}: ${err.message}`);
      return 'error';
    })));
    for (const r of results) if (counts[r] != null) counts[r] += 1;
  }
  return counts;
}

// Waits for this pass's mirrors, at most MIRROR_SETTLE_MS. One still in flight after that finishes on
// its own (or, in a one-shot timer run, is cut off: only the mirror's outcome is lost, never a brrr send).
async function settleMirrors(mirrors) {
  if (!mirrors.length) return;
  let timer;
  await Promise.race([
    Promise.allSettled(mirrors),
    new Promise((resolve) => { timer = setTimeout(resolve, MIRROR_SETTLE_MS); timer.unref?.(); }),
  ]);
  clearTimeout(timer);
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

async function schemaReady(pool) {
  const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [REQUIRED_MIGRATION]);
  return rows.length > 0;
}

// One full pass. `source` names who ran it ('timer' or 'web') for the health check.
async function runPass(pool, {
  source = 'manual',
  now = () => new Date(),
  sendImpl = brrr.send,
  mirrorImpl = mirror.send,
  config = defaultConfig(),
  budgetMs = 45 * 1000,
  log = console,
  shouldStop = () => false,
  afterClaim = null,
} = {}) {
  const started = now();
  const deadline = Date.now() + budgetMs;
  if (!(await schemaReady(pool))) {
    log.error(`[dispatch] waiting for migration ${REQUIRED_MIGRATION}; nothing done this pass`);
    return { at: started.toISOString(), source, waiting_for_migration: true };
  }
  // Recording and sending are independent: a failure in one must not stop the other (retries included).
  let recorded = { reminders: 0, delivered: 0, missed: 0, recordErrors: 0 };
  let recordError = null;
  try { recorded = await recordDueReminders(pool, started, config, log); } catch (err) { recordError = err; }
  let followUps = { follow_ups: 0, follow_ups_expired: 0, followUpErrors: 0 };
  try { followUps = await createFollowUps(pool, started, log); } catch (err) { log.error(`[dispatch] follow-ups failed: ${err.message}`); }
  const mirrors = [];
  const sent = await sendPending(pool, { now, sendImpl, mirrorImpl, config, log, deadline, mirrors, shouldStop, afterClaim });
  await settleMirrors(mirrors);
  let pruned = null;
  try { pruned = await pruneIfDue(pool, started, config); } catch (err) { log.error(`[dispatch] prune failed: ${err.message}`); }
  if (recordError) throw recordError; // no heartbeat: recording is broken, and the health check should say so
  await setConfig(pool, 'dispatch_last_run', JSON.stringify({ at: started.toISOString(), source }));
  return { at: started.toISOString(), source, ...recorded, ...followUps, ...sent, pruned };
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
    running = runPass(pool, { source: 'web', log, shouldStop: () => stopped, ...options })
      .then((s) => { if (s.reminders || s.follow_ups || s.followUpErrors || s.sent || s.retry || s.failed || s.missed || s.recordErrors || s.mirror_failed) log.log(`[dispatch] ${JSON.stringify(s)}`); })
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

module.exports = { runPass, startTicker, lastRun, followUpLag, defaultConfig, backoffMs, CLAIM_STALE_MS, LATE_AFTER_MS };
