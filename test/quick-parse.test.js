'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../public/shared/quick-parse');

// Monday 2026-11-02, 10:07 in the morning.
const ctx = {
  today: '2026-11-02',
  nowTime: '10:07',
  meId: 1,
  members: [{ id: 1, name: 'Sam' }, { id: 2, name: 'Riley' }, { id: 3, name: 'Jo Park' }],
};
const p = (text, extra = {}) => parse(text, { ...ctx, ...extra });

test('the motivating example', () => {
  const r = p('remind me to take my medicine tomorrow at 5pm');
  assert.deepEqual(r.recipients, [1]);
  assert.equal(r.date, '2026-11-03');
  assert.equal(r.time, '17:00');
  assert.equal(r.text, 'Take my medicine');
  assert.equal(r.repeat, null);
});

test('several people, "alert X:" form, everyone', () => {
  assert.deepEqual(p('remind Sam and Riley to feed the cat').recipients, [1, 2]);
  assert.deepEqual(p('remind riley, jo & me to pack lunches').recipients, [2, 3, 1]);
  const a = p('alert everyone: trash goes out every tuesday at 7:30pm');
  assert.deepEqual(a.recipients, [1, 2, 3]);
  assert.deepEqual(a.repeat, { freq: 'weekly', every: 1, weekdays: [2] });
  assert.equal(a.time, '19:30');
  assert.equal(a.text, 'Trash goes out');
});

test('unknown names leave the sentence alone', () => {
  const r = p('remind Grandma to call back at 3pm');
  assert.equal(r.recipients, null);
  assert.equal(r.text, 'Remind Grandma to call back');
  assert.equal(r.time, '15:00');
});

test('numbers are not times without am/pm, a colon, or "at"', () => {
  const r = p('take 2 pills with food');
  assert.equal(r.time, null);
  assert.equal(r.date, null);
  assert.equal(r.text, 'Take 2 pills with food');
  assert.equal(p('take 5 a day').time, null);
  assert.equal(p('cut 1/2 tablet').date, null);
  assert.equal(p('put on sun screen').date, null);
});

test('bare hours: 1-7 are PM, 8-11 AM, "tonight" forces PM', () => {
  assert.equal(p('call mom at 5').time, '17:00');
  assert.equal(p('call mom at 9').time, '09:00');
  assert.equal(p('call mom tonight at 9').time, '21:00');
  assert.equal(p('call mom at noon').time, '12:00');
  assert.equal(p('call mom at 5:30').time, '17:30');
  assert.equal(p('call mom at 17:45').time, '17:45');
});

test('minutes round up to the quarter hour, with a note', () => {
  const r = p('stand up at 9:10am');
  assert.equal(r.time, '09:15');
  assert.deepEqual(r.notes, ['rounded up to the quarter hour']);
  assert.equal(p('stand up at 11:50pm').time, '00:00');
  assert.equal(p('stand up tomorrow at 11:50pm').date, '2026-11-04');
});

test('a time alone means today if still ahead, else tomorrow', () => {
  assert.equal(p('lunch at 12:30pm').date, '2026-11-02');
  assert.equal(p('alarm at 8am').date, '2026-11-03');
});

test('relative times', () => {
  const r = p('check the oven in 20 minutes');
  assert.equal(r.date, '2026-11-02');
  assert.equal(r.time, '10:30'); // 10:27 → 10:30
  assert.equal(r.text, 'Check the oven');
  assert.equal(p('move the car in 2 hours').time, '12:15');
  assert.equal(p('in an hour take the bread out').time, '11:15');
  assert.equal(p('renew passport in 3 weeks').date, '2026-11-23');
  assert.deepEqual([p('late night in 14 hours').date, p('late night in 14 hours').time], ['2026-11-03', '00:15']);
});

test('weekdays: full names, or short ones after on/next/this', () => {
  assert.equal(p('dentist friday at 3pm').date, '2026-11-06');
  assert.equal(p('dentist on fri at 3pm').date, '2026-11-06');
  assert.equal(p('dentist next fri').date, '2026-11-06');
  assert.equal(p('dentist monday').date, '2026-11-09', 'same weekday as today means next week');
  assert.equal(p('dentist this monday at 4pm').date, '2026-11-02');
  assert.equal(p('soccer saturday morning').time, '08:00');
});

test('month dates roll into next year once passed', () => {
  assert.equal(p('renew registration on Nov 20').date, '2026-11-20');
  assert.equal(p('birthday card march 3rd').date, '2027-03-03');
  assert.equal(p('taxes on 4/15').date, '2027-04-15');
  assert.equal(p('party the 5th of december').date, '2026-12-05');
});

test('repeat phrases', () => {
  assert.deepEqual(p('vitamins every day at 8am').repeat, { freq: 'daily', every: 1 });
  assert.deepEqual(p('vitamins daily').repeat, { freq: 'daily', every: 1 });
  const m = p('stretch every morning');
  assert.deepEqual([m.repeat.freq, m.time], ['daily', '08:00']);
  assert.deepEqual(p('standup every weekday at 9:30am').repeat, { freq: 'weekly', every: 1, weekdays: [1, 2, 3, 4, 5] });
  assert.deepEqual(p('piano every mon and wed at 4pm').repeat, { freq: 'weekly', every: 1, weekdays: [1, 3] });
  assert.deepEqual(p('change filter every 3 months').repeat, { freq: 'monthly', every: 3 });
  assert.deepEqual(p('mow every other week').repeat, { freq: 'weekly', every: 2 });
  assert.deepEqual(p('pay rent monthly').repeat, { freq: 'monthly', every: 1 });
  assert.equal(p('vitamins every day at 8am').date, null, 'a repeating time leaves the start date to the form');
});

test('plain text passes through, trimmed and capitalized', () => {
  const r = p('  water   the plants ');
  assert.equal(r.text, 'Water the plants');
  assert.deepEqual(r.found, []);
});
