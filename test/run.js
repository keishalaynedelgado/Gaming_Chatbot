'use strict';
// End-to-end test against a mock OpenAI-compatible (MELDCX) API and a real
// (dedicated, disposable) PostgreSQL test database -- no API key and no
// filesystem project storage needed anymore; see backend/src/services/db.js.
const http = require('node:http');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { staticCheck, extractFiles, isSafePath } = require('../backend/src/services/qa');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://gamechatbot:gc_app_pw_2026@127.0.0.1:5432/gamechatbot_test';
process.env.DATABASE_URL = TEST_DATABASE_URL;
const testDb = new Pool({ connectionString: TEST_DATABASE_URL });

async function dbFileExists(id, version, relPath) {
  const { rows } = await testDb.query('SELECT 1 FROM game_files WHERE session_id = $1 AND version = $2 AND path = $3', [id, version, relPath]);
  return rows.length > 0;
}

// The whole point of a session is that it can be deleted outright (cascades
// to its messages and game_files via the FK) -- the equivalent of the old
// fs.rmSync(projects/<id>, { recursive: true }) cleanup between test cases.
async function cleanupSession(id) {
  await testDb.query('DELETE FROM sessions WHERE id = $1', [id]);
}

const GOOD_INDEX = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"></head><body><canvas id="c"></canvas><script type="module" src="./src/main.js"></script></body></html>`;
const GOOD_MAIN = `import { start } from './game/loop.js';\nlet paused = false; function restart() {}\nwindow.addEventListener('keydown', (e) => { if (e.key === 'p') paused = !paused; });\nstart();\n`;
const GOOD_LOOP = `export function start() {\n  function loop() { requestAnimationFrame(loop); }\n  loop();\n}\n`;
const GOOD_FILES = {
  'frontend/index.html': GOOD_INDEX,
  'frontend/src/main.js': GOOD_MAIN,
  'frontend/src/game/loop.js': GOOD_LOOP,
};
const BAD_MAIN = GOOD_MAIN.replace('function restart() {}', 'function restart({}'); // syntax error

let builderCalls = 0;
let repairCalls = 0;
let qaMode = 'PASS';

function filesBlock(map) {
  return Object.entries(map)
    .map(([p, c]) => `<file path="${p}">\n${c}\n</file>`)
    .join('\n');
}

