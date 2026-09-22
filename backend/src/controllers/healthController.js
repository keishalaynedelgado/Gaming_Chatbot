'use strict';
const { json } = require('../middleware/http');
const llm = require('../services/llm');

// GET /api/health -- lets the frontend show a banner if no API key is configured.
function getHealth(req, res) {
  return json(res, 200, { ok: true, hasKey: llm.hasKey() });
}

module.exports = { getHealth };
