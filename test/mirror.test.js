'use strict';

// The optional push mirror (lib/mirror.js + the dispatcher/members wiring). The rule under test throughout:
// the mirror gets a copy of each delivery at most once, and nothing it does changes the brrr delivery.

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const dispatcher = require('../lib/dispatcher');
const reminders = require('../lib/reminders');
const members = require('../lib/members');
const mirror = require('../lib/mirror');

const TZ = 'America/New_York';
const BASE = 'http://127.0.0.1:9';
const CONFIG = { giveUpMs: 12 * 3600 * 1000, retentionDays: 180, appPublicUrl: null, icon: null, mirrorUrl: BASE };
const at = (iso) => new Date(iso);

let pool;
test.before(async () => { if (!db.skip) pool = await db.freshPool(); });
test.after(async () => { if (pool) await pool.end(); });

function fakeBrrr({ fail = () => false } = {}) {
  const calls = [];
  return {
    calls,
    sendImpl: async (secret, payload) => {
      calls.push({ secret, payload });
      if (fail(calls.length)) throw Object.assign(new Error('brrr answered 503'), { status: 503 });
      return { status: 200 };
    },
  };
}

function fakeMirror({ fail = () => false, delayMs = 0, status = 200 } = {}) {
  const calls = [];
  return {
    calls,
    mirrorImpl: async (base, secret, payload) => {
      calls.push({ base, secret, payload });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail(calls.length)) throw new mirror.MirrorError('Could not reach the mirror gateway: ECONNREFUSED');
      return { status, id: `gw-${calls.length}` };
    },
  };
}

async function household({ mirrorFor = ['Sam'] } = {}) {
  await db.reset(pool);
  const out = {};
  for (const name of ['Sam', 'Riley']) {
    const m = await members.create(pool, { name });
    await members.setKey(pool, m.id, { key: `br_usr_${name.toLowerCase()}_key_0001` });
    if (mirrorFor.includes(name)) await members.setMirrorKey(pool, m.id, { key: `hp_usr_${name.toLowerCase()}_mirror_01` });
    out[name] = m;
  }
  return out;
}

async function oneOff(people, time = '17:00') {
  return reminders.create(pool, {
    text: 'Take medicine', date: '2026-11-03', time, level: 'time-sensitive',
    recipients: [people.Sam.id, people.Riley.id], created_by: people.Sam.id,
  }, { timezone: TZ, now: at('2026-11-03T15:00:00Z') });
}

const pass = (now, brrr, mir, config = CONFIG) => dispatcher.runPass(pool, {
  source: 'test', now: () => now, sendImpl: brrr.sendImpl, mirrorImpl: mir.mirrorImpl, config,
});
const rows = async () => (await pool.query('SELECT * FROM deliveries ORDER BY member_id')).rows;

test('mirrorUrl accepts http(s) bases only, without credentials or query', () => {
  assert.equal(mirror.mirrorUrl(''), null);
  assert.equal(mirror.mirrorUrl('http://127.0.0.1:3014/'), 'http://127.0.0.1:3014');
  assert.equal(mirror.mirrorUrl('https://gw.example.ts.net/push'), 'https://gw.example.ts.net/push');
  assert.equal(mirror.mirrorUrl('ftp://x'), null);
  assert.equal(mirror.mirrorUrl('https://u:p@x.example'), null);
  assert.equal(mirror.mirrorUrl('https://x.example/?a=1'), null);
});

test('send posts brrr-style with a Bearer header, returns the gateway id, redacts the secret', async () => {
  const seen = [];
  const ok = await mirror.send('http://gw', 'hp_usr_secret_123', { title: 't' }, {
    fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify({ id: 'abc', ok: true }), { status: 202 }); },
  });
  assert.deepEqual(ok, { status: 202, id: 'abc' });
  assert.equal(seen[0].url, 'http://gw/v1/send');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer hp_usr_secret_123');
  assert.ok(!seen[0].url.includes('hp_usr_secret_123'));
  await assert.rejects(
    mirror.send('http://gw', 'hp_usr_secret_123', {}, { fetchImpl: async () => new Response('{"error":"bad hp_usr_secret_123"}', { status: 401 }) }),
    (err) => err.status === 401 && !err.message.includes('hp_usr_secret_123') && err.message.includes('[secret]'),
  );
});

test('each delivery is mirrored once, with the same payload, only for members with a mirror key', { skip: db.skip }, async () => {
  const people = await household({ mirrorFor: ['Sam'] });
  await oneOff(people);
  const brrr = fakeBrrr();
  const mir = fakeMirror();
  const s = await pass(at('2026-11-03T22:00:30Z'), brrr, mir);
  assert.equal(s.sent, 2);
  assert.equal(s.mirrored, 1);
  assert.equal(mir.calls.length, 1);
  assert.equal(mir.calls[0].base, BASE);
  assert.equal(mir.calls[0].secret, 'hp_usr_sam_mirror_01');
  const toSamBrrr = brrr.calls.find((c) => c.secret === 'br_usr_sam_key_0001').payload;
  assert.deepEqual(mir.calls[0].payload, toSamBrrr, 'the mirror gets exactly what brrr got');
  const [sam, riley] = await rows();
  assert.equal(sam.status, 'sent');
  assert.equal(sam.mirror_status, 200);
  assert.equal(sam.mirror_id, 'gw-1');
  assert.ok(sam.mirror_done_at);
  assert.equal(riley.mirror_claimed_at, null);

  await pass(at('2026-11-03T22:01:30Z'), brrr, mir);
  assert.equal(mir.calls.length, 1, 'nothing is mirrored twice');
});

