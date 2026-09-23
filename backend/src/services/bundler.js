'use strict';
const qa = require('./qa');

// Turns a frontend/ file tree that uses native ES modules into ONE inlined,
// dependency-free script with no further per-file network requests.
//
// Why this exists: the live preview is served with an opaque origin (CSP
// `sandbox`, no `allow-same-origin` -- see config/constants.js) so untrusted
// generated code can never read this app's cookies or reach its API. That's
// correct and stays untouched. But it has a side effect: when the whole app
// is reached through a tunnel whose free tier shows a one-time "you're about
// to visit..." interstitial (ngrok's free *.ngrok-free.dev/.app domains, the
// ERR_NGROK_6024 page), the top-level tab navigation carries the cookie that
// skips it, while a `<script type="module" src="...">` fetch issued *from*
// the opaque-origin document cannot -- SameSite cookies are matched against
// the requesting document's site, and an opaque origin has none. So the very
// first per-file module request looks "fresh" to the tunnel and gets the
// interstitial page back instead of the real file: no Access-Control-Allow-
// Origin header on that page (it's the tunnel's page, not ours), hence the
// browser's CORS error, even though this server's own headers are correct.
//
// Rather than loosening the sandbox's `connect-src 'none'` (which exists
// specifically so generated code can never call back into this app's API --
// see GAME_CSP) to let the page fetch its own files with a bypass header,
// this avoids the problem completely: bundle every local module into ONE
// inline <script type="module"> with no `src`, so loading a game through
// such a tunnel needs exactly one HTTP request (the page navigation itself,
// which already works) and nothing else. Only used for hosts detected as
// this kind of tunnel; every other host keeps being served the original,
// unmodified multi-file project exactly as generated.
//
// This only has to understand the subset of ES module syntax this app's own
// Builder is instructed to write (relative imports/exports, one default
// export, CDN imports for external libraries) -- not arbitrary JavaScript.
// Anything it doesn't recognise (re-exports, a missing dependency, a bare
// module specifier) makes it bail out with `null`, and the caller falls back
// to serving the original files unmodified rather than risk shipping a
// silently-broken bundle.

