'use strict';
const http = require('node:http');
require('./utils/env').load();
const llm = require('./services/llm');
const db = require('./services/db');
const { json } = require('./middleware/http');
const { router } = require('./routes');
const { PORT } = require('./config/constants');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    await router(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, err.status || 500, { error: err.message || 'Server error' });
    else res.end();
  }
});

// Every chat and game the app persists lives in Postgres now (see store.js).
// Without it there's nothing to serve, so this fails fast and loud at
// startup rather than letting the first request hit a confusing DB error.
db.migrate()
  .then(() => {
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`Game creator chatbot running at http://localhost:${PORT}`);
      if (!llm.hasKey()) console.warn('Warning: no API key set (see .env.example).');
    });
  })
  .catch((err) => {
    console.error('Could not connect to PostgreSQL / apply schema:', err.message);
    console.error('Check DATABASE_URL in .env and that the database is reachable, then restart.');
    process.exit(1);
  });

module.exports = server;
