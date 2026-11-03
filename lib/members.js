'use strict';

const brrr = require('./brrr');
const { withTransaction } = require('./db');
const { InputError, cleanText } = require('./reminders');

const MAX_NAME = 40;

function cleanName(value) {
  const name = cleanText(value);
  if (!name) throw new InputError('Enter a name.');
  if (name.length > MAX_NAME) throw new InputError(`Keep names under ${MAX_NAME} characters.`);
  return name;
}

function duplicateName(err) {
  return err?.code === '23505' ? new InputError('Someone in the household already has that name.', 409, 'duplicate_name') : err;
}

// Never selects the secret itself: only whether there is one and its last four characters.
async function list(pool) {
  const { rows } = await pool.query(
    `SELECT m.id, m.name,
            (c.target_secret IS NOT NULL) AS has_key,
            CASE WHEN c.target_secret IS NULL THEN NULL
                 WHEN char_length(c.target_secret) <= 8 THEN '••••'
                 ELSE '••••' || right(c.target_secret, 4) END AS key_preview,
            c.last_ok_at, c.last_error, c.last_error_at,
            (SELECT count(*)::int FROM reminder_recipients rr JOIN reminders r ON r.id = rr.reminder_id
              WHERE rr.member_id = m.id AND r.status = 'active') AS active_reminders
       FROM family_members m
       LEFT JOIN member_notification_channels c ON c.member_id = m.id
      WHERE m.archived_at IS NULL
      ORDER BY m.id`,
  );
  return rows;
}

async function count(pool) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM family_members WHERE archived_at IS NULL');
  return rows[0].n;
}

async function create(pool, body) {
  const name = cleanName(body?.name);
  try {
    const { rows } = await pool.query('INSERT INTO family_members (name) VALUES ($1) RETURNING id, name', [name]);
    return rows[0];
  } catch (err) { throw duplicateName(err); }
}

// First run: create the household in one go. Refuses once anyone exists.
async function bootstrap(pool, body) {
  const names = Array.isArray(body?.members) ? body.members.map((m) => cleanText(typeof m === 'string' ? m : m?.name)).filter(Boolean) : [];
  if (!names.length) throw new InputError('Add at least one person.');
  const seen = new Set();
  for (const n of names) {
    cleanName(n);
    if (seen.has(n.toLowerCase())) throw new InputError(`"${n}" is listed twice.`);
    seen.add(n.toLowerCase());
  }
  return withTransaction(pool, async (client) => {
    await client.query('LOCK TABLE family_members IN EXCLUSIVE MODE');
    const { rows } = await client.query('SELECT count(*)::int AS n FROM family_members WHERE archived_at IS NULL');
    if (rows[0].n > 0) throw new InputError('The household is already set up.', 409, 'household_already_initialized');
    const out = [];
    for (const name of names) {
      const r = await client.query('INSERT INTO family_members (name) VALUES ($1) RETURNING id, name', [name]);
      out.push(r.rows[0]);
    }
    return out;
  });
}

