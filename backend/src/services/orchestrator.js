'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const claude = require('./llm');
const prompts = require('./prompts');
const qa = require('./qa');
const store = require('./store');
const { createPlan } = require('./planRunner');

const ROUTES = ['chat', 'discover', 'plan', 'build', 'improve', 'new_game'];
const busy = new Set();
const stopping = new Set(); // busy chats whose turn was Stopped and is unwinding
const STOP_SETTLE_MS = 5000;
// A chat kept alive indefinitely (the sidebar makes that easy -- a user can
// return to and keep extending the same conversation far longer than a
// single sitting used to) would otherwise send its ENTIRE history to the
// model on every single turn, unbounded. That's slower and more expensive
// every turn, and on some local/reasoning models measurably so. Recent
// context is what actually matters for "what are we discussing right now";
// older turns already shaped state.summary, which is sent in full regardless.
const HISTORY_LIMIT = 24;

// Recent history for a conversational turn -- never reaches back past
// state.historyStart (an earlier, unrelated game), and never past
// HISTORY_LIMIT messages even within the same game's conversation.
function recentHistory(state) {
  return state.messages.slice(state.historyStart).slice(-HISTORY_LIMIT);
}

// The sidebar's auto-generated title, computed here (not just client-side)
// so the database has a real title for a chat from the moment it exists --
// mirrors frontend/src/chats.js's own autoTitle() so the two normally agree
// outright; the database copy is the authoritative one.
const TITLE_MAX = 48;
function autoTitle(message) {
  const flat = (message || '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'New chat';
  if (flat.length <= TITLE_MAX) return flat;
  const cut = flat.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > 20 ? cut.slice(0, lastSpace) : cut}…`;
}

// ---------------------------------------------------------------- Game reuse
// The game name from a plain "make me X" request -- "Make a Flappy Bird game",
// "Create Flappy Bird.", "Build a Flappy Bird clone", "Generate Flappy Bird",
// "I want to make flappy bird" -- or null. Only short, bare requests count: any
// extra wishes ("...with lasers and 3 levels") leave a longer name that won't
// equal a finished game's title, so that request is built normally.
const GAME_REQUEST_RE = /^(?:(?:please|pls|hey|hi|ok|okay|can you|could you|would you|let s|lets)\s+)*(?:(?:i\s+)?(?:want|would like|d like|need)\s+(?:you\s+)?(?:to\s+)?)?(?:make|create|build|generate|code|program|give)(?:\s+me)?(?:\s+(?:a|an|the))?\s+(.+?)(?:\s+please)?$/;
function requestedGameName(message) {
  const norm = store.normalizeText(message);
  if (!norm || norm.length > 80) return null;
  const name = store.normalizeGameName(norm.match(GAME_REQUEST_RE)?.[1] || '');
  return name && !/^(?:game|new game|a game|something|anything)$/.test(name) ? name : null;
}

// The saved games list, from config/savedGames.md: under "## Saved Games",
// each "### Name" heading is a game, its "Project: <id>" line the chat that
// holds the finished game, and the "- ..." list items under "Triggers" its
// trigger phrases. Everything else in the file is documentation.
const SAVED_GAMES_FILE = path.join(__dirname, '..', 'config', 'savedGames.md');
function parseSavedGames(markdown) {
  const games = [];
  let inSection = false;
  let game = null;
  let inTriggers = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) { inSection = /^saved games$/i.test(h2[1].trim()); game = null; continue; }
    if (!inSection) continue;
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) { game = { name: h3[1].trim(), session: null, triggers: [] }; games.push(game); inTriggers = false; continue; }
    if (!game) continue;
    const project = line.match(/^\**project\**\s*:\**\s*`?([0-9a-f-]{36})`?/i);
    if (project) { game.session = project[1]; inTriggers = false; continue; }
    if (/^\**triggers\**\s*:?\**$/i.test(line)) { inTriggers = true; continue; }
    const item = line.match(/^[-*]\s+(.+)$/);
    if (item && inTriggers) { game.triggers.push(item[1].replace(/^["`]|["`]$/g, '').trim()); continue; }
    if (line && !item) inTriggers = false; // any other text ends the trigger list
  }
  return games.filter((g) => g.session);
}

