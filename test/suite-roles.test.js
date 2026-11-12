'use strict';

// Suite identity, roles: in tailnet mode the directory's role decides what each member may do, and a reminder is
// from their own linked person. Local mode keeps the device's own choice and lets everyone do everything.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('./helpers/db');
const { createApp } = require('../lib/app');

const ORIGIN = 'https://smith-home.example-tailnet.ts.net';
const TAILNET = {
  SOVEREIGN_AUTH_MODE: 'tailnet',
  SOVEREIGN_LISTEN: 'unix:/run/sovereign-apps/remind-me/app.sock',
  SOVEREIGN_HOMEBASE_UID: '998',
  APP_PUBLIC_URL: `${ORIGIN}/remind/`,
};
// The directory, as a live list: a test can change someone's role between requests.
function directoryOf(members) {
  const list = members.map((member) => ({ status: 'active', epoch: 1, apps: ['remind-me'], role: 'parent', ...member }));
  return { list, current: () => ({ ok: true, snapshot: { members: list, byUserId: new Map(list.map((member) => [member.userId, member])) } }) };
}
const as = (userId, login) => ({ 'x-sovereign-user-id': userId, 'x-sovereign-login': login });
const PARENT_HEADERS = as('u-parent', 'parent@example.com');
const KID_HEADERS = as('u-kid', 'kid@example.com');
const MEMBERS = () => [
  { userId: 'u-parent', memberId: 'm_parent', login: 'parent@example.com', name: 'Parent' },
  { userId: 'u-kid', memberId: 'm_kid', login: 'kid@example.com', name: 'Kid', role: 'kid' },
];

// A stand-in database: the gate's lookup and the household count are answered; anything else is an empty answer, so
// a route reached here may still fail on its own (400, 404, 500), which is not what these tests look at.
class StandInDb {
  constructor() {
    this.rows = [
      { id: 1, name: 'Parent', suite_member_id: 'm_parent' },
      { id: 2, name: '</script><b>Kid</b>', suite_member_id: 'm_kid' },
    ];
  }
  async query(sql, params = []) {
    if (sql.includes('WHERE suite_member_id = $1 AND archived_at IS NULL')) {
      return { rows: this.rows.filter((row) => row.suite_member_id === params[0]).map(({ id, name }) => ({ id, name })) };
    }
    if (sql.includes('count(*)::int AS n FROM family_members')) return { rows: [{ n: this.rows.length }] };
    return { rows: [], rowCount: 0 };
  }
  async connect() { return { query: (sql, params) => this.query(sql, params), release() {} }; }
}

function send(base, method, path, headers = {}, body) {
  const write = !['GET', 'HEAD'].includes(method);
  const text = body === undefined ? (write ? '{}' : undefined) : JSON.stringify(body);
  const all = { ...headers, ...(write ? { origin: ORIGIN, 'content-type': 'application/json' } : {}), ...(text ? { 'content-length': Buffer.byteLength(text) } : {}) };
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers: all }, (res) => {
      let out = '';
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: out, json: () => JSON.parse(out) }));
    });
    req.on('error', reject);
    req.end(text);
  });
}

async function withServer(env, reader, pool, fn, options = {}) {
  const app = createApp({ pool, timezone: 'America/New_York', env, suiteReader: reader, ...options });
  const server = app.listen(0, '127.0.0.1');
  const error = console.error;
  console.error = () => {};
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn((method, path, headers, body) => send(base, method, path, headers, body));
  } finally {
    console.error = error;
    await new Promise((resolve) => server.close(resolve));
  }
}

