'use strict';
const { json, readBody } = require('../middleware/http');
const { MAX_MESSAGE } = require('../config/constants');

const MAX_SPEC = 20000; // a saved Game Design Summary (see orchestrator.handleChat)
const HEARTBEAT_MS = 15000;
const running = new Map(); // session id -> AbortController of its in-progress turn
const store = require('../services/store');
const { handleChat } = require('../services/orchestrator');

// POST /api/chat -- streams the agent pipeline's progress and reply as
// server-sent events.
async function postChat(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return json(res, err.status || 400, { error: err.status ? err.message : 'Invalid JSON' });
  }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!store.isValidId(body.sessionId)) return json(res, 400, { error: 'Invalid session id' });
  if (!message) return json(res, 400, { error: 'Empty message' });
  const spec = typeof body.spec === 'string' ? body.spec.trim() : '';
  if (spec.length > MAX_SPEC) return json(res, 400, { error: `Saved prompt is limited to ${MAX_SPEC} characters` });
  // A saved prompt is sent as the message itself, so it gets the saved-prompt limit.
  const maxMessage = spec ? MAX_SPEC : MAX_MESSAGE;
  if (message.length > maxMessage) return json(res, 400, { error: `Message is limited to ${maxMessage} characters` });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  });
  // A turn is only ever cancelled by the Stop button (POST /api/session/:id/stop),
  // never by the connection dropping: a long game build can lose its browser
  // connection mid-way (sleep, flaky network, security software cutting a
  // quiet stream), and it should still finish and be saved -- the page picks
  // the result up when it reconnects (see frontend main.js).
  const ac = new AbortController();
  const ids = new Set([body.sessionId]);
  running.set(body.sessionId, ac);
  const emit = (evt) => {
    if (evt.type === 'session') { ids.add(evt.id); running.set(evt.id, ac); } // Stop works on the new chat too
    if (ac.signal.aborted) return; // after Stop, nothing more is sent
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
  // Heartbeat: an SSE comment every 15s, so the stream is never silent for
  // long (a model can "think" for minutes without output) -- idle
  // connections are what proxies and security software tend to cut.
  const heartbeat = setInterval(() => {
    if (ac.signal.aborted) return clearInterval(heartbeat);
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  // Stop ends the stream at once, rather than after the turn has unwound.
  ac.signal.addEventListener('abort', () => {
    clearInterval(heartbeat);
    if (!res.writableEnded && !res.destroyed) res.end();
  });
  res.on('close', () => {
    if (!res.writableEnded && !ac.signal.aborted) console.warn(`[chat] client disconnected from ${body.sessionId}; finishing the turn in the background`);
  });

  try {
    // Game type from the Save Prompt modal -- only a hint for the Builder.
    const promptType = spec && typeof body.promptType === 'string' && /^[a-z]{1,20}$/.test(body.promptType) ? body.promptType : null;
    // From a saved prompt: `loadGame` is its finished game (opened instantly,
    // no rebuild); `savedPromptId` is linked to the game a fresh build makes.
    const loadGame = store.isValidId(body.loadGame) ? body.loadGame : null;
    const savedPromptId = typeof body.savedPromptId === 'string' && /^sp-[a-z0-9-]{1,40}$/.test(body.savedPromptId) ? body.savedPromptId : null;
    await handleChat({ id: body.sessionId, message, spec: spec || null, promptType, loadGame, savedPromptId, emit, signal: ac.signal });
    emit({ type: 'done' });
  } catch (err) {
    if (!ac.signal.aborted) {
      console.error(err);
      emit({ type: 'error', message: err.message || 'Something went wrong.' });
    }
  } finally {
    clearInterval(heartbeat);
    for (const id of ids) if (running.get(id) === ac) running.delete(id);
  }
  if (!res.writableEnded && !res.destroyed) res.end();
}

// POST /api/session/:id/stop -- the Stop button: cancels that chat's turn.
function stopChat(req, res, id) {
  const ac = running.get(id);
  if (ac) ac.abort();
  return json(res, 200, { stopped: Boolean(ac) });
}

module.exports = { postChat, stopChat };
