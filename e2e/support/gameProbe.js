'use strict';
// Generic, read-only observation of a generated game. Every build is new
// model-written code, so nothing here may depend on a particular file, class
// or variable: the tests only look at what any build exposes -- its DOM text,
// the text it draws on a <canvas>, what it looks like (screenshots) and the
// errors it throws.

// Installed (via context.addInitScript) before any of the game's own code
// runs, on game pages only (/games/...). It never changes how the game
// behaves, with one deliberate exception: Math.random is seeded, so pipe gaps,
// dice rolls and enemy spawns repeat run to run instead of making the
// gameplay checks flaky.
function probeInitScript(seed) {
  if (!/^\/games\//.test(location.pathname) || window.__probe) return;
  const probe = { draws: 0, frames: 0 };
  Object.defineProperty(window, '__probe', { value: probe });

  // mulberry32
  let s = seed >>> 0;
  Math.random = function random() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Text drawn on a canvas, per canvas: `last` is the last complete frame,
  // `current` the frame being drawn now; visible text is the union of the
  // two. A frame is one animation frame in which the canvas was drawn on (a
  // canvas left untouched keeps its last frame, as a static board does);
  // games that don't use requestAnimationFrame get a new frame on each
  // full-canvas clear/fill instead.
  const frames = new WeakMap();
  const canvases = new Set();
  const frameOf = (ctx) => {
    let f = frames.get(ctx.canvas);
    if (!f) {
      f = { last: new Set(), current: new Set(), drawn: false };
      frames.set(ctx.canvas, f);
      canvases.add(ctx.canvas);
    }
    f.drawn = true;
    return f;
  };
  const nextFrame = (f) => {
    f.last = f.current;
    f.current = new Set();
    f.drawn = false;
  };
  let frameTime = null;
  const onAnimationFrame = (t) => {
    if (t === frameTime) return; // several callbacks share one frame
    frameTime = t;
    for (const c of canvases) {
      const f = frames.get(c);
      if (f.drawn) nextFrame(f);
    }
  };
  const coversCanvas = (ctx, w, h) => {
    try {
      const m = ctx.getTransform();
      return Math.abs(w * m.a) >= ctx.canvas.width * 0.9 && Math.abs(h * m.d) >= ctx.canvas.height * 0.9;
    } catch {
      return false;
    }
  };
  const P = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
  if (P) {
    for (const name of ['fillText', 'strokeText']) {
      const orig = P[name];
      P[name] = function drawText(text, ...rest) {
        probe.draws += 1;
        frameOf(this).current.add(String(text));
        return orig.call(this, text, ...rest);
      };
    }
    for (const name of ['clearRect', 'fillRect']) {
      const orig = P[name];
      P[name] = function drawRect(x, y, w, h) {
        probe.draws += 1;
        const f = frameOf(this);
        if (probe.frames === 0 && coversCanvas(this, w, h)) nextFrame(f);
        return orig.call(this, x, y, w, h);
      };
    }
    for (const name of ['drawImage', 'fill', 'stroke', 'putImageData']) {
      const orig = P[name];
      P[name] = function draw(...args) {
        probe.draws += 1;
        frameOf(this);
        return orig.apply(this, args);
      };
    }
  }
  const raf = window.requestAnimationFrame;
  if (raf) {
    window.requestAnimationFrame = function requestAnimationFrame(cb) {
      return raf.call(window, (t) => {
        probe.frames += 1;
        onAnimationFrame(t);
        cb(t);
      });
    };
  }

  // Only text on canvases that are actually on the page and visible.
  probe.canvasText = () => {
    const out = new Set();
    for (const c of canvases) {
      if (!c.isConnected) continue;
      const r = c.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const f = frames.get(c);
      for (const t of f.last) out.add(t);
      for (const t of f.current) out.add(t);
    }
    return [...out];
  };
}

// Everything the player can currently read: the page's visible DOM text plus
// the text on its canvases, one entry per line, trimmed and de-duplicated.
async function readText(game) {
  const lines = await game.evaluate(() => {
    const dom = (document.body?.innerText || '').split('\n');
    const canvas = window.__probe ? window.__probe.canvasText() : [];
    return [...dom, ...canvas];
  });
  return [...new Set(lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

async function probeCounters(game) {
  return game.evaluate(() => ({ draws: window.__probe?.draws ?? 0, frames: window.__probe?.frames ?? 0 }));
}

// A screenshot of the game, reduced to a 32x32 colour grid. Decoding happens
// in a separate blank page of the same browser (the game's own page is
// sandboxed and may hold a tainted or WebGL canvas, so its pixels can't be
// read reliably from inside it).
async function snapshot(game, decoder) {
  const png = await game.screenshot({ caret: 'hide' });
  const grid = await decoder.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const N = 32;
    const c = document.createElement('canvas');
    c.width = N;
    c.height = N;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, N, N);
    return Array.from(ctx.getImageData(0, 0, N, N).data);
  }, png.toString('base64'));
  return { png, grid };
}

// Mean absolute per-channel difference between two snapshots (0..255).
function diff(a, b) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.grid.length; i += 4) {
    sum += Math.abs(a.grid[i] - b.grid[i]) + Math.abs(a.grid[i + 1] - b.grid[i + 1]) + Math.abs(a.grid[i + 2] - b.grid[i + 2]);
    n += 3;
  }
  return sum / n;
}

