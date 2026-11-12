'use strict';

const express = require('express');
const path = require('path');

const brrr = require('./brrr');
const mirror = require('./mirror');
const { createSuiteIdentity } = require('./suite-identity');
const { withTransaction } = require('./db');
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
      // Deadlock or serialization failure: PostgreSQL rolled this request back whole; asking again is safe.
      if (err?.code === '40P01' || err?.code === '40001') {
        res.status(409).json({ error: 'Something else changed this at the same moment. Try again.', code: 'busy' });
        return;
      }
      console.error(`[api] ${req.method} ${req.path}: ${err.stack || err.message}`);
      res.status(500).json({ error: 'Something went wrong on the server. Try again in a moment.', code: 'server_error' });
    }
  };
}

function createApp({ pool, timezone, env = process.env, sendImpl = brrr.send, mirrorImpl = mirror.send, now = () => new Date(), suiteReader }) {
  if (!zoned.isValidTimeZone(timezone)) throw new Error(`Unknown time zone: ${timezone}`);
  const app = express();
  const config = dispatcher.defaultConfig(env);
  // Which sign-in Remind Me trusts (lib/suite-identity.js); a bad configuration refuses to start. In tailnet mode
  // the person a household member is: the live row a parent linked them to.
  const suite = createSuiteIdentity(env, {
    reader: suiteReader,
    findLinked: async (memberId) => {
      const { rows } = await pool.query('SELECT id, name FROM family_members WHERE suite_member_id = $1 AND archived_at IS NULL', [memberId]);
      return rows[0] || null;
    },
  });
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  // In tailnet mode every write must be JSON from the app's own origin, checked before anything reads the request,
  // and every request needs a household member a parent has linked to one of Remind Me's people. Local mode: both
  // pass through, and the check below is the app's own.
  app.use(suite.guard);
  app.use(suite.requireMember);
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
  // The link page is served by its route (/link), which checks the directory's role; its file is not a static page.
  app.get('/link.html', (_req, res) => res.redirect(303, 'link'));
  app.get('/link', (req, res, next) => {
    if (!suite.tailnet) return next();
    res.set('Cache-Control', 'no-store');
    if (req.suiteMember?.role !== 'parent') return res.status(403).type('text').send('Only a parent can link household members.');
    return page('link.html')(req, res);
  });
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

  // Who the pages are showing. In tailnet mode it's the linked person, with the directory's role, and the pages
  // skip their "who is using this phone" choice; in local mode there's nobody, and the device chooses as before.
  app.get('/api/me', route(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!suite.tailnet) return { mode: 'local', member: null };
    const { id, name } = req.familyMember;
    return { mode: 'tailnet', member: { id, name, role: req.suiteMember.role === 'parent' ? 'parent' : 'kid' } };
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
  app.get('/api/members', route(async () => ({ members: await members.list(pool), mirror_enabled: Boolean(config.mirrorUrl) })));
  app.post('/api/members', route(async (req, res) => {
    const m = await members.create(pool, req.body);
    res.status(201);
    return { member: m };
  }));
  app.patch('/api/members/:id', route(async (req) => { await members.rename(pool, idParam(req), req.body); }));
  app.delete('/api/members/:id', route(async (req) => members.archive(pool, idParam(req), { force: req.query.force === '1' })));
  app.post('/api/members/:id/brrr/check', route(async (req) => {
    const id = idParam(req);
    const { rows } = await pool.query("SELECT c.target_secret FROM family_members m LEFT JOIN member_notification_channels c ON c.member_id = m.id WHERE m.id = $1 AND m.archived_at IS NULL", [id]);
    if (!rows.length) throw new reminders.InputError('That person is not in the household.', 404, 'not_found');
    return require('./push-check').checkPushSecret(rows[0]?.target_secret);
  }));
  app.put('/api/members/:id/brrr', route(async (req) => members.setKey(pool, idParam(req), req.body)));
  app.delete('/api/members/:id/brrr', route(async (req) => { await members.clearKey(pool, idParam(req)); }));
  app.post('/api/members/:id/brrr/test', route(async (req) => members.test(pool, idParam(req), req.body, {
    sendImpl, icon: config.icon, openUrl: config.appPublicUrl,
  })));
  app.put('/api/members/:id/mirror', route(async (req) => members.setMirrorKey(pool, idParam(req), req.body)));
  app.delete('/api/members/:id/mirror', route(async (req) => { await members.clearMirrorKey(pool, idParam(req)); }));
  app.post('/api/members/:id/mirror/test', route(async (req) => members.testMirror(pool, idParam(req), req.body, {
    base: config.mirrorUrl, mirrorImpl, icon: config.icon, openUrl: config.appPublicUrl,
  })));
  app.get('/api/mirror/report', route(async (req) => ({
    enabled: Boolean(config.mirrorUrl), ...(await members.mirrorReport(pool, { days: req.query.days, now: now() })),
  })));

  // ── Linking household members (tailnet mode) ─────────────────────────────
  // A parent, as Home Base's directory says now, links each person here to the household member they are. The
  // directory's role is checked on every request. People here have no role of their own, so any account may take
  // any live person's row.
  function requireSuiteParent(req, res, next) {
    if (!suite.tailnet) return res.status(404).json({ error: 'Not found.', code: 'not_found' });
    if (req.suiteMember?.role !== 'parent') {
      return res.status(403).set('Cache-Control', 'no-store').json({ error: 'Only a parent can link household members.', code: 'parent_required' });
    }
    return next();
  }
  function directoryNow() {
    const directory = suite.directory();
    if (!directory) throw new reminders.InputError('The household directory is unavailable. Try again in a minute.', 503, 'directory');
    return directory;
  }
  app.get('/api/suite/links', requireSuiteParent, route(async (req, res) => {
    const directory = directoryNow();
    const { rows } = await pool.query('SELECT id, name, suite_member_id FROM family_members WHERE archived_at IS NULL ORDER BY id');
    res.set('Cache-Control', 'no-store');
    return { you: req.suiteMember.memberId, directory, members: rows };
  }));
  app.put('/api/suite/links/:id', requireSuiteParent, route(async (req) => {
    const id = /^[1-9][0-9]{0,9}$/.test(req.params.id) ? Number(req.params.id) : null;
    const notFound = () => new reminders.InputError('That person is not in the household.', 404, 'not_found');
    if (!id) throw notFound();
    const wanted = req.body?.suite_member_id;
    if (wanted !== null && (typeof wanted !== 'string' || !directoryNow().some((member) => member.memberId === wanted))) {
      throw new reminders.InputError('Pick a household member who has access to Remind Me.', 400, 'unknown_member');
    }
    let row;
    try {
      row = await withTransaction(pool, async (client) => {
        // Someone who has been removed keeps nobody's account: theirs is free to link again.
        if (wanted !== null) await client.query('UPDATE family_members SET suite_member_id = NULL WHERE suite_member_id = $1 AND archived_at IS NOT NULL', [wanted]);
        // Only a live person takes a link: one removed can't be linked.
        const { rows } = await client.query(
          'UPDATE family_members SET suite_member_id = $1 WHERE id = $2 AND archived_at IS NULL RETURNING id, name, suite_member_id',
          [wanted, id],
        );
        return rows[0];
      });
    } catch (err) {
      if (err?.code === '23505') throw new reminders.InputError('That household member is already linked to someone else.', 409, 'already_linked');
      throw err;
    }
    if (!row) throw notFound();
    console.log(`[suite-link] ${req.suiteMember.memberId} ${wanted ? `linked person ${id} to ${wanted}` : `unlinked person ${id}`}`);
    return row;
  }));

  // ── Reminders ────────────────────────────────────────────────────────────
  app.get('/api/reminders', route(async () => ({
    reminders: await reminders.list(pool, { now: now() }),
    problems: await reminders.problems(pool, { now: now() }),
  })));
  app.post('/api/reminders', route(async (req, res) => {
    // In tailnet mode a reminder is from the requester's own linked person, whoever the request names.
    const body = suite.tailnet ? { ...req.body, created_by: req.familyMember.id } : req.body;
    const id = await reminders.create(pool, body, { timezone, now: now() });
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