// What a kid may do: the main page, its reads, and reminders for anyone.
const KID_ALLOWED = [
  ['GET', '/'], ['HEAD', '/'],
  ['GET', '/api/me'], ['GET', '/api/config'], ['GET', '/api/members'], ['GET', '/api/reminders'],
  ['GET', '/api/deliveries'], ['GET', '/api/deliveries?limit=5'], ['GET', '/api/suggestions?q=med'], ['HEAD', '/api/reminders'],
  ['POST', '/api/reminders', { text: 'x', recipients: [1] }], ['PUT', '/api/reminders/3', { text: 'x' }], ['DELETE', '/api/reminders/3'],
  ['POST', '/api/reminders/3/extend'], ['POST', '/api/reminders/3/dismiss-renewal'],
];
// The People page and everything else is a parent's.
const PARENT_ONLY = [
  ['POST', '/api/members', { name: 'X' }], ['PATCH', '/api/members/1', { name: 'X' }], ['DELETE', '/api/members/1'], ['DELETE', '/api/members/1?force=1'],
  ['PUT', '/api/members/1/brrr', { key: 'k' }], ['DELETE', '/api/members/1/brrr'], ['POST', '/api/members/1/brrr/test'],
  ['PUT', '/api/members/1/mirror', { key: 'k' }], ['DELETE', '/api/members/1/mirror'], ['POST', '/api/members/1/mirror/test'],
  ['GET', '/api/mirror/report'], ['GET', '/api/mirror/report?days=7'],
  ['DELETE', '/api/suggestions', { text: 'x' }], ['GET', '/api/bootstrap'], ['POST', '/api/bootstrap/household', { members: ['X'] }],
  ['GET', '/api/suite/links'], ['PUT', '/api/suite/links/2', { suite_member_id: null }], ['GET', '/api/health/'],
];
// The kid's routes in other spellings and with other methods: refused, never matched loosely.
const KID_SPELLINGS = [
  ['GET', '/API/reminders'], ['GET', '/api/reminders/'], ['GET', '/Api/Me'], ['GET', '/api/me/'], ['GET', '/api//reminders'],
  ['PUT', '/api/reminders/03'], ['PUT', '/api/reminders/0'], ['DELETE', '/api/reminders/3/'], ['DELETE', '/API/reminders/3'],
  ['POST', '/api/reminders/'], ['POST', '/API/Reminders'], ['POST', '/api/reminders/3/extend/'], ['POST', '/api/reminders/3/Extend'],
  ['POST', '/api/reminders/x/extend'], ['POST', '/api/reminders/3/%2e%2e/extend'],
  ['PATCH', '/api/reminders/3'], ['DELETE', '/api/reminders'], ['PUT', '/api/reminders'], ['POST', '/api/members'],
  ['POST', '/api/me'], ['DELETE', '/api/me'], ['PUT', '/api/config'], ['POST', '/api/reminders/3'], ['DELETE', '/api/reminders/3/extend'],
  ['GET', '/api/reminders/3'], ['GET', '/api/reminders/3/extend'],
];

test('a kid may use the main page, its reads and reminders for anyone; the People page is a parent\'s', async () => {
  await withServer(TAILNET, directoryOf(MEMBERS()), new StandInDb(), async (call) => {
    for (const [method, path, body] of KID_ALLOWED) {
      const res = await call(method, path, KID_HEADERS, body);
      assert.notEqual(res.status, 303, `${method} ${path}`);
      assert.ok(res.status !== 403, `${method} ${path}: ${res.status} ${res.text}`);
    }
    for (const [method, path, body] of [...PARENT_ONLY, ...KID_SPELLINGS]) {
      const res = await call(method, path, KID_HEADERS, body);
      assert.equal(res.status, 403, `${method} ${path}`);
      if (method !== 'HEAD') assert.equal(res.json().code, 'parent_only', `${method} ${path}`);
      assert.equal(res.headers['cache-control'], 'no-store', `${method} ${path}`);
    }
    // Every page but the main one sends a kid to the main page, in any spelling.
    for (const path of ['/people', '/people.html', '/People', '/people/', '/index.html', '/link', '/link.html', '/setup', '/setup.html', '//', '/x/%2e%2e/people.html', '/anything']) {
      const res = await call('GET', path, KID_HEADERS);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.location, '/remind/', path);
    }
    // Page assets stay open to them, as to anyone.
    assert.equal((await call('GET', '/people.js', KID_HEADERS)).status, 200);
  });
});

test('a parent may use everything, the People page included', async () => {
  await withServer(TAILNET, directoryOf(MEMBERS()), new StandInDb(), async (call) => {
    for (const path of ['/', '/people', '/people.html', '/link']) {
      assert.equal((await call('GET', path, PARENT_HEADERS)).status, 200, path);
    }
    for (const [method, path, body] of [...KID_ALLOWED, ...PARENT_ONLY.filter(([, path]) => !path.startsWith('/api/health'))]) {
      const res = await call(method, path, PARENT_HEADERS, body);
      assert.notEqual(res.status, 303, `${method} ${path}`);
      assert.ok(res.status !== 403, `${method} ${path}: ${res.status} ${res.text}`);
    }
  });
});

