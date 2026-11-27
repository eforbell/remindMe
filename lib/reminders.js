'use strict';

const { withTransaction } = require('./db');
const schedule = require('./schedule');
const acks = require('./acks');

const { core, zoned } = schedule;

const MAX_TEXT = 120;
const MAX_RECIPIENTS = 20;
// A bounded series is "ending" once its last reminder is this close: 3 days for daily and weekly,
// a week for monthly and yearly (so there is time to act on the prompt).
const ENDING_SOON_MS = { daily: 3, weekly: 3, monthly: 7, yearly: 7 };
const DAY_MS = 24 * 60 * 60 * 1000;
const ENDED_PROMPT_MS = 7 * 24 * 60 * 60 * 1000;
const VISIBILITIES = ['private', 'family'];
// "Until acknowledged": re-alert every N minutes, give up after M (docs/plan-ack-and-snooze.md).
const REALERT_EVERY = [5, 10, 15, 30];
const REALERT_FOR = [60, 240, 720];
const DEFAULT_REALERT = { every: 15, for: 240 };
const WAITING_EXPIRED_MS = 12 * 60 * 60 * 1000; // "not acknowledged" stays on the card this long
const WAITING_RECENT_MS = 30 * 60 * 1000;       // a normal reminder stays snoozable this long after it went off

// Who sees a reminder (the viewer: the person asking, or null when this device hasn't said who it is).
// A 'family' reminder: everyone. A 'private' one: who set it and the people it reminds. Seeing one is what
// lets you change it, as before. Functions here take `viewer`; leaving it out (undefined) means unscoped,
// for internal callers and tests: every route passes one.
//
// visibleSql('r', '$2') is that rule as SQL for reminder alias r, the viewer bound at $2 (NULL matches only
// family reminders).
function visibleSql(alias, param) {
  return `(${alias}.visibility = 'family' OR ${alias}.created_by = ${param}::int
    OR EXISTS (SELECT 1 FROM reminder_recipients vr WHERE vr.reminder_id = ${alias}.id AND vr.member_id = ${param}::int))`;
}
const scoped = (viewer) => viewer !== undefined;

async function assertVisible(client, row, viewer) {
  if (!scoped(viewer) || row.visibility === 'family') return;
  if (viewer != null && row.created_by === viewer) return;
  if (viewer != null) {
    const { rowCount } = await client.query('SELECT 1 FROM reminder_recipients WHERE reminder_id = $1 AND member_id = $2', [row.id, viewer]);
    if (rowCount) return;
  }
  throw new InputError('That reminder no longer exists.', 404, 'not_found');
}

