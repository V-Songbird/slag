#!/usr/bin/env node
// jig:owned — generated from jig's check-driver template. Edit this file and
// jig reports it as drifted rather than overwriting your edit.
//
// Nothing here knows what jig is. No imports outside node's own standard
// library, no config to find, no plugin to install: any teammate, any CI, any
// machine with node can run this file. That is the whole point of it — it is
// the floor that keeps working after the agent host is gone.
//
//   node .jig/checks/run.mjs                 walk the project and check it
//   node .jig/checks/run.mjs <path> [...]    check exactly these paths
//   node .jig/checks/run.mjs --selftest      seed one violation per check and
//                                            prove each check catches its own
//   node .jig/checks/run.mjs --json          machine-readable report
//
// Exit code is 1 when anything was found and 0 when nothing was. A selftest
// exits 1 when a check failed to catch its own seeded violation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The project root is two levels up from `.jig/checks/`. Resolved from this
// file rather than from the working directory, so the driver behaves the same
// whether it is run from the repository root or from a git hook.
const ROOT = path.resolve(HERE, "..", "..");

// Directories a source check has no business walking into. Deliberately a
// short fixed list rather than a .gitignore parser: reading ignore rules
// properly means a dependency, and a check that silently skipped a tracked
// file would be worse than one that reads a few extra.
const SKIP_DIRS = new Set([
  ".git", ".jig", "node_modules", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".venv", "venv", "vendor", "target",
]);

// A ceiling, so a check driver pointed at a monorepo by accident stops instead
// of reading for ten minutes.
const MAX_FILES = 20000;

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

// Enough glob for the catalogue's own path patterns: `**` crosses directory
// separators, `*` does not, `?` is one character. Anything else is a literal.
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + out + "$", "i");
}

function matchesAny(rel, globs) {
  return globs.some((g) => globToRegExp(g).test(rel));
}

// ---------------------------------------------------------------------------
// Comment and string blanking
// ---------------------------------------------------------------------------
//
// Every blanked region keeps its length and its newlines, so a match's line
// number is still the line number in the file the user will open. This is the
// single place false positives are most likely to live, which is why the
// catalogue's near-miss fixtures aim straight at it.

const HASH_COMMENT_EXT = new Set([".sh", ".bash", ".zsh", ".yml", ".yaml", ".toml"]);

function commentStyle(rel) {
  const base = path.basename(rel);
  if (base === "Dockerfile" || base.startsWith("Dockerfile.")) return "hash";
  return HASH_COMMENT_EXT.has(path.extname(rel).toLowerCase()) ? "hash" : "slash";
}

// A `/` opens a regular expression only where a value may start. After a name,
// a number, or a closing bracket it is division. The known miss is `if (x)
// /re/.test(s)`, where the regex body stays visible to the patterns — a rare
// shape, and one that can only ever add a finding, never hide one.
function regexCanStart(prev) {
  return prev === "" || !/[)\]}\w$]/.test(prev);
}

