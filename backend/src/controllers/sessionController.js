'use strict';
const { json } = require('../middleware/http');
const store = require('../services/store');

// GET /api/session/:id -- restores a chat's message history and game link.
function getSession(req, res, id) {
  if (!store.isValidId(id)) return json(res, 400, { error: 'Invalid session id' });
  const state = store.get(id);
  return json(res, 200, {
    messages: state.messages,
    phase: state.phase,
    hasGame: state.hasGame,
    gameUrl: state.hasGame ? `/games/${id}/index.html?v=${state.gameVersion}` : null,
  });
}

module.exports = { getSession };
