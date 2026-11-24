'use strict';
// The left sidebar: a ChatGPT-style list of every chat the user has had.
// This module owns the sidebar's data and all of its DOM -- main.js only
// ever calls the small controller returned by initSidebar() and never
// touches localStorage, fetch, or the sidebar markup directly.
//
// Design: PostgreSQL (see backend/src/services/store.js) is the single
// source of truth for the list itself now -- title, recency, preview, game
// state, and soft-delete/restore all live there. localStorage is only ever
// a CACHE: it paints the sidebar instantly before the network round trip
// resolves, and is a fallback if that round trip fails, but every mutation
// (rename/delete/restore) and every full list load talks to the database
// and the database's answer is what's kept -- never merged, always
// replaced -- so the UI can never drift into showing a duplicate or a stale
// entry the database disagrees with.

const STORAGE_KEY = 'gc_chats';
const LEGACY_SESSION_KEY = 'gc_session'; // pre-sidebar single-session id
const COLLAPSED_KEY = 'gc_sidebar_collapsed';
const LEGACY_PINNED_KEY = 'gc_pinned_chats'; // pins from before they were stored in the database -- migrated once
const CURRENT_VERSION = 2;
const PREVIEW_MAX = 84;
const MOBILE_BREAKPOINT = 860;

// ---------------------------------------------------------------- Pinning
// Pins live in the database (each chat's pinnedAt -- the time it was pinned,
// which also keeps pinned chats in pin order), so they survive restarts,
// cleared browsers, Incognito windows and other devices. The localStorage
// chat cache only mirrors them for an instant first paint.
const isPinned = (chat) => Boolean(chat?.pinnedAt);

