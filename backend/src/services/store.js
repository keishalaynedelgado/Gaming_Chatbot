'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isSafePath } = require('./qa');

// projects/ holds generated game data (runtime output, not source), so it lives
// at the repo root, a sibling of frontend/ and backend/, three levels up from
// here (services -> src -> backend -> root).
const ROOT = path.join(__dirname, '..', '..', '..', 'projects');
const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
const cache = new Map();

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function dir(id) {
  if (!isValidId(id)) throw new Error('Invalid session id');
  return path.join(ROOT, id);
}

function versionDir(id, version) {
  return path.join(dir(id), `v${version}`);
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

function get(id) {
  if (cache.has(id)) return cache.get(id);
  let state = fresh();
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(path.join(dir(id), 'state.json'), 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  cache.set(id, state);
  return state;
}

function save(id, state) {
  fs.mkdirSync(dir(id), { recursive: true });
  fs.writeFileSync(path.join(dir(id), 'state.json'), JSON.stringify(state, null, 2));
}

// Writes the project as a brand new version directory (every earlier version stays
// on disk untouched). `files` must be the COMPLETE project -- for an improve, the
// caller merges the Builder's partial output onto the previous version first, so
// each version directory is fully self-contained. Every path is re-validated here,
// independently of whatever already filtered it upstream, as the last line of
// defense before anything is written to disk.
function saveProject(id, state, files) {
  state.gameVersion += 1;
  state.hasGame = true;
  const base = versionDir(id, state.gameVersion);
  for (const [rel, content] of Object.entries(files)) {
    if (!isSafePath(rel)) continue;
    const file = path.join(base, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return state.gameVersion;
}

// Reads every file of the current version back into a flat {path: content} map --
// used as context when the Builder improves an existing project, and to build the
// downloadable zip.
function readProjectFiles(id, state) {
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

// Reads one file from the current version's frontend/ tree, for serving the live
// preview. Returns a Buffer, or null if there's no game yet or the file doesn't exist.
function readFrontendFile(id, state, subPath) {
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

module.exports = { isValidId, get, save, saveProject, readProjectFiles, readFrontendFile };
