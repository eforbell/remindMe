'use strict';

// Suite identity, member linking: a parent links each Remind Me person to the household member they are.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./helpers/db');
const { createApp } = require('../lib/app');

const ORIGIN = 'https://smith-home.example-tailnet.ts.net';
const TAILNET = {
  SOVEREIGN_AUTH_MODE: 'tailnet',
  SOVEREIGN_LISTEN: 'unix:/run/sovereign-apps/remind-me/app.sock',
  SOVEREIGN_HOMEBASE_UID: '998',
  APP_PUBLIC_URL: `${ORIGIN}/remind/`,
};

function snapshotOf(members) {
  const list = members.map((member) => ({ status: 'active', epoch: 1, apps: ['remind-me'], role: 'parent', ...member }));
  return { current: () => ({ ok: true, snapshot: { members: list, byUserId: new Map(list.map((member) => [member.userId, member])) } }) };
}
const as = (userId, login) => ({ 'x-sovereign-user-id': userId, 'x-sovereign-login': login });
const PARENT_HEADERS = as('u-parent', 'parent@example.com');
const PARTNER_HEADERS = as('u-partner', 'partner@example.com');
const KID_HEADERS = as('u-kid', 'kid@example.com');
const MEMBERS = [
  { userId: 'u-parent', memberId: 'm_parent', login: 'parent@example.com', name: 'Parent' },
  { userId: 'u-partner', memberId: 'm_partner', login: 'partner@example.com', name: 'Partner' },
  { userId: 'u-kid', memberId: 'm_kid', login: 'kid@example.com', name: 'Kid', role: 'kid' },
  { userId: 'u-away', memberId: 'm_away', login: 'away@example.com', name: 'Away', status: 'disabled' },
  { userId: 'u-other', memberId: 'm_other', login: 'other@example.com', name: 'Other', apps: ['family-plan'] },
  { userId: 'u-tagged', memberId: 'm_tagged', login: 'tagged-devices', name: 'Tagged devices' },
];

// family_members as Postgres would answer the gate, the link list and the link UPDATEs (unique suite_member_id).
class MembersDb {
  constructor(rows) { this.rows = rows; }
  live() { return this.rows.filter((row) => !row.archived_at); }
  async query(sql, params = []) {
    if (sql.includes('WHERE suite_member_id = $1 AND archived_at IS NULL')) {
      return { rows: this.live().filter((row) => row.suite_member_id === params[0]).map(({ id, name }) => ({ id, name })) };
    }
    if (sql.includes('FROM family_members WHERE archived_at IS NULL ORDER BY id')) return { rows: this.live().map(({ id, name, suite_member_id }) => ({ id, name, suite_member_id })) };
    if (sql.startsWith('UPDATE family_members SET suite_member_id = NULL WHERE suite_member_id = $1 AND archived_at IS NOT NULL')) {
      for (const row of this.rows) if (row.archived_at && row.suite_member_id === params[0]) row.suite_member_id = null;
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE family_members SET suite_member_id = $1 WHERE id = $2 AND archived_at IS NULL')) {
      const [suiteMemberId, id] = params;
      const row = this.live().find((candidate) => candidate.id === id);
      if (row && suiteMemberId !== null && this.rows.some((other) => other.suite_member_id === suiteMemberId && other.id !== id)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      if (row) row.suite_member_id = suiteMemberId;
      return { rows: row ? [{ id: row.id, name: row.name, suite_member_id: row.suite_member_id }] : [] };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  async connect() { return { query: (sql, params) => this.query(sql, params), release() {} }; }
}
const household = () => new MembersDb([
  { id: 1, name: 'Parent', suite_member_id: null },
  { id: 2, name: 'Partner', suite_member_id: null },
  { id: 3, name: 'Kid', suite_member_id: null },
  { id: 4, name: 'Gone', suite_member_id: null, archived_at: new Date() },
]);

async function withServer(env, reader, pool, fn) {
  const app = createApp({ pool, timezone: 'America/New_York', env, suiteReader: reader });
  const server = app.listen(0, '127.0.0.1');
  const log = console.log;
  const logged = [];
  console.log = (line) => logged.push(String(line));
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (route, headers) => fetch(`${base}${route}`, { headers, redirect: 'manual' });
    const link = (id, suiteMemberId, headers = PARENT_HEADERS) => fetch(`${base}/api/suite/links/${id}`, {
      method: 'PUT',
      headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ suite_member_id: suiteMemberId }),
    });
    await fn({ get, link, logged });
  } finally {
    console.log = log;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a parent links Remind Me people to household members; nobody else can', async () => {
  const pool = household();
  await withServer(TAILNET, snapshotOf(MEMBERS), pool, async ({ get, link, logged }) => {
    // The page's file is never served as a static page, around the route's check: it redirects to the route.
    for (const headers of [PARENT_HEADERS, KID_HEADERS, {}]) {
      assert.notEqual((await get('/link.html', headers)).status, 200);
    }
    // A parent nobody has linked opens the link page and its list.
    const page = await get('/link', PARENT_HEADERS);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /link\.js/);

    // The directory lists only active members with access; the tagged-devices login is never one. People who have
    // been removed are not listed.
    const listed = await get('/api/suite/links', PARENT_HEADERS);
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    const body = await listed.json();
    assert.equal(body.you, 'm_parent');
    assert.deepEqual(body.directory, [
      { memberId: 'm_parent', name: 'Parent', role: 'parent' },
      { memberId: 'm_partner', name: 'Partner', role: 'parent' },
      { memberId: 'm_kid', name: 'Kid', role: 'kid' },
    ]);
    assert.deepEqual(body.members.map((member) => member.id), [1, 2, 3]);

    // Only someone with access, and only once.
    for (const value of ['m_away', 'm_other', 'm_tagged', 'm_nobody', 7, undefined, '', {}]) {
      const res = await link(1, value);
      assert.equal(res.status, 400, String(value));
      assert.equal((await res.json()).code, 'unknown_member');
    }
    assert.deepEqual(pool.rows.map((row) => row.suite_member_id), [null, null, null, null]);
    assert.equal((await link(1, 'm_parent')).status, 200);
    assert.deepEqual(logged, ['[suite-link] m_parent linked person 1 to m_parent'], 'the member ID, never a name');
    // Linked, the parent passes the gate with any spelling; the route still takes only a plain row ID.
    for (const id of ['99', '0', '01', 'abc', '1.5']) assert.equal((await link(id, 'm_partner')).status, 404, id);
    // Someone who has been removed can't be linked.
    const gone = await link(4, 'm_partner');
    assert.equal(gone.status, 404);
    assert.equal(pool.rows[3].suite_member_id, null);
    assert.equal(pool.rows[0].suite_member_id, 'm_parent');
    const twice = await link(2, 'm_parent');
    assert.equal(twice.status, 409);
    assert.equal((await twice.json()).code, 'already_linked');
    assert.equal(pool.rows[1].suite_member_id, null);
    // Linked now: through to the app, where before they were sent to the link page.
    assert.equal((await get('/people', PARENT_HEADERS)).status, 200);

    // People here have no role, so a kid's account may take any person's row (the directory's role still decides
    // what they may do). A kid can't link anyone, even themself, or see the list.
    assert.equal((await link(3, 'm_kid', KID_HEADERS)).status, 403);
    assert.equal(pool.rows[2].suite_member_id, null);
    assert.equal((await link(3, 'm_kid')).status, 200);
    const kidLink = await link(3, null, KID_HEADERS);
    assert.equal(kidLink.status, 403);
    assert.equal(pool.rows[2].suite_member_id, 'm_kid');
    assert.equal((await get('/api/suite/links', KID_HEADERS)).status, 403);
    assert.notEqual((await get('/link', KID_HEADERS)).status, 200);

    // Another parent, linked by the first, may change links too; unlinking frees the household member.
    assert.equal((await link(2, 'm_partner')).status, 200);
    assert.equal((await link(3, null, PARTNER_HEADERS)).status, 200);
    assert.equal(pool.rows[2].suite_member_id, null);
    assert.equal(logged.at(-1), '[suite-link] m_partner unlinked person 3');
    assert.equal((await get('/api/members', KID_HEADERS)).status, 403);
  });
});

