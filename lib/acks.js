'use strict';

// "Until acknowledged" and snooze: action tokens, Got it, snooze, and the stops that end a delivery's
// follow-up alerts. See docs/plan-ack-and-snooze.md.
//
// A delivery is one occurrence for one person (deliveries.alert_no = 0). Its follow-up alerts (alert_no >= 1)
// are re-alerts ("nag") and snooze alerts, created by the dispatcher from the delivery's cursor
// (follow_up_at). Everything here locks the delivery first and then its follow-up alerts, the same order the
// dispatcher uses, and never holds a lock across a network call.
//
// Tokens. A token lets whoever holds it see, acknowledge or snooze one delivery, as that delivery's own
// member, with no session: it is what a notification's tap link or action button carries.
//   token = base64url(send_key bytes) "." base64url(HMAC-SHA256(ack_key, "remind-me-ack:" + send_key)[0..16])
// Nothing per token is stored: checking one recomputes the MAC. Rotating ack_key in app_config kills them all.
// A token is a secret, like a push key: never in a URL path or query, a log line, or a response to anyone but
// its holder.

const crypto = require('crypto');
const { withTransaction } = require('./db');

const MINUTE = 60 * 1000;
const TOKEN_RE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/;
const TOKEN_GRACE_MS = 12 * 60 * MINUTE; // a token works until the delivery's horizon (or give-up) + this
const NO_ACK_HORIZON_MS = 12 * 60 * MINUTE; // a delivery without "Until acknowledged" can be snoozed this long
const ACK_HORIZON_EXTRA_MIN = 60;           // with it: snoozes may run this far past the last nag
const SNOOZE_MINUTES = [10, 30, 60];
// Deadlines are hard: no nag is created after follow_up_until, no alert of any kind after follow_up_horizon.
// A cursor is never set later than this before the deadline it must be created by, and the deadlines carry the
// same slack on top of the chosen duration. So the last nag of "every 15 for 1 h" is due at exactly 60 min, and a
// pass that starts up to a minute late still creates it; one still uncreated at the deadline (downtime) never is.
const CURSOR_LEAD_MIN = 2;
const CURSOR_LEAD_MS = CURSOR_LEAD_MIN * MINUTE;
const VIA = ['notification', 'link', 'app'];

// follow_up_ended for a stop: a final reason (acked, superseded, cancelled) is never replaced; the soft one
// (expired) is, so a Got it, a removed recipient or a newer occurrence after expiry is still recorded truthfully.
const END_SQL = (param) => `CASE WHEN follow_up_ended IN ('acked', 'superseded', 'cancelled') THEN follow_up_ended ELSE ${param} END`;

// Deadlines from a start time t0 (the first push being sent, or a snooze before that). Written with
// COALESCE, so whichever comes second never moves them. $t0 must be the SQL placeholder for t0.
const DEADLINE_SQL = (t0) => `
  follow_up_until = COALESCE(follow_up_until,
    CASE WHEN realert_every_min IS NOT NULL THEN ${t0} + make_interval(mins => realert_for_min + ${CURSOR_LEAD_MIN}) END),
  follow_up_horizon = COALESCE(follow_up_horizon,
    CASE WHEN realert_every_min IS NOT NULL THEN ${t0} + make_interval(mins => realert_for_min + ${CURSOR_LEAD_MIN + ACK_HORIZON_EXTRA_MIN})
         ELSE ${t0} + interval '${NO_ACK_HORIZON_MS / MINUTE} minutes' END)`;

