'use strict';
const path = require('node:path');

// frontend/ is a sibling of backend/ at the repo root, three levels up from
// here (config -> src -> backend -> root).
const FRONTEND_DIR = path.join(__dirname, '..', '..', '..', 'frontend');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
};

// Generated games are model-written code. Serve them in an opaque origin with no
// network access so they can never reach this app's API or other sessions.
const GAME_CSP = [
  'sandbox allow-scripts allow-pointer-lock allow-popups allow-modals',
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src data: https://fonts.gstatic.com',
  'img-src data: blob:',
  'media-src data: blob:',
  "connect-src 'none'",
  'worker-src blob:',
].join('; ');

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  MAX_MESSAGE: 4000,
  FRONTEND_DIR,
  MIME,
  GAME_CSP,
};
