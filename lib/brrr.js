'use strict';

// brrr.now push delivery (https://brrr.now/docs/).
//
// A member's brrr key is either a bare webhook secret (br_usr_…) or the full webhook URL from the brrr
// app. Bare secrets go in an Authorization header to /v1/send, so they never end up in a URL that might
// be logged. Only https://api.brrr.now/ URLs are accepted: this app never posts anywhere else.

const core = require('../public/shared/schedule-core');

const BRRR_API = 'https://api.brrr.now/v1/';
const SECRET_RE = /^[A-Za-z0-9_-]{8,200}$/;
const SEND_TIMEOUT_MS = 10000;

// Normalizes what a person pasted. Returns { value } or { error }.
function normalizeKey(input) {
  const raw = String(input || '').trim();
  if (!raw) return { error: 'Paste the webhook secret or URL from the brrr app.' };
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { return { error: 'That URL is not valid.' }; }
    if (url.protocol !== 'https:' || url.hostname !== 'api.brrr.now' || !url.pathname.startsWith('/v1/')) {
      return { error: 'Only https://api.brrr.now/v1/… webhook URLs are accepted.' };
    }
    const secret = url.pathname.slice('/v1/'.length).replace(/\/+$/, '');
    if (!SECRET_RE.test(secret) || secret === 'send' || url.search || url.hash) return { error: 'That brrr URL has no webhook secret in it.' };
    return { value: secret };
  }
  if (!SECRET_RE.test(raw)) return { error: 'A brrr secret is letters, digits, "_" and "-" (it usually starts with br_usr_).' };
  return { value: raw };
}

// "••••a1b2", never more than the last four characters.
function maskKey(secret) {
  const raw = String(secret || '');
  if (!raw) return null;
  if (raw.length <= 8) return '••••';
  return `••••${raw.slice(-4)}`;
}

function iconUrl(value = process.env.BRRR_ICON_URL) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? raw : null;
  } catch {
    return null;
  }
}

// The push for one delivery. Wording is deterministic; the reminder text is the title.
function buildPayload({ text, level, wallTime, today, wallDate, late, fromName, isLast, threadId, openUrl, expiresAt, icon }) {
  const parts = [];
  const when = core.formatTime12(wallTime);
  if (late) {
    const day = wallDate === today ? '' : `${core.formatDateFriendly(wallDate, today).replace(/^(Yesterday|Tomorrow)$/, (w) => w.toLowerCase())} `;
    parts.push(`Was due ${day}${when}`);
  }
  else parts.push(when);
  if (fromName) parts.push(`from ${fromName}`);
  let message = parts.join(' · ');
  if (isLast) message += ' · Last one in this series';

  const payload = {
    title: text,
    message,
    thread_id: threadId,
    interruption_level: core.LEVEL_VALUES.includes(level) ? level : 'active',
  };
  if (openUrl) payload.open_url = openUrl;
  if (expiresAt) payload.expiration_date = new Date(expiresAt).toISOString();
  if (icon) payload.icon_url = icon;
  return payload;
}

class BrrrError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || null;
  }
}

// Sends one push. Resolves { status } on a 2xx, rejects with BrrrError otherwise (no secret in it).
async function send(secret, payload, { fetchImpl = fetch, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  if (!secret) throw new BrrrError('No brrr key is set for this person.');
  let res;
  try {
    res = await fetchImpl(`${BRRR_API}send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000}s` : (err?.cause?.code || err?.message || 'network error');
    throw new BrrrError(`Could not reach brrr: ${reason}`);
  }
  if (res.ok) return { status: res.status };
  let detail = '';
  try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
  if (secret && detail.includes(secret)) detail = detail.split(secret).join('[secret]');
  const hint = res.status === 401 || res.status === 403 || res.status === 404 ? ' (check this person’s brrr key)' : '';
  throw new BrrrError(`brrr answered ${res.status}${hint}${detail ? `: ${detail}` : ''}`, res.status);
}

module.exports = { normalizeKey, maskKey, iconUrl, buildPayload, send, BrrrError, BRRR_API };
