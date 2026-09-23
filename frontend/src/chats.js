'use strict';
// The left sidebar: a ChatGPT-style list of every chat the user has had in
// this browser, persisted to localStorage. This module owns the sidebar's
// data (the localStorage-backed chat list) and all of its DOM -- main.js
// only ever calls the small controller returned by initSidebar() and never
// touches localStorage or the sidebar markup directly.
//
// Design: the backend (see backend/src/services/store.js) already durably
// persists every chat's full message history and game state on disk, keyed
// by session id -- that's the authoritative copy. This module's localStorage
// entry per chat is a CACHE: enough to render the list instantly (title,
// timestamp, preview) and restore a chat immediately on reload, but every
// chat switch still re-fetches from the server (via the caller's `onSelect`)
// so a cleared/stale/quota-evicted cache can never lose a conversation --
// only ever fall back to a slightly slower reload of the real thing.

const STORAGE_KEY = 'gc_chats';
const LEGACY_SESSION_KEY = 'gc_session'; // pre-sidebar single-session id
const COLLAPSED_KEY = 'gc_sidebar_collapsed';
const CURRENT_VERSION = 1;
const TITLE_MAX = 48;
const PREVIEW_MAX = 84;
const MOBILE_BREAKPOINT = 860;

// ---------------------------------------------------------------- Storage
function emptyStore() {
  return { version: CURRENT_VERSION, activeChatId: null, chats: [] };
}

// Applied in order as `version` climbs, so a store saved by an older build
// always comes back as a valid CURRENT_VERSION store instead of being
// discarded -- the whole point of shipping a version field up front.
const MIGRATIONS = {
  // (no migrations yet -- version 1 is the first shape)
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
    // store's first chat instead of orphaning it.
    const legacyId = readLegacySingleSession();
    if (legacyId) {
      store.chats.push({
        id: legacyId,
        title: 'Previous chat',
        titleAuto: true,
        updatedAt: new Date().toISOString(),
        lastMessage: '',
        gameState: null,
      });
      store.activeChatId = legacyId;
    }
  }
  return store;
}

// Writes to localStorage, degrading gracefully under quota pressure instead
// of losing the whole sidebar: first drop the cached `messages` from every
// chat except the active one (they're always re-fetchable from the server),
// and if it still doesn't fit, drop it from the active one too. The visible
// chat list itself (titles/timestamps/previews) is tiny and kept either way.
function persist(store) {
  const attempt = (s) => localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  try {
    attempt(store);
    return;
  } catch {
    /* fall through to degraded save below */
  }
  try {
    const trimmed = {
      ...store,
      chats: store.chats.map((c) => (c.id === store.activeChatId ? c : { ...c, messages: undefined })),
    };
    attempt(trimmed);
    return;
  } catch {
    /* fall through further */
  }
  try {
    const bare = { ...store, chats: store.chats.map((c) => ({ ...c, messages: undefined })) };
    attempt(bare);
  } catch {
    console.warn('[chats] localStorage unavailable or full; the chat list will not survive a reload this time.');
  }
}

