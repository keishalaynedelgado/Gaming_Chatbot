'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader so the project needs no dependencies. The .env file lives
// at the repo root (shared config, not backend-only source), three levels up
// from here (utils -> src -> backend -> root).
function load(file = path.join(__dirname, '..', '..', '..', '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    if (value !== '' && !(m[1] in process.env)) process.env[m[1]] = value;
  }
}

module.exports = { load };
