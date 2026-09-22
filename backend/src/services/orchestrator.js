'use strict';
const { randomUUID } = require('node:crypto');
const claude = require('./llm');
const prompts = require('./prompts');
const qa = require('./qa');
const store = require('./store');
const { milestoneScanner } = require('./plan');

const ROUTES = ['chat', 'discover', 'plan', 'build', 'improve', 'new_game'];
const busy = new Set();

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
// discover/plan show a Planning feed in the chat (see lib/plan.js and public/app.js);
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
      messages: [...state.messages.slice(state.historyStart), { role: 'user', content: message }],
      maxTokens: 2500,
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
async function runBuilder({ user, emit, signal, scan }) {
  let written = 0;
  let lastReport = 0;
  const { text, stopReason } = await claude.stream({
    model: claude.MODELS.builder(),
    system: prompts.BUILDER,
    messages: [{ role: 'user', content: user }],
    maxTokens: 50000,
    signal,
    onText: (delta) => {
      written += delta.length;
      if (written - lastReport >= 2000) {
        lastReport = written;
        emit({ type: 'agent', agent: 'builder', status: 'progress', detail: `${Math.round(written / 1000)}k characters written` });
      }
      scan?.(delta);
    },
  });
  // A large project can still exceed even a generous token budget. Rather than
  // fail outright, report it as truncated -- the caller re-prompts the Builder
  // to continue from exactly what it already finished (see buildGame below).
  const truncated = stopReason === 'max_tokens';
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
  return { notes: qa.extractTag(text, 'notes'), files, truncated };
}

// The Game Design Summary is known exactly server-side, so docs/GAME_DESIGN.md is
// written here rather than trusted to the model's transcription of it.
function formatGameDesignDoc(summary) {
  if (!summary) return '# Game Design\n\n_No design summary recorded yet._\n';
  const paras = summary.trim().split(/\n{2,}/);
  const body = paras.length > 1 && /\?\s*$/.test(paras[paras.length - 1]) ? paras.slice(0, -1).join('\n\n') : summary.trim();
  return `${body.replace(/^##\s*Game Design Summary/i, '# Game Design')}\n`;
}

