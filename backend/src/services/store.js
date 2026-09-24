'use strict';
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const { isSafePath } = require('./qa');

// Generated game files (HTML/CSS/JS/assets) live on disk, one folder per
// version, never in the database -- see db.js's module comment for why.
// projects/ is a sibling of frontend/ and backend/, three levels up from
// here (services -> src -> backend -> root) -- unless overridden (the test
// suite points this at its own directory via PROJECTS_DIR, precisely so it
// can never share real data with -- or get wiped out alongside -- dev's own
// projects/, the way chat data already can't via separate databases).
const PROJECTS_ROOT = process.env.PROJECTS_DIR || path.join(__dirname, '..', '..', '..', 'projects');

function versionDir(id, version) {
  return path.join(PROJECTS_ROOT, id, `v${version}`);
}

const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
// One process, one source of truth: this cache holds the SAME state object a
// caller mutates in place across a turn (messages pushed, summary set, ...),
// so save()/saveProject() never need to re-cache it themselves -- it's
// already the cached reference. Avoids a round trip to Postgres on every
// single request (a live game preview alone is several file requests, each
// starting with a lookup of this session's row).
const cache = new Map();

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function fresh() {
  return {
    messages: [], // [{role, content, createdAt}] shown in the UI and sent to agents
    phase: 'none', // none | discover | plan | built
    summary: null, // latest Game Design Summary text
    historyStart: 0, // messages before this index belong to an earlier game
    hasGame: false,
    gameVersion: 0,
    title: null, // sidebar title -- the database is authoritative for this, not localStorage
    titleAuto: true, // false once the user has manually renamed it
  };
}

// Reads a session's full state from Postgres. A never-seen id is NOT written
// to the database here -- exactly like the old file-based store never
// created a directory for one -- it just returns fresh() in memory. Only
// save()/saveProject() actually persist anything. Deliberately ignores
// deleted_at: a soft-deleted session must still open and work normally if
// something is already pointed at it (e.g. an open game tab) -- soft delete
// only ever affects whether listSessions() surfaces it, never direct access.
async function get(id) {
  if (cache.has(id)) return cache.get(id);
  let state = fresh();
  const { rows } = await db.query(
    'SELECT phase, summary, history_start, has_game, game_version, title, title_auto FROM sessions WHERE id = $1',
    [id],
  );
  if (rows.length) {
    const row = rows[0];
    const { rows: msgRows } = await db.query(
      'SELECT role, content, created_at FROM messages WHERE session_id = $1 ORDER BY seq',
      [id],
    );
    state = {
      messages: msgRows.map((m) => ({ role: m.role, content: m.content, createdAt: m.created_at.toISOString() })),
      phase: row.phase,
      summary: row.summary,
      historyStart: row.history_start,
      hasGame: row.has_game,
      gameVersion: row.game_version,
      title: row.title,
      titleAuto: row.title_auto,
    };
  }
  cache.set(id, state);
  return state;
}

function upsertSessionSql(client, id, state) {
  return client.query(
    `INSERT INTO sessions (id, phase, summary, history_start, has_game, game_version, title, title_auto, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (id) DO UPDATE SET
       phase = EXCLUDED.phase, summary = EXCLUDED.summary, history_start = EXCLUDED.history_start,
       has_game = EXCLUDED.has_game, game_version = EXCLUDED.game_version,
       title = EXCLUDED.title, title_auto = EXCLUDED.title_auto, updated_at = now()`,
    [id, state.phase, state.summary, state.historyStart, state.hasGame, state.gameVersion, state.title, state.titleAuto],
  );
}

// Builds a "($1,$2,$3,$4), ($5,$6,$7,$8), ..." VALUES clause + flat params
// array for a bulk insert -- avoids a network round trip per row, which
// matters once a conversation or a project has more than a couple of rows.
function bulkValues(rows, columnsPerRow) {
  const placeholders = [];
  const params = [];
  rows.forEach((row, i) => {
    const base = i * columnsPerRow;
    placeholders.push(`(${row.map((_, j) => `$${base + j + 1}`).join(', ')})`);
    params.push(...row);
  });
  return { placeholders: placeholders.join(', '), params };
}

// Persists the whole session (messages included) as it stands right now --
// state.messages is always the FULL current array, so messages are replaced
// wholesale each time, the same "overwrite the whole thing" semantics the
// old state.json had.
async function save(id, state) {
  await db.withTransaction(async (client) => {
    await upsertSessionSql(client, id, state);
    await client.query('DELETE FROM messages WHERE session_id = $1', [id]);
    if (state.messages.length) {
      // m.createdAt is set by the caller (orchestrator.js, at the moment each
      // message is actually created); this fallback only covers a message
      // that somehow arrives without one, so a timestamp is never lost.
      const rows = state.messages.map((m, i) => [id, i, m.role, m.content, m.createdAt || new Date().toISOString()]);
      const { placeholders, params } = bulkValues(rows, 5);
      await client.query(`INSERT INTO messages (session_id, seq, role, content, created_at) VALUES ${placeholders}`, params);
    }
  });
  cache.set(id, state);
}

