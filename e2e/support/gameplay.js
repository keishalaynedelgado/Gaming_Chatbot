'use strict';
// Gameplay checks for the three saved prompts. Each game is freshly generated
// by the model on every run, so the checks are written against what its
// prompt promises (controls, rules, win/lose), observed only through the
// running game: readable text (DOM + canvas), screenshots and input.
const { test, expect } = require('@playwright/test');
const {
  readText, probeCounters, snapshot, diff, colourCount, changesOver, waitForText, newLine, control, clickControl, mainCanvas,
} = require('./gameProbe');

const START = /^\W*(start|play|begin|new game|start game|play now|let'?s play|play game|tap to (start|play))\b/i;
const RESTART = /(play again|restart|retry|try again|replay|new game|start over|reset)/i;
const GAME_OVER = /game\s*over|you\s*(crashed|died|lost|lose)|\bcrash(ed)?!?$|you\s*were\s*(hit|caught)|\bcaught\b|try again|play again|\bretry\b/i;

// Runs one named check as a report step. A failure is recorded (and shown as
// a failed step) but doesn't stop the remaining checks; the test fails at
// the end if any required check failed.
async function check(ctx, name, fn) {
  try {
    const detail = await test.step(name, fn);
    ctx.checks.record(name, 'PASS', typeof detail === 'string' ? detail : '');
    return true;
  } catch (err) {
    ctx.checks.record(name, 'FAIL', String(err.message || err).split('\n').filter(Boolean).slice(0, 3).join(' '));
    return false;
  }
}

const notReached = (ctx, name, why) => ctx.checks.record(name, 'NOT REACHED', why);
const notVerified = (ctx, name, why) => ctx.checks.record(name, 'NOT VERIFIED', why);

async function centre(game) {
  const canvas = await mainCanvas(game);
  const box = canvas ? await canvas.boundingBox() : null;
  const vp = game.viewportSize();
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: vp.width / 2, y: vp.height / 2 };
}

// Brings the game to the state right before play: its start/menu button if it
// has one (otherwise the first key press starts it, which the callers do).
async function pressStartButton(game) {
  return (await clickControl(game, START)) ? 'start button' : null;
}

// From an end screen back to play: a restart control if there is one, else
// the usual keys. Returns how, or null if nothing cleared `stillOver`.
async function restart(game, stillOver) {
  await game.waitForTimeout(1200); // many games ignore input briefly on the end screen
  const attempts = [
    ['restart button', () => clickControl(game, RESTART)],
    ['Space key', () => game.keyboard.press('Space').then(() => true)],
    ['Enter key', () => game.keyboard.press('Enter').then(() => true)],
    ['R key', () => game.keyboard.press('r').then(() => true)],
    ['click', async () => { const c = await centre(game); await game.mouse.click(c.x, c.y); return true; }],
  ];
  for (const [how, act] of attempts) {
    if (!(await act())) continue;
    const cleared = await waitForText(game, (lines) => !stillOver(lines), { timeout: 2000 });
    if (cleared.value) return how;
  }
  return null;
}

