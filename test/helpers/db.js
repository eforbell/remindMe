'use strict';

// Database tests run against TEST_DATABASE_URL (a throwaway database: its public schema is dropped).
// Without it they are skipped. Example:
//   docker compose up -d && TEST_DATABASE_URL=postgresql://remindme:remindme@127.0.0.1:5441/remindme_test npm test

const { Client } = require('pg');
const { createPool } = require('../../lib/db');
const { migrate } = require('../../db/migrate');

const URL = process.env.TEST_DATABASE_URL;

async function ensureDatabase(url) {
  const target = new globalThis.URL(url);
  const name = target.pathname.slice(1);
  const admin = new globalThis.URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await client.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } finally {
    await client.end();
  }
}

// A fresh, migrated database for one test file.
async function freshPool() {
  await ensureDatabase(URL);
  const pool = createPool(URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  return pool;
}

async function reset(pool) {
  await pool.query(`TRUNCATE deliveries, reminder_recipients, reminders, suggestions, member_notification_channels, member_mirror_channels,
    family_members, app_config RESTART IDENTITY CASCADE`);
}

module.exports = { URL, freshPool, reset, skip: !URL && 'set TEST_DATABASE_URL to run database tests' };
