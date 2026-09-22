'use strict';
const { json } = require('../middleware/http');
const { serveStatic } = require('../middleware/staticFiles');
const chatController = require('../controllers/chatController');
const sessionController = require('../controllers/sessionController');
const gameController = require('../controllers/gameController');
const healthController = require('../controllers/healthController');

// The whole app's routing table. Small and hand-rolled on purpose (no
// framework dependency) -- but kept in one place, separate from the
// controllers that actually handle each request.
async function router(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/chat') return chatController.postChat(req, res);

  if (req.method === 'GET') {
    if (pathname === '/api/health') return healthController.getHealth(req, res);

    let m = pathname.match(/^\/api\/session\/([^/]+)$/);
    if (m) return sessionController.getSession(req, res, m[1]);

    m = pathname.match(/^\/games\/([^/]+)\/download$/);
    if (m) return gameController.download(req, res, m[1]);

    m = pathname.match(/^\/games\/([^/]+)\/(.*)$/);
    if (m) return gameController.serveFile(req, res, m[1], decodeURIComponent(m[2]));

    return serveStatic(res, pathname);
  }

  return json(res, 405, { error: 'Method not allowed' });
}

module.exports = { router };
