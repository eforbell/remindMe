'use strict';

require('dotenv').config();

const { createApp } = require('./lib/app');
const { createPool } = require('./lib/db');
const dispatcher = require('./lib/dispatcher');
const { migrate } = require('./db/migrate');

const PORT = Number(process.env.PORT || 3013);
// Loopback unless HOST says otherwise: under Home Base only nginx should reach the app.
const HOST = process.env.HOST || '127.0.0.1';
const TIMEZONE = process.env.HOUSEHOLD_TIMEZONE || 'America/New_York';
// The web process also runs the dispatcher every minute, as a second scheduler beside the systemd
// timer. Both claim rows, so running both never double-sends. Set IN_PROCESS_DISPATCH=false to stop it.
const IN_PROCESS_DISPATCH = String(process.env.IN_PROCESS_DISPATCH || 'true').toLowerCase() !== 'false';

async function main() {
  const pool = createPool();
  if (String(process.env.MIGRATE_ON_START || 'true').toLowerCase() !== 'false') {
    await migrate(pool, { log: console.log });
  }
  const app = createApp({ pool, timezone: TIMEZONE });
  const server = app.listen(PORT, HOST, () => {
    console.log(`remind-me listening on http://${HOST}:${PORT} (household time zone ${TIMEZONE})`);
  });
  const ticker = IN_PROCESS_DISPATCH ? dispatcher.startTicker(pool) : null;

  const shutdown = (signal) => {
    console.log(`${signal}: shutting down`);
    ticker?.stop();
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
