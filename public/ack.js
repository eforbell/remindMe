/* Remind Me: the Got it page a push links to (docs/plan-ack-and-snooze.md).
 *
 * The link is <app>/ack#t=<token>&a=<alert number>. The fragment never reaches the server, so the token is in no
 * access log. This page posts it to api/ack: "peek" on load (shows the reminder, changes nothing), "ack" or
 * "snooze" only when a button is tapped. It works without signing in: the token is what says which reminder,
 * and it acts as the person the reminder was for.
 */
'use strict';

(() => {
  const { esc, api } = RM;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('t') || '';
  const alertNo = /^\d{1,5}$/.test(params.get('a') || '') ? Number(params.get('a')) : null;
  let delivery = null;
  let busy = false;

  // Times in the household's zone (it comes with the reminder), never the phone's.
  function timeText(iso) {
    if (!iso) return '';
    const opts = { hour: 'numeric', minute: '2-digit' };
    if (delivery?.timezone) opts.timeZone = delivery.timezone;
    try { return new Intl.DateTimeFormat([], opts).format(new Date(iso)); } catch { return new Date(iso).toLocaleTimeString([], opts); }
  }

  // Through the pages' one fetch helper (common.js), like every other page write.
  const post = (body) => api('api/ack', { method: 'POST', body: { token, via: 'link', ...body } });

  function show({ label, body, note = '', actions = false }) {
    $('ack-label').textContent = label;
    $('ack-body').innerHTML = body;
    $('ack-note').textContent = note;
    $('ack-actions').classList.toggle('hidden', !actions || !delivery);
    if (delivery) {
      $('ack-btn').classList.toggle('hidden', !delivery.can_ack);
      $('ack-snooze').classList.toggle('hidden', !delivery.can_snooze);
    }
  }

  function gone() {
    delivery = null;
    show({
      label: 'Link expired',
      body: '<div class="next-empty">This link no longer works.</div><div class="next-people">The reminder was stopped, changed, or is too old. Open Remind Me to see what’s waiting for you.</div>',
    });
  }

  function render(note = '') {
    const d = delivery;
    const due = `<div class="next-meta"><span class="next-when">Due ${esc(timeText(d.scheduled_for))}</span></div>`;
    let state = '';
    let label = d.ack_required ? 'Waiting for your Got it' : 'Reminder';
    if (d.acked_at) {
      label = 'Done';
      state = `<div class="next-people ack-done">✓ Got it at ${esc(timeText(d.acked_at))}</div>`;
    } else if (d.ended === 'expired') {
      state = '<div class="next-people">It stopped re-alerting without a Got it. You can still tap it.</div>';
    } else if (d.next_alert_kind === 'snooze' && d.next_alert_at) {
      state = `<div class="next-people">Snoozed until ${esc(timeText(d.next_alert_at))}</div>`;
    } else if (d.ack_required && d.follow_ups) {
      state = `<div class="next-people">Re-alerted ${d.follow_ups} time${d.follow_ups === 1 ? '' : 's'}. It keeps going until you tap Got it.</div>`;
    } else if (d.ack_required) {
      state = '<div class="next-people">It re-alerts until you tap Got it.</div>';
    }
    show({
      label,
      body: `<div class="next-text">${esc(d.title)}</div>${due}${state}`,
      note,
      actions: d.can_ack || d.can_snooze,
    });
  }

  async function act(body, done) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('#ack-actions button').forEach((b) => { b.disabled = true; });
    try {
      const out = await post(body);
      if (out.result === 'gone') return gone();
      if (out.delivery) delivery = out.delivery;
      render(done(out));
    } catch (err) {
      render(`${err.message} Nothing was changed: try again.`);
    } finally {
      busy = false;
      document.querySelectorAll('#ack-actions button').forEach((b) => { b.disabled = false; });
    }
  }

  // Got it: `from` is the alert this link came with (a tap from the first push also tells Remind Me it arrived).
  $('ack-btn').addEventListener('click', () => act({ action: 'ack', from: alertNo }, (out) => (
    out.result === 'already' ? 'It was already acknowledged.' : 'Thanks. No more alerts for this one.')));

  // Snooze from the latest alert (what the page just showed), not the one this link came with.
  $('ack-snooze').addEventListener('click', (e) => {
    const b = e.target.closest('[data-minutes]');
    if (!b || !delivery) return;
    act({ action: 'snooze', minutes: Number(b.dataset.minutes), from: delivery.alert_no }, (out) => {
      if (out.result === 'snoozed') return `Snoozed. It alerts again at ${timeText(out.until)}.`;
      if (out.result === 'already') return 'It was already acknowledged.';
      return 'It changed while this page was open. Here’s where it is now.';
    });
  });

  async function start() {
    if (!token) return gone();
    try {
      const out = await post({ action: 'peek' });
      if (out.result !== 'ok') return gone();
      delivery = out.delivery;
      render();
    } catch (err) {
      show({ label: 'Can’t reach Remind Me', body: `<div class="next-people">${esc(err.message)}</div>`, note: 'Check your connection and reload this page.' });
    }
  }

  start();
})();