// How varied a snapshot is: the number of distinct (coarsely quantised)
// colours. A blank page or a single flat colour gives 1-2.
function colourCount(s) {
  const seen = new Set();
  for (let i = 0; i < s.grid.length; i += 4) seen.add(`${s.grid[i] >> 4},${s.grid[i + 1] >> 4},${s.grid[i + 2] >> 4}`);
  return seen.size;
}

// Did the picture change over `ms`? Used to tell a running game from a frozen one.
async function changesOver(game, decoder, ms, threshold = 0.5) {
  const a = await snapshot(game, decoder);
  await game.waitForTimeout(ms);
  const b = await snapshot(game, decoder);
  return { changed: diff(a, b) > threshold, amount: diff(a, b) };
}

// Polls `predicate(lines)` against the readable text until it returns a truthy
// value or `timeout` passes. Returns { value, lines, elapsed } -- value null on
// timeout. Short polls keep the measured times accurate.
async function waitForText(game, predicate, { timeout = 10000, interval = 50 } = {}) {
  const started = Date.now();
  let lines = [];
  for (;;) {
    lines = await readText(game);
    const value = predicate(lines);
    if (value) return { value, lines, elapsed: Date.now() - started };
    if (Date.now() - started >= timeout) return { value: null, lines, elapsed: Date.now() - started };
    await game.waitForTimeout(interval);
  }
}

// The first line matching `re` that was not already readable in `baseline`
// (so "Press R to restart" shown during play is never mistaken for a
// game-over screen).
function newLine(lines, re, baseline = []) {
  const before = new Set(baseline);
  return lines.find((l) => re.test(l) && !before.has(l)) || null;
}

// A visible, clickable control whose text matches `re` -- a real <button>,
// a role=button, a link, or a div styled as a button.
function control(game, re) {
  return game
    .locator('button, [role="button"], a, input[type="button"], input[type="submit"], [class*="btn" i], [class*="button" i]')
    .filter({ hasText: re })
    .filter({ visible: true });
}

async function clickControl(game, re) {
  const c = control(game, re);
  if (!(await c.count())) return false;
  await c.first().click({ timeout: 5000 });
  return true;
}

// The game's main canvas (the largest visible one), or null for a DOM game.
async function mainCanvas(game) {
  const all = game.locator('canvas').filter({ visible: true });
  const n = await all.count();
  let best = null;
  let bestArea = 0;
  for (let i = 0; i < n; i += 1) {
    const box = await all.nth(i).boundingBox();
    if (box && box.width * box.height > bestArea) {
      best = all.nth(i);
      bestArea = box.width * box.height;
    }
  }
  return best;
}

module.exports = {
  probeInitScript, readText, probeCounters, snapshot, diff, colourCount, changesOver, waitForText, newLine, control, clickControl, mainCanvas,
};
