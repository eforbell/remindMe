/* Remind Me: home page, composer, scheduled list. */
'use strict';

(() => {
  const { core, esc, api, avatar, toast, openSheet, closeSheet, confirmSheet } = RM;
  const $ = (id) => document.getElementById(id);
  const FREQ_LABEL = { once: 'Once', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };
  const UNIT = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' };
  const LEVEL = Object.fromEntries(core.LEVELS.map((l) => [l.value, l]));
  const COUNT_PRESETS = [5, 10, 30, 90];

  const state = { config: null, members: [], reminders: [], problems: [], health: null, loaded: false };

  // ── Data ─────────────────────────────────────────────────────────────────
  async function load() {
    try {
      const [config, m, r, health] = await Promise.all([
        api('api/config'), api('api/members'), api('api/reminders'), api('api/health').catch(() => null),
      ]);
      state.config = config;
      state.members = m.members;
      state.reminders = r.reminders;
      state.problems = r.problems || [];
      state.health = health;
      state.loaded = true;
      const me = RM.getMe();
      if (me && !state.members.some((x) => x.id === me)) RM.setMe(null);
      if (!RM.getMe() && state.members.length === 1) RM.setMe(state.members[0].id);
      renderHome();
      if (!$('scheduled').classList.contains('hidden')) renderScheduled();
      maybeAskWho();
    } catch (err) {
      $('next-body').innerHTML = `<span class="muted">${esc(err.message)}</span>`;
      $('status-line').textContent = '';
    }
  }

  const now = () => RM.householdNow(state.config.timezone);
  const memberById = (id) => state.members.find((m) => m.id === id);
  const reachable = () => state.members.filter((m) => m.has_key);
  const active = () => state.reminders.filter((r) => r.status === 'active');

  // ── Home ─────────────────────────────────────────────────────────────────
  function untilText(iso) {
    const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
    if (mins <= 0) return 'now';
    if (mins < 60) return `in ${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h < 24) return m ? `in ${h}h ${m}m` : `in ${h}h`;
    const d = Math.round(h / 24);
    return `in ${d} day${d === 1 ? '' : 's'}`;
  }

  function peopleText(list) {
    const names = list.map((p) => (p.id === RM.getMe() ? 'you' : p.name));
    if (names.length <= 2) return names.join(' and ');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  function renderHome() {
    const today = now().date;
    const list = active();
    $('list-count').textContent = String(list.length);
    $('list-count').classList.toggle('is-zero', list.length === 0);

    const next = list.filter((r) => r.next).sort((a, b) => a.next.at.localeCompare(b.next.at))[0];
    $('next-body').innerHTML = next ? `
      <div class="next-text">${esc(next.text)}</div>
      <div class="next-meta">
        <span class="next-when">${esc(RM.whenText(next.next.date, next.next.time, today))}</span>
        <span class="next-until">${esc(untilText(next.next.at))}</span>
      </div>
      <div class="next-people">to ${esc(peopleText(next.recipients))}${next.repeat.freq !== 'once' ? ` · ${esc(FREQ_LABEL[next.repeat.freq].toLowerCase())}` : ''}</div>`
      : `<div class="next-empty">Nothing scheduled.</div><div class="next-people">Tap <strong>New reminder</strong> to set one.</div>`;

    renderBanners(today);
    renderMeChip();
    renderStatus();
  }

  function renderStatus() {
    const d = state.health?.dispatcher;
    const el = $('status-line');
    if (!d) { el.textContent = ''; return; }
    el.classList.toggle('is-stale', Boolean(d.stale));
    el.innerHTML = d.stale
      ? '<span class="dot"></span>Reminders may be late: the scheduler hasn’t checked in recently.'
      : `<span class="dot"></span>Scheduler checked in ${esc(RM.relativeAgo(d.last_run_at))}`;
  }

  function renderBanners(today) {
    const out = [];
    if (state.members.length && !reachable().length) {
      out.push(`<div class="banner banner-info"><div class="banner-text"><strong>Nobody can get reminders yet.</strong> Add a brrr key for each person who should.</div>
        <div class="banner-actions"><a class="btn-solid btn-sm" href="people">Add keys</a></div></div>`);
    }
    if (state.health?.dispatcher?.stale) {
      out.push(`<div class="banner banner-warn"><div class="banner-text"><strong>The scheduler isn’t checking in.</strong> Reminders will go out late until it does. Check the Remind Me service in Home Base.</div></div>`);
    }
    // Delivery problems, grouped per reminder text.
    const byText = new Map();
    for (const p of state.problems) {
      const key = `${p.reminder_id}`;
      if (!byText.has(key)) byText.set(key, []);
      byText.get(key).push(p);
    }
    for (const list of byText.values()) {
      const names = [...new Set(list.map((p) => p.member_name))];
      const retrying = list.some((p) => p.status !== 'failed');
      out.push(`<div class="banner banner-bad"><div class="banner-text"><strong>${retrying ? 'Still trying to deliver' : 'Couldn’t deliver'}</strong> “${esc(list[0].text)}” to ${esc(names.join(', '))}. ${esc((list[0].last_error || '').replace(/([^.!?])$/, '$1.'))}${retrying ? ' Retrying automatically.' : ''}</div>
        <div class="banner-actions"><a class="btn-ghost btn-sm" href="people">Check brrr keys</a></div></div>`);
    }
    for (const r of state.reminders) {
      if (r.ending_soon) {
        const lastText = r.last ? RM.whenText(r.last.date, r.last.time, today) : '';
        out.push(`<div class="banner banner-renew" data-id="${r.id}"><div class="banner-text"><strong>“${esc(r.text)}” is ending.</strong>
          ${r.remaining === 1 ? 'One reminder left' : `${r.remaining} left`}${lastText ? `, the last ${esc(lastText)}` : ''}.</div>
          <div class="banner-actions">
            <button type="button" class="btn-solid btn-sm" data-act="extend" data-id="${r.id}">Add ${r.extend_by} more</button>
            <button type="button" class="btn-ghost btn-sm" data-act="edit" data-id="${r.id}">Change</button>
            <button type="button" class="btn-ghost btn-sm" data-act="dismiss" data-id="${r.id}">Let it end</button>
          </div></div>`);
      }
      if (r.ended_prompt) {
        out.push(`<div class="banner banner-renew" data-id="${r.id}"><div class="banner-text"><strong>“${esc(r.text)}” has finished.</strong> ${esc(r.describe.replace(/, \d+ times?$/, ''))}, done.</div>
          <div class="banner-actions">
            <button type="button" class="btn-solid btn-sm" data-act="again" data-id="${r.id}">Schedule again</button>
            <button type="button" class="btn-ghost btn-sm" data-act="dismiss" data-id="${r.id}">Dismiss</button>
          </div></div>`);
      }
    }
    $('banners').innerHTML = out.join('');
  }

  function renderMeChip() {
    const btn = $('me-btn');
    const me = memberById(RM.getMe());
    btn.classList.toggle('hidden', state.members.length < 2);
    btn.innerHTML = me ? `${avatar(me, 'avatar-sm')}<span class="me-name">${esc(me.name)}</span>` : '<span class="me-name">Who are you?</span>';
  }

  function maybeAskWho() {
    if (RM.getMe() || state.members.length < 2 || sessionStorage.getItem('rm_who_asked')) return;
    sessionStorage.setItem('rm_who_asked', '1');
    openWho();
  }

  function openWho() {
    $('whoami-list').innerHTML = state.members.map((m) => `
      <button type="button" class="whoami-item ${m.id === RM.getMe() ? 'is-selected' : ''}" data-id="${m.id}">
        ${avatar(m)}<span>${esc(m.name)}</span>
      </button>`).join('');
    openSheet($('whoami'));
  }

  $('whoami-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    RM.setMe(Number(b.dataset.id));
    closeSheet($('whoami'));
    renderHome();
  });
  $('me-btn').addEventListener('click', openWho);

  // Banner and list actions (event delegation).
  async function act(action, id) {
    const r = state.reminders.find((x) => x.id === id);
    if (!r) return;
    try {
      if (action === 'extend') {
        await api(`api/reminders/${id}/extend`, { method: 'POST', body: {} });
        toast(`Added ${r.extend_by} more`);
      } else if (action === 'dismiss') {
        await api(`api/reminders/${id}/dismiss-renewal`, { method: 'POST', body: {} });
      } else if (action === 'edit') {
        openComposer({ edit: r });
        return;
      } else if (action === 'again') {
        openComposer({ again: r });
        return;
      } else if (action === 'delete') {
        const ok = await confirmSheet({
          title: `Delete “${r.text}”?`,
          body: r.repeat.freq === 'once' ? 'It won’t be sent.' : 'The whole series stops. Nothing more will be sent.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        await api(`api/reminders/${id}`, { method: 'DELETE' });
        toast('Deleted');
      }
      await load();
    } catch (err) {
      toast(err.message, 'bad');
      if (err.status === 404 || err.status === 409) load();
    }
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) act(b.dataset.act, Number(b.dataset.id));
  });

  // ── Scheduled list ───────────────────────────────────────────────────────
  function deliveryLine(r) {
    const ds = r.deliveries || [];
    if (!ds.length) return '';
    const tz = state.config.timezone;
    const today = now().date;
    const parts = ds.map((d) => {
      const name = memberById(d.member_id)?.name || 'someone';
      const w = RM.wallOfIso(d.sent_at || d.scheduled_for, tz);
      const when = RM.whenText(w.date, w.time, today);
      switch (d.status) {
        case 'sent': return `<span class="ds ds-ok">✓ ${esc(name)}, ${esc(when)}</span>`;
        case 'pending':
        case 'sending': return d.last_error
          ? `<span class="ds ds-warn">↻ ${esc(name)}: retrying (${esc(d.last_error || 'send failed')})</span>`
          : `<span class="ds">… ${esc(name)}: sending</span>`;
        case 'failed': return `<span class="ds ds-bad">✕ ${esc(name)}: not delivered (${esc(d.last_error || 'failed')})</span>`;
        case 'missed': return `<span class="ds ds-warn">– ${esc(name)}: missed ${esc(when)}</span>`;
        default: return '';
      }
    });
    return `<div class="rem-deliveries"><span class="rem-label">Last time</span>${parts.join('')}</div>`;
  }

  function reminderCard(r, today) {
    const level = LEVEL[r.level];
    const bounded = r.repeat.freq !== 'once' && r.remaining != null;
    const repeatText = r.repeat.freq === 'once' ? 'Once'
      : `${r.describe.replace(/, (\d+ times?|until deleted)$/, '')}${bounded ? ` · ${r.remaining} left` : ' · until deleted'}`;
    return `
      <article class="rem-card ${r.ending_soon ? 'is-ending' : ''}" data-id="${r.id}">
        <div class="rem-top">
          <h3 class="rem-text">${esc(r.text)}</h3>
          <span class="level-pill level-${esc(r.level)}">${esc(level?.label || r.level)}</span>
        </div>
        <div class="rem-when"><span class="rem-label">Next</span>${esc(RM.whenText(r.next.date, r.next.time, today))} <span class="muted">· ${esc(untilText(r.next.at))}</span></div>
        <div class="rem-repeat"><span class="rem-label">Repeat</span>${esc(repeatText)}${bounded && r.last ? `<span class="muted"> · last ${esc(RM.whenText(r.last.date, r.last.time, today))}</span>` : ''}</div>
        <div class="rem-people">${r.recipients.map((p) => `<span class="rem-person">${avatar(p, 'avatar-xs')}${esc(p.name)}${p.has_key ? '' : ' <span class="no-key">no key</span>'}</span>`).join('')}</div>
        ${deliveryLine(r)}
        <div class="rem-actions">
          ${r.ending_soon ? `<button type="button" class="btn-solid btn-sm" data-act="extend" data-id="${r.id}">Add ${r.extend_by} more</button>` : ''}
          <button type="button" class="btn-ghost btn-sm" data-act="edit" data-id="${r.id}">Edit</button>
          <button type="button" class="btn-danger btn-sm" data-act="delete" data-id="${r.id}">Delete</button>
        </div>
      </article>`;
  }

  async function renderScheduled() {
    const today = now().date;
    const list = active();
    $('scheduled-sub').textContent = list.length ? `${list.length} reminder${list.length === 1 ? '' : 's'}, soonest first` : '';
    $('scheduled-list').innerHTML = list.length
      ? list.map((r) => reminderCard(r, today)).join('')
      : `<div class="empty-state"><h3>Nothing scheduled</h3><p>New reminders show up here until they’re sent.</p>
         <div class="form-actions"><button type="button" class="btn-solid" id="empty-new">New reminder</button></div></div>`;
    $('empty-new')?.addEventListener('click', () => { closeSheet($('scheduled')); openComposer(); });
    try {
      const { deliveries } = await api('api/deliveries?limit=15');
      const tz = state.config.timezone;
      $('recent').classList.toggle('hidden', !deliveries.length);
      $('recent-list').innerHTML = deliveries.map((d) => {
        const w = RM.wallOfIso(d.sent_at || d.scheduled_for, tz);
        const icon = { sent: '✓', failed: '✕', missed: '–', pending: '↻', sending: '…' }[d.status] || '';
        return `<li class="recent-item st-${esc(d.status)}"><span class="recent-icon">${icon}</span>
          <span class="recent-main"><span class="recent-text">${esc(d.text)}</span>
          <span class="recent-meta">${esc(d.member_name)} · ${esc(RM.whenText(w.date, w.time, today))}${d.status === 'sent' ? '' : ` · ${esc({ pending: 'retrying', sending: 'sending', failed: 'not delivered', missed: 'missed' }[d.status] || d.status)}`}</span></span></li>`;
      }).join('');
    } catch { $('recent').classList.add('hidden'); }
  }

  $('list-btn').addEventListener('click', () => {
    if (!state.loaded) return;
    renderScheduled();
    openSheet($('scheduled'));
  });

  // ── Composer ─────────────────────────────────────────────────────────────
  const c = {};
  let suggestTimer = null;
  let suggestions = [];
  let quickResult = null;

  function minutesUntil(date, time) {
    const n = now();
    return (core.dayNumber(date) - core.dayNumber(n.date)) * 1440
      + (Number(time.slice(0, 2)) * 60 + Number(time.slice(3))) - (Number(n.time.slice(0, 2)) * 60 + Number(n.time.slice(3)));
  }

  // The next quarter hour at least 15 minutes away.
  function defaultSlot() {
    const n = now();
    let slot = core.nextQuarterAfter(n.date, n.time);
    if (minutesUntil(slot.date, slot.time) < 15) slot = core.nextQuarterAfter(slot.date, slot.time);
    return slot;
  }

  function isPast(date, time) { return minutesUntil(date, time) <= 0; }

  function resetComposer() {
    const slot = defaultSlot();
    const me = memberById(RM.getMe());
    Object.assign(c, {
      mode: 'new', id: null, version: null, startedSeries: false,
      text: '', recipients: new Set(me?.has_key ? [me.id] : (reachable().length === 1 ? [reachable()[0].id] : [])),
      date: slot.date, time: slot.time,
      freq: 'once', every: 1, weekdays: new Set([core.weekdayOf(slot.date)]), weekdaysAuto: true,
      ends: 'after', count: core.DEFAULT_COUNTS.daily, level: state.config.default_level,
      anchor: null, anchorFreq: null, anchorEvery: null, origDate: null, droppedNames: [],
    });
    const d = core.parseDate(c.date);
    c.calY = d.y; c.calM = d.m;
  }

  function fillFrom(r, { asEdit }) {
    const rep = r.repeat;
    Object.assign(c, {
      text: r.text,
      recipients: new Set(r.recipients.filter((p) => p.has_key).map((p) => p.id)),
      droppedNames: asEdit ? r.recipients.filter((p) => !p.has_key).map((p) => p.name) : [],
      anchor: rep.freq === 'once' ? null : r.start_date,
      anchorFreq: rep.freq,
      anchorEvery: rep.every || 1,
      time: r.time,
      freq: rep.freq,
      every: rep.every || 1,
      level: r.level,
      ends: rep.freq !== 'once' && rep.count == null ? 'never' : 'after',
      count: rep.freq === 'once' ? core.DEFAULT_COUNTS.daily : (rep.count ?? core.DEFAULT_COUNTS[rep.freq]),
    });
    if (asEdit) {
      Object.assign(c, { mode: 'edit', id: r.id, version: r.version, date: r.next.date, origDate: r.next.date, startedSeries: r.fired_count > 0 });
    } else {
      // Schedule again: the same pattern measured from the same anchor (so "monthly on the 31st" stays on
      // the 31st), the original count, from its next date that is still ahead.
      const rule = { freq: rep.freq, every: rep.every || 1, weekdays: rep.weekdays, count: null };
      const n = now();
      let date = rep.freq === 'once' ? nextSlotAt(r.time).date : core.nextOccurrenceDate(rule, r.start_date, core.addDays(n.date, -1));
      if (rep.freq !== 'once' && date === n.date && isPast(date, r.time)) date = core.nextOccurrenceDate(rule, r.start_date, date);
      Object.assign(c, { date, origDate: date, count: r.extend_by || c.count });
    }
    c.weekdays = new Set(rep.weekdays && rep.weekdays.length ? rep.weekdays : [core.weekdayOf(c.date)]);
    c.weekdaysAuto = !(rep.weekdays && rep.weekdays.length);
    const d = core.parseDate(c.date);
    c.calY = d.y; c.calM = d.m;
  }

  // Today at `time` if that is still ahead, else tomorrow.
  function nextSlotAt(time) {
    const n = now();
    return { date: isPast(n.date, time) ? core.addDays(n.date, 1) : n.date, time };
  }

  function openComposer({ edit = null, again = null } = {}) {
    if (!state.loaded) return;
    resetComposer();
    if (edit) fillFrom(edit, { asEdit: true });
    if (again) fillFrom(again, { asEdit: false });
    $('composer-title').textContent = c.mode === 'edit' ? 'Edit reminder' : 'New reminder';
    $('composer-sub').textContent = c.mode === 'edit' && c.startedSeries
      ? 'Changing the date, time, or repeat restarts the series from the new date.'
      : 'Delivered by brrr on the quarter hour.';
    $('schedule-btn').textContent = c.mode === 'edit' ? 'Save changes' : 'Schedule';
    $('what').value = c.text;
    $('what-help').classList.toggle('hidden', Boolean(c.text));
    quickResult = null;
    hideSuggestions();
    renderComposer();
    $('composer-error').classList.add('hidden');
    if (!$('scheduled').classList.contains('hidden')) closeSheet($('scheduled'));
    openSheet($('composer'));
    $('composer').querySelector('.composer-body').scrollTop = 0;
    // Focus the text only for a new reminder, and not on touch devices (it would pop the keyboard over
    // the pickers before the person has seen them).
    if (c.mode === 'new' && !again && window.matchMedia('(hover: hover)').matches) setTimeout(() => $('what').focus({ preventScroll: true }), 60);
  }

  $('new-btn').addEventListener('click', () => openComposer());

  function renderComposer() {
    renderWho();
    renderDateQuick();
    renderCalendar();
    renderTime();
    renderRepeat();
    renderLevels();
    renderReadout();
    $('what-clear').classList.toggle('hidden', !c.text);
    const tz = state.config.timezone;
    const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    $('tz-help').textContent = deviceTz !== tz ? `Times are household time (${tz.replace(/_/g, ' ')}).` : '';
    $('tz-help').classList.toggle('hidden', deviceTz === tz);
  }

  function renderWho() {
    const ok = reachable();
    $('who-chips').innerHTML = state.members.map((m) => {
      const on = c.recipients.has(m.id);
      return `<button type="button" class="person-chip ${on ? 'is-on' : ''}" data-id="${m.id}" aria-pressed="${on}" ${m.has_key ? '' : 'disabled'}>
        ${avatar(m, 'avatar-sm')}<span class="person-name">${esc(m.id === RM.getMe() ? `${m.name} (me)` : m.name)}</span>
        ${m.has_key ? '<span class="check" aria-hidden="true"></span>' : '<span class="no-key">no key</span>'}
      </button>`;
    }).join('');
    const keyless = state.members.length - ok.length;
    const dropped = c.droppedNames.length ? `${esc(c.droppedNames.join(', '))} no longer ${c.droppedNames.length === 1 ? 'has' : 'have'} a brrr key and ${c.droppedNames.length === 1 ? 'was' : 'were'} taken off. ` : '';
    $('who-help').innerHTML = dropped + (!ok.length
      ? 'Nobody has a brrr key yet. <a href="people">Add one under People</a>.'
      : keyless ? `People without a brrr key can’t be picked. <a href="people">Add keys</a>.` : '');
  }

  $('who-chips').addEventListener('click', (e) => {
    const b = e.target.closest('.person-chip');
    if (!b || b.disabled) return;
    const id = Number(b.dataset.id);
    if (c.recipients.has(id)) c.recipients.delete(id); else c.recipients.add(id);
    renderWho();
    renderReadout();
  });

  function renderDateQuick() {
    const today = now().date;
    const days = [
      { date: today, label: 'Today' },
      { date: core.addDays(today, 1), label: 'Tomorrow' },
    ];
    for (let i = 2; i <= 6; i += 1) {
      const d = core.addDays(today, i);
      days.push({ date: d, label: core.WEEKDAY_SHORT[core.weekdayOf(d)] });
    }
    $('date-quick').innerHTML = days.map((d) => `<button type="button" class="chip-btn ${d.date === c.date ? 'is-on' : ''}" data-date="${d.date}">${esc(d.label)}</button>`).join('');
  }

  function seriesDatesInMonth(y, m) {
    if (c.freq === 'once') return new Set([c.date]);
    const monthStart = core.formatDate(y, m, 1);
    const monthEnd = core.formatDate(y, m, core.daysInMonth(y, m));
    // Walk the series up to the end of the shown month (however long it is), within its count.
    const rule = currentRule();
    const a = anchorDate();
    const out = new Set();
    let d = firstDate();
    for (let n = 0; d && d <= monthEnd && (rule.count == null || n < rule.count) && n < 50000; n += 1) {
      if (d >= monthStart) out.add(d);
      d = core.nextOccurrenceDate(rule, a, d);
    }
    return out;
  }

  function renderCalendar() {
    const today = now().date;
    const { calY: y, calM: m } = c;
    const first = core.formatDate(y, m, 1);
    const lead = core.weekdayOf(first);
    const dim = core.daysInMonth(y, m);
    const t = core.parseDate(today);
    const canPrev = y > t.y || (y === t.y && m > t.m);
    const series = seriesDatesInMonth(y, m);
    const cells = [];
    for (let i = 0; i < lead; i += 1) cells.push('<span class="cal-blank" aria-hidden="true"></span>');
    for (let d = 1; d <= dim; d += 1) {
      const date = core.formatDate(y, m, d);
      const past = date < today;
      const cls = ['cal-day'];
      if (date === today) cls.push('is-today');
      if (date === c.date) cls.push('is-selected');
      else if (series.has(date)) cls.push('in-series');
      const label = `${core.WEEKDAY_LONG[core.weekdayOf(date)]}, ${core.MONTH_LONG[m - 1]} ${d}`;
      cells.push(`<button type="button" class="${cls.join(' ')}" data-date="${date}" ${past ? 'disabled' : ''} aria-label="${label}" aria-pressed="${date === c.date}">${d}</button>`);
    }
    $('calendar').innerHTML = `
      <div class="cal-head">
        <button type="button" class="cal-nav" data-cal="-1" ${canPrev ? '' : 'disabled'} aria-label="Previous month">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button>
        <div class="cal-title">${core.MONTH_LONG[m - 1]} ${y}</div>
        <button type="button" class="cal-nav" data-cal="1" aria-label="Next month">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>
      </div>
      <div class="cal-grid cal-dow" aria-hidden="true">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => `<span>${x}</span>`).join('')}</div>
      <div class="cal-grid">${cells.join('')}</div>`;
  }

  function setDate(date) {
    c.date = date;
    const d = core.parseDate(date);
    c.calY = d.y; c.calM = d.m;
    if (c.weekdaysAuto) c.weekdays = new Set([core.weekdayOf(date)]);
    // Picking today with a time that has passed: move to the next good time.
    if (isPast(c.date, c.time)) {
      const slot = defaultSlot();
      if (slot.date === c.date) c.time = slot.time;
    }
    renderDateQuick();
    renderCalendar();
    renderTime();
    renderRepeat();
    renderReadout();
  }

  $('date-quick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-date]');
    if (b) setDate(b.dataset.date);
  });
  $('calendar').addEventListener('click', (e) => {
    const nav = e.target.closest('[data-cal]');
    if (nav && !nav.disabled) {
      let m = c.calM + Number(nav.dataset.cal);
      let y = c.calY;
      if (m < 1) { m = 12; y -= 1; }
      if (m > 12) { m = 1; y += 1; }
      c.calY = y; c.calM = m;
      renderCalendar();
      return;
    }
    const day = e.target.closest('[data-date]');
    if (day && !day.disabled) setDate(day.dataset.date);
  });

  function renderTime() {
    const h24 = Number(c.time.slice(0, 2));
    const min = Number(c.time.slice(3));
    const pm = h24 >= 12;
    const h12 = ((h24 + 11) % 12) + 1;
    const today = c.date === now().date;
    const slotPast = (h, q) => today && isPast(c.date, core.formatTime(h, q));
    const to24 = (h, isPm) => (h % 12) + (isPm ? 12 : 0);
    const hours = [];
    for (let h = 1; h <= 12; h += 1) {
      const hh = to24(h, pm);
      const allPast = slotPast(hh, 45);
      hours.push(`<button type="button" class="tp-hour ${h === h12 ? 'is-on' : ''}" data-hour="${h}" ${allPast ? 'disabled' : ''} aria-pressed="${h === h12}">${h}</button>`);
    }
    const quarters = core.QUARTERS.map((q) => `<button type="button" class="tp-q ${q === min ? 'is-on' : ''}" data-q="${q}" ${slotPast(h24, q) ? 'disabled' : ''} aria-pressed="${q === min}">:${core.pad2(q)}</button>`);
    const amPast = today && slotPast(11, 45);
    $('timepicker').innerHTML = `
      <div class="tp-top">
        <div class="tp-readout" aria-live="polite"><span class="tp-big">${h12}:${core.pad2(min)}</span><span class="tp-ampm-label">${pm ? 'PM' : 'AM'}</span></div>
        <div class="segmented tp-ampm" role="radiogroup" aria-label="AM or PM">
          <button type="button" class="${pm ? '' : 'is-on'}" data-ampm="am" role="radio" aria-checked="${!pm}" ${amPast ? 'disabled' : ''}>AM</button>
          <button type="button" class="${pm ? 'is-on' : ''}" data-ampm="pm" role="radio" aria-checked="${pm}">PM</button>
        </div>
      </div>
      <div class="tp-hours" role="group" aria-label="Hour">${hours.join('')}</div>
      <div class="segmented tp-quarters" role="group" aria-label="Minutes">${quarters.join('')}</div>`;
  }

  // The first quarter of hour hh that is still ahead (or the given one if it is).
  function firstOpenQuarter(hh, wanted) {
    if (!isPast(c.date, core.formatTime(hh, wanted))) return wanted;
    return core.QUARTERS.find((q) => !isPast(c.date, core.formatTime(hh, q))) ?? wanted;
  }

  $('timepicker').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    let h24 = Number(c.time.slice(0, 2));
    let min = Number(c.time.slice(3));
    const pm = h24 >= 12;
    if (b.dataset.hour) {
      h24 = (Number(b.dataset.hour) % 12) + (pm ? 12 : 0);
      min = firstOpenQuarter(h24, min);
    } else if (b.dataset.q) {
      min = Number(b.dataset.q);
    } else if (b.dataset.ampm) {
      const wantPm = b.dataset.ampm === 'pm';
      if (wantPm !== pm) h24 = (h24 + 12) % 24;
      min = firstOpenQuarter(h24, min);
    }
    c.time = core.formatTime(h24, min);
    renderTime();
    renderReadout();
  });

  // The date the repeat pattern is measured from: the series' own anchor while the date and the kind of
  // pattern are unchanged (editing a time keeps "the 31st"), otherwise the picked date. Mirrors the server.
  function anchorDate() {
    if (c.anchor && c.freq !== 'once' && c.freq === c.anchorFreq && c.every === c.anchorEvery && c.date === c.origDate) return c.anchor;
    return c.date;
  }

  // The first reminder on or after the picked date, and the series from there.
  function firstDate() {
    const a = anchorDate();
    return core.nextOccurrenceDate(currentRule(), a, a === c.date ? null : core.addDays(c.date, -1));
  }

  function seriesDates(limit) {
    const rule = currentRule();
    const a = anchorDate();
    const out = [];
    let d = firstDate();
    const max = rule.count == null ? limit : Math.min(limit, rule.count);
    while (d && out.length < max) { out.push(d); d = core.nextOccurrenceDate(rule, a, d); }
    return out;
  }

  function currentRule() {
    return {
      freq: c.freq,
      every: c.freq === 'once' ? 1 : c.every,
      weekdays: c.freq === 'weekly' ? [...c.weekdays].sort((a, b) => a - b) : null,
      count: c.freq === 'once' ? 1 : (c.ends === 'never' ? null : c.count),
    };
  }

  function stepper(name, value, min, max, label) {
    return `<div class="stepper" data-stepper="${name}">
      <button type="button" data-step="-1" ${value <= min ? 'disabled' : ''} aria-label="Fewer">−</button>
      <output aria-label="${esc(label)}">${value}</output>
      <button type="button" data-step="1" ${value >= max ? 'disabled' : ''} aria-label="More">+</button>
    </div>`;
  }

  function renderRepeat() {
    $('repeat-seg').innerHTML = core.FREQS.map((f) => `<button type="button" role="radio" aria-checked="${c.freq === f}" class="${c.freq === f ? 'is-on' : ''}" data-freq="${f}">${FREQ_LABEL[f]}</button>`).join('');
    const detail = $('repeat-detail');
    if (c.freq === 'once') { detail.classList.add('hidden'); detail.innerHTML = ''; return; }
    detail.classList.remove('hidden');
    const unit = UNIT[c.freq];
    const rule = currentRule();
    const first = firstDate();
    const last = rule.count != null ? seriesDates(rule.count).pop() : null;
    const today = now().date;
    const weekdayRow = c.freq === 'weekly' ? `
      <div class="weekday-row" role="group" aria-label="On these days">
        ${core.WEEKDAY_SHORT.map((w, i) => `<button type="button" class="wd ${c.weekdays.has(i) ? 'is-on' : ''}" data-wd="${i}" aria-pressed="${c.weekdays.has(i)}" aria-label="${core.WEEKDAY_LONG[i]}">${w.slice(0, 1)}</button>`).join('')}
      </div>` : '';
    detail.innerHTML = `
      <div class="repeat-row"><span class="repeat-key">Every</span>${stepper('every', c.every, 1, core.MAX_EVERY, 'Every')}<span class="repeat-unit">${c.every === 1 ? unit : `${unit}s`}</span></div>
      ${weekdayRow}
      <div class="repeat-row"><span class="repeat-key">Ends</span>
        <div class="segmented seg-ends" role="radiogroup" aria-label="Ends">
          <button type="button" role="radio" class="${c.ends === 'after' ? 'is-on' : ''}" aria-checked="${c.ends === 'after'}" data-ends="after">After</button>
          <button type="button" role="radio" class="${c.ends === 'never' ? 'is-on' : ''}" aria-checked="${c.ends === 'never'}" data-ends="never">Never</button>
        </div>
      </div>
      ${c.ends === 'after' ? `
        <div class="repeat-row"><span class="repeat-key"></span>${stepper('count', c.count, 1, core.MAX_COUNT, 'Times')}<span class="repeat-unit">${c.count === 1 ? 'time' : 'times'}</span></div>
        <div class="count-presets">${COUNT_PRESETS.map((n) => `<button type="button" class="chip-btn ${c.count === n ? 'is-on' : ''}" data-count="${n}">${n}</button>`).join('')}</div>` : ''}
      <p class="repeat-preview">${first ? `First: ${esc(RM.whenText(first, c.time, today))}` : ''}${last ? `<br>Last: ${esc(RM.whenText(last, c.time, today))}. You’ll get a prompt to extend it near the end.` : (rule.count == null ? '<br>Repeats until you delete it.' : '')}</p>`;
  }

  $('repeat-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-freq]');
    if (!b) return;
    const was = c.freq;
    c.freq = b.dataset.freq;
    if (was === 'once' && c.freq !== 'once' && c.ends === 'after') c.count = core.DEFAULT_COUNTS[c.freq];
    else if (c.freq !== 'once' && was !== c.freq && c.ends === 'after' && c.count === core.DEFAULT_COUNTS[was]) c.count = core.DEFAULT_COUNTS[c.freq];
    renderRepeat();
    renderCalendar();
    renderReadout();
  });

  $('repeat-detail').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.step) {
      const which = b.closest('[data-stepper]').dataset.stepper;
      const delta = Number(b.dataset.step);
      if (which === 'every') c.every = Math.min(core.MAX_EVERY, Math.max(1, c.every + delta));
      else c.count = Math.min(core.MAX_COUNT, Math.max(1, c.count + delta));
    } else if (b.dataset.wd) {
      const i = Number(b.dataset.wd);
      if (c.weekdays.has(i)) { if (c.weekdays.size > 1) c.weekdays.delete(i); } else c.weekdays.add(i);
      c.weekdaysAuto = false;
    } else if (b.dataset.ends) {
      c.ends = b.dataset.ends;
    } else if (b.dataset.count) {
      c.count = Number(b.dataset.count);
    }
    renderRepeat();
    renderCalendar();
    renderReadout();
  });

  function renderLevels() {
    $('levels').innerHTML = core.LEVELS.map((l) => `
      <button type="button" role="radio" aria-checked="${c.level === l.value}" class="level-opt level-${l.value} ${c.level === l.value ? 'is-on' : ''}" data-level="${l.value}">
        <span class="level-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <span class="level-name">${esc(l.label)}</span>
        <span class="level-hint">${esc(l.hint)}</span>
      </button>`).join('');
  }

  $('levels').addEventListener('click', (e) => {
    const b = e.target.closest('[data-level]');
    if (!b) return;
    c.level = b.dataset.level;
    renderLevels();
    renderReadout();
  });

  // The first problem that stops scheduling, or null.
  function problem() {
    if (!c.text.trim()) return { msg: 'Say what the reminder is for.', focus: 'what' };
    if (!c.recipients.size) return { msg: reachable().length ? 'Pick who to remind.' : 'Add a brrr key under People first.', focus: 'who-chips' };
    const first = firstDate();
    if (!first || isPast(first, c.time)) return { msg: 'That time has passed. Pick a later one.', focus: 'timepicker' };
    return null;
  }

  function renderReadout() {
    const today = now().date;
    const first = firstDate() || c.date;
    $('when-readout').textContent = RM.whenText(first, c.time, today);
    const who = [...c.recipients].map(memberById).filter(Boolean);
    const level = LEVEL[c.level]?.label || '';
    const parts = [];
    parts.push(who.length ? `Remind ${peopleText(who)}` : 'Remind …');
    parts.push(RM.whenText(first, c.time, today));
    if (c.freq !== 'once') parts.push(core.describeRepeat(currentRule(), anchorDate()).replace(/^./, (x) => x.toLowerCase()));
    parts.push(level.toLowerCase());
    $('composer-summary').innerHTML = `${c.text.trim() ? `<strong>${esc(c.text.trim())}</strong><br>` : ''}${esc(parts.join(' · '))}`;
    const p = problem();
    $('schedule-btn').classList.toggle('is-blocked', Boolean(p));
    $('schedule-btn').setAttribute('aria-disabled', p ? 'true' : 'false');
    if (!p) $('composer-error').classList.add('hidden');
  }

  // What: text, suggestions, quick entry.
  $('what').addEventListener('input', () => {
    c.text = $('what').value;
    $('what-clear').classList.toggle('hidden', !c.text);
    $('what-help').classList.toggle('hidden', Boolean(c.text));
    renderQuick();
    renderReadout();
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(fetchSuggestions, 140);
  });
  $('what').addEventListener('focus', () => { clearTimeout(suggestTimer); suggestTimer = setTimeout(fetchSuggestions, 0); });
  $('what').addEventListener('blur', () => setTimeout(hideSuggestions, 180));
  $('what').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('what').blur(); }
  });
  $('what-clear').addEventListener('click', () => {
    $('what').value = '';
    c.text = '';
    renderQuick();
    renderReadout();
    $('what-clear').classList.add('hidden');
    $('what').focus({ preventScroll: true });
  });

  async function fetchSuggestions() {
    if (document.activeElement !== $('what')) return;
    try {
      const q = c.text.trim();
      const { suggestions: list } = await api(`api/suggestions?q=${encodeURIComponent(q)}`);
      suggestions = list.filter((s) => s.text.toLowerCase() !== q.toLowerCase());
      if (document.activeElement !== $('what')) return;
      renderSuggestions();
    } catch { hideSuggestions(); }
  }

  function suggestionMeta(s) {
    const bits = [];
    if (s.time) bits.push(core.formatTime12(s.time));
    if (s.repeat?.freq && s.repeat.freq !== 'once') bits.push(FREQ_LABEL[s.repeat.freq].toLowerCase());
    const who = (s.recipients || []).map(memberById).filter(Boolean);
    if (who.length) bits.push(who.map((m) => m.name).join(', '));
    return bits.join(' · ');
  }

  function renderSuggestions() {
    const el = $('suggestions');
    if (!suggestions.length) { hideSuggestions(); return; }
    el.innerHTML = `<li class="sugg-head">${c.text.trim() ? 'From earlier' : 'Recent'}</li>${suggestions.slice(0, 5).map((s, i) => `
      <li class="sugg-row" role="option">
        <button type="button" class="sugg" data-i="${i}"><span class="sugg-text">${esc(s.text)}</span><span class="sugg-meta">${esc(suggestionMeta(s))}</span></button>
        <button type="button" class="sugg-x" data-forget="${i}" aria-label="Forget “${esc(s.text)}”">&times;</button>
      </li>`).join('')}`;
    el.classList.remove('hidden');
  }

  function hideSuggestions() { $('suggestions').classList.add('hidden'); }

  // Keep the input focused while tapping a suggestion (otherwise blur hides the list first).
  $('suggestions').addEventListener('pointerdown', (e) => e.preventDefault());
  $('suggestions').addEventListener('click', async (e) => {
    const forget = e.target.closest('[data-forget]');
    if (forget) {
      const s = suggestions[Number(forget.dataset.forget)];
      suggestions = suggestions.filter((x) => x !== s);
      renderSuggestions();
      api('api/suggestions', { method: 'DELETE', body: { text: s.text } }).catch(() => {});
      return;
    }
    const b = e.target.closest('[data-i]');
    if (!b) return;
    applySuggestion(suggestions[Number(b.dataset.i)]);
  });

  function applySuggestion(s) {
    c.text = s.text;
    $('what').value = s.text;
    if (s.time && core.isQuarterTime(s.time)) {
      const slot = nextSlotAt(s.time);
      c.time = s.time;
      c.date = slot.date;
    }
    if (s.level && LEVEL[s.level]) c.level = s.level;
    if (s.repeat?.freq) {
      c.freq = s.repeat.freq;
      c.every = s.repeat.every || 1;
      if (s.repeat.freq !== 'once') {
        c.ends = s.repeat.count == null ? 'never' : 'after';
        if (s.repeat.count) c.count = s.repeat.count;
      }
      if (s.repeat.weekdays?.length) { c.weekdays = new Set(s.repeat.weekdays); c.weekdaysAuto = false; }
      else { c.weekdays = new Set([core.weekdayOf(c.date)]); c.weekdaysAuto = true; }
    }
    const ids = (s.recipients || []).filter((id) => memberById(id)?.has_key);
    if (ids.length) c.recipients = new Set(ids);
    const d = core.parseDate(c.date);
    c.calY = d.y; c.calM = d.m;
    hideSuggestions();
    quickResult = null;
    $('quick').classList.add('hidden');
    $('what').blur();
    renderComposer();
    toast('Filled in from last time');
  }

  function renderQuick() {
    const el = $('quick');
    const text = c.text.trim();
    if (text.length < 4) { el.classList.add('hidden'); quickResult = null; return; }
    const n = now();
    const r = RemindParse.parse(text, { members: state.members, meId: RM.getMe(), today: n.date, nowTime: n.time });
    if (!r.found.length) { el.classList.add('hidden'); quickResult = null; return; }
    quickResult = r;
    const bits = [];
    if (r.recipients) {
      const who = r.recipients.map(memberById).filter(Boolean);
      const keyless = who.filter((m) => !m.has_key);
      bits.push(`<span class="q-bit">${who.map((m) => avatar(m, 'avatar-xs')).join('')}${esc(peopleText(who))}</span>`);
      if (keyless.length) bits.push(`<span class="q-bit q-warn">${esc(keyless.map((m) => m.name).join(', '))}: no key</span>`);
    }
    const date = r.date;
    if (date || r.time) bits.push(`<span class="q-bit">${esc(date && r.time ? RM.whenText(date, r.time, n.date) : date ? core.formatDateFriendly(date, n.date) : core.formatTime12(r.time))}</span>`);
    if (r.repeat) bits.push(`<span class="q-bit">${esc(FREQ_LABEL[r.repeat.freq])}${r.repeat.every > 1 ? ` ×${r.repeat.every}` : ''}${r.repeat.weekdays ? ` · ${r.repeat.weekdays.map((d) => core.WEEKDAY_SHORT[d]).join(' ')}` : ''}</span>`);
    el.innerHTML = `
      <div class="quick-body">
        <div class="quick-label">Fill in from your words${r.notes.length ? ` <span class="muted">(${esc(r.notes.join(', '))})</span>` : ''}</div>
        <div class="quick-bits">${r.text && r.text !== text ? `<span class="q-bit q-text">“${esc(r.text)}”</span>` : ''}${bits.join('')}</div>
      </div>
      <button type="button" class="btn-solid btn-sm" id="quick-use">Use</button>`;
    el.classList.remove('hidden');
  }

  $('quick').addEventListener('click', (e) => {
    if (!e.target.closest('#quick-use') || !quickResult) return;
    const r = quickResult;
    if (r.text) { c.text = r.text; $('what').value = r.text; }
    if (r.recipients) {
      const ok = r.recipients.filter((id) => memberById(id)?.has_key);
      if (ok.length) c.recipients = new Set(ok);
    }
    if (r.repeat) {
      c.freq = r.repeat.freq;
      c.every = r.repeat.every || 1;
      if (r.repeat.weekdays) { c.weekdays = new Set(r.repeat.weekdays); c.weekdaysAuto = false; }
      if (c.ends === 'after' && c.freq !== 'once') c.count = core.DEFAULT_COUNTS[c.freq];
    }
    if (r.time) c.time = r.time;
    if (r.date) c.date = r.date;
    else if (r.time && isPast(c.date, c.time)) c.date = nextSlotAt(c.time).date;
    if (c.freq === 'weekly' && c.weekdaysAuto) c.weekdays = new Set([core.weekdayOf(c.date)]);
    const d = core.parseDate(c.date);
    c.calY = d.y; c.calM = d.m;
    quickResult = null;
    $('quick').classList.add('hidden');
    hideSuggestions();
    renderComposer();
  });

  // Submit.
  $('composer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    c.text = $('what').value;
    const p = problem();
    const errEl = $('composer-error');
    if (p) {
      errEl.textContent = p.msg;
      errEl.classList.remove('hidden');
      const target = $(p.focus);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (p.focus === 'what') $('what').focus({ preventScroll: true });
      return;
    }
    const body = {
      text: c.text.trim(),
      recipients: [...c.recipients],
      date: c.date,
      time: c.time,
      level: c.level,
      repeat: currentRule(),
      created_by: RM.getMe(),
    };
    if (c.mode !== 'edit' && anchorDate() !== c.date) body.anchor = anchorDate();
    const btn = $('schedule-btn');
    btn.disabled = true;
    try {
      if (c.mode === 'edit') {
        await api(`api/reminders/${c.id}`, { method: 'PUT', body: { ...body, version: c.version } });
      } else {
        await api('api/reminders', { method: 'POST', body });
      }
      closeSheet($('composer'));
      const first = firstDate();
      toast(`${c.mode === 'edit' ? 'Saved' : 'Scheduled'}: ${RM.whenText(first, c.time, now().date)}`);
      await load();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      if (err.code === 'stale' || err.code === 'not_found' || err.code === 'finished') {
        await load();
        // Take the fresh version so the next Save compares against what is there now.
        const fresh = state.reminders.find((r) => r.id === c.id);
        if (fresh) c.version = fresh.version;
      }
    } finally {
      btn.disabled = false;
    }
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    // Refresh quietly, but never under an open composer (it would not lose input, but there is no need).
    if ($('composer').classList.contains('hidden')) load();
  }, 30000);

  load();
})();