// Anchored to the start of a line (imports are always their own statement
// there) but NOT to the end of it -- unlike the export regexes below, an
// import can legitimately share its line with further code after the
// semicolon, and requiring end-of-line here previously let such a line pass
// through completely untransformed (a real bug, caught by this file's tests:
// see test coverage for a same-line missing-dependency case).
const IMPORT_WITH_CLAUSE_RE = /^[ \t]*import\s+([^'";]+?)\s+from\s*['"]([^'"]+)['"]\s*;?/gm;
const IMPORT_BARE_RE = /^[ \t]*import\s*['"]([^'"]+)['"]\s*;?/gm;
const EXPORT_DEFAULT_DECL_RE = /^export\s+default\s+(async\s+function\*?|function\*?|class)\b/m;
const EXPORT_DEFAULT_EXPR_RE = /^export\s+default\s+/m;
const EXPORT_REEXPORT_RE = /^export\s*(\*|\{[^}]*\})\s*from\s*['"]/m;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}\s*;?[ \t]*$/gm;
const EXPORT_DECL_FUNC_RE = /^export\s+(async\s+function\*?|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_DECL_VAR_RE = /^export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

function parseImportClause(clause) {
  const out = { defaultName: null, namespaceName: null, named: [] };
  let rest = clause.trim();
  if (!rest.startsWith('{') && !rest.startsWith('*')) {
    const m = rest.match(/^([A-Za-z_$][\w$]*)\s*(,\s*)?/);
    if (m) {
      out.defaultName = m[1];
      rest = rest.slice(m[0].length).trim();
    }
  }
  const nsMatch = rest.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (nsMatch) {
    out.namespaceName = nsMatch[1];
    rest = rest.slice(nsMatch[0].length).trim();
  }
  const namedMatch = rest.match(/\{([^}]*)\}/);
  if (namedMatch) {
    for (const part of namedMatch[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const asMatch = piece.match(/^(\S+)\s+as\s+([A-Za-z_$][\w$]*)$/);
      out.named.push(asMatch ? { imported: asMatch[1], local: asMatch[2] } : { imported: piece, local: piece });
    }
  }
  return out;
}

function codegenImport(clause, key, tmp) {
  const parsed = parseImportClause(clause);
  const lines = [];
  const needsTmp = Boolean(parsed.defaultName) || parsed.named.length > 0;
  if (needsTmp) lines.push(`const ${tmp} = __require(${JSON.stringify(key)});`);
  if (parsed.namespaceName) lines.push(`const ${parsed.namespaceName} = __require(${JSON.stringify(key)});`);
  if (parsed.defaultName) lines.push(`const ${parsed.defaultName} = ${tmp}.default;`);
  if (parsed.named.length) {
    const destructure = parsed.named.map(({ imported, local }) => (imported === local ? imported : `${imported}: ${local}`)).join(', ');
    lines.push(`const { ${destructure} } = ${tmp};`);
  }
  if (!needsTmp && !parsed.namespaceName) lines.push(`__require(${JSON.stringify(key)});`);
  return lines.join('\n');
}

// Transforms one file's source. Returns null if it contains anything this
// simplified bundler doesn't support. Otherwise returns the rewritten body,
// the list of `exports.x = x` lines it needs, and the local files it depends
// on (so the caller can recurse into them).
function transformFile(relPath, src, resolveSpec) {
  if (EXPORT_REEXPORT_RE.test(src)) return null;

  let out = src;
  let defaultIsDecl = false;
  const exportsAssignments = [];
  const localDeps = [];
  let bail = false;

  out = out.replace(EXPORT_DEFAULT_DECL_RE, (m, kw) => {
    defaultIsDecl = true;
    return `const __default = ${kw}`;
  });
  out = out.replace(EXPORT_DEFAULT_EXPR_RE, () => 'exports.default = ');

  out = out.replace(EXPORT_LIST_RE, (m, inner) => {
    for (const part of inner.split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const asMatch = piece.match(/^(\S+)\s+as\s+(\S+)$/);
      if (asMatch) exportsAssignments.push(`exports.${asMatch[2]} = ${asMatch[1]};`);
      else exportsAssignments.push(`exports.${piece} = ${piece};`);
    }
    return '';
  });

  out = out.replace(EXPORT_DECL_FUNC_RE, (m, kw, name) => {
    exportsAssignments.push(`exports.${name} = ${name};`);
    return `${kw} ${name}`;
  });
  out = out.replace(EXPORT_DECL_VAR_RE, (m, kw, name) => {
    exportsAssignments.push(`exports.${name} = ${name};`);
    return `${kw} ${name}`;
  });

  let tmpCounter = 0;
  out = out.replace(IMPORT_WITH_CLAUSE_RE, (m, clause, spec) => {
    const resolved = resolveSpec(spec, relPath);
    if (!resolved) {
      bail = true;
      return m;
    }
    if (!resolved.external) localDeps.push(resolved.key);
    return codegenImport(clause, resolved.key, `__m${tmpCounter++}`);
  });
  out = out.replace(IMPORT_BARE_RE, (m, spec) => {
    const resolved = resolveSpec(spec, relPath);
    if (!resolved) {
      bail = true;
      return m;
    }
    if (resolved.external) return ''; // hoisted as a real top-level import; its own side effects already run
    localDeps.push(resolved.key);
    return `__require(${JSON.stringify(resolved.key)});`;
  });

  if (bail) return null;
  if (defaultIsDecl) exportsAssignments.push('exports.default = __default;');

  return { body: out, exportsAssignments, localDeps };
}

// files: flat {relPath: content} map for the frontend/ tree (keys like
// "frontend/src/main.js", matching qa.js's path conventions). entryRelPath:
// e.g. "frontend/src/main.js". Returns the bundled script source, or null if
// anything in the project isn't something this bundler understands.
function bundleFrontend(files, entryRelPath) {
  if (!files[entryRelPath]) return null;

  const externalSpecs = new Map(); // spec -> hoisted import var name
  const defineBlocks = [];
  const visited = new Set();
  let bail = false;

  function resolveSpec(spec, fromPath) {
    if (/^https?:\/\//i.test(spec)) {
      if (!externalSpecs.has(spec)) externalSpecs.set(spec, `__ext${externalSpecs.size}`);
      return { key: spec, external: true };
    }
    if (spec.startsWith('.')) {
      let target = qa.resolveRelative(fromPath, spec);
      if (!/\.[a-zA-Z0-9]+$/.test(target)) target += '.js';
      if (!files[target]) return null;
      return { key: target, external: false };
    }
    return null; // bare specifier -- unsupported (staticCheck should already reject these)
  }

  function visit(relPath) {
    if (visited.has(relPath) || bail) return;
    visited.add(relPath);
    const src = files[relPath];
    if (src === undefined) {
      bail = true;
      return;
    }
    const result = transformFile(relPath, src, resolveSpec);
    if (!result) {
      bail = true;
      return;
    }
    const indented = result.body.split('\n').concat(result.exportsAssignments).join('\n  ');
    defineBlocks.push(`  __define(${JSON.stringify(relPath)}, function (module, exports) {\n  ${indented}\n  });`);
    for (const dep of result.localDeps) visit(dep);
  }

  visit(entryRelPath);
  if (bail) return null;

  const lines = [];
  for (const [spec, varName] of externalSpecs) lines.push(`import * as ${varName} from ${JSON.stringify(spec)};`);
  lines.push('(function () {');
  lines.push('  const __modules = {};');
  lines.push('  const __cache = {};');
  lines.push('  function __define(id, factory) { __modules[id] = factory; }');
  lines.push('  function __require(id) {');
  lines.push('    if (Object.prototype.hasOwnProperty.call(__cache, id)) return __cache[id];');
  lines.push('    const factory = __modules[id];');
  lines.push("    if (!factory) throw new Error('Module not found: ' + id);");
  lines.push('    const module = { exports: {} };');
  lines.push('    __cache[id] = module.exports;');
  lines.push('    factory(module, module.exports);');
  lines.push('    __cache[id] = module.exports;');
  lines.push('    return module.exports;');
  lines.push('  }');
  for (const [spec, varName] of externalSpecs) lines.push(`  __cache[${JSON.stringify(spec)}] = ${varName};`);
  lines.push(...defineBlocks);
  lines.push(`  __require(${JSON.stringify(entryRelPath)});`);
  lines.push('})();');
  return lines.join('\n');
}

// True for hosts whose free tier shows an interstitial that breaks opaque-
// origin subresource requests the way described above -- currently just
// ngrok's free `*.ngrok-free.app` / `*.ngrok-free.dev` / legacy `*.ngrok.io`
// domains. Checked against the request's Host header.
function needsBundling(host) {
  return /ngrok/i.test(host || '');
}

module.exports = { bundleFrontend, needsBundling };
