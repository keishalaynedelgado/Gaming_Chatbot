'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const store = require('./store');
const appIcon = require('./appIcon');
const bundler = require('./bundler');
const qa = require('./qa');
const { buildZip } = require('./zip');
const { GAME_SANDBOX } = require('../config/constants');

// Turns a built game (its frontend/ folder) into an installable app:
//   apk -- an Android app: a tiny WebView wrapper (templates/android), built
//          with the Android SDK's own tools (javac, d8, aapt2, zipalign,
//          apksigner) -- no Gradle, so an export takes seconds.
//   exe -- a Windows app: a WebView2 window (templates/windows) compiled with
//          the C# compiler that ships with Windows, game files embedded, so
//          the result is one self-contained .exe.
//   msi -- a Windows installer for that same .exe (templates/windows/
//          installer.wxs), built with WiX 3: installs per user with Start
//          menu and desktop shortcuts, uninstalled from Settings > Apps.
//   setup -- that MSI inside a small setup .exe (templates/windows/
//          SetupLauncher.cs): the download shows the game's icon, which an
//          .msi file never can; it installs the game and opens it, and once
//          installed, it just opens the game.
//   ios -- the iPhone & iPad app. iOS only installs App Store (or signed)
//          apps, so this is a configuration profile (.mobileconfig) that
//          puts the game on the Home Screen as a full-screen web app: the
//          `web` page below, which is what it actually builds.
//   web -- that page (templates/web), served at /play/:id/: the whole game
//          inlined, with its icons, manifest and offline copy. It also
//          installs straight from Safari (Add to Home Screen / Add to Dock),
//          and it's built on request too.
//   mac -- a Mac app in a .zip: a WebKit window (templates/mac) run by
//          macOS's own JavaScript for Automation, so it needs no Xcode and
//          no compiled code -- built on any machine, with no tools.
// Every app carries the game's own icon (opts.icon, see iconDesigner.js).
// The tools live outside the project (EXPORT_TOOLS_DIR, see .env.example).
// Every finished app is kept per game version (store.exportDir), so asking
// for the same export again is instant.

const TEMPLATES = path.join(__dirname, '..', 'templates');
const MIN_SDK = 24; // Android 7.0

const FORMATS = {
  apk: { stem: 'game', ext: 'apk', label: 'Android app (APK)', mime: 'application/vnd.android.package-archive' },
  exe: { stem: 'game', ext: 'exe', label: 'Windows app (EXE)', mime: 'application/vnd.microsoft.portable-executable' },
  msi: { stem: 'game', ext: 'msi', label: 'Windows installer (MSI)', mime: 'application/x-msi' },
  setup: { stem: 'setup', ext: 'exe', suffix: '-Setup', label: 'Windows installer (Setup)', mime: 'application/vnd.microsoft.portable-executable' },
  ios: { stem: 'play', ext: 'mobileconfig', label: 'iPhone & iPad app', mime: 'application/x-apple-aspen-config' },
  web: { stem: 'play', ext: 'html', label: 'iPhone & iPad app', mime: 'text/html; charset=utf-8' },
  mac: { stem: 'game', ext: 'zip', suffix: '-Mac', label: 'Mac app', mime: 'application/zip' },
};
// The iPhone profile is made per download (it holds the address the
// download came from, see iosProfile); what gets built and kept is its page.
const BUILT_AS = { ios: 'web' };
const NO_TOOLS = new Set(['ios', 'web', 'mac']);

// ------------------------------------------------------------------- Tools
function toolsDir() {
  return process.env.EXPORT_TOOLS_DIR || '';
}

function fromTools(envName, sub) {
  return process.env[envName] || (toolsDir() ? path.join(toolsDir(), sub) : '');
}

// The highest-versioned subfolder ("34.0.0", "android-34") of a directory.
function newestSubdir(dir, re) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => re.test(n));
  } catch {
    return null;
  }
  const key = (n) => (n.match(/\d+/g) || []).map(Number);
  names.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
      if ((ka[i] || 0) !== (kb[i] || 0)) return (ka[i] || 0) - (kb[i] || 0);
    }
    return 0;
  });
  return names.length ? path.join(dir, names[names.length - 1]) : null;
}

