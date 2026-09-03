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
//   node .jig/checks/run.mjs --staged        check the staged bytes instead
//   node .jig/checks/run.mjs --ledger commit record what was found in the
//                                            ledger, under that lane's name
//   node .jig/checks/run.mjs --selftest      seed one violation per check and
//                                            prove each check catches its own
//   node .jig/checks/run.mjs --verify --lane <ci|commit> [--entry <id>]
//                                            run the linter, type checker and
//                                            test runner that lane names
//   node .jig/checks/run.mjs --json          machine-readable report
//
// Exit code is 1 when anything was found and 0 when nothing was. A selftest
// exits 1 when a check failed to catch its own seeded violation, and when a
// check claims this driver and carries no pair it can run. An empty checks
// directory is neither of those: no check failed, and none was proven either,
// so the report says nothing here is proven and the exit code stays 0. The
// workflow ships with this step in it, and an install whose coverage is a
// linter and a starter lands exactly that directory — exiting 1 on it was a CI
// lane red on its first push, on a tree jig had just written. The exit code
// answers "did a check fail here"; only the report answers "what is proven".
// A check whose detectors all belong to the session lane is a disclosed skip
// rather than a failure: it is proven where it runs. A walk that hit the file
// ceiling exits 1 too: it read part of the project, and 0 would say it read
// all of it. The one failure that exits 0 is this file itself crashing — that
// is a coverage gap, disclosed on stderr and in .jig/lane.log, and never a
// reason to stop somebody committing.
//
// A `--verify` run exits 1 when a command the lane names exited on anything but
// the code the entry expects, and when the lane could not start one at all. A
// lane with no entry in it ran nothing and exits 0 — the commit lane is opt-in,
// and a lane nobody asked for must not start failing commits.
//
// `--staged` is the commit lane's reading and nobody else's. A commit carries
// the index, not the working tree, and at commit time those are two different
// projects: a violation staged and then edited back out of the file lands in
// HEAD unchecked, and a violation sitting in the file but never staged blocks a
// commit that does not contain it. Both were reproduced. CI and a manual run
// have nothing staged and keep the walk.
//
// A check declares one of four detector kinds. A pattern detector is a regular
// expression over the files a glob names. A paired-change detector names two
// path sets and reports a staged change that touched the first and nothing in
// the second — the doc left behind by the module, the migration left behind by
// the schema. It reads the git index, so it has something to say at commit time
// and reports itself skipped anywhere nothing is staged. A removal detector
// counts what STOPPED being there, which needs a file before an edit and the
// same file after it. `--staged` is the one run that holds both — the index is
// the file after, HEAD is the file before — so the commit lane counts the drop,
// a deleted file included. Every other run reads the tree as it is and reports
// that class skipped; the selftest proves it from the fixture carrying both
// halves, so the check is proven where the lane cannot run it. An extract
// detector asks whether a doc still describes the thing it names: every name its
// regex takes out of `paths` has to appear literally somewhere in `pairedWith`.
// That is the doc-sync mistake co-change cannot reach, because both files moved
// and the doc names what the code no longer has. It reads the union whole —
// the index in the commit lane, the tree everywhere else — never the handful of
// files the run itself is scoped to.

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
// separators, `*` does not, `?` is one character, `{a,b}` is an alternation.
// Anything else is a literal. Without the alternation a path set like
// `**/*.{ts,tsx}` matches nothing at all, which is a silent zero-coverage
// failure rather than a loud one.
function globToRegExp(glob) {
  let out = "";
  let depth = 0;
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
    } else if (c === "{") {
      depth++;
      out += "(?:";
    } else if (c === "}" && depth) {
      depth--;
      out += ")";
    } else if (c === "," && depth) {
      out += "|";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + out + ")".repeat(depth) + "$", "i");
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

// Comment syntax is language data, so the edition that knows the language
// declares it per extension and hands the map down as `opts.commentSyntax`.
// This table is only the floor for a file no edition claimed — without it a
// `.py` or `.ps1` file would be read with JavaScript comment rules and every
// commented-out line would come back as live code.
const DEFAULT_COMMENT_SYNTAX = {
  ".py": "hash", ".pyi": "hash", ".rb": "hash", ".ps1": "hash", ".psm1": "hash",
  ".pl": "hash", ".pm": "hash", ".r": "hash", ".sh": "hash", ".bash": "hash",
  ".zsh": "hash", ".yml": "hash", ".yaml": "hash", ".toml": "hash",
};

function commentStyle(rel, syntax) {
  const ext = path.extname(rel).toLowerCase();
  if (syntax && typeof syntax[ext] === "string") return syntax[ext];
  if (/^(?:Dockerfile|Makefile|makefile|GNUmakefile)(?:\.|$)/.test(path.basename(rel))) return "hash";
  return DEFAULT_COMMENT_SYNTAX[ext] || "slash";
}

// A `/` opens a regular expression only where a value may start. After a name,
// a number, or a closing bracket it is division. The known miss is `if (x)
// /re/.test(s)`, where the regex body stays visible to the patterns — a rare
// shape, and one that can only ever add a finding, never hide one.
function regexCanStart(prev) {
  return prev === "" || !/[)\]}\w$]/.test(prev);
}

