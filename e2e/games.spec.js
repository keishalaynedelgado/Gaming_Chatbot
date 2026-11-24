'use strict';
// End-to-end: each of the three existing saved prompts is sent through the
// real chatbot UI, the real AI pipeline generates the game, and the generated
// game is played in its own tab. See e2e/README.md.
const { test, expect } = require('@playwright/test');
const chat = require('./support/chatbot');
const play = require('./support/gameplay');
const { probeInitScript } = require('./support/gameProbe');

// The three existing prompts, as listed under "Saved prompts" in the app.
// The prompt text itself is read from the app (GET /api/saved-prompts) at
// run time -- never copied here -- and `startsWith` pins that it is the
// right one. `id` is its identifier in the report.
const GAMES = [
  {
    id: 'sp-muf5h69r-sjfrmj',
    title: 'Flappy Bird',
    startsWith: '**Title**: Flappy Bird',
    play: play.flappyBird,
  },
  {
    id: 'sp-muf5qad8-95exbk',
    title: 'Snake and ladder',
    startsWith: 'Snake and Ladder is a simple board game',
    play: play.snakeAndLadder,
  },
  {
    id: '697f7a40-da6d-439d-82d4-2cc80889866d',
    title: 'Collect & Dodge',
    startsWith: '**Title**: *Collect & Dodge*',
    play: play.collectAndDodge,
  },
];

const SEED = Number(process.env.E2E_SEED || 20261015);
const GAMEPLAY_BUDGET_MS = 20 * 60 * 1000;

