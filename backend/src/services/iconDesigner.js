'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const claude = require('./llm');
const prompts = require('./prompts');
const store = require('./store');
const appIcon = require('./appIcon');

// A game's own app icon, for its exported apps (see exporter.js): the AI
// draws it as an SVG from the game's design (prompts.ICON_DESIGNER), which is
// checked, then rendered to a PNG by Microsoft Edge in headless mode. Made
// once per game and kept beside its exports, so every later export (and every
// version) reuses it. Any failure falls back to the default icon -- an icon
// is never a reason for an export to fail.

const RENDER_SIZE = 768; // a whole multiple of every icon size used (256, 192, 48, 32, 16)

function iconDir(id) {
  return path.join(path.dirname(store.exportDir(id, 0)), 'icon');
}

function edgePath() {
  const candidates = [
    process.env.EXPORT_EDGE_PATH,
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

// Keeps only a plain, self-contained drawing: anything that could run,
// load or link something is rejected outright.
function cleanSvg(text) {
  const m = String(text || '').match(/<svg\b[\s\S]*?<\/svg>/i);
  if (!m || m[0].length > 60000) return null;
  const svg = m[0];
  if (/<(script|foreignObject|image|iframe|style|use|a)\b/i.test(svg)) return null;
  if (/\son\w+\s*=|javascript:|@import/i.test(svg)) return null;
  if (/href\s*=\s*["']\s*(?!#)/i.test(svg)) return null;
  if (/url\(\s*['"]?\s*(?!#)/i.test(svg)) return null;
  return svg.replace(/<svg\b([^>]*)>/i, (all, attrs) => {
    let a = attrs.replace(/\s(width|height)\s*=\s*["'][^"']*["']/gi, '');
    if (!/\bviewBox\s*=/i.test(a)) a += ' viewBox="0 0 512 512"';
    if (!/\bxmlns\s*=/i.test(a)) a += ' xmlns="http://www.w3.org/2000/svg"';
    return `<svg${a} width="${RENDER_SIZE}" height="${RENDER_SIZE}">`;
  });
}

async function designSvg(state, signal) {
  const { text } = await claude.stream({
    model: claude.MODELS.designer(),
    system: prompts.ICON_DESIGNER,
    messages: [{ role: 'user', content: prompts.iconUser(state) }],
    maxTokens: 8000,
    signal,
    timeoutMs: 120000,
    noThinking: true, // a simple drawing: without it the model can think for minutes first
  });
  const svg = cleanSvg(text);
  if (!svg) throw new Error('the AI did not return a usable SVG');
  return svg;
}

function render(svg, signal) {
  const edge = edgePath();
  if (!edge) return Promise.reject(new Error('Microsoft Edge was not found'));
  return (async () => {
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'askvi-icon-'));
    try {
      const html = path.join(work, 'icon.html');
      const out = path.join(work, 'icon.png');
      await fsp.writeFile(html, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`);
      await new Promise((resolve, reject) => {
        execFile(edge, [
          '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
          '--force-device-scale-factor=1', '--default-background-color=00000000',
          `--user-data-dir=${path.join(work, 'profile')}`, `--window-size=${RENDER_SIZE},${RENDER_SIZE}`,
          `--screenshot=${out}`, pathToFileURL(html).href,
        ], { signal, windowsHide: true, timeout: 60000 }, (err) => (err && !fs.existsSync(out) ? reject(err) : resolve()));
      });
      return await fsp.readFile(out);
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  })();
}

// The game's icon set (appIcon.fromPng), designing it first if needed.
// Returns { icon, designed } -- designed is false when the default is used.
async function gameIcon({ id, state, signal }) {
  const dir = iconDir(id);
  const pngFile = path.join(dir, 'icon.png');
  try {
    if (fs.existsSync(pngFile)) return { icon: appIcon.fromPng(await fsp.readFile(pngFile)), designed: true };
    const svg = await designSvg(state, signal);
    const png = await render(svg, signal);
    const icon = appIcon.fromPng(png); // also proves the render is readable
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'icon.svg'), svg);
    await fsp.writeFile(pngFile, png);
    return { icon, designed: true };
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn(`[iconDesigner] using the default icon for ${id}: ${err.message}`);
    return { icon: appIcon.defaultIcon(), designed: false };
  }
}

// The designed icon if the game has one, else the default -- never designs
// one, for the web app's pages, which are built on request (exporter.js).
async function savedIcon(id) {
  try {
    return appIcon.fromPng(await fsp.readFile(path.join(iconDir(id), 'icon.png')));
  } catch {
    return appIcon.defaultIcon();
  }
}

module.exports = { gameIcon, savedIcon, cleanSvg, render };
