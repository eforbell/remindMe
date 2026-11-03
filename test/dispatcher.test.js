'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const dispatcher = require('../lib/dispatcher');
const reminders = require('../lib/reminders');
const members = require('../lib/members');

const TZ = 'America/New_York';
const CONFIG = { giveUpMs: 12 * 3600 * 1000, retentionDays: 180, appPublicUrl: null, icon: null };
const at = (iso) => new Date(iso);
const minutes = (d, n) => new Date(d.getTime() + n * 60000);

let pool;

test.before(async () => { if (!db.skip) pool = await db.freshPool(); });
test.after(async () => { if (pool) await pool.end(); });

// A recording fake for brrr: succeeds unless `fail` says otherwise.
function fakeSender({ fail = () => false, delayMs = 0 } = {}) {
  const calls = [];
  const sendImpl = async (secret, payload) => {
    calls.push({ secret, payload });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (fail(calls.length, secret)) throw Object.assign(new Error('brrr answered 503'), { status: 503 });
    return { status: 200 };
  };
  return { calls, sendImpl };
}

async function household(names = ['Sam', 'Riley']) {
  await db.reset(pool);
  const out = [];
  for (const name of names) {
    const m = await members.create(pool, { name });
    await members.setKey(pool, m.id, { key: `br_usr_${name.toLowerCase()}_key_0001` });
    out.push(m);
  }
  return out;
}

async function pass(now, sender, extra = {}) {
  return dispatcher.runPass(pool, { source: 'test', now: () => now, sendImpl: sender.sendImpl, config: CONFIG, ...extra });
}

async function deliveries() {
  const { rows } = await pool.query('SELECT * FROM deliveries ORDER BY reminder_id, occurrence_no, member_id');
  return rows;
}

async function reminderRow(id) {
  const { rows } = await pool.query('SELECT * FROM reminders WHERE id = $1', [id]);
  return rows[0];
}

test('a one-off fires once, on time, to every recipient, and completes', { skip: db.skip }, async () => {
  const [sam, riley] = await household();
  const created = at('2026-11-03T15:00:00Z'); // 10:00 New York
  const id = await reminders.create(pool, {
    text: 'Take medicine', date: '2026-11-03', time: '17:00', level: 'critical',
    recipients: [sam.id, riley.id], created_by: sam.id,
  }, { timezone: TZ, now: created });
  const sender = fakeSender();

  // 16:59 New York: not yet.
  let s = await pass(at('2026-11-03T21:59:00Z'), sender);
  assert.equal(s.reminders, 0);
  assert.equal(sender.calls.length, 0);

  // 17:00:40 (the timer fires up to a minute late): both get it.
  s = await pass(at('2026-11-03T22:00:40Z'), sender);
  assert.equal(s.sent, 2);
  assert.equal(sender.calls.length, 2);
  const toRiley = sender.calls.find((c) => c.secret === 'br_usr_riley_key_0001').payload;
  assert.equal(toRiley.title, 'Take medicine');
  assert.equal(toRiley.message, '5:00 PM · from Sam');
  assert.equal(toRiley.interruption_level, 'critical');
  assert.equal(toRiley.thread_id, `remind-me-${id}`);
  const toSam = sender.calls.find((c) => c.secret === 'br_usr_sam_key_0001').payload;
  assert.equal(toSam.message, '5:00 PM', 'no "from" line to yourself');

  const row = await reminderRow(id);
  assert.equal(row.status, 'completed');
  assert.equal(row.next_fire_at, null);
  assert.deepEqual((await deliveries()).map((d) => d.status), ['sent', 'sent']);

  // Later passes never resend.
  await pass(at('2026-11-03T22:05:00Z'), sender);
  await pass(at('2026-11-04T22:05:00Z'), sender);
  assert.equal(sender.calls.length, 2);
});

