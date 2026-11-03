#!/usr/bin/env node
'use strict';

// One dispatcher pass, for the systemd timer (remind-me-dispatch.timer, every minute).
// Records reminders that are due, sends what is pending, retries what failed. Exit code 1 on failure,
// so a broken dispatcher shows up as a failed unit in Home Base.

require('dotenv').config();

const { createPool } = require('../lib/db');
const dispatcher = require('../lib/dispatcher');

// systemd stops this unit with SIGTERM (e.g. at shutdown). Without a handler Node would exit at once, which
// could fall between brrr accepting a push and the row being marked sent. Instead: claim no new batch,
// let the one in flight finish (bounded by the send timeout), then exit normally.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (!stopping) console.log(`${signal}: finishing the batch in flight, then exiting`);
    stopping = true;
  });
}

async function main() {
  const pool = createPool();
  try {
    const summary = await dispatcher.runPass(pool, { source: 'timer', shouldStop: () => stopping });
    if (summary.reminders || summary.sent || summary.retry || summary.failed || summary.missed || summary.pruned) {
      console.log(JSON.stringify(summary));
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`dispatch failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
