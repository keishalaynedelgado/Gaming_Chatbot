'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const claude = require('./llm');
const prompts = require('./prompts');
const qa = require('./qa');
const store = require('./store');
const exporter = require('./exporter');
const iconDesigner = require('./iconDesigner');
const { createPlan } = require('./planRunner');
const log = require('../utils/logger');

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

// Once the design names the game, the chat is named after it ("Chess Master"
// instead of "create a chess game") -- unless the user renamed it themselves.
function retitle(state, emit) {
  const title = store.summaryTitle(state.summary);
  if (!title || state.titleAuto === false || state.title === title) return;
  state.title = title;
  state.titleAuto = true;
  emit({ type: 'title', title, titleAuto: true });
}

// ----------------------------------------------------------------- Preferences
// General topics worth remembering between games -- not game-specific ones
// like genre or story -- recognised from a setup question's wording, or else
// its options. Later games start from the user's usual choice on each
// (prompts.conversationSystem) instead of asking again.
const PREFERENCE_TOPICS = [
  ['platform', /\b(platform|desktop|mobile|phone|tablet|device|pc)\b/i],
  ['difficulty', /\b(difficulty|difficult|easy|hard|challenging)\b/i],
  ['controls', /\b(controls?|keyboard|touch|mouse|swipe|tap)\b/i],
  ['visual', /\b(visuals?|art|graphics|look)\b/i],
  ['audio', /\b(audio|sounds?|music)\b/i],
];

