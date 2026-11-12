/* Remind Me: helpers shared by every page. */
'use strict';

// ── Zoom: never, in any form ────────────────────────────────────────────────
// Four layers, because iOS honors different ones in Safari and in a WKWebView wrapper:
//   1. viewport meta: maximum-scale=1, user-scalable=no (honored by WKWebView by default)
//   2. CSS: touch-action pan-x pan-y on everything (no pinch, no double-tap zoom) - remind-skin.css
//   3. CSS: every input, select, and textarea is at least 16px (no focus zoom) - remind-skin.css
//   4. JS, below: cancel WebKit's pinch gesture events and any multi-touch move
(function noZoom() {
  const stop = (e) => e.preventDefault();
  document.addEventListener('gesturestart', stop, { passive: false });
  document.addEventListener('gesturechange', stop, { passive: false });
  document.addEventListener('gestureend', stop, { passive: false });
  document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    // A second tap within 300ms on something that is not a control would zoom on old WebKit.
    if (now - lastTouchEnd < 300 && !e.target.closest('button, a, input, select, textarea, label, [role="button"]')) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });
}());

const RM = (() => {
  const core = window.RemindCore;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // fetch wrapper: relative paths only (the app lives under a mount path such as /remind/).
  // Every write says it is JSON, even with no body (a DELETE): under Home Base's suite identity the
  // server refuses a write without it.
  async function api(path, { method = 'GET', body } = {}) {
    const init = { method, headers: { Accept: 'application/json' } };
    if (method !== 'GET' && method !== 'HEAD') init.headers['Content-Type'] = 'application/json';
    if (body !== undefined) init.body = JSON.stringify(body);
    let res;
    try {
      res = await fetch(path.replace(/^\/+/, ''), init);
    } catch {
      throw Object.assign(new Error('Can’t reach Remind Me. Check your connection and try again.'), { code: 'offline' });
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      throw Object.assign(new Error(data?.error || `Request failed (${res.status}).`), { code: data?.code, status: res.status });
    }
    return data;
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  const AVATAR_COLORS = ['#C4572A', '#3B6E8F', '#6F8A55', '#8B6914', '#7A5BA6', '#2F8C84', '#B5476B', '#5B6FC9'];
  function avatarColor(id) { return AVATAR_COLORS[(Number(id) - 1 + AVATAR_COLORS.length * 10) % AVATAR_COLORS.length]; }

  function avatar(member, size = '') {
    return `<span class="avatar ${size}" style="--avatar:${avatarColor(member.id)}" aria-hidden="true">${esc(initials(member.name))}</span>`;
  }

  // Who is using this device (for "me" and "from …"). Per device, in localStorage.
  const ME_KEY = 'rm_member';
  function getMe() { const v = Number(localStorage.getItem(ME_KEY)); return Number.isInteger(v) && v > 0 ? v : null; }
  function setMe(id) { if (id) localStorage.setItem(ME_KEY, String(id)); else localStorage.removeItem(ME_KEY); }

  // Household wall clock "now", computed live in the household zone (the phone may be elsewhere).
  function householdNow(timeZone) {
    const parts = {};
    for (const { type, value } of new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date())) parts[type] = value;
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  }

  function relativeAgo(iso) {
    if (!iso) return 'never';
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 45) return 'just now';
    if (s < 90) return 'a minute ago';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} minutes ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }

  // "Today 5:00 PM", "Thu, Nov 5 at 9:15 AM"
  function whenText(date, time, today) {
    const day = core.formatDateFriendly(date, today);
    return /^(Today|Tomorrow|Yesterday)$/.test(day) ? `${day} ${core.formatTime12(time)}` : `${day} at ${core.formatTime12(time)}`;
  }

  // An instant shown in the household zone.
  function wallOfIso(iso, timeZone) {
    const parts = {};
    for (const { type, value } of new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(iso))) parts[type] = value;
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  }

  let toastTimer = null;
  function toast(message, kind = 'ok') {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.className = `toast toast-${kind}`;
    el.textContent = message;
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'bad' ? 5000 : 2600);
  }

  // Sheets: .overlay elements. Opening one locks page scroll; Escape and the backdrop close it.
  const openStack = [];
  function openSheet(el, { onClose } = {}) {
    if (openStack.some((s) => s.el === el)) return;
    el.classList.remove('hidden');
    el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    openStack.push({ el, onClose, returnFocus: document.activeElement });
    requestAnimationFrame(() => el.classList.add('is-open'));
  }
  function closeSheet(el) {
    const i = openStack.findIndex((s) => s.el === el);
    if (i < 0) return;
    const [entry] = openStack.splice(i, 1);
    el.classList.remove('is-open');
    el.classList.add('hidden');
    el.setAttribute('aria-hidden', 'true');
    if (!openStack.length) document.body.classList.remove('modal-open');
    entry.onClose?.();
    if (entry.returnFocus && document.contains(entry.returnFocus)) entry.returnFocus.focus({ preventScroll: true });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openStack.length) closeSheet(openStack[openStack.length - 1].el);
  });
  document.addEventListener('click', (e) => {
    const top = openStack[openStack.length - 1];
    if (!top) return;
    if (e.target === top.el) closeSheet(top.el);
    const closer = e.target.closest('[data-close]');
    if (closer && top.el.contains(closer)) closeSheet(top.el);
  });

  // A small confirm sheet. Resolves true/false.
  function confirmSheet({ title, body = '', confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'overlay hidden';
      el.innerHTML = `
        <div class="overlay-box confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
          <div class="modal-body">
            <h2 id="confirm-title" class="confirm-title">${esc(title)}</h2>
            ${body ? `<p class="confirm-text">${esc(body)}</p>` : ''}
          </div>
          <div class="modal-foot">
            <button type="button" class="btn-ghost btn-lg" data-answer="no">Cancel</button>
            <button type="button" class="${danger ? 'btn-danger' : 'btn-solid'} btn-lg" data-answer="yes">${esc(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(el);
      let answered = false;
      const done = (value) => {
        if (answered) return;
        answered = true;
        closeSheet(el);
        el.remove();
        resolve(value);
      };
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-answer]');
        if (b) done(b.dataset.answer === 'yes');
      });
      openSheet(el, { onClose: () => done(false) });
      el.querySelector('[data-answer="yes"]').focus({ preventScroll: true });
    });
  }

  return { core, esc, api, initials, avatarColor, avatar, getMe, setMe, householdNow, relativeAgo, whenText, wallOfIso, toast, openSheet, closeSheet, confirmSheet };
})();