function notSetUp(what, missing) {
  const err = new Error(`${what} export is not set up on this server (missing: ${missing.join(', ')}). See EXPORT_TOOLS_DIR in .env.example.`);
  err.status = 503;
  return err;
}

function androidTools() {
  const java = fromTools('EXPORT_JAVA_HOME', 'jdk-17') || process.env.JAVA_HOME || '';
  const sdk = fromTools('ANDROID_HOME', 'android-sdk');
  const buildTools = newestSubdir(path.join(sdk, 'build-tools'), /^\d+\.\d+\.\d+$/);
  const platform = newestSubdir(path.join(sdk, 'platforms'), /^android-\d+$/);
  const t = {
    java: path.join(java, 'bin', 'java.exe'),
    javac: path.join(java, 'bin', 'javac.exe'),
    keytool: path.join(java, 'bin', 'keytool.exe'),
    androidJar: platform ? path.join(platform, 'android.jar') : '',
    targetSdk: platform ? Number(path.basename(platform).split('-')[1]) : 0,
    aapt2: buildTools ? path.join(buildTools, 'aapt2.exe') : '',
    aapt: buildTools ? path.join(buildTools, 'aapt.exe') : '',
    zipalign: buildTools ? path.join(buildTools, 'zipalign.exe') : '',
    d8Jar: buildTools ? path.join(buildTools, 'lib', 'd8.jar') : '',
    apksignerJar: buildTools ? path.join(buildTools, 'lib', 'apksigner.jar') : '',
  };
  const missing = Object.entries(t).filter(([k, p]) => k !== 'targetSdk' && !(p && fs.existsSync(p))).map(([k]) => k);
  if (missing.length) throw notSetUp('Android', missing);
  return t;
}

function windowsTools() {
  const wv = fromTools('EXPORT_WEBVIEW2_DIR', 'webview2');
  const t = {
    csc: path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    core: path.join(wv, 'lib', 'net462', 'Microsoft.Web.WebView2.Core.dll'),
    winforms: path.join(wv, 'lib', 'net462', 'Microsoft.Web.WebView2.WinForms.dll'),
    loaderX64: path.join(wv, 'runtimes', 'win-x64', 'native', 'WebView2Loader.dll'),
    loaderX86: path.join(wv, 'runtimes', 'win-x86', 'native', 'WebView2Loader.dll'),
  };
  const missing = Object.entries(t).filter(([, p]) => !fs.existsSync(p)).map(([k]) => k);
  if (missing.length) throw notSetUp('Windows', missing);
  return t;
}

function wixTools() {
  const wix = fromTools('EXPORT_WIX_DIR', 'wix');
  const t = { candle: path.join(wix, 'candle.exe'), light: path.join(wix, 'light.exe') };
  const missing = Object.entries(t).filter(([, p]) => !fs.existsSync(p)).map(([k]) => k);
  if (missing.length) throw notSetUp('Windows installer', missing);
  return t;
}

// Formats with nothing to install, which can be built whenever they're asked for.
function buildsOnRequest(format) {
  return NO_TOOLS.has(format);
}

// Checked up front, so a missing toolchain fails before any work starts.
function checkTools(format) {
  if (NO_TOOLS.has(format)) return;
  if (format === 'apk') androidTools();
  else windowsTools();
  if (format === 'msi' || format === 'setup') wixTools();
}

function cacheDir() {
  return path.join(toolsDir() || os.tmpdir(), 'askvi-export-cache');
}

function run(cmd, args, { cwd, signal, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, signal, env: env || process.env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (signal?.aborted) return reject(signal.reason ?? err);
        const out = `${stdout || ''}\n${stderr || ''}`.trim().split('\n').slice(-8).join('\n');
        return reject(new Error(`${path.basename(cmd)} failed: ${out || err.message}`));
      }
      resolve(stdout);
    });
  });
}