test('two dispatchers running at once never double-send', { skip: db.skip }, async () => {
  const people = await household(['A1', 'B2', 'C3', 'D4', 'E5', 'F6']);
  const created = at('2026-11-03T15:00:00Z');
  for (let i = 0; i < 12; i += 1) {
    await reminders.create(pool, {
      text: `Thing ${i}`, date: '2026-11-03', time: '17:00', recipients: people.map((p) => p.id),
    }, { timezone: TZ, now: created });
  }
  const sender = fakeSender({ delayMs: 5 });
  const now = at('2026-11-03T22:00:30Z');
  const results = await Promise.all([pass(now, sender), pass(now, sender), pass(now, sender)]);
  assert.equal(results.reduce((n, r) => n + r.sent, 0), 72);
  assert.equal(sender.calls.length, 72);
  const keys = new Set(sender.calls.map((c) => `${c.payload.title}|${c.secret}`));
  assert.equal(keys.size, 72, 'every (reminder, person) exactly once');
});

test('a failed send retries with back-off and then succeeds', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await reminders.create(pool, { text: 'Call the vet', date: '2026-11-03', time: '09:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  const sender = fakeSender({ fail: (n) => n <= 2 });
  const t0 = at('2026-11-03T14:00:20Z');

  await pass(t0, sender); // attempt 1 fails → retry in 1 min
  let [d] = await deliveries();
  assert.equal(d.status, 'pending');
  assert.equal(d.attempts, 1);
  assert.equal(d.next_attempt_at.toISOString(), minutes(t0, 1).toISOString());
  assert.match(d.last_error, /503/);

  await pass(minutes(t0, 0.5), sender); // too soon: nothing
  assert.equal(sender.calls.length, 1);

  await pass(minutes(t0, 1), sender); // attempt 2 fails → retry in 2 min
  [d] = await deliveries();
  assert.equal(d.attempts, 2);
  assert.equal(d.next_attempt_at.toISOString(), minutes(t0, 3).toISOString());

  await pass(minutes(t0, 3), sender); // attempt 3 succeeds
  [d] = await deliveries();
  assert.equal(d.status, 'sent');
  assert.equal(d.last_error, null);
  assert.equal(sender.calls.length, 3);
  const { rows } = await pool.query('SELECT last_ok_at, last_error FROM member_notification_channels WHERE member_id = $1', [sam.id]);
  assert.ok(rows[0].last_ok_at);
  assert.equal(rows[0].last_error, null);
});

test('a send that keeps failing gives up at the give-up time', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await reminders.create(pool, { text: 'Doomed', date: '2026-11-03', time: '09:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  const sender = fakeSender({ fail: () => true });
  let now = at('2026-11-03T14:00:10Z');
  for (let i = 0; i < 40; i += 1) {
    await pass(now, sender);
    const [d] = await deliveries();
    if (d.status !== 'pending') break;
    now = new Date(d.next_attempt_at);
  }
  const [d] = await deliveries();
  assert.equal(d.status, 'failed');
  assert.ok(now < minutes(at('2026-11-03T14:00:00Z'), 12 * 60 + 1), 'stopped within the give-up window');
  assert.ok(sender.calls.length >= 7 && sender.calls.length <= 20, `attempts: ${sender.calls.length}`);
});

test('after downtime only the latest missed occurrence is sent, marked late', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  const id = await reminders.create(pool, {
    text: 'Water plants', date: '2026-11-03', time: '08:00', recipients: [sam.id],
    repeat: { freq: 'daily', count: 10 },
  }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  // 08:00 New York on Nov 3 is 13:00Z. The server is down until Nov 6 at 09:30.
  const sender = fakeSender();
  const s = await pass(at('2026-11-06T14:30:00Z'), sender);
  assert.equal(s.delivered, 1);
  assert.equal(s.missed, 3);
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].payload.message, 'Was due 8:00 AM');

  const ds = await deliveries();
  assert.deepEqual(ds.map((d) => [d.occurrence_no, d.status]), [[0, 'missed'], [1, 'missed'], [2, 'missed'], [3, 'sent']]);
  const row = await reminderRow(id);
  assert.equal(row.fired_count, 4);
  assert.equal(row.next_fire_date, '2026-11-07');
  assert.equal(row.status, 'active');
});

