'use strict';

const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const brrr = require('../lib/brrr');

const ORIGINAL = process.env.PUSH_BASE_URL;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PUSH_BASE_URL;
  else process.env.PUSH_BASE_URL = ORIGINAL;
});

const ok = (sink) => async (url, init) => { sink.url = url; sink.init = init; return { ok: true, status: 200 }; };

test('unset, it posts to brrr with a bearer header, exactly as before', async () => {
  delete process.env.PUSH_BASE_URL;
  const seen = {};
  await brrr.send('br_usr_secretvalue1234', { title: 't' }, { fetchImpl: ok(seen) });
  assert.equal(seen.url, 'https://api.brrr.now/v1/send');
  assert.equal(seen.init.headers.Authorization, 'Bearer br_usr_secretvalue1234');
  assert.deepEqual(brrr.normalizeKey('https://api.brrr.now/v1/br_usr_a1b2c3d4e5f6'), { value: 'br_usr_a1b2c3d4e5f6' });
});

test('a configured service gets the push, including a path prefix', async () => {
  process.env.PUSH_BASE_URL = 'https://gateway.example.test/push/';
  const seen = {};
  await brrr.send('hp_secretvalue1234', { title: 't' }, { fetchImpl: ok(seen) });
  assert.equal(seen.url, 'https://gateway.example.test/push/v1/send');
  assert.equal(seen.url.includes('hp_secretvalue1234'), false);
  assert.deepEqual(brrr.normalizeKey('hp_secretvalue1234'), { value: 'hp_secretvalue1234' });
  assert.deepEqual(brrr.normalizeKey('https://gateway.example.test/push/v1/hp_secretvalue1234'), { value: 'hp_secretvalue1234' });
  assert.ok(brrr.normalizeKey('https://gateway.example.test/push/v1/send').error);
});

test('with a service configured, pasted URLs for any other service are refused', () => {
  process.env.PUSH_BASE_URL = 'http://127.0.0.1:3014';
  for (const key of ['https://api.brrr.now/v1/br_usr_a1b2c3d4e5f6', 'http://127.0.0.1.evil.test:3014/v1/hp_secretvalue1234',
    'http://127.0.0.1:3014/other/hp_secretvalue1234']) {
    assert.match(brrr.normalizeKey(key).error, /different push service/, key);
  }
});

test('a malformed PUSH_BASE_URL fails the send and never falls back to brrr', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, status: 200 }; };
  for (const bad of ['not a url', 'ftp://gateway.example.test', 'https://user:pass@gateway.example.test', 'https://gateway.example.test/?x=1']) {
    process.env.PUSH_BASE_URL = bad;
    await assert.rejects(brrr.send('hp_secretvalue1234', {}, { fetchImpl }), (err) => err instanceof brrr.BrrrError && /PUSH_BASE_URL/.test(err.message), bad);
    assert.match(brrr.normalizeKey('https://api.brrr.now/v1/br_usr_a1b2c3d4e5f6').error, /PUSH_BASE_URL/, bad);
  }
  assert.equal(called, false);
});

test('a blank or delimiter-ended PUSH_BASE_URL is malformed too, but an empty one means unset', async () => {
  const seen = {};
  for (const bad of ['   ', 'https://gateway.example.test/#', 'https://gateway.example.test/?']) {
    process.env.PUSH_BASE_URL = bad;
    await assert.rejects(brrr.send('hp_secretvalue1234', {}, { fetchImpl: ok(seen) }), /PUSH_BASE_URL/, JSON.stringify(bad));
  }
  assert.equal(seen.url, undefined);
  process.env.PUSH_BASE_URL = '';
  await brrr.send('br_usr_secretvalue1234', {}, { fetchImpl: ok(seen) });
  assert.equal(seen.url, 'https://api.brrr.now/v1/send');
});

test('the refusal does not repeat the configured base, and a saved non-secret is not sent as a credential', async () => {
  process.env.PUSH_BASE_URL = 'https://gateway.example.test/v1/hp_misplacedsecret';
  assert.equal(brrr.normalizeKey('https://api.brrr.now/v1/br_usr_a1b2c3d4e5f6').error.includes('misplaced'), false);
  delete process.env.PUSH_BASE_URL;
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, status: 200 }; };
  await assert.rejects(brrr.send('https://old.example.test/v1/oldsecret1234', {}, { fetchImpl }), (err) => !err.message.includes('oldsecret'));
  assert.equal(called, false);
});
