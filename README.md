# Game Creator Chatbot

A chat app where one chatbot talks to you while cooperating agents design, build and test complete web games behind the scenes. No npm dependencies (Node 20+).

Two different things in this repo are both organized into `frontend/`/`backend/` folders, and it's worth being clear which is which:
- **This app itself** — the chatbot tool — is laid out that way at the repo root (see "This app's layout" below).
- **Every game it generates** gets its own `frontend/`/`backend/` project, saved under `projects/<session>/v<N>/` (see "Generated game structure" below). That's a separate, unrelated structure living inside this app's data, not its source.

## Run

1. Copy `.env.example` to `.env` and set `MELDCX_API_KEY`.
2. `npm start`
3. Open http://localhost:3000

`npm test` runs an end-to-end test against a mock LLM API (no key needed).

## This app's layout

```
frontend/                the chat UI -- plain HTML/CSS/JS, no build step
  index.html
  src/
    main.js               entry point (chat streaming, rendering, planning feed, game-tab opening)
    styles/main.css
backend/
  src/
    server.js             thin entry point: creates the HTTP server, delegates to routes/
    routes/index.js        the routing table -- matches method + path, calls a controller
    controllers/            one file per route group: parses the request, calls a service, writes the response
      chatController.js      POST /api/chat (the SSE-streamed agent pipeline)
      sessionController.js   GET /api/session/:id
      gameController.js      GET /games/:id/* (live preview) and /games/:id/download (zip)
      healthController.js    GET /api/health
    services/                the actual logic, framework-agnostic
      orchestrator.js         routing between agents and the build/QA pipeline
      llm.js                  the MELDCX API client (chat/completions, SSE streaming)
      prompts.js              all agent prompts, including the generated-project structure rules
      qa.js                   parses the Builder's <files> output, validates paths, static-checks a project
      plan.js                 turns the Builder's streamed code into Planning-feed milestones
      zip.js                  minimal dependency-free ZIP writer, used by "Download project"
      store.js                per-session state; each game version is saved under projects/<session>/v<N>/
    middleware/
      http.js                 small json()/readBody() helpers shared by controllers
      staticFiles.js           serves frontend/ (there's no separate frontend server/process)
    utils/env.js              minimal .env loader (no dotenv dependency)
    config/constants.js       PORT, MIME map, the generated-game CSP, etc.
test/run.js                  end-to-end test against a mock LLM API
projects/                    generated games live here (gitignored runtime data, not source)
.env / .env.example           at the repo root: the only real runtime is the backend, so there's one shared .env
package.json                  one root package.json runs the whole app (`npm start` / `npm test`); frontend/backend
                               have no separate dependencies or build step, so they don't need their own
```

One Node process serves both sides: `backend/src/server.js` answers the API routes AND serves `frontend/`'s static files (via `middleware/staticFiles.js`) on the same port — there's no separate frontend dev server or bundler to run.

## How it works

Every message goes through the **Intent Agent**, which picks a route. The server enforces each route's prerequisites (for example, no build without a confirmed design summary).

| Route | Agent | What happens |
| --- | --- | --- |
| chat | Chatbot | Normal conversation |
| discover | Game Designer | Asks only for the missing details, never invents mechanics |
| plan | Game Planner | Writes the Game Design Summary and asks you to confirm it |
| build | Game Builder + Asset | Writes a full, organized project (see below), with placeholder art and synthesised audio |
| improve | Game Builder | Edits the existing project and keeps earlier decisions |
| new_game | | Starts a fresh project only when you ask for one |

**QA Agent.** Generated code first goes through deterministic checks (every `.js` file is syntax-compiled, relative imports are resolved and must exist, `frontend/index.html` is verified). Broken code goes back to the builder for repair, up to twice — the repair reply only needs to resend the files it's fixing. An LLM review then mentally tests logic, controls, win/lose and restart, and can apply a minimal patch (again, only the files it changed). Set `QA_REVIEW=0` to skip that review.

**Planning feed.** While a discover/plan/build/improve request is running, a small muted checklist appears above the reply (steps get a ✓ once done, a spinner while active). It's built entirely from user-facing milestones — the routing stage, and for the builder, keyword milestones detected in the code as it's written (controls, movement, scoring, enemies, audio, ...) — never the model's private reasoning. It's per-turn and not persisted; reloading the chat won't bring old planning cards back, only the messages themselves. See `backend/src/services/plan.js` and the "Planning feed" section of `frontend/src/main.js`.

**Game Design Summary.** Rendered in its own bordered, accent-colored card (see `.design-summary-card` in `frontend/src/styles/main.css`), deliberately styled nothing like the muted Planning feed.

## Generated game structure

Every game is generated as its own real multi-file project (not a single HTML file), saved at `projects/<session>/v<N>/`:

```
frontend/            plain ES modules, no bundler, no npm install to play it
  src/
    components/      reusable UI (HUD, menus, ...)
    scenes/           only if the game has more than one screen
    game/             the actual gameplay logic
    utils/ styles/ assets/
    App.js main.js
  index.html          the file that gets played -- loads ./src/main.js as a module
backend/              only generated if the design genuinely needs a server (multiplayer, a shared leaderboard); never executed by this app
shared/               only alongside a backend, so both sides agree on values/shapes
docs/                 GAME_DESIGN.md (kept in sync with the design summary server-side, not left to the model), README.md, CHANGELOG.md
.gitignore  README.md
```

Each build/improve is saved as a new version directory; an improve only needs to return the files it added or changed, and everything else is carried over from the previous version untouched, so features land in the same folders every time instead of the project being reorganized on each change. Saying something like "just a one-file prototype" switches the Builder to output a single self-contained `frontend/index.html` instead (the old default) — everything else in the pipeline (storage, serving, QA) treats that the same way, just as a one-file project.

The live preview only ever serves that project's `frontend/` (sandboxed). "Download project" packages the *whole* project — including `backend/`, `shared/` and `docs/` when present — as a zip.

## Safety

Generated games are model-written code. A game's `frontend/` is served with a CSP `sandbox` (opaque origin, no network access), so it can never reach this app's API or other sessions — the same is true whether it's one file or many. A generated `backend/`, when present, is real organized source for you to run yourself; this app never executes it. The server listens on 127.0.0.1 only.
