'use strict';

// "Until acknowledged" and snooze: tokens, acting by token, and keeping tokens secret (lib/acks.js).
// The follow-up alert lifecycle itself is tested in dispatcher.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./helpers/db');
const dispatcher = require('../lib/dispatcher');
const reminders = require('../lib/reminders');
const members = require('../lib/members');
const acks = require('../lib/acks');
const brrr = require('../lib/brrr');

const TZ = 'America/New_York';
const CONFIG = { giveUpMs: 12 * 3600 * 1000, retentionDays: 180, appPublicUrl: null, icon: null };
const at = (iso) => new Date(iso);
const T0 = at('2026-11-03T14:00:10Z'); // 9:00:10 New York
const ok = { sendImpl: async () => ({ status: 200 }) };
const failing = { sendImpl: async () => { throw Object.assign(new Error('brrr answered 503'), { status: 503 }); } };

let pool;
test.before(async () => { if (!db.skip) pool = await db.freshPool(); });
test.after(async () => { if (pool) await pool.end(); });

async function setup({ ack = true, sender = ok } = {}) {
  await db.reset(pool);
  const sam = await members.create(pool, { name: 'Sam' });
  await members.setKey(pool, sam.id, { key: 'br_usr_sam_key_0001' });
  const id = await reminders.create(pool, { text: 'Take medicine', date: '2026-11-03', time: '09:00', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  if (ack) await pool.query('UPDATE reminders SET ack_required = true, realert_every_min = 15, realert_for_min = 60 WHERE id = $1', [id]);
  await dispatcher.runPass(pool, { source: 'test', now: () => T0, sendImpl: sender.sendImpl, config: CONFIG });
  const { rows: [d] } = await pool.query('SELECT * FROM deliveries WHERE alert_no = 0');
  return { sam, id, d, token: acks.makeToken(await acks.ackKey(pool), d.send_key) };
}

test('a token names one delivery and only verifies with this install’s key', () => {
  const key = 'a'.repeat(64);
  const sendKey = '0b7e6f1c-3a52-4d2b-9a77-5f1d2c3b4a59';
  const token = acks.makeToken(key, sendKey);
  assert.match(token, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
  assert.equal(acks.verifyToken(key, token), sendKey);
  assert.equal(acks.verifyToken('b'.repeat(64), token), null, 'another install');
  const [raw, sig] = token.split('.');
  const flipped = sig[0] === 'A' ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
  assert.equal(acks.verifyToken(key, `${raw}.${flipped}`), null);
  const other = acks.makeToken(key, '1b7e6f1c-3a52-4d2b-9a77-5f1d2c3b4a59');
  assert.equal(acks.verifyToken(key, `${other.split('.')[0]}.${sig}`), null, 'a signature for one delivery never works for another');
  for (const junk of [null, undefined, '', 'x.y', `${token}.`, { token }]) assert.equal(acks.verifyToken(key, junk), null);
});

test('the signing key exists after migrating and is not recreated', { skip: db.skip }, async () => {
  await db.reset(pool);
  const [a, b] = await Promise.all([acks.ackKey(pool), acks.ackKey(pool)]);
  assert.equal(a, b, 'concurrent callers end up with the same key');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(await acks.ackKey(pool), a);
});

test('acting by token: peek, then Got it as the delivery’s own member; replays answer already', { skip: db.skip }, async () => {
  const { sam, token } = await setup();
  const peek = await acks.byToken(pool, { token, action: 'peek', now: at('2026-11-03T14:05:00Z') });
  assert.equal(peek.result, 'ok');
  assert.equal(peek.delivery.title, 'Take medicine');
  assert.equal(peek.delivery.ack_required, true);
  assert.equal(peek.delivery.alert_no, 0);
  assert.equal(peek.delivery.can_snooze, true);
  const { rows: [still] } = await pool.query('SELECT acked_at FROM deliveries WHERE alert_no = 0');
  assert.equal(still.acked_at, null, 'peeking never acknowledges');

  const out = await acks.byToken(pool, { token, action: 'ack', via: 'link', from: 0, now: at('2026-11-03T14:06:00Z') });
  assert.equal(out.result, 'recorded');
  assert.equal(out.delivery.acked_by, sam.id);
  assert.equal(out.delivery.ack_via, 'link');
  const again = await acks.byToken(pool, { token, action: 'ack', now: at('2026-11-03T14:07:00Z') });
  assert.equal(again.result, 'already');
  assert.equal(again.delivery.acked_at, '2026-11-03T14:06:00.000Z');
  assert.equal(again.delivery.ack_via, 'link');
  assert.equal((await acks.byToken(pool, { token, action: 'snooze', minutes: 10, from: 0, now: at('2026-11-03T14:08:00Z') })).result, 'already', 'Got it wins over a later snooze');
});

test('a forged, foreign or rotated-out token answers gone', { skip: db.skip }, async () => {
  const { d, token } = await setup();
  const now = at('2026-11-03T14:05:00Z');
  assert.equal((await acks.byToken(pool, { token: acks.makeToken('f'.repeat(64), d.send_key), action: 'ack', now })).result, 'gone');
  assert.equal((await acks.byToken(pool, { token: 'nonsense', action: 'peek', now })).result, 'gone');
  await pool.query("UPDATE app_config SET value = $1 WHERE key = 'ack_key'", ['e'.repeat(64)]);
  assert.equal((await acks.byToken(pool, { token, action: 'ack', now })).result, 'gone', 'rotating the key kills outstanding tokens');
  const { rows: [after] } = await pool.query('SELECT acked_at FROM deliveries WHERE id = $1', [d.id]);
  assert.equal(after.acked_at, null);
  await assert.rejects(acks.byToken(pool, { token, action: 'delete', now }), /Unknown action/);
});

test('a token stops working past its horizon + 12 h, or once the delivery is superseded or cancelled', { skip: db.skip }, async () => {
  const { d, token } = await setup();
  // Horizon: sent 14:00:10 + 60 min + 60 min = 16:00:10; the token works until 04:00:10 the next morning.
  assert.equal((await acks.byToken(pool, { token, action: 'peek', now: at('2026-11-04T04:00:00Z') })).result, 'ok');
  assert.equal((await acks.byToken(pool, { token, action: 'peek', now: at('2026-11-04T04:00:20Z') })).result, 'gone');
  await acks.endFollowUps(pool, [d.id], 'cancelled');
  assert.equal((await acks.byToken(pool, { token, action: 'ack', now: at('2026-11-03T14:05:00Z') })).result, 'gone');
});

test('a token that arrives before the first push is settled already works', { skip: db.skip }, async () => {
  const { d, token } = await setup({ sender: failing }); // first push waiting to retry: no deadlines yet
  assert.equal(d.follow_up_horizon, null);
  const out = await acks.byToken(pool, { token, action: 'snooze', minutes: 10, from: 0, now: at('2026-11-03T14:00:40Z') });
  assert.equal(out.result, 'snoozed');
  const { rows: [after] } = await pool.query('SELECT * FROM deliveries WHERE id = $1', [d.id]);
  assert.equal(after.status, 'sent', 'a tap from the first push proves it arrived');
  assert.equal(after.follow_up_until.toISOString(), '2026-11-03T15:00:40.000Z', 'the snooze set the deadlines itself');
  const calls = [];
  const sendImpl = async (secret, payload) => { calls.push(payload); return { status: 200 }; };
  await dispatcher.runPass(pool, { source: 'test', now: () => at('2026-11-03T14:10:50Z'), sendImpl, config: CONFIG });
  assert.deepEqual(calls.map((p) => p.message), ['Snoozed · was due 9:00 AM'], 'the snooze alert, and no retry of the first push');
});

test('a late Got it on an expired delivery is recorded and arms nothing; Snooze cannot reopen it', { skip: db.skip }, async () => {
  const { d, token } = await setup();
  await dispatcher.runPass(pool, { source: 'test', now: () => at('2026-11-03T15:30:00Z'), sendImpl: ok.sendImpl, config: CONFIG });
  const { rows: [expired] } = await pool.query('SELECT follow_up_ended FROM deliveries WHERE id = $1', [d.id]);
  assert.equal(expired.follow_up_ended, 'expired');
  assert.equal((await acks.byToken(pool, { token, action: 'snooze', minutes: 10, from: 0, now: at('2026-11-03T15:31:00Z') })).result, 'stale');
  assert.equal((await acks.byToken(pool, { token, action: 'ack', now: at('2026-11-03T15:32:00Z') })).result, 'recorded');
  const { rows: [after] } = await pool.query('SELECT follow_up_ended, follow_up_at FROM deliveries WHERE id = $1', [d.id]);
  assert.deepEqual(after, { follow_up_ended: 'acked', follow_up_at: null });
  // A final reason is never replaced.
  await acks.endFollowUps(pool, [d.id], 'superseded');
  const { rows: [final] } = await pool.query('SELECT follow_up_ended FROM deliveries WHERE id = $1', [d.id]);
  assert.equal(final.follow_up_ended, 'acked');
});

test('an expired delivery that is then superseded records it, and its token answers gone', { skip: db.skip }, async () => {
  const { d, token } = await setup();
  await dispatcher.runPass(pool, { source: 'test', now: () => at('2026-11-03T15:30:00Z'), sendImpl: ok.sendImpl, config: CONFIG });
  await acks.endFollowUps(pool, [d.id], 'superseded');
  const { rows: [after] } = await pool.query('SELECT follow_up_ended FROM deliveries WHERE id = $1', [d.id]);
  assert.equal(after.follow_up_ended, 'superseded');
  assert.equal((await acks.byToken(pool, { token, action: 'ack', now: at('2026-11-03T15:31:00Z') })).result, 'gone');
});

test('a token tap that marks the first push sent clears the channel error, unless a newer push failed since', { skip: db.skip }, async () => {
  const { sam, token } = await setup({ sender: failing });
  await acks.byToken(pool, { token, action: 'ack', from: 0, now: at('2026-11-03T14:00:40Z') });
  let { rows: [c] } = await pool.query('SELECT last_error FROM member_notification_channels WHERE member_id = $1', [sam.id]);
  assert.equal(c.last_error, null);

  const second = await setup({ sender: failing });
  await pool.query("UPDATE member_notification_channels SET last_error = 'a newer push failed', last_error_at = now() + interval '1 minute' WHERE member_id = $1", [second.sam.id]);
  await acks.byToken(pool, { token: second.token, action: 'ack', from: 0, now: at('2026-11-03T14:00:40Z') });
  ({ rows: [c] } = await pool.query('SELECT last_error FROM member_notification_channels WHERE member_id = $1', [second.sam.id]));
  assert.equal(c.last_error, 'a newer push failed');
});

test('a token snooze without the alert number is refused and changes nothing', { skip: db.skip }, async () => {
  const { d, token } = await setup({ sender: failing });
  await assert.rejects(acks.byToken(pool, { token, action: 'snooze', minutes: 10, now: at('2026-11-03T14:00:40Z') }), /which alert/);
  const { rows: [after] } = await pool.query('SELECT status, follow_up_at FROM deliveries WHERE id = $1', [d.id]);
  assert.deepEqual(after, { status: 'pending', follow_up_at: null }, 'the first push is not cancelled');
});

test('a newer failure on another push survives a token tap, even after the tapped push was claimed again', { skip: db.skip }, async () => {
  const { sam, d, token } = await setup({ sender: failing }); // push A fails at 14:00:10
  // Push B, another reminder, fails later.
  await reminders.create(pool, { text: 'Other', date: '2026-11-03', time: '09:15', recipients: [sam.id] }, { timezone: TZ, now: at('2026-11-03T12:00:00Z') });
  await dispatcher.runPass(pool, { source: 'test', now: () => at('2026-11-03T14:15:10Z'), sendImpl: failing.sendImpl, config: CONFIG });
  // A is claimed for a retry (its updated_at moves on), then the phone's tap from A's first push arrives.
  await pool.query("UPDATE deliveries SET status = 'sending', claim_token = gen_random_uuid(), claimed_at = now(), updated_at = now() WHERE id = $1", [d.id]);
  await acks.byToken(pool, { token, action: 'ack', from: 0, now: at('2026-11-03T14:16:00Z') });
  const { rows: [c] } = await pool.query('SELECT last_error FROM member_notification_channels WHERE member_id = $1', [sam.id]);
  assert.match(c.last_error, /503/, 'B’s failure is still shown');
  const { rows: [a] } = await pool.query('SELECT status FROM deliveries WHERE id = $1', [d.id]);
  assert.equal(a.status, 'sent');
});

test('snooze validates minutes and from', { skip: db.skip }, async () => {
  const { d } = await setup({ ack: false });
  await assert.rejects(acks.snooze(pool, { deliveryId: d.id, minutes: 7, from: 0 }), /10, 30 or 60/);
  await assert.rejects(acks.snooze(pool, { deliveryId: d.id, minutes: 10, from: -1 }), /which alert/);
  await assert.rejects(acks.snooze(pool, { deliveryId: d.id, minutes: 10 }), /which alert/);
  await assert.rejects(acks.snooze(pool, { deliveryId: d.id, minutes: 10, from: '' }), /which alert/);
  await assert.rejects(acks.ack(pool, { deliveryId: d.id, who: null, via: 'telepathy' }), /source/);
});

test('a push service error that echoes the payload stores no token', async () => {
  const token = acks.makeToken('a'.repeat(64), '0b7e6f1c-3a52-4d2b-9a77-5f1d2c3b4a59');
  const payload = { title: 'Take medicine', message: '9:00 AM', open_url: `https://remind.example/ack#t=${token}&a=0` };
  const fetchImpl = async (_url, init) => ({ ok: false, status: 400, text: async () => `bad request: ${init.body}` });
  await assert.rejects(
    brrr.send('br_usr_sam_key_0001', payload, { fetchImpl }),
    (err) => {
      assert.ok(!err.message.includes(token), err.message);
      assert.ok(!err.message.includes(token.split('.')[1]), 'not even the signature half');
      assert.match(err.message, /\[token\]/);
      return true;
    },
  );
});

test('follow-up alert wording', () => {
  const base = { title: 'Take medicine', message: '9:00 AM', thread_id: 'remind-me-4', interruption_level: 'critical', icon_url: 'https://x.example/i.png', expiration_date: 'old' };
  const nag = brrr.buildFollowUpPayload(base, { kind: 'nag', alertNo: 3, wallTime: '09:00', wallDate: '2026-11-03', today: '2026-11-03', expiresAt: at('2026-11-03T15:00:00Z') });
  assert.deepEqual(nag, {
    title: 'Take medicine', message: 'Still waiting · was due 9:00 AM · alert 3', thread_id: 'remind-me-4',
    interruption_level: 'critical', expiration_date: '2026-11-03T15:00:00.000Z', icon_url: 'https://x.example/i.png',
  });
  const snooze = brrr.buildFollowUpPayload(base, { kind: 'snooze', alertNo: 1, wallTime: '21:30', wallDate: '2026-11-02', today: '2026-11-03' });
  assert.equal(snooze.message, 'Snoozed · was due yesterday 9:30 PM');
});