// ------------------------------------------------------------------- Shared
// The files each format is built from. Their fingerprint is part of the
// cached app's name, so changing a template means the next export is built
// fresh instead of serving an app made from the old one.
const TEMPLATE_FILES = {
  apk: ['android/MainActivity.java'],
  exe: ['windows/GameLauncher.cs', 'windows/app.manifest'],
  msi: ['windows/GameLauncher.cs', 'windows/app.manifest', 'windows/installer.wxs'],
  setup: ['windows/GameLauncher.cs', 'windows/app.manifest', 'windows/installer.wxs', 'windows/SetupLauncher.cs'],
  web: ['web/index.html', 'web/sw.js'],
  mac: ['mac/Info.plist', 'mac/launcher.sh', 'mac/main.js'],
};
const templateTags = {};

function templateTag(format) {
  if (!templateTags[format]) {
    const hash = crypto.createHash('sha256');
    for (const rel of TEMPLATE_FILES[format]) hash.update(fs.readFileSync(path.join(TEMPLATES, ...rel.split('/'))));
    hash.update(fs.readFileSync(path.join(__dirname, 'appIcon.js')));
    if (format === 'web' || format === 'mac') hash.update(fs.readFileSync(__filename)); // their build (inlineGame) lives in this file
    templateTags[format] =hash.digest('hex').slice(0, 8);
  }
  return templateTags[format];
}

// What the app is branded with: the game's icon (its designed one --
// iconDesigner.js keeps it at exports/icon/icon.png -- or the default) and
// its name. Part of the cached app's name too, so an app made before the icon
// was designed, or before the game was renamed, is rebuilt with the new one.
function brandTag(id, state) {
  const hash = crypto.createHash('sha256').update(appTitle(state));
  try {
    hash.update(fs.readFileSync(path.join(path.dirname(store.exportDir(id, 0)), 'icon', 'icon.png')));
  } catch {
    hash.update('default icon');
  }
  return hash.digest('hex').slice(0, 8);
}

function exportFile(id, version, format, state) {
  format = BUILT_AS[format] || format;
  const f = FORMATS[format];
  return path.join(store.exportDir(id, version), `${f.stem}-${templateTag(format)}-${brandTag(id, state)}.${f.ext}`);
}

// The finished app for this version, if it was already exported.
function existing(id, version, format, state) {
  const file = exportFile(id, version, format, state);
  return fs.existsSync(file) ? file : null;
}

// Only frontend/ runs in the app (it's what the live preview serves too); a
// game's backend/ would need a server the app doesn't have.
async function gameFiles(id, state) {
  const all = await store.readProjectFiles(id, state);
  const files = {};
  let hasBackend = false;
  for (const [p, content] of Object.entries(all || {})) {
    if (p.startsWith('frontend/')) files[p.slice('frontend/'.length)] = content;
    else if (p.startsWith('backend/')) hasBackend = true;
  }
  if (files['index.html'] === undefined) throw new Error('This game has no frontend/index.html to package.');
  return { files, hasBackend };
}

async function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
  }
}

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The game's real name (store.displayTitle), used for the app, its window,
// shortcuts and the downloaded file.
function appTitle(state) {
  return store.displayTitle(state).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60) || 'Game';
}

function appId(id) {
  return `g${id.replace(/-/g, '').slice(0, 12)}`;
}

// "Flappy Bird" -> "Flappy-Bird": the downloaded file's name, and the
// installed .exe's.
function fileName(state) {
  return appTitle(state).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
}

function downloadName(state, format) {
  return `${fileName(state)}${FORMATS[format].suffix || ''}.${FORMATS[format].ext}`;
}

