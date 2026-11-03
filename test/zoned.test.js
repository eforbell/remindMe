'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zoned = require('../lib/zoned');

const NY = 'America/New_York';

test('plain wall time round-trips', () => {
  const at = zoned.toInstant('2026-11-03', '17:00', NY);
  assert.equal(at.toISOString(), '2026-11-03T22:00:00.000Z');
  assert.deepEqual(zoned.toWall(at, NY), { date: '2026-11-03', time: '17:00', seconds: 0 });
});

test('summer and winter offsets differ for the same wall time', () => {
  assert.equal(zoned.toInstant('2026-07-01', '09:00', NY).toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(zoned.toInstant('2026-12-01', '09:00', NY).toISOString(), '2026-12-01T14:00:00.000Z');
});

test('spring-forward gap moves forward by the gap', () => {
  // 2027-03-14 02:30 does not exist in New York; it becomes 03:30 EDT.
  const at = zoned.toInstant('2027-03-14', '02:30', NY);
  assert.equal(at.toISOString(), '2027-03-14T07:30:00.000Z');
  assert.equal(zoned.toWall(at, NY).time, '03:30');
});

test('fall-back overlap picks the first 1:30', () => {
  // 2026-11-01 01:30 happens twice in New York; the first is EDT (05:30Z).
  assert.equal(zoned.toInstant('2026-11-01', '01:30', NY).toISOString(), '2026-11-01T05:30:00.000Z');
});

test('works east of UTC too (Sydney DST ends in April)', () => {
  const syd = 'Australia/Sydney';
  // 2027-04-04 02:30 happens twice; first is AEDT (+11) → 2027-04-03T15:30Z.
  assert.equal(zoned.toInstant('2027-04-04', '02:30', syd).toISOString(), '2027-04-03T15:30:00.000Z');
  assert.equal(zoned.toInstant('2027-01-10', '08:00', syd).toISOString(), '2027-01-09T21:00:00.000Z');
});

test('time zone validation', () => {
  assert.equal(zoned.isValidTimeZone(NY), true);
  assert.equal(zoned.isValidTimeZone('Mars/Olympus'), false);
  assert.equal(zoned.isValidTimeZone(''), false);
});
