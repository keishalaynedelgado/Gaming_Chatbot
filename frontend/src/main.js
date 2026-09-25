'use strict';
import { initSidebar } from './chats.js';
import { createMascot, setMascotStatus } from './mascot.js';

const AGENTS = {
  intent: 'Understanding your request',
  designer: 'Game Designer is thinking',
  planner: 'Game Planner is drafting the design summary',
  builder: 'Game Builder is writing your game',
  qa: 'QA Agent is testing the game',
  chat: 'Thinking',
};

const $ = (id) => document.getElementById(id);
const els = {
  messages: $('messages'), status: $('status'), banner: $('banner'),
  composer: $('composer'), input: $('input'), send: $('send'), stop: $('stop'),
  themeToggle: $('themeToggle'),
  savePrompt: $('savePrompt'),
  savedChip: $('savedChip'), savedChipTitle: $('savedChipTitle'), savedChipClose: $('savedChipClose'),
};

// ---------------------------------------------------------------- Saved prompts
// Picking a saved game puts its finalized prompt in the composer (editable);
// while this mode is on, sending it goes straight to building -- the text is
// sent as the spec, so any edits made first are what gets built. Clearing the
// box or the chip's ✕ turns it back into a normal message.
const MAX_MESSAGE_LEN = 4000;
const MAX_SAVED_PROMPT_LEN = 20000; // matches the server's saved-prompt limit
let savedPromptMode = false;
let savedPromptType = null; // the saved prompt's Type, sent along as a Builder hint
let savedPromptId = null; // the user's saved prompt being built, linked to the finished game
let savedPromptsCache = []; // latest Saved prompts list, for the New Chat screen's cards

function setSavedPromptMode(on, title = '', type = null, id = null) {
  savedPromptMode = on;
  savedPromptType = on ? type : null;
  savedPromptId = on ? id : null;
  els.savedChip.hidden = !on;
  els.savedChipTitle.textContent = on && title ? `: ${title}` : '';
  els.input.maxLength = on ? MAX_SAVED_PROMPT_LEN : MAX_MESSAGE_LEN;
}

let sessionId = null;
let messages = []; // the active chat's history, mirrored to the sidebar after every turn
let currentGameUrl = null; // persists across turns once a game exists, even on turns that don't rebuild it
// Every chat runs its own turn, independently: replies can be generating in
// several chats at once, and switching chats never stops, resets or mixes
// them. A turn draws into the page only while its chat is on screen
// ("attached"); otherwise it keeps streaming into its own state (reply text,
// plan progress, status) and is redrawn as soon as its chat is opened again
// (see attachTurn).
const turns = new Map(); // session id -> its in-progress turn
const currentTurn = () => turns.get(sessionId);

// Leaving the chat on screen: every turn keeps running, just unseen.
function detachTurns() {
  for (const t of turns.values()) {
    t.attached = false;
    t.bubble = null;
    t.plan = null;
  }
}

function applyPlanEvent(turn, evt) {
  if (evt.op === 'start') turn.plan = planStart(evt.steps);
  else if (evt.op === 'step' && evt.id) planTrack(turn.plan, evt);
  else if (evt.op === 'step') planStep(turn.plan, evt.label);
  else if (evt.op === 'done') planFinish(turn.plan, true);
  else if (evt.op === 'error') planFinish(turn.plan, false);
}

// Back on a chat whose reply is still generating: redraw its progress and the
// reply so far, then keep updating live.
function attachTurn(turn) {
  turn.attached = true;
  for (const evt of turn.planEvents) applyPlanEvent(turn, evt);
  if (turn.raw) {
    turn.bubble = addMessage('assistant', '');
    turn.bubble.innerHTML = renderMarkdown(turn.raw);
  }
  for (const msg of turn.errors) addMessage('error', msg);
  scrollDown();
}