// ------------------------------------------------------------------ Flappy Bird
// Prompt: Space/click/tap flaps, gravity pulls down, hitting a pipe or the
// ground (or leaving the top) ends the run, +1 per gap, restart.
async function flappyBird(ctx) {
  const { game, decoder } = ctx;
  const scoreLine = (lines) => lines.find((l) => /^\d{1,4}$/.test(l) || /score\W*\d+/i.test(l));

  // One run from a fresh page load (same seed, so every run starts
  // identically): start, then one Space press -- the flap that also starts
  // games without a start button. `extra(t0)` may add input mid-flight.
  // Returns the time from that press to the game-over screen.
  async function run(label, extra) {
    await game.reload();
    await game.waitForLoadState('load');
    await game.waitForTimeout(800);
    const how = await pressStartButton(game);
    if (how) await game.waitForTimeout(300);
    await game.keyboard.press('Space');
    const t0 = Date.now();
    const baseline = await readText(game);
    const extraDone = extra ? extra(t0) : Promise.resolve();
    const over = await waitForText(game, (lines) => newLine(lines, GAME_OVER, baseline), { timeout: 15000, interval: 40 });
    await extraDone;
    return { label, how, baseline, gameOver: over.value, elapsed: over.elapsed, lines: over.lines };
  }

  let first = null;
  await check(ctx, 'Starts and runs (Space starts play; the scene animates)', async () => {
    await game.reload();
    await game.waitForLoadState('load');
    await game.waitForTimeout(800);
    const menu = (await readText(game)).filter((l) => /press|tap|click|space|start|play/i.test(l));
    const how = await pressStartButton(game);
    if (how) await game.waitForTimeout(300);
    await game.keyboard.press('Space');
    await game.waitForTimeout(150);
    const moving = await changesOver(game, decoder, 300, 0.05);
    const after = await readText(game);
    const menuGone = menu.length > 0 && menu.every((l) => !after.includes(l));
    expect(menuGone || moving.changed, `the start screen goes away or the picture moves (start text ${JSON.stringify(menu)}, now ${JSON.stringify(after.slice(0, 6))}, pixel change ${moving.amount.toFixed(2)})`).toBe(true);
    expect(moving.changed, `the scene animates during play (mean pixel change ${moving.amount.toFixed(2)})`).toBe(true);
    return `${how ? 'start button, then ' : ''}Space; ${menuGone ? 'start screen gone; ' : ''}picture change ${moving.amount.toFixed(2)}`;
  });

  await check(ctx, 'Gravity and collision end the run (game over without flapping)', async () => {
    first = await run('no extra input');
    expect(first.gameOver, `a game-over screen appears without input. Readable text: ${JSON.stringify(first.lines.slice(0, 12))}`).toBeTruthy();
    return `"${first.gameOver}" after ${first.elapsed} ms`;
  });

  await check(ctx, 'Score is displayed', async () => {
    const line = scoreLine(first ? first.baseline : await readText(game)) || scoreLine(first?.lines || []);
    expect(line, 'a score (a number, or "Score: n") is readable during play or on the game-over screen').toBeTruthy();
    return `"${line}"`;
  });

  if (first?.gameOver) {
    await check(ctx, 'Restart from the game-over screen', async () => {
      const how = await restart(game, (lines) => Boolean(newLine(lines, GAME_OVER, first.baseline)));
      expect(how, 'the game-over screen goes away after restart input').toBeTruthy();
      const moving = await changesOver(game, decoder, 300, 0.05);
      expect(moving.changed, 'the game animates again after restarting').toBe(true);
      return `via ${how}`;
    });

    // One flap early in the fall must keep the bird up noticeably longer than
    // not flapping at all (same seed, so the same starting state). Early,
    // because the measured time also includes any death animation before the
    // game-over screen.
    const t = first.elapsed;
    const flapAt = Math.min(450, Math.max(150, Math.round(t * 0.2)));
    for (const [name, flap] of [
      ['Flap with Space keeps the bird airborne longer', () => game.keyboard.press('Space')],
      ['Flap with a mouse click keeps the bird airborne longer', async () => { const c = await centre(game); await game.mouse.click(c.x, c.y); }],
    ]) {
      await check(ctx, name, async () => {
        const r = await run(name, async (t0) => {
          await game.waitForTimeout(Math.max(0, flapAt - (Date.now() - t0)));
          await flap();
        });
        expect(r.gameOver, 'the run still ends in a game over').toBeTruthy();
        expect(r.elapsed, `with one flap at ${flapAt} ms the run lasted ${r.elapsed} ms vs ${t} ms without`).toBeGreaterThan(t + 250);
        return `${r.elapsed} ms with the flap vs ${t} ms without`;
      });
    }
  } else {
    for (const n of ['Restart from the game-over screen', 'Flap with Space keeps the bird airborne longer', 'Flap with a mouse click keeps the bird airborne longer']) {
      notReached(ctx, n, 'no game-over screen was reached');
    }
  }

  notVerified(ctx, 'Score +1 per pipe gap passed / speed-up over time', 'needs a bot that can steer through pipes; the generated code exposes no game state to steer by');
}