// Pins saved by an earlier version only in this browser: read once, uploaded
// to the database in their original order, then removed.
function readLegacyPins() {
  try {
    const arr = JSON.parse(localStorage.getItem(LEGACY_PINNED_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- Saved prompts
// Build-ready prompts: the ones the user wrote and saved (🔖 Save prompt)
// plus every game already built (its finalized Game Design Summary). The
// database is the source (GET /api/saved-prompts); localStorage only caches
// the last list so it paints instantly. Picking one loads it into the
// composer, and sending it builds straight away: no questions, no confirmation.
// Line icons for the chat list's buttons (styled in main.css).
const svgIcon = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICONS = {
  pin: svgIcon('<path class="fillable" d="M9 3.5h6l-1.2 5.6 3.4 3.3v2.1H6.8v-2.1l3.4-3.3z"/><path d="M12 14.5v6"/>'),
  pencil: svgIcon('<path d="M4 20h4L19.2 8.8a2.3 2.3 0 0 0-3.3-3.3L4.7 16.7z"/><path d="M14.2 7.2l3.3 3.3"/>'),
  trash: svgIcon('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4.5h6V7"/>'),
  restore: svgIcon('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>'),
};

const PROMPTS_KEY = 'gc_saved_prompts';
const TAB_KEY = 'gc_sidebar_tab';
const PROMPT_TITLE_MAX = 48;

function titleOf(text) {
  const firstLine = (text || '').trim().split('\n')[0].replace(/\s+/g, ' ');
  return firstLine.length > PROMPT_TITLE_MAX ? `${firstLine.slice(0, PROMPT_TITLE_MAX)}…` : firstLine;
}

// A saved game's name for the list, without the leftovers a title taken from
// the chat can carry: leading dashes, "(or let me know if…)" asides, and a
// "Create a …" request phrasing.
function cleanPromptTitle(text) {
  let t = (text || '').trim().split('\n')[0];
  t = t.replace(/^[\s\-–—:•*#]+/, '');
  t = t.replace(/\s*\((?:or |let me know|tell me|feel free)[^)]*\)?/i, '');
  t = t.replace(/^(?:please\s+)?(?:create|make|build|design)\s+(?:me\s+)?(?:a|an|the)?\s*/i, '');
  t = t.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : (text || '').trim();
}

// Genre groups for the Saved prompts tab, in display order. A prompt saved
// with a specific type uses it; otherwise the genre is read from the design's
// "Genre" line, or failing that from the title and request. First match wins,
// so "arcade racing" is Racing and "board game / strategy" is Board & card.
const GENRES = [
  { id: 'arcade', label: 'Arcade', re: /arcade|endless|catch|dodge|flappy|collect/ },
  { id: 'platformer', label: 'Platformer & runner', short: 'Platformer', re: /platform|side-?scroll|runner|jump|mario/ },
  { id: 'racing', label: 'Racing', re: /racing|race car|kart|driving/ },
  { id: 'shooter', label: 'Shooter', re: /shoot|invader|space defen[cs]e/ },
  { id: 'puzzle', label: 'Puzzle', re: /puzzle|match-?3|sudoku|tetris|memory|word game/ },
  { id: 'board', label: 'Board & card', short: 'Board game', re: /board game|chess|checkers|snakes? and ladders?|ludo|card game|tic-?tac/ },
  { id: 'strategy', label: 'Strategy', re: /strategy|tactic|tower defen[cs]e/ },
  { id: 'other', label: 'Other', re: null },
];
// short: the compact name for tags (the welcome cards); otherwise the group heading.
const genreLabelOf = (id, short = false) => {
  const g = GENRES.find((x) => x.id === id) || GENRES[GENRES.length - 1];
  return (short && g.short) || g.label;
};
const MATCH_ORDER = ['board', 'racing', 'shooter', 'platformer', 'puzzle', 'strategy', 'arcade'];

function genreOf(p) {
  if (p.type && GENRES.some((g) => g.id === p.type && g.id !== 'other')) return p.type;
  const genreLine = (p.spec || p.request || '').match(/genre[^\n]*/i)?.[0] || '';
  const fallback = `${p.title || ''}\n${(p.request || '').slice(0, 400)}`;
  for (const text of [genreLine, fallback]) {
    const t = text.toLowerCase();
    if (!t.trim()) continue;
    const hit = MATCH_ORDER.find((id) => GENRES.find((g) => g.id === id).re.test(t));
    if (hit) return hit;
  }
  return 'other';
}

function readJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function loadPrompts() {
  const arr = readJson(PROMPTS_KEY, []);
  return Array.isArray(arr) ? arr.filter((p) => p && p.id && typeof p.spec === 'string' && p.spec && typeof p.request === 'string') : [];
}

async function apiListSavedPrompts() {
  const res = await fetch('/api/saved-prompts');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).prompts || [];
}

function savePrompts(prompts) {
  try {
    localStorage.setItem(PROMPTS_KEY, JSON.stringify(prompts));
  } catch {
    /* saved prompts just won't survive a reload this time */
  }
}

// ---------------------------------------------------------------- Storage
function emptyStore() {
  return { version: CURRENT_VERSION, activeChatId: null, chats: [] };
}

// Applied in order as `version` climbs, so a store saved by an older build
// always comes back as a valid CURRENT_VERSION store instead of being
// discarded -- the whole point of shipping a version field up front.
const MIGRATIONS = {
  // v1 cached each chat's full message list client-side; the database is now
  // the only place messages live (see module comment above) -- drop them,
  // keep everything else so the list still paints instantly on next load.
  1: (store) => ({ ...store, chats: store.chats.map(({ messages, gameState, ...rest }) => ({ ...rest, hasGame: gameState?.hasGame || false, gameUrl: gameState?.gameUrl || null })) }),
};

function migrate(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.chats)) return emptyStore();
  let store = raw;
  let v = Number(store.version) || 0;
  while (v < CURRENT_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) break; // unknown/future version shape -- stop rather than guess
    store = step(store);
    v += 1;
  }
  store.version = CURRENT_VERSION;
  store.chats = store.chats.filter((c) => c && typeof c.id === 'string');
  return store;
}

function readLegacySingleSession() {
  try {
    return localStorage.getItem(LEGACY_SESSION_KEY);
  } catch {
    return null;
  }
}

function load() {
  let store;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    store = raw ? migrate(JSON.parse(raw)) : null;
  } catch {
    store = null;
  }
  if (!store) {
    store = emptyStore();
    // A user from before the sidebar existed has exactly one conversation,
    // referenced only by the old single-id key -- carry it over as this
    // store's first chat instead of orphaning it. The next successful
    // GET /api/sessions replaces this with the database's real record.
    const legacyId = readLegacySingleSession();
    if (legacyId) {
      store.chats.push({ id: legacyId, title: 'Previous chat', titleAuto: true, updatedAt: new Date().toISOString(), lastMessage: '', hasGame: false, gameUrl: null });
      store.activeChatId = legacyId;
    }
  }
  return store;
}

