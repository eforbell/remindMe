'use strict';

// Who sees what: each person sees the reminders they set or are reminded by, and those set for the whole family.
// Only the people on a reminder get its push, whoever can see it. Against PostgreSQL, in both sign-in modes.
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const dispatcher = require('../lib/dispatcher');
const { createApp } = require('../lib/app');

const TZ = 'America/New_York';
const ORIGIN = 'https://park-home.example-tailnet.ts.net';
const TAILNET = {
  SOVEREIGN_AUTH_MODE: 'tailnet',
  SOVEREIGN_LISTEN: 'unix:/run/sovereign-apps/remind-me/app.sock',
  SOVEREIGN_HOMEBASE_UID: '998',
  APP_PUBLIC_URL: `${ORIGIN}/remind/`,
};
const PEOPLE = [
  { userId: 'u-sam', memberId: 'm_sam', login: 'sam@example.com', name: 'Sam', role: 'parent' },
  { userId: 'u-riley', memberId: 'm_riley', login: 'riley@example.com', name: 'Riley', role: 'kid' },
  { userId: 'u-jo', memberId: 'm_jo', login: 'jo@example.com', name: 'Jo', role: 'parent' },
];
const reader = {
  current: () => ({
    ok: true,
    snapshot: {
      members: PEOPLE.map((p) => ({ status: 'active', epoch: 1, apps: ['remind-me'], ...p })),
      byUserId: new Map(PEOPLE.map((p) => [p.userId, { status: 'active', epoch: 1, apps: ['remind-me'], ...p }])),
    },
  }),
};
const SAM = 1;
const RILEY = 2;
const JO = 3;
const AS = {
  [SAM]: { 'x-sovereign-user-id': 'u-sam', 'x-sovereign-login': 'sam@example.com' },
  [RILEY]: { 'x-sovereign-user-id': 'u-riley', 'x-sovereign-login': 'riley@example.com' },
  [JO]: { 'x-sovereign-user-id': 'u-jo', 'x-sovereign-login': 'jo@example.com' },
};
const clock = new Date('2026-11-02T15:00:00Z'); // Monday 10:00 New York

async function household(pool) {
  await db.reset(pool);
  await pool.query("INSERT INTO family_members (name, suite_member_id) VALUES ('Sam', 'm_sam'), ('Riley', 'm_riley'), ('Jo', 'm_jo')");
  await pool.query("INSERT INTO member_notification_channels (member_id, target_secret) VALUES (1, 'br_usr_sam00001'), (2, 'br_usr_riley0001'), (3, 'br_usr_jo000001')");
}

