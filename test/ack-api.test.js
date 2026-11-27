'use strict';

// "Until acknowledged" and snooze through the API (local mode): the setting, Got it and snooze from the app and
// by token, the "waiting" list, what the lists show, and everything that stops a running loop.
// The follow-up lifecycle itself is tested in dispatcher.test.js, tokens in acks.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const { createApp } = require('../lib/app');
const dispatcher = require('../lib/dispatcher');
const members = require('../lib/members');
const acks = require('../lib/acks');

const TZ = 'America/New_York';
const CONFIG = { giveUpMs: 12 * 3600 * 1000, retentionDays: 180, appPublicUrl: null, icon: null };
const at = (iso) => new Date(iso);
let pool;
let server;
let base;
let clock = at('2026-11-03T12:00:00Z');
let sam;
let riley;
let jo;

test.before(async () => {
  if (db.skip) return;
  pool = await db.freshPool();
  const app = createApp({ pool, timezone: TZ, env: {}, now: () => clock, sendImpl: async () => ({ status: 200 }) });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/`;
});
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
});

async function household() {
  await db.reset(pool);
  clock = at('2026-11-03T12:00:00Z');
  [sam, riley, jo] = [];
  const out = [];
  for (const name of ['Sam', 'Riley', 'Jo Park']) {
    const m = await members.create(pool, { name });
    await members.setKey(pool, m.id, { key: `br_usr_${name.split(' ')[0].toLowerCase()}_key_0001` });
    out.push(m);
  }
  [sam, riley, jo] = out;
}

// As `who` (X-Remind-Me-As, the local "who is using this phone" choice).
async function call(who, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(who ? { 'X-Remind-Me-As': String(who.id) } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data };
}

const body = (extra = {}) => ({
  text: 'Take medicine', date: '2026-11-03', time: '09:00', level: 'time-sensitive',
  recipients: [sam.id, riley.id], created_by: sam.id, ack_required: true, ...extra,
});

async function create(extra = {}, who = sam) {
  clock = at('2026-11-03T12:00:00Z');
  const res = await call(who, 'POST', 'api/reminders', body({ date: '2026-11-04', ...extra }));
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.id;
}

async function passAt(iso, sender = async () => ({ status: 200 })) {
  clock = at(iso);
  return dispatcher.runPass(pool, { source: 'test', now: () => clock, sendImpl: sender, config: CONFIG });
}

async function deliveryOf(member, occurrence = 0) {
  const { rows } = await pool.query('SELECT * FROM deliveries WHERE member_id = $1 AND occurrence_no = $2 AND alert_no = 0', [member.id, occurrence]);
  return rows[0];
}

// Wednesday 9:00 New York = 14:00Z.
const FIRE = '2026-11-04T14:00:10Z';

test('the setting: defaults, choices, refused with Passive, kept by an edit that leaves it out', { skip: db.skip }, async () => {
  await household();
  const id = await create();
  let r = await call(sam, 'GET', 'api/reminders');
  const rem = r.data.reminders.find((x) => x.id === id);
  assert.deepEqual([rem.ack_required, rem.realert_every_min, rem.realert_for_min], [true, 15, 240]);

  for (const [extra, code] of [
    [{ level: 'passive' }, 'ack_passive'],
    [{ realert_every_min: 7 }, 'invalid'],
    [{ realert_for_min: 30 }, 'invalid'],
    [{ ack_required: 'yes' }, 'invalid'],
  ]) {
    r = await call(sam, 'POST', 'api/reminders', body({ date: '2026-11-04', ...extra }));
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.equal(r.data.code, code);
  }
  const id2 = await create({ realert_every_min: 5, realert_for_min: 60, text: 'Feed the cat' });
  const row = (await pool.query('SELECT * FROM reminders WHERE id = $1', [id2])).rows[0];
  assert.deepEqual([row.realert_every_min, row.realert_for_min], [5, 60]);

  // An edit that leaves it out keeps it, and can't switch to Passive while it's on.
  const v = row.version;
  r = await call(sam, 'PUT', `api/reminders/${id2}`, { ...body({ date: '2026-11-04', text: 'Feed the cats', version: v }), ack_required: undefined });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await pool.query('SELECT ack_required, realert_every_min FROM reminders WHERE id = $1', [id2])).rows[0].realert_every_min, 5);
  r = await call(sam, 'PUT', `api/reminders/${id2}`, { ...body({ date: '2026-11-04', level: 'passive' }), ack_required: undefined });
  assert.equal(r.data.code, 'ack_passive');

  // A suggestion brings the setting back.
  r = await call(sam, 'GET', 'api/suggestions?q=feed');
  assert.deepEqual(r.data.suggestions[0].repeat.ack, { every: 5, for: 60 });
});

test('Got it from the app: per person, the creator may mark it done for someone, nobody else may', { skip: db.skip }, async () => {
  await household();
  await create();
  await passAt(FIRE);
  const samD = await deliveryOf(sam);
  const rileyD = await deliveryOf(riley);

  let r = await call(sam, 'GET', 'api/reminders');
  assert.equal(r.data.waiting.length, 1, 'Sam is waited on');
  assert.equal(r.data.waiting[0].title, 'Take medicine');
  assert.equal(r.data.waiting[0].due.time, '09:00');

  r = await call(sam, 'POST', `api/deliveries/${samD.id}/ack`, {});
  assert.equal(r.data.result, 'recorded');
  assert.equal((await call(sam, 'GET', 'api/reminders')).data.waiting.length, 0);
  assert.equal((await call(riley, 'GET', 'api/reminders')).data.waiting.length, 1, 'Riley still is');

  assert.equal((await call(jo, 'POST', `api/deliveries/${rileyD.id}/ack`, {})).status, 404, 'not theirs, not their reminder');
  assert.equal((await call(null, 'POST', `api/deliveries/${rileyD.id}/ack`, {})).status, 403, 'nobody picked on this phone');
  assert.equal((await call(sam, 'POST', `api/deliveries/${rileyD.id}/snooze`, { minutes: 10, from: 0 })).status, 404, 'only Riley snoozes Riley');

  r = await call(sam, 'POST', `api/deliveries/${rileyD.id}/ack`, {});
  assert.equal(r.data.result, 'recorded');
  assert.equal(r.data.delivery.acked_by, sam.id, 'marked done by the creator');
  // A finished one-off isn't in the reminders list; its creator sees it through recent deliveries.
  const recent = (await call(sam, 'GET', 'api/deliveries')).data.deliveries;
  assert.deepEqual(recent.map((d) => [d.member_id, d.acked_by, d.follow_up_ended, d.ack_required]).sort(),
    [[sam.id, sam.id, 'acked', true], [riley.id, sam.id, 'acked', true]].sort());
});

test('snooze from the app, and the waiting list for a normal reminder', { skip: db.skip }, async () => {
  await household();
  await create({ ack_required: false, recipients: [riley.id] });
  await passAt(FIRE);
  const d = await deliveryOf(riley);
  let w = (await call(riley, 'GET', 'api/reminders')).data.waiting;
  assert.equal(w.length, 1, 'just went off: snoozable');
  assert.equal(w[0].ack_required, false);
  assert.equal(w[0].can_snooze, true);

  clock = at('2026-11-04T14:05:00Z');
  let r = await call(riley, 'POST', `api/deliveries/${d.id}/snooze`, { minutes: 10, from: 0 });
  assert.equal(r.data.result, 'snoozed');
  assert.equal(r.data.until, '2026-11-04T14:15:00.000Z');
  assert.equal((await call(riley, 'POST', `api/deliveries/${d.id}/snooze`, { minutes: 7, from: 0 })).status, 400);
  assert.equal((await call(riley, 'POST', `api/deliveries/${d.id}/snooze`, { minutes: 10 })).status, 400);

  await passAt('2026-11-04T14:15:10Z');
  clock = at('2026-11-04T14:40:00Z');
  w = (await call(riley, 'GET', 'api/reminders')).data.waiting;
  assert.equal(w.length, 1, 'the snooze alert went off 25 minutes ago');
  assert.equal(w[0].alert_no, 1);
  clock = at('2026-11-04T14:50:00Z');
  assert.equal((await call(riley, 'GET', 'api/reminders')).data.waiting.length, 0, 'gone 30 minutes after');
});

test('an expired delivery shows as not acknowledged for 12 hours, and a late Got it is recorded', { skip: db.skip }, async () => {
  await household();
  await create({ realert_for_min: 60, recipients: [riley.id] });
  await passAt(FIRE);
  await passAt('2026-11-04T16:00:00Z'); // past the deadline
  clock = at('2026-11-04T18:00:00Z');
  let w = (await call(riley, 'GET', 'api/reminders')).data.waiting;
  assert.equal(w.length, 1);
  assert.equal(w[0].ended, 'expired');
  assert.equal(w[0].can_ack, true);
  assert.equal(w[0].can_snooze, false);
  clock = at('2026-11-05T04:00:00Z');
  assert.equal((await call(riley, 'GET', 'api/reminders')).data.waiting.length, 0);
  const r = await call(riley, 'POST', `api/deliveries/${(await deliveryOf(riley)).id}/ack`, {});
  assert.equal(r.data.result, 'recorded');
});

test('by token: POST /api/ack peeks and acknowledges; anything wrong answers gone', { skip: db.skip }, async () => {
  await household();
  await create({ recipients: [riley.id] });
  await passAt(FIRE);
  const d = await deliveryOf(riley);
  const token = acks.makeToken(await acks.ackKey(pool), d.send_key);
  clock = at('2026-11-04T14:03:00Z');
  let r = await call(null, 'POST', 'api/ack', { token, action: 'peek' });
  assert.equal(r.status, 200);
  assert.equal(r.data.delivery.title, 'Take medicine');
  r = await call(null, 'POST', 'api/ack', { token, action: 'ack', from: 0, via: 'link' });
  assert.equal(r.data.result, 'recorded');
  const after = await deliveryOf(riley);
  assert.deepEqual([after.acked_by, after.ack_via], [riley.id, 'link'], 'as the delivery’s own member');
  assert.equal((await call(null, 'POST', 'api/ack', { token: 'x.y', action: 'ack' })).data.result, 'gone');
  assert.equal((await call(null, 'POST', 'api/ack', { token, action: 'nuke' })).status, 400);
  assert.equal((await call(null, 'POST', 'api/ack', { token, action: 'ack', via: 'app' })).status, 400, 'only the app records via app');
  assert.equal((await call(null, 'GET', 'api/ack')).status, 404);
});

test('the list shows each recipient from the reminder’s latest occurrence only', { skip: db.skip }, async () => {
  await household();
  const id = await create({ repeat: { freq: 'daily', count: null } });
  await passAt(FIRE);
  await call(riley, 'POST', `api/deliveries/${(await deliveryOf(riley)).id}/ack`, {});
  // Riley comes off for Thursday's occurrence, then back on.
  clock = at('2026-11-04T15:00:00Z');
  let row = (await pool.query('SELECT version FROM reminders WHERE id = $1', [id])).rows[0];
  await call(sam, 'PUT', `api/reminders/${id}`, body({ date: '2026-11-05', recipients: [sam.id], repeat: { freq: 'daily', count: null }, version: row.version }));
  await passAt('2026-11-05T14:00:10Z');
  clock = at('2026-11-05T15:00:00Z');
  row = (await pool.query('SELECT version FROM reminders WHERE id = $1', [id])).rows[0];
  await call(sam, 'PUT', `api/reminders/${id}`, body({ date: '2026-11-06', repeat: { freq: 'daily', count: null }, version: row.version }));
  const rem = (await call(sam, 'GET', 'api/reminders')).data.reminders.find((x) => x.id === id);
  assert.deepEqual(rem.deliveries.map((d) => d.member_id), [sam.id], 'no old Got it for Riley');
  assert.equal(rem.deliveries[0].follow_ups, 0);
});

test('delete, turning it off, taking someone off and archiving them each stop a running loop; other edits don’t', { skip: db.skip }, async () => {
  const states = async () => (await pool.query('SELECT member_id, follow_up_ended, follow_up_at FROM deliveries WHERE alert_no = 0 ORDER BY member_id')).rows;

  // Delete.
  await household();
  let id = await create({ repeat: { freq: 'daily', count: null } });
  await passAt(FIRE);
  assert.equal((await call(sam, 'DELETE', `api/reminders/${id}`)).status, 200);
  assert.deepEqual((await states()).map((s) => s.follow_up_ended), ['cancelled', 'cancelled']);

  // A text edit keeps the loop; turning it off stops it.
  await household();
  id = await create({ repeat: { freq: 'daily', count: null } });
  await passAt(FIRE);
  clock = at('2026-11-04T14:05:00Z');
  let v = (await pool.query('SELECT version FROM reminders WHERE id = $1', [id])).rows[0].version;
  await call(sam, 'PUT', `api/reminders/${id}`, body({ date: '2026-11-05', text: 'Take medicine now', repeat: { freq: 'daily', count: null }, version: v }));
  assert.ok((await states()).every((s) => s.follow_up_ended == null && s.follow_up_at), 'still running');
  v = (await pool.query('SELECT version FROM reminders WHERE id = $1', [id])).rows[0].version;
  await call(sam, 'PUT', `api/reminders/${id}`, body({ date: '2026-11-05', ack_required: false, repeat: { freq: 'daily', count: null }, version: v }));
  assert.deepEqual((await states()).map((s) => s.follow_up_ended), ['cancelled', 'cancelled']);

  // Taking Riley off stops Riley's loop and cancels Riley's unsent pushes, the first included.
  await household();
  id = await create({ repeat: { freq: 'daily', count: null } });
  await passAt(FIRE, async (secret) => { if (secret.includes('riley')) throw new Error('brrr answered 503'); return { status: 200 }; });
  v = (await pool.query('SELECT version FROM reminders WHERE id = $1', [id])).rows[0].version;
  await call(sam, 'PUT', `api/reminders/${id}`, body({ date: '2026-11-05', recipients: [sam.id], repeat: { freq: 'daily', count: null }, version: v }));
  const r = await deliveryOf(riley);
  assert.deepEqual([r.status, r.follow_up_ended], ['cancelled', 'cancelled']);
  assert.equal((await deliveryOf(sam)).follow_up_ended, null, 'Sam’s keeps running');

  // Archiving Sam stops Sam's.
  await household();
  await create();
  await passAt(FIRE);
  await members.archive(pool, sam.id, { force: true });
  assert.equal((await deliveryOf(sam)).follow_up_ended, 'cancelled');
  assert.equal((await deliveryOf(riley)).follow_up_ended, null);
});

test('problems name failed follow-up alerts; the mirror report and health', { skip: db.skip }, async () => {
  await household();
  await create({ recipients: [riley.id] });
  await passAt(FIRE);
  const fail = async () => { throw new Error('brrr answered 503'); };
  for (const t of ['14:15:20', '14:16:20', '14:18:20', '14:22:20', '14:30:20']) await passAt(`2026-11-04T${t}Z`, fail);
  clock = at('2026-11-04T14:31:00Z');
  const { problems } = (await call(riley, 'GET', 'api/reminders')).data;
  const failed = problems.find((p) => p.status === 'failed');
  assert.deepEqual([failed.alert_no, failed.alert_kind], [1, 'nag']);
  const report = (await call(sam, 'GET', 'api/mirror/report')).data;
  assert.equal(report.totals.deliveries, 1, 'follow-up alerts are not first pushes');
  const health = (await call(null, 'GET', 'api/health')).data;
  assert.equal(typeof health.follow_up_lag_s, 'number');
});

// ── Regressions from review ─────────────────────────────────────────────────

const remindersLib = require('../lib/reminders');

test('deleting a reminder never deadlocks with Got it or a snooze on it', { skip: db.skip }, async () => {
  for (let i = 0; i < 12; i += 1) {
    await household();
    const id = await create({ repeat: { freq: 'daily', count: null } });
    await passAt(FIRE);
    // A re-alert waiting to retry for each of them.
    await passAt('2026-11-04T14:15:20Z', async () => { throw new Error('brrr answered 503'); });
    const [s, r] = [await deliveryOf(sam), await deliveryOf(riley)];
    const results = await Promise.allSettled([
      acks.ack(pool, { deliveryId: s.id, who: sam.id, via: 'app', now: at('2026-11-04T14:16:00Z') }),
      remindersLib.remove(pool, id),
      acks.snooze(pool, { deliveryId: r.id, minutes: 10, from: 1, now: at('2026-11-04T14:16:00Z') }),
    ]);
    for (const x of results) assert.equal(x.status, 'fulfilled', x.reason?.message);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM deliveries WHERE status IN ('pending', 'sending')");
    assert.equal(rows[0].n, 0, 'nothing left to send');
  }
});

test('turning it off and picking Passive in one save works', { skip: db.skip }, async () => {
  await household();
  const id = await create({ repeat: { freq: 'daily', count: null } });
  const v = (await pool.query('SELECT version FROM reminders WHERE id = $1', [id])).rows[0].version;
  const r = await call(sam, 'PUT', `api/reminders/${id}`, body({ date: '2026-11-04', level: 'passive', ack_required: false, repeat: { freq: 'daily', count: null }, version: v }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = (await pool.query('SELECT level, ack_required FROM reminders WHERE id = $1', [id])).rows[0];
  assert.deepEqual(row, { level: 'passive', ack_required: false });
});

test('someone taken off a private reminder can no longer read it through their old delivery or its token', { skip: db.skip }, async () => {
  await household();
  const id = await create({ repeat: { freq: 'daily', count: null } });
  await passAt(FIRE);
  const d = await deliveryOf(riley);
  const token = acks.makeToken(await acks.ackKey(pool), d.send_key);
  assert.equal((await call(riley, 'POST', `api/deliveries/${d.id}/ack`, {})).data.result, 'recorded');
  const v = (await pool.query('SELECT version FROM reminders WHERE id = $1', [id])).rows[0].version;
  await call(sam, 'PUT', `api/reminders/${id}`, body({ date: '2026-11-05', recipients: [sam.id], repeat: { freq: 'daily', count: null }, version: v }));
  const again = await call(riley, 'POST', `api/deliveries/${d.id}/ack`, {});
  assert.equal(again.status, 404);
  assert.equal(again.data.title, undefined);
  assert.deepEqual((await call(null, 'POST', 'api/ack', { token, action: 'peek' })).data, { result: 'gone' });
  assert.ok((await deliveryOf(riley)).acked_at, 'the acknowledgement record is kept');
});

test('a snooze alert still retrying keeps a normal reminder on the waiting list', { skip: db.skip }, async () => {
  await household();
  await create({ ack_required: false, recipients: [riley.id] });
  await passAt(FIRE);
  clock = at('2026-11-04T14:05:00Z');
  await call(riley, 'POST', `api/deliveries/${(await deliveryOf(riley)).id}/snooze`, { minutes: 60, from: 0 });
  await passAt('2026-11-04T15:05:10Z', async () => { throw new Error('brrr answered 503'); });
  clock = at('2026-11-04T15:06:00Z');
  assert.equal((await call(riley, 'GET', 'api/reminders')).data.waiting.length, 1);
});

test('a snoozed one-off whose recipient is then removed stays in its creator’s recent deliveries', { skip: db.skip }, async () => {
  await household();
  await create({ ack_required: false, recipients: [riley.id] });
  await passAt(FIRE, async () => { throw new Error('brrr answered 503'); }); // first push retrying
  clock = at('2026-11-04T14:01:00Z');
  await call(riley, 'POST', `api/deliveries/${(await deliveryOf(riley)).id}/snooze`, { minutes: 30, from: 0 });
  await members.archive(pool, riley.id, { force: true });
  const d = await deliveryOf(riley);
  assert.deepEqual([d.status, d.follow_up_ended], ['cancelled', 'cancelled']);
  const recent = (await call(sam, 'GET', 'api/deliveries')).data.deliveries;
  assert.equal(recent.length, 1);
});