// The saved game a request asks for, or null: the whole message equals one of
// its triggers ("flappy bird", "make flappy bird"), or it's a plain
// make/create/build request naming it ("Create Flappy Bird.", "Build a Flappy
// Bird clone"). The file is read fresh each time, so it can be edited without
// a restart.
function matchSavedGame(message) {
  let games;
  try {
    games = parseSavedGames(fs.readFileSync(SAVED_GAMES_FILE, 'utf8'));
  } catch (err) {
    console.warn(`[orchestrator] could not read ${SAVED_GAMES_FILE}: ${err.message}`);
    return null;
  }
  const text = store.normalizeText(message);
  const asked = requestedGameName(message);
  return games.find((g) => g?.session && (
    (g.triggers || []).some((t) => store.normalizeText(t) === text)
    || (asked && asked === store.normalizeGameName(g.name))
  )) || null;
}

// ---------------------------------------------------------------- Intent Agent
async function detectIntent(state, message, signal) {
  const recent = state.messages
    .slice(state.historyStart)
    .slice(-6)
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 600)}`)
    .join('\n');
  const input = [
    `State: phase=${state.phase}, designSummaryExists=${Boolean(state.summary)}, gameBuilt=${state.hasGame}`,
    recent ? `Recent messages:\n${recent}` : 'Recent messages: (none)',
    `LATEST user message:\n${message}`,
  ].join('\n\n');

  try {
    const { text } = await claude.stream({
      model: claude.MODELS.intent(),
      system: prompts.INTENT,
      messages: [{ role: 'user', content: input }],
      maxTokens: 60,
      signal,
      timeoutMs: 30000,
    });
    const route = text.match(/"route"\s*:\s*"([a-z_]+)"/)?.[1];
    if (ROUTES.includes(route)) return route;
  } catch (err) {
    if (signal?.aborted) throw err;
    // An unreadable intent must not break the chat: fall through to a safe default.
  }
  return state.phase === 'discover' ? 'discover' : 'chat';
}

// The server enforces what each route needs, whatever the Intent Agent says.
function guardRoute(route, state) {
  if (route === 'build') {
    if (state.hasGame) return 'improve';
    if (!state.summary) return 'discover';
  }
  if (route === 'improve' && !state.hasGame) return state.summary ? 'plan' : 'discover';
  return route;
}

// ------------------------------------------------- Designer / Planner / Chatbot
// discover/plan show a Planning feed in the chat (see frontend/src/main.js);
// plain chat does not, since it isn't "designing or building a game".
async function converse(kind, state, message, emit, signal, opts = {}) {
  const agent = { discover: 'designer', plan: 'planner', chat: 'chat' }[kind];
  const planning = kind === 'discover' || kind === 'plan';
  if (planning) {
    emit({ type: 'plan', op: 'start' });
    emit({ type: 'plan', op: 'step', label: kind === 'plan' ? 'Reviewing your requirements.' : "Gathering the game's requirements." });
  }

  emit({ type: 'agent', agent, status: 'start' });
  try {
    let seenSummary = false;
    let sinceMarkerCheck = '';
    const { text } = await claude.stream({
      model: claude.MODELS.designer(),
      system: prompts.conversationSystem(kind, state, opts),
      messages: [...recentHistory(state), { role: 'user', content: message }],
      maxTokens: 2500,
      timeoutMs: 90000,
      onText: (delta) => {
        emit({ type: 'text', delta });
        // The moment the summary heading appears, the planner has moved from
        // reviewing requirements to actually drafting the summary.
        if (kind === 'plan' && !seenSummary) {
          sinceMarkerCheck += delta;
          if (/##\s*Game Design Summary/i.test(sinceMarkerCheck)) {
            seenSummary = true;
            emit({ type: 'plan', op: 'step', label: 'Drafting the Game Design Summary.' });
          }
        }
      },
      signal,
    });
    emit({ type: 'agent', agent, status: 'done' });
    if (planning) emit({ type: 'plan', op: 'done' });

    if (kind === 'plan' && /##\s*Game Design Summary/i.test(text)) {
      state.summary = text.trim();
      state.phase = 'plan';
    } else if (kind === 'discover' && state.phase === 'none') {
      state.phase = 'discover';
    }
    return text;
  } catch (err) {
    if (planning) emit({ type: 'plan', op: 'error' });
    throw err;
  }
}

// -------------------------------------------------------------- Game Builder
async function runBuilder({ user, emit, signal, skipMeldcx }) {
  let written = 0;
  let lastReport = 0;
  let text;
  let stopReason;
  let meldcxFailed = false;
  try {
    ({ text, stopReason } = await claude.stream({
      model: claude.MODELS.builder(),
      system: prompts.BUILDER,
      messages: [{ role: 'user', content: user }],
      maxTokens: 50000,
      signal,
      timeoutMs: 900000,
      skipMeldcx,
      onText: (delta) => {
        written += delta.length;
        if (written - lastReport >= 2000) {
          lastReport = written;
          emit({ type: 'agent', agent: 'builder', status: 'progress', detail: `${Math.round(written / 1000)}k characters written` });
        }
      },
    }));
  } catch (err) {
    // The provider handling this died mid-generation but managed to write
    // something first (see llm.js's attemptStream) -- rather than surface
    // that as a failure the user has to manually retry, treat it exactly
    // like running out of tokens: keep what was written and let the existing
    // continuation loop below finish the job, on the fallback provider.
    if (signal?.aborted || !err.partialText) throw err;
    console.warn(`[orchestrator] builder stream failed mid-generation (${err.message}); continuing on the fallback provider`);
    text = err.partialText;
    stopReason = 'provider_failure';
    meldcxFailed = !skipMeldcx;
  }
  // A large project can still exceed even a generous token budget -- and a
  // provider can die mid-generation (see above). Rather than fail outright,
  // report it as truncated -- the caller re-prompts the Builder to continue
  // from exactly what it already finished (see buildGame below).
  const truncated = stopReason === 'max_tokens' || stopReason === 'provider_failure';
  const { files, skipped, complete, lastPath } = qa.extractFiles(text);
  if (skipped.length) console.warn(`Builder returned unsafe file paths, dropped: ${skipped.join(', ')}`);
  if (truncated && !complete && lastPath) {
    // That last file was cut off mid-write and is very likely broken -- drop it
    // rather than save something that looks finished but isn't.
    delete files[lastPath];
  }
  if (Object.keys(files).length === 0 && !truncated) {
    console.warn(`Builder returned zero usable files. Raw response (first 1500 chars):\n${text.slice(0, 1500)}`);
    throw new Error('The Game Builder did not return any files. Please try again.');
  }
  return { notes: qa.extractTag(text, 'notes'), files, truncated, meldcxFailed };
}

// The Game Design Summary is known exactly server-side, so docs/GAME_DESIGN.md is
// written here rather than trusted to the model's transcription of it.
function formatGameDesignDoc(summary) {
  if (!summary) return '# Game Design\n\n_No design summary recorded yet._\n';
  const paras = summary.trim().split(/\n{2,}/);
  const body = paras.length > 1 && /\?\s*$/.test(paras[paras.length - 1]) ? paras.slice(0, -1).join('\n\n') : summary.trim();
  return `${body.replace(/^##\s*Game Design Summary/i, '# Game Design')}\n`;
}

// Asks the Project Planner for the project's file list (the "Planning
// project" step). Returns [{ path, purpose }] -- only safe, sensible paths.
async function planProjectFiles({ state, message, signal }) {
  const { text } = await claude.stream({
    model: claude.MODELS.designer(),
    system: prompts.PROJECT_PLANNER,
    messages: [{ role: 'user', content: prompts.projectPlanUser({ state, userMessage: message }) }],
    maxTokens: 2000,
    timeoutMs: 120000,
    signal,
  });
  const body = qa.extractTag(text, 'manifest') || text;
  const json = body.match(/\[[\s\S]*\]/)?.[0];
  let list;
  try {
    list = JSON.parse(json);
  } catch {
    throw new Error('The project plan was not valid JSON');
  }
  const seen = new Set();
  const plan = (Array.isArray(list) ? list : [])
    .map((f) => ({ path: String(f?.path || '').trim().replace(/^\.?\//, ''), purpose: String(f?.purpose || '').trim() }))
    .filter((f) => f.path && qa.isSafePath(f.path) && !seen.has(f.path) && seen.add(f.path));
  if (!plan.some((f) => f.path === 'frontend/index.html')) throw new Error('The project plan is missing frontend/index.html');
  return plan.slice(0, 60);
}

// Builds (or improves) the game as an explicit plan -- see planRunner.js.
// Each step is a real action; independent steps run in parallel; a failed
// step is retried on its own. The generation, continuation, repair and QA
// logic inside the steps is unchanged from before -- only now each phase is
// a tracked step instead of a loose progress label.
async function buildGame({ id, state, message, mode, emit, signal, fromSavedPrompt = false, promptType = null }) {
  const plan = createPlan({
    emit,
    signal,
    steps: [
      {
        id: 'analyze',
        label: 'Analyzing request',
        run: async (ctx, step) => {
          ctx.currentFiles = mode === 'improve' ? await store.readProjectFiles(id, state) : null;
          ctx.history = state.messages.slice(state.historyStart);
          ctx.todayISO = new Date().toISOString().slice(0, 10);
          // Prototype mode is only ever chosen explicitly, and only for a fresh
          // build -- an improve request never collapses a project to one file.
          ctx.prototype = mode === 'build' && prompts.wantsPrototype(message);
          // Only a fresh multi-file project is complex enough to plan up front;
          // a one-file prototype or a change to an existing game goes straight
          // to generation.
          ctx.complex = mode === 'build' && !ctx.prototype;
          step.doneDetail = mode === 'improve' ? 'Change to an existing game' : ctx.prototype ? 'One-file prototype' : 'Full project build';
        },
      },
      {
        // Runs in parallel with planning/generation: it only needs the summary.
        id: 'docs',
        label: 'Preparing the design document',
        deps: ['analyze'],
        run: async (ctx) => {
          ctx.designDoc = formatGameDesignDoc(state.summary);
        },
      },
      {
        id: 'plan',
        label: 'Planning project',
        deps: ['analyze'],
        retries: 1,
        optional: true, // without a file plan the Builder still organises the project itself
        skip: (ctx) => (ctx.complex ? false : mode === 'improve' ? 'Not needed for a change to an existing game' : 'Not needed for a one-file prototype'),
        run: async (ctx, step) => {
          ctx.projectPlan = await planProjectFiles({ state, message, signal });
          step.doneDetail = `${ctx.projectPlan.length} files planned`;
        },
      },
      {
        id: 'generate',
        label: 'Generating files',
        deps: ['plan'],
        retries: 1,
        run: async (ctx, step) => {
          emit({ type: 'agent', agent: 'builder', status: 'start' });
          // Once meldCX fails once during this build, every later round
          // (continue or repair) skips straight to SCX instead of waiting out
          // meldCX's full timeout again.
          const first = await runBuilder({
            user: prompts.builderUser({
              state, messages: ctx.history, userMessage: message, currentFiles: ctx.currentFiles, prototype: ctx.prototype,
              todayISO: ctx.todayISO, fromSavedPrompt, promptType, projectPlan: ctx.projectPlan,
            }),
            emit,
            signal,
            skipMeldcx: ctx.skipMeldcx,
          });
          if (first.meldcxFailed) ctx.skipMeldcx = true;
          let { notes, truncated } = first;
          let project = { ...ctx.currentFiles, ...first.files };

          // A full project can be more than fits in one completion, or the
          // provider can die mid-generation: continue from exactly what's
          // finished (up to a couple of rounds) before calling it a failure.
          // Planned files that never arrived get one targeted round too.
          const missingPlanned = () => (ctx.projectPlan || []).map((f) => f.path).filter((p) => project[p] === undefined);
          for (let round = 0; (truncated || (round === 0 && missingPlanned().length)) && round < 2; round += 1) {
            const missing = missingPlanned();
            plan.note('generate', truncated ? 'Continuing (the project is large)' : `Writing ${missing.length} planned file(s) that were missing`);
            try {
              const cont = await runBuilder({ user: prompts.builderContinueUser({ state, currentFiles: project, missing }), emit, signal, skipMeldcx: ctx.skipMeldcx });
              project = { ...project, ...cont.files };
              notes = cont.notes || notes;
              truncated = cont.truncated;
              if (cont.meldcxFailed) ctx.skipMeldcx = true;
            } catch (err) {
              // One bad continuation reply must not abort the build outright.
              if (signal?.aborted) throw err;
              console.warn(`[orchestrator] continuation attempt ${round + 1} failed (${err.message})`);
            }
          }
          if (truncated) {
            throw new Error('The project was too large to finish even after continuing. Try asking for fewer features or a one-file prototype.');
          }
          ctx.project = project;
          ctx.notes = notes;
          const stillMissing = missingPlanned();
          step.doneDetail = `${Object.keys(project).length} files in the project${stillMissing.length ? ` (${stillMissing.length} planned file(s) left out)` : ''}`;
        },
      },
      {
        id: 'validate',
        label: 'Validating output',
        deps: ['generate'],
        retries: 1, // a second full round of repairs, on this step only
        run: async (ctx, step) => {
          // Deterministic QA: syntax, completeness, broken imports. Problems go
          // back to the Builder, which only resends the files it's fixing.
          let check = qa.staticCheck(ctx.project);
          for (let attempt = 0; check.errors.length && attempt < 2; attempt += 1) {
            emit({ type: 'agent', agent: 'builder', status: 'progress', detail: 'fixing problems found by QA' });
            plan.note('validate', `Fixing ${check.errors.length} problem(s) found while testing`);
            try {
              const fixed = await runBuilder({ user: prompts.builderRepairUser({ state, currentFiles: ctx.project, errors: check.errors }), emit, signal, skipMeldcx: ctx.skipMeldcx });
              if (fixed.meldcxFailed) ctx.skipMeldcx = true;
              ctx.project = { ...ctx.project, ...fixed.files };
              ctx.notes = fixed.notes || ctx.notes;
              check = qa.staticCheck(ctx.project);
            } catch (err) {
              // A single malformed repair reply must not abort the build --
              // the loop (and this step's own retry) exist for exactly that.
              if (signal?.aborted) throw err;
              console.warn(`[orchestrator] repair attempt ${attempt + 1} failed (${err.message})`);
            }
          }
          emit({ type: 'agent', agent: 'builder', status: 'done' });
          if (check.errors.length) {
            throw new Error(`The generated project still had errors after repair attempts: ${check.errors[0]}`);
          }

          // Optional LLM QA review (QA_REVIEW=1): a second full model pass over
          // everything the Builder wrote. Off by default for speed; the
          // deterministic checks + repairs above always run.
          ctx.qaLine = 'Automated checks passed.';
          if (process.env.QA_REVIEW === '1') {
            emit({ type: 'agent', agent: 'qa', status: 'start' });
            plan.note('validate', 'Testing the game for errors');
            try {
              const { text } = await claude.stream({
                model: claude.MODELS.qa(),
                system: prompts.QA,
                messages: [{ role: 'user', content: prompts.qaUser({ state, files: ctx.project, warnings: check.warnings }) }],
                maxTokens: 32000,
                signal,
                timeoutMs: 240000,
              });
              const verdict = qa.extractTag(text, 'verdict');
              const report = qa.extractTag(text, 'report');
              if (verdict === 'FIXED') {
                const { files: patchFiles } = qa.extractFiles(text);
                const patched = { ...ctx.project, ...patchFiles };
                if (Object.keys(patchFiles).length && qa.staticCheck(patched).errors.length === 0) {
                  ctx.project = patched;
                  ctx.qaLine = `QA found and fixed a few issues:\n${report}`;
                } else {
                  ctx.qaLine = 'QA review finished; its patch was not usable, so the original build was kept.';
                }
              } else {
                ctx.qaLine = `QA review passed. ${report}`.trim();
              }
            } catch (err) {
              if (signal?.aborted) throw err;
              ctx.qaLine = 'Automated checks passed (the extra QA review was unavailable).';
            }
            emit({ type: 'agent', agent: 'qa', status: 'done' });
          }
          step.doneDetail = 'All checks passed';
        },
      },
      {
        id: 'finalize',
        label: 'Finalizing project',
        deps: ['validate', 'docs'],
        run: async (ctx) => {
          // Keep docs/GAME_DESIGN.md authoritative, unless this really is a
          // bare one-file prototype (no point forcing a docs/ folder onto it).
          const isPrototypeShape = Object.keys(ctx.project).length === 1 && ctx.project['frontend/index.html'] !== undefined;
          if (!isPrototypeShape) ctx.project['docs/GAME_DESIGN.md'] = ctx.designDoc;
          const version = await store.saveProject(id, state, ctx.project);
          state.phase = 'built';
          emit({ type: 'game', url: `/games/${id}/index.html?v=${version}`, version });
        },
      },
    ],
  });

  const ctx = await plan.run({ skipMeldcx: false });
  const reply = `${ctx.notes || 'Your game is ready — it should have opened in a new tab.'}\n\n**QA:** ${ctx.qaLine}`;
  emit({ type: 'text', delta: reply });
  return reply;
}

// ------------------------------------------------------------------ Entry point
// `spec` is a saved, already-finalized Game Design Summary (from the sidebar's
// Saved prompts). With it, the request is treated as final: no intent check,
// no discovery questions, no confirmation -- straight to the Builder, with the
// exact same summary the game was originally built from.
async function handleChat({ id, message, spec, promptType = null, loadGame = null, savedPromptId = null, emit, signal }) {
  // A turn that was just Stopped may still be unwinding (its cancelled
  // request settling, the message being kept): wait briefly for it, so a
  // message sent right after Stop isn't refused. Never waits on a live turn.
  for (let waited = 0; busy.has(id) && stopping.has(id) && waited < STOP_SETTLE_MS; waited += 50) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (busy.has(id)) {
    const err = new Error('Still working on your previous message. Please wait a moment.');
    err.status = 409;
    throw err;
  }
  busy.add(id);
  const onStop = () => stopping.add(id);
  signal?.addEventListener('abort', onStop);
  // The chat exists -- with this message in it -- the moment the message
  // arrives, before any AI call: a slow, failed or timed-out reply can never
  // lose it, and the chat can be opened from the sidebar while the reply is
  // still being generated. `state.messages` itself only gets the message once
  // the turn is done (the agents add the current message to the history they
  // send on their own), so the early save writes a snapshot that includes it.
  const userMsg = { role: 'user', content: message, createdAt: new Date().toISOString() };
  let state;
  let activeId = id;
  let recorded = false; // has userMsg been pushed into state.messages yet?
  let savedEarly = false;
  const saveEarly = async () => {
    if (!state.title) {
      state.title = autoTitle(message);
      state.titleAuto = true;
      // The database-backed title, sent right away so the sidebar shows it.
      emit({ type: 'title', title: state.title, titleAuto: true });
    }
    await store.save(activeId, { ...state, messages: [...state.messages, userMsg] });
    savedEarly = true;
    emit({ type: 'saved', id: activeId });
  };
  try {
    state = await store.get(id);
    let freshStart = false;

    // A plain request for a game that's already been built ("Make a Flappy
    // Bird game", "Build a Flappy Bird clone") reuses that finished game the
    // same way -- matched on the exact game name, before any intent check or
    // planning, and only in a chat that doesn't have a game yet.
    let reuseFrom = loadGame;
    let reusedBy = 'saved prompt';
    let reuseName = null;
    if (!reuseFrom && !spec) {
      const saved = matchSavedGame(message);
      if (saved && saved.session !== id) {
        reuseFrom = saved.session;
        reuseName = saved.name;
        reusedBy = 'request';
      }
    }

    // A finished game to reuse: open a copy of it at once -- no planning,
    // generation, repair or AI calls. It's a copy (in this chat), so changes
    // asked for here never touch the original. If the game is gone after all,
    // this falls through to building it normally.
    if (reuseFrom && reuseFrom !== id) {
      const source = await store.get(reuseFrom);
      const files = source.hasGame ? await store.readProjectFiles(reuseFrom, source) : null;
      if (files && Object.keys(files).length) {
        if (state.hasGame || state.messages.length) {
          activeId = randomUUID();
          state = await store.get(activeId);
          emit({ type: 'session', id: activeId });
        }
        const name = reuseName || (source.summary || '').match(/\*\*Title:?\*\*:?\s*([^\n]+)/)?.[1].replace(/\(default[^)]*\)|[*_]/g, '').trim() || 'your game';
        if (!state.title) {
          state.title = name;
          state.titleAuto = true;
          emit({ type: 'title', title: state.title, titleAuto: true });
        }
        await saveEarly();
        state.summary = source.summary;
        const version = await store.saveProject(activeId, state, files);
        state.phase = 'built';
        // Not opened automatically: the user starts it with "Open game in new tab".
        emit({ type: 'game', url: `/games/${activeId}/index.html?v=${version}`, version, autoOpen: false });
        const reply = reusedBy === 'request'
          ? `**${name}** has already been built, so I've loaded the finished version instead of generating it again. Click **Open game in new tab** to play. Ask for any changes and I'll update this copy.`
          : `Here's **${name}**, loaded instantly from your saved prompt. Click **Open game in new tab** to play. Ask for any changes and I'll update this copy.`;
        emit({ type: 'text', delta: reply });
        state.messages.push(userMsg, { role: 'assistant', content: reply, createdAt: new Date().toISOString() });
        recorded = true;
        await store.save(activeId, state);
        return;
      }
    }

    let route;
    if (spec) {
      // A saved game always gets a clean chat of its own, never mixed into an
      // existing conversation or game.
      if (state.hasGame || state.messages.length) {
        activeId = randomUUID();
        state = await store.get(activeId);
        emit({ type: 'session', id: activeId });
      }
      await saveEarly();
      // Saved prompts are shown without the heading; the Builder and
      // docs/GAME_DESIGN.md expect the Planner's exact format, so restore it.
      state.summary = /^\s*##\s*Game Design Summary/i.test(spec) ? spec : `## Game Design Summary\n\n${spec}`;
      state.phase = 'plan';
      route = 'build';
    } else {
      await saveEarly();
      emit({ type: 'agent', agent: 'intent', status: 'start' });
      route = guardRoute(await detectIntent(state, message, signal), state);
      emit({ type: 'agent', agent: 'intent', status: 'done', detail: route });
    }

    // "Start a different game" from a chat that has nothing in it yet needs no
    // new chat -- it just starts here.
    if (route === 'new_game' && !state.messages.length) route = 'discover';

    if (route === 'new_game') {
      // A completely new game gets its own chat: a brand new session, so its
      // messages, design and generated files never mix with the old game's.
      // Improving the current game, in contrast, always stays in this same
      // session (see buildGame/converse above) -- only this explicit "start
      // over with something different" case moves to a fresh one.
      // The message moves with it: the old chat goes back to exactly how it
      // was, and the new chat is created (with the message) straight away.
      await store.save(id, state);
      activeId = randomUUID();
      state = await store.get(activeId);
      emit({ type: 'session', id: activeId });
      await saveEarly();
      route = 'discover';
      freshStart = true;
    }

    const reply = route === 'build' || route === 'improve'
      ? await buildGame({ id: activeId, state, message, mode: route, emit, signal, fromSavedPrompt: Boolean(spec), promptType })
      : await converse(route, state, message, emit, signal, { freshStart });

    // The reply is appended to the chat that already holds the message.
    state.messages.push(userMsg, { role: 'assistant', content: reply, createdAt: new Date().toISOString() });
    recorded = true;
    await store.save(activeId, state);

    // A fresh build that got this far succeeded, so its request + the exact
    // summary it was built from are now a finalized prompt: the sidebar saves
    // it, and reopening it rebuilds instantly (see `spec` above). Only fresh
    // builds count -- improvements to an existing game aren't new prompts.
    if (route === 'build') {
      const request = state.messages.slice(state.historyStart).find((m) => m.role === 'user')?.content || message;
      emit({ type: 'completed_prompt', title: state.title || autoTitle(request), request, spec: state.summary });
      // Built from one of the user's saved prompts: remember this game, so
      // picking that prompt again loads it instantly.
      if (savedPromptId) {
        await store.linkSavedPromptGame(savedPromptId, activeId)
          .catch((e) => console.error('[orchestrator] could not link the saved prompt to its game:', e.message));
      }
    }
  } catch (err) {
    // Failed, timed out or stopped: the chat keeps the user's message (it was
    // saved up front) -- also recorded in the in-memory state here, so the
    // next turn's save can't drop it again.
    if (savedEarly && !recorded) {
      state.messages.push(userMsg);
      await store.save(activeId, state).catch((e) => console.error('[orchestrator] could not keep the message after a failed turn:', e.message));
    }
    throw err;
  } finally {
    busy.delete(id);
    stopping.delete(id);
    signal?.removeEventListener('abort', onStop);
  }
}

module.exports = { handleChat, detectIntent, guardRoute };
