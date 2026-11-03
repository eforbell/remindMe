'use strict';

const { withTransaction } = require('./db');
const schedule = require('./schedule');

const { core, zoned } = schedule;

const MAX_TEXT = 120;
const MAX_RECIPIENTS = 20;
const ENDING_SOON_REMAINING = 2;
const ENDING_SOON_MS = 72 * 60 * 60 * 1000;
const ENDED_PROMPT_MS = 7 * 24 * 60 * 60 * 1000;

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

  const ids = Array.isArray(body?.recipients) ? [...new Set(body.recipients.map(Number))] : [];
  if (!ids.length) throw new InputError('Pick at least one person to remind.');
  if (ids.length > MAX_RECIPIENTS || ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new InputError('Those recipients are not valid.');
  const { rows: members } = await client.query(
    `SELECT m.id, m.name, (c.target_secret IS NOT NULL) AS has_key
       FROM family_members m
       LEFT JOIN member_notification_channels c ON c.member_id = m.id
      WHERE m.id = ANY($1::int[]) AND m.archived_at IS NULL`,
    [ids],
  );
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

  const first = core.nextOccurrenceDate(rule, date, null);
  const firstAt = zoned.toInstant(first, time, timezone);
  return { text, date, time, level, rule, recipients: ids, createdBy, first, firstAt, timezone, now };
}

function assertFuture(input) {
  if (input.firstAt <= input.now) {
    throw new InputError(input.rule.freq === 'once'
      ? 'That time has already passed. Pick a later time.'
      : 'The first reminder in that series has already passed. Start it later.', 400, 'in_the_past');
  }
}

async function remember(client, input) {
  await client.query(
    `INSERT INTO suggestions (key, text, use_count, last_used_at, last_time_of_day, last_level, last_repeat, last_recipient_ids)
     VALUES ($1, $2, 1, now(), $3, $4, $5, $6)
     ON CONFLICT (key) DO UPDATE SET
       text = EXCLUDED.text, use_count = suggestions.use_count + 1, last_used_at = now(),
       last_time_of_day = EXCLUDED.last_time_of_day, last_level = EXCLUDED.last_level,
       last_repeat = EXCLUDED.last_repeat, last_recipient_ids = EXCLUDED.last_recipient_ids`,
    [suggestionKey(input.text), input.text, input.time, input.level,
      { freq: input.rule.freq, every: input.rule.every, weekdays: input.rule.weekdays, count: input.rule.count },
      input.recipients],
  );
}

async function setRecipients(client, reminderId, ids) {
  await client.query('DELETE FROM reminder_recipients WHERE reminder_id = $1', [reminderId]);
  await client.query(
    'INSERT INTO reminder_recipients (reminder_id, member_id) SELECT $1, unnest($2::int[])',
    [reminderId, ids],
  );
}

async function create(pool, body, { timezone, now = new Date() }) {
  return withTransaction(pool, async (client) => {
    const input = await parseInput(client, body, { timezone, now });
    assertFuture(input);
    const { rule } = input;
    const extendBy = rule.count ?? core.DEFAULT_COUNTS[rule.freq] ?? 1;
    const { rows } = await client.query(
      `INSERT INTO reminders
         (text, level, created_by, timezone, start_date, time_of_day, freq, repeat_every, weekdays,
          max_occurrences, extend_by, fired_count, next_fire_date, next_fire_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13, 'active')
       RETURNING id`,
      [input.text, input.level, input.createdBy, timezone, input.date, input.time, rule.freq, rule.every,
        rule.weekdays, rule.freq === 'once' ? 1 : rule.count, Math.min(1000, extendBy), input.first, input.firstAt],
    );
    await setRecipients(client, rows[0].id, input.recipients);
    await remember(client, input);
    return rows[0].id;
  });
}

async function lockActive(client, id) {
  const { rows } = await client.query('SELECT * FROM reminders WHERE id = $1 FOR UPDATE', [id]);
  const row = rows[0];
  if (!row || row.status === 'deleted') throw new InputError('That reminder no longer exists.', 404, 'not_found');
  return row;
}

