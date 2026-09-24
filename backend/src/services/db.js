'use strict';
// PostgreSQL connection + schema. Chat sessions and messages live here --
// see store.js, which is the only other module that talks to this one.
// Generated game FILES (HTML/CSS/JS/assets) deliberately do NOT: storing
// full source as database rows was unnecessary overhead for something a
// filesystem already does well, so game files live under projects/<id>/
// on disk instead (see store.js's saveProject/readProjectFiles/
// readFrontendFile). The database only ever keeps lightweight references to
// them -- sessions.has_game and sessions.game_version.
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
// CREATE TABLE IF NOT EXISTS (plus ADD COLUMN IF NOT EXISTS for existing
// tables) is genuinely enough for a schema this small. If the shape ever
// needs to change, add a new IF NOT EXISTS/ALTER step here rather than a
// separate migrations directory.
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

    -- title/title_auto: the sidebar's conversation title now lives here (the
    -- database is authoritative for it), not only in each browser's
    -- localStorage -- so it survives a cleared cache or a different device.
    -- deleted_at: soft delete. A "deleted" chat is never actually removed
    -- (that's what makes restore possible) -- it's just excluded from the
    -- normal sidebar listing until restored (deleted_at set back to NULL).
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title_auto BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_sessions_listing ON sessions (deleted_at, updated_at DESC);

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
  `);
  // game_files no longer exists on a fresh install (see the module comment
  // above) -- an install that predates this change may still have the old
  // table sitting around with its content already migrated to disk; it's
  // simply unused now, never created for a new database.
}

module.exports = { query, withTransaction, migrate, getPool };
