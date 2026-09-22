'use strict';
const http = require('node:http');
require('./utils/env').load();
const llm = require('./services/llm');
const { json } = require('./middleware/http');
const { router } = require('./routes');
const { PORT } = require('./config/constants');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    await router(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, err.status || 500, { error: err.message || 'Server error' });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Game creator chatbot running at http://localhost:${PORT}`);
  if (!llm.hasKey()) console.warn('Warning: no API key set (see .env.example).');
});

module.exports = server;