// Writes the project as a brand new version directory -- every earlier
// version stays on disk untouched, so downloads/rollback always have the
// exact file set that version was actually built with. `files` must be the
// COMPLETE project (the caller merges the Builder's partial output onto the
// previous version first). Every path is re-validated here, independently
// of whatever already filtered it upstream, as the last line of defense
// before anything is written -- this is model-written content landing on
// disk under a path the model itself chose.
//
// Only has_game/game_version -- a pointer to where the files live, not the
// files themselves -- goes into Postgres, in the same call/transaction as
// everything else in `state`, so the database and disk can never disagree
// about which version is current.
async function saveProject(id, state, files) {
  state.gameVersion += 1;
  state.hasGame = true;
  const version = state.gameVersion;
  const base = versionDir(id, version);
  for (const [rel, content] of Object.entries(files)) {
    if (!isSafePath(rel)) continue;
    const file = path.join(base, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  await db.withTransaction((client) => upsertSessionSql(client, id, state));
  cache.set(id, state);
  return version;
}

// Reads every file of the current version back into a flat {path: content}
// map -- used as context when the Builder improves an existing project, and
// to build the downloadable zip.
async function readProjectFiles(id, state) {
  if (!state.hasGame) return null;
  const base = versionDir(id, state.gameVersion);
  const files = {};
  const walk = (dirPath, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dirPath, entry.name), rel);
      else files[rel] = fs.readFileSync(path.join(dirPath, entry.name), 'utf8');
    }
  };
  walk(base, '');
  return files;
}

// Reads one file from the current version's frontend/ tree, for serving the
// live preview. Returns a Buffer, or null if there's no game yet or the
// file doesn't exist.
async function readFrontendFile(id, state, subPath) {
  if (!state.hasGame) return null;
  const rel = `frontend/${subPath || 'index.html'}`;
  if (!isSafePath(rel)) return null;
  try {
    return fs.readFileSync(path.join(versionDir(id, state.gameVersion), rel));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// The sidebar's list -- the database is authoritative for it (title,
// recency, preview), not localStorage, which is only ever a fast/offline
// cache of whatever this last returned. `deleted` selects the trash view
// instead of the normal list; a session is never in both.
async function listSessions({ deleted = false } = {}) {
  const { rows } = await db.query(
    `SELECT s.id, s.title, s.title_auto, s.created_at, s.updated_at, s.has_game, s.game_version, s.deleted_at,
            (SELECT content FROM messages m WHERE m.session_id = s.id ORDER BY m.seq DESC LIMIT 1) AS last_message
     FROM sessions s
     WHERE s.deleted_at IS ${deleted ? 'NOT NULL' : 'NULL'}
     ORDER BY s.updated_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    titleAuto: r.title_auto,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    hasGame: r.has_game,
    gameUrl: r.has_game ? `/games/${r.id}/index.html?v=${r.game_version}` : null,
    lastMessage: r.last_message,
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
  }));
}

// Renames only a non-deleted session (restore it first to rename a trashed
// one) -- returns false if there was nothing to rename, so the route can
// answer 404 rather than a silent, misleading success.
async function renameSession(id, title) {
  const { rowCount } = await db.query(
    'UPDATE sessions SET title = $2, title_auto = FALSE WHERE id = $1 AND deleted_at IS NULL',
    [id, title],
  );
  const cached = cache.get(id);
  if (cached) {
    cached.title = title;
    cached.titleAuto = false;
  }
  return rowCount > 0;
}

// Soft delete: nothing is actually removed (that's what makes restore
// possible) -- it's just excluded from the normal listing until restored.
async function softDeleteSession(id) {
  const { rowCount } = await db.query('UPDATE sessions SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
  return rowCount > 0;
}

// Restores a soft-deleted session. Nothing needs to be reconstructed --
// deleting never touched messages or the on-disk game files, so every
// message, timestamp and game version is already exactly as it was.
async function restoreSession(id) {
  const { rowCount } = await db.query(
    'UPDATE sessions SET deleted_at = NULL, updated_at = now() WHERE id = $1 AND deleted_at IS NOT NULL',
    [id],
  );
  return rowCount > 0;
}

module.exports = {
  isValidId,
  get,
  save,
  saveProject,
  readProjectFiles,
  readFrontendFile,
  listSessions,
  renameSession,
  softDeleteSession,
  restoreSession,
};