// The same GUID every time for the same name, so each game keeps its
// installer identity (upgrade code, components) across versions.
function stableGuid(name) {
  const h = crypto.createHash('sha1').update(`askvi-games:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex').toUpperCase();
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

async function withWorkDir(fn) {
  const base = path.join(cacheDir(), 'work');
  await fsp.mkdir(base, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(base, 'build-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Writes to a temp name first, so a half-built app is never served.
async function publish(built, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.copyFile(built, tmp);
  await fsp.rename(tmp, target);
}

// ------------------------------------------------------------------- Android
function javaEnv(t) {
  const home = path.dirname(path.dirname(t.java));
  return { ...process.env, JAVA_HOME: home, PATH: `${path.join(home, 'bin')}${path.delimiter}${process.env.PATH}` };
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// The wrapper's compiled code is the same for every game: built once (per
// template change) and reused.
async function wrapperDex(t, signal) {
  const source = await fsp.readFile(path.join(TEMPLATES, 'android', 'MainActivity.java'));
  const hash = crypto.createHash('sha256').update(source).update(t.androidJar).digest('hex').slice(0, 16);
  const dex = path.join(cacheDir(), 'android', hash, 'classes.dex');
  if (fs.existsSync(dex)) return dex;
  await withWorkDir(async (work) => {
    const src = path.join(work, 'src', 'com', 'askvi', 'gamewrapper');
    await fsp.mkdir(src, { recursive: true });
    await fsp.writeFile(path.join(src, 'MainActivity.java'), source);
    const classes = path.join(work, 'classes');
    const env = javaEnv(t);
    await run(t.javac, ['-source', '1.8', '-target', '1.8', '-bootclasspath', t.androidJar, '-Xlint:-options', '-d', classes, path.join(src, 'MainActivity.java')], { signal, env });
    const out = path.join(work, 'dex');
    await fsp.mkdir(out);
    await run(t.java, ['-cp', t.d8Jar, 'com.android.tools.r8.D8', '--release', '--min-api', String(MIN_SDK), '--lib', t.androidJar, '--output', out, ...listFiles(classes)], { signal, env });
    await publish(path.join(out, 'classes.dex'), dex);
  });
  return dex;
}

// One signing key for every export, so a newer version of a game installs
// over the old one on the same phone.
async function signingKey(t, signal) {
  const ks = path.join(cacheDir(), 'android', 'askvi-export.keystore');
  if (!fs.existsSync(ks)) {
    await fsp.mkdir(path.dirname(ks), { recursive: true });
    await run(t.keytool, ['-genkeypair', '-noprompt', '-keystore', ks, '-storepass', 'askviexport', '-keypass', 'askviexport', '-alias', 'askvi',
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Ask Vi Games, O=meldCX'], { signal, env: javaEnv(t) });
  }
  return { ks, pass: 'askviexport', alias: 'askvi' };
}

async function buildApk({ id, state, files, icon, signal }) {
  const t = androidTools();
  const [dex, key] = [await wrapperDex(t, signal), await signingKey(t, signal)];
  const target = exportFile(id, state.gameVersion, 'apk', state);
  await withWorkDir(async (work) => {
    await writeTree(path.join(work, 'assets', 'game'), files);
    await writeTree(path.join(work, 'res'), { 'mipmap-xxxhdpi/ic_launcher.png': appIcon.png(192, icon) });
    await fsp.writeFile(path.join(work, 'AndroidManifest.xml'), `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.askvi.games.${appId(id)}">
  <application android:label="${xmlEscape(appTitle(state))}" android:icon="@mipmap/ic_launcher" android:allowBackup="false" android:hardwareAccelerated="true">
    <activity android:name="com.askvi.gamewrapper.MainActivity" android:exported="true"
      android:theme="@android:style/Theme.DeviceDefault.NoActionBar.Fullscreen"
      android:configChanges="orientation|screenSize|screenLayout|smallestScreenSize|keyboard|keyboardHidden|navigation|uiMode">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
    </activity>
  </application>
</manifest>
`);
    await run(t.aapt2, ['compile', '--dir', path.join(work, 'res'), '-o', path.join(work, 'res.zip')], { signal });
    await run(t.aapt2, ['link', '-o', path.join(work, 'unsigned.apk'), '-I', t.androidJar, '--manifest', path.join(work, 'AndroidManifest.xml'),
      '--min-sdk-version', String(MIN_SDK), '--target-sdk-version', String(t.targetSdk),
      '--version-code', String(state.gameVersion), '--version-name', `1.${state.gameVersion}`, path.join(work, 'res.zip')], { signal });
    // The code and game files are added with `aapt add` rather than aapt2's
    // -A, which on Windows stores asset paths with backslashes Android can't
    // open; `aapt add` keeps each entry name exactly as given.
    await fsp.copyFile(dex, path.join(work, 'classes.dex'));
    const entries = ['classes.dex', ...Object.keys(files).map((rel) => `assets/game/${rel}`)];
    await run(t.aapt, ['add', path.join(work, 'unsigned.apk'), ...entries], { cwd: work, signal });
    await run(t.zipalign, ['-f', '4', path.join(work, 'unsigned.apk'), path.join(work, 'aligned.apk')], { signal });
    await run(t.java, ['-jar', t.apksignerJar, 'sign', '--ks', key.ks, '--ks-pass', `pass:${key.pass}`, '--key-pass', `pass:${key.pass}`,
      '--ks-key-alias', key.alias, '--out', path.join(work, 'game.apk'), path.join(work, 'aligned.apk')], { signal, env: javaEnv(t) });
    await publish(path.join(work, 'game.apk'), target);
  });
  return target;
}

async function checkApk(file, signal) {
  const t = androidTools();
  await run(t.java, ['-jar', t.apksignerJar, 'verify', file], { signal, env: javaEnv(t) });
}

// ------------------------------------------------------------------- Windows
function csString(s) {
  return `@"${s.replace(/"/g, '""')}"`;
}

