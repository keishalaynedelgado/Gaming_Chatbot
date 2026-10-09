'use strict';
const dgram = require('node:dgram');
const os = require('node:os');
const zlib = require('node:zlib');
const { AsyncLocalStorage } = require('node:async_hooks');

// Application logger: prints to the console exactly as before, and -- when
// GRAYLOG_HOST is set -- also sends each entry to Graylog as a GELF message
// over UDP. UDP is fire-and-forget on purpose: a slow, stopped or missing
// Graylog can never delay a request or crash the app; at worst a log line is
// lost. No dependency needed -- GELF is just (gzipped) JSON in a datagram.
//
// Every entry carries an `event` name (e.g. llm_request_failed) plus
// structured fields, which is what Graylog's streams and event definitions
// match on. The request/session the code is running for is attached
// automatically (see `context` below), so callers never pass it around.

const APP = 'game-chatbot';
const LEVELS = { error: 3, warn: 4, info: 6, debug: 7 }; // syslog severities, as GELF expects
const MAX_DATAGRAM = 8192; // larger UDP datagrams would need GELF chunking; trimmed below instead

// Never sent to Graylog, whatever a caller passes: credentials by key name...
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential/i;
// ...and by shape, inside any string (error messages can quote a URL or header).
const SCRUB = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, '$1***:***@'], // user:password@ in a URL
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***'],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '$1-***'],
];
const scrub = (s) => SCRUB.reduce((out, [re, to]) => out.replace(re, to), String(s));

// The request (and, once known, the chat session) the current code runs for.
// server.js opens one per HTTP request; anything awaited inside it -- the
// orchestrator, the LLM calls, the database -- logs with the same ids.
const context = new AsyncLocalStorage();

let socket = null;
let pending = 0;
let idle = null; // resolves flush() once every queued datagram has gone out
const target = () => {
  const host = process.env.GRAYLOG_HOST;
  return host ? { host, port: Number(process.env.GRAYLOG_PORT) || 12201 } : null;
};

function send(gelf) {
  const to = target();
  if (!to) return;
  let buf = zlib.gzipSync(JSON.stringify(gelf));
  if (buf.length > MAX_DATAGRAM) {
    delete gelf.full_message;
    buf = zlib.gzipSync(JSON.stringify(gelf));
    if (buf.length > MAX_DATAGRAM) return;
  }
  if (!socket) {
    socket = dgram.createSocket('udp4');
    socket.on('error', () => {}); // logging must never take the app down
    socket.unref(); // nor keep the process alive on its own
  }
  pending += 1;
  socket.send(buf, to.port, to.host, () => {
    pending -= 1;
    if (!pending && idle) { idle(); idle = null; }
  });
}

function fieldsFrom(extra) {
  const out = {};
  for (const [key, value] of Object.entries({ ...context.getStore(), ...extra })) {
    if (value === undefined || value === null || SECRET_KEY.test(key)) continue;
    const name = key.replace(/[^\w.-]/g, '_');
    if (name === 'id') continue; // `_id` is reserved by GELF
    if (value instanceof Error) {
      out._error = scrub(value.message).slice(0, 2000);
      out._error_name = value.name;
      if (value.code) out._error_code = String(value.code);
    } else {
      // GELF fields are strings or numbers only: Graylog drops a JSON boolean,
      // so it goes as "true"/"false" (searchable as e.g. llm_timeout:true).
      out[`_${name}`] = typeof value === 'number' ? value : scrub(value).slice(0, 2000);
    }
  }
  return out;
}

// log.error('[llm] scx fallback also failed', { event: 'llm_request_failed', provider: 'scx', err })
// The console line is `message` (plus the error's message, if one is given
// and isn't in the text already); the Graylog entry gets every field.
function write(level, message, fields = {}) {
  const err = fields.err instanceof Error ? fields.err : null;
  const line = err && !message.includes(err.message) ? `${message}: ${err.message}` : message;
  const out = level === 'info' || level === 'debug' ? console.log : console[level];
  out(line);
  if (!target()) return;
  send({
    version: '1.1',
    host: os.hostname(),
    short_message: scrub(line).slice(0, 1000),
    ...(err?.stack ? { full_message: scrub(err.stack).slice(0, 6000) } : {}),
    timestamp: Date.now() / 1000,
    level: LEVELS[level],
    _app: APP,
    _env: process.env.NODE_ENV || 'development',
    _level_name: level,
    ...fieldsFrom(fields),
  });
}

// Adds ids to the current request's context (e.g. the chat session, once the
// body has been read), so later log lines in that request carry them.
function setContext(values) {
  const store = context.getStore();
  if (store) Object.assign(store, values);
}

// Resolves once queued Graylog messages are sent -- for the moment just
// before process.exit(), which would otherwise drop them.
function flush(timeoutMs = 1000) {
  if (!pending) return Promise.resolve();
  return new Promise((resolve) => {
    idle = resolve;
    setTimeout(resolve, timeoutMs).unref();
  });
}

module.exports = {
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
  context,
  setContext,
  flush,
};
