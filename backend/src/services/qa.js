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
  }

  for (const filePath of paths) {
    if (!/\.js$/i.test(filePath)) continue;
    try {
      new vm.Script(stripModuleSyntax(files[filePath]), { filename: filePath });
    } catch (err) {
      errors.push(`JavaScript syntax error in ${filePath}: ${err.message}`);
      continue;
    }
    const importRe = /import\s*(?:[\w*{}\s,]+from\s*)?["'](\.[^"']+)["']/g;
    let m;
    while ((m = importRe.exec(files[filePath]))) {
      let target = resolveRelative(filePath, m[1]);
      if (!/\.[a-zA-Z0-9]+$/.test(target)) target += '.js';
      if (!files[target]) errors.push(`${filePath} imports "${m[1]}" (resolved to ${target}), which was not generated.`);
    }
  }

  const allText = Object.values(files).join('\n');
  if (!/requestAnimationFrame|setInterval/.test(allText)) warnings.push('No game loop found (requestAnimationFrame / setInterval).');
  if (!/pause/i.test(allText)) warnings.push('No pause functionality found.');
  if (!/restart|play again|try again/i.test(allText)) warnings.push('No restart option found.');
  if (/\beval\s*\(|\bfetch\s*\(|XMLHttpRequest/.test(allText)) warnings.push('Uses eval or network requests, which are blocked or forbidden.');
  if (/\bTODO\b|FIXME/.test(allText)) warnings.push('Contains TODO/FIXME markers.');

  return { errors, warnings };
}

module.exports = { isSafePath, extractTag, extractFiles, serializeFiles, staticCheck };