async function withServer(env, pool, fn) {
  const app = createApp({ pool, timezone: TZ, env, suiteReader: env.SOVEREIGN_AUTH_MODE ? reader : undefined, now: () => clock });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const call = async (method, path, headers = {}, body) => {
    const write = !['GET', 'HEAD'].includes(method);
    const res = await fetch(base + path, {
      method,
      headers: { ...headers, ...(write ? { origin: ORIGIN, 'content-type': 'application/json' } : {}) },
      body: write ? JSON.stringify(body ?? {}) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, data };
  };
  try { await fn(call); } finally { await new Promise((resolve) => server.close(resolve)); }
}

const reminder = (text, recipients, extra = {}) => ({ text, recipients, date: '2026-11-02', time: '17:00', level: 'active', ...extra });
const texts = (r) => r.data.reminders.map((x) => x.text).sort();

let pool;
test.before(async () => { if (!db.skip) pool = await db.freshPool(); });
test.after(async () => { if (pool) await pool.end(); });

test('tailnet: each sees what they set or are on, plus whole-family ones; nobody else\'s private ones', { skip: db.skip }, async () => {
  await household(pool);
  await withServer(TAILNET, pool, async (call) => {
    const make = async (who, body) => {
      const r = await call('POST', 'api/reminders', AS[who], body);
      assert.equal(r.status, 201, JSON.stringify(r.data));
      return r.data.id;
    };
    await make(SAM, reminder('Riley: piano practice', [RILEY]));         // Sam set it, Riley is on it
    const samOwn = await make(SAM, reminder('Buy a gift for Jo', [SAM])); // Sam's alone
    await make(RILEY, reminder('Riley: text a friend', [RILEY]));         // Riley's alone
    const trash = await make(SAM, reminder('Trash night', [SAM], { visibility: 'family' }));

    assert.deepEqual(texts(await call('GET', 'api/reminders', AS[SAM])), ['Buy a gift for Jo', 'Riley: piano practice', 'Trash night']);
    assert.deepEqual(texts(await call('GET', 'api/reminders', AS[RILEY])), ['Riley: piano practice', 'Riley: text a friend', 'Trash night']);
    assert.deepEqual(texts(await call('GET', 'api/reminders', AS[JO])), ['Trash night']);

    const listed = (await call('GET', 'api/reminders', AS[SAM])).data.reminders;
    assert.equal(listed.find((r) => r.id === trash).visibility, 'family');
    assert.equal(listed.find((r) => r.id === samOwn).visibility, 'private', 'private unless asked');

    // One you can't see is "not found" to every change, and stays as it was.
    const version = listed.find((r) => r.id === samOwn).version;
    assert.equal((await call('PUT', `api/reminders/${samOwn}`, AS[JO], reminder('Hijacked', [JO], { version }))).status, 404);
    assert.equal((await call('POST', `api/reminders/${samOwn}/extend`, AS[JO], {})).status, 404);
    assert.equal((await call('POST', `api/reminders/${samOwn}/dismiss-renewal`, AS[JO], {})).status, 404);
    assert.equal((await call('DELETE', `api/reminders/${samOwn}`, AS[JO])).status, 404);
    const after = (await pool.query('SELECT text, status, renewal_dismissed_at FROM reminders WHERE id = $1', [samOwn])).rows[0];
    assert.deepEqual(after, { text: 'Buy a gift for Jo', status: 'active', renewal_dismissed_at: null });

    // A whole-family one can be changed by anyone who sees it, as before; an edit that leaves visibility out keeps it.
    const t = (await call('GET', 'api/reminders', AS[JO])).data.reminders[0];
    assert.equal((await call('PUT', `api/reminders/${trash}`, AS[JO], reminder('Trash and recycling night', [SAM], { version: t.version }))).status, 200);
    assert.equal((await pool.query('SELECT visibility FROM reminders WHERE id = $1', [trash])).rows[0].visibility, 'family');
    // And it can be made private again, which takes it out of Jo's list.
    const t2 = (await call('GET', 'api/reminders', AS[SAM])).data.reminders.find((r) => r.id === trash);
    assert.equal((await call('PUT', `api/reminders/${trash}`, AS[SAM], reminder('Trash and recycling night', [SAM], { version: t2.version, visibility: 'private' }))).status, 200);
    assert.deepEqual(texts(await call('GET', 'api/reminders', AS[JO])), []);

    assert.equal((await call('POST', 'api/reminders', AS[SAM], reminder('X', [SAM], { visibility: 'everyone' }))).status, 400);
  });
});

test('tailnet: only the people on a whole-family reminder get its push; delivery history follows what you see', { skip: db.skip }, async () => {
  await household(pool);
  await withServer(TAILNET, pool, async (call) => {
    await call('POST', 'api/reminders', AS[SAM], reminder('Trash night', [SAM], { visibility: 'family' }));
    await call('POST', 'api/reminders', AS[SAM], reminder('Buy a gift for Jo', [SAM]));
    const sent = [];
    await dispatcher.runPass(pool, {
      source: 'test',
      now: () => new Date('2026-11-02T22:00:20Z'),
      sendImpl: async (secret, payload) => {
        sent.push({ secret, title: payload.title });
        if (payload.title === 'Buy a gift for Jo') throw Object.assign(new Error('brrr answered 503'), { status: 503 });
        return { status: 200 };
      },
      config: { ...dispatcher.defaultConfig({}), mirrorUrl: null },
      log: { log() {}, error() {} },
    });
    assert.deepEqual(sent.map((s) => s.secret).sort(), ['br_usr_sam00001', 'br_usr_sam00001'], 'Riley and Jo see Trash night but get no push');

    const seen = async (who) => (await call('GET', 'api/deliveries', AS[who])).data.deliveries.map((d) => d.text).sort();
    assert.deepEqual(await seen(SAM), ['Buy a gift for Jo', 'Trash night']);
    assert.deepEqual(await seen(JO), ['Trash night']);
    // A private reminder's delivery trouble is shown only to those who can see it.
    const trouble = async (who) => (await call('GET', 'api/reminders', AS[who])).data.problems.map((p) => p.text);
    assert.deepEqual(await trouble(SAM), ['Buy a gift for Jo']);
    assert.deepEqual(await trouble(JO), []);
  });
});

test('suggestions are offered back to who wrote them and the people on them, not to everyone', { skip: db.skip }, async () => {
  await household(pool);
  // A row from before suggestions had an author: offered to the people it reminded.
  await pool.query("INSERT INTO suggestions (key, text, last_recipient_ids) VALUES ('call grandma', 'Call grandma', ARRAY[2])");
  await withServer(TAILNET, pool, async (call) => {
    await call('POST', 'api/reminders', AS[SAM], reminder('Buy a gift for Jo', [SAM]));
    await call('POST', 'api/reminders', AS[SAM], reminder('Bring a gift bag', [RILEY]));
    const offered = async (who, q) => (await call('GET', `api/suggestions?q=${encodeURIComponent(q)}`, AS[who])).data.suggestions.map((s) => s.text).sort();
    assert.deepEqual(await offered(SAM, 'gift'), ['Bring a gift bag', 'Buy a gift for Jo']);
    assert.deepEqual(await offered(RILEY, 'gift'), ['Bring a gift bag']);
    assert.deepEqual(await offered(JO, 'gift'), []);
    assert.deepEqual(await offered(JO, ''), []);
    assert.deepEqual(await offered(RILEY, 'grandma'), ['Call grandma']);
    assert.deepEqual(await offered(SAM, 'grandma'), []);
    // Forgetting one you aren't offered does nothing (it's a parent's action in tailnet mode).
    assert.equal((await call('DELETE', 'api/suggestions', AS[JO], { text: 'Buy a gift for Jo' })).status, 200);
    assert.deepEqual(await offered(SAM, 'buy'), ['Buy a gift for Jo']);
  });
});

test('local mode: the device says who it is (X-Remind-Me-As); before it has, only whole-family reminders show', { skip: db.skip }, async () => {
  await household(pool);
  await withServer({}, pool, async (call) => {
    const as = (id) => ({ 'X-Remind-Me-As': String(id) });
    assert.equal((await call('POST', 'api/reminders', as(SAM), reminder('Buy a gift for Jo', [SAM], { created_by: SAM }))).status, 201);
    assert.equal((await call('POST', 'api/reminders', as(SAM), reminder('Trash night', [SAM], { created_by: SAM, visibility: 'family' }))).status, 201);
    assert.equal((await call('POST', 'api/reminders', as(RILEY), reminder('Riley: piano practice', [RILEY], { created_by: SAM }))).status, 201);
    assert.deepEqual(texts(await call('GET', 'api/reminders', as(SAM))), ['Buy a gift for Jo', 'Riley: piano practice', 'Trash night']);
    assert.deepEqual(texts(await call('GET', 'api/reminders', as(RILEY))), ['Riley: piano practice', 'Trash night']);
    assert.deepEqual(texts(await call('GET', 'api/reminders', as(JO))), ['Trash night']);
    assert.deepEqual(texts(await call('GET', 'api/reminders')), ['Trash night'], 'nobody chosen yet');
    assert.deepEqual(texts(await call('GET', 'api/reminders', { 'X-Remind-Me-As': 'Sam' })), ['Trash night'], 'a malformed value is nobody');
  });
});
