'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { json } = require('../middleware/http');
const log = require('../utils/logger');
const { MIME, GAME_CSP, PLAY_CSP } = require('../config/constants');
const store = require('../services/store');
const qa = require('../services/qa');
const bundler = require('../services/bundler');
const exporter = require('../services/exporter');
const iconDesigner = require('../services/iconDesigner');
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
  if (data === null) return json(res, 404, { error: state.hasGame ? 'Not found' : 'No game yet' });

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
    'content-disposition': `attachment; filename="${exporter.fileName(state)}.zip"`,
    'cache-control': 'no-store',
  });
  res.end(zip);
}

// GET /games/:id/export/:format?v=N -- an exported app (APK, EXE, MSI, Setup,
// iPhone profile or Mac zip) of that game version, built earlier from the
// chat (see exporter.js). Named after the chat's title, e.g.
// "Flappy-Bird.apk". The iPhone and Mac apps need no tools, so for the
// current version they're built right here if needed (say, after the game
// was renamed) -- their download buttons always work.
async function downloadExport(req, res, id, format, v) {
  if (!store.isValidId(id)) return json(res, 400, { error: 'Invalid session id' });
  const state = await store.get(id);
  const version = v === null ? state.gameVersion : Number(v);
  let file = state.hasGame && Number.isInteger(version) && version >= 1 && version <= state.gameVersion
    ? exporter.existing(id, version, format, state)
    : null;
  if (!file && state.hasGame && version === state.gameVersion && exporter.buildsOnRequest(format)) {
    try {
      const { files } = await exporter.gameFiles(id, state);
      file = await exporter.build(format, { id, state, files, icon: await iconDesigner.savedIcon(id) });
    } catch (err) {
      log.error(`[export] could not build the ${format} app`, { event: 'export_failed', session_id: id, format, err });
    }
  }
  if (!file) return json(res, 404, { error: 'This app has not been exported yet. Ask the chatbot to export the game again.' });
  if (format === 'ios') {
    // Opens the game at the address this download came from, so the iPhone
    // that downloads it can reach it (see exporter.iosProfile).
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
    const host = String(req.headers.host || '');
    if (!/^[\w.-]+(:\d+)?$|^\[[\da-f:.]+\](:\d+)?$/i.test(host)) return json(res, 400, { error: 'Invalid host' });
    const profile = exporter.iosProfile({ id, state, origin: `${proto === 'https' ? 'https' : 'http'}://${host}`, page: file });
    res.writeHead(200, {
      'content-type': exporter.FORMATS.ios.mime,
      'content-disposition': `attachment; filename="${exporter.downloadName(state, format)}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(profile);
  }
  res.writeHead(200, {
    'content-type': exporter.FORMATS[format].mime,
    'content-disposition': `attachment; filename="${exporter.downloadName(state, format)}"`,
    'content-length': fs.statSync(file).size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

// GET /play/:id/<file> -- the game's iPhone, iPad & Mac app (the web export in
// exporter.js). Always the latest version, so an app already added to a Home
// Screen or Dock picks up an improved game; built here on first request if
// the chat hasn't exported it yet (with the designed icon, if there is one).
const PLAY_FILES = new Set(['index.html', 'manifest.webmanifest', 'sw.js', 'icon-180.png', 'icon-192.png', 'icon-512.png']);

async function playApp(req, res, id, name) {
  if (!store.isValidId(id)) return json(res, 400, { error: 'Invalid session id' });
  if (!PLAY_FILES.has(name)) return json(res, 404, { error: 'Not found' });
  const state = await store.get(id);
  if (!state.hasGame) return json(res, 404, { error: 'No game yet' });
  let page = exporter.existing(id, state.gameVersion, 'web', state);
  if (!page) {
    try {
      const { files } = await exporter.gameFiles(id, state);
      page = await exporter.build('web', { id, state, files, icon: await iconDesigner.savedIcon(id) });
    } catch (err) {
      log.error('[play] could not build the web app', { event: 'export_failed', session_id: id, format: 'web', err });
      return json(res, 500, { error: 'This game could not be opened as an app.' });
    }
  }
  const file = exporter.webFile(page, name);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)],
    'content-length': fs.statSync(file).size,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    ...(name === 'index.html' ? { 'content-security-policy': PLAY_CSP } : {}),
  });
  fs.createReadStream(file).pipe(res);
}

module.exports = { serveFile, download, downloadExport, playApp };
