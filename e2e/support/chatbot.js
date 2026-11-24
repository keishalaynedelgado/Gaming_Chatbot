'use strict';
// Drives the real chatbot UI (frontend/index.html + src/main.js) the way a
// user does. Selectors come from that markup: the composer textarea
// (aria-label "Message"), the Send/Stop buttons, the sidebar's "Saved prompts"
// tab (#tabPrompts) whose list items (.chat-item-main / .chat-item-title)
// load a prompt into the composer, and the chat's .msg.user / .msg.error /
// a.game-link elements.
const { expect } = require('@playwright/test');

// minutes -> ms, from an env override
const minutes = (name, fallback) => Number(process.env[name] || fallback) * 60 * 1000;
const GENERATION_TIMEOUT_MS = minutes('E2E_GENERATION_TIMEOUT_MIN', 20);

// The environment, not the app, is at fault: no AI provider, credentials, or
// network. Everything else the app reports is the app's own failure. The
// first entry is the exact message chatController.js sends for a provider
// outage (AI_UNAVAILABLE); the rest are llm.js's provider errors.
const ENVIRONMENT_ERRORS = [
  /The AI is temporarily unavailable/i,
  /No AI provider is available/i,
  /\berror \((401|403|408|429|5\d\d)\)/i,
  /did not respond within \d+s/i,
  /stalled( mid-stream)? \(/i,
  /Could not reach the server|Failed to fetch|NetworkError|ECONNREFUSED/i,
];

class BlockedError extends Error {}

function classifyError(message) {
  return ENVIRONMENT_ERRORS.some((re) => re.test(message)) ? 'BLOCKED' : 'FAIL';
}

// Records each verification for the report: one line per check with its
// result, also mirrored as a report annotation.
class Checklist {
  constructor() {
    this.items = [];
  }

  record(name, status, detail = '') {
    detail = detail.replace(/\u001b\[[0-9;]*m/g, ''); // assertion messages carry terminal colours
    const existing = this.items.find((i) => i.name === name);
    if (existing) Object.assign(existing, { status, detail });
    else this.items.push({ name, status, detail });
  }

  get failed() {
    return this.items.filter((i) => i.status === 'FAIL');
  }

  markdown() {
    return this.items.map((i) => `- **${i.status}** — ${i.name}${i.detail ? `: ${i.detail}` : ''}`).join('\n');
  }
}

// The backend must be the chatbot (not something else on the port) and
// have an AI key; otherwise no valid result is possible.
async function checkEnvironment(request) {
  let health;
  try {
    const res = await request.get('/api/health', { timeout: 10000 });
    health = res.ok() ? await res.json().catch(() => null) : null;
    if (!health || health.ok !== true) throw new Error(`GET /api/health answered ${res.status()} without the chatbot's health payload`);
  } catch (err) {
    throw new BlockedError(`The chatbot backend is unreachable at the base URL (${err.message.split('\n')[0]})`);
  }
  if (!health.hasKey) throw new BlockedError('The chatbot has no AI API key configured (MELDCX_API_KEY / SCX_API_KEY in .env)');
}

// The saved prompt as the app itself lists it (GET /api/saved-prompts, the
// same list the sidebar shows) -- the single source of truth for its text.
async function findSavedPrompt(request, { title, startsWith }) {
  const res = await request.get('/api/saved-prompts');
  expect(res.ok(), 'GET /api/saved-prompts').toBeTruthy();
  const { prompts } = await res.json();
  const matches = prompts.filter((p) => p.title === title);
  expect(matches, `exactly one saved prompt titled "${title}"`).toHaveLength(1);
  const prompt = matches[0];
  expect(prompt.spec.trimStart().startsWith(startsWith), `saved prompt "${title}" is the expected one (starts with ${JSON.stringify(startsWith)})`).toBeTruthy();
  return prompt;
}

// Every game session that existed before this test, so the test can prove
// the game it gets is newly generated, not an earlier one.
async function existingGameSessions(request) {
  const ids = new Set();
  const saved = await (await request.get('/api/saved-prompts')).json();
  for (const p of saved.prompts) if (p.gameSession) ids.add(p.gameSession);
  const res = await request.get('/api/sessions');
  if (res.ok()) {
    const body = await res.json();
    for (const s of body.sessions || body || []) if (s && s.id) ids.add(s.id);
  }
  return ids;
}

async function openChatbot(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'K Games' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeEditable();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  // The app shows this banner when its own health check fails.
  const banner = page.locator('#banner');
  if (await banner.isVisible()) throw new BlockedError(`The chatbot shows: ${await banner.innerText()}`);
}

// Saved prompts tab -> click the prompt: the app opens a fresh chat with the
// prompt's exact text in the composer ("Builds on Send").
async function loadSavedPrompt(page, prompt) {
  await page.getByRole('tab', { name: /Saved prompts/ }).click();
  const item = page.locator('#chatList .chat-item-main').filter({
    has: page.locator('.chat-item-title', { hasText: new RegExp(`^${prompt.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  });
  await expect(item).toHaveCount(1);
  await item.click();
  const input = page.getByRole('textbox', { name: 'Message' });
  await expect(input).toHaveValue(prompt.spec);
  await expect(page.locator('#savedChip')).toBeVisible();
  await expect(page.locator('#savedChip')).toContainText(prompt.title);
  // A fresh chat: nothing from an earlier chat on screen.
  await expect(page.locator('#messages .msg')).toHaveCount(0);
}

// Clicks Send and confirms the message was accepted: it is shown as the
// user's message and the chat is busy (Stop shown, Send disabled).
async function submit(page, prompt) {
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const userMsg = page.locator('#messages .msg.user');
  await expect(userMsg).toHaveCount(1);
  expect((await userMsg.innerText()).trim()).toBe(prompt.spec.trim());
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
}

// Waits for the turn to end -- the app re-enables Send and hides Stop only
// when its /api/chat stream has closed -- then reads the outcome from what
// the chat shows. A turn still running at the deadline is stopped (the same
// Stop button a user would press) and reported as a failure.
async function waitForGeneration(page) {
  const started = Date.now();
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  try {
    await expect(send).toBeEnabled({ timeout: GENERATION_TIMEOUT_MS });
    await expect(stop).toBeHidden();
  } catch {
    const progress = await page.locator('.plan-card').last().innerText().catch(() => '');
    if (await stop.isVisible()) await stop.click().catch(() => {});
    return {
      ok: false,
      kind: 'FAIL',
      reason: `Game generation did not finish within ${GENERATION_TIMEOUT_MS / 60000} minutes (stopped). Progress at the time:\n${progress}`,
      elapsedMs: Date.now() - started,
    };
  }
  const elapsedMs = Date.now() - started;
  const errors = await page.locator('#messages .msg.error').allInnerTexts();
  const progress = await page.locator('.plan-card').last().innerText().catch(() => '');
  const reply = await page.locator('#messages .msg.assistant').last().innerText().catch(() => '');
  if (errors.length) {
    const reason = errors.join('\n');
    return { ok: false, kind: classifyError(reason), reason, elapsedMs, progress, reply };
  }
  const link = page.locator('#messages a.game-link', { hasText: 'Open game in new tab' });
  if (!(await link.count())) {
    return { ok: false, kind: 'FAIL', reason: `The turn ended without a game. The chatbot replied:\n${reply}`, elapsedMs, progress, reply };
  }
  return { ok: true, elapsedMs, progress, reply, gameUrl: await link.last().getAttribute('href') };
}

module.exports = {
  BlockedError, Checklist, GENERATION_TIMEOUT_MS,
  checkEnvironment, findSavedPrompt, existingGameSessions, openChatbot, loadSavedPrompt, submit, waitForGeneration, classifyError,
};
