'use strict';
const path = require('node:path');
const { json } = require('../middleware/http');
const { MIME, GAME_CSP } = require('../config/constants');
const store = require('../services/store');
const qa = require('../services/qa');
const bundler = require('../services/bundler');
const { buildZip } = require('../services/zip');

const ENTRY_SCRIPT_RE = /<script\s+type=["']module["']\s+src=["']([^"']+)["']\s*>\s*<\/script>/i;

// Only reached for index.html on a host bundler.needsBundling() flags (see
// bundler.js for why: a tunnel's free-tier interstitial breaks the per-file
// requests a normal multi-file project needs). Inlines the whole local
// module graph into one <script>, so the page needs no further requests to
// run. Returns null (never throws) if there's nothing to do (a one-file
// prototype has no such <script src>) or the project has something this
// simplified bundler doesn't understand -- either way the caller just serves
// the original file, unmodified, exactly as it does for every other host.
async function bundleForTunnel(id, state, htmlBuffer) {
  const html = htmlBuffer.toString('utf8');
  const match = ENTRY_SCRIPT_RE.exec(html);
  if (!match) return null;
  const allFiles = await store.readProjectFiles(id, state);
  if (!allFiles) return null;
  const frontendFiles = {};
  for (const [p, content] of Object.entries(allFiles)) {
    if (p.startsWith('frontend/')) frontendFiles[p] = content;
  }
  const entryRel = qa.resolveRelative('frontend/index.html', match[1]);
  const bundled = bundler.bundleFrontend(frontendFiles, entryRel);
  if (!bundled) return null;
  return html.slice(0, match.index) + `<script type="module">\n${bundled}\n</script>` + html.slice(match.index + match[0].length);
}

// GET /games/:id/* -- serves one file from the current version's frontend/
// tree. The URL space after /games/:id/ mirrors the frontend/ folder directly
// (so relative imports inside the generated project resolve exactly as
// authored, with no path rewriting). Every response gets the same CSP sandbox
// and is never cached, so an "improve" is never masked by a stale cached file.
async function serveFile(req, res, id, subPath) {
  if (!store.isValidId(id)) return json(res, 400, { error: 'Invalid session id' });
  const state = await store.get(id);
  let data = await store.readFrontendFile(id, state, subPath);
  if (data === null) return json(res, 404, { error: 'No game yet' });

  const isIndex = !subPath || subPath === 'index.html';
  if (isIndex && bundler.needsBundling(req.headers.host)) {
    try {
      const inlined = await bundleForTunnel(id, state, data);
      if (inlined !== null) data = Buffer.from(inlined, 'utf8');
    } catch {
      // A failed bundling attempt must never turn into a broken response --
      // fall through and serve the original, unmodified file instead.
    }
  }

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
async function download(req, res, id) {
  if (!store.isValidId(id)) return json(res, 400, { error: 'Invalid session id' });
  const state = await store.get(id);
  const files = await store.readProjectFiles(id, state);
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
