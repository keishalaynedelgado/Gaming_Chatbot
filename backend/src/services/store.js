'use strict';
const db = require('./db');
const { isSafePath } = require('./qa');

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
    messages: [], // [{role, content}] shown in the UI and sent to agents
    phase: 'none', // none | discover | plan | built
    summary: null, // latest Game Design Summary text
    historyStart: 0, // messages before this index belong to an earlier game
    hasGame: false,
    gameVersion: 0,
  };
}

// Reads a session's full state from Postgres. A never-seen id is NOT written
// to the database here -- exactly like the old file-based store never
// created a directory for one -- it just returns fresh() in memory. Only
// save()/saveProject() actually persist anything.
async function get(id) {
  if (cache.has(id)) return cache.get(id);
  let state = fresh();
  const { rows } = await db.query(
    'SELECT phase, summary, history_start, has_game, game_version FROM sessions WHERE id = $1',
    [id],
  );
  if (rows.length) {
    const row = rows[0];
    const { rows: msgRows } = await db.query(
      'SELECT role, content FROM messages WHERE session_id = $1 ORDER BY seq',
      [id],
    );
    state = {
      messages: msgRows.map((m) => ({ role: m.role, content: m.content })),
      phase: row.phase,
      summary: row.summary,
      historyStart: row.history_start,
      hasGame: row.has_game,
      gameVersion: row.game_version,
    };
  }
  cache.set(id, state);
  return state;
}

function upsertSessionSql(client, id, state) {
  return client.query(
    `INSERT INTO sessions (id, phase, summary, history_start, has_game, game_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE SET
       phase = EXCLUDED.phase, summary = EXCLUDED.summary, history_start = EXCLUDED.history_start,
       has_game = EXCLUDED.has_game, game_version = EXCLUDED.game_version, updated_at = now()`,
    [id, state.phase, state.summary, state.historyStart, state.hasGame, state.gameVersion],
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
      const rows = state.messages.map((m, i) => [id, i, m.role, m.content]);
      const { placeholders, params } = bulkValues(rows, 4);
      await client.query(`INSERT INTO messages (session_id, seq, role, content) VALUES ${placeholders}`, params);
    }
  });
  cache.set(id, state);
}

// Writes the project as a brand new version -- every earlier version's rows
// stay untouched, exactly like the old per-version directories did. `files`
// must be the COMPLETE project (the caller merges the Builder's partial
// output onto the previous version first). Every path is re-validated here,
// independently of whatever already filtered it upstream, as the last line
// of defense before anything is written to the database.
async function saveProject(id, state, files) {
  state.gameVersion += 1;
  state.hasGame = true;
  const version = state.gameVersion;
  await db.withTransaction(async (client) => {
    await upsertSessionSql(client, id, state);
    const entries = Object.entries(files).filter(([rel]) => isSafePath(rel));
    if (entries.length) {
      const rows = entries.map(([rel, content]) => [id, version, rel, content]);
      const { placeholders, params } = bulkValues(rows, 4);
      await client.query(`INSERT INTO game_files (session_id, version, path, content) VALUES ${placeholders}`, params);
    }
  });
  cache.set(id, state);
  return version;
}

// Reads every file of the current version back into a flat {path: content}
// map -- used as context when the Builder improves an existing project, and
// to build the downloadable zip.
async function readProjectFiles(id, state) {
  if (!state.hasGame) return null;
  const { rows } = await db.query(
    'SELECT path, content FROM game_files WHERE session_id = $1 AND version = $2',
    [id, state.gameVersion],
  );
  const files = {};
  for (const r of rows) files[r.path] = r.content;
  return files;
}

// Reads one file from the current version's frontend/ tree, for serving the
// live preview. Returns a Buffer (matching what every caller already
// expects from the old fs.readFileSync-backed version), or null if there's
// no game yet or the file doesn't exist.
async function readFrontendFile(id, state, subPath) {
  if (!state.hasGame) return null;
  const rel = `frontend/${subPath || 'index.html'}`;
  if (!isSafePath(rel)) return null;
  const { rows } = await db.query(
    'SELECT content FROM game_files WHERE session_id = $1 AND version = $2 AND path = $3',
    [id, state.gameVersion, rel],
  );
  return rows.length ? Buffer.from(rows[0].content, 'utf8') : null;
}

module.exports = { isValidId, get, save, saveProject, readProjectFiles, readFrontendFile };
