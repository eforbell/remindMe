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
  const sendImpl = async (secret, payload, options = {}) => {
    calls.push({ secret, payload, idempotencyKey: options.idempotencyKey });
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

test('every attempt at a delivery carries the same Idempotency-Key; each delivery its own, random', { skip: db.skip }, async () => {
  const [sam, riley] = await household(['Sam', 'Riley']);
  await reminders.create(pool, { text: 'Lights out', date: '2026-11-03', time: '09:00', recipients: [sam.id, riley.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  // Sam's first attempt "times out" (the gateway may well have pushed it); the retry must say it's the same send.
  const sender = fakeSender({ fail: (n, secret) => n <= 2 && secret.includes('sam') });
  const t0 = at('2026-11-03T14:00:20Z');
  await pass(t0, sender);
  await pass(minutes(t0, 1), sender);
  const ds = await deliveries();
  const keyOf = (d) => `remind-me-${d.send_key}`; // random per delivery: ids repeat across installs
  const samD = ds.find((d) => d.member_id === sam.id);
  const rileyD = ds.find((d) => d.member_id === riley.id);
  assert.equal(samD.status, 'sent');
  const samKeys = sender.calls.filter((c) => c.secret.includes('sam')).map((c) => c.idempotencyKey);
  assert.deepEqual(samKeys, [keyOf(samD), keyOf(samD)]);
  assert.deepEqual(sender.calls.filter((c) => c.secret.includes('riley')).map((c) => c.idempotencyKey), [keyOf(rileyD)]);
  assert.notEqual(keyOf(samD), keyOf(rileyD));
  assert.match(keyOf(samD), /^remind-me-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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

test('the tap-through link is off unless TAP_OPENS_APP=true', () => {
  const url = 'https://home.example.ts.net/remind/';
  assert.equal(dispatcher.defaultConfig({ APP_PUBLIC_URL: url }).appPublicUrl, null);
  assert.equal(dispatcher.defaultConfig({ APP_PUBLIC_URL: url, TAP_OPENS_APP: 'false' }).appPublicUrl, null);
  assert.equal(dispatcher.defaultConfig({ APP_PUBLIC_URL: url, TAP_OPENS_APP: 'true' }).appPublicUrl, url);
  assert.equal(dispatcher.defaultConfig({ APP_PUBLIC_URL: url, TAP_OPENS_APP: ' TRUE ' }).appPublicUrl, url);
  assert.equal(dispatcher.defaultConfig({ TAP_OPENS_APP: 'true' }).appPublicUrl, null);
});

// ── "Until acknowledged" and snooze: follow-up alerts (docs/plan-ack-and-snooze.md) ─────────

const acks = require('../lib/acks');

// 9:00 New York on Tuesday 3 November (14:00Z), to Sam and Riley, re-alerting every `every` minutes for `forMin`.
async function nagReminder(people, { every = 15, forMin = 60, repeat = undefined, text = 'Take medicine' } = {}) {
  const id = await reminders.create(pool, {
    text, date: '2026-11-03', time: '09:00', level: 'time-sensitive', recipients: people.map((p) => p.id), repeat,
  }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  await pool.query('UPDATE reminders SET ack_required = true, realert_every_min = $2, realert_for_min = $3 WHERE id = $1', [id, every, forMin]);
  return id;
}

async function deliveryOf(member, occurrence = 0) {
  const { rows } = await pool.query('SELECT * FROM deliveries WHERE member_id = $1 AND occurrence_no = $2 AND alert_no = 0', [member.id, occurrence]);
  return rows[0];
}

async function alertsOf(member, occurrence = 0) {
  const { rows } = await pool.query(
    'SELECT * FROM deliveries WHERE member_id = $1 AND occurrence_no = $2 AND alert_no > 0 ORDER BY alert_no',
    [member.id, occurrence],
  );
  return rows;
}

const callsTo = (sender, name) => sender.calls.filter((c) => c.secret.includes(name.toLowerCase()));
const T0 = at('2026-11-03T14:00:10Z');

test('Until acknowledged re-alerts each person until the deadline, inside one delivery, never adding occurrences', { skip: db.skip }, async () => {
  const [sam, riley] = await household();
  const id = await nagReminder([sam, riley]);
  const sender = fakeSender();
  await pass(T0, sender);
  const d0 = await deliveryOf(riley);
  assert.equal(d0.follow_up_at.toISOString(), minutes(T0, 15).toISOString(), 'the first nag is armed from the send');
  assert.equal(d0.follow_up_until.toISOString(), minutes(T0, 60).toISOString());
  assert.equal(d0.follow_up_horizon.toISOString(), minutes(T0, 120).toISOString());

  await pass(minutes(T0, 10), sender);
  assert.equal(sender.calls.length, 2, 'nothing before the interval');

  const n1 = at('2026-11-03T14:15:20Z');
  let s = await pass(n1, sender);
  assert.equal(s.follow_ups, 2);
  assert.equal(s.sent, 2);
  const nag = callsTo(sender, 'Riley')[1];
  assert.equal(nag.payload.title, 'Take medicine');
  assert.equal(nag.payload.message, 'Still waiting · was due 9:00 AM · alert 1');
  assert.equal(nag.payload.interruption_level, 'time-sensitive');
  assert.equal(nag.payload.thread_id, `remind-me-${id}`);
  const [a1] = await alertsOf(riley);
  assert.equal(nag.payload.expiration_date, a1.give_up_at.toISOString(), 'its own expiry');
  assert.equal(a1.give_up_at.toISOString(), minutes(n1, 15).toISOString());

  await pass(at('2026-11-03T14:30:30Z'), sender);
  await pass(at('2026-11-03T14:45:40Z'), sender); // the next would be 15:00:40, past 15:00:10: this is the last
  assert.equal((await deliveryOf(riley)).follow_up_ended, 'expired');
  assert.equal(callsTo(sender, 'Riley').length, 4, 'the last nag is sent even though creating it expired the delivery');
  assert.equal(callsTo(sender, 'Riley')[3].payload.message, 'Still waiting · was due 9:00 AM · alert 3');
  await pass(at('2026-11-03T15:10:00Z'), sender);
  await pass(at('2026-11-03T16:30:00Z'), sender);
  assert.equal(sender.calls.length, 8, 'nothing after the deadline');

  const keys = sender.calls.map((c) => c.idempotencyKey);
  assert.equal(new Set(keys).size, 8, 'every alert has its own Idempotency-Key');
  const row = await reminderRow(id);
  assert.equal(row.occurrence_seq, 1, 'still one occurrence');
  assert.equal(row.status, 'completed');
  assert.deepEqual((await alertsOf(riley)).map((a) => [a.alert_no, a.alert_kind, a.status]), [[1, 'nag', 'sent'], [2, 'nag', 'sent'], [3, 'nag', 'sent']]);
});

test('Got it is per person: Sam acknowledging leaves Riley re-alerting; the creator can clear it for Riley', { skip: db.skip }, async () => {
  const [sam, riley] = await household();
  await nagReminder([sam, riley]);
  const sender = fakeSender();
  await pass(T0, sender);
  await pass(at('2026-11-03T14:15:20Z'), sender);
  const out = await acks.ack(pool, { deliveryId: (await deliveryOf(sam)).id, who: sam.id, via: 'app', now: at('2026-11-03T14:16:00Z') });
  assert.equal(out.result, 'recorded');
  await pass(at('2026-11-03T14:30:30Z'), sender);
  assert.equal(callsTo(sender, 'Sam').length, 2);
  assert.equal(callsTo(sender, 'Riley').length, 3);

  const again = await acks.ack(pool, { deliveryId: (await deliveryOf(sam)).id, who: riley.id, via: 'link', now: at('2026-11-03T14:31:00Z') });
  assert.equal(again.result, 'already');
  assert.equal(again.delivery.acked_by, sam.id, 'a replay keeps the first actor');
  assert.equal(again.delivery.acked_at, '2026-11-03T14:16:00.000Z');

  await acks.ack(pool, { deliveryId: (await deliveryOf(riley)).id, who: sam.id, via: 'app', now: at('2026-11-03T14:32:00Z') });
  await pass(at('2026-11-03T14:45:40Z'), sender);
  assert.equal(sender.calls.length, 5);
  const r = await deliveryOf(riley);
  assert.equal(r.acked_by, sam.id, 'recorded as acknowledged by the creator');
  assert.equal(r.follow_up_ended, 'acked');
});

test('nagging never arms before the first push is sent; a first push that gives up never nags', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await nagReminder([sam]);
  const sender = fakeSender({ fail: () => true });
  let now = T0;
  for (let i = 0; i < 40; i += 1) {
    await pass(now, sender);
    const d = await deliveryOf(sam);
    if (d.status !== 'pending') break;
    now = new Date(d.next_attempt_at);
  }
  const d = await deliveryOf(sam);
  assert.equal(d.status, 'failed');
  assert.equal(d.follow_up_at, null);
  assert.equal((await alertsOf(sam)).length, 0);
});

test('Got it while the first push is being sent is recorded, the push is not sent, and nothing arms', { skip: db.skip }, async () => {
  const [sam, riley] = await household();
  await nagReminder([sam, riley]);
  const sender = fakeSender();
  let done = false;
  const afterClaim = async (rows) => {
    if (done) return;
    done = true;
    const riley0 = rows.find((r) => r.member_id === riley.id);
    await acks.ack(pool, { deliveryId: riley0.id, who: riley.id, via: 'app', now: T0 });
  };
  const s = await pass(T0, sender, { afterClaim });
  assert.equal(s.lost, 1, 'the claim was taken away before the send-time check');
  assert.equal(callsTo(sender, 'Riley').length, 0);
  const r = await deliveryOf(riley);
  assert.equal(r.status, 'cancelled', 'an app Got it cancels an unsent first push');
  assert.ok(r.acked_at);
  await pass(at('2026-11-03T14:15:20Z'), sender);
  assert.equal(callsTo(sender, 'Riley').length, 0, 'never armed');
  assert.equal(callsTo(sender, 'Sam').length, 2);
});

test('a token tap from the first push marks it sent; one from a follow-up alert cancels it instead', { skip: db.skip }, async () => {
  const [sam, riley] = await household();
  await nagReminder([sam, riley]);
  // Both first pushes "time out": the phones may well have them.
  await pass(T0, fakeSender({ fail: () => true }));
  const key = await acks.ackKey(pool);
  const samToken = acks.makeToken(key, (await deliveryOf(sam)).send_key);
  const rileyToken = acks.makeToken(key, (await deliveryOf(riley)).send_key);
  const t = at('2026-11-03T14:00:40Z');
  assert.equal((await acks.byToken(pool, { token: samToken, action: 'ack', from: 0, now: t })).result, 'recorded');
  assert.equal((await acks.byToken(pool, { token: rileyToken, action: 'ack', from: 2, now: t })).result, 'recorded');
  const s = await deliveryOf(sam);
  const r = await deliveryOf(riley);
  assert.equal(s.status, 'sent');
  assert.equal(s.ack_via, 'notification');
  assert.equal(s.acked_by, sam.id);
  assert.equal(r.status, 'cancelled', 'a tap from a later alert proves nothing about the first push');
  const sender = fakeSender();
  await pass(at('2026-11-03T14:01:20Z'), sender);
  await pass(at('2026-11-03T14:15:20Z'), sender);
  assert.equal(sender.calls.length, 0);
});

test('two dispatchers create each follow-up alert once and send it once', { skip: db.skip }, async () => {
  const people = await household(['A1', 'B2', 'C3', 'D4']);
  for (let i = 0; i < 8; i += 1) await nagReminder(people, { text: `Thing ${i}` });
  await pass(T0, fakeSender());
  const sender = fakeSender({ delayMs: 5 });
  const now = at('2026-11-03T14:15:20Z');
  const results = await Promise.all([pass(now, sender), pass(now, sender), pass(now, sender)]);
  assert.equal(results.reduce((n, r) => n + r.follow_ups, 0), 32);
  assert.equal(sender.calls.length, 32);
  assert.equal(new Set(sender.calls.map((c) => c.idempotencyKey)).size, 32);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE alert_no = 1');
  assert.equal(rows[0].n, 32);
});

test('after downtime an overdue nag before its deadline sends one alert; one past it sends none', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await nagReminder([sam]);
  const sender = fakeSender();
  await pass(T0, sender);
  await pass(at('2026-11-03T14:52:00Z'), sender); // three nags overdue: one alert, and the next would be past 15:00:10
  assert.equal(sender.calls.length, 2);
  assert.equal((await deliveryOf(sam)).follow_up_ended, 'expired');

  const [riley] = await household(['Riley']);
  await nagReminder([riley]);
  await pass(T0, sender);
  await pass(at('2026-11-03T15:30:00Z'), sender); // down past the deadline
  assert.equal(sender.calls.length, 3, 'only the first push');
  const r = await deliveryOf(riley);
  assert.equal(r.follow_up_ended, 'expired');
  assert.equal(r.follow_up_at, null);
  assert.equal((await alertsOf(riley)).length, 0);
});

test('a failing follow-up alert retries within its own window, then fails and is replaced by the next', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await nagReminder([sam]);
  const sender = fakeSender({ fail: (_n) => false });
  await pass(T0, sender);
  const failing = fakeSender({ fail: () => true });
  const n1 = at('2026-11-03T14:15:20Z');
  await pass(n1, failing);
  let [a1] = await alertsOf(sam);
  assert.equal(a1.status, 'pending');
  assert.equal(a1.next_attempt_at.toISOString(), minutes(n1, 1).toISOString());
  for (const m of [1, 3, 7]) await pass(minutes(n1, m), failing);
  [a1] = await alertsOf(sam);
  assert.equal(a1.status, 'failed', 'the next retry would be past its 15-minute window');
  assert.equal(failing.calls.length, 4);
  assert.equal(new Set(failing.calls.map((c) => c.idempotencyKey)).size, 1, 'every attempt with the same key');
  await pass(at('2026-11-03T14:30:30Z'), sender);
  const alerts = await alertsOf(sam);
  assert.deepEqual(alerts.map((a) => a.status), ['failed', 'sent']);
});

test('a claim on the last nag left by a crashed dispatcher is reclaimed and sent within its window, same key', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await nagReminder([sam], { forMin: 60 });
  await pass(T0, fakeSender());
  for (const t of ['14:15:20', '14:30:30']) await pass(at(`2026-11-03T${t}Z`), fakeSender());
  const last = at('2026-11-03T14:45:40Z');
  await pass(last, fakeSender(), { budgetMs: 0 }); // creates the last nag, then "crashes" mid-send
  await pool.query("UPDATE deliveries SET status = 'sending', claimed_at = $1, claim_token = gen_random_uuid(), attempts = 1 WHERE alert_no = 3", [last]);
  const sender = fakeSender();
  await pass(minutes(last, 6), sender);
  assert.equal(sender.calls.length, 1);
  const a3 = (await alertsOf(sam))[2];
  assert.equal(a3.status, 'sent');
  assert.equal(sender.calls[0].idempotencyKey, `remind-me-${a3.send_key}`);
});

test('a newer alert replaces an older one still retrying', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await nagReminder([sam], { every: 5 });
  await pass(T0, fakeSender());
  await pass(at('2026-11-03T14:05:20Z'), fakeSender({ fail: () => true }));
  await pass(at('2026-11-03T14:10:30Z'), fakeSender());
  assert.deepEqual((await alertsOf(sam)).map((a) => [a.status, a.last_error]), [['missed', 'A newer alert was due.'], ['sent', null]]);
});

test('Got it cancels a first push waiting to retry; a snooze cancels a follow-up alert waiting to retry', { skip: db.skip }, async () => {
  const [sam, riley] = await household();
  await nagReminder([sam, riley]);
  await pass(T0, fakeSender({ fail: (_n, secret) => secret.includes('riley') }));
  assert.equal((await deliveryOf(riley)).status, 'pending');
  await acks.ack(pool, { deliveryId: (await deliveryOf(riley)).id, who: riley.id, via: 'app', now: at('2026-11-03T14:00:40Z') });
  await pass(at('2026-11-03T14:15:20Z'), fakeSender({ fail: () => true })); // Sam's nag fails, waits to retry
  const sender = fakeSender();
  const [a1] = await alertsOf(sam);
  assert.equal(a1.status, 'pending');
  const out = await acks.snooze(pool, { deliveryId: (await deliveryOf(sam)).id, minutes: 10, from: 1, now: at('2026-11-03T14:15:50Z') });
  assert.equal(out.result, 'snoozed');
  assert.equal(out.until, '2026-11-03T14:25:50.000Z');
  await pass(at('2026-11-03T14:16:20Z'), sender);
  await pass(at('2026-11-03T14:20:30Z'), sender);
  assert.equal(sender.calls.length, 0, 'nothing during the snooze, Riley never again');
  assert.equal((await alertsOf(sam))[0].status, 'cancelled');
  assert.equal((await deliveryOf(riley)).status, 'cancelled');
  await pass(at('2026-11-03T14:26:00Z'), sender);
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].payload.message, 'Snoozed · was due 9:00 AM');
  const s = await deliveryOf(sam);
  assert.equal(s.follow_up_kind, 'nag', 'nagging resumes after the snooze alert');
  assert.equal(s.follow_up_at.toISOString(), '2026-11-03T14:41:00.000Z');
});

test('a snooze on a normal reminder alerts exactly once; replays and stale snoozes change nothing', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await reminders.create(pool, { text: 'Bins out', date: '2026-11-03', time: '09:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  const sender = fakeSender();
  await pass(T0, sender);
  const id = (await deliveryOf(sam)).id;
  assert.equal((await deliveryOf(sam)).follow_up_at, null, 'a normal reminder never nags');
  const first = await acks.snooze(pool, { deliveryId: id, minutes: 10, from: 0, now: at('2026-11-03T14:03:00Z') });
  assert.equal(first.until, '2026-11-03T14:13:00.000Z');
  const replay = await acks.snooze(pool, { deliveryId: id, minutes: 30, from: 0, now: at('2026-11-03T14:04:00Z') });
  assert.equal(replay.result, 'snoozed');
  assert.equal(replay.until, '2026-11-03T14:13:00.000Z', 'a replay never moves it');
  await pass(at('2026-11-03T14:13:10Z'), sender);
  await pass(at('2026-11-03T14:30:00Z'), sender);
  await pass(at('2026-11-03T15:30:00Z'), sender);
  assert.equal(sender.calls.length, 2);
  assert.equal(sender.calls[1].payload.message, 'Snoozed · was due 9:00 AM');
  assert.equal((await acks.snooze(pool, { deliveryId: id, minutes: 10, from: 0, now: at('2026-11-03T14:20:00Z') })).result, 'stale');
  assert.equal((await acks.snooze(pool, { deliveryId: id, minutes: 10, from: 1, now: at('2026-11-03T14:20:00Z') })).result, 'snoozed', 'snoozing again from the latest alert works');
});

test('a snooze is capped at the horizon and still sent', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await reminders.create(pool, { text: 'Bins out', date: '2026-11-03', time: '09:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  const sender = fakeSender();
  await pass(T0, sender);
  const d = await deliveryOf(sam);
  assert.equal(d.follow_up_horizon.toISOString(), '2026-11-04T02:00:10.000Z', '12 hours from the send');
  const out = await acks.snooze(pool, { deliveryId: d.id, minutes: 60, from: 0, now: at('2026-11-04T01:55:00Z') });
  assert.equal(out.until, '2026-11-04T01:58:10.000Z', 'two minutes short of the horizon, so a late pass still finds it in time');
  await pass(at('2026-11-04T01:59:00Z'), sender);
  assert.equal(sender.calls.length, 2);
  assert.equal((await acks.snooze(pool, { deliveryId: d.id, minutes: 10, from: 1, now: at('2026-11-04T01:59:30Z') })).result, 'stale', 'too close to the horizon');
});

test('deadlines are hard: a follow-up still uncreated when its deadline passes is never created', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await nagReminder([sam]);
  await pass(T0, fakeSender());
  const d = await deliveryOf(sam);
  // The latest a cursor is ever placed: two minutes before follow_up_until (15:00:10). The dispatcher is down
  // until a minute after the deadline.
  await pool.query("UPDATE deliveries SET follow_up_at = '2026-11-03T14:58:10Z' WHERE id = $1", [d.id]);
  const sender = fakeSender();
  await pass(at('2026-11-03T15:01:10Z'), sender);
  assert.equal(sender.calls.length, 0);
  assert.equal((await deliveryOf(sam)).follow_up_ended, 'expired');
});

test('the first push’s deadlines and first nag run from when it was marked sent, not when it was claimed', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await nagReminder([sam], { every: 5 });
  const done = at('2026-11-03T14:00:18Z'); // the gateway took 8 seconds
  let calls = 0;
  await dispatcher.runPass(pool, { source: 'test', now: () => (calls++ < 2 ? T0 : done), sendImpl: fakeSender().sendImpl, config: CONFIG });
  const d = await deliveryOf(sam);
  assert.equal(d.sent_at.toISOString(), done.toISOString());
  assert.equal(d.follow_up_at.toISOString(), minutes(done, 5).toISOString());
  assert.equal(d.follow_up_until.toISOString(), minutes(done, 60).toISOString());
});

test('a pass that runs before migration 0006 is applied claims nothing', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await reminders.create(pool, { text: 'Queued', date: '2026-11-03', time: '09:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  await pool.query("DELETE FROM schema_migrations WHERE filename = '0006_ack_and_snooze.sql'");
  try {
    const sender = fakeSender();
    const s = await pass(T0, sender);
    assert.equal(s.waiting_for_migration, true);
    assert.equal(sender.calls.length, 0);
    assert.equal((await deliveries()).length, 0, 'nothing recorded or claimed');
  } finally {
    await pool.query("INSERT INTO schema_migrations (filename) VALUES ('0006_ack_and_snooze.sql') ON CONFLICT DO NOTHING");
  }
  const sender = fakeSender();
  await pass(minutes(T0, 1), sender);
  assert.equal(sender.calls.length, 1, 'sent once the migration is in');
});

test('Got it never deadlocks against archiving the person', { skip: db.skip }, async () => {
  for (let i = 0; i < 15; i += 1) {
    const [sam, riley] = await household();
    await reminders.create(pool, { text: 'One-off', date: '2026-11-03', time: '09:00', recipients: [sam.id, riley.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
    await pass(T0, fakeSender({ fail: () => true })); // a completed one-off whose first pushes wait to retry
    const d = await deliveryOf(riley);
    const results = await Promise.allSettled([
      acks.ack(pool, { deliveryId: d.id, who: riley.id, via: 'app', now: minutes(T0, 1) }),
      members.archive(pool, riley.id, { force: true }),
      acks.ack(pool, { deliveryId: (await deliveryOf(sam)).id, who: riley.id, via: 'app', now: minutes(T0, 1) }),
    ]);
    for (const r of results) assert.equal(r.status, 'fulfilled', r.reason?.message);
  }
});

test('a newer occurrence, even one recorded missed, ends older follow-ups and their unsent alerts', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await nagReminder([sam], { repeat: { freq: 'daily', count: null }, forMin: 720 });
  await pass(T0, fakeSender());
  await pass(at('2026-11-03T14:15:20Z'), fakeSender({ fail: () => true })); // alert 1 waiting to retry
  // Stretch the loop so it is still running when Wednesday's occurrence is recorded, then miss that one.
  await pool.query("UPDATE deliveries SET follow_up_until = '2026-11-05T00:00:00Z', follow_up_horizon = '2026-11-05T00:00:00Z', give_up_at = '2026-11-05T00:00:00Z' WHERE member_id = $1 AND occurrence_no = 0", [sam.id]);
  const sender = fakeSender();
  await pass(at('2026-11-04T14:30:00Z'), sender, { config: { ...CONFIG, giveUpMs: 15 * 60000 } });
  const d = await deliveryOf(sam);
  assert.equal(d.follow_up_ended, 'superseded');
  assert.equal(d.follow_up_at, null);
  const [a1] = await alertsOf(sam);
  assert.equal(a1.status, 'missed');
  assert.match(a1.last_error, /Superseded/);
  assert.equal((await deliveryOf(sam, 1)).status, 'missed');
  assert.equal(sender.calls.length, 0);
});

test('a newer occurrence recorded missed leaves an older first push that still has time to retry', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await reminders.create(pool, { text: 'Pills', date: '2026-11-03', time: '09:00', recipients: [sam.id], repeat: { freq: 'daily', count: null } }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  await pass(T0, fakeSender({ fail: () => true }), { config: { ...CONFIG, giveUpMs: 72 * 3600 * 1000 } });
  // The setting is lowered: Wednesday's is already past its give-up, Tuesday's still has its stored 72 hours.
  const sender = fakeSender();
  await pass(at('2026-11-04T14:30:00Z'), sender, { config: { ...CONFIG, giveUpMs: 15 * 60000 } });
  assert.equal((await deliveryOf(sam, 1)).status, 'missed');
  assert.equal((await deliveryOf(sam, 0)).status, 'sent', 'Tuesday’s retry still went');
});

test('a worker that claimed a follow-up alert before Got it committed does not send it', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await nagReminder([sam]);
  await pass(T0, fakeSender());
  const sender = fakeSender();
  const afterClaim = async () => {
    await acks.ack(pool, { deliveryId: (await deliveryOf(sam)).id, who: sam.id, via: 'app', now: at('2026-11-03T14:15:21Z') });
  };
  const s = await pass(at('2026-11-03T14:15:20Z'), sender, { afterClaim });
  assert.equal(s.lost, 1);
  assert.equal(sender.calls.length, 0);
  const [a1] = await alertsOf(sam);
  assert.equal(a1.status, 'cancelled');
  await pass(at('2026-11-03T14:21:00Z'), sender);
  assert.equal(sender.calls.length, 0, 'never reclaimed');
});

test('a first push still retrying after its recipient was removed is never sent', { skip: db.skip }, async () => {
  const [sam, riley] = await household();
  await reminders.create(pool, { text: 'Private thing', date: '2026-11-03', time: '09:00', recipients: [sam.id, riley.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  await pass(T0, fakeSender({ fail: () => true }));
  await pool.query('DELETE FROM reminder_recipients WHERE member_id = $1', [riley.id]);
  const sender = fakeSender();
  await pass(at('2026-11-03T14:01:20Z'), sender);
  assert.deepEqual(sender.calls.map((c) => c.secret), ['br_usr_sam_key_0001']);
  assert.equal((await deliveryOf(riley)).status, 'cancelled');
});

test('follow-up alerts go ahead of an old backlog of first pushes', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await nagReminder([sam]);
  await pass(T0, fakeSender());
  for (let i = 0; i < 12; i += 1) {
    await reminders.create(pool, { text: `Backlog ${i}`, date: '2026-11-03', time: '08:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  }
  await pass(at('2026-11-03T14:14:00Z'), fakeSender({ fail: () => true }), { budgetMs: 0 }); // record the backlog only
  let firstBatch = null;
  const afterClaim = async (rows) => { firstBatch = firstBatch || rows; };
  await pass(at('2026-11-03T14:15:20Z'), fakeSender(), { afterClaim });
  assert.equal(firstBatch.length, 10);
  assert.ok(firstBatch.some((r) => r.alert_no === 1), 'the nag is in the first batch');
  assert.equal(await dispatcher.followUpLag(pool, at('2026-11-03T14:16:00Z')), 0);
});

test('a follow-up alert expires on its own window even when the first push went out 11 hours late', { skip: db.skip }, async () => {
  const [sam] = await household(['Sam']);
  await nagReminder([sam]);
  const late = at('2026-11-04T01:00:10Z'); // 8:00 PM the same evening in New York
  const sender = fakeSender();
  await pass(late, sender);
  assert.match(sender.calls[0].payload.message, /^Was due/);
  await pass(minutes(late, 15), sender);
  assert.equal(sender.calls.length, 2);
  assert.equal(sender.calls[1].payload.expiration_date, minutes(late, 30).toISOString());
  assert.equal(sender.calls[1].payload.message, 'Still waiting · was due 9:00 AM · alert 1');
  assert.equal((await deliveryOf(sam)).follow_up_until.toISOString(), minutes(late, 60).toISOString(), 'deadlines run from the send');
});

test('follow-up creation never deadlocks against delete or archive', { skip: db.skip }, async () => {
  const people = await household(['A1', 'B2', 'C3']);
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push(await nagReminder(people, { text: `Thing ${i}`, every: 5 }));
  await pass(T0, fakeSender());
  const now = at('2026-11-03T14:05:20Z');
  const results = await Promise.allSettled([
    pass(now, fakeSender({ delayMs: 2 })),
    ...ids.slice(0, 3).map((id) => reminders.remove(pool, id)),
    members.archive(pool, people[2].id),
    pass(now, fakeSender({ delayMs: 2 })),
  ]);
  for (const r of results) assert.equal(r.status, 'fulfilled', r.reason?.message);
});