test('an occurrence older than the give-up window is recorded missed, not sent', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  const id = await reminders.create(pool, { text: 'Too late', date: '2026-11-03', time: '08:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  const sender = fakeSender();
  await pass(at('2026-11-04T02:00:00Z'), sender); // 13h after
  assert.equal(sender.calls.length, 0);
  const [d] = await deliveries();
  assert.equal(d.status, 'missed');
  assert.equal((await reminderRow(id)).status, 'completed');
});

test('a bounded series ends after its count, and says so on the last one', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  const id = await reminders.create(pool, {
    text: 'Antibiotic', date: '2026-11-03', time: '20:00', recipients: [sam.id], repeat: { freq: 'daily', count: 2 },
  }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  const sender = fakeSender();
  await pass(at('2026-11-04T01:00:30Z'), sender);
  assert.equal(sender.calls[0].payload.message, '8:00 PM');
  await pass(at('2026-11-05T01:00:30Z'), sender);
  assert.equal(sender.calls[1].payload.message, '8:00 PM · Last one in this series');
  const row = await reminderRow(id);
  assert.equal(row.status, 'completed');
  assert.equal(row.fired_count, 2);
  await pass(at('2026-11-06T01:00:30Z'), sender);
  assert.equal(sender.calls.length, 2);
});

test('a daily series keeps its wall-clock time across the DST change', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  const id = await reminders.create(pool, {
    text: 'Stretch', date: '2026-10-31', time: '09:00', recipients: [sam.id], repeat: { freq: 'daily', count: null },
  }, { timezone: TZ, now: at('2026-10-30T12:00:00Z') });
  const sender = fakeSender();
  await pass(at('2026-10-31T13:00:05Z'), sender); // 09:00 EDT
  let row = await reminderRow(id);
  assert.equal(row.next_fire_at.toISOString(), '2026-11-01T14:00:00.000Z'); // 09:00 EST, an hour later in UTC
  await pass(at('2026-11-01T13:00:05Z'), sender); // 08:00 EST: not yet
  assert.equal(sender.calls.length, 1);
  await pass(at('2026-11-01T14:00:05Z'), sender);
  assert.equal(sender.calls.length, 2);
  row = await reminderRow(id);
  assert.equal(row.max_occurrences, null);
  assert.equal(row.status, 'active');
});

