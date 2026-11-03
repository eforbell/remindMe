'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/shared/schedule-core');

const rule = (input, start) => {
  const out = core.normalizeRepeat(input, start);
  assert.equal(out.error, undefined, out.error);
  return out.rule;
};

test('quarter-hour times only', () => {
  for (const t of ['00:00', '09:15', '12:30', '23:45']) assert.equal(core.isQuarterTime(t), true, t);
  for (const t of ['09:10', '24:00', '9:15', '12:60', '12:00:00', '']) assert.equal(core.isQuarterTime(t), false, t);
});

test('dates are validated, including leap days', () => {
  assert.equal(core.isValidDate('2028-02-29'), true);
  assert.equal(core.isValidDate('2027-02-29'), false);
  assert.equal(core.isValidDate('2026-13-01'), false);
  assert.equal(core.weekdayOf('2026-11-02'), 1); // a Monday
  assert.equal(core.addDays('2026-12-31', 1), '2027-01-01');
});

test('nextQuarterAfter rolls over midnight', () => {
  assert.deepEqual(core.nextQuarterAfter('2026-11-02', '09:00'), { date: '2026-11-02', time: '09:15' });
  assert.deepEqual(core.nextQuarterAfter('2026-11-02', '09:07'), { date: '2026-11-02', time: '09:15' });
  assert.deepEqual(core.nextQuarterAfter('2026-11-02', '23:50'), { date: '2026-11-03', time: '00:00' });
});

test('once: one date, then nothing', () => {
  const r = rule({ freq: 'once' }, '2026-11-05');
  assert.deepEqual(r, { freq: 'once', every: 1, weekdays: null, count: 1 });
  assert.equal(core.nextOccurrenceDate(r, '2026-11-05', null), '2026-11-05');
  assert.equal(core.nextOccurrenceDate(r, '2026-11-05', '2026-11-05'), null);
});

test('daily every N', () => {
  const r = rule({ freq: 'daily', every: 3, count: 4 }, '2026-11-01');
  assert.deepEqual(core.occurrenceDates(r, '2026-11-01', 10), ['2026-11-01', '2026-11-04', '2026-11-07', '2026-11-10']);
  assert.equal(core.lastOccurrenceDate(r, '2026-11-01'), '2026-11-10');
  assert.equal(core.nextOccurrenceDate(r, '2026-11-01', '2026-11-05'), '2026-11-07');
});

test('weekly on chosen days starts on the first matching day on or after the start', () => {
  // Start Tuesday 2026-11-03, Mon/Wed/Fri: first is Wed the 4th.
  const r = rule({ freq: 'weekly', weekdays: [5, 1, 3, 3], count: 5 }, '2026-11-03');
  assert.deepEqual(r.weekdays, [1, 3, 5]);
  assert.deepEqual(core.occurrenceDates(r, '2026-11-03', 10), ['2026-11-04', '2026-11-06', '2026-11-09', '2026-11-11', '2026-11-13']);
});

test('weekly defaults to the start date’s weekday; every 2 weeks skips a week', () => {
  const r = rule({ freq: 'weekly', every: 2, count: 3 }, '2026-11-02');
  assert.deepEqual(r.weekdays, [1]);
  assert.deepEqual(core.occurrenceDates(r, '2026-11-02', 10), ['2026-11-02', '2026-11-16', '2026-11-30']);
});

test('every-2-weeks counts weeks from the start week even mid-week', () => {
  // Start Thursday 2026-11-05 with Mon+Thu: week 0 = Nov 1-7 → Thu 5; week 2 = Nov 15-21 → Mon 16, Thu 19.
  const r = rule({ freq: 'weekly', every: 2, weekdays: [1, 4], count: 4 }, '2026-11-05');
  assert.deepEqual(core.occurrenceDates(r, '2026-11-05', 10), ['2026-11-05', '2026-11-16', '2026-11-19', '2026-11-30']);
});

test('monthly on the 31st falls on the last day of shorter months', () => {
  const r = rule({ freq: 'monthly', count: 5 }, '2027-01-31');
  assert.deepEqual(core.occurrenceDates(r, '2027-01-31', 10), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
});

test('yearly on Feb 29 falls on Feb 28 in common years', () => {
  const r = rule({ freq: 'yearly', count: 5 }, '2028-02-29');
  assert.deepEqual(core.occurrenceDates(r, '2028-02-29', 10), ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
});

test('forever series have no last date but keep producing', () => {
  const r = rule({ freq: 'daily', count: null }, '2026-11-01');
  assert.equal(r.count, null);
  assert.equal(core.lastOccurrenceDate(r, '2026-11-01'), null);
  assert.equal(core.occurrenceDates(r, '2026-11-01', 400).length, 400);
  assert.equal(core.nextOccurrenceDate(r, '2026-11-01', '2036-11-01'), '2036-11-02');
});

test('repeat validation errors', () => {
  assert.ok(core.normalizeRepeat({ freq: 'hourly' }).error);
  assert.ok(core.normalizeRepeat({ freq: 'daily', every: 0 }).error);
  assert.ok(core.normalizeRepeat({ freq: 'daily', every: 1.5 }).error);
  assert.ok(core.normalizeRepeat({ freq: 'daily', count: 0 }).error);
  assert.equal(core.normalizeRepeat({ freq: 'daily', count: 1 }).rule.count, 1, 'one left in an edited series');
  assert.ok(core.normalizeRepeat({ freq: 'daily', count: 1001 }).error);
  assert.ok(core.normalizeRepeat({ freq: 'weekly', weekdays: [7] }, '2026-11-02').error);
});

test('describeRepeat reads naturally', () => {
  assert.equal(core.describeRepeat(rule({ freq: 'daily', count: 30 }, '2026-11-01'), '2026-11-01'), 'Every day, 30 times');
  assert.equal(core.describeRepeat(rule({ freq: 'weekly', weekdays: [1, 2, 3, 4, 5], count: null }, '2026-11-02'), '2026-11-02'), 'Weekly on weekdays, until deleted');
  assert.equal(core.describeRepeat(rule({ freq: 'monthly', every: 2, count: 6 }, '2026-11-30'), '2026-11-30'), 'Every 2 months on the 30th (or the month’s last day), 6 times');
  assert.equal(core.describeRepeat({ freq: 'once' }), 'Once');
});

test('12-hour formatting and friendly dates', () => {
  assert.equal(core.formatTime12('00:00'), '12:00 AM');
  assert.equal(core.formatTime12('12:00'), '12:00 PM');
  assert.equal(core.formatTime12('17:45'), '5:45 PM');
  assert.equal(core.formatTime12('09:15'), '9:15 AM');
  assert.equal(core.formatDateFriendly('2026-11-03', '2026-11-02'), 'Tomorrow');
  assert.equal(core.formatDateFriendly('2026-11-05', '2026-11-02'), 'Thu, Nov 5');
  assert.equal(core.formatDateFriendly('2027-01-05', '2026-11-02'), 'Tue, Jan 5, 2027');
});