async function liveMember(client, id, { lock = false } = {}) {
  const { rows } = await client.query(`SELECT id, name FROM family_members WHERE id = $1 AND archived_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw new InputError('That person is not in the household.', 404, 'not_found');
  return rows[0];
}

async function rename(pool, id, body) {
  const name = cleanName(body?.name);
  await liveMember(pool, id);
  try {
    await pool.query('UPDATE family_members SET name = $2, updated_at = now() WHERE id = $1', [id, name]);
  } catch (err) { throw duplicateName(err); }
}

// Removes a person. If they are on active reminders, refuses unless `force`: then they come off those
// reminders, and reminders left with nobody to remind are deleted. Their brrr key is erased.
async function archive(pool, id, { force = false } = {}) {
  return withTransaction(pool, async (client) => {
    // Lock order matches saving a reminder (reminder rows first, then people), so the two can't deadlock:
    //   1. the person's active reminders, FOR UPDATE (waits for any edit of them in progress)
    //   2. the person, FOR UPDATE (waits for any save holding them FOR SHARE, see reminders.parseInput)
    //   3. the reminders again: a save that finished while we waited at 2 is now visible
    const remindersOf = () => client.query(
      `SELECT r.id FROM reminders r JOIN reminder_recipients rr ON rr.reminder_id = r.id
        WHERE rr.member_id = $1 AND r.status = 'active' ORDER BY r.id FOR UPDATE OF r`,
      [id],
    );
    await remindersOf();
    await liveMember(client, id, { lock: true });
    const { rows: active } = await remindersOf();
    if (active.length && !force) {
      throw new InputError(`They are on ${active.length} scheduled reminder${active.length === 1 ? '' : 's'}.`, 409, 'has_reminders');
    }
    const ids = active.map((r) => r.id);
    if (ids.length) {
      await client.query('DELETE FROM reminder_recipients WHERE member_id = $1 AND reminder_id = ANY($2::int[])', [id, ids]);
      await client.query(
        `UPDATE reminders SET status = 'deleted', next_fire_at = NULL, next_fire_date = NULL, ended_at = now(),
                version = version + 1, updated_at = now()
          WHERE id = ANY($1::int[]) AND NOT EXISTS (SELECT 1 FROM reminder_recipients rr WHERE rr.reminder_id = reminders.id)`,
        [ids],
      );
    }
    await client.query("UPDATE deliveries SET status = 'cancelled', next_attempt_at = NULL, updated_at = now() WHERE member_id = $1 AND status = 'pending'", [id]);
    await client.query('DELETE FROM member_notification_channels WHERE member_id = $1', [id]);
    await client.query('UPDATE family_members SET archived_at = now(), updated_at = now() WHERE id = $1', [id]);
    return { removedFrom: ids.length };
  });
}

async function setKey(pool, id, body) {
  const { value, error } = brrr.normalizeKey(body?.key);
  if (error) throw new InputError(error);
  await liveMember(pool, id);
  await pool.query(
    `INSERT INTO member_notification_channels (member_id, channel_type, target_secret, updated_at)
     VALUES ($1, 'brrr', $2, now())
     ON CONFLICT (member_id) DO UPDATE SET target_secret = EXCLUDED.target_secret,
       last_ok_at = NULL, last_error = NULL, last_error_at = NULL, updated_at = now()`,
    [id, value],
  );
  return { key_preview: brrr.maskKey(value) };
}

async function clearKey(pool, id) {
  await liveMember(pool, id);
  await pool.query('DELETE FROM member_notification_channels WHERE member_id = $1', [id]);
}

// Sends a test push right now and records the outcome on the person's channel.
async function test(pool, id, body, { sendImpl = brrr.send, icon = brrr.iconUrl(), openUrl = null } = {}) {
  const member = await liveMember(pool, id);
  const { rows } = await pool.query('SELECT target_secret FROM member_notification_channels WHERE member_id = $1', [id]);
  if (!rows[0]) throw new InputError(`${member.name} has no brrr key yet.`, 400, 'no_key');
  const level = ['passive', 'active', 'time-sensitive', 'critical'].includes(body?.level) ? body.level : 'active';
  const payload = {
    title: 'Remind Me is connected',
    message: `Reminders for ${member.name} will arrive like this.`,
    thread_id: 'remind-me-test',
    interruption_level: level,
  };
  if (icon) payload.icon_url = icon;
  if (openUrl) payload.open_url = openUrl;
  try {
    await sendImpl(rows[0].target_secret, payload);
    await pool.query('UPDATE member_notification_channels SET last_ok_at = now(), last_error = NULL, last_error_at = NULL WHERE member_id = $1', [id]);
    return { ok: true };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 300);
    await pool.query('UPDATE member_notification_channels SET last_error = $2, last_error_at = now() WHERE member_id = $1', [id, message]);
    return { ok: false, error: message };
  }
}

module.exports = { list, count, create, bootstrap, rename, archive, setKey, clearKey, test };