function autoTitle(firstMessage) {
  const flat = (firstMessage || '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'New chat';
  if (flat.length <= TITLE_MAX) return flat;
  const cut = flat.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > 20 ? cut.slice(0, lastSpace) : cut}…`;
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

// ---------------------------------------------------------------- Controller
// Builds the whole sidebar (list, search, new/rename/delete, collapse) and
// returns a small API for main.js to drive it and keep it in sync.
function initSidebar({ onSelect, onNewDraft }) {
  const els = {
    sidebar: document.getElementById('sidebar'),
    backdrop: document.getElementById('sidebarBackdrop'),
    list: document.getElementById('chatList'),
    search: document.getElementById('chatSearch'),
    newChat: document.getElementById('newChat'),
    toggle: document.getElementById('sidebarToggle'),
  };

  let store = load();
  let filter = '';
  let switching = false; // guards against overlapping selects while one is loading

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

  function startRename(li, chat) {
    const titleEl = li.querySelector('.chat-item-title');
    const input = document.createElement('input');
    input.className = 'chat-item-rename';
    input.value = chat.title;
    input.setAttribute('aria-label', 'Rename chat');
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      const next = input.value.trim();
      chat.title = next || chat.title || 'New chat';
      chat.titleAuto = false;
      save();
      render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); render(); }
    });
    input.addEventListener('blur', commit, { once: true });
  }

  function confirmDelete(chat) {
    return window.confirm(`Delete "${chat.title}"? This removes it from your chat list (the game files it created, if any, are not deleted).`);
  }

  function render() {
    const active = store.activeChatId;
    els.list.innerHTML = '';
    const chats = sortedChats().filter((c) => matches(c, filter));

    if (!chats.length) {
      const empty = document.createElement('li');
      empty.className = 'chat-list-empty';
      empty.textContent = filter ? 'No chats match your search.' : 'No chats yet — start one below.';
      els.list.appendChild(empty);
      return;
    }

    for (const chat of chats) {
      const li = document.createElement('li');
      li.className = `chat-item${chat.id === active ? ' active' : ''}`;
      li.dataset.id = chat.id;

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'chat-item-main';
      main.setAttribute('aria-current', chat.id === active ? 'true' : 'false');

      const title = document.createElement('span');
      title.className = 'chat-item-title';
      title.textContent = chat.title || 'New chat';

      const meta = document.createElement('span');
      meta.className = 'chat-item-meta';
      const when = formatWhen(chat.updatedAt);
      const preview = chat.lastMessage ? previewOf(chat.lastMessage) : '';
      meta.textContent = [when, preview].filter(Boolean).join(' · ');

      main.append(title, meta);
      main.addEventListener('click', () => selectChat(chat.id));

      const actions = document.createElement('span');
      actions.className = 'chat-item-actions';

      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'chat-item-action';
      renameBtn.title = 'Rename';
      renameBtn.setAttribute('aria-label', 'Rename chat');
      renameBtn.textContent = '✎';
      renameBtn.addEventListener('click', (e) => { e.stopPropagation(); startRename(li, chat); });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'chat-item-action danger';
      deleteBtn.title = 'Delete';
      deleteBtn.setAttribute('aria-label', 'Delete chat');
      deleteBtn.textContent = '🗑';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirmDelete(chat)) deleteChat(chat.id);
      });

      actions.append(renameBtn, deleteBtn);
      li.append(main, actions);
      els.list.appendChild(li);
    }
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

  function deleteChat(id) {
    store.chats = store.chats.filter((c) => c.id !== id);
    if (store.activeChatId === id) {
      const next = sortedChats()[0];
      if (next) {
        store.activeChatId = next.id;
        save();
        render();
        onSelect(next.id);
      } else {
        store.activeChatId = null;
        save();
        onNewDraft();
        render();
      }
      return;
    }
    save();
    render();
  }

  // Creates or refreshes a chat's cached list entry. `bump` controls whether
  // this counts as new activity (moves it to the top / updates its
  // timestamp) -- true for an actual new turn, false when just re-syncing
  // the cache after fetching a chat's real state from the server.
  function upsert(id, { messages, hasGame, gameUrl }, { bump } = { bump: true }) {
    let chat = store.chats.find((c) => c.id === id);
    const firstUser = messages.find((m) => m.role === 'user');
    const last = messages[messages.length - 1];
    if (!chat) {
      chat = { id, title: autoTitle(firstUser?.content), titleAuto: true, updatedAt: new Date().toISOString(), lastMessage: '', gameState: null };
      store.chats.push(chat);
    }
    chat.lastMessage = last ? last.content : chat.lastMessage;
    chat.gameState = hasGame ? { hasGame: true, gameUrl } : null;
    chat.messages = messages;
    if (bump) chat.updatedAt = new Date().toISOString();
    store.activeChatId = id;
    save();
    render();
  }

  function cachedMessages(id) {
    return store.chats.find((c) => c.id === id)?.messages || null;
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
  els.newChat.addEventListener('click', () => {
    store.activeChatId = null;
    save();
    render();
    closeMobileDrawer();
    onNewDraft();
  });

  let wasMobile = window.innerWidth <= MOBILE_BREAKPOINT;
  if (wasMobile) els.sidebar.classList.add('sidebar-hidden');
  else applyCollapsed(loadCollapsed());
  render();

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
    hasChat: (id) => store.chats.some((c) => c.id === id),
    cachedMessages,
    recordActivity: (id, state) => upsert(id, state, { bump: true }),
    refreshCache: (id, state) => upsert(id, state, { bump: false }),
  };
}

export { initSidebar };