// Emulates an OpenAI-style chat/completions SSE stream, including a leading
// reasoning_content chunk (as real reasoning models on the gateway send).
// finishReason 'length' emulates a response cut off by the token limit.
function sse(res, text, finishReason = 'stop') {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) =>
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  chunk({ role: 'assistant', reasoning_content: 'thinking about it…' });
  for (let i = 0; i < text.length; i += 40) chunk({ content: text.slice(i, i + 40) });
  chunk({}, finishReason);
  res.write('data: [DONE]\n\n');
  res.end();
}

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { messages } = JSON.parse(body);
    const system = messages[0].content;
    const last = messages[messages.length - 1].content;
    if (system.startsWith('You are the Intent Agent')) {
      const route = last.match(/LATEST user message:\nroute:(\w+)/)?.[1] || 'chat';
      return sse(res, `{"route":"${route}"}`);
    }
    if (system.startsWith('You are the Game Builder')) {
      builderCalls += 1;
      const isRepair = last.includes('## Problems found by automated checks');
      const isContinue = last.includes('Files you have ALREADY finished');
      const isImprove = !isRepair && !isContinue && last.includes('## Current project files');
      if (isRepair) {
        repairCalls += 1;
        // MOCK_EMPTY_REPAIR_FIRST emulates a malformed repair reply (no <files>
        // block at all) on the first repair attempt only, to prove a second
        // attempt still gets a chance instead of the whole build crashing.
        if (process.env.MOCK_EMPTY_REPAIR_FIRST === '1' && repairCalls === 1) {
          return sse(res, '<notes>Sorry, let me reconsider that.</notes>');
        }
        return sse(res, `<notes>Built it. Arrow keys move.</notes>\n<files>\n${filesBlock({ 'frontend/src/main.js': GOOD_MAIN })}\n</files>`);
      }
      if (isContinue) {
        // Continuing rewrites the file that was mid-write when cut off, plus
        // whatever was still left -- and this time it actually finishes.
        return sse(res, `<notes>Built it. Arrow keys move.</notes>\n<files>\n${filesBlock({ 'frontend/src/main.js': GOOD_MAIN, 'frontend/src/game/loop.js': GOOD_LOOP })}\n</files>`);
      }
      if (isImprove) {
        return sse(res, `<notes>Built it. Arrow keys move.</notes>\n<files>\n${filesBlock({ 'frontend/src/game/loop.js': GOOD_LOOP.replace('requestAnimationFrame', 'requestAnimationFrame /* faster */') })}\n</files>`);
      }
      // A fresh build. MOCK_TRUNCATE_FIRST emulates the response getting cut off
      // by the token limit mid-way through the last file (no closing </files>,
      // finish_reason 'length').
      if (process.env.MOCK_TRUNCATE_FIRST === '1') {
        return sse(res, `<notes>Built it. Arrow keys move.</notes>\n<files>\n${filesBlock({ 'frontend/index.html': GOOD_INDEX, 'frontend/src/main.js': GOOD_MAIN })}`, 'length');
      }
      const bad = builderCalls === 1 && process.env.MOCK_BAD_FIRST === '1';
      const files = { ...GOOD_FILES };
      if (bad) files['frontend/src/main.js'] = BAD_MAIN;
      return sse(res, `<notes>Built it. Arrow keys move.</notes>\n<files>\n${filesBlock(files)}\n</files>`);
    }
    if (system.startsWith('You are the QA Agent')) {
      if (qaMode === 'FIXED') {
        const files = { 'frontend/src/main.js': GOOD_MAIN.replace('let paused = false;', 'let paused = false; // fixed') };
        return sse(res, `<verdict>FIXED</verdict><report>- fixed restart</report><files>\n${filesBlock(files)}\n</files>`);
      }
      return sse(res, '<verdict>PASS</verdict><report>Looks fine.</report>');
    }
    if (system.includes('PHASE: PLAN')) return sse(res, '## Game Design Summary\n**Title** Test\n\nDoes this match?');
    if (system.includes('PHASE: DISCOVER')) return sse(res, 'What is the objective?');
    sse(res, 'Hi there!');
  });
});

async function chat(port, sessionId, message) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });
  const raw = await res.text();
  return raw.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}