test('someone removed keeps nobody\'s account: it can be linked to another person', async () => {
  const pool = household();
  pool.rows[3].suite_member_id = 'm_kid';
  await withServer(TAILNET, snapshotOf(MEMBERS), pool, async ({ get, link }) => {
    // The kid's row was removed: they are refused like anyone unlinked.
    assert.equal((await get('/api/suite/links', KID_HEADERS)).status, 403);
    assert.equal((await link(1, 'm_parent')).status, 200);
    assert.equal((await link(3, 'm_kid')).status, 200);
    assert.deepEqual(pool.rows.map((row) => row.suite_member_id), ['m_parent', null, 'm_kid', null]);
  });
});

test('the link page is tailnet-only, and needs the directory', async () => {
  // Local mode has no link page: the device's own choice is how people say who they are.
  await withServer({}, undefined, household(), async ({ get }) => {
    assert.equal((await get('/api/suite/links')).status, 404);
    assert.equal((await get('/link')).status, 404);
    assert.equal((await get('/link.html')).status, 303);
    const put = await fetch(new URL('/api/suite/links/1', (await get('/link.html')).url), {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"suite_member_id":"m_parent"}',
    });
    assert.equal(put.status, 404);
  });
  // The directory went away after the gate let the parent in (a snapshot that reads once, then fails).
  let reads = 0;
  const flaky = snapshotOf(MEMBERS);
  const reader = { current: () => (reads++ % 2 === 0 ? flaky.current() : { ok: false, reason: 'missing' }) };
  await withServer(TAILNET, reader, household(), async ({ get, link }) => {
    const res = await get('/api/suite/links', PARENT_HEADERS);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'directory');
    const put = await link(1, 'm_parent');
    assert.equal(put.status, 503);
  });
});

// The real table: the migration, its unique column, and the UPDATEs the link route runs.
test('linking against PostgreSQL: unique, live people only, and the migration runs twice', { skip: db.skip }, async () => {
  const pool = await db.freshPool();
  try {
    await pool.query("INSERT INTO family_members (name) VALUES ('Parent'), ('Kid'), ('Gone')");
    await pool.query("UPDATE family_members SET archived_at = now(), suite_member_id = 'm_kid' WHERE name = 'Gone'");
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '0003_suite_member_link.sql'), 'utf8');
    await pool.query(`BEGIN; ${sql} COMMIT;`);
    await withServer(TAILNET, snapshotOf(MEMBERS), pool, async ({ get, link }) => {
      assert.equal((await link(1, 'm_parent')).status, 200);
      assert.equal((await link(2, 'm_parent')).status, 409);
      assert.equal((await link(3, 'm_partner')).status, 404);
      assert.equal((await link(2, 'm_kid')).status, 200);
      assert.equal((await get('/api/members', KID_HEADERS)).status, 200);
      const { rows } = await pool.query('SELECT name, suite_member_id FROM family_members ORDER BY id');
      assert.deepEqual(rows, [{ name: 'Parent', suite_member_id: 'm_parent' }, { name: 'Kid', suite_member_id: 'm_kid' }, { name: 'Gone', suite_member_id: null }]);
    });
  } finally {
    await pool.end();
  }
});
