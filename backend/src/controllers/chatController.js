'use strict';
const { json, readBody } = require('../middleware/http');
const { MAX_MESSAGE } = require('../config/constants');

const MAX_SPEC = 20000; // a saved Game Design Summary (see orchestrator.handleChat)
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
  const emit = (evt) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  try {
    // Game type from the Save Prompt modal -- only a hint for the Builder.
    const promptType = spec && typeof body.promptType === 'string' && /^[a-z]{1,20}$/.test(body.promptType) ? body.promptType : null;
    await handleChat({ id: body.sessionId, message, spec: spec || null, promptType, emit, signal: ac.signal });
    emit({ type: 'done' });
  } catch (err) {
    if (!ac.signal.aborted) {
      console.error(err);
      emit({ type: 'error', message: err.message || 'Something went wrong.' });
    }
  }
  res.end();
}

module.exports = { postChat };
