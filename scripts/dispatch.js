#!/usr/bin/env node
'use strict';

// One dispatcher pass, for the systemd timer (remind-me-dispatch.timer, every minute).
// Records reminders that are due, sends what is pending, retries what failed. Exit code 1 on failure,
// so a broken dispatcher shows up as a failed unit in Home Base.

require('dotenv').config();

const { createPool } = require('../lib/db');
const dispatcher = require('../lib/dispatcher');

async function main() {
  const pool = createPool();
  try {
    const summary = await dispatcher.runPass(pool, { source: 'timer' });
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
