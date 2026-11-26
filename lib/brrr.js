'use strict';

// brrr.now push delivery (https://brrr.now/docs/).
//
// A member's brrr key is either a bare webhook secret (br_usr_…) or the full webhook URL from the brrr
// app. Bare secrets go in an Authorization header to /v1/send, so they never end up in a URL that might
// be logged. This app posts only to the one push service it's configured with: PUSH_BASE_URL, any
// brrr-compatible API, by default brrr itself.

const core = require('../public/shared/schedule-core');

const DEFAULT_PUSH_BASE_URL = 'https://api.brrr.now';
const SECRET_RE = /^[A-Za-z0-9_-]{8,200}$/;
const SEND_TIMEOUT_MS = 10000;
// An action token (lib/acks.js): two base64url halves. Kept here too so send() can redact tokens from error
// text without depending on the token code.
const TOKEN_ANYWHERE_RE = /[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}/g;

// The push service's base URL. A malformed value is an error, not a fallback: falling back would send a
// self-hosted service's secrets to brrr.
function pushBaseUrl(value = process.env.PUSH_BASE_URL) {
  if (value === undefined || value === null || value === '') return DEFAULT_PUSH_BASE_URL;
  const raw = String(value).trim();
  let url;
  try { url = new URL(raw); } catch { throw new BrrrError('PUSH_BASE_URL is not a valid URL'); }
  // Checks raw, not url.search and url.hash: those are empty for a URL ending in a bare "?" or "#".
  if (!['http:', 'https:'].includes(url.protocol) || /[?#]/.test(raw) || url.username || url.password) {
    throw new BrrrError('PUSH_BASE_URL must be a plain http(s) URL');
  }
  return url.href.replace(/\/+$/, '');
}

// Normalizes what a person pasted. Returns { value } or { error }.
function normalizeKey(input) {
  const raw = String(input || '').trim();
  if (!raw) return { error: 'Paste the webhook secret or URL from the brrr app.' };
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { return { error: 'That URL is not valid.' }; }
    let prefix;
    try { prefix = `${pushBaseUrl()}/v1/`; } catch (err) { return { error: err.message }; }
    if (!url.href.startsWith(prefix)) return { error: 'That URL is for a different push service. Paste the secret or URL from the current one.' };
    const secret = url.href.slice(prefix.length).replace(/\/+$/, '');
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
  if (late) parts.push(`Was due ${dayPrefix(wallDate, today)}${when}`);
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

function dayPrefix(wallDate, today) {
  if (wallDate === today) return '';
  return `${core.formatDateFriendly(wallDate, today).replace(/^(Yesterday|Tomorrow)$/, (w) => w.toLowerCase())} `;
}

// A follow-up alert ("Until acknowledged" re-alert, or a snooze): the delivery's title, thread, level and icon,
// with its own message and expiry.
//   Still waiting · was due 9:00 AM · alert 3
//   Snoozed · was due 9:00 AM
function buildFollowUpPayload(base, { kind, alertNo, wallTime, wallDate, today, expiresAt }) {
  const due = `was due ${dayPrefix(wallDate, today)}${core.formatTime12(wallTime)}`;
  const payload = {
    title: base.title,
    message: kind === 'snooze' ? `Snoozed · ${due}` : `Still waiting · ${due} · alert ${alertNo}`,
    thread_id: base.thread_id,
    interruption_level: base.interruption_level,
  };
  if (base.open_url) payload.open_url = base.open_url;
  if (expiresAt) payload.expiration_date = new Date(expiresAt).toISOString();
  if (base.icon_url) payload.icon_url = base.icon_url;
  return payload;
}

class BrrrError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || null;
  }
}

// Sends one push. Resolves { status } on a 2xx, rejects with BrrrError otherwise (no secret in it).
// idempotencyKey: the same key on a retry lets a gateway that honors it (Home Push) answer "already sent"
// instead of pushing again, when an earlier attempt got through but its answer never reached us (a
// timeout). brrr ignores the header, so there a timed-out send can still arrive twice.
async function send(secret, payload, { fetchImpl = fetch, timeoutMs = SEND_TIMEOUT_MS, idempotencyKey = null } = {}) {
  if (!secret) throw new BrrrError('No brrr key is set for this person.');
  if (!SECRET_RE.test(secret)) throw new BrrrError('This person’s saved key is not a valid secret. Save it again.');
  const base = pushBaseUrl();
  let res;
  try {
    res = await fetchImpl(`${base}/v1/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000}s` : (err?.cause?.code || err?.message || 'network error');
    throw new BrrrError(`Could not reach brrr: ${reason}`);
  }
  if (res.ok) return { status: res.status };
  let detail = '';
  try { detail = await res.text(); } catch { /* ignore */ }
  // Redact before truncating, so a secret cut in half by the truncation can't survive it. Action tokens in the
  // payload too: a gateway that echoes the payload in an error would otherwise get a working token stored on
  // the delivery and the member's channel, which the People page shows.
  if (secret) detail = detail.split(secret).join('[secret]');
  for (const token of new Set(JSON.stringify(payload ?? null).match(TOKEN_ANYWHERE_RE) || [])) {
    detail = detail.split(token).join('[token]');
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 200);
  const hint = res.status === 401 || res.status === 403 || res.status === 404 ? ' (check this person’s brrr key)' : '';
  throw new BrrrError(`brrr answered ${res.status}${hint}${detail ? `: ${detail}` : ''}`, res.status);
}

module.exports = { pushBaseUrl, normalizeKey, maskKey, iconUrl, buildPayload, buildFollowUpPayload, send, BrrrError };