test('a claim abandoned by a crashed dispatcher is taken over after 5 minutes', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await reminders.create(pool, { text: 'Crashy', date: '2026-11-03', time: '09:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  const t0 = at('2026-11-03T14:00:10Z');
  // Record the occurrence without sending, then fake a crash mid-send.
  await pass(t0, fakeSender(), { budgetMs: 0 });
  await pool.query("UPDATE deliveries SET status = 'sending', claimed_at = $1, attempts = 1", [t0]);

  const sender = fakeSender();
  await pass(minutes(t0, 4), sender);
  assert.equal(sender.calls.length, 0, 'a live claim is left alone');
  await pass(minutes(t0, 6), sender);
  assert.equal(sender.calls.length, 1);
  const [d] = await deliveries();
  assert.equal(d.status, 'sent');
  assert.equal(d.attempts, 2);
});

test('deleting a reminder cancels deliveries still waiting to retry', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  const id = await reminders.create(pool, { text: 'Cancel me', date: '2026-11-03', time: '09:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  const t0 = at('2026-11-03T14:00:10Z');
  await pass(t0, fakeSender({ fail: () => true }));
  await reminders.remove(pool, id);
  const sender = fakeSender();
  await pass(minutes(t0, 5), sender);
  assert.equal(sender.calls.length, 0);
  const [d] = await deliveries();
  assert.equal(d.status, 'cancelled');
});

test('a person whose key was removed after scheduling gets retried, then fails, with a clear error', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await reminders.create(pool, { text: 'No key', date: '2026-11-03', time: '09:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  await members.clearKey(pool, sam.id);
  const sender = fakeSender();
  await pass(at('2026-11-03T14:00:10Z'), sender, { sendImpl: require('../lib/brrr').send });
  const [d] = await deliveries();
  assert.equal(d.status, 'pending');
  assert.match(d.last_error, /No brrr key/);
});

test('the pass records a heartbeat for the health check', { skip: db.skip }, async () => {
  await household(['Sam']);
  await pass(at('2026-11-03T14:00:10Z'), fakeSender());
  const last = await dispatcher.lastRun(pool);
  assert.equal(last.source, 'test');
  assert.equal(last.at, '2026-11-03T14:00:10.000Z');
});

test('old finished rows are pruned after the retention period', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  const id = await reminders.create(pool, { text: 'Old', date: '2026-01-05', time: '09:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-01-05T12:00:00Z') });
  await pass(at('2026-01-05T14:00:10Z'), fakeSender());
  await pool.query("UPDATE reminders SET updated_at = '2026-01-05T14:00:10Z' WHERE id = $1", [id]);
  const s = await pass(at('2026-11-03T14:00:10Z'), fakeSender());
  assert.deepEqual(s.pruned, { deliveries: 1, reminders: 1 });
  const again = await pass(at('2026-11-03T14:05:10Z'), fakeSender());
  assert.equal(again.pruned, null, 'pruning runs at most every 6 hours');
});

// ── Regressions from review ─────────────────────────────────────────────────

test('restarting a series that already fired keeps delivering (occurrence numbers never repeat)', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  const id = await reminders.create(pool, {
    text: 'Daily', date: '2026-11-03', time: '09:00', recipients: [sam.id], repeat: { freq: 'daily', count: null },
  }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  const sender = fakeSender();
  for (const day of ['03', '04', '05']) await pass(at(`2026-11-${day}T14:00:10Z`), sender);
  assert.equal(sender.calls.length, 3);
  const row = await reminderRow(id);
  // Change the time: the series restarts from tomorrow at 9:15.
  await reminders.update(pool, id, {
    text: 'Daily', date: '2026-11-06', time: '09:15', recipients: [sam.id], repeat: { freq: 'daily', count: null }, version: row.version,
  }, { timezone: TZ, now: at('2026-11-05T20:00:00Z') });
  for (const day of ['06', '07', '08', '09']) await pass(at(`2026-11-${day}T14:15:10Z`), sender);
  assert.equal(sender.calls.length, 7, 'all four days after the restart were sent');
});

test('a dispatcher that lost its claim cannot overwrite the result of the one that took over', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await reminders.create(pool, { text: 'Stall', date: '2026-11-03', time: '09:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  const t0 = at('2026-11-03T14:00:10Z');
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  const slow = { sendImpl: async () => { await stalled; throw new Error('brrr answered 503'); } };
  const passA = pass(t0, slow);
  // Wait until A has claimed the row, then age its claim and let B take over and succeed.
  for (let i = 0; i < 50; i += 1) {
    const [d] = await deliveries();
    if (d && d.status === 'sending') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await pool.query("UPDATE deliveries SET claimed_at = claimed_at - interval '6 minutes'");
  const b = fakeSender();
  await pass(minutes(t0, 6), b);
  assert.equal(b.calls.length, 1);
  release();
  const a = await passA;
  assert.equal(a.lost, 1, 'A noticed it no longer held the claim');
  const [d] = await deliveries();
  assert.equal(d.status, 'sent', 'B’s result stands');
  assert.equal(d.last_error, null);
});

test('when a newer occurrence is recorded, an older one still retrying is superseded, not sent too', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await reminders.create(pool, {
    text: 'Pills', date: '2026-11-03', time: '09:00', recipients: [sam.id], repeat: { freq: 'daily', count: null },
  }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  const config = { ...CONFIG, giveUpMs: 72 * 3600 * 1000 };
  await pass(at('2026-11-03T14:00:10Z'), fakeSender({ fail: () => true }), { config });
  // Down until Thursday morning: Tuesday's retry is still pending when Thursday's is recorded.
  const sender = fakeSender();
  await pass(at('2026-11-05T14:00:10Z'), sender, { config });
  assert.equal(sender.calls.length, 1, 'only the latest');
  const ds = await deliveries();
  assert.deepEqual(ds.map((d) => [d.occurrence_no, d.status]), [[0, 'missed'], [1, 'missed'], [2, 'sent']]);
  assert.match(ds[0].last_error, /Superseded/);
});

test('removing a person waits for a reminder being saved for them, then takes them off it', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // What reminders.create holds while it saves: the recipient row FOR SHARE.
    await client.query('SELECT id FROM family_members WHERE id = $1 FOR SHARE', [sam.id]);
    const { rows } = await client.query(
      `INSERT INTO reminders (text, level, timezone, start_date, time_of_day, freq, max_occurrences, next_fire_date, next_fire_at)
       VALUES ('Racy', 'active', $1, '2026-11-04', '09:00', 'once', 1, '2026-11-04', '2026-11-04T14:00:00Z') RETURNING id`, [TZ]);
    await client.query('INSERT INTO reminder_recipients (reminder_id, member_id) VALUES ($1, $2)', [rows[0].id, sam.id]);
    let settled = false;
    const archiving = members.archive(pool, sam.id, { force: true }).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(settled, false, 'archive waits for the save');
    await client.query('COMMIT');
    const out = await archiving;
    assert.equal(out.removedFrom, 1);
    assert.equal((await reminderRow(rows[0].id)).status, 'deleted');
  } finally {
    client.release();
  }
});

test('editing only the time keeps "monthly on the 31st" on the 31st', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  const id = await reminders.create(pool, {
    text: 'Rent', date: '2027-01-31', time: '09:00', recipients: [sam.id], repeat: { freq: 'monthly', count: 6 },
  }, { timezone: TZ, now: at('2027-01-01T12:00:00Z') });
  await pass(at('2027-01-31T14:00:10Z'), fakeSender());
  let row = await reminderRow(id);
  assert.equal(row.next_fire_date, '2027-02-28');
  await reminders.update(pool, id, {
    text: 'Rent', date: '2027-02-28', time: '10:00', recipients: [sam.id], repeat: { freq: 'monthly', count: 5 }, version: row.version,
  }, { timezone: TZ, now: at('2027-02-01T12:00:00Z') });
  row = await reminderRow(id);
  assert.equal(row.start_date, '2027-01-31', 'the anchor is kept');
  assert.equal(row.next_fire_date, '2027-02-28');
  const [listed] = await reminders.list(pool, { now: at('2027-02-01T12:00:00Z') });
  assert.equal(listed.describe, 'Monthly on the 31st (or the month’s last day), 5 times');
  await pass(at('2027-02-28T15:00:10Z'), fakeSender());
  assert.equal((await reminderRow(id)).next_fire_date, '2027-03-31');
});

