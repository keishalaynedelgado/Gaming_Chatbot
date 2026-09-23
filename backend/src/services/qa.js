'use strict';
const vm = require('node:vm');

const ALLOWED_ROOTS = ['frontend/', 'backend/', 'shared/', 'docs/'];
const ALLOWED_ROOT_FILES = ['.gitignore', 'README.md'];

// A path is only ever trusted once it passes this: no traversal, no absolute/
// drive paths, and it must live under one of the project's top-level folders
// (or be one of the few allowed root files). Used both when parsing model
// output and again, independently, right before anything touches disk.
function isSafePath(p) {
  if (!p || typeof p !== 'string' || p.includes('\0')) return false;
  if (/^[\\/]|^[A-Za-z]:/.test(p)) return false;
  const parts = p.split('/');
  if (parts.some((seg) => seg === '..' || seg === '' || seg === '.')) return false;
  if (ALLOWED_ROOT_FILES.includes(p)) return true;
  return ALLOWED_ROOTS.some((root) => p.startsWith(root)) && parts.length > 1;
}

// Pulls <tag>...</tag>; tolerates a missing closing tag at the end of the text.
function extractTag(text, tag) {
  const m = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*(?:</${tag}>|$)`));
  return m ? m[1].trim() : '';
}

function stripFence(content) {
  return content.replace(/^\s*```[a-zA-Z0-9]*\n/, '').replace(/\n```\s*$/, '');
}

// Parses the Builder/QA "<files><file path="...">...</file>...</files>" block
// into an ordered {path: content} map. Any file whose path doesn't pass
// isSafePath is dropped (reported in `skipped`) rather than trusted.
function extractFiles(text) {
  const files = {};
  const skipped = [];
  const block = text.match(/<files>([\s\S]*?)(?:<\/files>\s*$|<\/files>|$)/);
  if (!block) return { files, skipped, complete: false, lastPath: undefined };
  // If the response was cut off mid-generation (hit the token limit), the model
  // never got to emit the closing </files> tag -- that's a reliable signal, much
  // simpler than trying to tell from each individual <file> block whether it was
  // properly closed.
  const complete = text.includes('</files>');
  const re = /<file\s+path="([^"]*)"\s*>\n?([\s\S]*?)(?:\n?<\/file>|(?=<file\s+path=")|$)/g;
  let m;
  let lastPath;
  while ((m = re.exec(block[1]))) {
    const filePath = m[1].trim().replace(/^\.\//, '');
    const content = stripFence(m[2]).replace(/\n$/, '');
    if (!isSafePath(filePath)) {
      skipped.push(filePath);
      continue;
    }
    files[filePath] = content;
    lastPath = filePath;
  }
  return { files, skipped, complete, lastPath };
}

// Renders a file map back into the same <file path="...">...</file> text, so it
// can be handed to the Builder/QA agent as "here is the current project".
function serializeFiles(files) {
  return Object.entries(files)
    .map(([filePath, content]) => `<file path="${filePath}">\n${content}\n</file>`)
    .join('\n\n');
}

// vm.Script parses as a classic script, which doesn't understand ES module
// syntax -- so for the syntax check only (never for what's actually served),
// strip import/export so the rest of the file can still be checked.
function stripModuleSyntax(src) {
  return src
    .replace(/^\s*import\s[\s\S]*?;/gm, '')
    .replace(/^(\s*)export\s+default\s+/gm, '$1')
    .replace(/^(\s*)export\s+(?=(?:function|class|const|let|var)\b)/gm, '$1')
    .replace(/^\s*export\s*\{[\s\S]*?\}\s*;?/gm, '');
}

// Resolves a relative import/src specifier against the file that referenced it.
function resolveRelative(fromPath, spec) {
  const dir = fromPath.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') dir.pop();
    else dir.push(seg);
  }
  return dir.join('/');
}

// Names an import clause (the part between "import" and "from") binds, e.g.
// "Foo" / "{ a, b as c }" / "* as ns" / "Foo, { a }" / "Foo, * as ns".
function namesFromImportClause(clause) {
  const names = [];
  const nsMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (nsMatch) names.push(nsMatch[1]);
  const namedMatch = clause.match(/\{([^}]*)\}/);
  if (namedMatch) {
    for (const part of namedMatch[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const asMatch = piece.match(/^\S+\s+as\s+([A-Za-z_$][\w$]*)$/);
      names.push(asMatch ? asMatch[1] : piece.split(/\s+/)[0]);
    }
  }
  const defaultMatch = clause.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
  if (defaultMatch) names.push(defaultMatch[1]);
  return names;
}

// Every name a file imports, across all its import statements.
function importedNames(src) {
  const names = new Set();
  const re = /^import\s+([^'"]+?)\s+from\s+['"][^'"]+['"]/gm;
  let m;
  while ((m = re.exec(src))) {
    for (const n of namesFromImportClause(m[1])) names.add(n);
  }
  return names;
}

// Every name a file declares at its top level (function/class/const/let/var),
// approximated by matching declarations that start at column 0 -- close
// enough to "module scope" for generated, normally-indented code, without a
// real parser.
function topLevelDeclaredNames(src) {
  const names = new Set();
  const re = /^(?:export\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src))) {
    names.add(m[1] || m[2] || m[3]);
  }
  return names;
}

// Deterministic checks over the whole project.
// errors   -> the project cannot work, must go back to the Builder for repair
// warnings -> passed along as hints for the QA agent (may be false alarms)
function staticCheck(files) {
  const errors = [];
  const warnings = [];
  const paths = Object.keys(files);

  if (paths.length === 0) {
    errors.push('No files were generated.');
    return { errors, warnings };
  }

  const entry = 'frontend/index.html';
  if (!files[entry]) {
    errors.push(`Missing ${entry} (the file that gets played).`);
  } else {
    if (!/<!doctype html/i.test(files[entry])) errors.push(`${entry} is missing <!DOCTYPE html>.`);
    if (!/<script[\s>]/i.test(files[entry])) errors.push(`${entry} does not load any JavaScript.`);
    if (!/<meta[^>]+name=["']viewport["']/i.test(files[entry])) warnings.push(`${entry} has no viewport meta tag.`);

    // Every local <script src>/<link href> the entry file references must
    // actually exist -- a broken path here means the game never loads at all.
    const refRe = /<(?:script[^>]*\ssrc|link[^>]*\shref)=["']([^"']+)["']/gi;
    let rm;
    while ((rm = refRe.exec(files[entry]))) {
      const ref = rm[1];
      if (/^https?:\/\/|^data:/i.test(ref)) continue; // external/CDN, not ours to verify
      const target = resolveRelative(entry, ref);
      if (!files[target]) errors.push(`${entry} references "${ref}" (resolved to ${target}), which was not generated.`);
    }
  }

  for (const filePath of paths) {
    if (!/\.js$/i.test(filePath)) continue;
    try {
      new vm.Script(stripModuleSyntax(files[filePath]), { filename: filePath });
    } catch (err) {
      errors.push(`JavaScript syntax error in ${filePath}: ${err.message}`);
      continue;
    }

    // A name that's both imported and re-declared at the top level is a real
    // SyntaxError in a browser -- but invisible to the syntax check above,
    // since stripping import lines to make module syntax parseable also
    // erases the very conflict this catches. Check the ORIGINAL source.
    const declared = topLevelDeclaredNames(files[filePath]);
    for (const name of importedNames(files[filePath])) {
      if (declared.has(name)) {
        errors.push(`${filePath} both imports and locally declares "${name}" -- this is a real SyntaxError ("Identifier '${name}' has already been declared") that breaks the whole file. Remove the duplicate.`);
      }
    }

    // Every import -- relative or not -- is checked. A bare specifier (e.g.
    // "phaser", "lodash") can't be resolved by a browser without a bundler or
    // import map, so it's just as fatal as a broken relative path.
    const importRe = /import\s*(?:[\w*{}\s,]+from\s*)?["']([^"']+)["']/g;
    let m;
    while ((m = importRe.exec(files[filePath]))) {
      const spec = m[1];
      if (spec.startsWith('.')) {
        let target = resolveRelative(filePath, spec);
        if (!/\.[a-zA-Z0-9]+$/.test(target)) target += '.js';
        if (!files[target]) errors.push(`${filePath} imports "${spec}" (resolved to ${target}), which was not generated.`);
      } else if (!/^https?:\/\//i.test(spec)) {
        errors.push(`${filePath} imports "${spec}", a bare module specifier -- browsers can't resolve this without a bundler or import map. Use a relative path (e.g. "./game/x.js") or a full CDN URL instead.`);
      }
    }
  }

  const allText = Object.values(files).join('\n');
  if (!/requestAnimationFrame|setInterval/.test(allText)) warnings.push('No game loop found (requestAnimationFrame / setInterval).');
  if (!/pause/i.test(allText)) warnings.push('No pause functionality found.');
  if (!/restart|play again|try again/i.test(allText)) warnings.push('No restart option found.');
  if (/\beval\s*\(|\bfetch\s*\(|XMLHttpRequest/.test(allText)) warnings.push('Uses eval or network requests, which are blocked or forbidden.');
  if (/\bTODO\b|FIXME|\bnot implemented\b|\bcoming soon\b/i.test(allText)) warnings.push('Contains TODO/FIXME or other unfinished-work markers.');

  return { errors, warnings };
}

module.exports = { isSafePath, extractTag, extractFiles, serializeFiles, staticCheck, resolveRelative, namesFromImportClause };
