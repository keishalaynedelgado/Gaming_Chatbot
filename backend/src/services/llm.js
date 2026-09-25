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
  throw Object.assign(new Error(`${providerName} error (${res.status}): ${String(detail).slice(0, 300)}`), { status: res.status });
}

// Set LLM_DEBUG_STREAM=1 in .env to log every raw streamed chunk (very noisy
// during a game build, so it's off by default).
const DEBUG_STREAM = process.env.LLM_DEBUG_STREAM === '1';

// MELDCX stall watchdog (see attemptStream): give up on a MELDCX request that
// has streamed nothing for MELDCX_STALL_MS, or hasn't started answering within
// MELDCX_FIRST_OUTPUT_MS, and fall back to SCX right away.
const STALL = {
  idleMs: Number(process.env.MELDCX_STALL_MS) || 45000,
  firstOutputMs: Number(process.env.MELDCX_FIRST_OUTPUT_MS) || 90000,
  // A local model has to read the whole prompt before it can send anything:
  // allow this much extra per 1,000 prompt tokens (a change to an existing
  // game sends every file of it).
  perKTokenMs: Number(process.env.MELDCX_FIRST_OUTPUT_PER_1K_TOKENS_MS) || 5000,
};
const STALL_CHECK_MS = 2000;
const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);
const TRANSIENT_RETRY_MS = 3000;

// Reads a streamed completion, calling onData with each JSON payload as it
// arrives. Tolerant by design: SSE "data:" lines with or without a space,
// CRLF or LF line endings, keep-alive/comment lines, empty or malformed
// chunks (skipped, never fatal), and a server that ignores stream:true and
// answers with one plain JSON body instead (delivered as a single payload).
async function readSse(res, onData) {
  const decoder = new TextDecoder();
  let buffer = '';
  let sawSse = false;
  let raw = '';
  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    sawSse = true;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let evt;
    try {
      evt = JSON.parse(payload);
    } catch {
      return; // a malformed chunk: skip it, keep streaming
    }
    if (evt && typeof evt === 'object') onData(evt);
  };
  for await (const chunk of res.body) {
    const piece = decoder.decode(chunk, { stream: true });
    if (!sawSse && raw.length < 5_000_000) raw += piece;
    buffer += piece;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      handle(buffer.slice(0, nl).replace(/\r$/, ''));
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) handle(buffer.replace(/\r$/, ''));
  if (!sawSse && raw.trim()) {
    try {
      const evt = JSON.parse(raw);
      if (evt && typeof evt === 'object') onData(evt);
    } catch {
      /* neither SSE nor JSON -- nothing usable */
    }
  }
}

// Text from an OpenAI-compatible content field: a plain string, or an array
// of content parts ([{ type: 'text', text }]) as some servers send.
function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return '';
}

// Pulls the answer text and the reasoning ("thinking") text out of one
// streamed chunk -- streaming deltas, a full non-streamed message, or the
// legacy completions `text` field, whichever the server sends.
function readChoice(choice) {
  const delta = choice.delta || {};
  const message = choice.message || {};
  return {
    content: contentText(delta.content) || contentText(message.content) || (typeof choice.text === 'string' ? choice.text : ''),
    reasoning: contentText(delta.reasoning_content) || contentText(delta.reasoning)
      || contentText(message.reasoning_content) || contentText(message.reasoning),
  };
}

