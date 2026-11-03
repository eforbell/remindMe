'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const brrr = require('../lib/brrr');

test('normalizeKey accepts bare secrets and brrr webhook URLs only', () => {
  assert.deepEqual(brrr.normalizeKey('  br_usr_a1b2c3d4e5f6  '), { value: 'br_usr_a1b2c3d4e5f6' });
  assert.deepEqual(brrr.normalizeKey('https://api.brrr.now/v1/br_usr_a1b2c3d4e5f6'), { value: 'br_usr_a1b2c3d4e5f6' });
  for (const bad of ['', 'short', 'has spaces in it', 'http://api.brrr.now/v1/br_usr_a1b2c3d4e5f6',
    'https://evil.example/v1/br_usr_a1b2c3d4e5f6', 'https://api.brrr.now/v1/send', 'https://api.brrr.now/v1/br_usr_a1b2c3d4?x=1']) {
    assert.ok(brrr.normalizeKey(bad).error, bad);
  }
});

test('maskKey shows at most the last four characters', () => {
  assert.equal(brrr.maskKey('br_usr_a1b2c3d4e5f6'), '••••e5f6');
  assert.equal(brrr.maskKey('abcdefgh'), '••••');
  assert.equal(brrr.maskKey(''), null);
});

test('buildPayload: title is the text, message carries time, sender, lateness, series end', () => {
  const p = brrr.buildPayload({
    text: 'Take medicine', level: 'time-sensitive', wallTime: '17:00', wallDate: '2026-11-03', today: '2026-11-03',
    late: false, fromName: 'Sam', isLast: false, threadId: 'remind-me-7', openUrl: 'https://home.example/remind/',
    expiresAt: new Date('2026-11-04T10:00:00Z'), icon: 'https://cdn.example/icon.png',
  });
  assert.deepEqual(p, {
    title: 'Take medicine',
    message: '5:00 PM · from Sam',
    thread_id: 'remind-me-7',
    interruption_level: 'time-sensitive',
    open_url: 'https://home.example/remind/',
    expiration_date: '2026-11-04T10:00:00.000Z',
    icon_url: 'https://cdn.example/icon.png',
  });
  const late = brrr.buildPayload({ text: 'X', level: 'bogus', wallTime: '08:15', wallDate: '2026-11-02', today: '2026-11-03', late: true, isLast: true, threadId: 't' });
  assert.equal(late.message, 'Was due yesterday 8:15 AM · Last one in this series');
  assert.equal(late.interruption_level, 'active');
  assert.equal('open_url' in late, false);
});

test('send uses the bearer header, never the URL, and reports failures without the secret', async () => {
  const secret = 'br_usr_secretvalue1234';
  let seen;
  const ok = async (url, init) => { seen = { url, init }; return { ok: true, status: 200 }; };
  await brrr.send(secret, { title: 't', message: 'm' }, { fetchImpl: ok });
  assert.equal(seen.url, 'https://api.brrr.now/v1/send');
  assert.equal(seen.init.headers.Authorization, `Bearer ${secret}`);
  assert.equal(seen.url.includes(secret), false);

  const bad = async () => ({ ok: false, status: 401, text: async () => `invalid token ${secret}` });
  await assert.rejects(brrr.send(secret, {}, { fetchImpl: bad }), (err) => {
    assert.equal(err.status, 401);
    assert.match(err.message, /401/);
    assert.equal(err.message.includes(secret), false);
    return true;
  });

  const down = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(brrr.send(secret, {}, { fetchImpl: down }), /ECONNREFUSED/);
  await assert.rejects(brrr.send('', {}, { fetchImpl: ok }), /No brrr key/);
});

test('iconUrl only accepts http(s)', () => {
  assert.equal(brrr.iconUrl('https://cdn.example/i.png'), 'https://cdn.example/i.png');
  assert.equal(brrr.iconUrl('javascript:alert(1)'), null);
  assert.equal(brrr.iconUrl(''), null);
});

test('a secret echoed across the truncation point is still redacted', async () => {
  const secret = 'br_usr_' + 'z'.repeat(40);
  const echo = async () => ({ ok: false, status: 400, text: async () => `${'x'.repeat(185)}${secret}` });
  await assert.rejects(brrr.send(secret, {}, { fetchImpl: echo }), (err) => {
    assert.equal(err.message.includes(secret.slice(0, 10)), false);
    assert.match(err.message, /\[secret\]|x{20}/);
    return true;
  });
});