// ------------------------------------------------------------- Snake and Ladder
// Prompt: 1-100 board with snakes and ladders, players take turns rolling one
// die, first to land exactly on 100 wins.
async function snakeAndLadder(ctx) {
  const { game, decoder } = ctx;
  // "Player 2 Wins!", "You win!" -- but not a rule or hint like "Exact roll needed to win!".
  const WIN_RE = /\b(wins|winner|won|victory|congratulations|champion)\b|\byou\s+win\b/i;
  const WIN = { test: (l) => WIN_RE.test(l) && !/\bto win\b|\bneed/i.test(l) };
  const boardNumbers = (lines) => {
    const seen = new Set();
    for (const l of lines) for (const m of l.matchAll(/\b(\d{1,3})\b/g)) if (+m[1] >= 1 && +m[1] <= 100) seen.add(+m[1]);
    return seen;
  };

  let started = '';
  await check(ctx, 'Board shows squares 1-100', async () => {
    let lines = await readText(game);
    if (boardNumbers(lines).size < 90) {
      started = (await pressStartButton(game)) || '';
      await game.waitForTimeout(800);
      lines = await readText(game);
    }
    const seen = boardNumbers(lines);
    expect(seen.has(1) && seen.has(100), 'squares 1 and 100 are labelled').toBe(true);
    expect(seen.size, 'at least 90 of the squares 1-100 are labelled').toBeGreaterThanOrEqual(90);
    return `${seen.size}/100 squares labelled${started ? ` (after ${started})` : ''}`;
  });
  if (!started) started = (await pressStartButton(game)) || '';

  const baseline = await readText(game);
  // Roll with the visible Roll control, else Space.
  let mode = null;
  async function roll() {
    const btn = control(game, /roll/i);
    if (mode !== 'key') {
      try {
        await expect(btn.first()).toBeVisible({ timeout: mode ? 15000 : 3000 });
        await expect(btn.first()).toBeEnabled({ timeout: 15000 });
        await btn.first().click({ timeout: 5000 });
        mode = 'roll button';
        return;
      } catch (err) {
        if (mode === 'roll button') throw err;
      }
    }
    mode = 'key';
    await game.keyboard.press('Space');
  }

  await check(ctx, 'Rolling the die changes the game', async () => {
    const beforeText = await readText(game);
    const before = await snapshot(game, decoder);
    await roll();
    let changed = false;
    let amount = 0;
    for (let i = 0; i < 20 && !changed; i += 1) {
      await game.waitForTimeout(150);
      const textChanged = (await readText(game)).join('\n') !== beforeText.join('\n');
      amount = diff(before, await snapshot(game, decoder));
      changed = textChanged || amount > 0.3;
    }
    expect(changed, 'the text or the picture changes after a roll').toBe(true);
    return `rolled with the ${mode}; picture change ${amount.toFixed(2)}`;
  });

  // Keep rolling until somebody wins (a pure luck game; usually well under
  // 150 rolls). Snake/ladder messages are noted along the way.
  const maxMs = Number(process.env.E2E_SNAKE_MAX_MINUTES || 8) * 60 * 1000;
  let winLine = null;
  let rolls = 1;
  const events = new Set();
  await check(ctx, 'Game is played to a winner', async () => {
    const until = Date.now() + maxMs;
    while (!winLine && Date.now() < until && rolls < 600) {
      await roll();
      rolls += 1;
      await game.waitForTimeout(120);
      const lines = await readText(game);
      for (const l of lines) if (/ladder|snake|climb|slid|bitten/i.test(l) && !baseline.includes(l)) events.add(l);
      winLine = newLine(lines, WIN, baseline);
    }
    expect(winLine, `a winner is announced within ${rolls} rolls`).toBeTruthy();
    return `"${winLine}" after ${rolls} rolls`;
  });
  if (events.size) ctx.checks.record('Snake/ladder moves announced (informational)', 'PASS', [...events].slice(0, 4).map((e) => `"${e}"`).join(', '));
  else notVerified(ctx, 'Snakes and ladders move the token', 'no snake/ladder message was shown; token positions on the board are not readable');

  if (winLine) {
    const restartControl = control(game, RESTART);
    if (await restartControl.count()) {
      await check(ctx, 'Restart after the game ends', async () => {
        const how = await restart(game, (lines) => Boolean(newLine(lines, WIN, baseline)));
        expect(how, 'the winner message goes away after restarting').toBeTruthy();
        return `via ${how}`;
      });
    } else {
      notVerified(ctx, 'Restart after the game ends', 'no restart / play-again control is shown (the prompt does not ask for one)');
    }
  } else {
    notReached(ctx, 'Restart after the game ends', 'no winner was reached');
  }
}