async function buildGame({ id, state, message, mode, emit, signal }) {
  emit({ type: 'plan', op: 'start' });
  try {
    const currentFiles = mode === 'improve' ? store.readProjectFiles(id, state) : null;
    const history = state.messages.slice(state.historyStart);
    const todayISO = new Date().toISOString().slice(0, 10);
    // Prototype mode is only ever chosen explicitly, and only for a fresh build --
    // an improve request never collapses an existing project back to one file.
    const prototype = mode === 'build' && prompts.wantsPrototype(message);

    emit({ type: 'plan', op: 'step', label: mode === 'improve' ? 'Reviewing your requested changes.' : 'Reviewing the design summary.' });

    // Turns the code as it's written into short milestones ("Wiring up the
    // controls.", "Connecting the score system.", ...) for the Planning feed.
    // Shared across the initial write and any repair passes below.
    const scan = milestoneScanner((label) => emit({ type: 'plan', op: 'step', label }));

    emit({ type: 'agent', agent: 'builder', status: 'start' });
    emit({ type: 'plan', op: 'step', label: prototype ? 'Writing the prototype.' : 'Writing the project files.' });
    let { notes, files: newFiles, truncated } = await runBuilder({
      user: prompts.builderUser({ state, messages: history, userMessage: message, currentFiles, prototype, todayISO }),
      emit,
      signal,
      scan,
    });
    let project = { ...currentFiles, ...newFiles };

    // A full project can be more than fits in one completion. Rather than give
    // up, ask the Builder to continue from exactly what it already finished --
    // up to a couple of rounds -- before treating it as a real failure.
    for (let round = 0; truncated && round < 2; round += 1) {
      emit({ type: 'plan', op: 'step', label: 'Continuing (the project is large).' });
      const cont = await runBuilder({
        user: prompts.builderContinueUser({ state, currentFiles: project }),
        emit,
        signal,
        scan,
      });
      project = { ...project, ...cont.files };
      notes = cont.notes || notes;
      truncated = cont.truncated;
    }
    if (truncated) {
      throw new Error('The project was too large to finish even after continuing. Try asking for fewer features or a one-file prototype.');
    }

    // Deterministic QA: syntax, completeness, broken imports. Problems go back to
    // the Builder for repair; it only needs to resend the files it's fixing.
    let check = qa.staticCheck(project);
    for (let attempt = 0; check.errors.length && attempt < 2; attempt += 1) {
      emit({ type: 'agent', agent: 'builder', status: 'progress', detail: 'fixing problems found by QA' });
      emit({ type: 'plan', op: 'step', label: 'Fixing problems found while testing.' });
      const fixed = await runBuilder({
        user: prompts.builderRepairUser({ state, currentFiles: project, errors: check.errors }),
        emit,
        signal,
        scan,
      });
      project = { ...project, ...fixed.files };
      notes = fixed.notes || notes;
      check = qa.staticCheck(project);
    }
    emit({ type: 'agent', agent: 'builder', status: 'done' });
    if (check.errors.length) {
      throw new Error(`The generated project still had errors after repair attempts: ${check.errors[0]}`);
    }

    // LLM QA review: may return a minimal patch (only the files it changed).
    let qaLine = 'Automated checks passed.';
    if (process.env.QA_REVIEW !== '0') {
      emit({ type: 'agent', agent: 'qa', status: 'start' });
      emit({ type: 'plan', op: 'step', label: 'Testing the game for errors.' });
      try {
        const { text } = await claude.stream({
          model: claude.MODELS.qa(),
          system: prompts.QA,
          messages: [{ role: 'user', content: prompts.qaUser({ state, files: project, warnings: check.warnings }) }],
          maxTokens: 32000,
          signal,
        });
        const verdict = qa.extractTag(text, 'verdict');
        const report = qa.extractTag(text, 'report');
        if (verdict === 'FIXED') {
          const { files: patchFiles } = qa.extractFiles(text);
          const patched = { ...project, ...patchFiles };
          if (Object.keys(patchFiles).length && qa.staticCheck(patched).errors.length === 0) {
            project = patched;
            qaLine = `QA found and fixed a few issues:\n${report}`;
          } else {
            qaLine = 'QA review finished; its patch was not usable, so the original build was kept.';
          }
        } else {
          qaLine = `QA review passed. ${report}`.trim();
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        qaLine = 'Automated checks passed (the extra QA review was unavailable).';
      }
      emit({ type: 'agent', agent: 'qa', status: 'done' });
    }

    // Keep docs/GAME_DESIGN.md authoritative, unless this really is a bare
    // one-file prototype (no point forcing a docs/ folder onto that).
    const isPrototypeShape = Object.keys(project).length === 1 && project['frontend/index.html'] !== undefined;
    if (!isPrototypeShape) project['docs/GAME_DESIGN.md'] = formatGameDesignDoc(state.summary);

    emit({ type: 'plan', op: 'step', label: mode === 'improve' ? 'Refreshing the playable version.' : 'Preparing the playable version.' });
    const version = store.saveProject(id, state, project);
    state.phase = 'built';
    emit({ type: 'game', url: `/games/${id}/index.html?v=${version}`, version });
    emit({ type: 'plan', op: 'done' });

    const reply = `${notes || 'Your game is ready — it should have opened in a new tab.'}\n\n**QA:** ${qaLine}`;
    emit({ type: 'text', delta: reply });
    return reply;
  } catch (err) {
    emit({ type: 'plan', op: 'error' });
    throw err;
  }
}

// ------------------------------------------------------------------ Entry point
async function handleChat({ id, message, emit, signal }) {
  if (busy.has(id)) {
    const err = new Error('Still working on your previous message. Please wait a moment.');
    err.status = 409;
    throw err;
  }
  busy.add(id);
  try {
    let state = store.get(id);
    let activeId = id;
    let freshStart = false;

    emit({ type: 'agent', agent: 'intent', status: 'start' });
    let route = guardRoute(await detectIntent(state, message, signal), state);
    emit({ type: 'agent', agent: 'intent', status: 'done', detail: route });

    if (route === 'new_game') {
      // A completely new game gets its own chat: a brand new session, so its
      // messages, design and generated files never mix with the old game's.
      // Improving the current game, in contrast, always stays in this same
      // session (see buildGame/converse above) -- only this explicit "start
      // over with something different" case moves to a fresh one.
      activeId = randomUUID();
      state = store.get(activeId);
      emit({ type: 'session', id: activeId });
      route = 'discover';
      freshStart = true;
    }

    const reply = route === 'build' || route === 'improve'
      ? await buildGame({ id: activeId, state, message, mode: route, emit, signal })
      : await converse(route, state, message, emit, signal, { freshStart });

    state.messages.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    store.save(activeId, state);
  } finally {
    busy.delete(id);
  }
}

module.exports = { handleChat, detectIntent, guardRoute };