// One attempt against one provider. Never logs the API key. Throws on any
// failure; stream() below decides whether that's worth falling back from.
//
// timeoutMs guards against exactly what nothing else here could catch: the
// provider accepts the connection and then never sends a token (a hung local
// model "thinking" forever, or a dead upstream that never closes the
// socket). Without this, such a request waits forever -- the caller's own
// signal only fires if the USER cancels, which they can't do if they don't
// know it's stuck rather than just slow. This is a separate, internal signal
// from the caller's: a timeout must still let stream() fall back to SCX
// exactly like any other MELDCX failure, which only checks the CALLER's
// signal to decide that -- see the `signal?.aborted` check below there.
//
// `stall` (MELDCX only -- see stream()) adds a watchdog on top of that overall
// cap, so a stuck request is abandoned in seconds instead of waiting out a
// Builder's 15-minute limit: it cancels when nothing at all (no answer, no
// reasoning) has streamed for `idleMs`, or when no answer text has started
// within `firstOutputMs` (a model thinking on and on without ever answering).
// Once real answer text is flowing, only the idle check applies.
async function attemptStream(provider, { model, system, messages, maxTokens, onText, signal, timeoutMs, stall = null }) {
  const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : null;
  const stallAc = stall ? new AbortController() : null;
  const combinedSignal = AbortSignal.any([signal, timeoutSignal, stallAc?.signal].filter(Boolean));
  const started = Date.now();
  let lastActivity = started;
  let streaming = false; // has the model sent anything yet (answer or reasoning)?
  let answering = false;
  let stallReason = '';
  // Reading the prompt comes before any output, so the "no answer yet" limit
  // grows with the prompt's size, and the silence check only starts once the
  // model has begun streaming.
  const promptChars = system.length + messages.reduce((n, m) => n + String(m.content || '').length, 0);
  const firstOutputMs = stall ? stall.firstOutputMs + Math.round(promptChars / 4000) * stall.perKTokenMs : 0;
  const watchdog = stall && setInterval(() => {
    const now = Date.now();
    if (streaming && now - lastActivity > stall.idleMs) stallReason = `sent nothing for ${Math.round(stall.idleMs / 1000)}s`;
    else if (!answering && now - started > firstOutputMs) stallReason = `started no answer within ${Math.round(firstOutputMs / 1000)}s`;
    if (stallReason) stallAc.abort();
  }, STALL_CHECK_MS);
  const stalled = () => Boolean(stallReason) && !signal?.aborted;
  try {

    let res;
    try {
      res = await fetch(`${provider.baseUrl.replace(/\/(chat\/completions)?\/?$/, '')}/chat/completions`, {
        method: 'POST',
        signal: combinedSignal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify({
          model,
          stream: true,
          max_tokens: Math.min(maxTokens + REASONING_HEADROOM, MAX_COMPLETION),
          messages: [{ role: 'system', content: system }, ...messages],
        }),
      });
    } catch (err) {
      // Node/undici raises a TimeoutError (not AbortError) specifically for an
      // AbortSignal.timeout()-sourced abort -- checked for by name, not
      // instanceof, since it's a DOMException, not our own class.
      if (stalled()) throw new Error(`${provider.name} stalled (${stallReason}) and was cancelled.`);
      if ((err.name === 'AbortError' || err.name === 'TimeoutError') && !signal?.aborted) {
        throw new Error(`${provider.name} did not respond within ${Math.round(timeoutMs / 1000)}s and was cancelled. Try again, or try a different/faster model.`);
      }
      throw err;
    }
    if (!res.ok) await failFromResponse(res, provider.name);

    let text = '';
    let reasoning = '';
    let stopReason = null;
    try {
      await readSse(res, (evt) => {
        if (DEBUG_STREAM) console.log(`[${provider.name} stream]`, JSON.stringify(evt));
        if (evt.error) throw new Error(`${provider.name} error: ${evt.error.message || evt.error || 'stream failed'}`);
        const choice = evt.choices?.[0];
        if (!choice) return;
        // The answer streams to the caller in real time. Reasoning ("thinking")
        // is kept aside: normally never shown, but used below if it's all the
        // model sent, rather than losing the reply.
        const { content, reasoning: thought } = readChoice(choice);
        if (content || thought) { // real output resets the stall watchdog
        streaming = true;
        lastActivity = Date.now();
      }
        if (content) {
          answering = true;
          text += content;
          onText?.(content);
        }
        if (thought) reasoning += thought;
        if (choice.finish_reason) stopReason = choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason;
      });
    } catch (err) {
      // Whatever text streamed in before this provider died is attached to the
      // error (never thrown away) -- a caller that knows how to resume a
      // partial generation (see orchestrator.js's Builder continuation loop)
      // can pick up from here instead of starting over from nothing.
      let wrapped = err;
      if (stalled()) wrapped = new Error(`${provider.name} stalled mid-stream (${stallReason}) and was cancelled.`);
      else if ((err.name === 'AbortError' || err.name === 'TimeoutError') && !signal?.aborted) {
        wrapped = new Error(`${provider.name} stopped responding mid-stream after ${Math.round(timeoutMs / 1000)}s and was cancelled.`);
      }
      wrapped.partialText = text;
      throw wrapped;
    }

    // Some models/servers put the whole answer in reasoning_content and leave
    // content empty -- use it rather than report an empty response.
    if (!text.trim() && reasoning.trim()) {
      console.warn(`[llm] ${provider.name} sent only reasoning_content; using it as the response`);
      text = reasoning;
      onText?.(reasoning);
    }
    if (!text.trim()) {
      throw new Error(
        stopReason === 'max_tokens'
          ? 'The model ran out of tokens while thinking and produced no answer. Try again or choose a different model.'
          : 'The model returned an empty response. Please try again.',
      );
    }
    return { text, stopReason };
  } finally {
    if (watchdog) clearInterval(watchdog);
  }
}

