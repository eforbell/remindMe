'use strict';

// Push mirror: sends a copy of each push to a second, brrr-compatible gateway (PUSH_MIRROR_URL), so a
// self-hosted gateway can be run side by side with brrr and compared before anyone relies on it.
//
// The gateway speaks brrr's API: POST <base>/v1/send with Authorization: Bearer <secret> and the same
// JSON payload. A 200 means it handed the push to Apple; a 202 means it queued it to retry. Either way the
// response's "id" is the gateway's message id, kept on the delivery so its own delivery receipts can be
// matched up later. As with brrr keys, secrets never go into URLs, logs, or responses.

const SECRET_RE = /^[A-Za-z0-9_-]{8,200}$/;
const ID_RE = /^[A-Za-z0-9-]{8,64}$/; // the gateway's message id: a UUID in practice
const SEND_TIMEOUT_MS = 4000;

// Removes the secret from any text that came back from (or is about) the gateway, then trims it.
// Redact before truncating, so a secret cut in half by the truncation can't survive it.
function redact(text, secret, max = 300) {
  let out = String(text ?? '');
  if (secret) out = out.split(secret).join('[secret]');
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

// The gateway's base URL, or null when mirroring is off.
function mirrorUrl(value = process.env.PUSH_MIRROR_URL) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) return null;
  return url.toString().replace(/\/+$/, '');
}

function normalizeKey(input) {
  const raw = String(input || '').trim();
  if (!raw) return { error: "Paste the mirror gateway's webhook secret." };
  if (!SECRET_RE.test(raw)) return { error: 'A webhook secret is letters, digits, "_" and "-".' };
  return { value: raw };
}

class MirrorError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || null;
  }
}

// Resolves { status, id } when the gateway accepted the push (2xx); rejects with MirrorError otherwise.
async function send(base, secret, payload, { fetchImpl = fetch, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  if (!base) throw new MirrorError('No mirror gateway is configured.');
  if (!secret) throw new MirrorError('No mirror key is set for this person.');
  let res;
  try {
    res = await fetchImpl(`${base}/v1/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000}s` : (err?.cause?.code || err?.message || 'network error');
    throw new MirrorError(redact(`Could not reach the mirror gateway: ${reason}`, secret));
  }
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (res.ok) {
    // Only an id-shaped value that isn't (and doesn't contain) the secret is kept: a misbehaving gateway
    // must not be able to get the secret stored, reported or returned through this field.
    const id = typeof body?.id === 'string' && ID_RE.test(body.id) && !body.id.includes(secret) && !secret.includes(body.id) ? body.id : null;
    return { status: res.status, id };
  }
  const detail = redact(typeof body?.error === 'string' ? body.error : text, secret, 200);
  throw new MirrorError(`Mirror gateway answered ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
}

module.exports = { mirrorUrl, normalizeKey, send, redact, MirrorError, SEND_TIMEOUT_MS };
