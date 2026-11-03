# CLAUDE.md

Guidance for Claude Code in this repository. The README covers what the app does and how delivery works;
read it first.

## Shape

Node + Express + `pg`, no build step, vanilla HTML/CSS/JS. Same conventions as the other Sovereign Home
apps (`family_members`, `app_config`, relative fetch paths, `sovereign-chassis.css` + `tokens.css`).

```
server.js                 wires env → lib/app.js, starts the in-process dispatcher
lib/app.js                Express app (createApp({ pool, timezone, sendImpl, now }) for tests)
lib/dispatcher.js         record due occurrences → deliveries; claim + send + retry; prune; heartbeat
lib/reminders.js          create/update/delete/extend/list, suggestions, problems
lib/members.js            people + brrr keys (never SELECT the secret into a response)
lib/brrr.js               key normalization, payload wording, send (Bearer header)
lib/mirror.js             optional copy of each push to a second brrr-compatible gateway (PUSH_MIRROR_URL)
lib/zoned.js              wall clock ↔ instant in an IANA zone (DST rules documented there)
lib/schedule.js           server glue between rows, the shared rules, and zones
public/shared/schedule-core.js   recurrence + date math, shared by browser and server (UMD)
public/shared/quick-parse.js     deterministic quick-entry parser, shared (UMD)
scripts/dispatch.js       systemd timer entry point (one pass)
db/migrations/            numbered SQL; db/migrate.js applies them (advisory-locked)
```

## Rules

- Migrations are append-only: never edit one that has shipped; add `db/migrations/000N_*.sql`.
- Times are quarter hours only, everywhere (DB CHECK, server validation, UI).
- Wall-clock dates are `'YYYY-MM-DD'` strings end to end; `lib/db.js` stops pg from turning DATE into
  JS Dates. Never compute household dates with the device's local zone.
- The dispatcher must stay safe to run concurrently: every write is a claim (`SKIP LOCKED` or a
  conditional `UPDATE … RETURNING`). Add tests in `test/dispatcher.test.js` for any change there.
- Never put a brrr secret in a URL, log line, API response, or delivery payload. Mirror keys likewise.
- The mirror must never change a brrr delivery's status, retries or timing (see test/mirror.test.js).
- iOS wrapper: inputs ≥ 16px, no `window.prompt/alert/confirm`, keep the zoom guards in `common.js` and
  `remind-skin.css`. Check new UI at 390px wide in WebKit.
- Public repo: no real names, hostnames, or tailnet names in code, tests, or docs.

## Commands

```bash
docker compose up -d && npm run dev
TEST_DATABASE_URL=postgresql://remindme:remindme@127.0.0.1:5441/remindme_test npm test
```