// Writes to localStorage. This is only ever a cache now (see module comment)
// -- tiny (no message bodies), so quota pressure is not the concern it used
// to be, but a write can still fail (private browsing, storage disabled).
function persist(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    console.warn('[chats] localStorage unavailable; the sidebar cache will not survive a reload this time (the database copy is unaffected).');
  }
}

function previewOf(text) {
  const flat = (text || '').replace(/\s+/g, ' ').replace(/[`*_#>]/g, '').trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
}

// ---------------------------------------------------------------- Formatting
const dtFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Whole calendar days between an update time and now (0 = today, 1 =
// yesterday, ...), used to bucket the sidebar into Today / Previous 7 days /
// Older -- ignores time-of-day, matching formatWhen's "Yesterday" logic.
function calendarDaysAgo(iso, now) {
  const d = new Date(iso || 0);
  if (Number.isNaN(d.getTime())) return Infinity;
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  return Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
}

function formatWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (isSameDay(d, now)) return timeFormatter.format(d);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(d, yesterday)) return `Yesterday ${timeFormatter.format(d)}`;
  return dtFormatter.format(d);
}

// ---------------------------------------------------------------- API
// One retry (after a short delay) on a network-level failure only -- never
// on a clean HTTP error response, which means the server actually answered
// and retrying would just get the same answer. Used for every mutation
// (rename/delete/restore), per "handle failed database operations
// gracefully with rollback or retry logic".
async function fetchWithRetry(url, opts, retries = 1) {
  try {
    return await fetch(url, opts);
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, 400));
    return fetchWithRetry(url, opts, retries - 1);
  }
}

async function apiListSessions(deleted) {
  const res = await fetchWithRetry(`/api/sessions${deleted ? '?deleted=1' : ''}`);
  if (!res.ok) throw new Error(`Could not load chats (${res.status})`);
  return (await res.json()).sessions;
}

async function apiRename(id, title) {
  const res = await fetchWithRetry(`/api/session/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Could not rename chat (${res.status})`);
}

async function apiDelete(id) {
  const res = await fetchWithRetry(`/api/session/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Could not delete chat (${res.status})`);
}

async function apiSetPinned(id, pinned) {
  const res = await fetchWithRetry(`/api/session/${id}/pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) throw new Error(`Could not ${pinned ? 'pin' : 'unpin'} chat (${res.status})`);
  return (await res.json()).pinnedAt;
}

async function apiRestore(id) {
  const res = await fetchWithRetry(`/api/session/${id}/restore`, { method: 'POST' });
  if (!res.ok) throw new Error(`Could not restore chat (${res.status})`);
}

// ---------------------------------------------------------------- Controller
// Builds the whole sidebar (list, search, new/rename/delete/restore,
// collapse) and returns a small API for main.js to drive it and keep it in
// sync.
function initSidebar({ onSelect, onNewDraft, onPickPrompt, onNewPrompt, onPromptsChanged }) {
  const els = {
    tabs: document.getElementById('sidebarTabs'),
    tabChats: document.getElementById('tabChats'),
    tabPrompts: document.getElementById('tabPrompts'),
    chatCount: document.getElementById('chatCount'),
    promptCount: document.getElementById('promptCount'),
    sidebar: document.getElementById('sidebar'),
    backdrop: document.getElementById('sidebarBackdrop'),
    list: document.getElementById('chatList'),
    search: document.getElementById('chatSearch'),
    newChat: document.getElementById('newChat'),
    toggle: document.getElementById('sidebarToggle'),
    trashToggle: document.getElementById('chatTrashToggle'),
    error: document.getElementById('sidebarError'),
  };

  let store = load();
  let filter = '';
  let switching = false; // guards against overlapping selects while one is loading
  let trashView = false; // showing deleted chats (for restore) instead of the normal list
  let trashed = []; // last-loaded deleted-chats list, only populated while trashView is open
  let prompts = loadPrompts();
  let tab = 'chats'; // 'chats' | 'prompts'
  try { if (localStorage.getItem(TAB_KEY) === 'prompts') tab = 'prompts'; } catch { /* default tab */ }

  // Shown at once, saved to the database right away; if saving fails the pin
  // is put back the way it was, so the UI never disagrees with the database.
  async function togglePin(id) {
    const chat = store.chats.find((c) => c.id === id);
    if (!chat) return;
    const before = chat.pinnedAt || null;
    const pin = !before;
    chat.pinnedAt = pin ? new Date().toISOString() : null;
    save();
    render();
    try {
      chat.pinnedAt = await apiSetPinned(id, pin);
      save();
      render();
    } catch (err) {
      chat.pinnedAt = before;
      save();
      render();
      showError(`${err.message}. Please try again.`);
    }
  }

  // One-time upload of this browser's old local-only pins, in their order.
  async function migrateLegacyPins() {
    const legacy = readLegacyPins();
    if (!legacy.length) return;
    let allSaved = true;
    for (const id of legacy) {
      const chat = store.chats.find((c) => c.id === id);
      if (!chat || chat.pinnedAt) continue;
      try {
        chat.pinnedAt = await apiSetPinned(id, true);
      } catch {
        allSaved = false;
      }
    }
    if (allSaved) {
      try { localStorage.removeItem(LEGACY_PINNED_KEY); } catch { /* retried next load */ }
    }
    save();
    render();
  }

  function sortedChats() {
    return [...store.chats].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  }

  function matches(chat, q) {
    if (!q) return true;
    const needle = q.toLowerCase();
    return (chat.title || '').toLowerCase().includes(needle) || (chat.lastMessage || '').toLowerCase().includes(needle);
  }

  function save() {
    persist(store);
  }

  function closeMobileDrawer() {
    if (window.innerWidth <= MOBILE_BREAKPOINT) els.sidebar.classList.add('sidebar-hidden');
  }

  function showError(message) {
    if (!els.error) return;
    els.error.textContent = message;
    els.error.hidden = false;
    clearTimeout(showError._t);
    showError._t = setTimeout(() => { els.error.hidden = true; }, 5000);
  }

  // ---- Loading the real list from the database ----
  async function loadFromServer() {
    try {
      const sessions = await apiListSessions(false);
      store.chats = sessions;
      // A chat that no longer exists (or is now in the trash) can't stay active.
      if (store.activeChatId && !sessions.some((s) => s.id === store.activeChatId)) store.activeChatId = null;
      save();
      render();
      await migrateLegacyPins();
    } catch (err) {
      // The database is unreachable right now -- keep showing whatever was
      // last known (the localStorage cache, or the previous successful
      // load) rather than blanking the sidebar out from under the user.
      console.warn('[chats] could not load the chat list from the server; showing the last known list.', err.message);
      showError('Could not reach the server — showing your last known chat list.');
    }
  }

  async function loadTrash() {
    try {
      trashed = await apiListSessions(true);
    } catch (err) {
      console.warn('[chats] could not load deleted chats.', err.message);
      showError('Could not load deleted chats.');
      trashed = [];
    }
    render();
  }

  // ---- Rename ----
  function startRename(li, chat) {
    const titleEl = li.querySelector('.chat-item-title');
    const input = document.createElement('input');
    input.className = 'chat-item-rename';
    input.value = chat.title;
    input.maxLength = 120;
    input.setAttribute('aria-label', 'Rename chat');
    titleEl.replaceWith(input);
    // While renaming, the line under the box shows the keys instead of the preview.
    li.classList.add('is-renaming');
    const meta = li.querySelector('.chat-item-meta');
    if (meta) meta.innerHTML = '<kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel';
    input.focus();
    input.select();

    const commit = async () => {
      const next = input.value.trim();
      const previous = { title: chat.title, titleAuto: chat.titleAuto };
      if (!next || next === chat.title) return render(); // no real change -- just redraw the (now-removed) input away
      chat.title = next;
      chat.titleAuto = false;
      save();
      render();
      try {
        await apiRename(chat.id, next);
      } catch (err) {
        // Rollback: the database rejected/never got the rename -- the UI
        // must not keep showing a title the database doesn't have.
        chat.title = previous.title;
        chat.titleAuto = previous.titleAuto;
        save();
        render();
        showError('Could not rename that chat. Please try again.');
        console.error('[chats] rename failed', err);
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); render(); }
    });
    input.addEventListener('blur', commit, { once: true });
  }

  function confirmDelete(chat) {
    const pinnedNote = isPinned(chat) ? ' It is pinned, so it will also leave your Pinned chats.' : '';
    return window.confirm(`Delete "${chat.title}"?${pinnedNote} You can restore it later from Recently deleted.`);
  }

  // ---- Delete (soft) / Restore ----
  // Pinned chats can be deleted too; confirmDelete() warns that they're pinned.
  async function deleteChat(id) {
    const removed = store.chats.find((c) => c.id === id);
    const removedIndex = store.chats.indexOf(removed);
    const wasActive = store.activeChatId === id;

    // Optimistic: the sidebar updates immediately, before the network call
    // resolves, per "should update immediately without requiring a page refresh".
    store.chats = store.chats.filter((c) => c.id !== id);
    if (wasActive) {
      const next = sortedChats()[0];
      store.activeChatId = next ? next.id : null;
    }
    save();
    render();
    if (wasActive) {
      const next = sortedChats()[0];
      if (next) onSelect(next.id);
      else onNewDraft();
    }

    try {
      await apiDelete(id);
    } catch (err) {
      // Rollback: put it back exactly where it was.
      store.chats.splice(removedIndex, 0, removed);
      if (wasActive) store.activeChatId = id;
      save();
      render();
      if (wasActive) onSelect(id);
      showError('Could not delete that chat. Please try again.');
      console.error('[chats] delete failed', err);
    }
  }

  async function restoreChat(id) {
    const item = trashed.find((c) => c.id === id);
    // Optimistic: drop it from the trash view and show it in the real list
    // immediately, then confirm with the server.
    trashed = trashed.filter((c) => c.id !== id);
    if (item) {
      store.chats = [{ ...item, deletedAt: null }, ...store.chats.filter((c) => c.id !== id)];
      save();
    }
    render();
    try {
      await apiRestore(id);
      await loadFromServer(); // pick up the authoritative updatedAt/ordering
    } catch (err) {
      // Rollback: it's still deleted as far as the database is concerned.
      if (item) {
        store.chats = store.chats.filter((c) => c.id !== id);
        save();
      }
      trashed = [item, ...trashed].filter(Boolean);
      render();
      showError('Could not restore that chat. Please try again.');
      console.error('[chats] restore failed', err);
    }
  }

  function toggleTrash() {
    trashView = !trashView;
    els.trashToggle.setAttribute('aria-pressed', String(trashView));
    els.trashToggle.textContent = trashView ? '← Back to chats' : '🗑 Recently deleted';
    els.search.hidden = trashView;
    els.newChat.hidden = trashView;
    els.tabs.hidden = trashView;
    if (trashView) loadTrash();
    else render();
  }

  // ---- Rendering ----
  function renderTrashItem(chat) {
    const li = document.createElement('li');
    li.className = 'chat-item';
    li.dataset.id = chat.id;

    const main = document.createElement('div');
    main.className = 'chat-item-main';
    const title = document.createElement('span');
    title.className = 'chat-item-title';
    title.textContent = chat.title || 'New chat';
    const meta = document.createElement('span');
    meta.className = 'chat-item-meta';
    meta.textContent = `Deleted ${formatWhen(chat.deletedAt)}`;
    main.append(title, meta);

    const actions = document.createElement('span');
    actions.className = 'chat-item-actions';
    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'chat-item-action';
    restoreBtn.title = 'Restore';
    restoreBtn.setAttribute('aria-label', 'Restore chat');
    restoreBtn.innerHTML = ICONS.restore;
    restoreBtn.addEventListener('click', () => restoreChat(chat.id));
    actions.appendChild(restoreBtn);

    li.append(main, actions);
    return li;
  }

  function buildChatItem(chat, active) {
    const li = document.createElement('li');
    li.className = `chat-item${chat.id === active ? ' active' : ''}`;
    li.dataset.id = chat.id;

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'chat-item-main';
    main.setAttribute('aria-current', chat.id === active ? 'true' : 'false');

    const pinnedChat = isPinned(chat);
    const title = document.createElement('span');
    title.className = 'chat-item-title';
    title.textContent = chat.title || 'New chat';
    if (pinnedChat) {
      const mark = document.createElement('span');
      mark.className = 'pin-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.innerHTML = ICONS.pin;
      title.prepend(mark);
    }

    const meta = document.createElement('span');
    meta.className = 'chat-item-meta';
    const when = formatWhen(chat.updatedAt);
    const preview = chat.lastMessage ? previewOf(chat.lastMessage) : '';
    meta.textContent = [when, preview].filter(Boolean).join(' · ');

    main.append(title, meta);
    main.addEventListener('click', () => selectChat(chat.id));

    const actions = document.createElement('span');
    actions.className = 'chat-item-actions';

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = `chat-item-action pin-btn${pinnedChat ? ' pinned' : ''}`;
    pinBtn.title = pinnedChat ? 'Unpin' : 'Pin';
    pinBtn.setAttribute('aria-label', pinnedChat ? 'Unpin chat' : 'Pin chat');
    pinBtn.innerHTML = ICONS.pin;
    pinBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePin(chat.id); });

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'chat-item-action rename-btn';
    renameBtn.title = 'Rename';
    renameBtn.setAttribute('aria-label', 'Rename chat');
    renameBtn.innerHTML = ICONS.pencil;
    renameBtn.addEventListener('click', (e) => { e.stopPropagation(); startRename(li, chat); });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'chat-item-action danger';
    deleteBtn.title = 'Delete';
    deleteBtn.setAttribute('aria-label', 'Delete chat');
    deleteBtn.innerHTML = ICONS.trash;
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirmDelete(chat)) deleteChat(chat.id);
    });

    actions.append(pinBtn, renameBtn, deleteBtn);
    li.append(main, actions);
    return li;
  }

  function appendGroup(label, chats, active) {
    if (!chats.length) return;
    const header = document.createElement('li');
    header.className = label === 'Pinned' ? 'chat-group-header is-pinned' : 'chat-group-header';
    if (label === 'Pinned') header.innerHTML = `<span class="pin-mark" aria-hidden="true">${ICONS.pin}</span>`;
    header.append(label);
    els.list.appendChild(header);
    for (const chat of chats) els.list.appendChild(buildChatItem(chat, active));
  }

  // ---- Saved prompts ----
  function switchTab(next) {
    if (next === tab) return;
    tab = next;
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* not remembered this time */ }
    applyTab();
    render();
  }

  function applyTab() {
    const onPrompts = tab === 'prompts';
    els.tabChats.setAttribute('aria-selected', String(!onPrompts));
    els.tabPrompts.setAttribute('aria-selected', String(onPrompts));
    els.search.placeholder = onPrompts ? 'Search saved prompts…' : 'Search chats…';
    els.search.setAttribute('aria-label', onPrompts ? 'Search saved prompts' : 'Search chats');
    if (els.trashToggle) els.trashToggle.hidden = onPrompts; // the trash only holds chats
  }

  async function loadPromptsFromServer() {
    try {
      prompts = await apiListSavedPrompts();
      savePrompts(prompts);
      render();
    } catch {
      /* keep showing the cached list */
    }
  }

  // A fresh build just finished: show it at the top right away, then take the
  // database's list (a rebuild of an existing design just moves it up).
  function addCompletedPrompt({ title, request, spec }) {
    if (!spec || !request) return;
    const entry = { id: `local_${Date.now().toString(36)}`, title: title || titleOf(request), request, spec, savedAt: new Date().toISOString() };
    prompts = [entry, ...prompts.filter((p) => p.spec !== spec)];
    render();
    loadPromptsFromServer();
  }

  // Picking a saved prompt loads it into a fresh chat's composer, ready to
  // edit; sending it then builds immediately (see main.js).
  function pickPrompt(prompt) {
    store.activeChatId = null;
    save();
    render();
    closeMobileDrawer();
    onPickPrompt?.(prompt);
  }

  function buildPromptItem(prompt) {
    const li = document.createElement('li');
    li.className = 'chat-item';
    li.dataset.id = prompt.id;

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'chat-item-main';
    const name = cleanPromptTitle(prompt.title);
    const ready = !!prompt.gameSession;
    main.title = ready
      ? `Load "${name}" — the game is already built and opens on Send`
      : `Load "${name}" into the chat box — Send builds it right away`;
    const title = document.createElement('span');
    title.className = 'chat-item-title';
    title.textContent = titleOf(name);
    const meta = document.createElement('span');
    meta.className = 'chat-item-meta';
    const status = document.createElement('span');
    status.className = ready ? 'prompt-status is-ready' : 'prompt-status';
    status.textContent = ready ? '▶ Ready to play' : '⚡ Builds on Send';
    meta.append(status, ` · ${formatWhen(prompt.savedAt)}`);
    main.append(title, meta);
    main.addEventListener('click', () => pickPrompt(prompt));

    li.append(main);
    return li;
  }

  function renderPrompts() {
    const newLi = document.createElement('li');
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'sidebar-new-prompt';
    newBtn.textContent = '＋ New saved prompt';
    newBtn.addEventListener('click', () => { closeMobileDrawer(); onNewPrompt?.(); });
    newLi.appendChild(newBtn);
    els.list.appendChild(newLi);

    const needle = filter.toLowerCase();
    const genreLabel = (id) => GENRES.find((g) => g.id === id).label;
    const shown = prompts
      .map((p) => ({ p, genre: genreOf(p) }))
      .filter(({ p, genre }) => !needle || `${p.title}\n${p.request}\n${genreLabel(genre)}`.toLowerCase().includes(needle));
    if (!shown.length) {
      const empty = document.createElement('li');
      empty.className = 'chat-list-empty';
      empty.textContent = filter ? 'No saved prompts match your search.' : 'No saved prompts yet — save your own with 🔖 Save prompt, and every game you build shows up here too.';
      els.list.appendChild(empty);
      return;
    }
    // One group per genre (newest first inside each), in GENRES order.
    for (const g of GENRES) {
      const items = shown.filter((x) => x.genre === g.id);
      if (!items.length) continue;
      const header = document.createElement('li');
      header.className = 'chat-group-header prompt-group-header';
      header.append(g.label);
      const count = document.createElement('span');
      count.className = 'prompt-group-count';
      count.textContent = String(items.length);
      header.appendChild(count);
      els.list.appendChild(header);
      for (const { p } of items) els.list.appendChild(buildPromptItem(p));
    }
  }

  function render() {
    els.list.innerHTML = '';
    els.chatCount.textContent = String(store.chats.length);
    els.promptCount.textContent = String(prompts.length);
    onPromptsChanged?.(prompts);

    if (tab === 'prompts' && !trashView) {
      renderPrompts();
      return;
    }

    if (trashView) {
      if (!trashed.length) {
        const empty = document.createElement('li');
        empty.className = 'chat-list-empty';
        empty.textContent = 'Nothing in the trash.';
        els.list.appendChild(empty);
        return;
      }
      for (const chat of [...trashed].sort((a, b) => new Date(b.deletedAt || 0) - new Date(a.deletedAt || 0))) {
        els.list.appendChild(renderTrashItem(chat));
      }
      return;
    }

    const active = store.activeChatId;
    const chats = sortedChats().filter((c) => matches(c, filter));

    if (!chats.length) {
      const empty = document.createElement('li');
      empty.className = 'chat-list-empty';
      empty.textContent = filter ? 'No chats match your search.' : 'No chats yet — start one below.';
      els.list.appendChild(empty);
      return;
    }

    // Pinned chats always surface first, regardless of how recent they are;
    // everything else buckets by recency, same idea as most chat apps' history.
    const rest = chats.filter((c) => !isPinned(c));
    const now = new Date();
    const today = rest.filter((c) => calendarDaysAgo(c.updatedAt, now) <= 0);
    const last7 = rest.filter((c) => { const d = calendarDaysAgo(c.updatedAt, now); return d > 0 && d <= 7; });
    const older = rest.filter((c) => calendarDaysAgo(c.updatedAt, now) > 7);

    // Pinned in the order they were pinned (first pinned stays on top).
    appendGroup('Pinned', chats.filter(isPinned).sort((a, b) => (a.pinnedAt < b.pinnedAt ? -1 : 1)), active);
    appendGroup('Today', today, active);
    appendGroup('Previous 7 days', last7, active);
    appendGroup('Older', older, active);
  }

  async function selectChat(id) {
    if (switching || id === store.activeChatId) return;
    switching = true;
    try {
      store.activeChatId = id;
      save();
      render();
      closeMobileDrawer();
      await onSelect(id);
    } finally {
      switching = false;
    }
  }

  // Creates or refreshes a chat's cached list entry from a turn's real
  // outcome. `title`/`titleAuto` always come from the server (the SSE
  // 'title' event for a brand new chat, or GET /api/session/:id otherwise)
  // -- never guessed client-side, so the sidebar can never disagree with
  // what's actually in the database. `bump` controls whether this counts as
  // new activity (moves it to the top / updates its timestamp) -- true for
  // an actual new turn, false when just re-syncing after a fetch.
  function upsert(id, { messages, hasGame, gameUrl, title, titleAuto }, { bump, activate = true }) {
    let chat = store.chats.find((c) => c.id === id);
    const last = messages[messages.length - 1];
    if (!chat) {
      chat = { id, title: title || 'New chat', titleAuto: titleAuto !== false, updatedAt: new Date().toISOString(), lastMessage: '', hasGame: false, gameUrl: null };
      store.chats.push(chat);
    } else if (title !== undefined && title !== null) {
      chat.title = title;
      chat.titleAuto = titleAuto !== false;
    }
    chat.lastMessage = last ? last.content : chat.lastMessage;
    if (hasGame !== undefined) {
      chat.hasGame = Boolean(hasGame);
      chat.gameUrl = hasGame ? gameUrl : null;
    }
    if (bump) chat.updatedAt = new Date().toISOString();
    if (activate) store.activeChatId = id;
    save();
    render();
  }

  // ---- Collapse / mobile drawer ----
  function applyCollapsed(collapsed) {
    els.sidebar.classList.toggle('sidebar-collapsed', collapsed);
    els.toggle.setAttribute('aria-expanded', String(!collapsed));
  }

  function loadCollapsed() {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  }

  function toggleSidebar() {
    if (window.innerWidth <= MOBILE_BREAKPOINT) {
      els.sidebar.classList.toggle('sidebar-hidden');
      return;
    }
    const collapsed = !els.sidebar.classList.contains('sidebar-collapsed');
    applyCollapsed(collapsed);
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      /* the collapsed state just won't survive a reload */
    }
  }

  // ---- Wiring ----
  els.toggle.addEventListener('click', toggleSidebar);
  els.backdrop.addEventListener('click', () => els.sidebar.classList.add('sidebar-hidden'));
  els.search.addEventListener('input', () => { filter = els.search.value.trim(); render(); });
  els.trashToggle?.addEventListener('click', toggleTrash);
  els.tabChats.addEventListener('click', () => switchTab('chats'));
  els.tabPrompts.addEventListener('click', () => switchTab('prompts'));
  // Standard tablist keyboard behaviour: arrows move between the two tabs.
  els.tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = tab === 'chats' ? 'prompts' : 'chats';
    switchTab(next);
    (next === 'chats' ? els.tabChats : els.tabPrompts).focus();
  });
  applyTab();
  function startNewChat() {
    store.activeChatId = null;
    save();
    render();
    closeMobileDrawer();
    onNewDraft();
  }
  els.newChat.addEventListener('click', startNewChat);
  // Matches the "+ New chat" button's own on-screen shortcut hint (Alt+N) --
  // never left as a decoration that doesn't actually do anything.
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      startNewChat();
    }
  });

  let wasMobile = window.innerWidth <= MOBILE_BREAKPOINT;
  if (wasMobile) els.sidebar.classList.add('sidebar-hidden');
  else applyCollapsed(loadCollapsed());
  render(); // instant paint from cache
  loadFromServer(); // then reconcile with the database, the authoritative copy
  loadPromptsFromServer(); // same for the saved (already built) games

  // Only the initial load decides which mode to start in; this keeps it
  // correct if the viewport is later resized across the breakpoint (a
  // rotated tablet, a resized window) without needing a reload.
  window.addEventListener('resize', () => {
    const isMobile = window.innerWidth <= MOBILE_BREAKPOINT;
    if (isMobile === wasMobile) return;
    wasMobile = isMobile;
    if (isMobile) {
      els.sidebar.classList.remove('sidebar-collapsed');
      els.sidebar.classList.add('sidebar-hidden');
    } else {
      els.sidebar.classList.remove('sidebar-hidden');
      applyCollapsed(loadCollapsed());
    }
  });

  return {
    getActiveId: () => store.activeChatId,
    newChat: startNewChat,
    recordActivity: (id, state) => upsert(id, state, { bump: true }),
    refreshCache: (id, state) => upsert(id, state, { bump: false }),
    // Updates a chat's list entry mid-turn (title, new session, final reply)
    // without making it the selected chat if the user has moved elsewhere.
    updateChat: (id, state, { bump = false, activate = true } = {}) => upsert(id, state, { bump, activate }),
    addCompletedPrompt,
    refreshSavedPrompts: loadPromptsFromServer,
    // A prompt the server just confirmed saving: listed and cached at once, so
    // it's there after a refresh even if the follow-up list fetch fails.
    addSavedPrompt: (p) => {
      if (!p || !p.spec) return;
      prompts = [p, ...prompts.filter((x) => x.spec !== p.spec)];
      savePrompts(prompts);
      render();
    },
  };
}

export { initSidebar, genreOf, genreLabelOf, cleanPromptTitle };