class InputError extends Error {
  constructor(message, status = 400, code = 'invalid') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// The suggestion key for a reminder text: lower case, no trailing punctuation.
function suggestionKey(text) {
  return cleanText(text).toLowerCase().replace(/[.!?…]+$/u, '').trim();
}

// Validates a create/update body against the household time zone. `count` is how many reminders are
// still to come, the next one included (null: until deleted).
async function parseInput(client, body, { timezone, now, forUpdate = false }) {
  const text = cleanText(body?.text);
  if (!text) throw new InputError('Say what the reminder is for.');
  if (text.length > MAX_TEXT) throw new InputError(`Keep the reminder under ${MAX_TEXT} characters.`);

  const date = String(body?.date || '');
  const time = String(body?.time || '');
  if (!core.isValidDate(date)) throw new InputError('Pick a date.');
  if (!core.isQuarterTime(time)) throw new InputError('Pick a time on the quarter hour (:00, :15, :30, :45).');

  const level = String(body?.level || core.DEFAULT_LEVEL);
  if (!core.LEVEL_VALUES.includes(level)) throw new InputError('Pick an alert level.');

  const { rule, error } = core.normalizeRepeat(body?.repeat, date);
  if (error) throw new InputError(error);

  // Left out of an edit: it keeps what it had (null here). Left out of a new reminder: private.
  const visibility = body?.visibility == null ? (forUpdate ? null : 'private') : String(body.visibility);
  if (visibility != null && !VISIBILITIES.includes(visibility)) throw new InputError('Pick who can see it.');

  const realert = parseRealert(body, { forUpdate });
  if (realert?.on && level === 'passive') {
    throw new InputError('"Until acknowledged" needs an alert that makes a sound. Pick a level other than Passive.', 400, 'ack_passive');
  }

  const ids = Array.isArray(body?.recipients) ? [...new Set(body.recipients.map(Number))] : [];
  if (!ids.length) throw new InputError('Pick at least one person to remind.');
  if (ids.length > MAX_RECIPIENTS || ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new InputError('Those recipients are not valid.');
  const { rows: members } = await client.query(
    `SELECT m.id, m.name, (c.target_secret IS NOT NULL) AS has_key
       FROM family_members m
       LEFT JOIN member_notification_channels c ON c.member_id = m.id
      WHERE m.id = ANY($1::int[]) AND m.archived_at IS NULL
      ORDER BY m.id
      FOR SHARE OF m`,
    [ids],
  );
  // FOR SHARE holds these people until this transaction commits, so archiving one of them (which takes
  // the row FOR UPDATE first) either finishes before we look, or waits and then sees this reminder.
  if (members.length !== ids.length) throw new InputError('Someone you picked is no longer in the household. Reload and try again.');
  const keyless = members.filter((m) => !m.has_key);
  if (keyless.length) {
    throw new InputError(`${keyless.map((m) => m.name).join(', ')} ${keyless.length === 1 ? 'has' : 'have'} no brrr key yet. Add one under People first.`, 400, 'recipient_without_key');
  }

  let createdBy = null;
  if (body?.created_by != null && !forUpdate) {
    const id = Number(body.created_by);
    if (Number.isInteger(id) && id > 0) {
      const { rows } = await client.query('SELECT id FROM family_members WHERE id = $1 AND archived_at IS NULL', [id]);
      createdBy = rows[0]?.id ?? null;
    }
  }

  // An optional anchor (on or before the date) measures the pattern from an earlier date, so "Schedule
  // again" keeps a finished series' day of month or year.
  let anchor = date;
  if (body?.anchor != null && rule.freq !== 'once') {
    if (!core.isValidDate(body.anchor) || body.anchor > date) throw new InputError('That series anchor is not valid.');
    anchor = body.anchor;
  }
  return withFirst({ text, date, time, level, visibility, realert, rule, recipients: ids, createdBy, timezone, now, anchor });
}

// { on, every, for } from a body's ack_required, realert_every_min and realert_for_min; on with the defaults when
// only ack_required is given. Left out of an edit (ack_required absent): null, it keeps what it had.
function parseRealert(body, { forUpdate }) {
  if (body?.ack_required == null) return forUpdate ? null : { on: false, every: null, for: null };
  if (typeof body.ack_required !== 'boolean') throw new InputError('Say whether it needs acknowledging.');
  if (!body.ack_required) return { on: false, every: null, for: null };
  const every = body.realert_every_min == null ? DEFAULT_REALERT.every : Number(body.realert_every_min);
  const forMin = body.realert_for_min == null ? DEFAULT_REALERT.for : Number(body.realert_for_min);
  if (!REALERT_EVERY.includes(every)) throw new InputError('Re-alert every 5, 10, 15 or 30 minutes.');
  if (!REALERT_FOR.includes(forMin)) throw new InputError('Give up after 1, 4 or 12 hours.');
  return { on: true, every, for: forMin };
}

// The series' first occurrence on or after input.date, counting from input.anchor (the date its pattern
// is measured from: the 31st for "monthly on the 31st", the week for "every 2 weeks").
function withFirst(input) {
  const after = input.anchor === input.date ? null : core.addDays(input.date, -1);
  const first = core.nextOccurrenceDate(input.rule, input.anchor, after);
  if (!first) throw new InputError('That repeat pattern has no date on or after the one picked.');
  return { ...input, first, firstAt: zoned.toInstant(first, input.time, input.timezone) };
}

function assertFuture(input) {
  if (input.firstAt <= input.now) {
    throw new InputError(input.rule.freq === 'once'
      ? 'That time has already passed. Pick a later time.'
      : 'The first reminder in that series has already passed. Start it later.', 400, 'in_the_past');
  }
}

// Suggestions are kept per author: who scheduled or edited it (0 when nobody is known, as for rows from before
// authors). Two people writing the same text each keep their own row; an edit is the editor's use of it.
async function remember(client, input, author) {
  await client.query(
    `INSERT INTO suggestions (author, key, text, use_count, last_used_at, last_time_of_day, last_level, last_repeat, last_recipient_ids)
     VALUES ($7, $1, $2, 1, now(), $3, $4, $5, $6)
     ON CONFLICT (author, key) DO UPDATE SET
       text = EXCLUDED.text, use_count = suggestions.use_count + 1, last_used_at = now(),
       last_time_of_day = EXCLUDED.last_time_of_day, last_level = EXCLUDED.last_level,
       last_repeat = EXCLUDED.last_repeat, last_recipient_ids = EXCLUDED.last_recipient_ids`,
    [suggestionKey(input.text), input.text, input.time, input.level,
      // "Until acknowledged" rides along with the pattern, so a suggestion brings the setting back with the level.
      { freq: input.rule.freq, every: input.rule.every, weekdays: input.rule.weekdays, count: input.rule.count,
        ack: input.realert?.on ? { every: input.realert.every, for: input.realert.for } : null },
      input.recipients, author ?? 0],
  );
}

async function setRecipients(client, reminderId, ids) {
  await client.query('DELETE FROM reminder_recipients WHERE reminder_id = $1', [reminderId]);
  await client.query(
    'INSERT INTO reminder_recipients (reminder_id, member_id) SELECT $1, unnest($2::int[])',
    [reminderId, ids],
  );
}

async function create(pool, body, { timezone, now = new Date(), viewer }) {
  return withTransaction(pool, async (client) => {
    const input = await parseInput(client, body, { timezone, now });
    assertFuture(input);
    const { rule } = input;
    const extendBy = rule.count ?? core.DEFAULT_COUNTS[rule.freq] ?? 1;
    const { rows } = await client.query(
      `INSERT INTO reminders
         (text, level, visibility, created_by, timezone, start_date, time_of_day, freq, repeat_every, weekdays,
          max_occurrences, extend_by, fired_count, next_fire_date, next_fire_at, status,
          ack_required, realert_every_min, realert_for_min)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $13, $14, 'active', $15, $16, $17)
       RETURNING id`,
      [input.text, input.level, input.visibility, input.createdBy, timezone, input.anchor, input.time, rule.freq, rule.every,
        rule.weekdays, rule.freq === 'once' ? 1 : rule.count, Math.min(1000, extendBy), input.first, input.firstAt,
        input.realert.on, input.realert.every, input.realert.for],
    );
    await setRecipients(client, rows[0].id, input.recipients);
    await remember(client, input, input.createdBy ?? viewer);
    return rows[0].id;
  });
}

// The reminder, locked, if it exists and the viewer can see it (one they can't is "no longer exists" too).
async function lockActive(client, id, viewer) {
  const { rows } = await client.query('SELECT * FROM reminders WHERE id = $1 FOR UPDATE', [id]);
  const row = rows[0];
  if (!row || row.status === 'deleted') throw new InputError('That reminder no longer exists.', 404, 'not_found');
  await assertVisible(client, row, viewer);
  return row;
}

// Edits an active reminder. Changing when it happens (date, time, or repeat pattern) restarts the series
// from the new date; changing only the text, people, level, or count keeps its place in the series.
async function update(pool, id, body, { timezone, now = new Date(), viewer }) {
  return withTransaction(pool, async (client) => {
    const row = await lockActive(client, id, viewer);
    if (row.status !== 'active') throw new InputError('That reminder has already finished. Schedule it again instead.', 409, 'finished');
    if (body?.version != null && Number(body.version) !== row.version) {
      throw new InputError('This reminder changed while you were editing (it may have just gone off). Reload and try again.', 409, 'stale');
    }
    const input = await parseInput(client, body, { timezone: row.timezone, now, forUpdate: true });
    const { rule } = input;
    const realert = input.realert || { on: row.ack_required, every: row.realert_every_min, for: row.realert_for_min };
    if (realert.on && input.level === 'passive') {
      throw new InputError('"Until acknowledged" needs an alert that makes a sound. Pick a level other than Passive.', 400, 'ack_passive');
    }
    const old = schedule.ruleOf(row);
    const sameWhen = input.date === row.next_fire_date
      && input.time === schedule.hhmm(row.time_of_day)
      && rule.freq === old.freq && rule.every === old.every
      && String(rule.weekdays) === String(old.weekdays);

    if (sameWhen) {
      const maxOcc = rule.freq === 'once' ? 1 : (rule.count == null ? null : Number(row.fired_count) + rule.count);
      // extend_by stays: "Add N more" offers the series' original run, not what happens to be left.
      await client.query(
        `UPDATE reminders SET text = $2, level = $3, max_occurrences = $4, visibility = COALESCE($5, visibility),
                ack_required = $6, realert_every_min = $7, realert_for_min = $8,
                renewal_dismissed_at = NULL, version = version + 1, updated_at = now()
          WHERE id = $1`,
        [id, input.text, input.level, maxOcc, input.visibility, realert.on, realert.every, realert.for],
      );
    } else {
      // Same next date and the same kind of pattern (e.g. only the time changed): keep measuring the
      // pattern from the original start, so "monthly on the 31st" stays on the 31st and "every other
      // week" keeps its weeks. Otherwise the new date starts the pattern afresh.
      const keepAnchor = rule.freq !== 'once' && input.date === row.next_fire_date
        && rule.freq === old.freq && rule.every === old.every;
      const restarted = keepAnchor ? withFirst({ ...input, anchor: row.start_date }) : input;
      assertFuture(restarted);
      await client.query(
        `UPDATE reminders
            SET text = $2, level = $3, start_date = $4, time_of_day = $5, freq = $6, repeat_every = $7,
                weekdays = $8, max_occurrences = $9, extend_by = $10, fired_count = 0,
                next_fire_date = $11, next_fire_at = $12, renewal_dismissed_at = NULL,
                visibility = COALESCE($13, visibility), ack_required = $14, realert_every_min = $15, realert_for_min = $16,
                version = version + 1, updated_at = now()
          WHERE id = $1`,
        [id, restarted.text, restarted.level, restarted.anchor, restarted.time, rule.freq, rule.every, rule.weekdays,
          rule.freq === 'once' ? 1 : rule.count,
          Math.min(1000, rule.count ?? core.DEFAULT_COUNTS[rule.freq] ?? 1), restarted.first, restarted.firstAt,
          input.visibility, realert.on, realert.every, realert.for],
      );
    }
    // The level and "Until acknowledged" are written in the same UPDATE above, so turning it off and picking
    // Passive in one save never meets the CHECK halfway. A loop already running keeps its own timing (the
    // delivery has a snapshot of both settings), but turning "Until acknowledged" off stops it.
    // Someone taken off it: their open deliveries for it end, with every unsent push, the first included, so a
    // private reminder never reaches someone who no longer sees it (the send-time check backs this up).
    // Each delivery row is written once (see acks.endFollowUps), so the two stops below never share a row.
    const { rows: before } = await client.query('SELECT member_id FROM reminder_recipients WHERE reminder_id = $1', [id]);
    const removed = before.map((r) => r.member_id).filter((m) => !input.recipients.includes(m));
    if (row.ack_required && !realert.on) {
      await stopOpen(client, 'reminder_id = $1 AND realert_every_min IS NOT NULL AND member_id <> ALL($2::int[])', [id, removed]);
    }
    if (removed.length) {
      await stopOpen(client, 'reminder_id = $1 AND member_id = ANY($2::int[])', [id, removed], { firstPush: true });
    }
    await setRecipients(client, id, input.recipients);
    await remember(client, { ...input, realert }, viewer);
    return id;
  });
}

// Ends the follow-ups of the open deliveries (alert_no = 0) matching `where` as 'cancelled', and cancels their
// unsent follow-up alerts; with firstPush, also cancels their first push if still unsent, in the same UPDATE
// (one write per delivery row: see acks.endFollowUps). Callers hold the reminder (or the member) first:
// reminder → member → delivery.
async function stopOpen(client, where, params, { firstPush = false } = {}) {
  const { rows } = await client.query(
    `SELECT id FROM deliveries
      WHERE ${where} AND alert_no = 0
        AND (follow_up_ended IS NULL OR follow_up_ended = 'expired'${firstPush ? " OR status IN ('pending', 'sending')" : ''})
      ORDER BY id`,
    params,
  );
  await acks.endFollowUps(client, rows.map((r) => r.id), 'cancelled', { firstPush: firstPush ? 'cancelled' : null });
}

async function remove(pool, id, { viewer } = {}) {
  return withTransaction(pool, async (client) => {
    await lockActive(client, id, viewer);
    await client.query(
      `UPDATE reminders SET status = 'deleted', next_fire_at = NULL, next_fire_date = NULL,
              ended_at = COALESCE(ended_at, now()), version = version + 1, updated_at = now()
        WHERE id = $1`,
      [id],
    );
    // Deliveries first (their own first push in the same write), then their alerts, then any other alert still
    // pending. Got it and snooze lock a delivery and then its alerts, so taking an alert first could deadlock.
    await stopOpen(client, 'reminder_id = $1', [id], { firstPush: true });
    await client.query(
      "UPDATE deliveries SET status = 'cancelled', next_attempt_at = NULL, updated_at = now() WHERE reminder_id = $1 AND alert_no > 0 AND status = 'pending'",
      [id],
    );
  });
}

// Adds another run of reminders to a bounded series (as many as it was first scheduled with).
async function extend(pool, id, body, { viewer } = {}) {
  return withTransaction(pool, async (client) => {
    const row = await lockActive(client, id, viewer);
    if (row.status !== 'active') throw new InputError('That series has already ended. Schedule it again instead.', 409, 'finished');
    if (row.freq === 'once' || row.max_occurrences == null) throw new InputError('Only a repeating series with an end can be extended.');
    const by = body?.by == null ? row.extend_by : Number(body.by);
    if (!Number.isInteger(by) || by < 1 || by > 1000) throw new InputError('Extend by 1 to 1000 reminders.');
    await client.query(
      `UPDATE reminders SET max_occurrences = LEAST(100000, max_occurrences + $2), renewal_dismissed_at = NULL,
              version = version + 1, updated_at = now()
        WHERE id = $1`,
      [id, by],
    );
  });
}

// "Let it end": stop prompting about a series that is ending or has ended.
async function dismissRenewal(pool, id, { viewer } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE reminders r SET renewal_dismissed_at = now(), version = version + 1, updated_at = now()
      WHERE r.id = $1 AND r.status <> 'deleted'${scoped(viewer) ? ` AND ${visibleSql('r', '$2')}` : ''}`,
    scoped(viewer) ? [id, viewer] : [id],
  );
  if (!rowCount) throw new InputError('That reminder no longer exists.', 404, 'not_found');
}

// ── Reading ────────────────────────────────────────────────────────────────

function wallOf(at, timezone) {
  if (!at) return null;
  const w = zoned.toWall(at, timezone);
  return { date: w.date, time: w.time, at: new Date(at).toISOString() };
}

function present(row, recipients, deliveries, now) {
  const rule = schedule.ruleOf(row);
  const remaining = schedule.remainingOf(row);
  const last = row.status === 'active' ? schedule.lastOf(row) : null;
  const bounded = row.freq !== 'once' && row.max_occurrences != null;
  const endingSoon = row.status === 'active' && bounded && !row.renewal_dismissed_at
    && Boolean(last) && last.at - now <= ENDING_SOON_MS[row.freq] * DAY_MS;
  const ended = row.status === 'completed' && row.freq !== 'once' && !row.renewal_dismissed_at
    && row.ended_at && now - new Date(row.ended_at) <= ENDED_PROMPT_MS;
  const repeatForForm = { ...rule, count: rule.freq === 'once' ? 1 : remaining };
  return {
    id: row.id,
    text: row.text,
    level: row.level,
    visibility: row.visibility,
    ack_required: row.ack_required,
    realert_every_min: row.realert_every_min,
    realert_for_min: row.realert_for_min,
    status: row.status,
    version: row.version,
    created_by: row.created_by,
    recipients,
    time: schedule.hhmm(row.time_of_day),
    start_date: row.start_date,
    repeat: repeatForForm,
    describe: core.describeRepeat({ ...rule, count: rule.freq === 'once' ? 1 : remaining }, row.start_date),
    fired_count: row.fired_count,
    remaining,
    next: row.status === 'active' ? { date: row.next_fire_date, time: schedule.hhmm(row.time_of_day), at: new Date(row.next_fire_at).toISOString() } : null,
    last: last ? { date: last.date, time: schedule.hhmm(row.time_of_day), at: last.at.toISOString() } : null,
    last_fired: wallOf(row.last_fired_at, row.timezone),
    ending_soon: Boolean(endingSoon),
    ended_prompt: Boolean(ended),
    extend_by: row.extend_by,
    deliveries,
  };
}

async function list(pool, { now = new Date(), viewer } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM reminders r
      WHERE (r.status = 'active'
         OR (r.status = 'completed' AND r.freq <> 'once' AND r.renewal_dismissed_at IS NULL AND r.ended_at > $1))
        ${scoped(viewer) ? `AND ${visibleSql('r', '$2')}` : ''}
      ORDER BY r.next_fire_at NULLS LAST, r.id`,
    scoped(viewer) ? [new Date(now.getTime() - ENDED_PROMPT_MS), viewer] : [new Date(now.getTime() - ENDED_PROMPT_MS)],
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const { rows: rec } = await pool.query(
    `SELECT rr.reminder_id, m.id, m.name, (c.target_secret IS NOT NULL) AS has_key
       FROM reminder_recipients rr
       JOIN family_members m ON m.id = rr.member_id AND m.archived_at IS NULL
       LEFT JOIN member_notification_channels c ON c.member_id = m.id
      WHERE rr.reminder_id = ANY($1::int[])
      ORDER BY m.name`,
    [ids],
  );
  // Each recipient's delivery from the reminder's latest occurrence (not each person's own latest: someone
  // re-added after missing one occurrence must not show an old Got it), with its acknowledgement state.
  const { rows: del } = await pool.query(
    `SELECT d.id, d.reminder_id, d.member_id, d.status, d.scheduled_for, d.sent_at, d.attempts, d.last_error,
            d.next_attempt_at, d.realert_every_min IS NOT NULL AS ack_required, d.acked_at, d.acked_by, d.ack_via,
            d.follow_ups, d.follow_up_ended, d.follow_up_at
       FROM deliveries d
      WHERE d.reminder_id = ANY($1::int[]) AND d.alert_no = 0
        AND d.occurrence_no = (SELECT max(x.occurrence_no) FROM deliveries x WHERE x.reminder_id = d.reminder_id AND x.alert_no = 0)
      ORDER BY d.reminder_id, d.member_id`,
    [ids],
  );
  const byReminder = (list, key = 'reminder_id') => list.reduce((acc, r) => {
    (acc[r[key]] ||= []).push(r);
    return acc;
  }, {});
  const recBy = byReminder(rec);
  const delBy = byReminder(del);
  return rows.map((row) => present(
    row,
    (recBy[row.id] || []).map(({ id, name, has_key }) => ({ id, name, has_key })),
    (delBy[row.id] || []).map((d) => ({
      id: Number(d.id), member_id: d.member_id, status: d.status, scheduled_for: d.scheduled_for, sent_at: d.sent_at,
      attempts: d.attempts, last_error: d.last_error, next_attempt_at: d.next_attempt_at,
      ack_required: d.ack_required, acked_at: d.acked_at, acked_by: d.acked_by, ack_via: d.ack_via,
      follow_ups: d.follow_ups, follow_up_ended: d.follow_up_ended, next_alert_at: d.follow_up_at,
    })),
    now,
  ));
}

async function recentDeliveries(pool, { limit = 20, viewer } = {}) {
  const { rows } = await pool.query(
    `SELECT d.id, d.reminder_id, d.status, d.scheduled_for, d.sent_at, d.attempts, d.last_error,
            d.payload->>'title' AS text, m.id AS member_id, m.name AS member_name, r.created_by,
            d.realert_every_min IS NOT NULL AS ack_required, d.acked_at, d.acked_by, d.ack_via,
            d.follow_ups, d.follow_up_ended, d.follow_up_at AS next_alert_at
       FROM deliveries d
       JOIN family_members m ON m.id = d.member_id
       JOIN reminders r ON r.id = d.reminder_id
      WHERE d.alert_no = 0
        -- A first push cancelled by a Got it or a snooze still shows: the delivery itself was acknowledged,
        -- snoozed or ended (so a finished one-off never drops out of its creator's view).
        AND (d.status <> 'cancelled' OR d.acked_at IS NOT NULL OR d.follow_up_at IS NOT NULL OR d.follow_ups > 0
             OR d.snoozed_from IS NOT NULL OR (d.follow_up_ended IS NOT NULL AND r.status <> 'deleted'))${scoped(viewer) ? ` AND ${visibleSql('r', '$2')}` : ''}
      ORDER BY d.scheduled_for DESC, d.id DESC
      LIMIT $1`,
    scoped(viewer) ? [Math.min(100, Math.max(1, limit)), viewer] : [Math.min(100, Math.max(1, limit))],
  );
  return rows;
}

// Deliveries that need attention: still retrying after a failure, or failed, within the last day.
// Independent of the reminder's status, so a finished one-off that could not be delivered still shows.
async function problems(pool, { now = new Date(), viewer } = {}) {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const { rows } = await pool.query(
    `SELECT d.id, d.reminder_id, d.status, d.attempts, d.last_error, d.scheduled_for, d.next_attempt_at,
            d.payload->>'title' AS text, m.id AS member_id, m.name AS member_name, d.alert_no, d.alert_kind
       FROM deliveries d
       JOIN family_members m ON m.id = d.member_id AND m.archived_at IS NULL
       JOIN reminders r ON r.id = d.reminder_id AND r.status <> 'deleted'
      WHERE d.scheduled_for > $1
        AND (d.status = 'failed' OR (d.status IN ('pending', 'sending') AND d.last_error IS NOT NULL))
        ${scoped(viewer) ? `AND ${visibleSql('r', '$2')}` : ''}
      ORDER BY d.scheduled_for DESC
      LIMIT 20`,
    scoped(viewer) ? [since, viewer] : [since],
  );
  return rows;
}

// "Waiting on you": the viewer's own deliveries that want a Got it or may be snoozed. Read from deliveries, not
// the reminders list, so a finished one-off is still here. With "Until acknowledged": open (still alerting or
// snoozed), or not acknowledged and expired in the last 12 hours (a late Got it is still recorded). Without it:
// snoozed, or went off (first push or snooze alert) in the last 30 minutes, so it can be snoozed.
async function waiting(pool, { now = new Date(), viewer } = {}) {
  if (viewer == null) return [];
  const { rows } = await pool.query(
    `SELECT d.*, r.level, r.timezone
       FROM deliveries d
       JOIN reminders r ON r.id = d.reminder_id AND r.status <> 'deleted'
      WHERE d.member_id = $1 AND d.alert_no = 0 AND d.acked_at IS NULL
        AND (
          (d.realert_every_min IS NOT NULL AND d.follow_up_ended IS NULL
             AND (d.status = 'sent' OR d.follow_up_at IS NOT NULL OR d.follow_ups > 0))
          OR (d.realert_every_min IS NOT NULL AND d.follow_up_ended = 'expired' AND d.follow_up_until > $2)
          OR (d.realert_every_min IS NULL AND d.follow_up_ended IS NULL
             AND (d.follow_up_at IS NOT NULL OR d.sent_at > $3
                  OR EXISTS (SELECT 1 FROM deliveries f WHERE f.reminder_id = d.reminder_id AND f.occurrence_no = d.occurrence_no
                               AND f.member_id = d.member_id AND f.alert_no > 0
                               AND (f.sent_at > $3 OR f.status IN ('pending', 'sending')))))
        )
      ORDER BY d.scheduled_for DESC, d.id DESC
      LIMIT 20`,
    [viewer, new Date(now.getTime() - WAITING_EXPIRED_MS), new Date(now.getTime() - WAITING_RECENT_MS)],
  );
  return rows.map((d) => ({ ...acks.present(d, now), level: d.level, due: wallOf(d.scheduled_for, d.timezone) }));
}

// The viewer's own suggestions ($n), plus rows with no known author offered to the people they last reminded.
const suggestionMineSql = (param) => `(author = ${param}::int OR (author = 0 AND ${param}::int = ANY(last_recipient_ids)))`;

// Past reminder texts that match what is being typed, best first.
async function suggest(pool, q, { limit = 6, viewer } = {}) {
  const key = suggestionKey(q);
  if (!key) {
    const { rows } = await pool.query(
      `SELECT text, use_count, last_used_at, to_char(last_time_of_day, 'HH24:MI') AS time, last_level AS level,
              last_repeat AS repeat, last_recipient_ids AS recipients
         FROM suggestions ${scoped(viewer) ? `WHERE ${suggestionMineSql('$2')}` : ''}
        ORDER BY last_used_at DESC LIMIT $1`,
      scoped(viewer) ? [limit, viewer] : [limit],
    );
    return rows;
  }
  const like = key.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { rows } = await pool.query(
    `SELECT text, use_count, last_used_at, to_char(last_time_of_day, 'HH24:MI') AS time, last_level AS level,
            last_repeat AS repeat, last_recipient_ids AS recipients
       FROM suggestions
      WHERE (key LIKE $1 || '%' OR key LIKE '% ' || $1 || '%')${scoped(viewer) ? ` AND ${suggestionMineSql('$3')}` : ''}
      ORDER BY (key LIKE $1 || '%') DESC, use_count DESC, last_used_at DESC
      LIMIT $2`,
    scoped(viewer) ? [like, limit, viewer] : [like, limit],
  );
  return rows;
}

async function forgetSuggestion(pool, text, { viewer } = {}) {
  await pool.query(
    `DELETE FROM suggestions WHERE key = $1${scoped(viewer) ? ` AND ${suggestionMineSql('$2')}` : ''}`,
    scoped(viewer) ? [suggestionKey(text), viewer] : [suggestionKey(text)],
  );
}

module.exports = {
  InputError, create, update, remove, extend, dismissRenewal, list, problems, recentDeliveries, waiting, suggest, forgetSuggestion,
  suggestionKey, cleanText, VISIBILITIES, visibleSql, REALERT_EVERY, REALERT_FOR,
};
