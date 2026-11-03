/* Remind Me: quick entry. Reads a typed sentence such as
 *   "remind Sam and Riley to take medicine tomorrow at 5pm"
 *   "alert everyone: trash goes out every tuesday at 7:30pm"
 * and finds the parts the form can fill: who, when, how often, and the reminder text that is left.
 *
 * Deterministic and conservative: numbers only count as times with am/pm, a colon, or "at" in front
 * ("take 2 pills" stays as it is). The app never applies a result by itself; it offers it, and the person
 * taps to use it. Minutes round UP to the next quarter hour (5:10pm becomes 5:15 PM).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./schedule-core'));
  else root.RemindParse = factory(root.RemindCore);
}(typeof self !== 'undefined' ? self : this, function (core) {
  'use strict';

  const WEEKDAYS = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
  };
  const WEEKDAY_RE = '(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';
  const WEEKDAY_FULL_RE = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
  const MONTHS = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
    jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };
  const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const PARTS_OF_DAY = { morning: '08:00', afternoon: '15:00', evening: '18:00', night: '21:00', tonight: '20:00' };
  const EVERYONE = new Set(['everyone', 'everybody', 'all', 'us', 'all of us', 'the family', 'the household']);

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function roundUpQuarter(h, min) {
    let total = h * 60 + min;
    const rounded = Math.ceil(total / 15) * 15;
    const changed = rounded !== total;
    total = rounded;
    return { dayCarry: total >= 1440 ? 1 : 0, time: core.formatTime(Math.floor((total % 1440) / 60), total % 60), rounded: changed };
  }

  // "Sam", "Sam and Riley", "Sam, Riley & Jo", "me", "everyone" → member ids, or null if any part is unknown.
  function resolveNames(chunk, members, meId) {
    const raw = chunk.trim().toLowerCase().replace(/\s+/g, ' ');
    if (EVERYONE.has(raw)) return members.map((m) => m.id);
    const parts = raw.split(/\s*(?:,|&|\band\b|\+)\s*/).filter(Boolean);
    if (!parts.length) return null;
    const ids = [];
    for (const part of parts) {
      if (part === 'me' || part === 'myself') {
        if (meId == null) return null;
        ids.push(meId);
        continue;
      }
      const exact = members.filter((m) => m.name.toLowerCase() === part);
      const first = exact.length ? exact : members.filter((m) => m.name.toLowerCase().split(' ')[0] === part);
      if (first.length !== 1) return null;
      ids.push(first[0].id);
    }
    return [...new Set(ids)];
  }

  function parse(input, ctx) {
    const members = (ctx && ctx.members) || [];
    const meId = ctx && ctx.meId != null ? ctx.meId : null;
    const today = ctx.today;
    const nowTime = ctx.nowTime;
    let s = ` ${String(input || '').replace(/\s+/g, ' ').trim()} `;
    const out = { text: '', recipients: null, date: null, time: null, repeat: null, notes: [], found: [] };
    let pmHint = null; // true: a bare "at 7" means PM; false: AM
    let partTime = null;

    const take = (re, fn) => {
      const m = re.exec(s);
      if (!m) return false;
      if (fn(m) === false) return false;
      s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
      return true;
    };

    // 1 · Who: "remind <names> to|about|that …", "alert <names>: …"
    take(/^\s*(?:please\s+)?(?:remind|alert|tell|ping|nudge|notify)\s+(.+?)(?:\s+(?:to|about|that|of)\s+|\s*[:–—-]\s+)/i, (m) => {
      const ids = resolveNames(m[1], members, meId);
      if (!ids) return false;
      out.recipients = ids;
      out.found.push('who');
      return true;
    });

    // 2 · How often
    take(/\b(?:every\s*day|daily|each\s+day)\b/i, () => { out.repeat = { freq: 'daily', every: 1 }; });
    if (!out.repeat) take(/\bevery\s+(morning|afternoon|evening|night)\b/i, (m) => { out.repeat = { freq: 'daily', every: 1 }; partTime = PARTS_OF_DAY[m[1].toLowerCase()]; });
    if (!out.repeat) take(/\b(?:every\s+weekday|on\s+weekdays|weekdays)\b/i, () => { out.repeat = { freq: 'weekly', every: 1, weekdays: [1, 2, 3, 4, 5] }; });
    if (!out.repeat) take(/\b(?:every\s+weekend|on\s+weekends|weekends)\b/i, () => { out.repeat = { freq: 'weekly', every: 1, weekdays: [0, 6] }; });
    if (!out.repeat) {
      take(new RegExp(`\\bevery\\s+${WEEKDAY_RE}s?((?:\\s*(?:,|and|&)\\s*${WEEKDAY_RE}s?)*)\\b`, 'i'), (m) => {
        const names = m[0].replace(/^every\s+/i, '').split(/\s*(?:,|and|&)\s*/i);
        const days = names.map((n) => WEEKDAYS[n.toLowerCase().replace(/s$/, '')] ?? WEEKDAYS[n.toLowerCase()]).filter((d) => d != null);
        if (!days.length) return false;
        out.repeat = { freq: 'weekly', every: 1, weekdays: [...new Set(days)].sort((a, b) => a - b) };
        return true;
      });
    }
    if (!out.repeat) {
      take(/\bevery\s+(\d{1,2}|other)\s+(day|week|month|year)s?\b/i, (m) => {
        const every = m[1].toLowerCase() === 'other' ? 2 : Number(m[1]);
        if (every < 1 || every > core.MAX_EVERY) return false;
        out.repeat = { freq: { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[m[2].toLowerCase()], every };
        return true;
      });
    }
    if (!out.repeat) take(/\b(?:every\s+week|weekly)\b/i, () => { out.repeat = { freq: 'weekly', every: 1 }; });
    if (!out.repeat) take(/\b(?:every\s+month|monthly)\b/i, () => { out.repeat = { freq: 'monthly', every: 1 }; });
    if (!out.repeat) take(/\b(?:every\s+year|yearly|annually)\b/i, () => { out.repeat = { freq: 'yearly', every: 1 }; });
    if (out.repeat) out.found.push('repeat');

    // 3 · Relative times: "in 20 minutes", "in an hour", "in 3 days"
    take(/\bin\s+(\d{1,3}|an?|half\s+an)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/i, (m) => {
      const qty = /^half/i.test(m[1]) ? 0.5 : /^an?$/i.test(m[1]) ? 1 : Number(m[1]);
      const unit = m[2].toLowerCase();
      if (/^(day|week)/.test(unit)) {
        if (!Number.isInteger(qty) || qty < 1 || qty > 730) return false;
        out.date = core.addDays(today, qty * (unit.startsWith('week') ? 7 : 1));
        out.found.push('date');
        return true;
      }
      const [h, mm] = nowTime.split(':').map(Number);
      const addMin = Math.round(qty * (unit.startsWith('h') ? 60 : 1));
      if (addMin < 1 || addMin > 7 * 24 * 60) return false;
      const total = h * 60 + mm + addMin;
      const r = roundUpQuarter(0, total % 1440);
      out.date = core.addDays(today, Math.floor(total / 1440) + r.dayCarry);
      out.time = r.time;
      if (r.rounded) out.notes.push('rounded up to the quarter hour');
      out.found.push('date', 'time');
      return true;
    });

    // 4 · Dates
    if (!out.date) {
      take(/\b(?:the\s+)?day\s+after\s+tomorrow\b/i, () => { out.date = core.addDays(today, 2); });
      if (!out.date) take(/\b(?:tomorrow|tmrw|tmr)(?:\s+(morning|afternoon|evening|night))?\b/i, (m) => { out.date = core.addDays(today, 1); if (m[1]) partTime = PARTS_OF_DAY[m[1].toLowerCase()]; });
      if (!out.date) take(/\btonight\b/i, () => { out.date = today; pmHint = true; partTime = PARTS_OF_DAY.tonight; });
      if (!out.date) take(/\b(?:today|this\s+(morning|afternoon|evening))\b/i, (m) => { out.date = today; if (m[1]) partTime = PARTS_OF_DAY[m[1].toLowerCase()]; });
      if (!out.date && !(out.repeat && out.repeat.freq === 'weekly' && out.repeat.weekdays)) {
        // Short names (sat, sun, wed…) need next/this before them, or "on" before and a time or the end
        // after, so "put on sun screen" stays text.
        take(new RegExp(`\\b(?:(?:on\\s+)?(next|this)\\s+${WEEKDAY_RE}|on\\s+${WEEKDAY_RE}(?=\\s*(?:$|[,.!?]|at\\b|morning|afternoon|evening|night|\\d))|${WEEKDAY_FULL_RE})\\b(?:\\s+(morning|afternoon|evening|night))?`, 'i'), (m) => {
          const target = WEEKDAYS[(m[2] || m[3] || m[4]).toLowerCase()];
          if (target == null) return false;
          let diff = (target - core.weekdayOf(today) + 7) % 7;
          // The same weekday as today means a week out, unless they said "this".
          if (diff === 0 && (m[1] || '').toLowerCase() !== 'this') diff = 7;
          out.date = core.addDays(today, diff);
          if (m[5]) partTime = PARTS_OF_DAY[m[5].toLowerCase()];
          return true;
        });
      }
      if (!out.date) {
        const fromParts = (y, mo, d) => {
          if (mo < 1 || mo > 12 || d < 1 || d > core.daysInMonth(y, mo)) return null;
          let date = core.formatDate(y, mo, d);
          if (date < today) {
            if (mo === 2 && d === 29) return null;
            date = core.formatDate(y + 1, mo, d);
          }
          return date;
        };
        const ty = core.parseDate(today).y;
        take(new RegExp(`\\b(?:on\\s+)?${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'), (m) => {
          const date = fromParts(ty, MONTHS[m[1].toLowerCase()], Number(m[2]));
          if (!date) return false;
          out.date = date;
          return true;
        }) || take(new RegExp(`\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, 'i'), (m) => {
          const date = fromParts(ty, MONTHS[m[2].toLowerCase()], Number(m[1]));
          if (!date) return false;
          out.date = date;
          return true;
        }) || take(/\bon\s+(\d{1,2})\/(\d{1,2})\b/i, (m) => {
          const date = fromParts(ty, Number(m[1]), Number(m[2]));
          if (!date) return false;
          out.date = date;
          return true;
        });
      }
      if (out.date) out.found.push('date');
    }

    // 5 · Times
    if (!out.time) {
      let raw = null;
      take(/\b(?:at\s+)?(noon|midday|midnight)\b/i, (m) => { raw = m[1].toLowerCase() === 'midnight' ? { h: 0, min: 0 } : { h: 12, min: 0 }; })
        || take(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b\.?/i, (m) => {
          let h = Number(m[1]);
          const min = Number(m[2] || 0);
          if (h < 1 || h > 12 || min > 59) return false;
          if (m[3].toLowerCase() === 'p' && h !== 12) h += 12;
          if (m[3].toLowerCase() === 'a' && h === 12) h = 0;
          raw = { h, min };
          return true;
        })
        || take(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/i, (m) => {
          raw = { h: Number(m[1]), min: Number(m[2]) };
          // "at 5:30" with no am/pm: read 1-7 as PM, like the bare-hour rule below.
          if (raw.h >= 1 && raw.h <= 7 && !/^0/.test(m[1]) && pmHint !== false) raw.h += 12;
          else if (raw.h >= 1 && raw.h <= 11 && pmHint === true) raw.h += 12;
          return true;
        })
        || take(/\bat\s+(\d{1,2})\b(?!\s*(?:%|percent|degrees|pills?|tablets?|mg|ml))/i, (m) => {
          let h = Number(m[1]);
          if (h < 1 || h > 12) return false;
          // A bare hour: 1-7 reads as PM, 8-11 as AM, 12 as noon, unless "tonight"/"evening" said PM.
          if (pmHint === true && h < 12) h += 12;
          else if (pmHint !== false && h >= 1 && h <= 7) h += 12;
          raw = { h, min: 0 };
          return true;
        });
      if (!raw && partTime) {
        const [h, min] = partTime.split(':').map(Number);
        raw = { h, min };
      }
      if (raw) {
        const r = roundUpQuarter(raw.h, raw.min);
        out.time = r.time;
        if (r.rounded) out.notes.push('rounded up to the quarter hour');
        if (r.dayCarry && out.date) out.date = core.addDays(out.date, 1);
        out.found.push('time');
      }
    }
    // A time without a date: today if it is still ahead, otherwise tomorrow.
    if (out.time && !out.date && !out.repeat) {
      out.date = out.time > nowTime ? today : core.addDays(today, 1);
    }

    // 6 · What is left is the reminder text.
    let text = s.replace(/\s+/g, ' ').trim();
    text = text.replace(/^(?:(?:to|at|on|and|about|that|by)\b|[,:;–—-])\s*/i, '');
    text = text.replace(/\s*(?:\b(?:at|on|by|and)|[,:;–—-])$/i, '');
    text = text.trim();
    out.text = text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
    out.found = [...new Set(out.found)];
    return out;
  }

  return { parse, resolveNames, escapeRe };
}));
