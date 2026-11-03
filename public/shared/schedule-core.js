/* Remind Me: schedule core, shared by the browser and the server.
 *
 * Everything here works on household wall-clock values: dates are 'YYYY-MM-DD' and times are 'HH:MM'
 * (24-hour, quarter hours only). No time zones and no Date objects that depend on the device's zone;
 * the server turns a wall-clock date and time into an instant (lib/zoned.js).
 *
 * A repeat rule is { freq, every, weekdays, count }:
 *   freq      once | daily | weekly | monthly | yearly
 *   every     1..99, "every N days/weeks/months/years" (1 for once)
 *   weekdays  weekly only: 0 (Sun) .. 6 (Sat); the weeks counted for `every` start on Sunday
 *   count     how many reminders in the series (1 for once), or null to repeat until deleted. When
 *             editing a series that has started, it counts the reminders still to come.
 * A series starts on its start date: the first reminder is the first matching date on or after it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RemindCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FREQS = ['once', 'daily', 'weekly', 'monthly', 'yearly'];
  const MAX_EVERY = 99;
  const MAX_COUNT = 1000;
  const DEFAULT_COUNTS = { daily: 30, weekly: 12, monthly: 12, yearly: 5 };
  const QUARTERS = [0, 15, 30, 45];
  const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // brrr.now interruption levels (https://brrr.now/docs/), with the names the app shows.
  const LEVELS = [
    { value: 'passive', label: 'Quiet', hint: 'Lands in Notification Center without a sound or lighting the screen.' },
    { value: 'active', label: 'Standard', hint: 'Lights the screen and can play a sound.' },
    { value: 'time-sensitive', label: 'Urgent', hint: 'Breaks through Focus and notification summaries.' },
    { value: 'critical', label: 'Critical', hint: 'Sounds even on silent. Turn on Critical Alerts for brrr on the phone first.' },
  ];
  const LEVEL_VALUES = LEVELS.map((l) => l.value);
  const DEFAULT_LEVEL = 'time-sensitive';

  // ── Dates ────────────────────────────────────────────────────────────────

  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const TIME_RE = /^(\d{2}):(\d{2})$/;

  function pad2(n) { return String(n).padStart(2, '0'); }

  function parseDate(value) {
    const m = DATE_RE.exec(String(value || ''));
    if (!m) return null;
    const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
    return { y, m: mo, d };
  }

  function isValidDate(value) { return parseDate(value) !== null; }

  function formatDate(y, m, d) { return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`; }

  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

  function daysInMonth(y, m) {
    return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  }

  // Days since 1970-01-01 for a wall-clock date (UTC arithmetic, so no zone or DST can shift it).
  function dayNumber(value) {
    const p = typeof value === 'string' ? parseDate(value) : value;
    return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86400000);
  }

  function fromDayNumber(n) {
    const dt = new Date(n * 86400000);
    return formatDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  function addDays(value, days) { return fromDayNumber(dayNumber(value) + days); }

  function weekdayOf(value) { return ((dayNumber(value) % 7) + 7 + 4) % 7; } // 1970-01-01 was a Thursday

  function compareDates(a, b) { return a < b ? -1 : a > b ? 1 : 0; } // ISO dates sort as strings

  // ── Times (quarter hours only) ───────────────────────────────────────────

  function parseTime(value) {
    const m = TIME_RE.exec(String(value || ''));
    if (!m) return null;
    const h = Number(m[1]); const min = Number(m[2]);
    if (h > 23 || !QUARTERS.includes(min)) return null;
    return { h, min };
  }

  function isQuarterTime(value) { return parseTime(value) !== null; }

  function formatTime(h, min) { return `${pad2(h)}:${pad2(min)}`; }

  // The first quarter hour strictly after (date, HH:MM[:ss]), as { date, time }.
  function nextQuarterAfter(date, hhmm) {
    const [h, min] = String(hhmm).split(':').map(Number);
    let total = h * 60 + min;
    total = (Math.floor(total / 15) + 1) * 15;
    if (total >= 24 * 60) return { date: addDays(date, 1), time: '00:00' };
    return { date, time: formatTime(Math.floor(total / 60), total % 60) };
  }

  // Wall-clock comparison of two { date, time } pairs.
  function compareWall(a, b) {
    return compareDates(a.date, b.date) || (a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
  }

  // ── Repeat rules ─────────────────────────────────────────────────────────

  // Validates and normalizes a repeat rule. Returns { rule } or { error }.
  function normalizeRepeat(input, startDate) {
    const raw = input && typeof input === 'object' ? input : {};
    const freq = raw.freq == null ? 'once' : String(raw.freq);
    if (!FREQS.includes(freq)) return { error: 'Repeat must be once, daily, weekly, monthly, or yearly.' };
    if (freq === 'once') return { rule: { freq: 'once', every: 1, weekdays: null, count: 1 } };

    const every = raw.every == null ? 1 : Number(raw.every);
    if (!Number.isInteger(every) || every < 1 || every > MAX_EVERY) return { error: `"Every" must be a whole number from 1 to ${MAX_EVERY}.` };

    let weekdays = null;
    if (freq === 'weekly') {
      const list = Array.isArray(raw.weekdays) && raw.weekdays.length ? raw.weekdays : [startDate && isValidDate(startDate) ? weekdayOf(startDate) : null];
      const set = new Set();
      for (const w of list) {
        const n = Number(w);
        if (!Number.isInteger(n) || n < 0 || n > 6) return { error: 'Weekdays must be 0 (Sunday) to 6 (Saturday).' };
        set.add(n);
      }
      weekdays = [...set].sort((a, b) => a - b);
    }

    let count = null;
    if (raw.count !== null && raw.count !== undefined && raw.count !== 'forever') {
      count = Number(raw.count);
      if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) return { error: `A repeating series runs 1 to ${MAX_COUNT} times, or until deleted.` };
    }
    return { rule: { freq, every, weekdays, count } };
  }

  // The first occurrence date strictly after `after` (or on/after the start date when `after` is null),
  // or null when the rule has none (a once rule after its date). Never looks more than ~200 years ahead.
  function nextOccurrenceDate(rule, startDate, after) {
    const start = parseDate(startDate);
    if (!start) return null;
    const min = after == null ? startDate : addDays(after, 1); // the earliest date allowed
    if (compareDates(min, startDate) < 0) return nextOccurrenceDate(rule, startDate, null);

    switch (rule.freq) {
      case 'once':
        return after == null ? startDate : null;
      case 'daily': {
        const offset = dayNumber(min) - dayNumber(startDate);
        const k = Math.ceil(offset / rule.every);
        return addDays(startDate, k * rule.every);
      }
      case 'weekly': {
        // Weeks run Sunday..Saturday; the week holding the start date is week 0.
        const week0 = dayNumber(startDate) - weekdayOf(startDate);
        const days = new Set(rule.weekdays);
        let n = dayNumber(min);
        for (let i = 0; i < 7 * rule.every + 7; i += 1, n += 1) {
          const week = Math.floor((n - week0) / 7);
          if (week % rule.every === 0 && days.has(((n % 7) + 7 + 4) % 7)) return fromDayNumber(n);
        }
        return null;
      }
      case 'monthly':
      case 'yearly': {
        const stepMonths = rule.freq === 'monthly' ? rule.every : rule.every * 12;
        const minP = parseDate(min);
        const monthsFromStart = (minP.y - start.y) * 12 + (minP.m - start.m);
        let k = Math.max(0, Math.floor(monthsFromStart / stepMonths));
        for (let guard = 0; guard < 2400; guard += 1, k += 1) {
          const total = start.m - 1 + k * stepMonths;
          const y = start.y + Math.floor(total / 12);
          const m = (total % 12) + 1;
          // The 31st falls on the last day of shorter months; Feb 29 on Feb 28 in common years.
          const candidate = formatDate(y, m, Math.min(start.d, daysInMonth(y, m)));
          if (compareDates(candidate, min) >= 0) return candidate;
        }
        return null;
      }
      default:
        return null;
    }
  }

  // The first `n` occurrence dates of a series (fewer when the series is shorter).
  function occurrenceDates(rule, startDate, n) {
    const out = [];
    let date = nextOccurrenceDate(rule, startDate, null);
    const limit = rule.count == null ? n : Math.min(n, rule.count);
    while (date && out.length < limit) {
      out.push(date);
      date = nextOccurrenceDate(rule, startDate, date);
    }
    return out;
  }

  // The date of the last occurrence of a bounded series, or null for a forever series.
  function lastOccurrenceDate(rule, startDate) {
    if (rule.count == null) return null;
    const dates = occurrenceDates(rule, startDate, rule.count);
    return dates[dates.length - 1] || null;
  }

  // ── Words ────────────────────────────────────────────────────────────────

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  function describeRepeat(rule, startDate) {
    if (!rule || rule.freq === 'once') return 'Once';
    const p = parseDate(startDate);
    let text;
    if (rule.freq === 'daily') text = rule.every === 1 ? 'Every day' : `Every ${rule.every} days`;
    else if (rule.freq === 'weekly') {
      const days = rule.weekdays || [];
      let dayText;
      if (days.length === 7) dayText = 'every day';
      else if (days.join() === '1,2,3,4,5') dayText = 'weekdays';
      else if (days.join() === '0,6') dayText = 'weekends';
      else dayText = days.map((d) => WEEKDAY_SHORT[d]).join(', ');
      text = rule.every === 1 ? `Weekly on ${dayText}` : `Every ${rule.every} weeks on ${dayText}`;
    } else if (rule.freq === 'monthly') {
      const day = p ? ordinal(p.d) : '';
      text = rule.every === 1 ? `Monthly on the ${day}` : `Every ${rule.every} months on the ${day}`;
      if (p && p.d > 28) text += ' (or the month’s last day)';
    } else {
      const day = p ? `${MONTH_SHORT[p.m - 1]} ${p.d}` : '';
      text = rule.every === 1 ? `Yearly on ${day}` : `Every ${rule.every} years on ${day}`;
    }
    return rule.count == null ? `${text}, until deleted` : `${text}, ${plural(rule.count, 'time')}`;
  }

  function formatTime12(hhmm) {
    const t = parseTime(hhmm) || (() => { const [h, m] = String(hhmm).split(':').map(Number); return { h, min: m }; })();
    if (t.h === 0 && t.min === 0) return '12:00 AM';
    if (t.h === 12 && t.min === 0) return '12:00 PM';
    const h12 = ((t.h + 11) % 12) + 1;
    return `${h12}:${pad2(t.min)} ${t.h < 12 ? 'AM' : 'PM'}`;
  }

  // "Today", "Tomorrow", "Thu, Nov 5", or "Thu, Nov 5, 2027" outside the current year.
  function formatDateFriendly(date, today) {
    const p = parseDate(date);
    if (!p) return '';
    if (today) {
      const diff = dayNumber(date) - dayNumber(today);
      if (diff === 0) return 'Today';
      if (diff === 1) return 'Tomorrow';
      if (diff === -1) return 'Yesterday';
    }
    const base = `${WEEKDAY_SHORT[weekdayOf(date)]}, ${MONTH_SHORT[p.m - 1]} ${p.d}`;
    const sameYear = today && parseDate(today) && parseDate(today).y === p.y;
    return sameYear ? base : `${base}, ${p.y}`;
  }

  return {
    FREQS, MAX_EVERY, MAX_COUNT, DEFAULT_COUNTS, QUARTERS, LEVELS, LEVEL_VALUES, DEFAULT_LEVEL,
    WEEKDAY_SHORT, WEEKDAY_LONG, MONTH_SHORT, MONTH_LONG,
    pad2, parseDate, isValidDate, formatDate, daysInMonth, dayNumber, fromDayNumber, addDays, weekdayOf,
    compareDates, parseTime, isQuarterTime, formatTime, nextQuarterAfter, compareWall,
    normalizeRepeat, nextOccurrenceDate, occurrenceDates, lastOccurrenceDate,
    describeRepeat, formatTime12, formatDateFriendly, ordinal, plural,
  };
}));