// Edits an active reminder. Changing when it happens (date, time, or repeat pattern) restarts the series
// from the new date; changing only the text, people, level, or count keeps its place in the series.
async function update(pool, id, body, { timezone, now = new Date() }) {
  return withTransaction(pool, async (client) => {
    const row = await lockActive(client, id);
    if (row.status !== 'active') throw new InputError('That reminder has already finished. Schedule it again instead.', 409, 'finished');
    if (body?.version != null && Number(body.version) !== row.version) {
      throw new InputError('This reminder changed while you were editing (it may have just gone off). Reload and try again.', 409, 'stale');
    }
    const input = await parseInput(client, body, { timezone: row.timezone, now, forUpdate: true });
    const { rule } = input;
    const old = schedule.ruleOf(row);
    const sameWhen = input.date === row.next_fire_date
      && input.time === schedule.hhmm(row.time_of_day)
      && rule.freq === old.freq && rule.every === old.every
      && String(rule.weekdays) === String(old.weekdays);

    if (sameWhen) {
      const maxOcc = rule.freq === 'once' ? 1 : (rule.count == null ? null : Number(row.fired_count) + rule.count);
      await client.query(
        `UPDATE reminders SET text = $2, level = $3, max_occurrences = $4,
                extend_by = CASE WHEN $5::int IS NULL THEN extend_by ELSE LEAST(1000, $5::int) END,
                renewal_dismissed_at = NULL, version = version + 1, updated_at = now()
          WHERE id = $1`,
        [id, input.text, input.level, maxOcc, rule.count],
      );
    } else {
      assertFuture(input);
      await client.query(
        `UPDATE reminders
            SET text = $2, level = $3, start_date = $4, time_of_day = $5, freq = $6, repeat_every = $7,
                weekdays = $8, max_occurrences = $9, extend_by = $10, fired_count = 0,
                next_fire_date = $11, next_fire_at = $12, renewal_dismissed_at = NULL,
                version = version + 1, updated_at = now()
          WHERE id = $1`,
        [id, input.text, input.level, input.date, input.time, rule.freq, rule.every, rule.weekdays,
          rule.freq === 'once' ? 1 : rule.count,
          Math.min(1000, rule.count ?? core.DEFAULT_COUNTS[rule.freq] ?? 1), input.first, input.firstAt],
      );
    }
    await setRecipients(client, id, input.recipients);
    await remember(client, input);
    return id;
  });
}

async function remove(pool, id) {
  return withTransaction(pool, async (client) => {
    await lockActive(client, id);
    await client.query(
      `UPDATE reminders SET status = 'deleted', next_fire_at = NULL, next_fire_date = NULL,
              ended_at = COALESCE(ended_at, now()), version = version + 1, updated_at = now()
        WHERE id = $1`,
      [id],
    );
    await client.query(
      "UPDATE deliveries SET status = 'cancelled', next_attempt_at = NULL, updated_at = now() WHERE reminder_id = $1 AND status = 'pending'",
      [id],
    );
  });
}

