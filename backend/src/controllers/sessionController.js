'use strict';
const { json, readBody } = require('../middleware/http');
const store = require('../services/store');

const TITLE_MAX_LEN = 200;

// GET /api/session/:id -- restores a chat's message history and game link.
async function getSession(req, res, id) {
  if (!store.isValidId(id)) return json(res, 400, { error: 'Invalid session id' });
  const state = await store.get(id);
  return json(res, 200, {
    messages: state.messages,
    phase: state.phase,
    hasGame: state.hasGame,
    gameUrl: state.hasGame ? `/games/${id}/index.html?v=${state.gameVersion}` : null,
    title: state.title,
    titleAuto: state.titleAuto,
  });
}

// GET /api/sessions -- the sidebar's list, straight from the database (the
// authoritative copy -- see store.js). ?deleted=1 lists the trash instead.
async function listSessions(req, res, deleted) {
  const sessions = await store.listSessions({ deleted });
  return json(res, 200, { sessions });
}

// PATCH /api/session/:id -- rename. Body: { title }.
async function renameSession(req, res, id) {
  if (!store.isValidId(id)) return json(res, 400, { error: 'Invalid session id' });
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return json(res, err.status || 400, { error: err.status ? err.message : 'Invalid JSON' });
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return json(res, 400, { error: 'Title is required' });
  if (title.length > TITLE_MAX_LEN) return json(res, 400, { error: `Title is limited to ${TITLE_MAX_LEN} characters` });

  const ok = await store.renameSession(id, title);
  if (!ok) return json(res, 404, { error: 'No such chat (or it is in the trash -- restore it first)' });
  return json(res, 200, { id, title });
}

// DELETE /api/session/:id -- soft delete (see store.softDeleteSession).
async function deleteSession(req, res, id) {
  if (!store.isValidId(id)) return json(res, 400, { error: 'Invalid session id' });
  const ok = await store.softDeleteSession(id);
  if (!ok) return json(res, 404, { error: 'No such chat (or it is already deleted)' });
  return json(res, 200, { id, deleted: true });
}

// POST /api/session/:id/restore
async function restoreSession(req, res, id) {
  if (!store.isValidId(id)) return json(res, 400, { error: 'Invalid session id' });
  const ok = await store.restoreSession(id);
  if (!ok) return json(res, 404, { error: 'No such deleted chat' });
  return json(res, 200, { id, deleted: false });
}

module.exports = { getSession, listSessions, renameSession, deleteSession, restoreSession };