// Streams a chat completion. MELDCX is always tried first; only if it's
// missing a key, unreachable, or errors does this retry once against SCX
// (with SCX's own model, not the MELDCX one the caller passed) before
// giving up. Resolves with the full text and the stop reason ("max_tokens"
// when the output was cut off) -- identical shape regardless of which
// provider actually answered.
async function stream({ model, system, messages, maxTokens = 4096, onText, signal, timeoutMs = 120000, skipMeldcx = false }) {
  const meldcx = meldcxConfig();
  const scx = scxConfig();

  // Fall back only before any content has reached the caller. Once a token
  // has streamed into the chat, switching providers mid-response would show
  // a corrupted, duplicated reply -- so a failure past that point is always
  // just propagated (with whatever partial text it managed -- see
  // attemptStream's catch block -- attached for a caller that can resume a
  // partial generation itself, such as the Builder's continuation loop),
  // exactly as before this fallback existed. A timeout is just another
  // failure by this point -- it falls back exactly the same way.
  let emitted = false;
  const guardedOnText = (piece) => {
    emitted = true;
    onText?.(piece);
  };

  if (meldcx.apiKey && !skipMeldcx) {
    console.log(`[llm] provider=meldcx model=${model}`);
    try {
      console.log('bading',{model, system, messages} )
      return await attemptStream(meldcx, { model, system, messages, maxTokens, onText: guardedOnText, signal, timeoutMs, stall: STALL });
    } catch (err) {
      if (signal?.aborted || emitted) throw err;
      console.warn(`[llm] meldcx unavailable (${err.message}); falling back to provider=scx`);
    }
  } else if (!skipMeldcx) {
    console.warn('[llm] MELDCX_API_KEY not set; falling back to provider=scx');
  }

  if (!scx.apiKey) {
    throw new Error(
      'No AI provider is available. Set MELDCX_API_KEY (and/or SCX_API_KEY as a fallback) in .env, and restart the server.',
    );
  }
  console.log(`[llm] provider=scx model=${scx.model}`);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await attemptStream(scx, { model: scx.model, system, messages, maxTokens, onText: guardedOnText, signal, timeoutMs });
    } catch (err) {
      // A brief SCX outage (rate limit / gateway / "temporarily unavailable")
      // gets one more try after a short pause -- only before any text has
      // reached the caller, and never after Stop.
      if (attempt < 2 && !signal?.aborted && !emitted && TRANSIENT_STATUS.has(err.status)) {
        console.warn(`[llm] scx temporarily unavailable (${err.message}); retrying in ${TRANSIENT_RETRY_MS / 1000}s`);
        await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_MS));
        if (!signal?.aborted) continue;
      }
      if (!(signal?.aborted)) console.error(`[llm] scx fallback also failed (${err.message})`);
      throw err;
    }
  }
}

module.exports = { MODELS, stream, hasKey };