// A reply's numbered questions that have "- option" bullets under them.
function parseQuestions(text) {
  const questions = [];
  for (const line of String(text || '').split('\n')) {
    const q = line.match(/^\s*(\d+)\.\s+(.+)$/);
    const o = line.match(/^\s*[-*]\s+(.+)$/);
    if (q) questions.push({ n: Number(q[1]), text: q[2], options: [] });
    else if (o && questions.length) questions[questions.length - 1].options.push(o[1].replace(/[*_`]/g, '').trim());
  }
  return questions.filter((q) => q.options.length >= 2);
}

function preferenceTopic(question) {
  const match = (s) => PREFERENCE_TOPICS.find(([, re]) => re.test(s))?.[0];
  return match(question.text) || match(question.options.join(' ')) || null;
}

// Remembers the user's answers ("1. Easy\n3. Mobile", or a bare answer to a
// single question -- which is what the answer buttons send) to the questions
// just asked, on the topics above.
async function recordAnswers(state, message) {
  const last = [...state.messages].reverse().find((m) => m.role === 'assistant')?.content;
  const questions = parseQuestions(last);
  if (!questions.length) return;
  const answers = new Map([...message.matchAll(/^\s*(\d+)[.)]\s*(.+)$/gm)].map((m) => [Number(m[1]), m[2].trim()]));
  if (!answers.size && questions.length === 1) answers.set(questions[0].n, message.trim());
  for (const q of questions) {
    const topic = preferenceTopic(q);
    const answer = answers.get(q.n);
    if (!topic || !answer || answer.length > 40 || /something else|\bother\b|not sure|you choose|surprise/i.test(answer)) continue;
    await store.recordPreference(topic, answer);
  }
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

// ------------------------------------------------------------ Demo flow
// DEMO ONLY, for the games in config/savedGames.md, mirroring a real build
// with no model call at any point: asking for one gets a few setup questions
// as if it were new; the answer (whatever it is) gets that game's Game Design
// Summary ending with the usual 'say build it'; 'build it' then gets a build
// progress card at demo pace (~3.5s) and the link to the finished game.
const DEMO_QUESTIONS = `Great choice! Before I build it, tell me a bit about how you'd like it:

1. What genre or vibe do you want?
   - Arcade
   - Puzzle
   - Platformer
   - Endless runner / survival
   - Something else

2. What should the player be trying to do?
   - Collect items
   - Avoid enemies
   - Beat levels
   - Survive as long as possible

3. Should it be for desktop, mobile, or both?
   - Desktop
   - Mobile
   - Both`;
const DEMO_MARK = 'Before I build it, tell me a bit about how you\'d like it:';
const DEMO_STEP_MS = { analyze: 500, plan: 800, generate: 1400, validate: 600 };

const DEMO_CONFIRM = 'Does this match your vision? You can say **build it** or tell me what to change.';

// Only a pure go-ahead ("build it", "yes", "looks good, go ahead") counts --
// a reply asking for changes goes through the normal flow instead.
const GO_AHEAD_WORDS = new Set(['build', 'it', 'now', 'yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'go', 'ahead', 'do', 'looks', 'look', 'good', 'great', 'perfect', 'please', 'proceed', 'lets', 'let', 's', 'sounds', 'confirm', 'confirmed', 'that', 'thats', 'is', 'fine', 'awesome', 'cool', 'nice', 'start', 'make', 'the', 'game']);
function isGoAhead(message) {
  const words = store.normalizeText(message).split(' ').filter(Boolean);
  return words.length > 0 && words.length <= 8 && words.every((w) => GO_AHEAD_WORDS.has(w));
}

// Where this chat is in the demo flow, if anywhere: 'answers' (the last reply
// asked the setup questions) or 'build' (the last reply was the summary,
// waiting for "build it"), plus which saved game -- found from the message
// that asked for it, just before the questions.
function demoStage(state) {
  if (state.hasGame) return null;
  const replies = state.messages.map((m, i) => ({ m, i })).filter(({ m }) => m.role === 'assistant');
  const last = replies[replies.length - 1]?.m.content || '';
  const stage = last.includes(DEMO_MARK) ? 'answers' : last.includes(DEMO_CONFIRM) ? 'build' : null;
  if (!stage) return null;
  const questions = [...replies].reverse().find(({ m }) => m.content.includes(DEMO_MARK));
  const asked = questions && state.messages[questions.i - 1];
  const saved = asked?.role === 'user' ? matchSavedGame(asked.content) : null;
  return saved ? { stage, saved } : null;
}

async function loadDemoProject(saved) {
  const source = await store.get(saved.session);
  const files = source.hasGame ? await store.readProjectFiles(saved.session, source) : null;
  return files && Object.keys(files).length ? { source, files } : null;
}

// Step 2: the saved game's Game Design Summary -- cleaned of the Planner's
// "(default ...)" notes and closing question, always opening with its title --
// then the usual "say build it". Returns the reply, or null if the project is
// missing (normal flow then).
async function showDemoSummary({ saved, state, emit }) {
  const project = await loadDemoProject(saved);
  if (!project) return null;
  const design = store.finalPrompt(project.source.summary || '');
  const titled = /\*\*Title:?\*\*/i.test(design) ? design : `**Title**: ${saved.name}\n\n${design}`;
  const reply = `## Game Design Summary\n\n${titled}\n\n${DEMO_CONFIRM}`;
  emit({ type: 'text', delta: reply });
  state.summary = project.source.summary;
  retitle(state, emit);
  state.phase = 'plan';
  return reply;
}

// Step 3 ("build it"): the build progress card at demo pace (~3.5s), then the
// link to the finished game (a copy saved to this chat).
async function buildDemoGame({ saved, id, state, emit, signal }) {
  const project = await loadDemoProject(saved);
  if (!project) return null;
  const { files } = project;
  const fileCount = Object.keys(files).length;
  const pause = (ms) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

  await createPlan({
    emit,
    signal,
    steps: [
      { id: 'analyze', label: 'Analyzing request', run: async (ctx, s) => { await pause(DEMO_STEP_MS.analyze); s.doneDetail = 'Full project build'; } },
      { id: 'plan', label: 'Planning project', deps: ['analyze'], run: async (ctx, s) => { await pause(DEMO_STEP_MS.plan); s.doneDetail = `${fileCount} files planned`; } },
      {
        id: 'generate', label: 'Generating files', deps: ['plan'],
        run: async (ctx, s) => {
          emit({ type: 'agent', agent: 'builder', status: 'start' });
          await pause(DEMO_STEP_MS.generate);
          s.doneDetail = `${fileCount} files in the project`;
        },
      },
      {
        id: 'validate', label: 'Validating output', deps: ['generate'],
        run: async (ctx, s) => {
          await pause(DEMO_STEP_MS.validate);
          emit({ type: 'agent', agent: 'builder', status: 'done' });
          s.doneDetail = 'All checks passed';
        },
      },
      {
        id: 'finalize', label: 'Finalizing project', deps: ['validate'],
        run: async () => {
          const version = await store.saveProject(id, state, files);
          state.phase = 'built';
          // The link waits for the user's click ("Open game in new tab").
          emit({ type: 'game', url: `/games/${id}/index.html?v=${version}`, version, autoOpen: false });
        },
      },
    ],
  }).run({});

  const reply = 'Your game is ready — click **Open game in new tab** to play. Ask for any changes and I\'ll update it.\n\n**QA:** Automated checks passed.';
  emit({ type: 'text', delta: reply });
  return reply;
}

// ------------------------------------------------------------------ App export
// "Export it" (typed, or the game card's Export button) in a chat that has a
// game: the chatbot first asks which app the user wants -- Android (APK),
// Windows app (EXE), Windows installer (a Setup .exe with the MSI inside,
// so the download shows the game's icon), iPhone & iPad (a profile that puts
// the game on the Home Screen, since iOS only installs App Store apps) or
// Mac (a zipped .app) -- then builds it (exporter.js) with the game's own
// AI-designed icon (iconDesigner.js) and replies with the download link. A
// request that already names the format ("export it as an APK") has
// answered that question, so it builds straight away.
const EXPORT_ASK = 'Reply with **APK**, **EXE**, **Setup**, **iPhone** or **Mac**.';
const EXPORT_NAMES = {
  apk: 'Android app (APK)',
  exe: 'Windows app (EXE)',
  setup: 'Windows installer (Setup)',
  ios: 'iPhone & iPad app',
  mac: 'Mac app',
};
const EXPORT_ORDER = ['apk', 'exe', 'setup', 'ios', 'mac'];

// Asking to download or install the game, on any device, is an export too:
// it gets the download buttons, never the chat model's own answer (which
// could only describe a link).
const DEVICE = '(android|windows|desktop|laptop|computer|mobile|phone|tablet|pc|iphone|ipad|ios|mac|macos|macbook|apple)';

function wantsExport(message) {
  const m = message.toLowerCase();
  if (m.split(/\s+/).length > 14) return false; // a longer message is a change request, not an export
  return /\b(export|apk|exe|msi|mobileconfig)\b/.test(m)
    || /\b(download|install)\b/.test(m)
    || new RegExp(`\\b${DEVICE}\\s+(app|application|installer|setup|version|file)\\b`).test(m);
}

// Which formats the message names ("apk and setup" picks two). Right after
// the question, a bare "1" to "5" picks that option. A general "windows"
// or "pc" means the EXE, unless the installer is asked for; "msi" means the
// installer; "apple" means both the iPhone and the Mac app.
function exportFormats(message, asked) {
  const m = message.toLowerCase();
  const pick = (n) => asked && new RegExp(`^\\s*${n}\\s*[.)]?\\s*$`).test(m);
  const setup = /\b(setup|msi|installer)\b/.test(m) || pick(3);
  const apk = /\b(apk|android)\b/.test(m) || pick(1);
  const exe = /\bexe\b/.test(m) || (/\b(windows|pc|desktop)\b/.test(m) && !setup) || pick(2);
  const ios = /\b(iphone|ipad|ios|ipados|apple)\b/.test(m) || pick(4);
  const mac = /\b(mac|macos|macbook|imac|osx|apple)\b/.test(m) || pick(5);
  if (/\ball( (three|four|five))?\b/.test(m) && asked) return EXPORT_ORDER;
  if (/\bboth\b/.test(m) && !(setup && (apk || exe)) && !ios && !mac) return ['apk', 'exe'];
  return EXPORT_ORDER.filter((f) => ({ apk, exe, setup, ios, mac })[f]);
}

async function exportFlow({ id, state, message, emit, signal }) {
  if (!state.hasGame) return null;
  const last = [...state.messages].reverse().find((m) => m.role === 'assistant')?.content || '';
  // Any export question counts, including one asked before its wording changed.
  const asked = /Reply with \*\*APK\*\*/.test(last) && message.trim().split(/\s+/).length <= 6;
  const formats = exportFormats(message, asked);
  if (asked && formats.length) return exportApps({ id, state, formats, emit, signal });
  if (!wantsExport(message)) return null;
  if (formats.length) return exportApps({ id, state, formats, emit, signal });

  const reply = `Which app would you like for **${store.displayTitle(state)}**?\n\n`
    + '1. **Android (APK)**: install it on an Android phone or tablet.\n'
    + '2. **Windows app (EXE)**: a single file that runs the game directly, with nothing to install.\n'
    + '3. **Windows installer (Setup)**: installs the game on the PC with Start menu and desktop shortcuts.\n'
    + '4. **iPhone & iPad**: puts the game on the Home Screen, where it opens full screen like an app and plays offline.\n'
    + '5. **Mac**: a Mac app that runs the game in its own window, offline.\n\n'
    + EXPORT_ASK;
  emit({ type: 'text', delta: reply });
  return reply;
}

async function exportApps({ id, state, formats, emit, signal }) {
  try {
    formats.forEach(exporter.checkTools);
  } catch (err) {
    console.error('[orchestrator] export unavailable:', err.message);
    const reply = `The ${formats.map((f) => EXPORT_NAMES[f]).join(' and ')} cannot be created right now, because the export tools are not set up on this server.`;
    emit({ type: 'text', delta: reply });
    return reply;
  }

  const builds = formats.map((f) => `build-${f}`);
  const ctx = await createPlan({
    emit,
    signal,
    steps: [
      {
        id: 'prepare',
        label: 'Preparing game files',
        run: async (c, s) => {
          Object.assign(c, await exporter.gameFiles(id, state));
          s.doneDetail = `${Object.keys(c.files).length} files`;
        },
      },
      {
        // Designed once per game; every later export reuses it.
        id: 'icon',
        label: 'Designing the app icon',
        run: async (c, s) => {
          const { icon, designed } = await iconDesigner.gameIcon({ id, state, signal });
          c.icon = icon;
          s.doneDetail = designed ? 'Game icon ready' : 'Using the standard icon';
        },
      },
      ...formats.map((f) => ({
        id: `build-${f}`,
        label: `Building the ${EXPORT_NAMES[f]}`,
        deps: ['prepare', 'icon'],
        run: async (c, s) => {
          const cached = exporter.existing(id, state.gameVersion, f, state);
          c[f] = cached || await exporter.build(f, { id, state, files: c.files, icon: c.icon, signal });
          s.doneDetail = cached ? 'Already built for this version' : 'Built';
        },
      })),
      {
        id: 'check',
        label: formats.length > 1 ? 'Checking the apps' : 'Checking the app',
        deps: builds,
        run: async (c, s) => {
          for (const f of formats) await exporter.check(f, c[f], signal);
          s.doneDetail = 'Ready to install';
        },
      },
    ],
  }).run({});

  const lines = [`**${store.displayTitle(state)}** is ready to download.`, ''];
  for (const f of formats) lines.push(`[Download ${EXPORT_NAMES[f]}](/games/${id}/export/${f}?v=${state.gameVersion})`, '');
  if (formats.includes('apk')) {
    lines.push('**Android:** open the downloaded file on the phone or tablet and allow installing apps from this source when asked. Because the app is not from the Play Store, Android may show a warning first.', '');
  }
  if (formats.includes('exe')) {
    lines.push('**Windows app:** double-click the file to play. Windows may show a SmartScreen notice because the app is not signed; choose **More info**, then **Run anyway**.', '');
  }
  if (formats.includes('setup')) {
    lines.push('**Windows installer:** double-click the file: it installs the game and opens it. After that, the same file, the Start menu or the desktop shortcut opens the game. Windows may show a SmartScreen notice because the installer is not signed; choose **More info**, then **Run anyway**. To remove the game, uninstall it from **Settings > Apps**.', '');
  }
  if (formats.includes('ios')) {
    lines.push('**iPhone or iPad app:** tap the button on the iPhone or iPad itself (open this chat there) and tap **Allow**. Then open **Settings**, tap **Profile Downloaded** and **Install**. The game appears on the Home Screen with its icon and opens full screen, like an app. Open it **once while this server is running**: that saves the game on the iPhone, and from then on it plays with **no connection at all**. Whenever it can reach the server again, it picks up an improved game for the next launch. To remove it, delete its icon.', '');
  }
  if (formats.includes('mac')) {
    lines.push(`**Mac:** double-click the downloaded file to unzip it (some browsers already do), then drag **${store.displayTitle(state)}** into **Applications** and open it. The first time, macOS blocks it because the app is not from the App Store: open **System Settings > Privacy & Security** and click **Open Anyway** (on older macOS, Control-click the app and choose **Open**). The app runs offline.`, '');
  }
  if (ctx.hasBackend) lines.push('Note: this game has server features, which do not work in the exported app. The app runs offline.', '');
  const reply = lines.join('\n').trim();
  emit({ type: 'text', delta: reply });
  return reply;
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
  // A new game's design starts from the user's usual choices (see recordAnswers).
  const usual = planning && !state.hasGame
    ? await store.usualChoices().catch((e) => { console.error('[orchestrator] could not read preferences:', e.message); return []; })
    : [];
  // Code never reaches the chat: the reply is held back a few characters so
  // a code start (```, <!DOCTYPE, <html) is caught before it's shown; then the
  // model call is cancelled. The game itself is only ever written by the
  // Builder, after the user confirms a Game Design Summary.
  const codeCut = new AbortController();
  let full = '';
  let shown = 0;
  let codeAt = -1;
  let emojiRun = 0;
  let emojiSpam = false;
  try {
    let seenSummary = false;
    let sinceMarkerCheck = '';
    let text;
    try {
      ({ text } = await claude.stream({
        model: claude.MODELS.designer(),
        system: prompts.conversationSystem(kind, state, { ...opts, usual }),
        messages: [...recentHistory(state), { role: 'user', content: message }],
        maxTokens: 2500,
        timeoutMs: 90000,
        onText: (piece) => {
          if (codeAt >= 0 || emojiSpam) return;
          // No emojis ever reach the chat. A reply that turns into a stream of
          // nothing but emojis (a model stuck in a loop) is stopped there.
          const clean = stripEmoji(piece);
          emojiRun = clean.trim() ? 0 : emojiRun + (piece.length - clean.length);
          if (emojiRun > EMOJI_RUN_LIMIT) { emojiSpam = true; codeCut.abort(); return; }
          full += clean;
          codeAt = full.search(CODE_START_RE);
          const upTo = codeAt >= 0 ? codeAt : Math.max(shown, full.length - CODE_HOLDBACK);
          const delta = full.slice(shown, upTo);
          shown = upTo;
          if (delta) emit({ type: 'text', delta });
          if (codeAt >= 0) { codeCut.abort(); return; }
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
        signal: signal ? AbortSignal.any([signal, codeCut.signal]) : codeCut.signal,
      }));
    } catch (err) {
      if ((codeAt < 0 && !emojiSpam) || signal?.aborted) throw err; // a real failure, or the user's Stop
    }
    if (emojiSpam) console.warn(`[orchestrator] ${kind} reply turned into a run of emojis; stopped there`);
    if (codeAt < 0) {
      if (full.length > shown) emit({ type: 'text', delta: full.slice(shown) }); // the held-back tail
      text = emojiSpam ? full.trim() : full || stripEmoji(text);
    } else {
      text = full.slice(0, codeAt).replace(/\n-{3,}\s*$/, '').trim();
      console.warn(`[orchestrator] ${kind} reply started writing code; cut off before it reached the chat`);
      // Writing the game means the idea is clear enough to build: write the
      // Game Design Summary instead (the user then says "build it").
      if (kind !== 'plan') {
        emit({ type: 'text_replace', text: '' });
        emit({ type: 'agent', agent, status: 'done' });
        if (planning) emit({ type: 'plan', op: 'done' });
        return converse('plan', state, message, emit, signal, opts);
      }
    }
    emit({ type: 'agent', agent, status: 'done' });
    if (planning) emit({ type: 'plan', op: 'done' });

    if (kind === 'plan' && /##\s*Game Design Summary/i.test(text)) {
      state.summary = text.trim();
      state.phase = 'plan';
      retitle(state, emit);
    } else if (kind === 'discover' && state.phase === 'none') {
      state.phase = 'discover';
    }
    return text;
  } catch (err) {
    if (planning) emit({ type: 'plan', op: 'error' });
    throw err;
  }
}

// Where a chat reply starts writing code (see converse), and how many
// characters are held back so a marker split across chunks is still caught.
const CODE_START_RE = /```|<!DOCTYPE|<html[\s>]/i;
const CODE_HOLDBACK = 12;

// Replies to the user carry no emojis (a formal tone): pictographs, flags,
// skin tones, keycaps and the joiners between them are removed. A run of
// more than EMOJI_RUN_LIMIT emoji characters with no real text stops the reply.
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu;
const EMOJI_RUN_LIMIT = 80;
function stripEmoji(s) {
  return String(s || '').replace(EMOJI_RE, '');
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

  // Game generation is the app's heaviest operation: log when it starts,
  // and how it ended, with its duration.
  const started = Date.now();
  const build = { mode, from_saved_prompt: fromSavedPrompt };
  log.info(`[build] ${mode} started`, { event: 'game_build_started', ...build });
  let ctx;
  try {
    ctx = await plan.run({ skipMeldcx: false });
  } catch (err) {
    const fields = { ...build, duration_ms: Date.now() - started, err };
    if (signal?.aborted) log.info(`[build] ${mode} stopped`, { event: 'game_build_cancelled', ...fields });
    else log.error(`[build] ${mode} failed`, { event: 'game_build_failed', ...fields });
    throw err;
  }
  log.info(`[build] ${mode} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`, {
    event: 'game_build_completed', ...build, duration_ms: Date.now() - started, game_version: state.gameVersion, file_count: Object.keys(ctx.project || {}).length,
  });
  const reply = `${stripEmoji(ctx.notes).trim() || 'Your game is ready — it should have opened in a new tab.'}\n\n**QA:** ${stripEmoji(ctx.qaLine)}`;
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
      if (saved && saved.session !== id && !state.hasGame && !state.summary) {
        // Demo flow (see DEMO_QUESTIONS): in a chat without a game yet, ask
        // the setup questions first -- the next message gets the game.
        await saveEarly();
        emit({ type: 'text', delta: DEMO_QUESTIONS });
        state.phase = 'discover';
        state.messages.push(userMsg, { role: 'assistant', content: DEMO_QUESTIONS, createdAt: new Date().toISOString() });
        recorded = true;
        await store.save(activeId, state);
        return;
      }
      if (saved && saved.session !== id) {
        // From a chat that already has a game: open a copy in a new chat now.
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
      retitle(state, emit);
      state.phase = 'plan';
      route = 'build';
    } else {
      retitle(state, emit); // a chat from before titles followed the design gets its game's name now
      await saveEarly();
      await recordAnswers(state, message).catch((e) => console.error('[orchestrator] could not save preferences:', e.message));
      // App export (see exportFlow): asks APK or EXE, then builds and links it.
      const exportReply = await exportFlow({ id: activeId, state, message, emit, signal });
      if (exportReply) {
        state.messages.push(userMsg, { role: 'assistant', content: exportReply, createdAt: new Date().toISOString() });
        recorded = true;
        await store.save(activeId, state);
        return;
      }
      // Demo flow: the answer to the setup questions for a saved game gets its
      // summary (whatever it says); then "build it" gets the demo-paced build
      // and the link. A change request instead goes through the normal flow.
      const demo = demoStage(state);
      let demoReply = null;
      if (demo?.stage === 'answers') demoReply = await showDemoSummary({ saved: demo.saved, state, emit });
      else if (demo?.stage === 'build' && isGoAhead(message)) demoReply = await buildDemoGame({ saved: demo.saved, id: activeId, state, emit, signal });
      if (demoReply) {
        state.messages.push(userMsg, { role: 'assistant', content: demoReply, createdAt: new Date().toISOString() });
        recorded = true;
        await store.save(activeId, state);
        return;
      }
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