test('a mirror failure changes nothing about the brrr delivery', { skip: db.skip }, async () => {
  const people = await household({ mirrorFor: ['Sam', 'Riley'] });
  await oneOff(people);
  const brrr = fakeBrrr();
  const mir = fakeMirror({ fail: () => true });
  const s = await pass(at('2026-11-03T22:00:30Z'), brrr, mir);
  assert.equal(s.sent, 2);
  assert.equal(s.mirror_failed, 2);
  for (const r of await rows()) {
    assert.equal(r.status, 'sent');
    assert.equal(r.attempts, 1);
    assert.match(r.mirror_error, /ECONNREFUSED/);
  }
  const list = await members.list(pool);
  assert.match(list[0].mirror_last_error, /ECONNREFUSED/);
  assert.equal(list[0].last_error, null, 'the brrr channel stays clean');
});

test('a brrr retry does not mirror again; the mirror happens on the first attempt even if brrr fails', { skip: db.skip }, async () => {
  const people = await household({ mirrorFor: ['Sam'] });
  await oneOff(people);
  const brrr = fakeBrrr({ fail: (n) => n <= 2 }); // both first attempts fail
  const mir = fakeMirror();
  let s = await pass(at('2026-11-03T22:00:30Z'), brrr, mir);
  assert.equal(s.retry, 2);
  assert.equal(mir.calls.length, 1);
  s = await pass(at('2026-11-03T22:02:00Z'), brrr, mir);
  assert.equal(s.sent, 2);
  assert.equal(mir.calls.length, 1);
});

test('two dispatchers at once still mirror each delivery once', { skip: db.skip }, async () => {
  const people = await household({ mirrorFor: ['Sam', 'Riley'] });
  await oneOff(people);
  const brrr = fakeBrrr();
  const mir = fakeMirror({ delayMs: 30 });
  const now = at('2026-11-03T22:00:30Z');
  await Promise.all([pass(now, brrr, mir), pass(now, brrr, mir)]);
  assert.equal(mir.calls.length, 2);
  assert.equal(new Set(mir.calls.map((c) => c.secret)).size, 2);
});

test('mirroring is off without PUSH_MIRROR_URL, even with keys set', { skip: db.skip }, async () => {
  const people = await household({ mirrorFor: ['Sam', 'Riley'] });
  await oneOff(people);
  const mir = fakeMirror();
  const s = await pass(at('2026-11-03T22:00:30Z'), fakeBrrr(), mir, { ...CONFIG, mirrorUrl: null });
  assert.equal(s.sent, 2);
  assert.equal(mir.calls.length, 0);
});

test('mirror keys: set (masked), archived members lose theirs, report counts outcomes', { skip: db.skip }, async () => {
  const people = await household({ mirrorFor: ['Sam', 'Riley'] });
  await assert.rejects(members.setMirrorKey(pool, people.Sam.id, { key: 'bad key!' }), /letters, digits/);
  const list = await members.list(pool);
  assert.equal(list[0].has_mirror_key, true);
  assert.equal(list[0].mirror_key_preview, '••••r_01');
  assert.ok(!JSON.stringify(list).includes('hp_usr_sam_mirror_01'));

  await oneOff(people);
  await pass(at('2026-11-03T22:00:30Z'), fakeBrrr(), fakeMirror({ fail: (n) => n === 2 }));
  const rep = await members.mirrorReport(pool, { days: 7, now: at('2026-11-03T23:00:00Z') });
  assert.equal(rep.totals.deliveries, 2);
  assert.equal(rep.totals.brrr_sent, 2);
  assert.equal(rep.totals.mirror_accepted, 1);
  assert.equal(rep.totals.mirror_failed, 1);
  assert.ok(!JSON.stringify(rep).includes('hp_usr_'));
  assert.equal(rep.deliveries[0].title, 'Take medicine');

  await members.archive(pool, people.Riley.id, { force: true });
  const { rowCount } = await pool.query('SELECT 1 FROM member_mirror_channels WHERE member_id = $1', [people.Riley.id]);
  assert.equal(rowCount, 0);
});

test('test push goes to the mirror only and records the outcome', { skip: db.skip }, async () => {
  const people = await household({ mirrorFor: ['Sam'] });
  const mir = fakeMirror();
  const res = await members.testMirror(pool, people.Sam.id, { level: 'time-sensitive' }, { base: BASE, mirrorImpl: mir.mirrorImpl });
  assert.deepEqual(res, { ok: true, status: 200, id: 'gw-1' });
  assert.equal(mir.calls[0].payload.interruption_level, 'time-sensitive');
  await assert.rejects(members.testMirror(pool, people.Riley.id, {}, { base: BASE, mirrorImpl: mir.mirrorImpl }), /no mirror key/);
  await assert.rejects(members.testMirror(pool, people.Sam.id, {}, { base: null, mirrorImpl: mir.mirrorImpl }), /PUSH_MIRROR_URL/);
});
