'use strict';

// Suite identity (Home Base Feature-10): the gate in front of every route in tailnet mode. Local mode is the rest of
// the suite, unchanged. The database is a stand-in that answers what the gate and the routes reached here ask.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSuiteIdentity, homeBaseUid, publicPath } = require('../lib/suite-identity');
const { listenTarget } = require('../lib/listen');
const { createApp } = require('../lib/app');

const SOCKET = 'unix:/run/sovereign-apps/remind-me/app.sock';
const ORIGIN = 'https://smith-home.example-tailnet.ts.net';
const TAILNET = { SOVEREIGN_AUTH_MODE: 'tailnet', SOVEREIGN_LISTEN: SOCKET, SOVEREIGN_HOMEBASE_UID: '998', APP_PUBLIC_URL: `${ORIGIN}/remind/` };
const noSnapshot = { current: () => ({ ok: false, reason: 'missing', message: 'no snapshot' }) };
const unlinked = { findLinked: async () => null };

// A directory snapshot as the library hands it over: members by stable user ID.
function snapshotOf(members) {
  const list = members.map((member) => ({ status: 'active', epoch: 1, apps: ['remind-me'], role: 'parent', ...member }));
  return { current: () => ({ ok: true, snapshot: { members: list, byUserId: new Map(list.map((member) => [member.userId, member])) } }) };
}
const as = (userId, login) => ({ 'x-sovereign-user-id': userId, 'x-sovereign-login': login });
const PARENT = { userId: 'u-parent', memberId: 'm_parent', login: 'parent@example.com', name: 'Parent' };
const KID = { userId: 'u-kid', memberId: 'm_kid', login: 'kid@example.com', name: '<b>Kid</b>', role: 'kid' };
const PARENT_HEADERS = as('u-parent', 'parent@example.com');
const KID_HEADERS = as('u-kid', 'kid@example.com');
const JSON_WRITE = { origin: ORIGIN, 'content-type': 'application/json' };

