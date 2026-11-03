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
