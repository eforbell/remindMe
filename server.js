'use strict';

require('dotenv').config();

const { createApp } = require('./lib/app');
const { createPool } = require('./lib/db');
const dispatcher = require('./lib/dispatcher');
const { describe: describeListen, listen } = require('./lib/listen');
const { migrate } = require('./db/migrate');

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
  // Under Home Base, its own socket (SOVEREIGN_LISTEN); otherwise loopback, HOST to override (lib/listen.js).
  const server = listen(app, { defaultPort: 3013 }, (target) => {
    console.log(`remind-me listening on ${describeListen(target)} (household time zone ${TIMEZONE})`);
  });
  const ticker = IN_PROCESS_DISPATCH ? dispatcher.startTicker(pool) : null;

  const shutdown = async (signal) => {
    console.log(`${signal}: shutting down`);
    setTimeout(() => process.exit(0), 50000).unref(); // a pass is budgeted 45s
    // Stop taking requests and let the ones in progress finish, and let a dispatcher pass finish too.
    const drained = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections?.();
    await Promise.all([drained, ticker?.stop()]);
    await pool.end().catch(() => {});
    process.exit(0);
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
