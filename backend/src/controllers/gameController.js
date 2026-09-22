'use strict';
const path = require('node:path');
const { json } = require('../middleware/http');
const { MIME, GAME_CSP } = require('../config/constants');
const store = require('../services/store');
const { buildZip } = require('../services/zip');

// GET /games/:id/* -- serves one file from the current version's frontend/
// tree. The URL space after /games/:id/ mirrors the frontend/ folder directly
// (so relative imports inside the generated project resolve exactly as
// authored, with no path rewriting). Every response gets the same CSP sandbox
// and is never cached, so an "improve" is never masked by a stale cached file.
function serveFile(req, res, id, subPath) {
  if (!store.isValidId(id)) return json(res, 400, { error: 'Invalid session id' });
  const state = store.get(id);
  const data = store.readFrontendFile(id, state, subPath);
  if (data === null) return json(res, 404, { error: 'No game yet' });
  res.writeHead(200, {
    'content-type': MIME[path.extname(subPath || 'index.html')] || 'application/octet-stream',
    'content-security-policy': GAME_CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // The sandboxed document has an opaque ("null") origin, so the browser treats
    // its own <script type="module" src="..."> fetches as cross-origin and enforces
    // CORS even though they're same-server. The content is already public at this
    // URL to anyone with the link, so allowing any reader is not a new disclosure.
    'access-control-allow-origin': '*',
  });
  res.end(data);
}

// GET /games/:id/download -- packages the WHOLE project (frontend + backend/
// shared/docs, when present) as a zip, unlike the live preview above which
// only ever serves frontend/.
function download(req, res, id) {
  if (!store.isValidId(id)) return json(res, 400, { error: 'Invalid session id' });
  const state = store.get(id);
  const files = store.readProjectFiles(id, state);
  if (!files) return json(res, 404, { error: 'No game yet' });
  const zip = buildZip(Object.entries(files).map(([filePath, content]) => ({ path: filePath, content })));
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="game-${id.slice(0, 8)}.zip"`,
    'cache-control': 'no-store',
  });
  res.end(zip);
}

module.exports = { serveFile, download };