// family_members as Postgres would answer the gate, the member list, setup and the health probe.
class MembersDb {
  constructor(rows) { this.rows = rows; }
  live() { return this.rows.filter((row) => !row.archived_at); }
  async query(sql, params = []) {
    if (sql.includes('WHERE suite_member_id = $1 AND archived_at IS NULL')) {
      return { rows: this.live().filter((row) => row.suite_member_id === params[0]).map(({ id, name }) => ({ id, name })) };
    }
    if (sql.includes('count(*)::int AS n FROM family_members WHERE archived_at IS NULL')) return { rows: [{ n: this.live().length }] };
    if (sql.includes('FROM family_members WHERE archived_at IS NULL ORDER BY id')) return { rows: this.live().map(({ id, name, suite_member_id }) => ({ id, name, suite_member_id })) };
    if (sql.startsWith('UPDATE family_members SET suite_member_id = $1 WHERE id = $2')) {
      const row = this.live().find((candidate) => candidate.id === params[1] && params[0] === null);
      return { rows: row ? [{ id: row.id, name: row.name, suite_member_id: null }] : [] };
    }
    if (sql.includes('FROM family_members m')) return { rows: this.live().map(({ id, name }) => ({ id, name, has_key: false })) };
    if (sql.includes('INSERT INTO family_members (name)')) {
      const row = { id: this.rows.length + 1, name: params[0], suite_member_id: null };
      this.rows.push(row);
      return { rows: [{ id: row.id, name: row.name }] };
    }
    if (sql.includes('FROM app_config')) return { rows: [] };
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.startsWith('LOCK TABLE family_members')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  async connect() { return { query: (sql, params) => this.query(sql, params), release() {} }; }
}
const household = () => new MembersDb([
  { id: 1, name: 'Parent', suite_member_id: 'm_parent' },
  { id: 2, name: 'Kid', suite_member_id: 'm_kid' },
]);

// A request with exactly these path and headers (fetch would tidy both). A body carries its length: Node sends a
// DELETE's body unframed otherwise.
function send(base, method, path, headers = {}, body) {
  if (body !== undefined) headers = { ...headers, 'content-length': Buffer.byteLength(body) };
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer({ env, reader }, db, fn) {
  const app = createApp({ pool: db, timezone: 'America/New_York', env, suiteReader: reader });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn((method, path, headers, body) => send(base, method, path, headers, body));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const tailnet = (members) => ({ env: TAILNET, reader: snapshotOf(members) });

test('no SOVEREIGN_AUTH_MODE means local: installs from before Home Base set one keep the device\'s choice', () => {
  assert.equal(createSuiteIdentity({}).mode, 'local');
  assert.equal(createSuiteIdentity({ SOVEREIGN_AUTH_MODE: 'local' }).mode, 'local');
  assert.equal(createSuiteIdentity({}).tailnet, false);
});

test('a configuration the app cannot trust refuses to start', () => {
  for (const mode of ['', ' ', 'Tailnet', 'off', 'true']) {
    assert.throws(() => createSuiteIdentity({ ...TAILNET, SOVEREIGN_AUTH_MODE: mode }, unlinked), /SOVEREIGN_AUTH_MODE/, `mode '${mode}'`);
  }
  // Identity headers are trusted only on the app's socket, which only nginx can reach.
  for (const listen of [undefined, '', '127.0.0.1:3013']) {
    assert.throws(() => createSuiteIdentity({ ...TAILNET, SOVEREIGN_LISTEN: listen }, unlinked), /SOVEREIGN_LISTEN/);
  }
  for (const uid of [undefined, '', '0', '-1', '01', '1e3', '4294967295', '99999999999', 'homebase']) {
    assert.throws(() => createSuiteIdentity({ ...TAILNET, SOVEREIGN_HOMEBASE_UID: uid }, unlinked), /SOVEREIGN_HOMEBASE_UID/, `uid '${uid}'`);
  }
  for (const url of [undefined, '', 'remind', 'http://smith-home.example-tailnet.ts.net/remind/']) {
    assert.throws(() => createSuiteIdentity({ ...TAILNET, APP_PUBLIC_URL: url }, unlinked), /APP_PUBLIC_URL/, `url '${url}'`);
  }
  // The link page redirect is built on the path, so it must stay on this host.
  for (const url of [`${ORIGIN}//evil.example/`, `${ORIGIN}/remind//x/`, `${ORIGIN}/rem%2Find/`]) {
    assert.throws(() => createSuiteIdentity({ ...TAILNET, APP_PUBLIC_URL: url }, unlinked), /APP_PUBLIC_URL/, `url '${url}'`);
  }
  for (const [url, path] of [[`${ORIGIN}/remind/`, '/remind/'], [`${ORIGIN}/remind`, '/remind/'], [`${ORIGIN}/`, '/']]) {
    assert.equal(publicPath(url), path);
  }
  assert.equal(homeBaseUid('998'), 998);
  assert.throws(() => createSuiteIdentity(TAILNET), /find linked members/);
  assert.equal(createSuiteIdentity(TAILNET, unlinked).mode, 'tailnet');
  // The app itself: server.js builds it at startup, so a bad configuration stops the process before it listens.
  assert.throws(() => createApp({ pool: household(), timezone: 'America/New_York', env: { ...TAILNET, SOVEREIGN_HOMEBASE_UID: '0' } }), /SOVEREIGN_HOMEBASE_UID/);
  assert.throws(() => createApp({ pool: household(), timezone: 'America/New_York', env: { ...TAILNET, SOVEREIGN_AUTH_MODE: 'on' } }), /SOVEREIGN_AUTH_MODE/);
});

test('tailnet mode always listens on the socket: the identity headers are trusted only there', () => {
  assert.deepEqual(listenTarget({ ...TAILNET, HOST: '127.0.0.1', PORT: '3013' }), { socket: '/run/sovereign-apps/remind-me/app.sock' });
});

test('tailnet mode takes writes only as JSON from the app\'s own origin, DELETE included, before reading the body', async () => {
  await withServer(tailnet([PARENT]), household(), async (call) => {
    const refusals = [
      [{}, 'origin_missing'],
      [{ origin: 'https://smith-pulse.example-tailnet.ts.net', 'content-type': 'application/json' }, 'origin_mismatch'],
      [{ origin: ORIGIN, 'sec-fetch-site': 'same-site', 'content-type': 'application/json' }, 'fetch_site'],
      [{ origin: ORIGIN }, 'content_type'],
      [{ origin: ORIGIN, 'content-type': 'text/plain' }, 'content_type'],
      [{ origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, 'content_type'],
      [{ origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=x' }, 'content_type'],
    ];
    for (const [method, path] of [['POST', '/api/bootstrap/household'], ['DELETE', '/api/reminders/1'], ['DELETE', '/api/suggestions'], ['PUT', '/api/members/1/brrr']]) {
      for (const [headers, reason] of refusals) {
        // A body that isn't JSON: refused by the guard, never read by the parser (which would answer 400).
        const res = await call(method, path, { ...PARENT_HEADERS, ...headers }, 'not json');
        assert.equal(res.status, 403, `${method} ${path} ${reason}`);
        assert.equal(res.json().reason, reason, `${method} ${path}`);
      }
    }
    // Local mode lets a DELETE without a body go untyped; tailnet mode doesn't (above), and takes it typed.
    const res = await call('POST', '/api/bootstrap/household', { ...PARENT_HEADERS, ...JSON_WRITE, 'sec-fetch-site': 'same-origin' }, '{"members":["Jo"]}');
    assert.equal(res.status, 409, 'through the guard and the gate to the handler');
    assert.equal(res.json().code, 'household_already_initialized');
  });
});

test('tailnet mode lets in only a household member with access whom a parent has linked', async () => {
  const members = [
    PARENT,
    KID,
    { userId: 'u-away', memberId: 'm_away', login: 'away@example.com', name: 'Away', status: 'disabled' },
    { userId: 'u-other', memberId: 'm_other', login: 'other@example.com', name: 'Other', apps: ['family-plan'] },
    { userId: 'u-new', memberId: 'm_new', login: 'new@example.com', name: 'New kid', role: 'kid' },
  ];
  await withServer(tailnet(members), household(), async (call) => {
    // Linked: through to the app, parent and kid alike.
    assert.equal((await call('GET', '/api/members', PARENT_HEADERS)).status, 200);
    assert.equal((await call('GET', '/api/members', KID_HEADERS)).status, 200);
    assert.equal((await call('GET', '/', PARENT_HEADERS)).status, 200);

    const refused = [
      [{}, 'not_member'],                                                     // no identity: tagged device, lookup failed
      [as('u-parent', 'someone@example.com'), 'not_member'],                  // the login must match the user ID
      [as('u-nobody', 'nobody@example.com'), 'not_member'],                   // not in the household
      [as('u-away', 'away@example.com'), 'not_member'],                       // disabled
      [as('u-other', 'other@example.com'), 'not_member'],                     // no access to Remind Me
      [{ 'x-sovereign-user-id': 'u-parent', 'x-sovereign-login': 'tagged-devices' }, 'not_member'],
      [as('u-new', 'new@example.com'), 'not_linked'],                         // a kid nobody has linked yet
    ];
    for (const [headers, code] of refused) {
      for (const path of ['/api/members', '/API/members', '/api/members/', '/Api/Members/', '/api/bootstrap', '/api/suite/links', '/api']) {
        const api = await call('GET', path, headers);
        assert.equal(api.status, 403, `${code} ${path}`);
        assert.equal(api.json().code, code, path);
        assert.equal(api.headers['cache-control'], 'no-store');
      }
      for (const path of ['/', '/index.html', '/people', '/people.html', '/setup', '/setup.html', '/link', '/shared/x.html', '/x/%2e%2e/people.html']) {
        const page = await call('GET', path, headers);
        assert.equal(page.status, 403, `${code} ${path}`);
        assert.match(page.headers['content-type'], /text\/html/);
        assert.equal(page.headers['cache-control'], 'no-store');
      }
    }
    // The page names who is asking, as text: a name is never markup.
    const kidPage = (await call('GET', '/', as('u-new', 'new@example.com'))).text;
    assert.match(kidPage, /Ask a parent to link you/);
    assert.match(kidPage, /New kid/);
    // Health and page assets are open, reads only; data and pages are not.
    assert.equal((await call('GET', '/api/health')).status, 200);
    assert.equal((await call('HEAD', '/api/health')).status, 200);
    for (const path of ['/common.js', '/remind-skin.css', '/favicon.svg', '/apple-touch-icon.png', '/sovereign-fonts.css', '/shared/schedule-core.js', '/shared/quick-parse.js']) {
      assert.equal((await call('GET', path)).status, 200, path);
    }
    for (const path of ['/API/health', '/api/health/', '/api/config', '/shared/sub/x.js']) {
      assert.equal((await call('GET', path)).status, 403, path);
    }
    assert.equal((await call('POST', '/common.js', JSON_WRITE, '{}')).status, 403);
  });

  // Without a snapshot nobody is a member: say so, and that it's not the asker's doing.
  await withServer({ env: TAILNET, reader: noSnapshot }, household(), async (call) => {
    const res = await call('GET', '/api/members', PARENT_HEADERS);
    assert.equal(res.status, 503);
    assert.equal(res.json().code, 'directory');
    assert.equal(res.headers['cache-control'], 'no-store');
    const page = await call('GET', '/', PARENT_HEADERS);
    assert.equal(page.status, 503);
    assert.match(page.text, /can&#39;t check who you are/);
  });

  // Local mode ignores identity headers entirely.
  await withServer({ env: {} }, household(), async (call) => {
    assert.equal((await call('GET', '/api/members')).status, 200);
    assert.equal((await call('GET', '/api/members', as('u-nobody', 'nobody@example.com'))).status, 200);
  });
});

test('a person who has been removed is nobody\'s: their account is refused like an unlinked one', async () => {
  const db = household();
  db.rows[1].archived_at = new Date();
  await withServer(tailnet([PARENT, KID]), db, async (call) => {
    const res = await call('GET', '/api/members', KID_HEADERS);
    assert.equal(res.status, 403);
    assert.equal(res.json().code, 'not_linked');
    const page = await call('GET', '/', KID_HEADERS);
    assert.equal(page.status, 403);
    // The kid's name is never markup.
    assert.match(page.text, /&lt;b&gt;Kid&lt;\/b&gt;/);
    assert.doesNotMatch(page.text, /<b>Kid/);
  });
  db.rows[0].archived_at = new Date();
  await withServer(tailnet([PARENT]), db, async (call) => {
    const res = await call('GET', '/', PARENT_HEADERS);
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/remind/link');
  });
});

test('a parent nobody has linked reaches the link page and setup, and nothing about the household', async () => {
  const db = new MembersDb([{ id: 1, name: 'Parent', suite_member_id: null }]);
  await withServer(tailnet([PARENT]), db, async (call) => {
    const get = (path) => call('GET', path, PARENT_HEADERS);
    for (const path of ['/', '/index.html', '/people', '/people.html', '/setup.html', '/LINK', '/link/', '/Setup', '/setup/', '//link', '/link.html']) {
      const res = await get(path);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.location, '/remind/link', path);
    }
    for (const path of ['/api/members', '/api/reminders', '/api/config', '/api/mirror/report', '/api/suite/links/01', '/api/suite/links/1/x',
      '/API/suite/links', '/api/suite/links/', '/api/bootstrap/', '/Api/Bootstrap']) {
      const res = await get(path);
      assert.equal(res.status, 403, path);
      assert.equal(res.json().code, 'not_linked', path);
    }
    for (const [method, path] of [['POST', '/api/members'], ['DELETE', '/api/reminders/1'], ['POST', '/api/bootstrap/household/'], ['POST', '/API/bootstrap/household']]) {
      const res = await call(method, path, { ...PARENT_HEADERS, ...JSON_WRITE }, '{"name":"X"}');
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.json().code, 'not_linked', `${method} ${path}`);
    }
    // Admitted: the link page, its list and a link route (test/suite-links.test.js covers what they do).
    for (const path of ['/link', '/api/suite/links']) assert.equal((await get(path)).status, 200, path);
    const linkRoute = await call('PUT', '/api/suite/links/1', { ...PARENT_HEADERS, ...JSON_WRITE }, '{"suite_member_id":null}');
    assert.equal(linkRoute.status, 200);
    // Setup redirects home once a household exists; the gate then sends them to the link page.
    assert.equal((await get('/setup')).headers.location, './');
    // Setup's status says only whether a household is still needed: no names, no counts.
    const status = await get('/api/bootstrap');
    assert.equal(status.status, 200);
    assert.equal(status.headers['cache-control'], 'no-store');
    assert.deepEqual(status.json(), { status: 'ready', app: 'remind-me', household_initialized: true, bootstrap: { needs_household: false, ready: true } });
    // And setup itself refuses once there is one.
    const again = await call('POST', '/api/bootstrap/household', { ...PARENT_HEADERS, ...JSON_WRITE }, '{"members":["Jo"]}');
    assert.equal(again.status, 409);
    assert.equal(db.rows.length, 1);
  });

  // First run: no household yet. The parent sets it up, then goes on to link themself.
  const empty = new MembersDb([]);
  await withServer(tailnet([PARENT, KID]), empty, async (call) => {
    const page = await call('GET', '/setup', PARENT_HEADERS);
    assert.equal(page.status, 200);
    assert.match(page.text, /setup\.js/);
    assert.equal((await call('GET', '/', PARENT_HEADERS)).headers.location, '/remind/link');
    // A kid nobody has linked can't set it up.
    const kid = await call('POST', '/api/bootstrap/household', { ...KID_HEADERS, ...JSON_WRITE }, '{"members":["Kid"]}');
    assert.equal(kid.status, 403);
    assert.equal(kid.json().code, 'not_linked');
    const made = await call('POST', '/api/bootstrap/household', { ...PARENT_HEADERS, ...JSON_WRITE }, '{"members":["Parent","Kid"]}');
    assert.equal(made.status, 201);
    assert.deepEqual(empty.rows.map((row) => row.name), ['Parent', 'Kid']);
  });
});

test('the API is for Remind Me\'s own pages: a navigation to it is refused, in any spelling', async () => {
  await withServer(tailnet([PARENT]), household(), async (call) => {
    const navigate = (path) => call('GET', path, { ...PARENT_HEADERS, 'sec-fetch-mode': 'navigate' });
    for (const path of ['/api/members', '/API/Members', '/api/members/', '/api/mirror/report', '/Api/config', '/api/suite/links', '/api']) {
      const res = await navigate(path);
      assert.equal(res.status, 403, path);
      assert.equal(res.json().code, 'not_a_page', path);
      assert.equal(res.headers['cache-control'], 'no-store');
    }
    // The pages' own fetches are not navigations, and pages are.
    assert.equal((await call('GET', '/api/members', { ...PARENT_HEADERS, 'sec-fetch-mode': 'cors' })).status, 200);
    assert.equal((await navigate('/')).status, 200);
    // Home Base's probe is open, however it arrives.
    assert.equal((await call('GET', '/api/health', { 'sec-fetch-mode': 'navigate' })).status, 200);
  });
});