test('the directory\'s role is read on every request: a parent made a kid loses the People page at once', async () => {
  const directory = directoryOf(MEMBERS());
  await withServer(TAILNET, directory, new StandInDb(), async (call) => {
    assert.equal((await call('GET', '/people', PARENT_HEADERS)).status, 200);
    assert.equal((await call('GET', '/api/mirror/report', PARENT_HEADERS)).status, 200);
    directory.list[0].role = 'kid';
    assert.equal((await call('GET', '/people', PARENT_HEADERS)).status, 303);
    assert.equal((await call('GET', '/api/mirror/report', PARENT_HEADERS)).status, 403);
    assert.equal((await call('GET', '/api/me', PARENT_HEADERS)).json().member.role, 'kid');
    // And back: the same linked row, a parent again.
    directory.list[0].role = 'parent';
    assert.equal((await call('GET', '/api/mirror/report', PARENT_HEADERS)).status, 200);
    // A kid made a parent gets the People page; their row is the same.
    directory.list[1].role = 'parent';
    assert.equal((await call('GET', '/people', KID_HEADERS)).status, 200);
  });
});

test('/api/me says who the pages show: the linked person with the directory\'s role, or nobody in local mode', async () => {
  await withServer(TAILNET, directoryOf(MEMBERS()), new StandInDb(), async (call) => {
    const parent = await call('GET', '/api/me', PARENT_HEADERS);
    assert.equal(parent.headers['cache-control'], 'no-store');
    assert.deepEqual(parent.json(), { mode: 'tailnet', member: { id: 1, name: 'Parent', role: 'parent' } });
    assert.deepEqual((await call('GET', '/api/me', KID_HEADERS)).json(), { mode: 'tailnet', member: { id: 2, name: '</script><b>Kid</b>', role: 'kid' } });
  });
  await withServer({}, undefined, new StandInDb(), async (call) => {
    assert.deepEqual((await call('GET', '/api/me', KID_HEADERS)).json(), { mode: 'local', member: null });
  });
});

test('in tailnet mode a reminder is from the requester\'s own person, whoever the request names', { skip: db.skip }, async () => {
  const pool = await db.freshPool();
  try {
    await pool.query("INSERT INTO family_members (name, suite_member_id) VALUES ('Parent', 'm_parent'), ('Kid', 'm_kid')");
    await pool.query("INSERT INTO member_notification_channels (member_id, target_secret) VALUES (1, 'br_usr_test0001'), (2, 'br_usr_test0002')");
    const clock = new Date('2026-11-02T15:00:00Z');
    const reminder = (extra) => ({ text: 'Feed the cat', recipients: [1, 2], date: '2026-11-02', time: '17:00', level: 'active', ...extra });
    const createdBy = async () => (await pool.query('SELECT created_by FROM reminders ORDER BY id')).rows.map((row) => row.created_by);
    await withServer(TAILNET, directoryOf(MEMBERS()), pool, async (call) => {
      // The kid names the parent's row (1); the reminder is from the kid's (2). Naming nobody, it's still theirs.
      assert.equal((await call('POST', '/api/reminders', KID_HEADERS, reminder({ created_by: 1 }))).status, 201);
      assert.equal((await call('POST', '/api/reminders', KID_HEADERS, reminder({}))).status, 201);
      assert.equal((await call('POST', '/api/reminders', PARENT_HEADERS, reminder({ created_by: 2 }))).status, 201);
      assert.deepEqual(await createdBy(), [2, 2, 1]);
      // A kid edits, extends and deletes anyone's reminder (the household's decision).
      const { reminders } = (await call('GET', '/api/reminders', KID_HEADERS)).json();
      const parents = reminders.find((r) => r.created_by === 1);
      assert.equal((await call('PUT', `/api/reminders/${parents.id}`, KID_HEADERS, reminder({ text: 'Feed the dog', version: parents.version }))).status, 200);
      assert.equal((await call('DELETE', `/api/reminders/${parents.id}`, KID_HEADERS)).status, 200);
      assert.deepEqual(await createdBy(), [2, 2, 1], 'an edit keeps who it was from');
    }, { now: () => clock });
    // Local mode: the device's choice, from the request, as before.
    await withServer({}, undefined, pool, async (call) => {
      assert.equal((await call('POST', '/api/reminders', {}, reminder({ created_by: 1 }))).status, 201);
      assert.deepEqual(await createdBy(), [2, 2, 1, 1]);
    }, { now: () => clock });
  } finally {
    await pool.end();
  }
});
