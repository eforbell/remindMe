'use strict';

const express = require('express');
const path = require('path');

const brrr = require('./brrr');
const dispatcher = require('./dispatcher');
const members = require('./members');
const reminders = require('./reminders');
const zoned = require('./zoned');
const core = require('../public/shared/schedule-core');
const pkg = require('../package.json');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STALE_DISPATCH_MS = 3 * 60 * 1000;

const DEFAULT_FONT_SANS = 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap';
const DEFAULT_FONT_MONO = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap';

function fontsCss(env = process.env) {
  const source = String(env.SOVEREIGN_FONT_SOURCE || 'google').trim().toLowerCase();
  if (source === 'off') return '/* Sovereign fonts disabled via SOVEREIGN_FONT_SOURCE=off */\n';
  const local = source === 'local';
  const sans = (local ? env.SOVEREIGN_FONT_SANS_CSS_URL_LOCAL : env.SOVEREIGN_FONT_SANS_CSS_URL) || DEFAULT_FONT_SANS;
  const mono = (local ? env.SOVEREIGN_FONT_MONO_CSS_URL_LOCAL : env.SOVEREIGN_FONT_MONO_CSS_URL) || DEFAULT_FONT_MONO;
  const safe = (u) => String(u).replace(/['\\\n\r]/g, '');
  return `/* Generated from environment */\n@import url('${safe(sans)}');\n@import url('${safe(mono)}');\n`;
}

function idParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new reminders.InputError('Not found.', 404, 'not_found');
  return id;
}

// Wraps an async handler: InputError becomes its status and message; anything else is a 500 with a
// generic message (details go to the log, never to the client).
function route(fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      if (err instanceof reminders.InputError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      console.error(`[api] ${req.method} ${req.path}: ${err.stack || err.message}`);
      res.status(500).json({ error: 'Something went wrong on the server. Try again in a moment.', code: 'server_error' });
    }
  };
}

