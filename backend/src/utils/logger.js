'use strict';

// Application logger: prints each entry to the console. Callers pass a
// message plus optional structured fields (e.g. { event, err }); when an
// error is given and its message isn't in the text already, it's appended.

// log.error('[llm] scx fallback also failed', { event: 'llm_request_failed', provider: 'scx', err })
function write(level, message, fields = {}) {
  const err = fields.err instanceof Error ? fields.err : null;
  const line = err && !message.includes(err.message) ? `${message}: ${err.message}` : message;
  const out = level === 'info' ? console.log : console[level];
  out(line);
}

module.exports = {
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
};
