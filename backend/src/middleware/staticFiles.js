'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { json } = require('./http');
const { FRONTEND_DIR, MIME } = require('../config/constants');

// Serves the chat UI's static files straight out of frontend/. There's no
// build step -- it's plain HTML/CSS/JS, so this is the only "frontend server"
// the app needs.
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^[/\\]+/, '');
  const file = path.resolve(FRONTEND_DIR, rel);
  if (file !== FRONTEND_DIR && !file.startsWith(FRONTEND_DIR + path.sep)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}

module.exports = { serveStatic };
