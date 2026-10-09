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
  '.webmanifest': 'application/manifest+json',
};

// Generated games are model-written code. Serve them in an opaque origin with no
// network access so they can never reach this app's API or other sessions.
const GAME_SANDBOX = 'allow-scripts allow-pointer-lock allow-popups allow-modals';
const GAME_CSP = [
  `sandbox ${GAME_SANDBOX}`,
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src data: https://fonts.gstatic.com',
  'img-src data: blob:',
  'media-src data: blob:',
  "connect-src 'none'",
  'worker-src blob:',
].join('; ');

// The iPhone & Mac web app's page (templates/web/index.html). It is this app's
// own code, not the game's, and needs a real origin for its service worker,
// so it isn't sandboxed itself: the game runs inside it in an iframe with
// sandbox="GAME_SANDBOX", and that srcdoc frame inherits this policy -- so
// the game gets exactly what GAME_CSP allows.
const PLAY_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src data: https://fonts.gstatic.com',
  'img-src data: blob:',
  'media-src data: blob:',
  "connect-src 'none'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join('; ');

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  MAX_MESSAGE: 4000,
  FRONTEND_DIR,
  MIME,
  GAME_SANDBOX,
  GAME_CSP,
  PLAY_CSP,
};