async function main() {
  // ---- Unit checks: qa.js ----
  assert.deepEqual(staticCheck(GOOD_FILES).errors, []);
  assert.ok(staticCheck({ ...GOOD_FILES, 'frontend/src/main.js': BAD_MAIN }).errors[0].includes('syntax error'));
  const brokenImport = { 'frontend/index.html': GOOD_INDEX, 'frontend/src/main.js': GOOD_MAIN };
  assert.ok(staticCheck(brokenImport).errors.some((e) => e.includes('was not generated')), 'missing import target should error');
  assert.ok(staticCheck({}).errors.length > 0);
  assert.ok(staticCheck({ 'frontend/src/main.js': GOOD_MAIN }).errors.some((e) => e.includes('Missing frontend/index.html')));

  // A bare import specifier (no bundler/import map in a browser) must be caught.
  const bareImport = { ...GOOD_FILES, 'frontend/src/game/loop.js': GOOD_LOOP.replace('export function', "import 'phaser';\nexport function") };
  assert.ok(staticCheck(bareImport).errors.some((e) => e.includes('bare module specifier')), 'bare import specifier should error');
  // An entry file referencing a script/stylesheet that was never generated must be caught.
  const brokenEntryRef = { ...GOOD_FILES, 'frontend/index.html': GOOD_INDEX.replace('./src/main.js', './src/missing.js') };
  assert.ok(staticCheck(brokenEntryRef).errors.some((e) => e.includes('missing.js') && e.includes('was not generated')), 'broken entry file reference should error');
  // Importing a name and also re-declaring it locally is a real SyntaxError in a
  // browser, but invisible to a check that strips imports before parsing.
  const dupeDecl = { ...GOOD_FILES, 'frontend/src/main.js': `${GOOD_MAIN}\nfunction start() { return 1; }\n` };
  assert.ok(staticCheck(dupeDecl).errors.some((e) => e.includes('"start"') && e.includes('already been declared')), 'import name re-declared locally should error');

  const parsed = extractFiles(`<files>\n${filesBlock(GOOD_FILES)}\n</files>`);
  // extractFiles trims exactly one trailing newline per file (so round-tripping
  // through serialize+extract doesn't accumulate blank lines); compare modulo that.
  for (const [p, content] of Object.entries(GOOD_FILES)) assert.equal(parsed.files[p], content.replace(/\n$/, ''));
  assert.deepEqual(parsed.skipped, []);
  const unsafe = extractFiles('<files><file path="../../etc/passwd">oops</file></files>');
  assert.deepEqual(unsafe.files, {});
  assert.deepEqual(unsafe.skipped, ['../../etc/passwd']);
  assert.equal(isSafePath('frontend/index.html'), true);
  assert.equal(isSafePath('../frontend/index.html'), false);
  assert.equal(isSafePath('/etc/passwd'), false);
  assert.equal(isSafePath('README.md'), true);
  assert.equal(isSafePath('random.txt'), false);

  // ---- backend/src/services/zip.js ----
  const { buildZip } = require('../backend/src/services/zip');
  const zip = buildZip([{ path: 'frontend/index.html', content: GOOD_INDEX }]);
  assert.ok(Buffer.isBuffer(zip) && zip.length > 0);
  assert.equal(zip.readUInt32LE(0), 0x04034b50); // local file header signature

  // ---- End-to-end against the mock server ----
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = 3900 + Math.floor(Math.random() * 90);
  process.env.MELDCX_API_KEY = 'test-key';
  process.env.MELDCX_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
  process.env.PORT = String(port);
  process.env.MOCK_BAD_FIRST = '1';
  require('../backend/src/server');
  await new Promise((r) => setTimeout(r, 500)); // now includes a real db.migrate() round trip before listen()

  // A dedicated, disposable database -- safe to wipe clean before every run
  // rather than only relying on each test case's own cleanup, in case a
  // previous run crashed mid-test and left rows behind.
  await testDb.query('TRUNCATE sessions CASCADE');

  const id = `test-${Date.now()}`;
  const text = (evts) => evts.filter((e) => e.type === 'text').map((e) => e.delta).join('');

  let evts = await chat(port, id, 'route:chat hello');
  assert.equal(text(evts), 'Hi there!');
  assert.ok(evts.at(-1).type === 'done');

  evts = await chat(port, id, 'route:discover I want a game');
  assert.equal(text(evts), 'What is the objective?');

  evts = await chat(port, id, 'route:build build it now');
  assert.equal(text(evts), 'What is the objective?'); // no summary yet -> falls back to discover

  evts = await chat(port, id, 'route:plan enough info');
  assert.ok(text(evts).includes('## Game Design Summary'));

  // First builder output has a syntax error, so it must be repaired (resending
  // only the broken file), then QA passes and the docs are written server-side.
  evts = await chat(port, id, 'route:build yes build it');
  assert.equal(builderCalls, 2, 'builder should be re-run once to repair the syntax error');
  const game = evts.find((e) => e.type === 'game');
  assert.ok(game && game.version === 1);
  assert.equal(game.url, `/games/${id}/index.html?v=1`);
  assert.ok(text(evts).includes('Built it') && text(evts).includes('QA:'));

  const served = await fetch(`http://127.0.0.1:${port}${game.url}`);
  assert.equal(served.status, 200);
  assert.ok(served.headers.get('content-security-policy').includes('sandbox'));
  assert.equal(await served.text(), GOOD_INDEX);

  // A host bundler.needsBundling() flags (e.g. an ngrok free-tier tunnel) must
  // get the entry script inlined into one dependency-free <script>, since the
  // extra per-file <script src> request would otherwise hit that tunnel's own
  // warning interstitial before ever reaching this server (see bundler.js).
  const tunneled = await new Promise((resolve, reject) => {
    http
      .get({ hostname: '127.0.0.1', port, path: game.url, headers: { host: 'demo.ngrok-free.dev' } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
  assert.equal(tunneled.status, 200);
  assert.ok(!tunneled.body.includes('<script type="module" src='), 'a tunneled host must get the entry script inlined, not referenced by src');
  assert.ok(tunneled.body.includes('__require("frontend/src/main.js")'), 'the inlined bundle must actually run the entry module');
  assert.ok(tunneled.body.includes('function start()'), "the bundle must contain the real module code (loop.js's start), not a stub");
  // A normal (non-tunnel) host must be completely unaffected -- still the
  // original, unbundled multi-file project, exactly as generated.
  assert.equal(await (await fetch(`http://127.0.0.1:${port}${game.url}`)).text(), GOOD_INDEX, 'a normal host must still get the original, unbundled file');

  const servedJs = await fetch(`http://127.0.0.1:${port}/games/${id}/src/game/loop.js`);
  assert.equal(servedJs.status, 200);
  assert.equal((await servedJs.text()).trim(), GOOD_LOOP.trim());
  // docs/ is a sibling of frontend/, not nested inside it, so it must NOT be
  // reachable through the live-preview route (only the download zip has it).
  const gameDesignDoc = await fetch(`http://127.0.0.1:${port}/games/${id}/docs/GAME_DESIGN.md`);
  assert.equal(gameDesignDoc.status, 404);

  // Download is the WHOLE project (including docs/), as a zip.
  const zipRes = await fetch(`http://127.0.0.1:${port}/games/${id}/download`);
  assert.equal(zipRes.status, 200);
  assert.equal(zipRes.headers.get('content-type'), 'application/zip');
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  assert.equal(zipBuf.readUInt32LE(0), 0x04034b50);
  assert.ok(zipBuf.includes(Buffer.from('docs/GAME_DESIGN.md')), 'zip should include the docs folder');

  // Improve: builder returns only the ONE changed file; the rest of the tree
  // (index.html, main.js) must be carried over unchanged into the new version.
  builderCalls = 0;
  qaMode = 'FIXED';
  process.env.MOCK_BAD_FIRST = '0';
  evts = await chat(port, id, 'route:improve make it faster');
  const game2 = evts.find((e) => e.type === 'game');
  assert.equal(game2.version, 2);
  assert.equal(builderCalls, 1, 'improve should not need a repair pass');
  assert.ok(text(evts).includes('fixed restart'));
  const carried = await fetch(`http://127.0.0.1:${port}/games/${id}/index.html?v=2`);
  assert.equal(await carried.text(), GOOD_INDEX, 'unchanged file must be carried over into the new version');
  const changed = await fetch(`http://127.0.0.1:${port}/games/${id}/src/game/loop.js`);
  assert.ok((await changed.text()).includes('/* faster */'), 'changed file must reflect the new version');

  // Old version (v1) must still exist on disk for history/rollback.
  assert.ok(await dbFileExists(id, 1, 'frontend/index.html'));

  // A build that gets cut off by the token limit must continue from exactly
  // what it already finished, rather than fail and discard everything.
  const id2 = `test-truncate-${Date.now()}`;
  await chat(port, id2, 'route:plan enough info');
  builderCalls = 0;
  qaMode = 'PASS';
  process.env.MOCK_TRUNCATE_FIRST = '1';
  evts = await chat(port, id2, 'route:build yes build it');
  assert.equal(builderCalls, 2, 'one truncated attempt + one continuation');
  assert.ok(!text(evts).toLowerCase().includes('too large'), 'must not surface as a failure when continuation succeeds');
  const game3 = evts.find((e) => e.type === 'game');
  assert.ok(game3 && game3.version === 1);
  const mainAfterContinue = await fetch(`http://127.0.0.1:${port}/games/${id2}/src/main.js`);
  assert.equal((await mainAfterContinue.text()).trim(), GOOD_MAIN.trim(), 'the file that was mid-write must be rewritten complete, not left truncated');
  process.env.MOCK_TRUNCATE_FIRST = '0';
  await cleanupSession(id2);

  // A malformed repair reply (the model returns no files) must not abort the
  // whole build -- the retry loop must actually get its second attempt.
  const id3 = `test-repair-resilience-${Date.now()}`;
  await chat(port, id3, 'route:plan enough info');
  builderCalls = 0;
  repairCalls = 0;
  process.env.MOCK_BAD_FIRST = '1'; // fresh build has a syntax error -> needs repair
  process.env.MOCK_EMPTY_REPAIR_FIRST = '1'; // ...and the first repair attempt comes back empty
  evts = await chat(port, id3, 'route:build yes build it');
  assert.equal(repairCalls, 2, 'a malformed repair reply must not consume the whole retry budget in one shot');
  assert.ok(!evts.some((e) => e.type === 'error'), 'the build must still succeed once the second repair attempt works');
  const game4 = evts.find((e) => e.type === 'game');
  assert.ok(game4 && game4.version === 1, 'the game must still get built despite the mid-repair hiccup');
  process.env.MOCK_BAD_FIRST = '0';
  process.env.MOCK_EMPTY_REPAIR_FIRST = '0';
  await cleanupSession(id3);

  // A genuinely new/different game must get its own fresh, isolated session --
  // never reuse or reset the current one in place -- so nothing mixes with the
  // game already built above.
  const beforeSwitchSession = await (await fetch(`http://127.0.0.1:${port}/api/session/${id}`)).json();
  evts = await chat(port, id, 'route:new_game something totally different');
  const sessionEvt = evts.find((e) => e.type === 'session');
  assert.ok(sessionEvt && sessionEvt.id && sessionEvt.id !== id, 'must switch to a brand new session id');
  const newId = sessionEvt.id;

  // The original session must be completely untouched: same message count,
  // same game, still on disk.
  const afterOldSession = await (await fetch(`http://127.0.0.1:${port}/api/session/${id}`)).json();
  assert.deepEqual(afterOldSession, beforeSwitchSession, 'the old session must not be modified by starting a new game');
  assert.ok(await dbFileExists(id, 2, 'frontend/index.html'), 'old game files must still exist');

  // The new session must start clean: only this exchange, no game, no files.
  const newSession = await (await fetch(`http://127.0.0.1:${port}/api/session/${newId}`)).json();
  assert.equal(newSession.messages.length, 2, 'new session should contain only the message that started it');
  assert.equal(newSession.hasGame, false);
  assert.equal(newSession.gameUrl, null);
  assert.ok(!(await dbFileExists(newId, 1, 'frontend/index.html')), 'new session must have no generated files');
  await cleanupSession(newId);

  // Session restore and validation.
  const session = await (await fetch(`http://127.0.0.1:${port}/api/session/${id}`)).json();
  assert.equal(session.hasGame, true);
  assert.equal(session.messages.length, 12);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/session/..%2f..%2fx`)).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/..%2fserver.js`)).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);

  await cleanupSession(id);

  // ---- Provider fallback: MELDCX primary, SCX as automatic backup ----
  // A second mock that always errors, standing in for "MELDCX is down".
  const failMock = http.createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'simulated MELDCX outage' } }));
  });
  await new Promise((r) => failMock.listen(0, '127.0.0.1', r));
  const failUrl = `http://127.0.0.1:${failMock.address().port}`;
  const workingUrl = `http://127.0.0.1:${mock.address().port}`;

  // MELDCX unreachable -> SCX (pointed at the working mock) must answer instead.
  process.env.MELDCX_BASE_URL = failUrl;
  process.env.SCX_API_KEY = 'scx-test-key';
  process.env.SCX_BASE_URL = workingUrl;
  process.env.SCX_MODEL = 'scx-test-model';
  const idFallback = `test-fallback-${Date.now()}`;
  evts = await chat(port, idFallback, 'route:chat hello');
  assert.equal(text(evts), 'Hi there!', 'a real answer must come through via the SCX fallback');
  assert.ok(!evts.some((e) => e.type === 'error'), 'a successful fallback must not surface as an error');
  await cleanupSession(idFallback);

  // MELDCX key missing entirely (not just unreachable) -> same fallback applies.
  delete process.env.MELDCX_API_KEY;
  const idNoKey = `test-nokey-${Date.now()}`;
  evts = await chat(port, idNoKey, 'route:chat hello');
  assert.equal(text(evts), 'Hi there!', 'a missing MELDCX key should also fall back to SCX');
  await cleanupSession(idNoKey);

  // Both providers down -> the existing error path, never a fabricated reply.
  process.env.MELDCX_API_KEY = 'test-key';
  process.env.SCX_BASE_URL = failUrl;
  const idBothDown = `test-bothdown-${Date.now()}`;
  evts = await chat(port, idBothDown, 'route:chat hello');
  assert.ok(evts.some((e) => e.type === 'error'), 'both providers down must surface the existing error handling');
  assert.equal(text(evts), '', 'no fabricated text when both providers fail');
  await cleanupSession(idBothDown);

  delete process.env.SCX_API_KEY;
  delete process.env.SCX_BASE_URL;
  delete process.env.SCX_MODEL;
  process.env.MELDCX_BASE_URL = workingUrl;
  failMock.close();
  await testDb.end();

  console.log('All tests passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
