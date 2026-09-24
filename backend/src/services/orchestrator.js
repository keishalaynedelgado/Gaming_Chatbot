'use strict';
const { randomUUID } = require('node:crypto');
const claude = require('./llm');
const prompts = require('./prompts');
const qa = require('./qa');
const store = require('./store');

const ROUTES = ['chat', 'discover', 'plan', 'build', 'improve', 'new_game'];
const busy = new Set();
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

async function buildGame({ id, state, message, mode, emit, signal }) {
  emit({ type: 'plan', op: 'start' });
  try {
    const currentFiles = mode === 'improve' ? await store.readProjectFiles(id, state) : null;
    const history = state.messages.slice(state.historyStart);
    const todayISO = new Date().toISOString().slice(0, 10);
    // Prototype mode is only ever chosen explicitly, and only for a fresh build --
    // an improve request never collapses an existing project back to one file.
    const prototype = mode === 'build' && prompts.wantsPrototype(message);

    // A short, fixed micro-plan -- these labels (plus "Fixing problems..."/
    // "Testing..." below, only when actually needed) are the whole Planning
    // feed. Deliberately NOT a per-keyword-detected list scanned out of the
    // code as it streams (that produced anywhere up to 9 granular steps) --
    // a handful of fixed, honest phases, matching what's actually happening.
    emit({ type: 'plan', op: 'step', label: mode === 'improve' ? 'Reviewing your requested changes.' : 'Reviewing the design summary.' });

    emit({ type: 'agent', agent: 'builder', status: 'start' });
    emit({ type: 'plan', op: 'step', label: prototype ? 'Writing the prototype.' : 'Writing the game in one pass.' });
    // Once meldCX fails once during this build, every later round (continue
    // or repair) skips straight to SCX instead of waiting out meldCX's full
    // timeout again -- there's no reason to think it recovered mid-build.
    let skipMeldcx = false;
    let { notes, files: newFiles, truncated, meldcxFailed } = await runBuilder({
      user: prompts.builderUser({ state, messages: history, userMessage: message, currentFiles, prototype, todayISO }),
      emit,
      signal,
      skipMeldcx,
    });
    if (meldcxFailed) skipMeldcx = true;
    let project = { ...currentFiles, ...newFiles };

    // A full project can be more than fits in one completion, or the
    // provider handling it can die mid-generation. Rather than give up, ask
    // the Builder to continue from exactly what it already finished -- up to
    // a couple of rounds -- before treating it as a real failure.
    for (let round = 0; truncated && round < 2; round += 1) {
      emit({ type: 'plan', op: 'step', label: 'Continuing (the project is large).' });
      try {
        const cont = await runBuilder({
          user: prompts.builderContinueUser({ state, currentFiles: project }),
          emit,
          signal,
          skipMeldcx,
        });
        project = { ...project, ...cont.files };
        notes = cont.notes || notes;
        truncated = cont.truncated;
        if (cont.meldcxFailed) skipMeldcx = true;
      } catch (err) {
        // Same reasoning as the repair loop below: one bad continuation reply
        // must not abort the build outright -- let the loop retry, or fall
        // through to the clear final error once rounds are exhausted.
        if (signal?.aborted) throw err;
        console.warn(`[orchestrator] continuation attempt ${round + 1} failed (${err.message})`);
      }
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
      try {
        const fixed = await runBuilder({
          user: prompts.builderRepairUser({ state, currentFiles: project, errors: check.errors }),
          emit,
          signal,
          skipMeldcx,
        });
        if (fixed.meldcxFailed) skipMeldcx = true;
        project = { ...project, ...fixed.files };
        notes = fixed.notes || notes;
        check = qa.staticCheck(project);
      } catch (err) {
        // A single malformed repair reply (e.g. the model returned no files)
        // must not abort the whole build -- that's exactly what the retry
        // loop exists for. Leave `check` as-is so the loop either tries again
        // or, once attempts are exhausted, falls through to the clear final
        // error below instead of this one crashing the build outright.
        if (signal?.aborted) throw err;
        console.warn(`[orchestrator] repair attempt ${attempt + 1} failed (${err.message})`);
      }
    }
    emit({ type: 'agent', agent: 'builder', status: 'done' });
    if (check.errors.length) {
      throw new Error(`The generated project still had errors after repair attempts: ${check.errors[0]}`);
    }

    // LLM QA review: a second full model pass re-reading everything the
    // Builder just wrote, on top of the Builder's own required self-check
    // (see prompts.BUILDER) and the deterministic static check + repair loop
    // above. Real value (a genuinely fresh set of eyes can catch what the
    // Builder missed), but it roughly doubles wall-clock time for a build
    // that already passed static checks -- so for speed, it's opt-in
    // (QA_REVIEW=1) rather than on by default. Set it if you want the extra
    // pass back; the repair loop above still runs regardless.
    let qaLine = 'Automated checks passed.';
    if (process.env.QA_REVIEW === '1') {
      emit({ type: 'agent', agent: 'qa', status: 'start' });
      emit({ type: 'plan', op: 'step', label: 'Testing the game for errors.' });
      try {
        const { text } = await claude.stream({
          model: claude.MODELS.qa(),
          system: prompts.QA,
          messages: [{ role: 'user', content: prompts.qaUser({ state, files: project, warnings: check.warnings }) }],
          maxTokens: 32000,
          signal,
          timeoutMs: 240000,
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
    const version = await store.saveProject(id, state, project);
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
    let state = await store.get(id);
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
      state = await store.get(activeId);
      emit({ type: 'session', id: activeId });
      route = 'discover';
      freshStart = true;
    }

    const reply = route === 'build' || route === 'improve'
      ? await buildGame({ id: activeId, state, message, mode: route, emit, signal })
      : await converse(route, state, message, emit, signal, { freshStart });

    const now = new Date().toISOString();
    state.messages.push({ role: 'user', content: message, createdAt: now }, { role: 'assistant', content: reply, createdAt: now });
    if (!state.title) {
      state.title = autoTitle(message);
      state.titleAuto = true;
      // Tells the sidebar the real, database-backed title directly -- no
      // client-side guessing needed, so it can never drift from what's
      // actually stored.
      emit({ type: 'title', title: state.title, titleAuto: true });
    }
    await store.save(activeId, state);
  } finally {
    busy.delete(id);
  }
}

module.exports = { handleChat, detectIntent, guardRoute };