test('"schedule again" can keep the original anchor day', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  const id = await reminders.create(pool, {
    text: 'Rent', date: '2027-04-01', anchor: '2027-01-31', time: '09:00', recipients: [sam.id], repeat: { freq: 'monthly', count: 3 },
  }, { timezone: TZ, now: at('2027-03-20T12:00:00Z') });
  const row = await reminderRow(id);
  assert.equal(row.next_fire_date, '2027-04-30');
  assert.equal(row.start_date, '2027-01-31', 'the anchor is stored, so later months stay on the 31st');
  await pass(at('2027-04-30T13:00:10Z'), fakeSender());
  assert.equal((await reminderRow(id)).next_fire_date, '2027-05-31');
  await assert.rejects(reminders.create(pool, {
    text: 'Bad', date: '2027-04-01', anchor: '2027-05-01', time: '09:00', recipients: [sam.id], repeat: { freq: 'monthly', count: 3 },
  }, { timezone: TZ, now: at('2027-03-20T12:00:00Z') }), /anchor/);
});

test('a text-only edit keeps "Add N more" at the original run length', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  const id = await reminders.create(pool, {
    text: 'Typo', date: '2026-11-03', time: '09:00', recipients: [sam.id], repeat: { freq: 'daily', count: 30 },
  }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  const row = await reminderRow(id);
  await reminders.update(pool, id, {
    text: 'Fixed', date: row.next_fire_date, time: '09:00', recipients: [sam.id], repeat: { freq: 'daily', count: 1 }, version: row.version,
  }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  assert.equal((await reminderRow(id)).extend_by, 30);
});

test('"ending soon" follows the time to the last reminder, not the count left', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  const now = at('2026-11-03T12:00:00Z');
  await reminders.create(pool, { text: 'Yearly', date: '2026-12-01', time: '09:00', recipients: [sam.id], repeat: { freq: 'yearly', count: 2 } }, { timezone: TZ, now });
  await reminders.create(pool, { text: 'Soon', date: '2026-11-04', time: '09:00', recipients: [sam.id], repeat: { freq: 'daily', count: 2 } }, { timezone: TZ, now });
  const list = await reminders.list(pool, { now });
  assert.equal(list.find((r) => r.text === 'Yearly').ending_soon, false);
  assert.equal(list.find((r) => r.text === 'Soon').ending_soon, true);
});