function createApp({ pool, timezone, env = process.env, sendImpl = brrr.send, now = () => new Date() }) {
  if (!zoned.isValidTimeZone(timezone)) throw new Error(`Unknown time zone: ${timezone}`);
  const app = express();
  const config = dispatcher.defaultConfig(env);
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  // Changes need a JSON content type (which a cross-site form cannot send without a CORS preflight this
  // app never answers) and must not come from another site.
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        res.status(403).json({ error: 'Cross-site requests are not allowed.', code: 'cross_site' });
        return;
      }
      if (req.method !== 'DELETE' && !req.is('application/json')) {
        res.status(415).json({ error: 'Send JSON.', code: 'unsupported_media_type' });
        return;
      }
    }
    next();
  });

  async function needsSetup() {
    return (await members.count(pool)) === 0;
  }

  // ── Pages ────────────────────────────────────────────────────────────────
  const page = (file) => (_req, res) => res.sendFile(path.join(PUBLIC_DIR, file));
  app.get(['/', '/index.html'], async (req, res, next) => {
    try {
      if (await needsSetup()) return res.redirect('setup');
      return page('index.html')(req, res);
    } catch (err) { return next(err); }
  });
  app.get(['/setup', '/setup.html'], async (req, res, next) => {
    try {
      if (!(await needsSetup())) return res.redirect('./');
      return page('setup.html')(req, res);
    } catch (err) { return next(err); }
  });
  app.get(['/people', '/people.html'], page('people.html'));
  app.get('/sovereign-fonts.css', (_req, res) => {
    res.set('Content-Type', 'text/css; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(fontsCss(env));
  });
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '5m' }));

  // ── Health and setup ─────────────────────────────────────────────────────
  app.get('/api/health', async (_req, res) => {
    try {
      const last = await dispatcher.lastRun(pool);
      const age = last ? now() - new Date(last.at) : null;
      res.json({
        status: 'ok',
        app: 'remind-me',
        version: pkg.version,
        dispatcher: { last_run_at: last?.at || null, last_source: last?.source || null, stale: age == null || age > STALE_DISPATCH_MS },
      });
    } catch (err) {
      console.error(`[health] ${err.message}`);
      res.status(503).json({ status: 'error', app: 'remind-me', error: 'database unreachable' });
    }
  });

  app.get('/api/bootstrap', route(async () => {
    const setup = await needsSetup();
    return {
      status: setup ? 'needs_setup' : 'ready',
      app: 'remind-me',
      household_initialized: !setup,
      bootstrap: { needs_household: setup, ready: !setup },
    };
  }));

  app.post('/api/bootstrap/household', route(async (req, res) => {
    const created = await members.bootstrap(pool, req.body);
    res.status(201);
    return { ok: true, members: created };
  }));

  app.get('/api/config', route(async () => {
    const wall = zoned.toWall(now(), timezone);
    return {
      timezone,
      today: wall.date,
      now_time: wall.time,
      levels: core.LEVELS,
      default_level: core.DEFAULT_LEVEL,
      default_counts: core.DEFAULT_COUNTS,
      give_up_hours: config.giveUpMs / 3600000,
    };
  }));

  // ── People ───────────────────────────────────────────────────────────────
  app.get('/api/members', route(async () => ({ members: await members.list(pool) })));
  app.post('/api/members', route(async (req, res) => {
    const m = await members.create(pool, req.body);
    res.status(201);
    return { member: m };
  }));
  app.patch('/api/members/:id', route(async (req) => { await members.rename(pool, idParam(req), req.body); }));
  app.delete('/api/members/:id', route(async (req) => members.archive(pool, idParam(req), { force: req.query.force === '1' })));
  app.put('/api/members/:id/brrr', route(async (req) => members.setKey(pool, idParam(req), req.body)));
  app.delete('/api/members/:id/brrr', route(async (req) => { await members.clearKey(pool, idParam(req)); }));
  app.post('/api/members/:id/brrr/test', route(async (req) => members.test(pool, idParam(req), req.body, {
    sendImpl, icon: config.icon, openUrl: config.appPublicUrl,
  })));

  // ── Reminders ────────────────────────────────────────────────────────────
  app.get('/api/reminders', route(async () => ({
    reminders: await reminders.list(pool, { now: now() }),
    problems: await reminders.problems(pool, { now: now() }),
  })));
  app.post('/api/reminders', route(async (req, res) => {
    const id = await reminders.create(pool, req.body, { timezone, now: now() });
    res.status(201);
    return { id };
  }));
  app.put('/api/reminders/:id', route(async (req) => ({ id: await reminders.update(pool, idParam(req), req.body, { timezone, now: now() }) })));
  app.delete('/api/reminders/:id', route(async (req) => { await reminders.remove(pool, idParam(req)); }));
  app.post('/api/reminders/:id/extend', route(async (req) => { await reminders.extend(pool, idParam(req), req.body); }));
  app.post('/api/reminders/:id/dismiss-renewal', route(async (req) => { await reminders.dismissRenewal(pool, idParam(req)); }));
  app.get('/api/deliveries', route(async (req) => ({ deliveries: await reminders.recentDeliveries(pool, { limit: Number(req.query.limit) || 20 }) })));
  app.get('/api/suggestions', route(async (req) => ({ suggestions: await reminders.suggest(pool, String(req.query.q || '').slice(0, 120)) })));
  app.delete('/api/suggestions', route(async (req) => { await reminders.forgetSuggestion(pool, req.body?.text); }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.', code: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request was not valid JSON.', code: 'bad_json' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.', code: 'too_large' });
    console.error(`[http] ${req.method} ${req.path}: ${err?.stack || err}`);
    return res.status(500).json({ error: 'Something went wrong on the server.', code: 'server_error' });
  });
  return app;
}

module.exports = { createApp, fontsCss };