function blankRegions(text, rel, opts) {
  const style = commentStyle(rel);
  const strings = opts && opts.strings;
  const out = text.split("");
  const erase = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const toLineEnd = (from) => {
    let j = from;
    while (j < text.length && text[j] !== "\n") j++;
    return j;
  };

  let prev = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (style === "hash" && c === "#") {
      const end = toLineEnd(i);
      erase(i, end);
      i = end;
      continue;
    }
    if (style === "slash" && c === "/" && text[i + 1] === "/") {
      const end = toLineEnd(i);
      erase(i, end);
      i = end;
      continue;
    }
    if (style === "slash" && c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      erase(i, end);
      i = end;
      continue;
    }
    if (style === "slash" && c === "/" && regexCanStart(prev)) {
      let j = i + 1;
      let charClass = false;
      while (j < text.length) {
        const d = text[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") break;
        if (d === "[") charClass = true;
        else if (d === "]") charClass = false;
        else if (d === "/" && !charClass) { j++; break; }
        j++;
      }
      erase(i + 1, Math.max(i + 1, j - 1));
      prev = "/";
      i = j;
      continue;
    }
    if (strings && (c === '"' || c === "'" || c === "`")) {
      let j = i + 1;
      while (j < text.length) {
        const d = text[j];
        if (d === "\\") { j += 2; continue; }
        if (d === c) { j++; break; }
        // A single- or double-quoted literal cannot span a line in valid
        // source; treating a stray newline as the end keeps one unbalanced
        // quote from blanking the rest of the file.
        if (d === "\n" && c !== "`") break;
        j++;
      }
      erase(i + 1, Math.max(i + 1, j - 1));
      prev = c;
      i = j;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// The context every check module is handed
// ---------------------------------------------------------------------------

function walk(root, only) {
  if (only && only.length) {
    return only
      .map((p) => path.relative(root, path.resolve(root, p)).split(path.sep).join("/"))
      .filter((rel) => rel && !rel.startsWith("..") && fs.existsSync(path.join(root, rel)));
  }
  const found = [];
  const stack = ["."];
  while (stack.length && found.length < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir === "." ? entry.name : dir + "/" + entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(rel);
      } else if (entry.isFile()) {
        found.push(rel);
      }
    }
  }
  return found;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

function makeContext(root, only) {
  const all = walk(root, only);
  const cache = new Map();
  return {
    root,
    files(globs) {
      return all.filter((rel) => matchesAny(rel, globs));
    },
    read(rel) {
      if (!cache.has(rel)) {
        try {
          cache.set(rel, fs.readFileSync(path.join(root, rel), "utf-8").replace(/^﻿/, ""));
        } catch {
          cache.set(rel, null);
        }
      }
      return cache.get(rel);
    },
    clean(rel, text, opts) {
      return blankRegions(text, rel, opts || {});
    },
    lineOf,
    // The pattern-over-source loop, written once. Every source check is the
    // same handful of decisions — which files, which patterns, whether string
    // literals count, whether a match may span lines — so each check module
    // states those and nothing else.
    //
    // `perLine` matters more than it looks. A pattern like `curl [^|]* | sh`
    // has a negated character class in it, and a negated class happily crosses
    // a newline: run it over a whole file and a curl on line 3 pairs up with an
    // unrelated pipe on line 40. Anything describing one shell command asks for
    // one line at a time.
    scan(classId, globs, patterns, opts) {
      const options = opts || {};
      const out = [];
      for (const rel of this.files(globs)) {
        const text = this.read(rel);
        if (text === null) continue;
        const source = blankRegions(text, rel, options);
        if (options.perLine) {
          source.split("\n").forEach((line, i) => {
            for (const p of patterns) if (new RegExp(p).test(line)) out.push(this.finding(classId, rel, i + 1, p));
          });
          continue;
        }
        for (const p of patterns) {
          for (const m of source.matchAll(new RegExp(p, "g"))) {
            out.push(this.finding(classId, rel, lineOf(text, m.index), p));
          }
        }
      }
      return out;
    },
    // Findings name a file and a line and the pattern that fired. The text
    // that matched is deliberately never carried out of here — a report is a
    // record of which check spoke, not a copy of somebody's source.
    finding(classId, rel, line, pattern, note) {
      return { classId, path: rel, line, pattern, note: note || null };
    },
    git(args) {
      const run = spawnSync("git", args, { cwd: root, encoding: "utf-8", windowsHide: true });
      if (run.error || run.status !== 0) return { ok: false, stdout: "" };
      return { ok: true, stdout: run.stdout };
    },
  };
}

// ---------------------------------------------------------------------------
// Loading the checks
// ---------------------------------------------------------------------------

async function loadChecks() {
  let names;
  try {
    names = fs.readdirSync(HERE).filter((f) => f.endsWith(".check.mjs")).sort();
  } catch {
    names = [];
  }
  const checks = [];
  for (const name of names) {
    try {
      const mod = await import(pathToFileURL(path.join(HERE, name)).href);
      if (typeof mod.check === "function" && typeof mod.id === "string") checks.push(mod);
    } catch (err) {
      // A check that will not load is reported and skipped. One broken module
      // must not take the other three down with it.
      checks.push({ id: name, broken: err.message });
    }
  }
  return checks;
}

// ---------------------------------------------------------------------------
// The two runs
// ---------------------------------------------------------------------------

async function runChecks(root, only) {
  const ctx = makeContext(root, only);
  const findings = [];
  const skipped = [];
  const broken = [];
  for (const mod of await loadChecks()) {
    if (mod.broken) { broken.push({ id: mod.id, why: mod.broken }); continue; }
    try {
      const result = (await mod.check(ctx)) || [];
      for (const f of result) {
        if (f && f.skipped) skipped.push({ id: mod.id, why: f.skipped, command: f.command || null });
        else findings.push(f);
      }
    } catch (err) {
      broken.push({ id: mod.id, why: err.message });
    }
  }
  findings.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  return { findings, skipped, broken };
}

// The witnessed catch, without jig. Each check names a violating sample and
// where to put it; the driver seeds it in a throwaway directory, runs that one
// check against it, and reports whether the check saw its own violation. A
// check that cannot seed itself says so instead of quietly passing.
async function runSelftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jig-selftest-"));
  const results = [];
  try {
    for (const mod of await loadChecks()) {
      if (mod.broken) { results.push({ id: mod.id, caught: false, why: mod.broken }); continue; }
      const seed = mod.selftest;
      if (!seed || !seed.path) {
        results.push({ id: mod.id, caught: null, why: seed && seed.why ? seed.why : "cannot seed itself", command: (seed && seed.command) || null });
        continue;
      }
      const full = path.join(dir, seed.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, seed.sample);
      let hits = [];
      try {
        hits = (await mod.check(makeContext(dir, null))) || [];
      } catch (err) {
        results.push({ id: mod.id, caught: false, why: err.message });
        fs.rmSync(full, { force: true });
        continue;
      }
      const real = hits.filter((h) => h && !h.skipped);
      results.push({ id: mod.id, caught: real.length > 0, seeded: seed.path, hits: real.length });
      fs.rmSync(full, { force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(out) {
  const lines = [];
  for (const f of out.findings) lines.push(`${f.path}:${f.line}  ${f.classId}${f.note ? "  (" + f.note + ")" : ""}`);
  for (const s of out.skipped) lines.push(`skipped  ${s.id} — ${s.why}${s.command ? "\n  run it yourself: " + s.command : ""}`);
  for (const b of out.broken) lines.push(`BROKEN   ${b.id} — ${b.why}`);
  lines.push(out.findings.length
    ? `\n${out.findings.length} finding${out.findings.length === 1 ? "" : "s"}.`
    : "\nNo findings.");
  return lines.join("\n");
}

function selftestReport(results) {
  const lines = [];
  for (const r of results) {
    if (r.caught === true) lines.push(`caught   ${r.id} — seeded ${r.seeded}, ${r.hits} hit${r.hits === 1 ? "" : "s"}`);
    else if (r.caught === null) lines.push(`skipped  ${r.id} — ${r.why}${r.command ? "\n  run it yourself: " + r.command : ""}`);
    else lines.push(`MISSED   ${r.id} — ${r.why || "the seeded violation did not fire the check"}`);
  }
  const missed = results.filter((r) => r.caught === false).length;
  lines.push(missed ? `\n${missed} check${missed === 1 ? "" : "s"} did not catch its own violation.` : "\nEvery runnable check caught its own violation.");
  return lines.join("\n");
}

async function main(argv) {
  const json = argv.includes("--json");
  const paths = argv.filter((a) => !a.startsWith("--"));
  if (argv.includes("--selftest")) {
    const results = await runSelftest();
    process.stdout.write((json ? JSON.stringify({ selftest: results }, null, 2) : selftestReport(results)) + "\n");
    return results.some((r) => r.caught === false) ? 1 : 0;
  }
  const out = await runChecks(ROOT, paths);
  process.stdout.write((json ? JSON.stringify(out, null, 2) : report(out)) + "\n");
  return out.findings.length || out.broken.length ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    // The driver failing is a fact to report, never a reason to stop somebody
    // committing. A crash exits 1 and says why, in one line.
    process.stderr.write("jig checks failed to run: " + err.message + "\n");
    process.exitCode = 1;
  },
);
