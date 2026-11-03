'use strict';

// Server-side schedule helpers: the shared wall-clock rules (public/shared/schedule-core.js) plus the
// household time zone (lib/zoned.js).

const core = require('../public/shared/schedule-core');
const zoned = require('./zoned');

// The rule stored on a reminders row.
function ruleOf(row) {
  return {
    freq: row.freq,
    every: row.repeat_every,
    weekdays: row.weekdays ? row.weekdays.map(Number) : null,
    count: row.max_occurrences == null ? null : Number(row.max_occurrences),
  };
}

function hhmm(timeOfDay) { return String(timeOfDay).slice(0, 5); }

function instantOf(date, time, timezone) { return zoned.toInstant(date, hhmm(time), timezone); }

// The occurrence after `date` in a series, as { date, at }, or null when the rule has no more.
function nextAfter(row, date) {
  const next = core.nextOccurrenceDate(ruleOf(row), row.start_date, date);
  return next ? { date: next, at: instantOf(next, row.time_of_day, row.timezone) } : null;
}

// Dates of the next `n` occurrences starting at the cursor (the cursor's own date first).
function upcomingDates(row, n) {
  if (!row.next_fire_date) return [];
  const out = [row.next_fire_date];
  let date = row.next_fire_date;
  while (out.length < n) {
    const next = core.nextOccurrenceDate(ruleOf(row), row.start_date, date);
    if (!next) break;
    out.push(next);
    date = next;
  }
  return out;
}

// How many reminders are still to come (cursor included), or null for a forever series.
function remainingOf(row) {
  if (row.status !== 'active') return 0;
  if (row.max_occurrences == null) return null;
  return Math.max(0, Number(row.max_occurrences) - Number(row.fired_count));
}

// The last occurrence of a bounded series as { date, at }, or null (forever, or too far out to walk).
function lastOf(row) {
  const remaining = remainingOf(row);
  if (remaining == null || remaining === 0 || remaining > 2000) return null;
  const dates = upcomingDates(row, remaining);
  const date = dates[dates.length - 1];
  return date ? { date, at: instantOf(date, row.time_of_day, row.timezone) } : null;
}

module.exports = { core, zoned, ruleOf, hhmm, instantOf, nextAfter, upcomingDates, remainingOf, lastOf };
