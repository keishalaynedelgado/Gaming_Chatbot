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

const SAVED_PROMPT_MAX_LEN = 20000; // same as the chat's saved-prompt spec limit
const SAVED_PROMPT_NAME_MAX = 80;
// The Save Prompt modal's Type options (a genre hint passed to the Builder).
const SAVED_PROMPT_TYPES = ['any', 'arcade', 'platformer', 'puzzle', 'shooter', 'racing', 'strategy', 'other'];

// GET /api/saved-prompts -- the user's own saved prompts plus every game
// already built, all build-ready (see store.listSavedPrompts).
async function listSavedPrompts(req, res) {
  const prompts = await store.listSavedPrompts();
  return json(res, 200, { prompts });
}

// POST /api/saved-prompts -- save a prompt the user wrote. Body: { prompt }.
async function createSavedPrompt(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return json(res, err.status || 400, { error: err.status ? err.message : 'Invalid JSON' });
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return json(res, 400, { error: 'Prompt is required' });
  if (prompt.length > SAVED_PROMPT_MAX_LEN) return json(res, 400, { error: `Saved prompt is limited to ${SAVED_PROMPT_MAX_LEN} characters` });
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, SAVED_PROMPT_NAME_MAX) : '';
  const type = SAVED_PROMPT_TYPES.includes(body.type) ? body.type : 'any';
  const saved = await store.createSavedPrompt({ name, prompt, type, runAuto: body.runAuto === true, showOnHome: body.showOnHome === true });
  return json(res, 201, { prompt: saved });
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

module.exports = { getSession, listSessions, listSavedPrompts, createSavedPrompt, renameSession, deleteSession, restoreSession };
