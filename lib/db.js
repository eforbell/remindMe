'use strict';

const { Pool, types } = require('pg');

// DATE columns stay 'YYYY-MM-DD' strings: they are household wall-clock dates, and turning them into
// JS Dates would shift them by the server's zone.
types.setTypeParser(1082, (value) => value);

function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString, max: 8 });
  // An idle client losing its connection (e.g. PostgreSQL restarting) must not crash the process.
  pool.on('error', (err) => console.error(`[db] idle client error: ${err.message}`));
  return pool;
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPool, withTransaction };