test('a push that only gets through on a late retry says it was due', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await reminders.create(pool, { text: 'Retry late', date: '2026-11-03', time: '09:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  await pass(at('2026-11-03T14:00:10Z'), fakeSender({ fail: () => true }));
  const sender = fakeSender();
  await pool.query("UPDATE deliveries SET next_attempt_at = '2026-11-03T14:30:00Z'");
  await pass(at('2026-11-03T14:30:10Z'), sender);
  assert.equal(sender.calls[0].payload.message, 'Was due 9:00 AM');
});

test('one reminder that cannot be recorded does not block the others', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await pool.query(
    `INSERT INTO reminders (text, level, timezone, start_date, time_of_day, freq, max_occurrences, next_fire_date, next_fire_at)
     VALUES ('Poison', 'active', 'Mars/Olympus', '2026-11-03', '09:00', 'daily', NULL, '2026-11-03', '2026-11-03T13:00:00Z')`);
  await pool.query('INSERT INTO reminder_recipients (reminder_id, member_id) SELECT max(id), $1 FROM reminders', [sam.id]);
  await reminders.create(pool, { text: 'Healthy', date: '2026-11-03', time: '09:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  const sender = fakeSender();
  const logged = [];
  const s = await pass(at('2026-11-03T14:00:10Z'), sender, { log: { error: (m) => logged.push(m), log: () => {} } });
  assert.equal(s.recordErrors, 1);
  assert.deepEqual(sender.calls.map((c) => c.payload.title), ['Healthy']);
  assert.match(logged[0], /could not be recorded/);
});

test('a first send in flight is not reported as a problem', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await reminders.create(pool, { text: 'Inflight', date: '2026-11-03', time: '09:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  await pass(at('2026-11-03T14:00:10Z'), fakeSender(), { budgetMs: 0 });
  await pool.query("UPDATE deliveries SET status = 'sending', attempts = 1, claimed_at = now()");
  assert.deepEqual(await reminders.problems(pool, { now: at('2026-11-03T14:00:20Z') }), []);
});

test('editing a reminder while one of its people is being removed does not deadlock', { skip: db.skip }, async () => {
  const [sam, riley] = await household(['Sam', 'Riley']);
  const id = await reminders.create(pool, { text: 'Both', date: '2026-11-04', time: '09:00', recipients: [sam.id, riley.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  const row = await reminderRow(id);
  // An edit in progress holds the reminder row (what update() takes first) ...
  const editor = await pool.connect();
  try {
    await editor.query('BEGIN');
    await editor.query('SELECT id FROM reminders WHERE id = $1 FOR UPDATE', [id]);
    // ... while Riley is being removed ...
    const archiving = members.archive(pool, riley.id, { force: true });
    await new Promise((r) => setTimeout(r, 150));
    // ... and then the edit locks its people, as parseInput does. With the old lock order this deadlocked.
    await editor.query('SELECT id FROM family_members WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE', [[sam.id, riley.id]]);
    await editor.query('COMMIT');
    const out = await archiving;
    assert.equal(out.removedFrom, 1);
  } finally {
    editor.release();
  }
  assert.equal(row.status, 'active');
  const [listed] = await reminders.list(pool, { now: at('2026-11-03T12:00:00Z') });
  assert.deepEqual(listed.recipients.map((p) => p.name), ['Sam']);
});