async function buildExe({ id, state, files, icon, signal }) {
  const t = windowsTools();
  const target = exportFile(id, state.gameVersion, 'exe', state);
  await withWorkDir(async (work) => {
    const gameDir = path.join(work, 'game');
    await writeTree(gameDir, files);
    await fsp.writeFile(path.join(work, 'GameInfo.cs'),
      `static class GameInfo\n{\n    public const string AppId = ${csString(appId(id))};\n    public const string Title = ${csString(appTitle(state))};\n    public const int Version = ${Number(state.gameVersion)};\n}\n`);
    await fsp.writeFile(path.join(work, 'app.ico'), appIcon.ico(icon));
    const q = (p) => `"${p}"`;
    const rsp = [
      '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
      `/out:${q(path.join(work, 'game.exe'))}`,
      `/win32icon:${q(path.join(work, 'app.ico'))}`,
      `/win32manifest:${q(path.join(TEMPLATES, 'windows', 'app.manifest'))}`,
      `/reference:${q(t.core)}`, `/reference:${q(t.winforms)}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
      `/resource:${q(t.core)},lib/Microsoft.Web.WebView2.Core.dll`,
      `/resource:${q(t.winforms)},lib/Microsoft.Web.WebView2.WinForms.dll`,
      `/resource:${q(t.loaderX64)},native/x64/WebView2Loader.dll`,
      `/resource:${q(t.loaderX86)},native/x86/WebView2Loader.dll`,
      ...Object.keys(files).map((rel) => `/resource:${q(path.join(gameDir, ...rel.split('/')))},game/${rel}`),
      q(path.join(TEMPLATES, 'windows', 'GameLauncher.cs')),
      q(path.join(work, 'GameInfo.cs')),
    ];
    await fsp.writeFile(path.join(work, 'build.rsp'), rsp.join('\n'));
    await run(t.csc, [`@${path.join(work, 'build.rsp')}`], { cwd: work, signal });
    await publish(path.join(work, 'game.exe'), target);
  });
  return target;
}

async function startsWith(file, magic, what) {
  const fd = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(magic.length);
    await fd.read(head, 0, magic.length, 0);
    if (!head.equals(magic)) throw new Error(`The ${what} was not built correctly.`);
  } finally {
    await fd.close();
  }
}

// The installer wraps the game .exe (built first, or reused).
async function buildMsi(opts) {
  const { id, state, icon, signal } = opts;
  const t = wixTools();
  const exe = await build('exe', opts);
  const target = exportFile(id, state.gameVersion, 'msi', state);
  await withWorkDir(async (work) => {
    await fsp.writeFile(path.join(work, 'app.ico'), appIcon.ico(icon));
    const vars = {
      ...installerVars(id, state),
      AppId: appId(id),
      ExePath: exe,
      IconPath: path.join(work, 'app.ico'),
      Guid1: stableGuid(`${id}:game`),
      Guid2: stableGuid(`${id}:startmenu`),
      Guid3: stableGuid(`${id}:desktop`),
    };
    await wix(t, 'installer.wxs', vars, path.join(work, 'game.msi'), { work, signal });
    await publish(path.join(work, 'game.msi'), target);
  });
  return target;
}

// What the MSI and the setup .exe agree on: names, version, where it installs.
function installerVars(id, state) {
  const title = appTitle(state);
  return {
    Title: title,
    FolderName: title.replace(/[<>:"/\\|?*]/g, '').trim() || 'Game',
    Version: `1.0.${Number(state.gameVersion)}`,
    UpgradeCode: stableGuid(`${id}:upgrade`),
    ExeName: downloadName(state, 'exe'),
  };
}

async function wix(t, template, vars, out, { work, signal }) {
  const obj = path.join(work, `${path.basename(template, '.wxs')}.wixobj`);
  await run(t.candle, ['-nologo', ...Object.entries(vars).map(([k, v]) => `-d${k}=${v}`),
    '-out', obj, path.join(TEMPLATES, 'windows', template)], { cwd: work, signal });
  await run(t.light, ['-nologo', '-spdb', '-out', out, obj], { cwd: work, signal });
}

// The setup .exe (templates/windows/SetupLauncher.cs) carries the MSI (built
// first, or reused): it installs the game, or opens it when it's already
// installed. Compiled with Windows' own C# compiler, like the game .exe.
async function buildSetup(opts) {
  const { id, state, icon, signal } = opts;
  const t = windowsTools();
  const msi = await build('msi', opts);
  const target = exportFile(id, state.gameVersion, 'setup', state);
  await withWorkDir(async (work) => {
    await fsp.writeFile(path.join(work, 'app.ico'), appIcon.ico(icon));
    const v = installerVars(id, state);
    await fsp.writeFile(path.join(work, 'SetupInfo.cs'), 'static class SetupInfo\n{\n'
      + `    public const string AppId = ${csString(appId(id))};\n`
      + `    public const string Title = ${csString(v.Title)};\n`
      + `    public const string Version = ${csString(v.Version)};\n`
      + `    public const string FolderName = ${csString(v.FolderName)};\n`
      + `    public const string ExeName = ${csString(v.ExeName)};\n}\n`);
    const q = (p) => `"${p}"`;
    const rsp = [
      '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
      `/out:${q(path.join(work, 'setup-launcher.exe'))}`,
      `/win32icon:${q(path.join(work, 'app.ico'))}`,
      `/win32manifest:${q(path.join(TEMPLATES, 'windows', 'app.manifest'))}`,
      '/reference:System.Windows.Forms.dll',
      `/resource:${q(msi)},game.msi`,
      q(path.join(TEMPLATES, 'windows', 'SetupLauncher.cs')),
      q(path.join(work, 'SetupInfo.cs')),
    ];
    await fsp.writeFile(path.join(work, 'setup.rsp'), rsp.join('\n'));
    await run(t.csc, [`@${path.join(work, 'setup.rsp')}`], { cwd: work, signal });
    await publish(path.join(work, 'setup-launcher.exe'), target);
  });
  return target;
}

// ------------------------------------------------------- iPhone, iPad & Mac
// The game as ONE HTML document, for the web app's iframe srcdoc and the Mac
// app: its local scripts (a module entry point bundled the way the tunnel
// preview does it, see bundler.js) and stylesheets inlined, so it needs no
// further request and works offline. Anything that can't be inlined still
// loads from `base` (the web app: online, from the live preview /games/:id/;
// the Mac app has no base, the files sit next to the page).
function inlineGame(files, base) {
  const frontend = {};
  for (const [rel, content] of Object.entries(files)) frontend[`frontend/${rel}`] = content;
  const local = (url) => {
    if (!url || /^([a-z][\w+.-]*:|\/|#)/i.test(url)) return null;
    const rel = qa.resolveRelative('frontend/index.html', url.split(/[?#]/)[0]);
    return frontend[rel] === undefined ? null : rel;
  };
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    return m ? m[1] ?? m[2] ?? m[3] : null;
  };

  let html = files['index.html']
    .replace(/<script\b[^>]*>\s*<\/script>/gi, (tag) => {
      const rel = local(attr(tag, 'src'));
      if (!rel) return tag;
      const module = /^module$/i.test(attr(tag, 'type') || '');
      const code = module ? bundler.bundleFrontend(frontend, rel) : frontend[rel];
      if (code === null) return tag;
      return `<script${module ? ' type="module"' : ''}>\n${code.replace(/<\/script/gi, '<\\/script')}\n</script>`;
    })
    .replace(/<link\b[^>]*>/gi, (tag) => {
      const rel = /\bstylesheet\b/i.test(attr(tag, 'rel') || '') && local(attr(tag, 'href'));
      return rel ? `<style>\n${frontend[rel].replace(/<\/style/gi, '<\\/style')}\n</style>` : tag;
    });

  if (!base) return html;
  const baseTag = `<base href="${xmlEscape(base)}">`;
  const at = [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i].map((re) => html.match(re)).find(Boolean);
  html = at ? html.slice(0, at.index + at[0].length) + baseTag + html.slice(at.index + at[0].length) : baseTag + html;
  return html;
}

// A file of the web app, given its page (the built index.html): the page,
// its icons and manifest kept beside it, or the service worker they share.
function webFile(page, name) {
  if (name === 'index.html') return page;
  if (name === 'sw.js') return path.join(TEMPLATES, 'web', 'sw.js');
  return `${page.slice(0, -'.html'.length)}-${name}`;
}

async function buildWeb({ id, state, files, icon }) {
  const target = exportFile(id, state.gameVersion, 'web', state);
  const title = appTitle(state);
  const fill = {
    TITLE: xmlEscape(title),
    SANDBOX: GAME_SANDBOX,
    GAME: xmlEscape(inlineGame(files, `/games/${id}/`)),
  };
  const page = (await fsp.readFile(path.join(TEMPLATES, 'web', 'index.html'), 'utf8'))
    .replace(/\{\{(TITLE|SANDBOX|GAME)\}\}/g, (all, key) => fill[key]);
  const manifest = {
    id: `/play/${id}/`,
    name: title,
    short_name: title,
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'any',
    background_color: '#000000',
    theme_color: '#000000',
    icons: [192, 512].map((n) => ({ src: `icon-${n}.png`, sizes: `${n}x${n}`, type: 'image/png' })),
  };
  const out = {
    'icon-180.png': appIcon.png(180, appIcon.opaque(icon)), // apple-touch-icon
    'icon-192.png': appIcon.png(192, icon),
    'icon-512.png': appIcon.png(512, icon),
    'manifest.webmanifest': JSON.stringify(manifest, null, 2),
    'index.html': page, // last: once the page exists, so does everything it links
  };
  await withWorkDir(async (work) => {
    for (const [name, data] of Object.entries(out)) {
      await fsp.writeFile(path.join(work, name), data);
      await publish(path.join(work, name), webFile(target, name));
    }
  });
  return target;
}

// The iPhone & iPad app: a configuration profile with one Web Clip, which
// puts the game's web app (above) on the Home Screen, full screen, with the
// game's icon. Made per download, because it must hold an address the
// iPhone can reach -- the one this download came from (`origin`). Installing
// a newer one replaces the old (same identifier); removing it removes the
// icon too.
function iosProfile({ id, state, origin, page }) {
  const icon = fs.readFileSync(webFile(page, 'icon-180.png')).toString('base64').replace(/.{1,76}/g, '$&\n');
  const ident = `com.askvi.games.${appId(id)}`;
  const s = (v) => `<string>${xmlEscape(String(v))}</string>`;
  const title = appTitle(state);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>${s('com.apple.webClip.managed')}
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key>${s(`${ident}.webclip`)}
      <key>PayloadUUID</key>${s(stableGuid(`${id}:webclip`))}
      <key>PayloadDisplayName</key>${s(title)}
      <key>Label</key>${s(title)}
      <key>URL</key>${s(`${origin}/play/${id}/`)}
      <key>Icon</key>
      <data>
${icon}      </data>
      <key>FullScreen</key><true/>
      <key>Precomposed</key><true/>
      <key>IsRemovable</key><true/>
    </dict>
  </array>
  <key>PayloadType</key>${s('Configuration')}
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadIdentifier</key>${s(ident)}
  <key>PayloadUUID</key>${s(stableGuid(`${id}:profile`))}
  <key>PayloadDisplayName</key>${s(title)}
  <key>PayloadDescription</key>${s(`Adds ${title} to the Home Screen.`)}
  <key>PayloadOrganization</key>${s('Ask Vi Games')}
  <key>PayloadRemovalDisallowed</key><false/>
</dict>
</plist>
`;
}

// The Mac app, zipped (Safari unzips it on download): "<Title>.app" with the
// launcher, templates/mac/main.js, the game (inlined, plus its files) and the
// game's icon. The launcher is marked executable in the zip itself.
async function buildMac({ id, state, files, icon }) {
  const target = exportFile(id, state.gameVersion, 'mac', state);
  const v = installerVars(id, state);
  const text = async (name) => (await fsp.readFile(path.join(TEMPLATES, 'mac', name), 'utf8')).replace(/\r\n/g, '\n');
  const fill = { APP_ID: appId(id), TITLE: xmlEscape(v.Title), VERSION: v.Version };
  const app = `${v.FolderName.replace(/[\\/:]/g, '')}.app/Contents`;
  const entries = [
    { path: `${app}/Info.plist`, content: (await text('Info.plist')).replace(/\{\{(APP_ID|TITLE|VERSION)\}\}/g, (all, key) => fill[key]) },
    { path: `${app}/PkgInfo`, content: 'APPL????' },
    { path: `${app}/MacOS/game`, content: await text('launcher.sh'), mode: 0o100755 },
    { path: `${app}/Resources/main.js`, content: await text('main.js') },
    { path: `${app}/Resources/AppIcon.icns`, content: appIcon.icns(appIcon.padded(icon)) },
    ...Object.entries({ ...files, 'index.html': inlineGame(files) }).map(([rel, content]) => ({ path: `${app}/Resources/game/${rel}`, content })),
  ].map((e) => ({ mode: 0o100644, ...e }));
  await withWorkDir(async (work) => {
    await fsp.writeFile(path.join(work, 'game.zip'), buildZip(entries));
    await publish(path.join(work, 'game.zip'), target);
  });
  return target;
}

// ------------------------------------------------------------------- API
const BUILDERS = { apk: buildApk, exe: buildExe, msi: buildMsi, setup: buildSetup, web: buildWeb, mac: buildMac };
const inflight = new Map(); // target file -> its running build, so the EXE/MSI a setup needs is built once

function build(format, opts) {
  const target = exportFile(opts.id, opts.state.gameVersion, format, opts.state);
  if (fs.existsSync(target)) return Promise.resolve(target);
  if (!inflight.has(target)) inflight.set(target, BUILDERS[BUILT_AS[format] || format](opts).finally(() => inflight.delete(target)));
  return inflight.get(target);
}

async function check(format, file, signal) {
  if (format === 'apk') return checkApk(file, signal);
  if (format === 'web' || format === 'ios') return startsWith(file, Buffer.from('<!doctype html>'), 'iPhone & iPad app');
  if (format === 'mac') return startsWith(file, Buffer.from('504b0304', 'hex'), FORMATS[format].label);
  if (format === 'exe' || format === 'setup') return startsWith(file, Buffer.from('MZ'), 'Windows app');
  return startsWith(file, Buffer.from('d0cf11e0a1b11ae1', 'hex'), 'Windows installer'); // MSI = OLE compound file
}

module.exports = { FORMATS, buildsOnRequest, checkTools,gameFiles, existing, exportFile, fileName, downloadName, build, check, webFile, inlineGame, iosProfile };