// Adds another run of reminders to a bounded series (as many as it was first scheduled with).
async function extend(pool, id, body) {
  return withTransaction(pool, async (client) => {
    const row = await lockActive(client, id);
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
async function dismissRenewal(pool, id) {
  const { rowCount } = await pool.query(
    "UPDATE reminders SET renewal_dismissed_at = now(), version = version + 1, updated_at = now() WHERE id = $1 AND status <> 'deleted'",
    [id],
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
    && (remaining <= ENDING_SOON_REMAINING || (last && last.at - now <= ENDING_SOON_MS));
  const ended = row.status === 'completed' && row.freq !== 'once' && !row.renewal_dismissed_at
    && row.ended_at && now - new Date(row.ended_at) <= ENDED_PROMPT_MS;
  const repeatForForm = { ...rule, count: rule.freq === 'once' ? 1 : remaining };
  return {
    id: row.id,
    text: row.text,
    level: row.level,
    status: row.status,
    version: row.version,
    created_by: row.created_by,
    recipients,
    time: schedule.hhmm(row.time_of_day),
    start_date: row.start_date,
    repeat: repeatForForm,
    describe: core.describeRepeat({ ...rule, count: rule.freq === 'once' ? 1 : remaining }, row.next_fire_date || row.start_date),
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

async function list(pool, { now = new Date() } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM reminders
      WHERE status = 'active'
         OR (status = 'completed' AND freq <> 'once' AND renewal_dismissed_at IS NULL AND ended_at > $1)
      ORDER BY next_fire_at NULLS LAST, id`,
    [new Date(now.getTime() - ENDED_PROMPT_MS)],
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
  // The most recent occurrence's outcome per reminder, plus anything still being retried.
  const { rows: del } = await pool.query(
    `SELECT DISTINCT ON (d.reminder_id, d.member_id) d.reminder_id, d.member_id, d.status, d.scheduled_for,
            d.sent_at, d.attempts, d.last_error, d.next_attempt_at
       FROM deliveries d
      WHERE d.reminder_id = ANY($1::int[])
      ORDER BY d.reminder_id, d.member_id, d.occurrence_no DESC`,
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
      member_id: d.member_id, status: d.status, scheduled_for: d.scheduled_for, sent_at: d.sent_at,
      attempts: d.attempts, last_error: d.last_error, next_attempt_at: d.next_attempt_at,
    })),
    now,
  ));
}

async function recentDeliveries(pool, { limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT d.id, d.reminder_id, d.status, d.scheduled_for, d.sent_at, d.attempts, d.last_error,
            d.payload->>'title' AS text, m.id AS member_id, m.name AS member_name
       FROM deliveries d
       JOIN family_members m ON m.id = d.member_id
      WHERE d.status <> 'cancelled'
      ORDER BY d.scheduled_for DESC, d.id DESC
      LIMIT $1`,
    [Math.min(100, Math.max(1, limit))],
  );
  return rows;
}

// Deliveries that need attention: still retrying after a failure, or failed, within the last day.
// Independent of the reminder's status, so a finished one-off that could not be delivered still shows.
async function problems(pool, { now = new Date() } = {}) {
  const { rows } = await pool.query(
    `SELECT d.id, d.reminder_id, d.status, d.attempts, d.last_error, d.scheduled_for, d.next_attempt_at,
            d.payload->>'title' AS text, m.id AS member_id, m.name AS member_name
       FROM deliveries d
       JOIN family_members m ON m.id = d.member_id AND m.archived_at IS NULL
       JOIN reminders r ON r.id = d.reminder_id AND r.status <> 'deleted'
      WHERE d.scheduled_for > $1
        AND (d.status = 'failed' OR (d.status IN ('pending', 'sending') AND d.attempts > 0))
      ORDER BY d.scheduled_for DESC
      LIMIT 20`,
    [new Date(now.getTime() - 24 * 60 * 60 * 1000)],
  );
  return rows;
}

// Past reminder texts that match what is being typed, best first.
async function suggest(pool, q, { limit = 6 } = {}) {
  const key = suggestionKey(q);
  if (!key) {
    const { rows } = await pool.query(
      `SELECT text, use_count, last_used_at, to_char(last_time_of_day, 'HH24:MI') AS time, last_level AS level,
              last_repeat AS repeat, last_recipient_ids AS recipients
         FROM suggestions ORDER BY last_used_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }
  const like = key.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { rows } = await pool.query(
    `SELECT text, use_count, last_used_at, to_char(last_time_of_day, 'HH24:MI') AS time, last_level AS level,
            last_repeat AS repeat, last_recipient_ids AS recipients
       FROM suggestions
      WHERE key LIKE $1 || '%' OR key LIKE '% ' || $1 || '%'
      ORDER BY (key LIKE $1 || '%') DESC, use_count DESC, last_used_at DESC
      LIMIT $2`,
    [like, limit],
  );
  return rows;
}

async function forgetSuggestion(pool, text) {
  await pool.query('DELETE FROM suggestions WHERE key = $1', [suggestionKey(text)]);
}

module.exports = {
  InputError, create, update, remove, extend, dismissRenewal, list, problems, recentDeliveries, suggest, forgetSuggestion,
  suggestionKey, cleanText,
};