// Both `stripComments` and `stripStrings` default to true: blanking more is the
// fewer-false-positives direction, so an edition that says nothing gets the
// safe reading. `strings` is the driver's older spelling of `stripStrings`.
//
// Comments and string literals are RECOGNISED unconditionally and only ERASED
// when asked. That separation is the whole fix for the third fault: with string
// bodies left visible, a scanner that stopped tracking them read the `//` in a
// URL as a comment and blanked the rest of the line, and the `/*` in a glob as
// a block comment and blanked the rest of the file.
function blankRegions(text, rel, opts) {
  const o = opts || {};
  const style = commentStyle(rel, o.commentSyntax);
  const stripComments = o.stripComments !== false;
  const stripStrings = o.stripStrings !== undefined ? o.stripStrings !== false : o.strings !== false;
  const out = text.split("");
  const erase = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const toLineEnd = (from) => {
    let j = from;
    while (j < text.length && text[j] !== "\n") j++;
    return j;
  };

  // A literal that never closes is not a literal: reading it as one is how a
  // lone apostrophe used to blank everything after it.
  const closedAt = (i, q, oneLine) => {
    let j = i + 1;
    while (j < text.length) {
      const d = text[j];
      if (d === "\\") { j += 2; continue; }
      if (d === q) return { body: i + 1, bodyEnd: j, end: j + 1 };
      if (d === "\n" && oneLine) return null;
      j++;
    }
    return null;
  };
  // Rust raw strings: `r"…"`, `r#"…"#`, `br##"…"##`. No escapes inside, and the
  // hash count picks the terminator, so a `"` in the body cannot end it early.
  const RAW = /(?:br|r)(#*)"/y;
  const literalAt = (i) => {
    const q = text[i];
    if (style === "hash") {
      if (q !== '"' && q !== "'") return null;
      // Python triple quotes span lines; consuming one whole is what keeps the
      // scanner in step with the rest of the file.
      if (text[i + 1] === q && text[i + 2] === q) {
        const close = text.indexOf(q + q + q, i + 3);
        return close === -1 ? null : { body: i + 3, bodyEnd: close, end: close + 3 };
      }
      return closedAt(i, q, true);
    }
    if (q === "r" || q === "b") {
      if (/[\w$]/.test(text[i - 1] || "")) return null;
      RAW.lastIndex = i;
      const m = RAW.exec(text);
      if (!m || m.index !== i) return null;
      const term = '"' + m[1];
      const body = i + m[0].length;
      const close = text.indexOf(term, body);
      return close === -1 ? null : { body, bodyEnd: close, end: close + term.length };
    }
    if (q === '"' || q === "'") return closedAt(i, q, true);
    // Template literals and Go raw strings both span lines.
    if (q === "`") return closedAt(i, q, false);
    return null;
  };

  let prev = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (style === "hash" && c === "#") {
      const end = toLineEnd(i);
      if (stripComments) erase(i, end);
      i = end;
      continue;
    }
    if (style === "slash" && c === "/" && text[i + 1] === "/") {
      const end = toLineEnd(i);
      if (stripComments) erase(i, end);
      i = end;
      continue;
    }
    if (style === "slash" && c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      if (stripComments) erase(i, end);
      i = end;
      continue;
    }
    const lit = literalAt(i);
    if (lit) {
      if (stripStrings) erase(lit.body, lit.bodyEnd);
      prev = text[lit.end - 1];
      i = lit.end;
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
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// The context every check module is handed
// ---------------------------------------------------------------------------

// Returns the files and whether the ceiling cut the walk short. The second half
// matters as much as the first: a run that read part of the project and printed
// "No findings." is a coverage claim nobody demonstrated.
function walk(root, only) {
  if (only && only.length) {
    return {
      files: only
        .map((p) => path.relative(root, path.resolve(root, p)).split(path.sep).join("/"))
        .filter((rel) => rel && !rel.startsWith("..") && fs.existsSync(path.join(root, rel))),
      truncated: false,
    };
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
  // The loop stops on the ceiling with directories still on the stack, or on an
  // empty stack having read everything. Only the first is a partial scan.
  return { files: found, truncated: stack.length > 0 };
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

// One git reader for everything here. Argv, never a string a shell reads, and a
// non-zero exit is null rather than an exception: a repository git will not
// answer for is a run with nothing staged, not a crash.
function gitOut(root, args) {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf-8", windowsHide: true });
  return run.error || run.status !== 0 ? null : run.stdout;
}

// The staged file list, under whichever `--diff-filter` the caller needs.
// `--relative` for the same reason `changed()` uses it: git names paths from the
// repository root and a check's globs are written against ROOT, and below the
// root the two namespaces differ. The pattern kinds ask for `ACMR`, because a
// deleted file has no staged content left to read; the removal kind adds `D`,
// because a file git will commit the removal of is the plainest removal there
// is. SKIP_DIRS applies here as it does to the walk — staging a check module
// must not point the check at the fixture inside it.
// null, not an empty list, when git will not answer: an index nobody could read
// and an index with nothing in it are the same silence otherwise, and reporting
// the second for the first is a commit lane that rubber-stamps everything.
function stagedFiles(root, filter) {
  const out = gitOut(root, ["diff", "--cached", "--name-only", "--relative", "--diff-filter=" + filter]);
  if (out === null) return null;
  return out.split("\n").map((s) => s.trim()).filter(Boolean)
    .filter((rel) => !rel.split("/").some((seg) => SKIP_DIRS.has(seg)));
}

// Every path the index holds, which is the whole project as this commit will
// leave it rather than the handful of paths it touches. `ls-files` and not
// `diff --cached` for exactly that difference — an extract detector looks a
// doc's names up in every file that could carry them, not only the ones that
// happened to move.
//
// No `--relative`: `ls-files` has no such flag and already names paths from the
// directory it is run in, which is the namespace `--relative` buys everywhere
// else here. Below the repository root the two would otherwise differ and every
// glob would match nothing.
function indexFiles(root) {
  const out = gitOut(root, ["ls-files", "--cached"]);
  if (out === null) return null;
  return out.split("\n").map((s) => s.trim()).filter(Boolean)
    .filter((rel) => !rel.split("/").some((seg) => SKIP_DIRS.has(seg)));
}

function makeContext(root, only, staged) {
  const list = staged ? stagedFiles(root, "ACMR") : null;
  // A git that will not answer is a partial scan exactly like a walk that hit
  // the ceiling, and it exits non-zero for the same reason: 0 is the only thing
  // a hook reads, and there it says the project was checked.
  const walked = staged
    ? { files: list || [], truncated: list === null,
      why: "git could not list the staged files, so nothing in this commit was read" }
    : { ...walk(root, only), why: `the walk stopped at ${MAX_FILES} files — everything past that was never read` };
  const all = walked.files;
  const cache = new Map();
  // The whole project, read once and only where something asks for it.
  let whole;
  return {
    root,
    truncated: walked.truncated,
    partial: walked.truncated ? walked.why : null,
    files(globs) {
      return all.filter((rel) => matchesAny(rel, globs));
    },
    // The union a doc's names have to be found in, and deliberately not
    // `files()`. `files()` is what this run READS — the staged set at commit
    // time, the named paths on a path-scoped run — and a union narrowed to that
    // reports every name missing the moment the doc moved without the code
    // beside it. So the commit lane reads the index whole and every other run
    // reads the tree whole, whatever the run itself was scoped to.
    //
    // Null when git will not answer, like `changed()`: a union nobody could read
    // is not a union that came back missing the names.
    union(globs) {
      if (whole === undefined) {
        if (staged) whole = indexFiles(root);
        else if (!only || !only.length) whole = all;
        else {
          // The one run that has to walk twice: it was scoped to a few paths and
          // the union is still the whole project. A ceiling hit here would let a
          // name sitting in a file nobody read be reported missing, so it is
          // disclosed exactly as a partial scan is.
          const scan = walk(root, null);
          whole = scan.files;
          if (scan.truncated) {
            this.truncated = true;
            this.partial = `the union walk stopped at ${MAX_FILES} files — everything past that was never read`;
          }
        }
      }
      return whole === null ? null : whole.filter((rel) => matchesAny(rel, globs));
    },
    read(rel) {
      if (!cache.has(rel)) {
        try {
          // `:./path` is git's spelling for "this path in the index, named
          // relative to here" — the namespace the staged list came back in.
          const text = staged ? gitOut(root, ["show", ":./" + rel])
            : fs.readFileSync(path.join(root, rel), "utf-8");
          cache.set(rel, text === null ? null : text.replace(/^﻿/, ""));
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
      const stdout = gitOut(root, args);
      return stdout === null ? { ok: false, stdout: "" } : { ok: true, stdout };
    },
    // The staged change set, and what a paired-change detector reads.
    //
    // Staged and nothing else. A base ref would have to be guessed, and a
    // guessed base makes the same check say different things on a branch, on a
    // merge, and on a shallow CI clone — three answers is worse than one honest
    // limit. Nothing staged returns null, which the caller reports as a skip
    // rather than a pass: a class nobody could evaluate is not a class that
    // came back clean.
    //
    // `--relative` because git names staged files from the repository root and
    // a check's globs are written against ROOT. Where jig is installed below
    // the root the two namespaces differ, and every paired check would match
    // nothing on a real commit while still reporting itself as coverage.
    changed() {
      const run = this.git(["diff", "--cached", "--name-only", "--relative"]);
      if (!run.ok) return null;
      const list = run.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      return list.length ? list : null;
    },
    // The change set a removal detector counts over, and the file as HEAD has
    // it. Deletions are in this list and out of the other one: a file the commit
    // removes outright is the plainest removal there is, and it is precisely the
    // one a pattern can never see. Null where nothing is staged, like
    // `changed()`, so the caller reports a skip rather than a pass.
    removedChanged() {
      const list = stagedFiles(root, "ACMRD");
      return list && list.length ? list : null;
    },
    // The version this commit replaces. Null when HEAD does not carry the path,
    // which is a file this commit ADDS — an addition removes nothing.
    head(rel) {
      const text = gitOut(root, ["show", "HEAD:./" + rel]);
      return text === null ? null : text.replace(/^﻿/, "");
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
      if (typeof mod.id === "string" && Array.isArray(mod.detectors)) checks.push(mod);
    } catch (err) {
      // A check that will not load is reported and skipped. One broken module
      // must not take the others down with it.
      checks.push({ id: name, broken: err.message });
    }
  }
  return checks;
}

// A check module declares detectors, not a function. Only the ones this driver
// runs are its own — a detector belonging to a session guard or to CI names a
// different runner and is skipped here rather than run in the wrong place.
function driverDetectors(mod) {
  return mod.detectors.filter((det) => det && det.runner === "checks" &&
    det.params && Array.isArray(det.params.patterns) && det.params.patterns.length);
}

function scanWith(ctx, mod, det) {
  const p = det.params;
  return ctx.scan(mod.id, p.paths || [], p.patterns, p);
}

// The second detector kind, and the only one that is not a regular expression
// over source. A pattern detector asks what is inside one file. A paired-change
// detector asks what moved together, which is a question no pattern can reach:
// the doc that has to follow the module, the migration that has to follow the
// schema, the fixture that has to follow the format. `paths` names the files
// whose change obliges something matching `pairedWith` to change with them.
// An extract detector names `pairedWith` too and means something else by it —
// not "this had to change alongside" but "this is where the names have to
// appear" — so it is excluded here rather than reported as a doc that never
// moved.
function pairedDetectors(mod) {
  return mod.detectors.filter((det) => det && det.runner === "checks" && det.params &&
    !(Array.isArray(det.params.extract) && det.params.extract.length) &&
    Array.isArray(det.params.pairedWith) && det.params.pairedWith.length &&
    Array.isArray(det.params.paths) && det.params.paths.length);
}

// The paired detector's whole rule, written once so admission and the shipped
// driver cannot answer it differently: the set touched something in `paths` and
// nothing in `pairedWith`.
function pairedFires(units, set, match) {
  return units.some((u) => set.some((rel) => matchesAny(rel, u.paths, match)) &&
    !set.some((rel) => matchesAny(rel, u.pairedWith, match)));
}

// The finding names the file that moved without its pair, at line 1. The
// mistake is the absence of another file, so there is no line in this one to
// point at, and pretending otherwise would send somebody to an innocent line.
//
// The caller answers first whether the `pairedWith` glob names anything in the
// project at all, and reports the class skipped when it does not: a pair that
// exists nowhere is not a pair this change left behind. The fixture pair cannot
// catch that — its change set is inline text, so a `pairedWith` glob is never
// compiled against a real tree — so without that gate a check the pair certified
// reports every touch of `paths` as a doc left behind, for ever.
function pairedFindings(ctx, mod, det, changed) {
  const p = det.params;
  const touched = changed.filter((rel) => matchesAny(rel, p.paths));
  if (!pairedFires([p], changed, globToRegExp)) return [];
  const note = "changed with nothing matching " + p.pairedWith.join(" or ");
  return touched.map((rel) => ctx.finding(mod.id, rel, 1, "paired:" + p.pairedWith.join(","), note));
}

// The third detector kind. A pattern detector asks what is inside one file and
// a paired-change detector asks what moved together; a removal detector asks
// what stopped being there, which neither can see, because every deleted line is
// absent from the file that is left.
function removedDetectors(mod) {
  return mod.detectors.filter((det) => det && det.runner === "checks" && det.params &&
    Array.isArray(det.params.removed) && det.params.removed.length);
}

// Its fixture is one file before an edit and the same file after it, in one
// string with `--- after` on a line of its own between them.
//
// The extract kind needs two texts for its own reason — the doc, then the union
// its names have to appear in — and says so with `--- paired`. The label is the
// only difference; it is never anything but one of those two literals, so
// nothing here escapes it.
function fencedHalves(text, label) {
  const at = text.search(new RegExp("^--- " + (label || "after") + "$", "m"));
  if (at === -1) return null;
  const nl = text.indexOf("\n", at);
  return { before: text.slice(0, at), after: nl === -1 ? "" : text.slice(nl + 1) };
}

// The extract fence, named once so admission, the driver and the skill cannot
// spell it differently.
const PAIRED_FENCE = "paired";

// The removal detector's whole rule, written once so admission and the shipped
// driver cannot answer it differently: some pattern this detector names is in
// the before text more times than in the after text, and by how much.
function removedDrop(before, after, patterns) {
  for (const p of patterns) {
    const drop = countOf(before, p) - countOf(after, p);
    if (drop > 0) return { pattern: p, drop };
  }
  return null;
}

function countOf(text, pattern) {
  return (text.match(new RegExp(pattern, "g")) || []).length;
}

// Both halves are blanked the way the pattern kind blanks a file, at the path
// the count is taken over, so a declaration that only ever lived in a comment is
// not a removal.
function removedDropAt(det, rel, halves) {
  return removedDrop(blankRegions(halves.before, rel, det.params),
    blankRegions(halves.after, rel, det.params), det.params.removed);
}

// The selftest's reading of it: the fixture carries both halves, so the path is
// the one this detector's own globs derive.
function removedHits(det, halves) {
  return removedDropAt(det, fixturePath(det), halves) ? 1 : 0;
}

// The commit lane's reading of it, and the only lane that has two versions of a
// real file: the index is the file after, HEAD is the file before. The finding
// names the file at line 1, like a paired one — what is wrong is an absence, and
// there is no line left in the file to point at.
function countFloorFindings(ctx, mod, det, changed) {
  const p = det.params;
  const out = [];
  for (const rel of changed.filter((r) => matchesAny(r, p.paths || []))) {
    const before = ctx.head(rel);
    if (before === null) continue;
    const after = ctx.read(rel);
    // A staged deletion reads back null, which is the same absence as an empty
    // file and counted as one.
    const found = removedDropAt(det, rel, { before, after: after === null ? "" : after });
    if (found) {
      out.push(ctx.finding(mod.id, rel, 1, "removed:" + found.pattern,
        found.drop + " fewer than the version this commit replaces"));
    }
  }
  return out;
}

// The fourth detector kind. A pattern detector asks what is inside one file, a
// paired-change detector asks what moved together, a removal detector asks what
// stopped being there. This one asks whether a doc still describes the thing it
// names: every name its regex takes out of `paths` has to appear literally
// somewhere in `pairedWith`. It is the doc-sync mistake co-change cannot reach —
// the README and the flag were renamed in the same commit and the README named
// the wrong one.
function extractDetectors(mod) {
  return mod.detectors.filter((det) => det && det.runner === "checks" && det.params &&
    Array.isArray(det.params.extract) && det.params.extract.length &&
    Array.isArray(det.params.paths) && det.params.paths.length &&
    Array.isArray(det.params.pairedWith) && det.params.pairedWith.length);
}

// The rule, written once so the lane and the selftest cannot answer it
// differently: every name the regex takes out of the doc has to appear literally
// in one of the union's texts. Raw bytes on both sides, and nothing blanked — a
// doc has no comments to strip, and a name the code carries only in a comment is
// still a name the code carries, which is the direction that adds no finding.
//
// A pattern with no capture group takes nothing out of the doc, so it says
// nothing here. It never fires on its own violation either, which is what keeps
// it out rather than a rule about how a pattern must be written.
function extractMisses(det, doc, union) {
  const out = [];
  for (const pattern of det.params.extract) {
    for (const m of doc.matchAll(new RegExp(pattern, "g"))) {
      if (typeof m[1] !== "string" || !m[1]) continue;
      if (union.some((body) => body.includes(m[1]))) continue;
      out.push({ pattern, at: m.index + m[0].indexOf(m[1]) });
    }
  }
  return out;
}

// The finding is at the name's own line, which is the one place in the doc a
// reader can act on: the line that says the thing the code no longer has. The
// name itself is never carried out, for the reason `finding` gives — a report
// says which check spoke and where, not what somebody's text said.
//
// Null when the union read back with no text at all, which is the caller's cue
// to report the class skipped: a union nothing matches is not a union that came
// back missing every name. The fixture pair cannot catch that — its union half
// is inline text, so a `pairedWith` glob is never compiled against a real tree —
// so without this a check the pair certified reports every name in every doc as
// drift and blocks the commit that installed it.
function extractFindings(ctx, mod, det, union) {
  const bodies = union.map((rel) => ctx.read(rel)).filter((text) => text !== null);
  if (!bodies.length) return null;
  const note = "names something no file matching " + det.params.pairedWith.join(" or ") + " has";
  const out = [];
  for (const rel of ctx.files(det.params.paths)) {
    const text = ctx.read(rel);
    if (text === null) continue;
    for (const miss of extractMisses(det, text, bodies)) {
      out.push(ctx.finding(mod.id, rel, lineOf(text, miss.at), "extract:" + miss.pattern, note));
    }
  }
  return out;
}

// The fixture pair is stored inline, so the driver has to invent the path it
// would have lived under. That path has to satisfy the detector's own globs, or
// ctx.scan filters the fixture straight back out and every precise check reports
// a miss it never had. So the first glob is walked segment by segment and each
// wildcard is replaced with a literal: `**` between directories collapses to
// nothing, a `*` directory becomes one named directory, a `{a,b}` alternation
// takes its first branch, and the final segment's `*` becomes `fixture`. A glob
// ending `*.js` therefore still yields `fixture.js`, the same name and so the
// same language admission read it as.
function concreteSegment(glob, star) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      out += star;
      while (glob[i + 1] === "*") i++;
    } else if (c === "?") {
      out += "x";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      const body = end === -1 ? glob.slice(i + 1) : glob.slice(i + 1, end);
      out += body.split(",")[0];
      i = end === -1 ? glob.length : end;
    } else {
      out += c;
    }
  }
  return out;
}

function fixturePath(det) {
  const glob = (det.params.paths || [])[0] || "fixture.txt";
  const segments = glob.split("/");
  const base = concreteSegment(segments.pop(), "fixture");
  const dirs = segments
    .filter((seg) => seg !== "**" && seg !== "")
    .map((seg) => concreteSegment(seg, "fx"));
  return [...dirs, base].join("/");
}

// ---------------------------------------------------------------------------
// The two runs
// ---------------------------------------------------------------------------

async function runChecks(root, only, staged) {
  const ctx = makeContext(root, only, staged);
  const findings = [];
  const skipped = [];
  const broken = [];
  // The reason and the alternative the check's author wrote for the moment it
  // fires. A finding that names a pattern and a line tells somebody WHAT
  // matched; these tell them why it is a mistake and what to do instead, which
  // is the only part they can act on.
  const denies = {};
  // Read once, for every paired detector in the run. Asking git per check would
  // spawn a process per module to learn the same fact.
  let changed;
  let dropped;
  for (const mod of await loadChecks()) {
    if (mod.broken) { broken.push({ id: mod.id, why: mod.broken }); continue; }
    const mine = driverDetectors(mod);
    const paired = pairedDetectors(mod);
    const removed = removedDetectors(mod);
    const extract = extractDetectors(mod);
    if (!mine.length && !paired.length && !removed.length && !extract.length) {
      skipped.push({ id: mod.id, why: "no detector this driver runs — it is watched elsewhere", command: null });
      continue;
    }
    // A removal needs the file as it was as well as the file as it is, and a
    // walk only has the second. Said out loud rather than counted as clean: a
    // class nobody could evaluate is not a class that came back with nothing.
    // Only when the module carries nothing else this run reads. A module with a
    // pattern detector beside its removal one IS evaluated, and reporting it
    // skipped as well would make the word mean two things in one run.
    if (removed.length && !staged && !mine.length && !paired.length && !extract.length) {
      // Where it IS watched, said only when the module carries the lever that
      // does it. A removal reaches a lane through an edit guard reading one
      // call's two halves; a module with none is watched nowhere at all, and
      // pointing the owner at the session lane anyway is a coverage claim.
      const session = mod.detectors.some((det) => det && det.runner !== "checks" && det.params &&
        Array.isArray(det.params.removed) && det.params.removed.length);
      skipped.push({
        id: mod.id,
        why: "a removal is only visible between two versions of a file, and this run reads the tree as it is" +
          " — the commit lane counts it against HEAD" +
          (session ? ", and this class is watched where the edit happens"
            : ", and this check carries no session guard either, so nothing watches it as it is typed"),
        command: null,
      });
    }
    const deny = mod.deny || mod.detectors.map((d) => d && d.deny).find(Boolean);
    if (deny && typeof deny.reason === "string" && typeof deny.alternative === "string") {
      denies[mod.id] = { reason: deny.reason, alternative: deny.alternative };
    }
    try {
      for (const det of mine) findings.push(...scanWith(ctx, mod, det));
      if (paired.length) {
        if (changed === undefined) changed = ctx.changed();
        if (changed === null) {
          skipped.push({
            id: mod.id,
            why: "nothing is staged, so there is no change set to read — this class is watched at commit time",
            command: null,
          });
        } else {
          for (const det of paired) {
            // The relation half, read against the real tree. A `pairedWith`
            // glob nothing matches is not a pair this change left behind, and
            // reporting it as one turns the check into a firehose the fixture
            // pair certified — the same defect `extract` had, on a different
            // relation.
            const union = ctx.union(det.params.pairedWith);
            if (union === null) {
              skipped.push({
                id: mod.id,
                why: "git could not list what the index holds, so there was nothing to say whether this class's pair is there at all",
                command: null,
              });
              break;
            }
            if (!union.length) {
              skipped.push({
                id: mod.id,
                why: "no file matching " + det.params.pairedWith.join(" or ") +
                  " exists here, so nothing in this commit could have been changed alongside it",
                command: null,
              });
              continue;
            }
            findings.push(...pairedFindings(ctx, mod, det, changed));
          }
        }
      }
      // The content relation. Every lane reads it — the doc and the union both
      // exist in the tree as readily as in the index — and the commit lane reads
      // both from the staged bytes, which is the only reading that describes the
      // commit being made.
      for (const det of extract) {
        const union = ctx.union(det.params.pairedWith);
        if (union === null) {
          skipped.push({
            id: mod.id,
            why: "git could not list what the index holds, so there was nothing to look this doc's names up in",
            command: null,
          });
          break;
        }
        const found = extractFindings(ctx, mod, det, union);
        if (found === null) {
          skipped.push({
            id: mod.id,
            why: "no file matching " + det.params.pairedWith.join(" or ") +
              " could be read here, so there is nothing to look this doc's names up in",
            command: null,
          });
          continue;
        }
        findings.push(...found);
      }
      // The count floor, and the commit lane's alone. It is the one run holding
      // the file before the change as well as the file after it, so it is the
      // one run that can say the suite lost cases in this commit.
      if (removed.length && staged) {
        if (dropped === undefined) dropped = ctx.removedChanged();
        if (dropped === null) {
          skipped.push({
            id: mod.id,
            why: "nothing is staged, so there is no earlier version to count against",
            command: null,
          });
        } else {
          for (const det of removed) findings.push(...countFloorFindings(ctx, mod, det, dropped));
        }
      }
    } catch (err) {
      broken.push({ id: mod.id, why: err.message });
    }
  }
  findings.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  return { findings, skipped, broken, denies, truncated: ctx.truncated, partial: ctx.partial };
}

// The witnessed catch, without jig. Every check carries the pair that admitted
// it, so the driver can re-run that same admission here, in a throwaway
// directory, with nothing installed. Both halves count: a check that misses its
// own violation is broken, and one that fires on its own near miss is a check
// that will cry wolf on somebody's real code.
async function runSelftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jig-selftest-"));
  const results = [];
  try {
    for (const mod of await loadChecks()) {
      if (mod.broken) { results.push({ id: mod.id, caught: false, why: mod.broken }); continue; }
      const mine = driverDetectors(mod);
      const paired = pairedDetectors(mod);
      const removed = removedDetectors(mod);
      const extract = extractDetectors(mod);
      const pair = mod.fixtures;
      // A check whose every detector belongs to another lane is not this
      // driver's to prove. The session guards carry their own witnessed close,
      // so this is a disclosed skip and not a failure — a repository whose
      // checks are all session guards is a healthy install, and failing its
      // selftest would leave the shipped CI workflow red for ever.
      if (!mod.detectors.some((det) => det && det.runner === "checks")) {
        results.push({ id: mod.id, caught: null, why: "declares no `checks` detector — it is proven in the session lane", command: null });
        continue;
      }
      // But a check that DOES claim this driver and hands it nothing runnable
      // is unproven coverage sitting in the checks directory. Every check jig
      // admits carries its pair inline, so this one was never admitted, and
      // skipping it quietly is the coverage claim the driver must not make.
      if ((!mine.length && !paired.length && !removed.length && !extract.length) || !pair ||
          typeof pair.violation !== "string" || typeof pair.nearMiss !== "string") {
        results.push({ id: mod.id, caught: false, why: "claims a `checks` detector but carries no fixture pair this driver can run" });
        continue;
      }
      let hits = 0;
      let nearMissHits = 0;
      let failed = null;
      let seeded = null;
      for (const det of mine) {
        const name = fixturePath(det);
        if (!seeded) seeded = name;
        const full = path.join(dir, ...name.split("/"));
        try {
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, pair.violation);
          hits += scanWith(makeContext(dir, [name]), mod, det).length;
          fs.writeFileSync(full, pair.nearMiss);
          nearMissHits += scanWith(makeContext(dir, [name]), mod, det).length;
        } catch (err) {
          failed = err.message;
        } finally {
          fs.rmSync(full, { force: true });
        }
        if (failed) break;
      }
      // A paired-change fixture is a change set rather than source text: one
      // path per line. Nothing is written to disk for it, because the thing
      // under test is which paths appear together, and a list is already that.
      if (!failed && paired.length) {
        const asSet = (text) => text.split("\n").map((s) => s.trim()).filter(Boolean);
        const bare = makeContext(dir, []);
        for (const det of paired) {
          if (!seeded) seeded = (det.params.paths || []).join(", ") || null;
          hits += pairedFindings(bare, mod, det, asSet(pair.violation)).length;
          nearMissHits += pairedFindings(bare, mod, det, asSet(pair.nearMiss)).length;
        }
      }
      // A removal fixture is one file before an edit and the same file after it,
      // fenced in one string. Nothing is written to disk for it either: the thing
      // under test is the difference between two counts, and both texts are here.
      if (!failed && removed.length) {
        const halves = { v: fencedHalves(pair.violation), n: fencedHalves(pair.nearMiss) };
        if (!halves.v || !halves.n) {
          failed = "a removal detector's fixture carries no `--- after` fence, so there are no two versions to compare";
        } else {
          for (const det of removed) {
            if (!seeded) seeded = fixturePath(det);
            hits += removedHits(det, halves.v);
            nearMissHits += removedHits(det, halves.n);
          }
        }
      }
      // An extract fixture is a doc and the union its names have to appear in,
      // fenced by `--- paired` in one string. Nothing is written to disk for it
      // either: the thing under test is whether one text's names are in the
      // other, and both texts are here.
      if (!failed && extract.length) {
        const halves = { v: fencedHalves(pair.violation, PAIRED_FENCE), n: fencedHalves(pair.nearMiss, PAIRED_FENCE) };
        if (!halves.v || !halves.n) {
          failed = "an extract detector's fixture carries no `--- paired` fence, so there is nothing to look its names up in";
        } else {
          for (const det of extract) {
            if (!seeded) seeded = fixturePath(det);
            hits += extractMisses(det, halves.v.before, [halves.v.after]).length;
            nearMissHits += extractMisses(det, halves.n.before, [halves.n.after]).length;
          }
        }
      }
      if (failed) { results.push({ id: mod.id, caught: false, why: failed }); continue; }
      const why = hits === 0 ? "the seeded violation did not fire the check"
        : nearMissHits > 0 ? "the check also fired on its own near miss" : null;
      results.push({ id: mod.id, caught: hits > 0 && nearMissHits === 0, seeded, hits, nearMissHits, why });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

// ---------------------------------------------------------------------------
// The lane verification
// ---------------------------------------------------------------------------
//
// A linter, a type checker and a test runner are only coverage where something
// runs them. `.jig/verify.json` is the list of what runs and where: one entry
// per tool the owner ticked, carrying the argv, the exit code a clean run has,
// the paths the tool speaks for, and the lanes that run it.
//
// Every entry is an argv spawned with no shell — the same stance the installer
// takes, and for the same reason: a string a shell reads is a string somebody
// can put a second command in. A file that is missing, unreadable or names no
// entry for this lane runs nothing and exits 0, because the commit lane is
// opt-in and a lane nobody asked for must not start failing commits.

function readVerifyEntries() {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(HERE, "..", "verify.json"), "utf-8").replace(/^﻿/, ""));
  } catch {
    return [];
  }
  const rows = record && Array.isArray(record.entries) ? record.entries : [];
  return rows.filter((e) => e && typeof e.id === "string" && Array.isArray(e.argv) && e.argv.length &&
    e.argv.every((a) => typeof a === "string" && a) && Array.isArray(e.lanes));
}

function flagValue(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 || !argv[at + 1] || argv[at + 1].startsWith("--") ? null : argv[at + 1];
}

// Where an executable name resolves to a `.cmd` or `.bat` on this machine.
// Returns the resolved path, or null on any platform and for any name where
// that is not the story — including when the tool is genuinely absent.
function windowsShim(name) {
  if (process.platform !== "win32") return null;
  if (/\.(cmd|bat)$/i.test(name)) return name;
  for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of [".cmd", ".bat"]) {
      const full = path.join(dir, name + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch { /* a PATH entry that is not there is not this function's problem */ }
    }
  }
  return null;
}

// The JS the `.cmd` shim would have handed to node, per manager, resolved
// beside the shim itself. A machine with fnm or nvm has one of these per node
// version; the one that answers to `npm` on this PATH is the one whose shim was
// just found, so the neighbour is the right copy and a PATH search is not.
const NODE_CLI_ENTRIES = {
  npm: "node_modules/npm/bin/npm-cli.js",
  npx: "node_modules/npm/bin/npx-cli.js",
  pnpm: "node_modules/pnpm/bin/pnpm.cjs",
  yarn: "node_modules/yarn/bin/yarn.js",
};

// The same command with no shim in it, or null when there is no such route.
// npm, pnpm and yarn are Node programs wearing a `.cmd` hat: the shim's whole
// job is to find node and hand it the script named here, and jig already IS a
// node that can do that. So the batch shim is never the route (SCOPE, the
// derail pass) and no shell is needed for the managers the owner's own platform
// installs everything through. Nothing else is rewritten — a batch file with no
// JS behind it needs cmd.exe, and jig opens no shell.
function shellFreeArgv(argv) {
  const rel = NODE_CLI_ENTRIES[String(argv[0]).replace(/\.(cmd|bat)$/i, "").toLowerCase()];
  if (!rel) return null;
  // Absolute only: `windowsShim` hands a bare `.cmd` name straight back, and
  // resolving the entry beside that would read a `node_modules` in whatever
  // directory jig happens to be run from rather than the manager's own.
  const shim = windowsShim(argv[0]);
  if (!shim || !path.isAbsolute(shim)) return null;
  const entry = path.join(path.dirname(shim), ...rel.split("/"));
  if (!fs.existsSync(entry)) return null;
  return [process.execPath, entry, ...argv.slice(1)];
}

function runVerify(lane, only) {
  const entries = readVerifyEntries()
    .filter((e) => e.lanes.includes(lane) && (only === null || e.id === only));
  const results = [];
  for (const entry of entries) {
    const expectedExit = Number.isInteger(entry.expectedExit) ? entry.expectedExit : 0;
    // Every shipped JS argv starts with `npx`, which on Windows is a batch shim
    // Node will not start without a shell — and this driver opens none. So the
    // shim's own JS entry is run directly, exactly as the installer does it.
    // Without this the whole lane came back NOT RUN on Windows, and a wired
    // commit lane blocked every commit on that machine.
    const spawnable = shellFreeArgv(entry.argv) || entry.argv;
    const run = spawnSync(spawnable[0], spawnable.slice(1), {
      cwd: ROOT, shell: false, windowsHide: true, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024,
    });
    const command = entry.argv.join(" ");
    if (run.error) {
      // A tool the lane cannot start is a gap, never a pass: this lane claims to
      // run it, and reporting nothing would be the coverage claim the driver
      // must not make.
      results.push({ id: entry.id, command, ran: false, passed: false, why: "could not run " + entry.argv[0] +
        " (" + (run.error.code || run.error.message) + ")" });
      continue;
    }
    results.push({
      id: entry.id, command, ran: true, code: run.status, expectedExit,
      passed: run.status === expectedExit,
      output: ((run.stdout || "") + (run.stderr || "")).trim(),
    });
  }
  return { lane, entry: only, requested: entries.length, results };
}

function verifyReport(out) {
  const lines = [];
  for (const r of out.results) {
    if (r.passed) lines.push(`ok       ${r.id} — ${r.command} exited ${r.code}`);
    else if (!r.ran) lines.push(`NOT RUN  ${r.id} — ${r.why}\n  command: ${r.command}`);
    else lines.push(`FAILED   ${r.id} — ${r.command} exited ${r.code}, expected ${r.expectedExit}` +
      (r.output ? "\n" + r.output : ""));
  }
  const failed = out.results.filter((r) => !r.passed).length;
  if (failed) lines.push(`\n${failed} of ${out.results.length} did not pass in the ${out.lane} lane.`);
  else if (out.results.length) lines.push(`\nEvery command the ${out.lane} lane names passed.`);
  else if (out.entry) lines.push(`\nNothing named ${out.entry} runs in the ${out.lane} lane — .jig/verify.json` +
    ` no longer carries that entry, so this step proves nothing.`);
  else lines.push(`\nNo entry names the ${out.lane} lane, so nothing was verified.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(out) {
  const lines = [];
  for (const f of out.findings) {
    lines.push(`${f.path}:${f.line}  ${f.classId}${f.note ? "  (" + f.note + ")" : ""}`);
    const deny = (out.denies || {})[f.classId];
    if (deny) {
      lines.push(`  ${deny.reason}`);
      lines.push(`  Instead: ${deny.alternative}`);
    }
  }
  for (const s of out.skipped) lines.push(`skipped  ${s.id} — ${s.why}${s.command ? "\n  run it yourself: " + s.command : ""}`);
  for (const b of out.broken) lines.push(`BROKEN   ${b.id} — ${b.why}`);
  // A partial walk is disclosed on the report and again in the closing line,
  // because the closing line is the one anybody reads. "No findings" over a
  // scan that stopped at the ceiling would be coverage nobody demonstrated.
  if (out.partial) lines.push(`PARTIAL  ${out.partial}`);
  lines.push(out.findings.length
    ? `\n${out.findings.length} finding${out.findings.length === 1 ? "" : "s"}.`
    : out.partial
      ? "\nNo findings in what was read, which is not the whole project. This is a partial scan, not a pass."
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
  const proved = results.filter((r) => r.caught === true).length;
  lines.push(missed ? `\n${missed} check${missed === 1 ? "" : "s"} did not catch its own violation.`
    : proved ? "\nEvery runnable check caught its own violation."
    // Nothing ran is not the same as nothing failed, and the old wording said
    // the second about the first. A selftest that proved no check proved no
    // coverage, which is the one claim this driver must never make.
    : "\nNo check ran its own fixture pair, so nothing here is proven. There is no coverage to report.");
  return lines.join("\n");
}

async function main(argv) {
  const json = argv.includes("--json");
  const ledger = flagValue(argv, "--ledger");
  // The lane name is a value, not a path to check. Without the second clause
  // `--ledger commit` would scope the whole run to a file called `commit`,
  // which exists nowhere — a lane that checked nothing and said so cleanly.
  const paths = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--ledger");
  if (argv.includes("--verify")) {
    const lane = flagValue(argv, "--lane");
    const out = runVerify(lane || "ci", flagValue(argv, "--entry"));
    // Only a lane that names itself writes, exactly as `--ledger` gates the
    // findings writer. Without the gate a hand-typed `--verify` minted a row
    // reading `lane: "ci"` — evidence for a lane that did not run, off the
    // default the report happens to use — and `lastGreen` read it back as fact.
    if (lane) ledgerVerify(lane, out.results);
    process.stdout.write((json ? JSON.stringify({ verify: out }, null, 2) : verifyReport(out)) + "\n");
    // A step that named one entry and found none is a lane that lost the tool it
    // claims to run — exit 1. A lane nobody put an entry in ran nothing and says
    // so, which is the opt-in case and exits 0.
    if (out.entry && !out.results.length) return 1;
    return out.results.some((r) => !r.passed) ? 1 : 0;
  }
  if (argv.includes("--selftest")) {
    const results = await runSelftest();
    process.stdout.write((json ? JSON.stringify({ selftest: results }, null, 2) : selftestReport(results)) + "\n");
    // A check that failed is the only thing this exit code reports. Nothing to
    // run is not a failure of anything: the report above already says nothing
    // is proven, and exiting 1 on it made the shipped CI workflow red on every
    // install whose checks directory holds only this file.
    return results.some((r) => r.caught === false) ? 1 : 0;
  }
  const out = await runChecks(ROOT, paths, argv.includes("--staged"));
  if (ledger) ledgerFindings(ledger, out.findings);
  process.stdout.write((json ? JSON.stringify(out, null, 2) : report(out)) + "\n");
  // A truncated walk exits non-zero for the same reason it prints a line: the
  // exit code is the only thing a hook or a CI step reads, and 0 there says the
  // project was checked.
  return out.findings.length || out.broken.length || out.truncated ? 1 : 0;
}

// One row per finding, in the ledger the session lane already writes. Only a
// lane that names itself writes here: a manual run stays the read-only thing
// the activation doc promises, and only the shim passes the flag.
//
// Class facts and nothing else — the class that spoke, the file and the line.
// Never the pattern that fired and never the matched text: a matcher or a line
// of somebody's source, sitting in a record a report reads back, is a thing
// that gets pasted somewhere without review. The finding already carries the
// pattern for the person reading the report; the ledger is not that reader.
//
// `deny` and `armed` because the commit lane has one mode: a finding here exits
// 1 and the shim stops the commit. There is no observe half to distinguish.
//
// Wrapped whole, and deliberately silent. A ledger row that will not append is
// a missing piece of evidence, never a reason to fail somebody's commit.
function ledgerFindings(lane, findings) {
  try {
    const ts = new Date().toISOString();
    const rows = findings.map((f) => JSON.stringify({
      ts, lane, session: null, actor: null, guardId: null, classId: f.classId,
      mode: "armed", decision: "deny", tool: null, matched: null, path: f.path, line: f.line,
    }) + "\n").join("");
    if (rows) fs.appendFileSync(path.join(HERE, "..", "ledger.jsonl"), rows);
  } catch { /* evidence that cannot be written is not a reason to block */ }
}

// One row per lane entry a verification run touched, in the shape the session
// hook's witness writes: a `verify` id and a `verified`/`verify-failed`
// decision, with no guardId, is what the ledger's verification reader keeps.
// Without it a repository whose pre-commit hook ran the suite green on every
// commit still reported `lastGreen: null`, because only the session lane had
// ever left evidence.
//
// Only a lane that names itself with `--lane`, for the reason `ledgerFindings`
// says: a manual run stays the read-only thing the activation doc promises, and
// a row carrying the default lane name would be evidence for a lane nobody ran.
// A hosted CI lane writes here too and the row still dies with the job — the
// ledger is git-ignored and the checkout is thrown away — which is why the
// skills say `lastGreen` answers for the session and commit lanes and not for
// somebody else's runner.
//
// An entry that could not start is `verify-failed` like any other red run: it
// did not verify, and a lane that recorded nothing there would be the coverage
// gap going quiet again.
//
// Wrapped whole and silent, for the reason `ledgerFindings` is: evidence that
// cannot be written is never a reason to fail somebody's commit or CI step.
function ledgerVerify(lane, results) {
  try {
    const ts = new Date().toISOString();
    const rows = results.map((r) => JSON.stringify({
      ts, lane, session: null, actor: null, guardId: null, classId: null,
      mode: "armed", decision: r.passed ? "verified" : "verify-failed", tool: null,
      matched: null, path: null, verify: r.id, exitCode: r.ran ? r.code : null,
    }) + "\n").join("");
    if (rows) fs.appendFileSync(path.join(HERE, "..", "ledger.jsonl"), rows);
  } catch { /* evidence that cannot be written is not a reason to fail a lane */ }
}

// The same row the commit shim writes, in the same file: a lane that goes quiet
// and a lane that never ran are the same silence otherwise. Machine-local,
// git-ignored, and failing to write it never fails a run.
function laneLog(what) {
  try {
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    fs.appendFileSync(path.join(HERE, "..", "lane.log"), stamp + " checks " + what + "\n");
  } catch { /* a disclosure that cannot be written is not a reason to fail */ }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    // The driver failing is a fact to report, never a reason to stop somebody
    // committing: a driver that cannot run is a disclosed coverage gap. CI runs
    // this same file, so the gap is disclosed there on stderr and in the lane
    // log rather than by a red job — SCOPE's derail-pass row C13d is where that
    // trade was made. Exit 1 stays where it means something: a check that
    // reported a finding, and a check module that would not load, which is a
    // broken install the owner made and can revert.
    const why = String((err && err.message) || err).split("\n")[0];
    process.stderr.write("jig checks failed to run, so nothing was checked: " + why + "\n");
    laneLog("crashed " + why);
    process.exitCode = 0;
  },
);
