'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../lib/app');

// Real app + HTTP, with an isolated DB boundary and a local fake push gateway.
// Neither /v1/send nor the existing test-notification path may be invoked.
test('save and recheck verify the saved person secret without sending, with safe failures', async () => {
  const originalBase = process.env.PUSH_BASE_URL;
  let status = 200;
  const secret = 'hp_person_secret_1234';
  let saved;
  const gatewayCalls = [];
  const gateway = http.createServer((req, res) => {
    gatewayCalls.push([req.method, req.url, req.headers.authorization]);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: status === 200, kind: 'person', active: 2, reachable: 2 }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  process.env.PUSH_BASE_URL = `http://127.0.0.1:${gateway.address().port}`;
  const writes = [];
  const pool = { query: async (sql, params) => {
    if (sql.includes('SELECT id, name FROM family_members')) return { rows: params[0] === 1 ? [{ id: 1, name: 'Operator' }] : [] };
    if (sql.includes('INSERT INTO member_notification_channels')) { saved = params[1]; writes.push(sql); return { rows: [] }; }
    if (sql.includes('SELECT c.target_secret FROM family_members')) return { rows: params[0] === 1 ? [{ target_secret: saved }] : [] };
    throw new Error(`Unexpected DB query: ${sql}`);
  } };
  const app = createApp({ pool, timezone: 'America/New_York', env: {}, sendImpl: () => assert.fail('must not send a push') });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const call = (path, method = 'POST', body = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/members/${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const save = await call('1/brrr', 'PUT', { key: secret });
    assert.equal(save.status, 200);
    assert.equal((await save.json()).verification.status, 'verified');
    assert.equal(saved, secret);
    const check = await call('1/brrr/check', 'POST', { secret: 'ignore-this-unsaved-value' });
    const body = await check.json();
    assert.equal(body.status, 'verified');
    assert.equal(body.reachable, 2);
    assert.equal(check.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(body).includes(secret));
    status = 401;
    assert.equal((await (await call('1/brrr/check')).json()).status, 'failed');
    status = 404;
    assert.equal((await (await call('1/brrr/check')).json()).status, 'unsupported');
    assert.equal(writes.length, 1, 'rechecks never change channel/delivery state');
    assert.equal((await call('2/brrr/check')).status, 404);
    assert.equal(gatewayCalls.length, 4);
    assert.ok(gatewayCalls.every(c => c[0] === 'GET' && c[1] === '/v1/check' && c[2] === `Bearer ${secret}`));
    assert.equal((await call('1/brrr/check', 'POST', {})).status, 200);
  } finally {
    server.closeAllConnections(); gateway.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => gateway.close(resolve))]);
    if (originalBase === undefined) delete process.env.PUSH_BASE_URL;
    else process.env.PUSH_BASE_URL = originalBase;
  }
});
