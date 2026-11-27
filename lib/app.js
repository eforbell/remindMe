'use strict';

const express = require('express');
const path = require('path');

const acks = require('./acks');
const brrr = require('./brrr');
const mirror = require('./mirror');
const { createSuiteIdentity, isTokenRoute } = require('./suite-identity');
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
      if (err instanceof reminders.InputError || err instanceof acks.AckError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      // Deadlock or serialization failure: PostgreSQL rolled this request back whole; asking again is safe.
      if (err?.code === '40P01' || err?.code === '40001' || err?.code === '55P03') {
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
  // Exactly POST /api/ack is let past the origin guard (and requireMember lets it past too): Home Push's
  // notification buttons post it from the phone with no browser origin, maybe from a device not linked to anyone.
  // The guard protects requests that carry identity automatically, like a cookie; this one ignores identity and
  // needs a secret token in its body instead. It still goes through the /api JSON check below.
  app.use((req, res, next) => (isTokenRoute(req) ? next() : suite.guard(req, res, next)));
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

  // Who is asking, which decides the reminders they see (lib/reminders.js). Tailnet mode: the person their
  // household account is linked to. Local mode: the person this device says it is (X-Remind-Me-As, from the
  // "who's using this phone" choice), or null before it has said. Local mode trusts the device, as it always
  // has: this keeps each person's list their own; it isn't a security boundary.
  function viewerOf(req) {
    if (suite.tailnet) return req.familyMember.id;
    const value = String(req.get('x-remind-me-as') || '');
    return /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : null;
  }

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
        // How long the oldest due follow-up alert has waited: a stalled send queue shows here while the heartbeat
        // stays fresh. Best effort (null if it can't be read): it never makes the health check itself fail.
        follow_up_lag_s: await dispatcher.followUpLag(pool, now()).catch(() => null),
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
  // The People page's view: each person's key previews, last delivery errors and mirror state. In tailnet mode that
  // is a parent's; a kid gets what scheduling a reminder needs, who there is and whether a push can reach them.
  app.get('/api/members', route(async (req) => {
    const list = await members.list(pool);
    if (suite.tailnet && req.suiteMember?.role !== 'parent') {
      return { members: list.map(({ id, name, has_key }) => ({ id, name, has_key })), mirror_enabled: false };
    }
    return { members: list, mirror_enabled: Boolean(config.mirrorUrl) };
  }));
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
    enabled: Boolean(config.mirrorUrl), ...(await members.mirrorReport(pool, { days: req.query.days, now: now(), viewer: viewerOf(req) })),
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
  // Each sees the reminders they set or are reminded by, and those set for the whole family. One they can't
  // see is "not found" to every route here.
  app.get('/api/reminders', route(async (req) => ({
    reminders: await reminders.list(pool, { now: now(), viewer: viewerOf(req) }),
    problems: await reminders.problems(pool, { now: now(), viewer: viewerOf(req) }),
    waiting: await reminders.waiting(pool, { now: now(), viewer: viewerOf(req) }),
  })));
  app.post('/api/reminders', route(async (req, res) => {
    // In tailnet mode a reminder is from the requester's own linked person, whoever the request names.
    const body = suite.tailnet ? { ...req.body, created_by: req.familyMember.id } : req.body;
    const id = await reminders.create(pool, body, { timezone, now: now(), viewer: viewerOf(req) });
    res.status(201);
    return { id };
  }));
  app.put('/api/reminders/:id', route(async (req) => ({ id: await reminders.update(pool, idParam(req), req.body, { timezone, now: now(), viewer: viewerOf(req) }) })));
  app.delete('/api/reminders/:id', route(async (req) => { await reminders.remove(pool, idParam(req), { viewer: viewerOf(req) }); }));
  app.post('/api/reminders/:id/extend', route(async (req) => { await reminders.extend(pool, idParam(req), req.body, { viewer: viewerOf(req) }); }));
  app.post('/api/reminders/:id/dismiss-renewal', route(async (req) => { await reminders.dismissRenewal(pool, idParam(req), { viewer: viewerOf(req) }); }));
  // ── Got it and snooze (docs/plan-ack-and-snooze.md) ───────────────────────
  // By token: whoever holds a delivery's token, with no session, acting as that delivery's own member. It never
  // reads who is asking (viewerOf): in tailnet mode this route skips both identity gates.
  app.post('/api/ack', route(async (req) => {
    const { token, action, minutes, from, via } = req.body || {};
    return acks.byToken(pool, { token, action, minutes, from, via: via == null ? 'notification' : via, now: now() });
  }));
  // From the app: the delivery's own member, or (Got it only, "Mark done for Riley") whoever set the reminder.
  // Anything else is "not found", like a reminder they can't see.
  async function deliveryFor(req, { creatorMay }) {
    const viewer = viewerOf(req);
    if (viewer == null) throw new reminders.InputError('Pick who is using this phone first.', 403, 'who');
    // Only while they can still see the reminder (lib/reminders.js): someone taken off a private reminder keeps
    // no way to read its title back through an old delivery of theirs.
    const { rows } = await pool.query(
      `SELECT d.id, d.member_id, r.created_by FROM deliveries d JOIN reminders r ON r.id = d.reminder_id
        WHERE d.id = $1 AND d.alert_no = 0 AND r.status <> 'deleted' AND ${reminders.visibleSql('r', '$2')}`,
      [idParam(req), viewer],
    );
    const d = rows[0];
    if (!d || !(d.member_id === viewer || (creatorMay && d.created_by === viewer))) {
      throw new reminders.InputError('That reminder no longer exists.', 404, 'not_found');
    }
    // Checked again inside the action, under its locks (the reminder and the viewer are held), so an edit or an
    // archive that lands meanwhile is seen. Losing access is "not found"; a delivery that was stopped while
    // they could still see it answers "gone" (200), like the token route.
    const access = async (client) => {
      const { rowCount } = await client.query(
        `SELECT 1 FROM reminders r
          WHERE r.id = (SELECT reminder_id FROM deliveries WHERE id = $1) AND r.status <> 'deleted'
            AND EXISTS (SELECT 1 FROM family_members m WHERE m.id = $2 AND m.archived_at IS NULL)
            AND ${reminders.visibleSql('r', '$2')}`,
        [d.id, viewer],
      );
      if (!rowCount) throw new reminders.InputError('That reminder no longer exists.', 404, 'not_found');
      return true;
    };
    return { id: d.id, viewer, access };
  }
  app.post('/api/deliveries/:id/ack', route(async (req) => {
    const { id, viewer, access } = await deliveryFor(req, { creatorMay: true });
    return acks.ack(pool, { deliveryId: id, who: viewer, via: 'app', access, now: now() });
  }));
  app.post('/api/deliveries/:id/snooze', route(async (req) => {
    const { id, access } = await deliveryFor(req, { creatorMay: false });
    return acks.snooze(pool, { deliveryId: id, minutes: req.body?.minutes, from: req.body?.from, access, now: now() });
  }));

  app.get('/api/deliveries', route(async (req) => ({ deliveries: await reminders.recentDeliveries(pool, { limit: Number(req.query.limit) || 20, viewer: viewerOf(req) }) })));
  app.get('/api/suggestions', route(async (req) => ({ suggestions: await reminders.suggest(pool, String(req.query.q || '').slice(0, 120), { viewer: viewerOf(req) }) })));
  app.delete('/api/suggestions', route(async (req) => { await reminders.forgetSuggestion(pool, req.body?.text, { viewer: viewerOf(req) }); }));

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