test.describe('Gaming Chatbot — generate and play the saved game prompts', () => {
  for (const g of GAMES) {
    test(`${g.title} [prompt ${g.id}]`, async ({ page, context, request }, testInfo) => {
      test.setTimeout(chat.GENERATION_TIMEOUT_MS + GAMEPLAY_BUDGET_MS);
      testInfo.annotations.push({ type: 'prompt', description: `${g.title} — saved prompt ${g.id}` });
      const checks = new chat.Checklist();
      const consoleLog = [];
      const pageErrors = [];
      const watch = (p, label) => {
        p.on('console', (m) => consoleLog.push(`[${label}] ${m.type()}: ${m.text()}`));
        p.on('pageerror', (e) => pageErrors.push(`[${label}] ${e.message}`));
      };
      watch(page, 'chat');
      await context.addInitScript(probeInitScript, SEED);

      let outcome = 'FAIL';
      let reason = '';
      let game = null;
      let generation = null;
      const stages = ['Prompt submitted', 'Game generation completed', 'Game workspace opened', 'Game rendered'];
      try {
        await test.step('Environment: chatbot backend reachable and AI key configured', () => chat.checkEnvironment(request));

        const prompt = await test.step('Find the existing saved prompt', () => chat.findSavedPrompt(request, g));
        await testInfo.attach('prompt.txt', { body: prompt.spec, contentType: 'text/plain' });
        const known = await chat.existingGameSessions(request);

        await test.step('Open the chatbot', () => chat.openChatbot(page));
        const popups = [];
        page.on('popup', (p) => popups.push(p));

        await test.step('Submit the prompt', async () => {
          await chat.loadSavedPrompt(page, prompt);
          await chat.submit(page, prompt);
        });
        checks.record('Prompt submitted', 'PASS', `"${prompt.title}" loaded from Saved prompts, sent, shown as the user's message`);

        generation = await test.step('Wait for game generation', async () => {
          const r = await chat.waitForGeneration(page);
          await testInfo.attach('chatbot-reply.txt', { body: `${r.progress || ''}\n\n${r.reply || ''}`.trim() || '(none)', contentType: 'text/plain' });
          if (!r.ok && r.kind === 'BLOCKED') throw new chat.BlockedError(`AI provider unavailable during generation: ${r.reason}`);
          expect(r.ok, r.reason).toBe(true);
          expect(r.reply, 'the game was generated, not loaded from an earlier build').not.toMatch(/has already been built|loaded instantly/i);
          return r;
        });
        checks.record('Game generation completed', 'PASS', `${Math.round(generation.elapsedMs / 1000)}s`);

        game = await test.step('Open the game workspace (its own tab)', async () => {
          const m = generation.gameUrl.match(/^\/games\/([\w-]+)\/index\.html\?v=(\d+)$/);
          expect(m, `game link ${generation.gameUrl}`).toBeTruthy();
          expect(known.has(m[1]), 'the game belongs to a new chat, not an existing game').toBe(false);
          expect(m[2], 'it is the first version of a new game').toBe('1');
          const res = await request.get(generation.gameUrl);
          expect(res.status(), 'the game page is served').toBe(200);
          // The app opens the tab itself when the build finishes; if that
          // didn't happen, click the chat's "Open game in new tab" link.
          let tab = popups.find((p) => p.url().includes(generation.gameUrl));
          if (!tab) {
            const [opened] = await Promise.all([
              page.waitForEvent('popup'),
              page.locator('#messages a.game-link', { hasText: 'Open game in new tab' }).last().click(),
            ]);
            tab = opened;
          }
          await tab.waitForLoadState('load');
          expect(tab.url()).toContain(generation.gameUrl);
          await tab.bringToFront();
          return tab;
        });
        watch(game, 'game');
        checks.record('Game workspace opened', 'PASS', generation.gameUrl);

        const decoder = await context.newPage(); // blank page used to decode screenshots
        const rendered = await test.step('Game renders (not blank, not stuck loading)', async () => {
          const r = await play.verifyRenders(game, decoder);
          await testInfo.attach('game-start.png', { body: r.png, contentType: 'image/png' });
          return r;
        });
        checks.record('Game rendered', 'PASS', `${rendered.canvas ? 'canvas' : 'DOM'} game, ${rendered.colours} colours, text: ${JSON.stringify(rendered.lines.slice(0, 4))}`);
        await game.bringToFront();

        await g.play({ game, decoder, checks });

        await test.step('No critical JavaScript runtime errors', async () => {
          expect(pageErrors, 'uncaught errors in the chatbot or the game').toEqual([]);
        }).then(
          () => checks.record('No critical JavaScript runtime errors', 'PASS'),
          (err) => { checks.record('No critical JavaScript runtime errors', 'FAIL', pageErrors.join(' | ')); throw err; },
        );

        expect(checks.failed.map((c) => `${c.name}: ${c.detail}`), 'all required gameplay checks pass').toEqual([]);
        outcome = 'PASS';
      } catch (err) {
        reason = String(err.message || err).replace(/\u001b\[[0-9;]*m/g, '').split('\n').filter(Boolean).slice(0, 4).join(' ');
        const done = new Set(checks.items.map((i) => i.name));
        const next = stages.find((s) => !done.has(s));
        if (next) checks.record(next, err instanceof chat.BlockedError ? 'BLOCKED' : 'FAIL', reason);
        for (const s of stages) if (!checks.items.some((i) => i.name === s)) checks.record(s, 'NOT REACHED');
        if (err instanceof chat.BlockedError) {
          outcome = 'BLOCKED';
          testInfo.annotations.push({ type: 'outcome', description: `BLOCKED — ${err.message}` });
          test.skip(true, `BLOCKED: ${err.message}`);
        }
        throw err;
      } finally {
        if (outcome !== 'BLOCKED') testInfo.annotations.push({ type: 'outcome', description: outcome === 'PASS' ? 'PASS' : `FAIL — ${reason}` });
        for (const c of checks.items) testInfo.annotations.push({ type: 'check', description: `${c.status} — ${c.name}${c.detail ? `: ${c.detail}` : ''}` });
        await testInfo.attach('verification.md', { body: `# ${g.title} (${g.id}) — ${outcome}\n\n${checks.markdown()}\n`, contentType: 'text/markdown' });
        await testInfo.attach('verification.json', { body: JSON.stringify({ game: g.title, promptId: g.id, outcome, reason, generationMs: generation?.elapsedMs ?? null, gameUrl: generation?.gameUrl ?? null, checks: checks.items, pageErrors }, null, 2), contentType: 'application/json' });
        await testInfo.attach('console.log', { body: consoleLog.join('\n') || '(empty)', contentType: 'text/plain' });
        await testInfo.attach('chat-final.png', { body: await page.screenshot({ fullPage: false }).catch(() => Buffer.alloc(0)), contentType: 'image/png' });
        if (game && !game.isClosed()) await testInfo.attach('game-final.png', { body: await game.screenshot().catch(() => Buffer.alloc(0)), contentType: 'image/png' });
      }
    });
  }
});
