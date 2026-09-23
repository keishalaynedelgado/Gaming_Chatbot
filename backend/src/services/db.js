'use strict';
// PostgreSQL connection + schema. Everything the app persists (sessions,
// messages, and every generated game file, every version) lives here now --
// see store.js, which is the only other module that talks to this one.
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and set it to your PostgreSQL connection string.');
  }
  pool = new Pool({ connectionString, max: 10 });
  pool.on('error', (err) => {
    // A background/idle client error (e.g. the connection dropped) must not
    // crash the whole process -- the pool recovers new clients on the next query.
    console.error('[db] unexpected error on idle client:', err.message);
  });
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Idempotent: safe to run on every startup. No migration framework -- this
// app's whole philosophy is "as little machinery as the job needs", and
// CREATE TABLE IF NOT EXISTS is genuinely enough for a schema this small.
// If the shape ever needs to change, add a new IF NOT EXISTS/ALTER step here
// rather than a separate migrations directory.
async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      phase TEXT NOT NULL DEFAULT 'none',
      summary TEXT,
      history_start INTEGER NOT NULL DEFAULT 0,
      has_game BOOLEAN NOT NULL DEFAULT FALSE,
      game_version INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, seq);

    CREATE TABLE IF NOT EXISTS game_files (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (session_id, version, path)
    );
    CREATE INDEX IF NOT EXISTS idx_game_files_lookup ON game_files (session_id, version);
  `);
}

module.exports = { query, withTransaction, migrate, getPool };