// --------------------------------------------------------------- Collect & Dodge
// Prompt: arrow keys move in four directions, collect every item, getting hit
// by an enemy loses, collecting all wins.
async function collectAndDodge(ctx) {
  const { game, decoder } = ctx;
  const WIN = /you\s*win|win!|level\s*(complete|cleared)|all\b.*\b(collected|cleared)|\bcleared\b|victory|well done|congratulations/i;
  const counter = (lines) => {
    for (const l of lines) {
      if (/level|lvl|lives?|wave|stage|\bhp\b|health/i.test(l)) continue;
      const m = l.match(/(\d+)\s*\/\s*(\d+)/);
      if (m) return { value: +m[1], total: +m[2], line: l };
    }
    for (const l of lines) {
      const m = l.match(/(score|items?|collected|coins?|gems?|stars?|points?|orbs?)\W{0,3}(\d+)/i);
      if (m) return { value: +m[2], line: l };
    }
    return null;
  };

  let baseline = [];
  await check(ctx, 'Starts and runs', async () => {
    const how = (await pressStartButton(game)) || 'Enter key';
    if (how === 'Enter key') await game.keyboard.press('Enter');
    await game.waitForTimeout(500);
    baseline = await readText(game);
    const moving = await changesOver(game, decoder, 600, 0.03);
    expect(moving.changed, `the game animates after starting (enemies move; mean pixel change ${moving.amount.toFixed(2)})`).toBe(true);
    return `via ${how}; picture change ${moving.amount.toFixed(2)}`;
  });

  let start = null;
  await check(ctx, 'Collected-items counter is displayed', async () => {
    start = counter(await readText(game));
    expect(start, `an item counter or score is readable. Text: ${JSON.stringify(baseline.slice(0, 12))}`).toBeTruthy();
    return `"${start.line}"`;
  });

  // Sweep the level with held arrow keys (boustrophedon, then back up) until
  // items get collected and an end screen (hit or win) has been seen. A hit
  // before anything was collected is restarted and play continues.
  const segments = [];
  for (let i = 0; i < 4; i += 1) segments.push(['ArrowRight', 900], ['ArrowDown', 220], ['ArrowLeft', 900], ['ArrowDown', 220]);
  for (let i = 0; i < 4; i += 1) segments.push(['ArrowRight', 900], ['ArrowUp', 220], ['ArrowLeft', 900], ['ArrowUp', 220]);
  const maxMs = Number(process.env.E2E_COLLECT_MAX_SECONDS || 120) * 1000;
  let best = start ? start.value : 0;
  let collectedLine = null;
  let lost = null;
  let won = null;
  let earlyRestart = null; // a restart after a hit with nothing collected yet
  const until = Date.now() + maxMs;
  for (let i = 0; Date.now() < until && !(collectedLine && (lost || won)); i += 1) {
    const [key, ms] = segments[i % segments.length];
    await game.keyboard.down(key);
    await game.waitForTimeout(ms);
    await game.keyboard.up(key);
    const lines = await readText(game);
    const c = counter(lines);
    if (c && c.value > best) { best = c.value; collectedLine = c.line; }
    const hit = newLine(lines, GAME_OVER, baseline);
    const win = newLine(lines, WIN, baseline);
    if (win && !won) won = win;
    if (hit && !lost) {
      lost = { line: hit, counter: c };
      if (!collectedLine) {
        earlyRestart = await restart(game, (l) => Boolean(newLine(l, GAME_OVER, baseline)));
        if (!earlyRestart) break; // reported by the restart check below
        if (await control(game, START).count()) await pressStartButton(game);
        best = start ? start.value : 0;
        lost = null;
      }
    }
  }

  await check(ctx, 'Arrow keys move the player and collecting raises the counter', async () => {
    expect(collectedLine, `the counter rose above ${start ? start.value : 0} while sweeping with the arrow keys`).toBeTruthy();
    return `counter reached "${collectedLine}"`;
  });

  await check(ctx, 'An end state is reached (hit by an enemy, or everything collected)', async () => {
    expect(lost || won, `a hit/game-over or win screen appeared within ${maxMs / 1000}s of play`).toBeTruthy();
    return lost ? `hit: "${lost.line}"` : `win: "${won}"`;
  });

  if (lost || won) {
    await check(ctx, 'Restart resets the round', async () => {
      const how = await restart(game, (l) => Boolean(newLine(l, lost ? GAME_OVER : WIN, baseline)));
      expect(how, 'restart input clears the end screen').toBeTruthy();
      if (await control(game, START).count()) await pressStartButton(game);
      await game.waitForTimeout(500);
      const c = counter(await readText(game));
      expect(c, 'the counter is shown again after restarting').toBeTruthy();
      expect(c.value, `the counter is back to its starting value (${start ? start.value : 0})`).toBeLessThanOrEqual(start ? start.value : 0);
      return `via ${how}; counter "${c.line}"`;
    });
  } else {
    notReached(ctx, 'Restart resets the round', 'no end screen was reached');
  }
}

// Shared by all three: the page loaded, isn't blank, and isn't stuck loading.
async function verifyRenders(game, decoder) {
  const deadline = Date.now() + 20000;
  let s;
  let lines = [];
  let counters;
  for (;;) {
    s = await snapshot(game, decoder);
    lines = await readText(game);
    counters = await probeCounters(game);
    const colours = colourCount(s);
    const hasContent = colours >= 4 && (counters.draws > 0 || lines.length > 0 || (await game.locator('body *').filter({ visible: true }).count()) > 0);
    const loading = lines.length > 0 && lines.every((l) => /loading|please wait|^\.+$/i.test(l));
    if (hasContent && !loading) {
      return { colours, lines, counters, canvas: Boolean(await mainCanvas(game)), png: s.png };
    }
    if (Date.now() > deadline) {
      throw new Error(`The game page stayed ${loading ? 'on a loading screen' : 'blank'} for 20s (${colours} colours, ${counters.draws} canvas draws, text: ${JSON.stringify(lines.slice(0, 8))})`);
    }
    await game.waitForTimeout(500);
  }
}

module.exports = { flappyBird, snakeAndLadder, collectAndDodge, verifyRenders };
