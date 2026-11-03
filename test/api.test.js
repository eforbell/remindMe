'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const { createApp } = require('../lib/app');

const TZ = 'America/New_York';
let pool;
let server;
let base;
let clock = new Date('2026-11-02T15:00:00Z'); // Monday 10:00 New York
const sent = [];

test.before(async () => {
  if (db.skip) return;
  pool = await db.freshPool();
  const app = createApp({
    pool,
    timezone: TZ,
    env: {},
    now: () => clock,
    sendImpl: async (secret, payload) => { sent.push({ secret, payload }); return { status: 200 }; },
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/`;
});
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
});

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data, headers: res.headers };
}

const reminderBody = (extra = {}) => ({
  text: 'Take medicine', recipients: [1], date: '2026-11-02', time: '17:00', level: 'time-sensitive', created_by: 1, ...extra,
});

test('first run: / sends you to setup, setup creates the household once', { skip: db.skip }, async () => {
  let r = await call('GET', '');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'setup');
  r = await call('GET', 'api/bootstrap');
  assert.equal(r.data.household_initialized, false);

  r = await call('POST', 'api/bootstrap/household', { members: ['Sam', 'Riley', 'sam'] });
  assert.equal(r.status, 400, 'duplicate names are refused');
  r = await call('POST', 'api/bootstrap/household', { members: ['Sam', 'Riley'] });
  assert.equal(r.status, 201);
  r = await call('POST', 'api/bootstrap/household', { members: ['Jo'] });
  assert.equal(r.status, 409);
  assert.equal((await call('GET', 'api/bootstrap')).data.household_initialized, true);
  assert.equal((await call('GET', 'setup')).status, 302);
});

test('brrr keys are stored but never returned', { skip: db.skip }, async () => {
  const secret = 'br_usr_supersecretvalue9876';
  let r = await call('PUT', 'api/members/1/brrr', { key: `https://api.brrr.now/v1/${secret}` });
  assert.equal(r.status, 200);
  assert.equal(r.data.key_preview, '••••9876');
  r = await call('PUT', 'api/members/2/brrr', { key: 'https://evil.example/v1/br_usr_x1234567' });
  assert.equal(r.status, 400);
  r = await call('GET', 'api/members');
  const body = JSON.stringify(r.data);
  assert.equal(body.includes(secret), false);
  assert.equal(body.includes('target_secret'), false);
  assert.equal(r.data.members[0].has_key, true);
  assert.equal(r.data.members[1].has_key, false);

  r = await call('POST', 'api/members/1/brrr/test', { level: 'active' });
  assert.deepEqual(r.data, { ok: true });
  assert.equal(sent.at(-1).secret, secret);
  r = await call('POST', 'api/members/2/brrr/test', {});
  assert.equal(r.status, 400);
});

test('creating reminders: validation', { skip: db.skip }, async () => {
  const bad = [
    [{ text: '' }, /what the reminder is for/],
    [{ time: '17:10' }, /quarter hour/],
    [{ date: '2026-02-30' }, /Pick a date/],
    [{ time: '09:00' }, /already passed/],
    [{ recipients: [] }, /at least one person/],
    [{ recipients: [2] }, /no brrr key/],
    [{ recipients: [99] }, /no longer in the household/],
    [{ level: 'loud' }, /alert level/],
    [{ repeat: { freq: 'hourly' } }, /Repeat must be/],
    [{ text: 'x'.repeat(121) }, /under 120/],
  ];
  for (const [extra, msg] of bad) {
    const r = await call('POST', 'api/reminders', reminderBody(extra));
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.match(r.data.error, msg, JSON.stringify(extra));
  }
});

test('create, list, edit, extend, delete', { skip: db.skip }, async () => {
  let r = await call('POST', 'api/reminders', reminderBody({ repeat: { freq: 'daily', count: 3 } }));
  assert.equal(r.status, 201);
  const id = r.data.id;

  r = await call('GET', 'api/reminders');
  let rem = r.data.reminders.find((x) => x.id === id);
  assert.equal(rem.next.date, '2026-11-02');
  assert.equal(rem.next.time, '17:00');
  assert.equal(rem.next.at, '2026-11-02T22:00:00.000Z');
  assert.equal(rem.remaining, 3);
  assert.equal(rem.last.date, '2026-11-04');
  assert.equal(rem.describe, 'Every day, 3 times');
  assert.equal(rem.ending_soon, true, 'last one is within 72 hours');
  assert.deepEqual(rem.recipients.map((p) => p.name), ['Sam']);

  // Text-only edit keeps the series' place; a stale version is refused.
  r = await call('PUT', `api/reminders/${id}`, reminderBody({ text: 'Take meds', repeat: { freq: 'daily', count: 3 }, version: rem.version + 5 }));
  assert.equal(r.status, 409);
  r = await call('PUT', `api/reminders/${id}`, reminderBody({ text: 'Take meds', repeat: { freq: 'daily', count: 3 }, version: rem.version }));
  assert.equal(r.status, 200);
  rem = (await call('GET', 'api/reminders')).data.reminders.find((x) => x.id === id);
  assert.equal(rem.text, 'Take meds');
  assert.equal(rem.next.date, '2026-11-02');

  // Extend adds the original count.
  r = await call('POST', `api/reminders/${id}/extend`, {});
  assert.equal(r.status, 200);
  rem = (await call('GET', 'api/reminders')).data.reminders.find((x) => x.id === id);
  assert.equal(rem.remaining, 6);
  assert.equal(rem.last.date, '2026-11-07');

  // Changing the time restarts the series from the given date.
  r = await call('PUT', `api/reminders/${id}`, reminderBody({ text: 'Take meds', time: '20:30', date: '2026-11-03', repeat: { freq: 'daily', count: 2 }, version: rem.version }));
  assert.equal(r.status, 200);
  rem = (await call('GET', 'api/reminders')).data.reminders.find((x) => x.id === id);
  assert.deepEqual([rem.next.date, rem.next.time, rem.remaining, rem.fired_count], ['2026-11-03', '20:30', 2, 0]);

  r = await call('DELETE', `api/reminders/${id}`);
  assert.equal(r.status, 200);
  assert.equal((await call('GET', 'api/reminders')).data.reminders.some((x) => x.id === id), false);
  assert.equal((await call('DELETE', `api/reminders/${id}`)).status, 404);
});

test('forever series: no last date, cannot be extended', { skip: db.skip }, async () => {
  const r = await call('POST', 'api/reminders', reminderBody({ text: 'Vitamins', repeat: { freq: 'weekly', weekdays: [1, 3, 5], count: null } }));
  const rem = (await call('GET', 'api/reminders')).data.reminders.find((x) => x.id === r.data.id);
  assert.equal(rem.remaining, null);
  assert.equal(rem.last, null);
  assert.equal(rem.ending_soon, false);
  assert.equal(rem.describe, 'Weekly on Mon, Wed, Fri, until deleted');
  assert.equal((await call('POST', `api/reminders/${r.data.id}/extend`, {})).status, 400);
});

test('suggestions come from what was scheduled before', { skip: db.skip }, async () => {
  let r = await call('GET', 'api/suggestions?q=take');
  assert.ok(r.data.suggestions.length >= 1);
  const s = r.data.suggestions[0];
  assert.match(s.text, /^Take/);
  assert.ok(s.time);
  r = await call('GET', 'api/suggestions?q=meds');
  assert.equal(r.data.suggestions[0].text, 'Take meds', 'matches a later word too');
  r = await call('GET', 'api/suggestions?q=%25');
  assert.equal(r.data.suggestions.length, 0, 'LIKE wildcards are escaped');
  await call('DELETE', 'api/suggestions', { text: 'Take meds' });
  r = await call('GET', 'api/suggestions?q=meds');
  assert.equal(r.data.suggestions.length, 0);
});

test('removing a person: refused while on reminders unless forced; their key is erased', { skip: db.skip }, async () => {
  await call('PUT', 'api/members/2/brrr', { key: 'br_usr_riley_key_1234' });
  const r = await call('POST', 'api/reminders', reminderBody({ text: 'Both', recipients: [1, 2] }));
  const solo = await call('POST', 'api/reminders', reminderBody({ text: 'Riley only', recipients: [2] }));
  let d = await call('DELETE', 'api/members/2');
  assert.equal(d.status, 409);
  d = await call('DELETE', 'api/members/2?force=1');
  assert.equal(d.status, 200);
  assert.equal(d.data.removedFrom, 2);
  const list = (await call('GET', 'api/reminders')).data.reminders;
  assert.deepEqual(list.find((x) => x.id === r.data.id).recipients.map((p) => p.id), [1]);
  assert.equal(list.some((x) => x.id === solo.data.id), false, 'left with nobody, it is deleted');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM member_notification_channels WHERE member_id = 2');
  assert.equal(rows[0].n, 0);
});

test('mutations need JSON and same-site requests', { skip: db.skip }, async () => {
  let r = await call('POST', 'api/reminders', 'text=x', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 415);
  r = await call('POST', 'api/members', { name: 'Eve' }, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(r.status, 403);
  r = await call('POST', 'api/members', '{bad json');
  assert.equal(r.status, 400);
  r = await call('GET', 'api/nope');
  assert.equal(r.status, 404);
});

test('health reports the dispatcher heartbeat', { skip: db.skip }, async () => {
  let r = await call('GET', 'api/health');
  assert.equal(r.data.status, 'ok');
  assert.equal(r.data.dispatcher.stale, true);
  await pool.query("INSERT INTO app_config (key, value) VALUES ('dispatch_last_run', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [JSON.stringify({ at: new Date(clock.getTime() - 60000).toISOString(), source: 'timer' })]);
  r = await call('GET', 'api/health');
  assert.equal(r.data.dispatcher.stale, false);
  assert.equal(r.data.dispatcher.last_source, 'timer');
  clock = new Date(clock.getTime() + 10 * 60000);
  r = await call('GET', 'api/health');
  assert.equal(r.data.dispatcher.stale, true);
});

test('config gives the household clock and levels', { skip: db.skip }, async () => {
  const r = await call('GET', 'api/config');
  assert.equal(r.data.timezone, TZ);
  assert.match(r.data.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(r.data.levels.map((l) => l.value), ['passive', 'active', 'time-sensitive', 'critical']);
});
