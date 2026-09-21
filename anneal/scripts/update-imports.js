#!/usr/bin/env node
"use strict";

// anneal's import fixer: after `git mv`, rewrite the relative specifiers that
// named the old path. It covers `import`, `export ... from`, dynamic `import()`
// and `require()` in the JavaScript and TypeScript family, and re-anchors the
// moved file's own relative imports against its new folder.
//
// It is deliberately narrow, and the skill still searches for the old path and
// the old basename afterwards. Out of scope, because a rewrite here would be a
// guess: path aliases (`@/x`, tsconfig `paths`), bare package specifiers,
// imports in other languages, and every path written in a config file or a doc.
//
//   node update-imports.js --from <old-path> --to <new-path> [--root <dir>]
//
// Paths are relative to --root. Exits non-zero when asked for something it
// cannot do, never when it merely found nothing to change. It runs on a
// migration branch with a clean tree, so `git diff` is the preview.

const fs = require("node:fs");
const path = require("node:path");

const CODE_EXTENSIONS = new Set(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "vue", "svelte"]);

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "target", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".turbo", "__pycache__", ".venv", "venv",
]);

// One specifier per match: the text that opens the string, the specifier, the
// quote that closes it. `from '…'` covers `import x from` and `export … from`;
// the bare `import '…'` branch is the side-effect form, which carries no
// binding for a later search to find and so is the easiest one to miss by hand.
const SPECIFIER = /(from\s*['"]|import\s*\(\s*['"]|import\s+['"]|require\s*\(\s*['"])([^'"\n]+)(['"])/g;

const toPosix = (value) => value.replace(/\\/g, "/");

function stripExtension(file) {
  const ext = path.extname(file);
  return ext ? file.slice(0, -ext.length) : file;
}

function walk(root) {
  const files = [];
  const pending = [""];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) pending.push(rel);
      } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name).slice(1).toLowerCase())) {
        files.push(toPosix(rel));
      }
    }
  }
  return files;
}

// A specifier keeps the shape it had: extension only when it carried one, and
// always "./"-anchored so it stays relative rather than turning into a package.
function specifierFor(fromDir, target, hadExtension) {
  let rel = toPosix(path.relative(fromDir, target));
  if (!hadExtension) rel = stripExtension(rel);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

// Resolve each relative specifier against `resolveFrom`, ask `pick` what it
// should point at now, and write it back relative to `anchorTo`.
function rewrite(text, { resolveFrom, anchorTo, pick }) {
  let changed = 0;
  const next = text.replace(SPECIFIER, (match, open, specifier, close) => {
    if (!specifier.startsWith(".")) return match;
    const target = pick(path.resolve(resolveFrom, specifier));
    if (target === null) return match;
    const replacement = specifierFor(anchorTo, target, path.extname(specifier) !== "");
    if (replacement === specifier) return match;
    changed += 1;
    return `${open}${replacement}${close}`;
  });
  return { text: next, changed };
}

// Every other file: only the specifiers that resolved to the old path move.
const updateReferences = (text, fileDir, oldFull, newFull) =>
  rewrite(text, {
    resolveFrom: fileDir,
    anchorTo: fileDir,
    pick: (resolved) => {
      if (resolved === oldFull) return newFull;
      // An explicit extension identifies a different file. Only extensionless
      // imports may match the moved file without its suffix.
      if (path.extname(resolved) !== "") return null;
      return resolved === stripExtension(oldFull) ? newFull : null;
    },
  });

// The moved file itself: its specifiers were written against the old folder and
// still mean the same targets, so each is re-anchored from the new folder.
const updateSelf = (text, oldDir, newDir) =>
  oldDir === newDir
    ? { text, changed: 0 }
    : rewrite(text, { resolveFrom: oldDir, anchorTo: newDir, pick: (resolved) => resolved });

function updateImports({ root, from, to }) {
  const base = path.resolve(root);
  const oldRel = toPosix(from);
  const newRel = toPosix(to);
  const oldFull = path.resolve(base, oldRel);
  const newFull = path.resolve(base, newRel);
  const oldDir = path.dirname(oldFull);
  const newDir = path.dirname(newFull);

  const updated = [];
  for (const file of walk(base)) {
    const full = path.resolve(base, file);
    let text;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const result = file === newRel
      ? updateSelf(text, oldDir, newDir)
      : updateReferences(text, path.dirname(full), oldFull, newFull);
    if (!result.changed) continue;
    fs.writeFileSync(full, result.text);
    updated.push({ file, changed: result.changed });
  }
  return { updated };
}

function main(argv) {
  const args = argv.slice(2);
  let root = process.cwd();
  let from = null;
  let to = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && args[i + 1]) root = args[++i];
    else if (args[i] === "--from" && args[i + 1]) from = args[++i];
    else if (args[i] === "--to" && args[i + 1]) to = args[++i];
    else {
      process.stderr.write(`update-imports: unexpected argument ${JSON.stringify(args[i])}\n`);
      return 2;
    }
  }
  if (!from || !to) {
    process.stderr.write("usage: update-imports.js --from <old-path> --to <new-path> [--root <dir>]\n");
    return 2;
  }

  const { updated } = updateImports({ root, from, to });
  process.stdout.write(`updated ${updated.length} file${updated.length === 1 ? "" : "s"}\n`);
  for (const { file, changed } of updated) process.stdout.write(`  ${file} (${changed})\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv);

module.exports = { updateImports };
