'use strict';

// Talks to an OpenAI-compatible chat/completions endpoint. MELDCX is the
// primary/default provider; if it's missing, invalid, unavailable, or fails
// to connect, stream() transparently falls back to SCX, using the exact
// same request/response shape -- callers elsewhere in the app never need to
// know providers exist at all, and never change based on which one answers.
const DEFAULT_MELDCX_URL = 'http://10.11.0.4:1234/v1';
const DEFAULT_SCX_BASE_URL = 'https://api.scx.ai/v1';
// Reasoning models spend part of max_tokens on hidden thinking; leave room for it.
const REASONING_HEADROOM = 6000;
// Confirmed against the actual gateway (not an assumed model limit) that it
// accepts and services requests at this ceiling without erroring.
const MAX_COMPLETION = 60000;

const ROLE_DEFAULTS = { intent: 'gpt-oss-120b', designer: 'gpt-oss-120b', builder: 'minimax-m2.7', qa: 'gpt-oss-120b' };

// The model to request for each agent role -- from MELDCX's point of view: a
// role-specific override, then a MELDCX-wide override, then a hardcoded
// default. Unrelated to the SCX fallback, which always uses SCX_MODEL
// regardless of role (see stream() below); this keeps every existing caller
// (orchestrator.js) unchanged.
const MODELS = Object.fromEntries(
  ['intent', 'designer', 'builder', 'qa'].map((role) => [
    role,
    () => process.env[`${role.toUpperCase()}_MODEL`] || process.env.MELDCX_MODEL || ROLE_DEFAULTS[role],
  ]),
);

function hasKey() {
  return Boolean(process.env.MELDCX_API_KEY || process.env.SCX_API_KEY);
}

function meldcxConfig() {
  return {
    name: 'meldcx',
    apiKey: process.env.MELDCX_API_KEY,
    baseUrl: process.env.MELDCX_BASE_URL || DEFAULT_MELDCX_URL,
  };
}

function scxConfig() {
  return {
    name: 'scx',
    apiKey: process.env.SCX_API_KEY,
    baseUrl: process.env.SCX_BASE_URL || DEFAULT_SCX_BASE_URL,
    model: process.env.SCX_MODEL,
  };
}

async function failFromResponse(res, providerName) {
  let detail;
  try {
    const body = await res.json();
    detail = body?.error?.message || JSON.stringify(body);
  } catch {
    detail = res.statusText;
  }
  throw new Error(`${providerName} error (${res.status}): ${String(detail).slice(0, 300)}`);
}

// Reads a server-sent-event body, calling onData with each JSON payload.
async function readSse(res, onData) {
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let evt;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    onData(evt);
  };
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      handle(buffer.slice(0, nl).replace(/\r$/, ''));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer) handle(buffer);
}

// One attempt against one provider. Never logs the API key. Throws on any
// failure; stream() below decides whether that's worth falling back from.
async function attemptStream(provider, { model, system, messages, maxTokens, onText, signal }) {
  const base = provider.baseUrl.replace(/\/(chat\/completions)?\/?$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: Math.min(maxTokens + REASONING_HEADROOM, MAX_COMPLETION),
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  if (!res.ok) await failFromResponse(res, provider.name);

  let text = '';
  let stopReason = null;
  await readSse(res, (evt) => {
    if (evt.error) throw new Error(`${provider.name} error: ${evt.error.message || 'stream failed'}`);
    const choice = evt.choices?.[0];
    if (!choice) return;
    // delta.reasoning_content is the model's hidden thinking: never shown or stored.
    const piece = choice.delta?.content;
    if (piece) {
      text += piece;
      onText?.(piece);
    }
    if (choice.finish_reason) stopReason = choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason;
  });

  if (!text.trim()) {
    throw new Error(
      stopReason === 'max_tokens'
        ? 'The model ran out of tokens while thinking and produced no answer. Try again or choose a different model.'
        : 'The model returned an empty response. Please try again.',
    );
  }
  return { text, stopReason };
}

// Streams a chat completion. MELDCX is always tried first; only if it's
// missing a key, unreachable, or errors does this retry once against SCX
// (with SCX's own model, not the MELDCX one the caller passed) before
// giving up. Resolves with the full text and the stop reason ("max_tokens"
// when the output was cut off) -- identical shape regardless of which
// provider actually answered.
async function stream({ model, system, messages, maxTokens = 4096, onText, signal }) {
  const meldcx = meldcxConfig();
  const scx = scxConfig();

  // Fall back only before any content has reached the caller. Once a token
  // has streamed into the chat, switching providers mid-response would show
  // a corrupted, duplicated reply -- so a failure past that point is always
  // just propagated, exactly as before this fallback existed.
  let emitted = false;
  const guardedOnText = (piece) => {
    emitted = true;
    onText?.(piece);
  };

  if (meldcx.apiKey) {
    console.log(`[llm] provider=meldcx model=${model}`);
    try {
      return await attemptStream(meldcx, { model, system, messages, maxTokens, onText: guardedOnText, signal });
    } catch (err) {
      if (signal?.aborted || emitted) throw err;
      console.warn(`[llm] meldcx unavailable (${err.message}); falling back to provider=scx`);
    }
  } else {
    console.warn('[llm] MELDCX_API_KEY not set; falling back to provider=scx');
  }

  if (!scx.apiKey) {
    throw new Error(
      'No AI provider is available. Set MELDCX_API_KEY (and/or SCX_API_KEY as a fallback) in .env, and restart the server.',
    );
  }
  console.log(`[llm] provider=scx model=${scx.model}`);
  try {
    return await attemptStream(scx, { model: scx.model, system, messages, maxTokens, onText: guardedOnText, signal });
  } catch (err) {
    if (!(signal?.aborted)) console.error(`[llm] scx fallback also failed (${err.message})`);
    throw err;
  }
}

module.exports = { MODELS, stream, hasKey };
