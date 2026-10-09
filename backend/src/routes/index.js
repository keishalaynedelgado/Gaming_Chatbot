'use strict';
const { json } = require('../middleware/http');
const { serveStatic } = require('../middleware/staticFiles');
const chatController = require('../controllers/chatController');
const sessionController = require('../controllers/sessionController');
const gameController = require('../controllers/gameController');
const healthController = require('../controllers/healthController');

// The whole app's routing table. Small and hand-rolled on purpose (no
// framework dependency) -- but kept in one place, separate from the
// controllers that actually handle each request. `url` is the full parsed
// URL (not just the pathname) so routes that need a query string -- the
// sidebar's trash view -- can read it.
async function router(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/chat') return chatController.postChat(req, res);

  if (req.method === 'GET') {
    if (pathname === '/api/health') return healthController.getHealth(req, res);
    if (pathname === '/api/sessions') return sessionController.listSessions(req, res, url.searchParams.get('deleted') === '1');
    if (pathname === '/api/saved-prompts') return sessionController.listSavedPrompts(req, res);

    let m = pathname.match(/^\/api\/session\/([^/]+)$/);
    if (m) return sessionController.getSession(req, res, m[1]);

    m = pathname.match(/^\/games\/([^/]+)\/download$/);
    if (m) return gameController.download(req, res, m[1]);

    m = pathname.match(/^\/games\/([^/]+)\/export\/(apk|exe|msi|setup|ios|mac)$/);
    if (m) return gameController.downloadExport(req, res, m[1], m[2], url.searchParams.get('v'));

    // The iPhone & Mac app (exporter.js) gets its own folder: it is the app's
    // scope, and its service worker's.
    m = pathname.match(/^\/play\/([^/]+)$/);
    if (m) {
      res.writeHead(301, { location: `${pathname}/${url.search}` });
      return res.end();
    }

    m = pathname.match(/^\/play\/([^/]+)\/([^/]*)$/);
    if (m) return gameController.playApp(req, res, m[1], m[2] || 'index.html');

    m = pathname.match(/^\/games\/([^/]+)\/(.*)$/);
    if (m) return gameController.serveFile(req, res, m[1], decodeURIComponent(m[2]));

    return serveStatic(res, pathname);
  }

  if (req.method === 'PATCH') {
    const m = pathname.match(/^\/api\/session\/([^/]+)$/);
    if (m) return sessionController.renameSession(req, res, m[1]);
  }

  if (req.method === 'DELETE') {
    const m = pathname.match(/^\/api\/session\/([^/]+)$/);
    if (m) return sessionController.deleteSession(req, res, m[1]);
  }

  if (req.method === 'POST') {
    if (pathname === '/api/saved-prompts') return sessionController.createSavedPrompt(req, res);
    const pin = pathname.match(/^\/api\/session\/([^/]+)\/pin$/);
    if (pin) return sessionController.pinSession(req, res, pin[1]);
    const stop = pathname.match(/^\/api\/session\/([^/]+)\/stop$/);
    if (stop) return chatController.stopChat(req, res, stop[1]);
    const m = pathname.match(/^\/api\/session\/([^/]+)\/restore$/);
    if (m) return sessionController.restoreSession(req, res, m[1]);
  }

  return json(res, 405, { error: 'Method not allowed' });
}

module.exports = { router };
