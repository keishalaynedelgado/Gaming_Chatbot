'use strict';
import { initSidebar } from './chats.js';

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
};

let sessionId = null;
let controller = null;
let messages = []; // the active chat's history, mirrored to the sidebar after every turn
let currentGameUrl = null; // persists across turns once a game exists, even on turns that don't rebuild it

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
  let list = null;
  let code = null;
  const closeList = () => {
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
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (/^\s*---+\s*$/.test(line)) { closeList(); out.push('<hr>'); }
    else if (!line.trim()) closeList();
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
  box.innerHTML = '<h2>What should we make?</h2><p>Chat about anything, or describe a game and I will design and build it with you, step by step.</p>';
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
}

function setStatus(text) {
  els.status.hidden = !text;
  els.status.textContent = text || '';
}

function setBusy(busy) {
  els.send.disabled = busy;
  els.input.disabled = busy;
  els.stop.hidden = !busy;
  if (!busy) { setStatus(''); els.input.focus(); }
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

function planStart() {
  const card = document.createElement('div');
  card.className = 'plan-card';
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

function planFinish(card, ok) {
  if (!card) return;
  const active = card.querySelector('.plan-steps .plan-step.active');
  if (active) { active.classList.replace('active', ok ? 'done' : 'error'); setStepIcon(active, ok ? 'done' : 'error'); }
  card.querySelector('.plan-head .plan-spin')?.remove();
}

// ---------------------------------------------------------------- Chat
async function send(text) {
  text = text.trim();
  if (!text || controller) return;
  els.messages.querySelector('.welcome')?.remove();
  addMessage('user', text);
  messages.push({ role: 'user', content: text });
  els.input.value = '';
  autoGrow();

  controller = new AbortController();
  setBusy(true);
  let bubble = null;
  let raw = '';
  let builtGameUrl = null;
  let plan = null;

  const handle = (evt) => {
    if (evt.type === 'agent') {
      if (evt.status === 'start') setStatus(`${AGENTS[evt.agent] || 'Working'}…`);
      else if (evt.status === 'progress' && evt.detail) setStatus(`${AGENTS[evt.agent] || 'Working'}: ${evt.detail}…`);
    } else if (evt.type === 'text') {
      raw += evt.delta;
      if (!bubble) bubble = addMessage('assistant', '');
      bubble.innerHTML = renderMarkdown(raw);
      scrollDown();
    } else if (evt.type === 'game') {
      // The game event arrives before the notes/QA text for this turn, so open the
      // tab immediately; the link is attached to the bubble once it exists below.
      builtGameUrl = evt.url;
      currentGameUrl = evt.url;
      openGame(evt.url);
    } else if (evt.type === 'plan') {
      if (evt.op === 'start') plan = planStart();
      else if (evt.op === 'step') planStep(plan, evt.label);
      else if (evt.op === 'done') planFinish(plan, true);
      else if (evt.op === 'error') planFinish(plan, false);
    } else if (evt.type === 'session') {
      // A completely new game got its own fresh session -- switch to it and
      // reset the visible chat so this game's conversation never mixes with
      // the previous one's. The message that triggered this (already shown
      // above) is re-added so the new chat starts from it.
      sessionId = evt.id;
      messages = [{ role: 'user', content: text }];
      currentGameUrl = null;
      els.messages.innerHTML = '';
      addMessage('user', text);
      bubble = null;
    } else if (evt.type === 'error') {
      addMessage('error', evt.message);
    }
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, message: text }),
      signal: controller.signal,
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
    if (bubble) renderAssistantContent(bubble, raw);
    if (raw) messages.push({ role: 'assistant', content: raw });
    if (builtGameUrl) appendGameLink(builtGameUrl, bubble);
  } catch (err) {
    if (err.name === 'AbortError') addMessage('error', 'Stopped. That message was not saved, so feel free to send it again.');
    else addMessage('error', err.message || 'Could not reach the server.');
  } finally {
    controller = null;
    setBusy(false);
    sidebar.recordActivity(sessionId, { messages, hasGame: Boolean(currentGameUrl), gameUrl: currentGameUrl });
  }
}

// Loads one chat's full history from the server (the authoritative copy --
// see chats.js) and renders it, replacing whatever was shown before. Used
// both for the initial page load and every sidebar chat switch.
async function loadChat(id) {
  if (controller) return;
  sessionId = id;
  try {
    const res = await fetch(`/api/session/${id}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    messages = data.messages.slice();
    currentGameUrl = data.gameUrl;
    if (!data.messages.length) {
      showWelcome();
    } else {
      els.messages.innerHTML = '';
      let lastAssistant = null;
      for (const m of data.messages) {
        const div = addMessage(m.role, m.content);
        if (m.role === 'assistant') lastAssistant = div;
      }
      // Don't auto-open a tab just from loading/reloading the chat; only offer the link.
      if (data.gameUrl) appendGameLink(data.gameUrl, lastAssistant);
    }
    sidebar.refreshCache(id, { messages, hasGame: data.hasGame, gameUrl: data.gameUrl });
  } catch {
    messages = [];
    currentGameUrl = null;
    showWelcome();
  }
}

// Starts a brand new, empty chat -- generates a fresh id but does not touch
// the sidebar's saved list at all (chats.js only ever adds an entry once a
// chat actually has a message, so an unused draft just quietly disappears).
function startNewDraft() {
  if (controller) return;
  sessionId = crypto.randomUUID();
  messages = [];
  currentGameUrl = null;
  showWelcome();
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
els.input.addEventListener('input', autoGrow);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(els.input.value); }
});
els.stop.addEventListener('click', () => controller?.abort());
els.themeToggle?.addEventListener('click', toggleTheme);

applyTheme(currentTheme()); // sync the toggle button's icon/label to whatever index.html already applied
const sidebar = initSidebar({ onSelect: loadChat, onNewDraft: startNewDraft });
checkHealth();
const initialId = sidebar.getActiveId();
if (initialId) loadChat(initialId);
else startNewDraft();
