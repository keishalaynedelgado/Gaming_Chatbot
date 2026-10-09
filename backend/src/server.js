'use strict';
const http = require('node:http');
const { randomUUID } = require('node:crypto');
require('./utils/env').load();
const log = require('./utils/logger');
const llm = require('./services/llm');
const db = require('./services/db');
const { json } = require('./middleware/http');
const { router } = require('./routes');
const { PORT } = require('./config/constants');

// Only API calls and game/app downloads are worth a log line each; the chat
// UI's own static files and game assets would just be noise.
const LOGGED_PATH = /^\/api\/|^\/games\/[^/]+\/(download|export\/)/;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const requestId = randomUUID();
  const started = Date.now();
  res.setHeader('x-request-id', requestId);
  res.on('finish', () => {
    if (!LOGGED_PATH.test(url.pathname) && res.statusCode < 500) return;
    const fields = { event: 'http_request', request_id: requestId, method: req.method, path: url.pathname, status: res.statusCode, duration_ms: Date.now() - started };
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log[level](`${req.method} ${url.pathname} ${res.statusCode} ${fields.duration_ms}ms`, fields);
  });
  log.context.run({ request_id: requestId }, async () => {
    try {
      await router(req, res, url);
    } catch (err) {
      console.error(err);
      log.error(`[http] unhandled error on ${req.method} ${url.pathname}`, { event: 'http_unhandled_error', method: req.method, path: url.pathname, err });
      if (!res.headersSent) json(res, err.status || 500, { error: err.message || 'Server error' });
      else res.end();
    }
  });
});

// Every chat and game the app persists lives in Postgres now (see store.js).
// Without it there's nothing to serve, so this fails fast and loud at
// startup rather than letting the first request hit a confusing DB error.
db.migrate()
  .then(() => {
    server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
      log.info(`Game creator chatbot running at http://localhost:${PORT}`, { event: 'server_started', port: Number(PORT) });
      if (!llm.hasKey()) log.warn('Warning: no API key set (see .env.example).', { event: 'llm_no_api_key' });
    });
  })
  .catch(async (err) => {
    log.error('Could not connect to PostgreSQL / apply schema', { event: 'server_start_failed', err });
    console.error('Check DATABASE_URL in .env and that the database is reachable, then restart.');
    await log.flush();
    process.exit(1);
  });

module.exports = server;
