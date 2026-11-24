# End-to-end tests (Playwright)

These tests drive the real chatbot in Chromium. Each one sends one of the three
existing saved prompts, waits for the real AI pipeline to generate the game,
then plays the generated game in its own tab.

| Test | Saved prompt (as listed in the app) | Identifier |
| --- | --- | --- |
| Flappy Bird | "Flappy Bird" | `sp-muf5h69r-sjfrmj` |
| Snake and ladder | "Snake and ladder" | `sp-muf5qad8-95exbk` |
| Collect & Dodge | "Collect & Dodge" | `697f7a40-da6d-439d-82d4-2cc80889866d` (its original chat) |

The prompt text is read from the app (`GET /api/saved-prompts`) at run time and
is never copied into the tests.

## Commands

```sh
npm run test:e2e             # all three tests
npm run test:e2e:flappy      # one test (also :snake, :collect)
npm run test:e2e:headed      # watch the browser
npm run test:e2e:report      # open the HTML report
```

`npm run test:e2e` reuses the chatbot if it is already running at
http://127.0.0.1:3000, and otherwise starts it with `npm start` (the Playwright
`webServer` setting). The tests use 127.0.0.1 rather than localhost because on
Windows "localhost" can reach a different server listening on the same port
over IPv6.

Settings (environment variables):

| Variable | Default | Meaning |
| --- | --- | --- |
| `E2E_BASE_URL` | `http://127.0.0.1:$PORT` | The chatbot to test |
| `E2E_GENERATION_TIMEOUT_MIN` | 20 | Longest wait for one game build |
| `E2E_WORKERS` | 1 | Builds run one at a time; set 3 to run them side by side |
| `E2E_SEED` | 20261015 | Seed for the game's `Math.random` |
| `E2E_SNAKE_MAX_MINUTES` | 8 | Rolling budget to reach a winner |
| `E2E_COLLECT_MAX_SECONDS` | 120 | Play budget for Collect & Dodge |

## What each test does

1. **Environment.** `/api/health` must answer as the chatbot with an AI key configured.
2. **Submit.** Open the app, go to **Saved prompts**, and click the prompt. The
   app opens a new chat with the prompt's exact text in the message box ("Builds
   on Send"). The test checks the text, clicks **Send**, and checks that the
   message appears as the user's message.
3. **Generation.** Wait (up to `E2E_GENERATION_TIMEOUT_MIN`) until the app ends
   the turn. The build must finish with the "Open game in new tab" link and no
   error, and the reply must not be the "already built / loaded instantly"
   reuse. The game must be version 1 of a chat that didn't exist before the test.
4. **Workspace.** The game tab the app opens (or the link, if no tab opened)
   loads the game URL.
5. **Render.** The page is not blank and not stuck on a loading screen.
6. **Gameplay.** Checks specific to each game, listed below.
7. **Runtime errors.** No uncaught JavaScript errors occurred in the chat or the game.

Gameplay checks:

- **Flappy Bird**
  - Space starts play and the scene animates.
  - Without input, gravity and collision end the run on a game-over screen.
  - A score is displayed.
  - Restart works from the game-over screen.
  - One flap, by Space and separately by a mouse click, keeps the bird alive
    more than 250 ms longer than a run with no flap. Each run starts from a
    fresh page load with the same random seed.
- **Snake and ladder**
  - The board labels squares 1–100.
  - A roll (Roll button, or Space) changes the game.
  - The game is played to an announced winner.
  - If the game has a restart / play-again control, restart works.
- **Collect & Dodge**
  - The game starts and animates.
  - An item counter is shown.
  - Sweeping the level with held arrow keys raises the counter.
  - An end state is reached (hit by an enemy, or everything collected).
  - Restart clears the end screen and resets the counter.

Each build is new model-written code, so the checks only use what any build
exposes: visible DOM text, text drawn on a canvas (recorded by an init script),
screenshots, keyboard and mouse input, and uncaught errors. The init script
also seeds `Math.random` so runs repeat. It does not change game logic.

**Not verified automatically:**
- Flappy Bird's +1 per pipe and its speed-up (this needs a bot that can fly
  through pipes).
- Snake and ladder's token movement on the board. Snake and ladder messages are
  recorded when the game shows them.

These items are listed as NOT VERIFIED in the report, never as passed.

## Results: PASS, FAIL, BLOCKED

- **PASS:** every stage and every required check passed.
- **FAIL:** generation failed or timed out, the workspace didn't open, the game
  was blank or broken, an uncaught error occurred, or a required check failed.
- **BLOCKED:** no valid result was possible. Causes: the backend was
  unreachable, no AI key was configured, or the AI provider was unavailable (the
  app's "The AI is temporarily unavailable" error, or provider 401/403/429/5xx
  errors and timeouts). BLOCKED tests are skipped with a `BLOCKED — reason`
  annotation.

## Where results go

- `playwright-report/index.html`: the HTML report. Each test lists its prompt,
  outcome and one annotation per check, with steps and attachments
  (`verification.md` / `.json`, prompt text, chatbot reply, console log, game
  and chat screenshots).
- `playwright-report/summary.md` and `summary.json`: PASS / FAIL / BLOCKED
  totals and the overall result. The same summary is printed at the end of the
  run.
- `test-results/`: traces, screenshots and videos of failed tests. Open a trace
  with `npx playwright show-trace test-results/<test>/trace.zip`.

## Side effects

The tests use the real app and database, the same way a user would. Each run:
- adds three chats, each with its generated game under `projects/`;
- links the Flappy Bird and Snake and ladder saved prompts to the newly built
  game, which the app does whenever a saved prompt is built.

Nothing is deleted.
