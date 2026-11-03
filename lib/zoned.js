'use strict';

// Wall clock <-> instant in an IANA time zone, using only Intl (no dependencies).
//
// DST rules, matching what people expect from a calendar:
//   - A wall time that happens twice (fall back, e.g. 1:30 AM) means the FIRST one.
//   - A wall time that never happens (spring forward, e.g. 2:30 AM) moves forward by the gap (3:30 AM).

const core = require('../public/shared/schedule-core');

const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function isValidTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string') return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

// The wall-clock fields of an instant in a zone.
function partsAt(ms, timeZone) {
  const out = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (type !== 'literal') out[type] = Number(value);
  }
  return out;
}

// Zone offset in ms at an instant (wall clock minus UTC).
function offsetAt(ms, timeZone) {
  const p = partsAt(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// { date: 'YYYY-MM-DD', time: 'HH:MM', seconds } for an instant in a zone.
function toWall(instant, timeZone) {
  const ms = instant instanceof Date ? instant.getTime() : Number(instant);
  const p = partsAt(ms, timeZone);
  return {
    date: core.formatDate(p.year, p.month, p.day),
    time: `${core.pad2(p.hour)}:${core.pad2(p.minute)}`,
    seconds: p.second,
  };
}

// The instant (Date) of a wall-clock date and HH:MM in a zone.
function toInstant(date, time, timeZone) {
  const d = core.parseDate(date);
  const [h, min] = String(time).split(':').map(Number);
  if (!d || !Number.isInteger(h) || !Number.isInteger(min)) throw new Error(`Invalid wall time ${date} ${time}`);
  const wall = Date.UTC(d.y, d.m - 1, d.d, h, min);
  // Offsets a day either side cover every real-world transition (none are closer than that).
  const offsets = [...new Set([offsetAt(wall - 86400000, timeZone), offsetAt(wall, timeZone), offsetAt(wall + 86400000, timeZone)])];
  const candidates = offsets.map((offset) => wall - offset);
  const matches = candidates.filter((ms) => {
    const back = toWall(ms, timeZone);
    return back.date === date && back.time === `${core.pad2(h)}:${core.pad2(min)}`;
  });
  if (matches.length) return new Date(Math.min(...matches));
  // In a spring-forward gap: the pre-transition offset gives the later instant, i.e. shifted forward.
  return new Date(Math.max(...candidates));
}

module.exports = { isValidTimeZone, toWall, toInstant, offsetAt };