// ---------------------------------------------------------------- Theme
// Dark is the default; light is available but only ever applied by an
// explicit click here, never inferred from OS/browser preference -- and the
// choice is remembered. (index.html applies a saved choice synchronously,
// before first paint, so switching pages never flashes the wrong theme.)
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  if (els.themeToggle) {
    els.themeToggle.textContent = theme === 'light' ? '☀️' : '🌙';
    els.themeToggle.setAttribute('aria-label', theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f5f8' : '#0c0e13');
}

function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    localStorage.setItem('gc_theme', next);
  } catch {
    /* storage unavailable; the choice just won't survive a reload */
  }
}

// ---------------------------------------------------------------- Rendering
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(t) {
  return t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
}

// Small markdown subset. Input is HTML-escaped first, so output is safe to inject.
function renderMarkdown(src) {
  const out = [];
  let list = null; // top-level list currently open: null | 'ol' | 'ul'
  let liOpen = false; // an 'ol' item left open in case bullets nest under it
  let nested = false; // a <ul> currently open inside that ol item, for sub-options
  let code = null;
  // Closes the current top-level <ol> item (and any bullets nested under it) --
  // called before starting the next item, or before leaving the list entirely.
  const closeOlLi = () => {
    if (list === 'ol' && liOpen) {
      if (nested) { out.push('</ul>'); nested = false; }
      out.push('</li>');
      liOpen = false;
    }
  };
  const closeList = () => {
    closeOlLi();
    if (list) { out.push(`</${list}>`); list = null; }
  };
  for (const line of escapeHtml(src).split('\n')) {
    if (/^```/.test(line)) {
      if (code === null) { closeList(); code = []; } else { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = null; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { closeList(); out.push(`<h${m[1].length < 3 ? 3 : 4}>${inline(m[2])}</h${m[1].length < 3 ? 3 : 4}>`); }
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      // A model reply commonly lists 2-4 bullet options right under a numbered
      // question -- nest those inside that question's <li> instead of treating
      // them as a sibling list, which would otherwise split the <ol> in two and
      // restart its numbering at 1.
      if (list === 'ol' && liOpen) {
        if (!nested) { out.push('<ul>'); nested = true; }
        out.push(`<li>${inline(m[1])}</li>`);
      } else {
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        out.push(`<li>${inline(m[1])}</li>`);
      }
    }
    else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } else { closeOlLi(); }
      out.push(`<li>${inline(m[1])}`);
      liOpen = true;
    }
    else if (/^\s*---+\s*$/.test(line)) { closeList(); out.push('<hr>'); }
    else if (!line.trim()) { /* blank line: don't break a list -- models often write "loose" lists with a blank line between items */ }
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  if (code !== null) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
  closeList();
  return out.join('');
}

function scrollDown() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

// Splits an assistant reply that contains a "## Game Design Summary" heading into
// the text before it, the summary block itself, and the trailing paragraph (the
// planner's "does this match?" confirmation), so the summary can get its own card.
function splitSummary(raw) {
  const idx = raw.search(/##\s*Game Design Summary/i);
  if (idx === -1) return null;
  const before = raw.slice(0, idx).trim();
  const paras = raw.slice(idx).split(/\n{2,}/);
  let after = '';
  let body = paras;
  if (paras.length > 1) {
    after = paras[paras.length - 1].trim();
    body = paras.slice(0, -1);
  }
  const summary = body.join('\n\n').replace(/^##\s*Game Design Summary\s*/i, '').trim();
  return summary ? { before, summary, after } : null;
}

// Renders an assistant reply, pulling any Game Design Summary out into its own
// visually distinct card instead of leaving it as plain chat text.
function renderAssistantContent(el, raw) {
  const split = splitSummary(raw);
  if (!split) {
    el.innerHTML = renderMarkdown(raw);
    return;
  }
  el.innerHTML = '';
  if (split.before) {
    const p = document.createElement('div');
    p.innerHTML = renderMarkdown(split.before);
    el.appendChild(p);
  }
  const card = document.createElement('div');
  card.className = 'design-summary-card';
  const head = document.createElement('div');
  head.className = 'design-summary-head';
  head.textContent = '🎮 Game Design Summary';
  const body = document.createElement('div');
  body.innerHTML = renderMarkdown(split.summary);
  card.append(head, body);
  el.appendChild(card);
  if (split.after) {
    const p = document.createElement('div');
    p.innerHTML = renderMarkdown(split.after);
    el.appendChild(p);
  }
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (role === 'assistant') renderAssistantContent(div, text);
  else div.textContent = text;
  els.messages.appendChild(div);
  scrollDown();
  return div;
}

function showWelcome() {
  els.messages.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'welcome';
  box.innerHTML = '<div class="welcome-hero"><div class="welcome-bubble">Hi! Tell me a game idea and I\'ll help you design and build it.</div></div><h2>Where should we <span class="accent-word">start?</span></h2><p>Chat about anything, or describe a game and I will design and build it with you, step by step.</p>';
  box.querySelector('.welcome-hero').prepend(createMascot({ placement: 'welcome' }));
  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const text of ['I want to make a game', 'Surprise me with a game idea', 'What can you do?']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', () => send(text));
    chips.appendChild(b);
  }
  box.appendChild(chips);
  els.messages.appendChild(box);
  renderWelcomeSavedPrompts();
}

// The status shows in the corner mascot's speech bubble; the #status line
// stays in sync as the screen-reader announcement and the visible fallback on
// phones, where the bubble doesn't fit (see main.css).
function setStatus(text) {
  els.status.hidden = !text;
  els.status.textContent = text || '';
  setMascotStatus(cornerMascot, text);
}

// The composer reflects only the chat on screen: busy (Stop shown, input
// locked, its status in Vi's bubble) while that chat has a reply generating;
// other chats stay free to use.
function refreshComposer() {
  const turn = currentTurn();
  els.send.disabled = Boolean(turn);
  els.input.disabled = Boolean(turn);
  els.stop.hidden = !turn;
  setStatus(turn?.status || '');
}

// ---------------------------------------------------------------- Game tab
// Every generated game opens in its own browser tab, named after the session so
// rebuilding or improving the game re-uses that same tab instead of piling up new
// ones. The tab is not given noopener/noreferrer: those flags make browsers create
// a fresh, unnamed tab every time (no reuse). This is safe because the game itself
// is served with a CSP `sandbox` policy that has no allow-top-navigation, so it can
// never use window.opener to navigate this chat tab away, even without noopener.
function gameTarget() {
  return `game-${sessionId}`;
}

function openGame(url) {
  let win = null;
  try {
    win = window.open(url, gameTarget());
    win?.focus();
  } catch {
    /* popups can be blocked by the browser; the link in the chat still works */
  }
  return win;
}

// Appends a click-to-open link (and a project download link) into a message
// bubble. A real click always works even when the automatic window.open() above
// gets popup-blocked.
function appendGameLink(url, bubble) {
  const target = bubble || addMessage('assistant', '');
  const open = document.createElement('a');
  open.href = url;
  open.target = gameTarget();
  open.className = 'game-link';
  open.textContent = 'Open game in new tab ↗';
  target.appendChild(open);

  const download = document.createElement('a');
  download.href = url.replace(/\/index\.html(\?.*)?$/, '/download');
  download.className = 'game-link ghost';
  download.textContent = 'Download project ↓';
  target.appendChild(download);
}

// ---------------------------------------------------------------- Planning feed
// A small, muted checklist shown above the reply while the agents design or build
// a game. It only ever displays short, user-facing milestones sent by the server
// (see lib/plan.js) -- never the model's private reasoning. Each user request that
// triggers game work gets its own card, created once and updated in place as work
// moves through its stages (never a new card per internal stage) -- the same
// pattern used by other assistants' per-response "thinking" indicators.
function setStepIcon(li, state) {
  const icon = li.querySelector('.plan-icon');
  icon.className = `plan-icon plan-${state}`;
  icon.textContent = state === 'done' ? '✓' : state === 'error' ? '⚠' : '';
}

// A tracked build plan (see backend planRunner.js): every step is listed up
// front, then each one's status updates in place -- pending, running, done,
// retrying, skipped or failed -- with a running "done of total" count.
const TRACK_ICONS = { pending: '', active: '', retry: '', done: '✓', skipped: '–', failed: '⚠' };

function planTrack(card, evt) {
  if (!card) return;
  const li = card.querySelector(`.plan-step[data-id="${CSS.escape(evt.id)}"]`);
  if (!li) return;
  li.className = `plan-step plan-${evt.status}`;
  const icon = li.querySelector('.plan-icon');
  const spinning = evt.status === 'active' || evt.status === 'retry';
  icon.className = `plan-icon ${spinning ? 'plan-spin' : `plan-${evt.status}`}`;
  icon.textContent = TRACK_ICONS[evt.status] ?? '';
  const detail = li.querySelector('.plan-detail');
  detail.textContent = evt.detail ? ` — ${evt.detail}` : '';
  if (evt.progress) card.querySelector('.plan-count').textContent = `${evt.progress.done}/${evt.progress.total}`;
}

function planStart(steps) {
  const card = document.createElement('div');
  card.className = 'plan-card';
  if (Array.isArray(steps) && steps.length) {
    const head = document.createElement('div');
    head.className = 'plan-head';
    head.innerHTML = '<span class="plan-icon plan-spin" aria-hidden="true"></span><span>Plan</span><span class="plan-count"></span>';
    head.querySelector('.plan-count').textContent = `0/${steps.length}`;
    const list = document.createElement('ul');
    list.className = 'plan-steps';
    for (const s of steps) {
      const li = document.createElement('li');
      li.className = 'plan-step plan-pending';
      li.dataset.id = s.id;
      const icon = document.createElement('span');
      icon.className = 'plan-icon plan-pending';
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = s.label;
      const detail = document.createElement('span');
      detail.className = 'plan-detail';
      label.appendChild(detail);
      li.append(icon, label);
      list.appendChild(li);
    }
    card.append(head, list);
    els.messages.appendChild(card);
    scrollDown();
    return card;
  }
  const head = document.createElement('div');
  head.className = 'plan-head';
  const spin = document.createElement('span');
  spin.className = 'plan-icon plan-spin';
  spin.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = 'Planning';
  head.append(spin, label);
  const list = document.createElement('ul');
  list.className = 'plan-steps';
  card.append(head, list);
  els.messages.appendChild(card);
  scrollDown();
  return card;
}

function planStep(card, label) {
  if (!card) return;
  const list = card.querySelector('.plan-steps');
  const active = list.querySelector('.plan-step.active');
  if (active) { active.classList.replace('active', 'done'); setStepIcon(active, 'done'); }
  const li = document.createElement('li');
  li.className = 'plan-step active';
  const icon = document.createElement('span');
  icon.className = 'plan-icon plan-spin';
  icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = label;
  li.append(icon, text);
  list.appendChild(li);
  scrollDown();
}

// Stop: freeze the progress card -- running steps are marked stopped and
// nothing spins on.
function planStop(card) {
  if (!card) return;
  card.querySelector('.plan-head .plan-spin')?.remove();
  for (const li of card.querySelectorAll('.plan-step.active, .plan-step.plan-active, .plan-step.plan-retry')) {
    li.className = 'plan-step plan-skipped';
    const icon = li.querySelector('.plan-icon');
    icon.className = 'plan-icon plan-skipped';
    icon.textContent = '–';
    const detail = li.querySelector('.plan-detail');
    if (detail) detail.textContent = ' — Stopped';
  }
}

function planFinish(card, ok) {
  if (!card) return;
  const active = card.querySelector('.plan-steps .plan-step.active');
  if (active) { active.classList.replace('active', ok ? 'done' : 'error'); setStepIcon(active, ok ? 'done' : 'error'); }
  card.querySelector('.plan-head .plan-spin')?.remove();
}

// ---------------------------------------------------------------- Chat
// opts.spec: a saved, finalized Game Design Summary -- the server then skips
// straight to building it (see orchestrator.handleChat).
async function send(text, opts = {}) {
  text = text.trim();
  if (!text || currentTurn()) return; // this chat already has a reply generating
  if (savedPromptMode) {
    opts = { ...opts, spec: text, promptType: savedPromptType, savedPromptId };
    setSavedPromptMode(false);
  }
  els.messages.querySelector('.welcome')?.remove();
  addMessage('user', text);
  messages.push({ role: 'user', content: text });
  els.input.value = '';
  autoGrow();

  // Everything about this turn lives on it, so it can keep going while its
  // chat isn't on screen -- and never touches another chat's state.
  const turn = {
    session: sessionId,
    messages, // this chat's history (the same array while it's on screen)
    attached: true,
    controller: new AbortController(),
    raw: '', // the reply so far
    bubble: null,
    plan: null,
    planEvents: [], // replayed to redraw the progress card on return
    errors: [],
    status: '',
    saved: false,
    builtGameUrl: null,
    newTitle: null,
    newTitleAuto: null,
  };
  const shown = () => turn.attached && sessionId === turn.session;
  turns.set(turn.session, turn);
  // The chat exists from this moment: listed in the sidebar right away (the
  // server saves it before the AI starts, and confirms the real title).
  sidebar.recordActivity(turn.session, { messages: turn.messages, hasGame: Boolean(currentGameUrl), gameUrl: currentGameUrl });
  refreshComposer();

  const handle = (evt) => {
    if (evt.type === 'agent') {
      if (evt.status === 'start') turn.status = `${AGENTS[evt.agent] || 'Working'}…`;
      else if (evt.status === 'progress' && evt.detail) turn.status = `${AGENTS[evt.agent] || 'Working'}: ${evt.detail}…`;
      if (shown()) setStatus(turn.status);
    } else if (evt.type === 'text') {
      turn.raw += evt.delta;
      if (!shown()) return;
      if (!turn.bubble) turn.bubble = addMessage('assistant', '');
      turn.bubble.innerHTML = renderMarkdown(turn.raw);
      scrollDown();
    } else if (evt.type === 'game') {
      // The game event arrives before the notes/QA text for this turn, so open the
      // tab immediately; the link is attached to the bubble once it exists below.
      turn.builtGameUrl = evt.url;
      if (shown()) currentGameUrl = evt.url;
      if (evt.autoOpen !== false) openGame(evt.url); // reused saved games wait for the user's click
    } else if (evt.type === 'plan') {
      turn.planEvents.push(evt);
      if (shown()) applyPlanEvent(turn, evt);
    } else if (evt.type === 'session') {
      // A completely new game got its own fresh session: the turn moves to
      // it, and (if on screen) the view follows, starting from this message.
      const wasShown = shown();
      turns.delete(turn.session);
      turn.session = evt.id;
      turns.set(turn.session, turn);
      turn.messages = [{ role: 'user', content: text }];
      turn.newTitle = null; // a fresh session gets its own title event again below
      turn.newTitleAuto = null;
      if (wasShown) {
        sessionId = evt.id;
        messages = turn.messages;
        currentGameUrl = null;
        els.messages.innerHTML = '';
        addMessage('user', text);
        turn.bubble = null;
        turn.plan = null;
      }
      sidebar.updateChat(turn.session, { messages: turn.messages, hasGame: false, gameUrl: null }, { activate: wasShown });
    } else if (evt.type === 'saved') {
      turn.saved = true; // the server has this turn -- it survives a dropped connection
    } else if (evt.type === 'completed_prompt') {
      sidebar.addCompletedPrompt(evt);
    } else if (evt.type === 'title') {
      // The database-authoritative title for a brand new chat -- see
      // orchestrator.js. Never guessed client-side.
      turn.newTitle = evt.title;
      turn.newTitleAuto = evt.titleAuto;
      sidebar.updateChat(turn.session, { messages: turn.messages, title: turn.newTitle, titleAuto: turn.newTitleAuto }, { activate: shown() });
    } else if (evt.type === 'error') {
      turn.errors.push(evt.message);
      if (shown()) addMessage('error', evt.message);
    }
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: turn.session, message: text, spec: opts.spec || undefined, promptType: opts.promptType || undefined,
        loadGame: opts.loadGame || undefined, savedPromptId: opts.savedPromptId || undefined,
      }),
      signal: turn.controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (chunk.startsWith('data: ')) {
          try { handle(JSON.parse(chunk.slice(6))); } catch { /* ignore malformed event */ }
        }
      }
    }
    if (turn.raw) turn.messages.push({ role: 'assistant', content: turn.raw });
    if (shown()) {
      if (turn.bubble) renderAssistantContent(turn.bubble, turn.raw);
      if (turn.builtGameUrl) appendGameLink(turn.builtGameUrl, turn.bubble);
    }
  } catch (err) {
    // The connection dropped after the server took the turn: it keeps working
    // (only Stop cancels), so wait for the result instead of reporting failure.
    const lostConnection = err.name !== 'AbortError' && err instanceof TypeError && turn.saved;
    if (lostConnection) waitForTurn(turn);
    if (err.name === 'AbortError' && shown()) planStop(turn.plan);
    if (shown()) {
      if (err.name === 'AbortError') addMessage('error', 'Stopped. Your message is kept in this chat — send it again whenever you like.');
      else if (lostConnection) addMessage('error', 'The connection to the server dropped, but Vi is still working on this in the background. This chat will update by itself when it’s done.');
      else addMessage('error', err.message || 'Could not reach the server.');
    }
  } finally {
    turns.delete(turn.session);
    const onScreen = shown();
    const gameUrl = turn.builtGameUrl || (onScreen ? currentGameUrl : null);
    sidebar.updateChat(turn.session, { messages: turn.messages, hasGame: Boolean(gameUrl), gameUrl, title: turn.newTitle, titleAuto: turn.newTitleAuto }, { bump: true, activate: onScreen });
    if (sessionId === turn.session) {
      // Its chat was reopened but not yet redrawn when it finished: show the saved result.
      if (!onScreen) loadChat(turn.session);
      refreshComposer();
      if (onScreen) els.input.focus();
    }
  }
}

// Loads one chat's full history from the server (the authoritative copy --
// see chats.js) and renders it, replacing whatever was shown before. Used
// both for the initial page load and every sidebar chat switch. A reply
// still generating in the chat being left keeps going in the background; one
// generating in the chat being opened is redrawn and continues live.
async function loadChat(id) {
  detachTurns();
  sessionId = id;
  refreshComposer();
  try {
    const res = await fetch(`/api/session/${id}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (sessionId !== id) return; // switched again while this was loading
    const turn = turns.get(id);
    // A brand-new chat may not be in the database yet: fall back to its turn.
    const list = data.messages.length ? data.messages : turn ? turn.messages : [];
    messages = turn ? turn.messages : list.slice();
    currentGameUrl = data.gameUrl;
    if (!list.length) {
      showWelcome();
    } else {
      els.messages.innerHTML = '';
      let lastAssistant = null;
      for (const m of list) {
        const div = addMessage(m.role, m.content);
        if (m.role === 'assistant') lastAssistant = div;
      }
      // Don't auto-open a tab just from loading/reloading the chat; only offer the link.
      if (data.gameUrl && !turn) appendGameLink(data.gameUrl, lastAssistant);
    }
    if (turn) attachTurn(turn);
    sidebar.refreshCache(id, { messages: list, hasGame: data.hasGame, gameUrl: data.gameUrl, title: data.title, titleAuto: data.titleAuto });
  } catch {
    if (sessionId !== id) return;
    messages = [];
    currentGameUrl = null;
    showWelcome();
  }
}

// Starts a brand new, empty chat -- generates a fresh id but does not touch
// the sidebar's saved list at all (chats.js only ever adds an entry once a
// chat actually has a message, so an unused draft just quietly disappears).
// Replies generating in other chats keep going.
function startNewDraft() {
  detachTurns();
  sessionId = crypto.randomUUID();
  messages = [];
  currentGameUrl = null;
  showWelcome();
  refreshComposer();
  els.input.focus();
}

async function checkHealth() {
  try {
    const { hasKey } = await (await fetch('/api/health')).json();
    if (!hasKey) {
      els.banner.hidden = false;
      els.banner.textContent = 'No API key found. Copy .env.example to .env, set MELDCX_API_KEY, and restart the server.';
    }
  } catch {
    els.banner.hidden = false;
    els.banner.textContent = 'Cannot reach the server. Is it running?';
  }
}

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`;
}

// ---------------------------------------------------------------- Wiring
els.composer.addEventListener('submit', (e) => { e.preventDefault(); send(els.input.value); });
els.input.addEventListener('input', () => {
  autoGrow();
  if (savedPromptMode && !els.input.value.trim()) setSavedPromptMode(false);
});
// ---------------------------------------------------------------- Save Prompt modal
// Anyone can write a game prompt here and save it; it's stored exactly as
// written and treated as final and build-ready (see useSavedPrompt below).
const modal = {
  el: $('savePromptModal'), form: $('savePromptForm'), name: $('savePromptName'), text: $('savePromptText'),
  type: $('savePromptType'), runAuto: $('savePromptRunAuto'), showHome: $('savePromptShowHome'),
  error: $('savePromptError'), cancel: $('savePromptCancel'), submit: $('savePromptSubmit'),
};

function flashSaveButton(text) {
  els.savePrompt.textContent = text;
  clearTimeout(flashSaveButton.t);
  flashSaveButton.t = setTimeout(() => { els.savePrompt.textContent = '🔖 Save prompt'; }, 2200);
}

// Opens the modal, pre-filled with `prefill` (e.g. what's in the chat box).
function openSavePromptModal(prefill = '') {
  modal.form.reset();
  modal.text.value = prefill.trim();
  modal.error.hidden = true;
  modal.el.showModal();
  (modal.text.value ? modal.name : modal.text).focus();
}

modal.cancel.addEventListener('click', () => modal.el.close());
modal.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = modal.text.value.trim();
  if (!prompt) {
    modal.error.textContent = 'Write the game prompt first.';
    modal.error.hidden = false;
    modal.text.focus();
    return;
  }
  modal.submit.disabled = true;
  try {
    const res = await fetch('/api/saved-prompts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: modal.name.value.trim(),
        prompt,
        type: modal.type.value,
        runAuto: modal.runAuto.value === 'yes',
        showOnHome: modal.showHome.checked,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    modal.el.close();
    flashSaveButton('✓ Saved to Saved prompts');
    // Show it (and cache it) right away, then sync with the server's list.
    sidebar.addSavedPrompt(body.prompt);
    sidebar.refreshSavedPrompts();
  } catch (err) {
    modal.error.textContent = `Couldn’t save the prompt (${err.message}). Please try again.`;
    modal.error.hidden = false;
  } finally {
    modal.submit.disabled = false;
  }
});

els.savePrompt.addEventListener('click', () => openSavePromptModal(savedPromptMode ? '' : els.input.value));

// Using a saved prompt: it goes into the chat box of a new chat, exactly as
// saved, to edit if wanted -- and Send then generates the game straight away
// (no questions, planning or confirmation).
function useSavedPrompt(p) {
  startNewDraft(); // its own new chat -- fine even while other chats are busy
  els.input.value = p.spec;
  setSavedPromptMode(true, p.title, p.type, p.custom ? p.id : null);
  autoGrow();
  els.input.focus();
  els.input.setSelectionRange(0, 0);
  els.input.scrollTop = 0;
}

// "Show on the New Chat screen" prompts, as cards under the welcome message.
function renderWelcomeSavedPrompts() {
  const box = els.messages.querySelector('.welcome');
  if (!box) return;
  box.querySelector('.welcome-saved')?.remove();
  const shown = savedPromptsCache.filter((p) => p.showOnHome);
  if (!shown.length) return;
  const section = document.createElement('div');
  section.className = 'welcome-saved';
  const head = document.createElement('div');
  head.className = 'welcome-saved-head';
  head.textContent = 'Saved game prompts';
  const grid = document.createElement('div');
  grid.className = 'welcome-saved-grid';
  for (const p of shown.slice(0, 6)) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'welcome-saved-card';
    const title = document.createElement('span');
    title.className = 'welcome-saved-title';
    title.textContent = p.title;
    const body = document.createElement('span');
    body.className = 'welcome-saved-body';
    body.textContent = p.spec.replace(/[*_#]/g, '').replace(/\s+/g, ' ').trim();
    const meta = document.createElement('span');
    meta.className = 'welcome-saved-meta';
    meta.textContent = '⚡ Builds on Send';
    card.append(title, body, meta);
    card.addEventListener('click', () => useSavedPrompt(p));
    grid.appendChild(card);
  }
  section.append(head, grid);
  box.appendChild(section);
}
els.savedChipClose.addEventListener('click', () => { setSavedPromptMode(false); els.input.focus(); });
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(els.input.value); }
});
// Stop is the only thing that cancels a turn on the server (a dropped
// connection doesn't), so tell it explicitly, then close the stream.
els.stop.addEventListener('click', () => {
  const turn = currentTurn(); // only this chat's reply -- other chats keep going
  if (!turn) return;
  fetch(`/api/session/${turn.session}/stop`, { method: 'POST' }).catch(() => { /* the abort below still ends it here */ });
  turn.controller.abort();
});

// After a dropped connection: poll the chat until the server has saved the
// reply (one more message than this turn had), then show it -- if that chat
// is still the one on screen -- and refresh its sidebar entry.
const RECOVER_POLL_MS = 5000;
const RECOVER_MAX_MS = 30 * 60 * 1000;
async function waitForTurn(turn) {
  const known = turn.messages.length; // includes this turn's user message
  const deadline = Date.now() + RECOVER_MAX_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RECOVER_POLL_MS));
    try {
      const res = await fetch(`/api/session/${turn.session}`);
      if (!res.ok) continue;
      const data = await res.json();
      if (data.messages.length <= known) continue;
      sidebar.refreshCache(turn.session, { messages: data.messages, hasGame: data.hasGame, gameUrl: data.gameUrl, title: data.title, titleAuto: data.titleAuto });
      if (sessionId === turn.session && !turns.has(turn.session)) loadChat(turn.session);
      return;
    } catch {
      /* still offline -- keep waiting */
    }
  }
}
els.themeToggle?.addEventListener('click', toggleTheme);
// Vi's small corner companion, docked to the chat input; CSS keeps it hidden until the first message replaces the welcome screen.
const cornerMascot = createMascot({
  placement: 'corner',
  tips: [
    'Hoot hoot! Click a saved prompt in the sidebar to reuse it in one go.',
    'Describe the goal, controls and vibe of your game — I\'ll handle the rest.',
    'Want changes? Tell me what to tweak and I\'ll rebuild the game.',
    'Every game you finish is saved under Saved prompts — click it to rebuild instantly.',
  ],
});
els.composer.appendChild(cornerMascot);

applyTheme(currentTheme()); // sync the toggle button's icon/label to whatever index.html already applied
const sidebar = initSidebar({
  onSelect: loadChat,
  onNewDraft: startNewDraft,
  // A saved (completed) prompt builds immediately in a fresh chat, from the
  // exact spec it was finalized with -- no questions or confirmation.
  onNewPrompt: () => openSavePromptModal(),
  onPickPrompt: useSavedPrompt,
  onPromptsChanged: (list) => {
    savedPromptsCache = list;
    renderWelcomeSavedPrompts();
  },
});
checkHealth();
const initialId = sidebar.getActiveId();
if (initialId) loadChat(initialId);
else startNewDraft();