class AckError extends Error {
  constructor(message, status = 400, code = 'invalid') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ── Tokens ──────────────────────────────────────────────────────────────────

// The signing key, from app_config. Migration 0006 creates it; if the row is ever missing (a wiped config),
// INSERT … ON CONFLICT DO NOTHING followed by a fresh read means concurrent callers all end up with the same one.
async function ackKey(db) {
  const read = async () => (await db.query("SELECT value FROM app_config WHERE key = 'ack_key'")).rows[0]?.value;
  let key = await read();
  if (!key) {
    await db.query(
      `INSERT INTO app_config (key, value) VALUES ('ack_key', $1) ON CONFLICT (key) DO NOTHING`,
      [crypto.randomBytes(32).toString('hex')],
    );
    key = await read();
  }
  return key;
}

function mac(key, sendKey) {
  return crypto.createHmac('sha256', key).update(`remind-me-ack:${sendKey}`).digest().subarray(0, 16);
}

function uuidBytes(sendKey) {
  const hex = String(sendKey).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('send_key is not a UUID');
  return Buffer.from(hex, 'hex');
}

function makeToken(key, sendKey) {
  return `${uuidBytes(sendKey).toString('base64url')}.${mac(key, String(sendKey).toLowerCase()).toString('base64url')}`;
}

// The send_key a well-formed, correctly signed token names, or null. Constant-time on the MAC.
function verifyToken(key, token) {
  const m = TOKEN_RE.exec(typeof token === 'string' ? token : '');
  if (!m || !key) return null;
  const raw = Buffer.from(m[1], 'base64url');
  const given = Buffer.from(m[2], 'base64url');
  if (raw.length !== 16 || given.length !== 16) return null;
  const hex = raw.toString('hex');
  const sendKey = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return crypto.timingSafeEqual(given, mac(key, sendKey)) ? sendKey : null;
}

// ── State ───────────────────────────────────────────────────────────────────

// What a holder of the token, or the app, is shown about one delivery.
function present(d, now) {
  const ended = d.follow_up_ended || null;
  const open = !d.acked_at && !ended;
  return {
    id: Number(d.id),
    reminder_id: d.reminder_id,
    member_id: d.member_id,
    title: d.payload?.title || '',
    scheduled_for: new Date(d.scheduled_for).toISOString(),
    ack_required: d.realert_every_min != null,
    alert_no: Number(d.follow_ups), // the latest alert: what "from" must be for a snooze to apply
    follow_ups: Number(d.follow_ups),
    acked_at: d.acked_at ? new Date(d.acked_at).toISOString() : null,
    acked_by: d.acked_by ?? null,
    ack_via: d.ack_via || null,
    ended,
    next_alert_at: d.follow_up_at ? new Date(d.follow_up_at).toISOString() : null,
    next_alert_kind: d.follow_up_at ? d.follow_up_kind : null,
    can_ack: !d.acked_at && !['superseded', 'cancelled'].includes(ended),
    can_snooze: open && (d.follow_up_horizon == null || new Date(d.follow_up_horizon).getTime() - CURSOR_LEAD_MS > now.getTime()),
  };
}

function tokenAlive(d, now) {
  if (['superseded', 'cancelled'].includes(d.follow_up_ended)) return false;
  const until = new Date(d.follow_up_horizon || d.give_up_at).getTime() + TOKEN_GRACE_MS;
  return now.getTime() < until;
}

// ── Stops ───────────────────────────────────────────────────────────────────

// Ends the follow-ups of the given deliveries (alert_no = 0 ids) for `reason` and, for a final reason, moves
// their unsent follow-up alerts (pending or sending) to `unsentStatus`. Two statements, delivery rows first,
// so the lock order is always delivery → its alerts. Applies whatever the delivery's own status is.
async function endFollowUps(client, ids, reason, { unsentStatus = 'cancelled', note = null } = {}) {
  if (!ids.length) return 0;
  const { rows } = await client.query(
    `UPDATE deliveries SET follow_up_at = NULL, follow_up_ended = ${END_SQL('$2')}, updated_at = now()
      WHERE id = ANY($1::bigint[]) AND alert_no = 0
      RETURNING reminder_id, occurrence_no, member_id`,
    [ids, reason],
  );
  if (reason !== 'expired') await cancelUnsentAlerts(client, rows, unsentStatus, note);
  return rows.length;
}

// Moves the unsent follow-up alerts (pending or sending) of these deliveries to `status`. A worker already
// holding one ('sending') loses it: its send-time check fails, finish() updates nothing (it requires
// 'sending'), and the stale-claim sweep never picks it up again.
async function cancelUnsentAlerts(client, deliveries, status = 'cancelled', note = null) {
  if (!deliveries.length) return;
  await client.query(
    `UPDATE deliveries f SET status = $4, next_attempt_at = NULL, claim_token = NULL, claimed_at = NULL,
            last_error = COALESCE($5, f.last_error), updated_at = now()
       FROM unnest($1::int[], $2::int[], $3::int[]) AS k(reminder_id, occurrence_no, member_id)
      WHERE f.reminder_id = k.reminder_id AND f.occurrence_no = k.occurrence_no AND f.member_id = k.member_id
        AND f.alert_no > 0 AND f.status IN ('pending', 'sending')`,
    [deliveries.map((d) => d.reminder_id), deliveries.map((d) => d.occurrence_no), deliveries.map((d) => d.member_id), status, note],
  );
}

// The first push, if still unsent, after a Got it or a snooze. It is cancelled, so it can't buzz during a snooze
// or after a Got it; except a token tap from the first push itself (from = 0) proves the push arrived and only
// the push service's answer was lost, so then it is marked sent.
async function settleFirstPush(client, d, { promote, now }) {
  if (!['pending', 'sending'].includes(d.status)) return;
  if (!promote) {
    await client.query(
      `UPDATE deliveries SET status = 'cancelled', next_attempt_at = NULL, claim_token = NULL, claimed_at = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('pending', 'sending')`,
      [d.id],
    );
    return;
  }
  await client.query(
    `UPDATE deliveries SET status = 'sent', sent_at = $2, next_attempt_at = NULL, claim_token = NULL, claimed_at = NULL,
            last_error = NULL, updated_at = now()
      WHERE id = $1 AND status IN ('pending', 'sending')`,
    [d.id, now],
  );
  // Clears the member's "last send failed" only if nothing failed after this row's own last failed attempt
  // (the failure path writes both in one transaction, with the same time). Compared in SQL: a JS Date would
  // drop the microseconds.
  await client.query(
    `UPDATE member_notification_channels SET last_ok_at = now(), last_error = NULL, last_error_at = NULL
      WHERE member_id = $1
        AND (last_error_at IS NULL OR last_error_at <= (SELECT last_failed_at FROM deliveries WHERE id = $2))`,
    [d.member_id, d.id],
  );
}

// Locks one delivery for a Got it or a snooze, after its reminder and the people it may touch (FOR KEY SHARE,
// people in id order): the same order as delete, edit and archive (reminder → member → delivery → its alerts).
// Writing a delivery takes foreign-key locks on both: writing acked_by locks the actor, and a row written twice in
// one transaction has its foreign keys checked again on the second write (PostgreSQL re-checks a row this
// transaction already changed), which locks its reminder and member. Taking those after the delivery could
// deadlock with delete or archive, which hold the reminder or person and then wait for the delivery. A
// delivery's reminder and member never change, so reading them unlocked first is safe.
async function lockDelivery(client, id, actor = null) {
  const { rows: found } = await client.query('SELECT reminder_id, member_id FROM deliveries WHERE id = $1 AND alert_no = 0', [id]);
  if (!found[0]) return null;
  await client.query('SELECT id FROM reminders WHERE id = $1 FOR KEY SHARE', [found[0].reminder_id]);
  const people = [...new Set([found[0].member_id, actor].filter((m) => m != null).map(Number))].sort((a, b) => a - b);
  await client.query('SELECT id FROM family_members WHERE id = ANY($1::int[]) ORDER BY id FOR KEY SHARE', [people]);
  const { rows } = await client.query('SELECT * FROM deliveries WHERE id = $1 AND alert_no = 0 FOR UPDATE', [id]);
  return rows[0] || null;
}

// ── Got it ──────────────────────────────────────────────────────────────────

// Records Got it on one delivery, in any status (a Got it during the first send, or after expiry, counts).
// Answers recorded, already (a replay keeps the first actor and time) or gone (superseded or cancelled).
// who: the member acknowledging (the delivery's own, or the reminder's creator from the app).
// promote: the tap came from the first push itself (token, from = 0); see settleFirstPush.
async function ack(pool, { deliveryId, who, via, promote = false, now = new Date() }) {
  if (!VIA.includes(via)) throw new AckError('Unknown acknowledgement source.');
  return withTransaction(pool, async (client) => {
    const d = await lockDelivery(client, deliveryId, who);
    if (!d || ['superseded', 'cancelled'].includes(d.follow_up_ended)) return { result: 'gone' };
    if (d.acked_at) return { result: 'already', delivery: present(d, now) };
    const { rows } = await client.query(
      `UPDATE deliveries SET acked_at = $2, acked_by = $3, ack_via = $4,
              follow_up_at = NULL, follow_up_ended = 'acked', updated_at = now()
        WHERE id = $1 AND acked_at IS NULL
          AND follow_up_ended IS DISTINCT FROM 'superseded' AND follow_up_ended IS DISTINCT FROM 'cancelled'
      RETURNING *`,
      [d.id, now, who ?? null, via],
    );
    await cancelUnsentAlerts(client, [d]);
    await settleFirstPush(client, d, { promote, now });
    return { result: 'recorded', delivery: present(rows[0], now) };
  });
}

// ── Snooze ──────────────────────────────────────────────────────────────────

// Snoozes one delivery: one more alert `minutes` from now (10, 30 or 60), never past its horizon.
// from: the alert_no the person snoozed from. It applies only from the latest alert, and only while the
// delivery is open (not acknowledged, stopped or expired: an expired delivery is never reopened).
// Answers snoozed (with the time), already (acknowledged), gone, or stale (with the current state).
async function snooze(pool, { deliveryId, minutes, from, promote = false, now = new Date() }) {
  const mins = Number(minutes);
  if (!SNOOZE_MINUTES.includes(mins)) throw new AckError('Snooze for 10, 30 or 60 minutes.');
  const fromNo = parseAlertNo(from);
  if (fromNo == null) throw new AckError('Say which alert this snooze is from.');
  return withTransaction(pool, async (client) => {
    const d = await lockDelivery(client, deliveryId);
    if (!d || ['superseded', 'cancelled'].includes(d.follow_up_ended)) return { result: 'gone' };
    if (d.acked_at) return { result: 'already', delivery: present(d, now) };
    // Replay of the snooze already pending: nothing moves, so a retry after a lost answer never pushes it on.
    if (d.follow_up_at && d.follow_up_kind === 'snooze' && Number(d.snoozed_from) === fromNo && fromNo === Number(d.follow_ups)) {
      return { result: 'snoozed', until: new Date(d.follow_up_at).toISOString(), delivery: present(d, now) };
    }
    if (d.follow_up_ended || fromNo !== Number(d.follow_ups)) return { result: 'stale', delivery: present(d, now) };
    if (d.follow_up_horizon && now.getTime() >= new Date(d.follow_up_horizon).getTime() - CURSOR_LEAD_MS) {
      return { result: 'stale', delivery: present(d, now) };
    }
    const { rows } = await client.query(
      `UPDATE deliveries SET ${DEADLINE_SQL('$2::timestamptz')}, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [d.id, now],
    );
    // Never closer to the horizon than CURSOR_LEAD_MS, so the pass that finds it (up to a minute late) still
    // creates it before the horizon, which is a hard limit.
    const latest = new Date(rows[0].follow_up_horizon).getTime() - CURSOR_LEAD_MS; // > now: checked above
    const at = new Date(Math.min(now.getTime() + mins * MINUTE, latest));
    const { rows: [after] } = await client.query(
      `UPDATE deliveries SET follow_up_at = $2, follow_up_kind = 'snooze', snoozed_from = $3, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [d.id, at, fromNo],
    );
    await cancelUnsentAlerts(client, [d]);
    await settleFirstPush(client, d, { promote, now });
    return { result: 'snoozed', until: at.toISOString(), delivery: present(after, now) };
  });
}

// An alert number from a request: a non-negative integer, or a string of digits. Anything else is null; never
// coerced, since Number(null), Number('') and Number(false) are all 0, the first push.
function parseAlertNo(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 32767 ? value : null;
  if (typeof value === 'string' && /^\d{1,5}$/.test(value)) return Number(value) <= 32767 ? Number(value) : null;
  return null;
}

// ── By token ────────────────────────────────────────────────────────────────

// The delivery a token names, if the token is genuine and still alive. Acts as that delivery's own member.
async function deliveryForToken(db, token, now) {
  const sendKey = verifyToken(await ackKey(db), token);
  if (!sendKey) return null;
  // Only while its member is still one of the reminder's recipients and the reminder exists: a token in the hands
  // of someone taken off a private reminder must not keep showing its title.
  const { rows } = await db.query(
    `SELECT d.* FROM deliveries d JOIN reminders r ON r.id = d.reminder_id AND r.status <> 'deleted'
      WHERE d.send_key = $1 AND d.alert_no = 0
        AND EXISTS (SELECT 1 FROM reminder_recipients rr WHERE rr.reminder_id = d.reminder_id AND rr.member_id = d.member_id)`,
    [sendKey],
  );
  const d = rows[0];
  return d && tokenAlive(d, now) ? d : null;
}

// POST /api/ack: { token, action: 'peek' | 'ack' | 'snooze', minutes?, from? }. Anything wrong with the token
// answers `gone`, so the answer never says whether a delivery exists.
async function byToken(pool, { token, action, minutes, from, via = 'notification', now = new Date() }) {
  if (!['peek', 'ack', 'snooze'].includes(action)) throw new AckError('Unknown action.');
  if (!['notification', 'link'].includes(via)) throw new AckError('Unknown acknowledgement source.');
  const d = await deliveryForToken(pool, token, now);
  if (!d) return { result: 'gone' };
  const fromNo = parseAlertNo(from);
  const promote = fromNo === 0;
  if (action === 'peek') return { result: 'ok', delivery: present(d, now) };
  if (action === 'ack') return ack(pool, { deliveryId: d.id, who: d.member_id, via, promote, now });
  return snooze(pool, { deliveryId: d.id, minutes, from: fromNo, promote, now });
}

module.exports = {
  ackKey, makeToken, verifyToken, present, tokenAlive,
  endFollowUps, cancelUnsentAlerts, ack, snooze, byToken, deliveryForToken,
  AckError, END_SQL, DEADLINE_SQL, SNOOZE_MINUTES, TOKEN_GRACE_MS, CURSOR_LEAD_MS, parseAlertNo,
};
