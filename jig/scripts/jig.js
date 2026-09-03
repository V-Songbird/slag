#!/usr/bin/env node
"use strict";

// jig engine — the transaction core. Every byte jig ever writes goes through
// here, which is what makes "named, approved, reversible" a mechanical property
// instead of a promise: the target is fingerprinted before the write, the
// pre-image is journalled before the write, and the write is re-validated after
// it.
//
// Commands (run from the project root being guarded):
//   node jig.js scan                         read the project's own facts, the
//                                            languages it is written in, and
//                                            which of jig's slots are taken;
//                                            writes .jig/profile.json
//   node jig.js toolchain                    the apparatus each matched edition
//                                            knows about, with presence probed
//                                            and the exact install command
//   node jig.js admit --from <checks.json>   run every authored check against
//                                            its own fixture pair and against
//                                            every other check's near miss;
//                                            writes .jig/discarded.json
//   node jig.js plan --from <file>|-         the authored checks, or a draft
//                                            plan; writes .jig/plan-<id>.json
//   node jig.js plan --select <classId,…>    generate that draft from the
//                                            editions instead of reading one
//   node jig.js apply --change <id> --path <rel> [--change … --path …] | --plan <id>
//                                            applies ONLY what is named here —
//                                            the id says what and the path says
//                                            where, and both halves are the
//                                            approval boundary. `--plan` names
//                                            no path, so it carries the batch
//                                            tier only and refuses any change
//                                            that can refuse a call or fail a
//                                            build
//   node jig.js status [--root <path>]       replay the journal and print state;
//                                            writes nothing, ever
//   node jig.js revert --change <id> | --tx <id> | --all [--force]
//                                            restore journalled pre-images
//   node jig.js selftest [--live]            probe every installed guard, the
//        [--toolchain <ids>]                 check driver and the commit lane
//                                            with a synthetic violation and show
//                                            the catch; --live actually runs
//                                            them, and --toolchain names the
//                                            installed tools it may spawn
//   node jig.js migrate [--accept-drops]     rewrite a 1.0.1 install into the
//                                            shape this engine reads, as one
//                                            journalled transaction. It refuses
//                                            outright when a guard cannot be
//                                            carried forward, naming each one;
//                                            --accept-drops is how the owner
//                                            says they read that list
//
// Two flags matter on a project that does not exist yet, where detection has
// nothing on disk to read: `--edition <id>` names the language, and
// `--package-manager <name>` names the manager. Both are accepted by `scan`,
// `toolchain` and `plan`. `--edition` is also the permission to write the
// starter project file — jig scaffolds one only for an edition somebody NAMED,
// never for one detection merely matched, because a `pyproject.toml` makes a
// Python repository match the rust edition too.
//
// Every command prints one JSON object to stdout and exits 0 on success, 1 on
// an expected refusal (with the reason on stderr).
//
// The transaction concepts are borrowed from a sibling in this marketplace and
// rewritten fresh here: sha256 pre-image fingerprints with stale refusal,
// path-escape guards, an append-only journal, per-change apply and revert.
// There is deliberately no runtime dependency on anything — jig must work in a
// repository that carries no other plugin at all.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

// The three modules the catalogue reversal rests on. `editionsLib` reads the
// per-language catalogues, `admission` decides whether an authored check is
// real, `toolchainLib` proposes and runs the installs. None of them decides
// what may be installed — the fixture pair and the owner do.
const editionsLib = require("./editions.js");
const admission = require("./admission.js");
const toolchainLib = require("./toolchain.js");
// `sectionsLib` composes several tools' configuration into the one file they
// share, which is the only reason jig can harden a Python or a .NET project
// without the last tool applied erasing every earlier one.
const sectionsLib = require("./sections.js");
// The vocabulary the session hooks share with the engine. It lives in its own
// module so a hook can name a constant without requiring this file, which a
// hook spawn would otherwise parse in full on every tool call.
const {
  SCHEMA_VERSION, STATE_DIR, VERIFY_FILE, SHELL_TOOLS,
  isObject, stripBom, proposedVerifyEntries, fixturePath,
} = require("./vocab.js");

const PLUGIN_ROOT = path.dirname(__dirname);

// The one fix every surface offers for a dead commit lane, in the two forms an
// owner can actually run. Nothing puts jig on a PATH, so a report that handed
// out `jig plan --wire-commit` handed out a command that answers "command not
// found" — it is either the skill that offers it, or this script by its path.
const WIRE_COMMIT_FIX = "ask /jig:jig to wire the commit lane, or run: node " +
  toPosix(__filename) + " plan --wire-commit";

const JOURNAL_FILE = "journal.jsonl";
const PREIMAGE_DIR = "preimages";
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// The change kinds the engine can execute. `include-line` was reserved through
// the 0.1.0 line and is installable from 0.2.0: its one caller is git-hook
// activation, it only ever targets a committed hook file, and it always lands
// in the item consent tier — an edit to a file jig does not own is approved by
// name or not at all.
const CHANGE_KINDS = ["write-side-file", "write-config", "include-line", "write-settings", "write-rule", "write-agents-region", "run-install", "set-git-config"];
const INSTALLABLE_KINDS = ["write-side-file", "write-config", "include-line", "write-settings", "write-rule", "write-agents-region", "run-install", "set-git-config"];

// The one git setting jig may change, and the sentinel path the journal files
// it under. A setting has a pre-image the journal can hold — a value, or its
// absence — which is what separates it from every path under `.git/`, where a
// repository is not a file and the refusal in `targetProblem` still stands.
// Nothing here writes `.git/config`: `git config` does, and `git config` is
// also what puts the old value back.
const GIT_SETTING = "core.hooksPath";
const GIT_SETTING_PATH = "git:" + GIT_SETTING;

// The prose budget: the most always-loaded bytes one
// plan may add to the rule corpus. A default, stated as one — measured against
// nothing but the cost every session pays to carry prose. Every emitted rule
// must also carry its evidence label; both are refusals, not warnings.
const PROSE_BUDGET_BYTES = 2000;
const PROSE_EVIDENCE_MARK = "generated by jig";

// The jig-owned region inside AGENTS.md (0.5.0, the Codex column). Everything
// between the markers is jig's; everything outside is never touched. The size
// ceiling is the host's own loadability physics — a file past it stops being
// read, which would silently kill the user's OWN instructions too.
const AGENTS_BEGIN = "<!-- jig:begin — jig owns what sits between these markers -->";
const AGENTS_END = "<!-- jig:end -->";
const AGENTS_BUDGET_BYTES = 32768;

// The standing brief, in the one wording both harness channels carry. A Codex
// session reads AGENTS.md and a Claude Code session reads `.claude/rules/`, so
// jig has two hosts for the same sentences — and a brief that said two
// different things in the two files would be two coverage claims, one of them
// wrong. Both are computed from the same selection, and neither is written
// without approval.
// `ci` is the plan's own answer, not an assumption: `--no-ci` writes no workflow
// and gives no entry a `ci` lane, and always-loaded prose naming a lane the plan
// did not write is the coverage claim this document forbids.
function harnessBriefText(selection, ci) {
  return "jig guards this repository. Before calling any work done, run:\n\n" +
    "    node .jig/checks/run.mjs\n\n" +
    "It exits non-zero on: " + selection.join(", ") + ".\n" +
    (ci
      ? "CI runs that walk, then --selftest, then one --verify --lane ci step per\n" +
        "tool the install wired — the linter, the type checker, the test runner.\n"
      : "No CI workflow was installed, so nothing runs that walk for you.\n") +
    "The commit lane, where it is wired, reads the staged bytes instead.\n" +
    "Never delete or focus a test to make a suite pass — fix it, or skip it\n" +
    "visibly and say so. The coverage matrix is at .jig/plan.md.\n";
}

function agentsRegionText(selection, ci) {
  return AGENTS_BEGIN + "\n\n" + harnessBriefText(selection, ci) + "\n" + AGENTS_END + "\n";
}

// write-settings is additionally gated behind the permissions probe series
//: the capability exists only after a human has run
// scripts/probes/permissions.js against a pinned CLI and a green results.json
// sits beside it. Probes first, capability second — a missing or red record
// keeps the gate closed. JIG_PROBE_RESULTS points tests at a fixture.
function probeGreen() {
  const file = process.env.JIG_PROBE_RESULTS || path.join(__dirname, "probes", "results.json");
  try {
    const record = JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
    return record.green === true && typeof record.cliVersion === "string" && record.cliVersion.length > 0;
  } catch {
    return false;
  }
}

// The per-kind target allowlist — the second half of the path guard. Containment
// under the project root stops a write escaping the repository; this stops a
// write landing somewhere inside it that the kind has no business touching. A
// trailing "/" is a directory prefix, anything else is an exact path.
//
// `null` is the widened boundary (SCOPE, "What this reverses"): jig writes
// anywhere the owner approves BY NAME, which is why the two kinds that carry a
// linter config or a package install can land anywhere in the tree and why
// `apply` demands `--path` beside every `--change`. The kinds whose target is
// the whole point of the kind keep their narrow list.
const KIND_TARGETS = {
  "write-side-file": null,
  "write-config": [STATE_DIR + "/config.json"],
  "include-line": ["scripts/git-hooks/", ".husky/"],
  "write-settings": [".claude/settings.json"],
  "write-rule": [".claude/rules/"],
  "write-agents-region": ["AGENTS.md"],
  "run-install": null,
  // The narrowest list in the table: one sentinel, one setting.
  "set-git-config": [GIT_SETTING_PATH],
};

// The one directory no approval reaches. A write into `.git/` can rewrite
// history, re-point a ref or install a hook — none of which the journal could
// put back, because the pre-image of a repository is not a file.
const GIT_DIR = ".git/";

// Files the engine owns. A plan that could write these could rewrite the record
// of what it did — the journal holds the only copy of every pre-image, so this
// is the one denial that outranks any allowlist.
const ENGINE_OWNED = [STATE_DIR + "/" + JOURNAL_FILE, STATE_DIR + "/" + PREIMAGE_DIR + "/"];

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

// An expected failure: a refusal the user should read as a sentence, not a
// stack. Anything thrown without this marker is a bug and keeps its stack.
function expected(message) {
  const err = new Error(message);
  err.expected = true;
  return err;
}

function toPosix(rel) {
  return String(rel).replace(/\\/g, "/");
}

function hashBytes(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function statePath(root, ...parts) {
  return path.join(root, STATE_DIR, ...parts);
}

function readIfExists(full) {
  return fs.existsSync(full) ? fs.readFileSync(full) : null;
}

// ---------------------------------------------------------------------------
// Byte fidelity: EOL style and BOM
// ---------------------------------------------------------------------------
//
// jig generates its artifacts with LF and no BOM, because that is what a
// template looks like. A Windows repository does not, and a guardrail plugin
// that rewrites every line ending of the file it "just added a line to" would
// produce a diff nobody can review. So the style of the file being written is
// measured first and re-applied to the payload afterwards. Revert needs none of
// this — it restores the pre-image bytes verbatim, which is byte-identical by
// construction.

function hasBom(buf) {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

// The dominant line ending, not the first one: a file with three CRLF lines and
// one stray LF is a CRLF file, and normalising it to LF is the damage this
// exists to prevent. A file with no newline at all has no style to preserve.
function detectStyle(buf) {
  if (buf === null) return { bom: false, eol: "lf" };
  const text = buf.toString("utf8");
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return { bom: hasBom(buf), eol: crlf > lf ? "crlf" : "lf" };
}

function applyStyle(text, style) {
  let body = stripBom(String(text)).replace(/\r\n/g, "\n");
  if (style.eol === "crlf") body = body.replace(/\n/g, "\r\n");
  const bytes = Buffer.from(body, "utf8");
  return style.bom ? Buffer.concat([BOM, bytes]) : bytes;
}

// ---------------------------------------------------------------------------
// The path guard
// ---------------------------------------------------------------------------

// Lexical containment. A draft plan is JSON somebody assembled; an absolute path
// or a `..` segment in it must never become a write outside the project.
function resolveInsideRoot(root, rel) {
  if (typeof rel !== "string" || !rel.trim() || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

// The write-time half. A plan artifact on disk may have been edited since it was
// written, so every actual write re-checks its destination — lexically first,
// then through the real path of the nearest existing ancestor, because a
// symlinked or junctioned directory inside the project that points outside IS
// outside and a prefix check cannot see that.
function resolveWritePath(root, rel) {
  const lexical = resolveInsideRoot(root, typeof rel === "string" ? rel : "");
  if (!lexical) return null;
  let probe = path.dirname(lexical);
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  let realBase, realRoot;
  try {
    realBase = fs.realpathSync(probe);
    realRoot = fs.realpathSync(path.resolve(root));
  } catch {
    return null; // a boundary that cannot be resolved is not one to write past
  }
  const from = path.relative(realRoot, realBase);
  return from === "" || (!from.startsWith("..") && !path.isAbsolute(from)) ? lexical : null;
}

function matchesTarget(rel, target) {
  const p = toPosix(rel);
  return target.endsWith("/") ? p.startsWith(target) : p === target;
}

function isEngineOwned(rel) {
  const p = toPosix(rel);
  return ENGINE_OWNED.some((t) => matchesTarget(p, t)) || /^\.jig\/plan-[0-9a-f]+\.json$/.test(p);
}

// The whole write boundary in one answer, so no caller can check half of it.
// Returns null when the path is writable for that kind, otherwise the reason.
function targetProblem(root, kind, rel) {
  if (typeof rel !== "string" || !rel.trim()) return "the change has no path";
  // First, and for every kind including the git-setting one: no path under
  // `.git/` is writable, whatever it was approved for.
  if (matchesTarget(rel, GIT_DIR)) {
    return rel + " is inside .git/ — jig never writes there, whatever it was approved for. A repository is not a" +
      " file the journal can put back.";
  }
  // Then the one target that is not a path at all. A setting has a pre-image
  // the journal can hold, so it is reachable where a file under `.git/` is not
  // — but only through its own kind, and only for the one key. Everything below
  // this line is about files.
  if (kind === "set-git-config" || rel === GIT_SETTING_PATH) {
    if (kind !== "set-git-config") return rel + " is a git setting — only set-git-config may name it";
    return rel === GIT_SETTING_PATH ? null
      : rel + " — set-git-config only ever names " + GIT_SETTING_PATH;
  }
  if (!resolveInsideRoot(root, rel)) return rel + " escapes the project root";
  if (isEngineOwned(rel)) return rel + " belongs to the engine — a change may not rewrite the transaction record";
  if (!Object.prototype.hasOwnProperty.call(KIND_TARGETS, kind)) {
    return rel + " — " + JSON.stringify(kind) + " is not a change kind this engine writes";
  }
  const targets = KIND_TARGETS[kind];
  if (targets && !targets.some((t) => matchesTarget(rel, t))) {
    return rel + " is outside what " + kind + " may write (" + targets.join(", ") + ")";
  }
  // A jig rule is recognisable as jig's forever: the name is the namespace,
  // and a write-rule that could shadow a user's own rule file is refused.
  if (kind === "write-rule" && !/^jig-[a-z0-9-]+\.md$/.test(path.basename(toPosix(rel)))) {
    return rel + " — a write-rule target must be named .claude/rules/jig-<slug>.md";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The validator registry
// ---------------------------------------------------------------------------
//
// Keyed by format, each entry declaring HOW the claim is checked: `parse` reads
// the artifact back with the same parser the host uses, `exec` runs a real tool
// over it, `none` means jig cannot verify this format at all. D17 as an engine
// invariant: `verifyBy: "none"` auto-stamps ENFORCEMENT GAP, so an unverifiable
// artifact can never be reported as a guarantee.

const VALIDATORS = {
  json: {
    verifyBy: "parse",
    verify(full) {
      try {
        JSON.parse(stripBom(fs.readFileSync(full, "utf8")));
        return null;
      } catch (err) {
        return "is not valid JSON: " + err.message;
      }
    },
  },
  jsonl: {
    verifyBy: "parse",
    verify(full) {
      const lines = stripBom(fs.readFileSync(full, "utf8")).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          JSON.parse(lines[i]);
        } catch (err) {
          return "line " + (i + 1) + " is not valid JSON: " + err.message;
        }
      }
      return null;
    },
  },
  js: {
    verifyBy: "exec",
    verify(full) {
      // `node --check` with the node already running this process — never a
      // downloaded tool. A syntax error in a generated check driver or in a
      // host file jig just edited is exactly amendment 1's lesson, and it is
      // cheap to catch here instead of at the user's next commit.
      const run = spawnSync(process.execPath, ["--check", full], { encoding: "utf8", windowsHide: true });
      if (run.error) return "could not be syntax-checked (" + run.error.message + ")";
      if (run.status !== 0) return "is not valid JavaScript: " + String(run.stderr || "").split("\n")[0].trim();
      return null;
    },
  },
};

const FORMAT_BY_EXT = { ".json": "json", ".jsonl": "jsonl", ".js": "js", ".mjs": "js", ".cjs": "js" };

// Extension first, then the shebang. slag's own pre-commit hook is an
// extensionless `#!/usr/bin/env node` file — treating it as unverifiable text
// is how a shell-syntax include line becomes a SyntaxError that blocks every
// commit in the repository.
function formatOf(root, rel) {
  const byExt = FORMAT_BY_EXT[path.extname(toPosix(rel)).toLowerCase()];
  if (byExt) return byExt;
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return null;
  const head = fs.readFileSync(full).slice(0, 200).toString("utf8");
  return /^#!.*\bnode\b/.test(head) ? "js" : null;
}

function verifyByFor(format) {
  return format && VALIDATORS[format] ? VALIDATORS[format].verifyBy : "none";
}

// Read the artifact back the way the host will. Returns {verifyBy, gap,
// problem} — `gap: true` is the ENFORCEMENT GAP stamp, never an error.
function verifyWritten(root, rel) {
  const format = formatOf(root, rel);
  const verifyBy = verifyByFor(format);
  if (verifyBy === "none") return { verifyBy, gap: true, problem: null };
  const problem = VALIDATORS[format].verify(path.join(root, rel));
  return { verifyBy, gap: false, problem: problem === null ? null : rel + " " + problem };
}

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------
//
// Append-only, one JSON object per line, never rewritten. The pre-image BYTES
// live beside it in `.jig/preimages/<sha256>` rather than inside the row, so a
// row stays small and a binary-ish file stays byte-exact. Together they are the
// only copy of the project as it was before jig touched it — which is why both
// are machine-local and git-ignored, and why nothing here ever renders a
// pre-image into a report.

function ensureStateDir(root) {
  const dir = statePath(root);
  fs.mkdirSync(dir, { recursive: true });
  // Written by us, because the journal and the pre-images carry verbatim
  // contents of files the user never meant to commit, and everything else named
  // here is derived or per-machine. A stale committed plan is what mints the
  // "defined by 2 plans" refusal. Missing lines are APPENDED to a list that
  // already exists: jig extends an ignore file, it never rewrites or narrows one.
  const ignore = path.join(dir, ".gitignore");
  const want = [JOURNAL_FILE, PREIMAGE_DIR + "/", "ledger.jsonl", "profile.json", "off", "lane.log",
    "plan.md", "plan.json", "plan-*.json", "backlog.json", "discarded.json", "authored.json",
    // Where a `selftest --toolchain` run plants its seed. The directory is
    // removed the moment the tool has answered; the line is here for the run
    // that was killed between the two journal rows.
    "selftest/"];
  const had = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
  const present = had.split(/\r?\n/).map((line) => line.trim());
  // A line the owner explicitly UN-ignored is an answer they gave, and the last
  // matching pattern wins in git — so appending `plan.json` under their
  // `!plan.json` would quietly reverse it. Already there, or already negated,
  // is already answered.
  const missing = want.filter((line) => !present.includes(line) && !present.includes("!" + line));
  if (missing.length) {
    fs.appendFileSync(ignore, (had === "" || had.endsWith("\n") ? "" : "\n") + missing.join("\n") + "\n");
  }
  return dir;
}

function storePreImage(root, buf) {
  if (buf === null) return null;
  const sha = hashBytes(buf);
  const dir = statePath(root, PREIMAGE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sha);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return sha;
}

function loadPreImage(root, sha) {
  const file = statePath(root, PREIMAGE_DIR, sha);
  if (!fs.existsSync(file)) {
    throw expected("The pre-image " + sha.slice(0, 12) + " is missing from " + STATE_DIR + "/" + PREIMAGE_DIR +
      "/. It holds the only copy of that file as it was — nothing was restored.");
  }
  const buf = fs.readFileSync(file);
  if (hashBytes(buf) !== sha) {
    throw expected("The pre-image " + sha.slice(0, 12) + " does not match its own fingerprint — it was edited or" +
      " truncated. Nothing was restored.");
  }
  return buf;
}

function appendJournal(root, row) {
  ensureStateDir(root);
  fs.appendFileSync(statePath(root, JOURNAL_FILE), JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
}

function readJournal(root) {
  const file = statePath(root, JOURNAL_FILE);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const last = lines.reduce((n, line, i) => (line.trim() ? i : n), -1);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      rows.push(JSON.parse(lines[i]));
    } catch (err) {
      // A torn LAST line is an interrupted append — the write died mid-row and
      // there is nothing after it to lose. A torn line with rows behind it is
      // damage, and skipping it would silently drop a pre-image reference.
      if (i === last) continue;
      throw expected(STATE_DIR + "/" + JOURNAL_FILE + " is damaged: line " + (i + 1) + " of " + (last + 1) +
        " is not valid JSON (" + err.message + ")." +
        "\n  Only a torn final line is an interrupted append. An earlier one means the journal was edited or" +
        " truncated, and it points at the only copy of the files as they were — repair or remove that line" +
        " before running a transaction command again.");
    }
  }
  return rows;
}

// State is a replay, never a field anyone updates. Keyed by change and path, so
// two writes to one file from different changes stay independent things to undo.
function replayJournal(rows) {
  const changes = new Map();
  let order = 0;
  for (const row of rows) {
    if (!row.change) continue;
    let c = changes.get(row.change);
    if (!c) {
      c = { id: row.change, tx: row.tx, plan: row.plan, writes: new Map(), rejected: false };
      changes.set(row.change, c);
    }
    c.tx = row.tx || c.tx;
    c.plan = row.plan || c.plan;
    if (row.event === "intent") {
      c.writes.set(row.path, {
        path: row.path, kind: row.kind, preImage: row.preImage === undefined ? null : row.preImage,
        // An install's way back out, carried on the row that recorded the way
        // in — restoring a manifest is not the same as telling the ecosystem
        // about it, and the second half is the owner's to run.
        reconcile: row.reconcile || null,
        written: false, restored: false, hashAfter: null, gap: false, order: ++order,
      });
    } else if (row.event === "outcome") {
      const w = c.writes.get(row.path);
      if (w) { w.written = true; w.restored = false; w.hashAfter = row.hashAfter; w.gap = !!row.gap; w.order = ++order; }
    } else if (row.event === "restore") {
      const w = c.writes.get(row.path);
      if (w) { w.written = false; w.restored = true; w.order = ++order; }
    } else if (row.event === "reject") {
      c.rejected = true;
    }
  }
  return changes;
}

function changeState(c) {
  const writes = [...c.writes.values()];
  if (!writes.length) return "empty";
  if (writes.every((w) => w.restored)) return "reverted";
  // Refused before a byte landed: the command never ran and never will under
  // this id, so the change is finished. `interrupted` kept it in `status`'s
  // open list for ever, and nothing — not even `revert --all` — could take it
  // out, because there was no write to restore.
  if (c.rejected && writes.every((w) => !w.written)) return "refused";
  if (writes.some((w) => !w.written && !w.restored)) return "interrupted";
  return "applied";
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

// Returns the sentence refusing a write-config change that would leave the
// repository with no guards at all, or null when it would not. Reads the file on
// disk rather than anything the caller says about it: the whole point is that
// the caller believed the empty config was fine.
function emptiesConfig(root, rel, content) {
  let proposed = null;
  try {
    proposed = JSON.parse(stripBom(content));
  } catch {
    return null; // Not this gate's job — validateConfig says what a broken config is.
  }
  if (!isObject(proposed) || (Array.isArray(proposed.guards) && proposed.guards.length)) return null;
  const raw = readIfExists(path.join(root, rel));
  if (raw === null) return null;
  let installed = null;
  try {
    installed = JSON.parse(stripBom(raw.toString("utf8")));
  } catch {
    return null;
  }
  const guards = isObject(installed) && Array.isArray(installed.guards) ? installed.guards : [];
  if (!guards.length) return null;
  return "this would replace " + rel + "'s " + guards.length + " guard" + (guards.length === 1 ? "" : "s") +
    " (" + guards.map((g) => (g && g.id) || "?").join(", ") + ") with none, which disarms this repository." +
    " jig does not propose that — use `revert` to take the install back out.";
}

// Draft → canonical plan. Everything mechanical is computed here rather than
// trusted from the draft: the fingerprint, the file's EOL/BOM style, the
// format, and how that format gets verified. A draft that states any of them is
// ignored on those fields — a plan the caller could dictate is not a boundary.
function planFromDraft(draft, root) {
  const problems = [];
  if (!isObject(draft)) return { problems: ["the draft is not a JSON object"] };
  // An EMPTY array is a plan that writes nothing, which is what a selection
  // whose every slot is occupied now produces: the gap is disclosed on the
  // review surface rather than thrown away with the plan (SCOPE — an occupied
  // slot is a disclosed gap, not a refusal).
  if (!Array.isArray(draft.changes)) return { problems: ["the draft has no `changes` array"] };

  const changes = [];
  const seen = new Set();
  for (const raw of draft.changes) {
    if (!isObject(raw)) { problems.push("a change is not an object"); continue; }
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const label = "change " + (id || "?");
    if (!id) { problems.push("a change is missing a string id"); continue; }
    if (seen.has(id)) { problems.push("duplicate change id: " + id); continue; }
    seen.add(id);

    if (!CHANGE_KINDS.includes(raw.kind)) {
      problems.push(label + ": unknown kind " + JSON.stringify(raw.kind) + " (known: " + CHANGE_KINDS.join(", ") + ")");
      continue;
    }
    if (!INSTALLABLE_KINDS.includes(raw.kind)) {
      problems.push(label + ": the kind " + raw.kind + " is implemented but not installable in this release");
      continue;
    }
    if (raw.kind === "write-settings" && !probeGreen()) {
      problems.push(label + ": jig does not write permission rules into your settings. They stay a" +
        " printed proposal you apply yourself, which is the only shipped behaviour." +
        " (Maintainers: the capability unlocks behind scripts/probes/permissions.js.)");
      continue;
    }
    const rel = toPosix(typeof raw.path === "string" ? raw.path.trim() : "");
    const badTarget = targetProblem(root, raw.kind, rel);
    if (badTarget) { problems.push(label + ": " + badTarget); continue; }
    // An include-line change carries the line and its marker instead of whole
    // file content — the final bytes are woven from the host file at apply
    // time, because the host may legitimately change between plan and apply.
    if (raw.kind === "include-line") {
      if (typeof raw.line !== "string" || !raw.line.trim()) {
        problems.push(label + ": an include-line change needs a `line` string"); continue;
      }
      if (typeof raw.marker !== "string" || !raw.marker.trim()) {
        problems.push(label + ": an include-line change needs a `marker` string the line contains"); continue;
      }
      if (!raw.line.includes(raw.marker)) {
        problems.push(label + ": the marker must appear in the line itself, or idempotency has nothing to key on");
        continue;
      }
    } else if (raw.kind === "run-install") {
      // The item is carried whole, exactly as proposeInstalls froze it, because
      // apply re-states its `command` back as the approval and a command
      // assembled at apply time would not be the command anybody read.
      const item = raw.install;
      if (!isObject(item) || typeof item.id !== "string" || typeof item.command !== "string" ||
        !Array.isArray(item.argv) || !item.argv.length) {
        problems.push(label + ": a run-install change needs the frozen `install` item from proposeInstalls");
        continue;
      }
    } else if (raw.kind === "set-git-config") {
      // The value is the whole change, so it is the whole validation. A relative
      // directory is the only shape jig ever proposes — an absolute one would
      // point every clone of the repository at one machine's disk.
      if (typeof raw.value !== "string" || !raw.value.trim()) {
        problems.push(label + ": a set-git-config change needs a `value` string"); continue;
      }
      if (path.isAbsolute(raw.value) || raw.value.includes("..")) {
        problems.push(label + ": " + GIT_SETTING + " must be a relative path inside the project — " +
          JSON.stringify(raw.value) + " is not"); continue;
      }
    } else if (typeof raw.content !== "string") {
      problems.push(label + ": " + rel + " has no `content` string"); continue;
    }

    // The last line of defence under the config face. Whatever computed it —
    // a plan, a retirement, a hand-written draft — a config holding no guards
    // proposed over one that holds some is a repository being disarmed, and
    // that is never a change jig offers. Taking the guards out wholesale is
    // `revert`, which puts the install back the way it was found.
    if (raw.kind === "write-config") {
      const dropped = emptiesConfig(root, rel, raw.content);
      if (dropped) { problems.push(label + ": " + dropped); continue; }
    }

    // A git setting has no file behind it, so every fact computed from one is
    // computed from nothing: no bytes to style, no format to verify by. It gets
    // its own row rather than a file row full of nulls that read like a gap.
    const setting = raw.kind === "set-git-config";
    const full = path.join(root, rel);
    const current = setting ? null : readIfExists(full);
    const style = detectStyle(current);
    const format = setting ? null : (formatOf(root, rel) || FORMAT_BY_EXT[path.extname(rel).toLowerCase()] || null);
    const verifyBy = setting ? "git-config" : verifyByFor(format);
    changes.push({
      id,
      kind: raw.kind,
      path: rel,
      // The staleness basis. `null` means "this change creates the file", and
      // the file existing at apply time is then itself the staleness.
      sourceHash: current === null ? null : hashBytes(current),
      eol: style.eol,
      bom: style.bom,
      format,
      verifyBy,
      // D17: an artifact jig cannot read back is a gap, stamped at plan time so
      // the matrix can render it before anybody approves anything.
      enforcementGap: verifyBy === "none",
      content: raw.kind === "include-line" ? raw.line
        : raw.kind === "run-install" ? ""
          : setting ? raw.value : raw.content,
      // The value the setting is being moved to, carried beside `content` so a
      // reader of the plan and a reader of the manifest see the same word for
      // it that `git config` will.
      value: setting ? raw.value : undefined,
      // The install item and the fixture-pair proof ride the plan untouched.
      // The proof is what the manifest records, so a hand-edited config cannot
      // claim a proof it does not have (SCOPE, "What binds a proof").
      install: raw.kind === "run-install" ? raw.install : undefined,
      // The rest of a config-only tool item. A tool the owner installed by hand
      // still has a wiring line and a CI step; dropping them here is what made
      // the manual-install follow-up hand back bare config.
      tool: typeof raw.tool === "string" ? raw.tool : undefined,
      wiring: typeof raw.wiring === "string" ? raw.wiring : undefined,
      ciStep: typeof raw.ciStep === "string" ? raw.ciStep : undefined,
      proof: /^[0-9a-f]{64}$/.test(String(raw.proof)) ? raw.proof : undefined,
      marker: raw.kind === "include-line" ? raw.marker : undefined,
      anchor: raw.kind === "include-line" && typeof raw.anchor === "string" ? raw.anchor : undefined,
      line: raw.kind === "include-line" ? raw.line : undefined,
      rationale: typeof raw.rationale === "string" ? raw.rationale.trim() : "",
      // The manifest's half of the row, carried rather than computed, because
      // only the caller knows which classes an artifact is for and where its
      // bytes came from. Absent on a hand-written draft, which is what keeps a
      // hand-written draft out of the manifest.
      classIds: Array.isArray(raw.classIds) ? raw.classIds.filter((s) => typeof s === "string") : [],
      ownership: OWNERSHIPS.includes(raw.ownership) ? raw.ownership : "file",
      provenance: PROVENANCES.includes(raw.provenance) ? raw.provenance : "assumed",
      template: isObject(raw.template) && typeof raw.template.name === "string"
        ? { name: raw.template.name, version: String(raw.template.version) }
        : null,
    });
  }
  // The prose gates (0.4.0): every emitted rule carries its evidence label,
  // and one plan may not add more always-loaded bytes than the budget. Both
  // refuse the whole draft — silently trimming prose would install a corpus
  // nobody reviewed.
  const proseChanges = changes.filter((c) => c.kind === "write-rule");
  for (const c of proseChanges) {
    if (!c.content.includes(PROSE_EVIDENCE_MARK)) {
      problems.push("change " + c.id + ": an emitted rule must carry its evidence label (\"" +
        PROSE_EVIDENCE_MARK + " …\") — unlabeled prose is folklore");
    }
  }
  const proseBytes = proseChanges.reduce((n, c) => n + Buffer.byteLength(c.content, "utf8"), 0);
  if (proseBytes > PROSE_BUDGET_BYTES) {
    problems.push("this plan adds " + proseBytes + " bytes of always-loaded prose and the budget is " +
      PROSE_BUDGET_BYTES + " — drop a rule rather than paying it; every session carries what you emit here");
  }
  if (problems.length) return { problems };

  // Files first, installs after, and id order inside each group so the same
  // draft always plans to the same list. The rank is not cosmetic: a package
  // manager needs the project file to exist before it has anywhere to record a
  // dependency, and on a project jig is scaffolding that file is one of these
  // changes rather than something that was already on disk.
  //
  // Inside the installs the KIND decides, not the id. A scaffold command writes
  // the files the rest then run: ordering `checkstyle` before `gradle` put
  // `./gradlew checkstyleMain` ahead of the `gradle wrapper` that creates
  // `gradlew`, so the first install of a greenfield JVM project ran a script
  // that did not exist yet. An installKind no edition states sorts last, where
  // it can depend on everything and nothing depends on it.
  const INSTALL_ORDER = ["scaffold", "package", "builtin", "audit"];
  const rank = (c) => {
    if (c.kind !== "run-install") return 0;
    const at = INSTALL_ORDER.indexOf(c.install && c.install.installKind);
    return 1 + (at < 0 ? INSTALL_ORDER.length : at);
  };
  changes.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // A content hash, not a clock: the same draft over the same tree plans to the
  // same id, so a re-run is recognisable as the same plan.
  const planId = hashBytes(Buffer.from(JSON.stringify(changes), "utf8")).slice(0, 12);
  return { problems: [], payload: { schemaVersion: SCHEMA_VERSION, planId, changes } };
}

function planFiles(root) {
  const dir = statePath(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^plan-[0-9a-f]+\.json$/.test(f)).sort().map((f) => path.join(dir, f));
}

function readPlan(file) {
  let record;
  try {
    record = JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  } catch (err) {
    throw expected(path.basename(file) + " is not readable JSON (" + err.message + ")");
  }
  if (!isObject(record) || !Array.isArray(record.changes)) throw expected(path.basename(file) + " is not a plan");
  if (record.schemaVersion > SCHEMA_VERSION) {
    throw expected(path.basename(file) + " is schemaVersion " + record.schemaVersion + " and this engine reads " +
      SCHEMA_VERSION + ". Upgrade jig rather than applying a plan it cannot fully read.");
  }
  return record;
}

// A change id resolves against every plan artifact in `.jig/`. Two plans
// defining the same id is a refusal, not a guess: the CLI argument is the
// approval boundary, so it has to mean exactly one thing.
function findChange(root, changeId) {
  const hits = [];
  for (const file of planFiles(root)) {
    const record = readPlan(file);
    const change = record.changes.find((c) => c.id === changeId);
    if (change) hits.push({ plan: record, change });
  }
  if (!hits.length) throw expected("no plan in " + STATE_DIR + "/ defines change " + changeId);
  if (hits.length > 1) {
    // A second interview in the same repository writes a second plan file, and
    // an artifact id is derived from its template rather than from the plan —
    // so every unchanged artifact is defined twice and a re-run could not be
    // applied at all. The tie is broken by the plan the owner was handed the
    // token from: `plan.json` is the reviewed plan, rewritten by the same
    // command that printed the id. It is not "the newest wins" — with no
    // reviewed plan on disk, or with the id in none of it, the id still means
    // more than one thing and stays a refusal.
    const reviewed = reviewedPlanId(root);
    const one = hits.filter((h) => h.plan.planId === reviewed);
    if (one.length !== 1) {
      throw expected("change " + changeId + " is defined by " + hits.length + " plans — the id has to name one change");
    }
    return one[0];
  }
  return hits[0];
}

// The planId of the plan `.jig/plan.json` last reviewed, or null when there is
// none to read. Null and unreadable are the same answer: no tie to break.
function reviewedPlanId(root) {
  const raw = readIfExists(path.join(root, STATE_DIR, PLAN_JSON_FILE));
  if (raw === null) return null;
  try {
    const record = JSON.parse(stripBom(raw.toString("utf8")));
    return isObject(record) && typeof record.planId === "string" ? record.planId : null;
  } catch {
    return null;
  }
}

function findPlan(root, planId) {
  for (const file of planFiles(root)) {
    const record = readPlan(file);
    if (record.planId === planId) return record;
  }
  throw expected("no plan in " + STATE_DIR + "/ has the id " + planId);
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

// The bytes this change intends to leave on disk, in the target's own style.
function intendedBytes(change) {
  return applyStyle(change.content, { eol: change.eol, bom: change.bom });
}

// The include-line mechanism, reached by `plan --weave-precommit` against a
// pre-commit hook the repository committed. Three refusals, in the order that
// matters: the marker is already there (a no-op, not an error), the anchor
// drifted (the host file is not the one that was planned against), the anchor
// is ambiguous.
function includeLineText(hostText, change) {
  const marker = String(change.marker || "");
  const anchor = String(change.anchor || "");
  const line = String(change.line || "");
  if (!marker || !line) return { problem: "an include-line change needs a marker and a line" };
  if (hostText.includes(marker)) return { noop: "the marker is already present" };
  if (!anchor) return { text: hostText.replace(/\n?$/, "\n") + line + "\n" };
  const first = hostText.indexOf(anchor);
  if (first === -1) return { problem: "the anchor is not in the host file — it drifted since the plan" };
  if (hostText.indexOf(anchor, first + anchor.length) !== -1) {
    return { problem: "the anchor occurs more than once — extend it until it matches one place" };
  }
  const cut = first + anchor.length;
  return { text: hostText.slice(0, cut) + "\n" + line + hostText.slice(cut) };
}

// The crash-ordering rule, in one place: intent BEFORE the write, outcome
// AFTER it. The journal may therefore claim a pre-image for a write that never
// happened — restoring that is a harmless no-op — but can never hold a write
// whose pre-image was not recorded first, which would be unrecoverable.
function journalledWrite(root, ctx, change, bytes) {
  const full = resolveWritePath(root, change.path);
  if (!full) {
    throw expected("Refusing to write " + change.path + " for change " + change.id +
      ": the path resolves outside the project root. The plan was edited after it was written, or a directory on" +
      " the path is a link that leaves the project. Nothing was written.");
  }
  const preImage = readIfExists(full);
  appendJournal(root, {
    event: "intent", tx: ctx.tx, plan: ctx.plan, change: change.id, kind: change.kind, path: change.path,
    preImage: storePreImage(root, preImage),
    hashBefore: preImage === null ? null : hashBytes(preImage),
  });
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
  // Git will not run a hook it cannot execute, and a shim written 0644 is a
  // commit lane that reports live and does nothing. The bit is set here rather
  // than left to the owner because jig wrote the file. win32 has no exec bit;
  // the chmod is a no-op there and the lane report says so instead of guessing.
  if (change.path.startsWith(STATE_DIR + "/hooks/")) {
    try { fs.chmodSync(full, 0o755); } catch { /* fail open: an unset bit is reported, never fatal */ }
  }
  const check = verifyWritten(root, change.path);
  appendJournal(root, {
    event: "outcome", tx: ctx.tx, plan: ctx.plan, change: change.id, path: change.path,
    hashAfter: hashBytes(bytes), verifyBy: check.verifyBy, gap: check.gap,
  });
  return check;
}

// Put one journalled write back the way it was. A null pre-image means the
// write created the file, so undoing it removes the file — and the directories
// the write had to create, or a reverted install leaves empty folders behind.
function restoreWrite(root, ctx, changeId, write, cause) {
  // The setting's way back. A null pre-image means jig created the setting, so
  // undoing it unsets the key — the same rule the file branch below follows,
  // through `git config` instead of the file writer.
  if (write.path === GIT_SETTING_PATH) {
    const back = write.preImage === null ? null : loadPreImage(root, write.preImage).toString("utf8");
    const argv = back === null ? ["config", "--unset", GIT_SETTING] : ["config", GIT_SETTING, back];
    const r = spawnSync("git", argv, { cwd: root, encoding: "utf-8", windowsHide: true });
    // `--unset` exits 5 when the key is already gone, which is the state revert
    // was asking for. Every other non-zero exit left the setting where it was.
    if (r.error || (r.status !== 0 && !(back === null && r.status === 5))) {
      throw expected("Refusing to report " + GIT_SETTING + " restored for change " + changeId +
        ": `git " + argv.join(" ") + "` " + (r.error ? r.error.message : "exited " + r.status) +
        ". The setting is unchanged.");
    }
    appendJournal(root, {
      event: "restore", tx: ctx.tx, plan: ctx.plan, change: changeId, path: write.path, cause,
      hashAfter: write.preImage, setting: GIT_SETTING, valueAfter: back,
    });
    return;
  }
  const full = resolveWritePath(root, write.path);
  if (!full) {
    throw expected("Refusing to restore " + write.path + " for change " + changeId +
      ": the path resolves outside the project root. Nothing was restored for it.");
  }
  if (write.preImage === null) {
    fs.rmSync(full, { force: true });
    for (let dir = path.dirname(full); dir.startsWith(path.resolve(root) + path.sep); dir = path.dirname(dir)) {
      if (!fs.existsSync(dir) || fs.readdirSync(dir).length) break;
      fs.rmdirSync(dir);
    }
  } else {
    const buf = loadPreImage(root, write.preImage);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
  }
  appendJournal(root, {
    event: "restore", tx: ctx.tx, plan: ctx.plan, change: changeId, path: write.path, cause,
    hashAfter: write.preImage,
  });
}

// Everything the ecosystem owns at the root of this project: the manifest the
// install edits and the lockfile it writes. They come from the edition's own
// marker files, so no table here names a language, and they are journalled even
// when they do not exist yet — a lockfile the install CREATES is a lockfile
// revert has to remove.
function installTouchPaths(root, change) {
  const rels = new Set([change.path]);
  const editionId = change.install && change.install.edition;
  if (editionId) {
    const row = editionsLib.loadIndex(PLUGIN_ROOT).editions.find((e) => e.id === editionId);
    const patterns = (row && row.detect && row.detect.files) || [];
    // A glob names files that are already on disk, so it is resolved against the
    // tree here, at intent time, exactly like a literal path. Skipping it left
    // the dotnet edition's `*.csproj` edits with no pre-image at all.
    const files = patterns.some((p) => p.includes("*")) ? editionsLib.walkFiles(root) : [];
    for (const p of patterns) {
      if (!p.includes("*")) rels.add(p);
      else for (const f of files) if (editionsLib.fileMatches(p, f.base)) rels.add(f.rel);
    }
  }
  return [...rels];
}

// Every path under the project root an install could create. The walk is
// detection's own, so it skips `.git`, `.jig` and the dependency stores —
// what a package manager puts in `node_modules/` or `target/` is undone by the
// reconcile command, not by deleting files one at a time.
function installSnapshot(root) {
  return new Set(editionsLib.walkFiles(root).map((f) => f.rel));
}

// The one change that runs a command instead of writing bytes — and it is
// journalled like a write anyway. The pre-images go down BEFORE the package
// manager starts, so an install that half-succeeded is still an install
// `revert` can put back, and the way out (SCOPE: never silently) rides the
// intent row as `reconcile`.
function applyInstall(root, ctx, change) {
  const item = change.install;
  const touched = installTouchPaths(root, change);
  for (const rel of touched) {
    if (targetProblem(root, change.kind, rel)) continue;
    const pre = readIfExists(path.join(root, rel));
    appendJournal(root, {
      event: "intent", tx: ctx.tx, plan: ctx.plan, change: change.id, kind: change.kind, path: rel,
      preImage: storePreImage(root, pre),
      hashBefore: pre === null ? null : hashBytes(pre),
      reconcile: item.uninstallCommand || null,
    });
  }

  const before = installSnapshot(root);

  // The approval is the item's own id and its command character for character.
  // Both come off the plan the owner read; nothing here re-assembles either.
  let run;
  try {
    run = toolchainLib.runInstall(root, item, { id: item.id, command: item.command });
  } catch (err) {
    // A refusal is the end of this change, not a pause in it. Without this row
    // the intents above stay unmatched for ever: `status` reported the change
    // `interrupted` — open work somebody still had to finish — and `revert`
    // could not clear it, because a write that never happened is not a write
    // revert restores.
    if (err.expected) {
      appendJournal(root, {
        event: "reject", tx: ctx.tx, plan: ctx.plan, change: change.id, path: change.path, cause: "install-refused",
      });
    }
    throw err;
  }

  // What the command created that nobody named: `gradle wrapper` writes
  // `gradlew`, `gradlew.bat` and `gradle/wrapper/*`, and without these rows
  // `revert` leaves every one of them behind. This is the one place the
  // crash-ordering rule cannot hold, and it costs nothing: a path that did not
  // exist before the command ran has no pre-image to lose, and `null` is the
  // only pre-image it could ever have had.
  //
  // Never off a truncated walk. The walk stops at its file cap wherever the
  // count ran out, so on a repository above it the two lists are cut in
  // different places and a file that was only ever missing from `before` would
  // be journalled as created — with a null pre-image, which is `revert`'s
  // instruction to DELETE somebody's file. So a capped walk claims nothing:
  // the repository is left where it was before 2.12.0, with the reconcile
  // command as its way out, rather than handed a revert that removes files the
  // install never touched.
  const afterWalk = installSnapshot(root);
  const capped = before.size >= editionsLib.WALK_MAX_FILES || afterWalk.size >= editionsLib.WALK_MAX_FILES;
  const created = [];
  for (const rel of capped ? [] : afterWalk) {
    if (before.has(rel) || touched.includes(rel)) continue;
    if (targetProblem(root, change.kind, rel)) continue;
    appendJournal(root, {
      event: "intent", tx: ctx.tx, plan: ctx.plan, change: change.id, kind: change.kind, path: rel,
      preImage: null, hashBefore: null, reconcile: item.uninstallCommand || null,
    });
    created.push(rel);
  }

  for (const rel of touched.concat(created)) {
    const after = readIfExists(path.join(root, rel));
    appendJournal(root, {
      event: "outcome", tx: ctx.tx, plan: ctx.plan, change: change.id, path: rel,
      hashAfter: after === null ? null : hashBytes(after), verifyBy: "exec", gap: false,
    });
  }

  if (run.timedOut || run.code !== 0) {
    appendJournal(root, { event: "reject", tx: ctx.tx, plan: ctx.plan, change: change.id, path: change.path, cause: "install-failed" });
    throw expected("The install for " + item.id + " " + (run.timedOut ? "timed out" : "exited " + run.code) + ":\n  " +
      item.command + "\n" + String(run.stderr || run.stdout || "").trim().split("\n").slice(-5).join("\n") +
      "\n  The manifest and lockfile pre-images are journalled — `revert --change " + change.id + "` puts them back.");
  }

  // The config rides the same change id as the install, because the owner
  // approved one tool and revert has to undo one tool (SCOPE, "Is install,
  // config and wiring one item or three").
  let config = null;
  if (typeof item.configBody === "string" && item.configPath) {
    const rel = toPosix(item.configPath);
    const problem = targetProblem(root, "write-side-file", rel);
    if (problem) throw expected("Refusing to write " + item.id + "'s config: " + problem);
    const style = detectStyle(readIfExists(path.join(root, rel)));
    const check = journalledWrite(root, ctx, { ...change, path: rel }, applyStyle(item.configBody, style));
    if (check.problem) throw expected("Change " + change.id + " installed " + item.id + " and its config did not read back: " + check.problem);
    config = rel;
  }

  return {
    change: change.id,
    path: change.path,
    outcome: "installed",
    tool: item.id,
    command: item.command,
    config,
    reconcile: item.uninstallCommand || null,
    enforcementGap: false,
  };
}

// The other change that runs a command instead of writing bytes — and the only
// one whose target is not a file at all. `git config` owns `.git/config`; jig
// owns the record of what the value was before it, and that record is the whole
// reason a setting is reachable where a path under `.git/` is not. The old
// value goes down BEFORE the new one goes in, on the same crash-ordering rule
// every write obeys.
function applyGitConfig(root, ctx, change) {
  const before = gitConfig(root, GIT_SETTING);
  const bytes = before === null ? null : Buffer.from(before, "utf8");
  appendJournal(root, {
    event: "intent", tx: ctx.tx, plan: ctx.plan, change: change.id, kind: change.kind, path: change.path,
    // A setting that was unset has no pre-image, exactly as a file that did not
    // exist has none. Revert reads both the same way: put nothing back, take
    // what jig put there back out.
    preImage: bytes === null ? null : storePreImage(root, bytes),
    hashBefore: bytes === null ? null : hashBytes(bytes),
    setting: GIT_SETTING,
    valueBefore: before,
  });

  const r = spawnSync("git", ["config", GIT_SETTING, change.value], { cwd: root, encoding: "utf-8", windowsHide: true });
  if (r.error || r.status !== 0) {
    appendJournal(root, {
      event: "reject", tx: ctx.tx, plan: ctx.plan, change: change.id, path: change.path, cause: "git-config-failed",
    });
    throw expected("Setting " + GIT_SETTING + " failed: `git config " + GIT_SETTING + " " + change.value + "` " +
      (r.error ? r.error.message : "exited " + r.status) + "\n  " +
      String(r.stderr || "").trim() + "\n  Nothing was changed.");
  }

  // Read it back through git rather than trusting the exit code, for the same
  // reason every written file is read back: the check is what makes the outcome
  // row a fact instead of an assumption.
  const after = gitConfig(root, GIT_SETTING);
  if (after !== change.value) {
    appendJournal(root, {
      event: "reject", tx: ctx.tx, plan: ctx.plan, change: change.id, path: change.path, cause: "git-config-not-read-back",
    });
    throw expected("Set " + GIT_SETTING + " to " + JSON.stringify(change.value) + " and git reads " +
      JSON.stringify(after) + " back. Another config file is overriding it. Nothing else was changed.");
  }
  appendJournal(root, {
    event: "outcome", tx: ctx.tx, plan: ctx.plan, change: change.id, path: change.path,
    hashAfter: hashBytes(Buffer.from(after, "utf8")), verifyBy: "git-config", gap: false,
  });

  return {
    change: change.id,
    path: change.path,
    outcome: "set",
    setting: GIT_SETTING,
    value: after,
    valueBefore: before,
    enforcementGap: false,
  };
}

function applyChange(root, ctx, change) {
  if (change.kind === "run-install") return applyInstall(root, ctx, change);
  if (change.kind === "set-git-config") return applyGitConfig(root, ctx, change);

  const full = path.join(root, change.path);
  const current = readIfExists(full);

  let bytes;
  if (change.kind === "write-agents-region") {
    // Replace jig's own region, or append it; never a byte outside the
    // markers. Creating the file is allowed — a repository with no AGENTS.md
    // gets one holding only jig's region — and the loadability ceiling is
    // checked on the WHOLE result, because a file past it stops being read
    // and that would silently kill the user's own instructions too.
    const host = current === null ? "" : stripBom(current.toString("utf8")).replace(/\r\n/g, "\n");
    const begin = host.indexOf(AGENTS_BEGIN);
    const end = host.indexOf(AGENTS_END);
    let next;
    if (begin !== -1 && end !== -1 && end > begin) {
      next = host.slice(0, begin) + change.content.replace(/\n$/, "") + host.slice(end + AGENTS_END.length);
    } else {
      next = host ? host.replace(/\n?$/, "\n\n") + change.content : change.content;
    }
    if (Buffer.byteLength(next, "utf8") > AGENTS_BUDGET_BYTES) {
      appendJournal(root, { event: "reject", tx: ctx.tx, plan: ctx.plan, change: change.id, path: change.path, cause: "size" });
      throw expected("Refusing to apply change " + change.id + ": AGENTS.md would be " +
        Buffer.byteLength(next, "utf8") + " bytes, past the " + AGENTS_BUDGET_BYTES +
        " loadability ceiling — a file that big stops being read at all.");
    }
    bytes = applyStyle(next, { eol: change.eol, bom: change.bom });
  } else if (change.kind === "include-line") {
    // Woven from the host as it is NOW — the marker is the idempotency check,
    // and the anchor refusals catch a host that drifted out from under the
    // plan. A missing host file is a refusal, never a create: include-line
    // exists to edit a file somebody else owns, and a file that is not there
    // is not theirs to have a line added to.
    if (current === null) {
      appendJournal(root, { event: "reject", tx: ctx.tx, plan: ctx.plan, change: change.id, path: change.path, cause: "missing-host" });
      throw expected("Refusing to apply change " + change.id + ": " + change.path + " does not exist, and an" +
        " include-line change never creates the file it edits.");
    }
    const host = stripBom(current.toString("utf8")).replace(/\r\n/g, "\n");
    const woven = includeLineText(host, change);
    if (woven.noop) {
      return { change: change.id, path: change.path, outcome: "already-applied", enforcementGap: change.enforcementGap };
    }
    if (woven.problem) {
      appendJournal(root, { event: "reject", tx: ctx.tx, plan: ctx.plan, change: change.id, path: change.path, cause: "anchor" });
      throw expected("Refusing to apply change " + change.id + ": " + woven.problem);
    }
    bytes = applyStyle(woven.text, { eol: change.eol, bom: change.bom });
  } else {
    bytes = intendedBytes(change);
  }

  // Idempotency before staleness, deliberately: a re-run of an already-applied
  // change reads as "stale" to a naive hash check, and refusing it would make
  // the safe thing (running apply again after an interruption) the scary thing.
  if (current !== null && hashBytes(current) === hashBytes(bytes)) {
    return { change: change.id, path: change.path, outcome: "already-applied", enforcementGap: change.enforcementGap };
  }

  // include-line is exempt from the hash check on purpose: weaving at apply
  // time exists precisely because the host may change between plan and apply,
  // and the marker plus the anchor refusals are its staleness semantics.
  const currentHash = current === null ? null : hashBytes(current);
  if (change.kind !== "include-line" && change.kind !== "write-agents-region" && currentHash !== change.sourceHash) {
    const was = change.sourceHash === null ? "did not exist when the plan was made" : "was fingerprinted at plan time";
    appendJournal(root, { event: "reject", tx: ctx.tx, plan: ctx.plan, change: change.id, path: change.path, cause: "stale" });
    throw expected("Refusing to apply change " + change.id + ": " + change.path + " has changed since it " + was +
      ". Re-plan against the file as it is now — jig never writes over an edit it did not see.");
  }

  const check = journalledWrite(root, ctx, change, bytes);
  if (check.problem) {
    // The artifact jig just wrote does not read back. Undo it before reporting,
    // so a failed apply never leaves a broken file behind.
    const state = replayJournal(readJournal(root)).get(change.id);
    const write = state && state.writes.get(change.path);
    if (write) restoreWrite(root, ctx, change.id, write, "post-write validation failed");
    appendJournal(root, { event: "reject", tx: ctx.tx, plan: ctx.plan, change: change.id, path: change.path, cause: "invalid" });
    throw expected("Change " + change.id + " was rolled back: " + check.problem);
  }
  return {
    change: change.id,
    path: change.path,
    outcome: "applied",
    verifyBy: check.verifyBy,
    enforcementGap: check.gap,
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
//
// Every byte jig installs comes from a file in `templates/`, copied out
// verbatim. Nothing is interpolated, so an installed artifact and the template
// it came from are the same text — which is what makes drift a hash comparison
// instead of a judgement call. The two artifacts that ARE computed (the config
// and the manifest) are computed from the catalogue and from the transaction,
// never from anything a person typed.
//
// The recorded hash is over the template's text with CRLF folded to LF, so a
// Windows checkout that rewrote the line endings still installs rather than
// refusing every artifact for a difference nobody made.

const TEMPLATE_DIR = path.join(__dirname, "templates");
const TEMPLATE_INDEX = path.join(TEMPLATE_DIR, "templates.json");

const CONFIG_FILE = "config.json";
const MANIFEST_FILE = "manifest.json";
const PERMISSIONS_FILE = "proposed-permissions.json";
const ACTIVATION_FILE = "activation.md";
// The one line that makes a committed pre-commit hook run the checks, per host.
// It lives in `catalogues/shared.json` so the wiring and the editions ship as
// one body of data rather than half data and half constant.
const ACTIVATION = require("../catalogues/shared.json").activation;

const OWNERSHIPS = ["file", "line", "schema"];
const PROVENANCES = ["elicited", "forensic", "assumed"];

// SCOPE reverses the v1 clamp: a check whose fixture pair passed is proven at
// install and blocks from install. Observe survives as a choice the owner makes
// — `plan --observe` — never as a probation every guard has to serve first.
const DEFAULT_INSTALL_MODE = "armed";

function installMode(opts) {
  return opts && (opts.observe === true || opts.observe === "true") ? "observe" : DEFAULT_INSTALL_MODE;
}

// The same closed set the runner enforces, declared again here rather than
// imported, because the runner reads this file and importing it back would be
// a cycle. A test asserts the two lists are identical, which is what keeps a
// second copy honest.
const HOOK_RUNNERS = ["PreToolUse", "PostToolUse"];

// The directories `run.mjs` never walks, and never reads staged either. Copied
// here for the same reason HOOK_RUNNERS is: the driver is a standalone template
// written into somebody else's repository and cannot import the engine. A test
// asserts the two lists are identical, which is what keeps a second copy honest.
const DRIVER_SKIPS = [
  ".git", ".jig", "node_modules", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".venv", "venv", "vendor", "target",
];

// The actors a coverage cell can be about. An engine list rather than an
// edition one: who is at the keyboard is not a fact about a language, and an
// edition that could add a column would be an edition deciding what jig
// reports.
const ACTORS = ["human-editor", "human-ci", "claude-session", "codex-session"];

// What each lever can promise, in the only two terms the matrix grades on:
// can a human or a CI runner run it with no agent host, and is it a pattern
// somebody has to read or a fact a machine decides. Also an engine list — the
// editions describe mistakes and tools, never jig's own delivery mechanics.
const LEVERS = {
  "check-driver": { hostNeutral: true, probabilistic: false, availableAt: "0.1.0-alpha" },
  "ci-workflow": { hostNeutral: true, probabilistic: false, availableAt: "0.1.0-alpha" },
  "tool-rule": { hostNeutral: true, probabilistic: false, availableAt: "0.3.0-alpha" },
  "bash-guard": { hostNeutral: false, probabilistic: false, availableAt: "0.1.0-alpha" },
  "edit-guard": { hostNeutral: false, probabilistic: false, availableAt: "0.5.0-alpha" },
  "edit-observe-guard": { hostNeutral: false, probabilistic: false, availableAt: "0.1.0-alpha" },
  "prose-rule": { hostNeutral: false, probabilistic: true, availableAt: "0.4.0-alpha" },
  "agents-region": { hostNeutral: false, probabilistic: true, availableAt: "0.5.0-alpha" },
};

// An authored detector names a lever and nothing else; this is what runs it.
// editions.adaptDetector answers the same question for an edition's detectors
// and speaks only for the levers an edition can carry, which is why an authored
// session guard — a lever no edition ships — is adapted here instead.
const AUTHORED_RUNNERS = {
  "check-driver": "checks",
  "ci-workflow": "ci",
  "tool-rule": "ci",
  "bash-guard": "PreToolUse",
  // The edit lever an authored check should reach for: it denies the edit
  // before the host writes the bytes. `edit-observe-guard` still runs — installs
  // made before 2.11.0 carry it and their proof hashes bind it — and `migrate`
  // is what moves one across, re-recording the proof per guard.
  "edit-guard": "PreToolUse",
  "edit-observe-guard": "PostToolUse",
};

function adaptAuthoredDetector(check, det, index) {
  const runner = AUTHORED_RUNNERS[det && det.lever];
  if (!runner) {
    throw expected("the authored check " + check.id + " names a lever `" + (det && det.lever) +
      "` this build does not run. It runs " + Object.keys(AUTHORED_RUNNERS).join(", ") + ".");
  }
  return { ...det, id: det.lever + "-" + index, runner };
}

// Which editions this project is. Resolved ONCE per plan and threaded through,
// because detection walks the tree and because a plan that asked twice could
// answer itself differently halfway. The scan already did the walk, so its
// profile is the first authority; `--edition` overrides both, for a project
// that does not exist on disk yet.
function resolveEditions(root, opts) {
  const explicit = typeof opts.edition === "string" && opts.edition.trim()
    ? opts.edition.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  let ids = explicit;
  if (!ids) {
    try {
      const { profile } = readProfile(root);
      if (Array.isArray(profile.editions) && profile.editions.length) ids = profile.editions;
    } catch {
      // No scan here yet. Detection is the same census the scan writes down,
      // so the answer is the same one — it just costs the walk again.
    }
  }
  if (!ids) {
    ids = editionsLib.detectEditions(root, editionsLib.loadIndex(PLUGIN_ROOT)).map((d) => d.id);
  }
  return ids.map((id) => editionsLib.loadEdition(PLUGIN_ROOT, id));
}

// A class as the rest of the engine wants it: a namespaced id, the edition it
// came from, and detectors carrying the runner that will execute them. The
// catalogue informs and never gates (SCOPE), so a miss here is not a refusal —
// it is a class the model authored and the fixture pair admitted.
function editionClassById(loaded, id) {
  for (const edition of loaded) {
    for (const cls of edition.classes || []) {
      if (editionsLib.namespacedId(edition.edition, cls.id) !== id) continue;
      return {
        ...cls,
        id,
        edition: edition.edition,
        // SCOPE, "Where does comment syntax live": the edition declares it per
        // extension, and the blanker reads it off the check. Carried here so a
        // class proves and runs against its own language's comment rules rather
        // than the driver's fallback table.
        commentSyntax: (edition.detect && edition.detect.commentSyntax) || null,
        detectors: cls.detectors.map((det, i) => editionsLib.adaptDetector(cls, det, i)),
      };
    }
  }
  return null;
}

function templateText(buf) {
  return stripBom(buf.toString("utf8")).replace(/\r\n/g, "\n");
}

function templateIndex() {
  const buf = readIfExists(TEMPLATE_INDEX);
  if (buf === null) throw expected("jig's template index is missing — the plugin install is incomplete");
  const record = JSON.parse(templateText(buf));
  if (record.schemaVersion > SCHEMA_VERSION) {
    throw expected("the template index is schemaVersion " + record.schemaVersion + " and this engine reads " +
      SCHEMA_VERSION);
  }
  return record.templates;
}

// The version a manifest row records for a template, read from the index that
// owns it. A hand-written version string here would go stale the first time a
// template's bytes changed, and the manifest would then claim a version that
// never shipped.
function templateVersion(name) {
  const row = templateIndex().find((t) => t.name === name);
  if (!row) throw expected("jig ships no template named " + name);
  return String(row.version);
}

// The hash gate. A template that does not match what jig recorded for it is
// not a template jig is willing to write into somebody's repository, whatever
// changed it — so the refusal happens before a plan exists, not after a write.
function templateBody(entry) {
  const buf = readIfExists(path.join(TEMPLATE_DIR, entry.file));
  if (buf === null) throw expected("the template " + entry.name + " (" + entry.file + ") is missing from jig");
  const text = templateText(buf);
  const found = hashBytes(Buffer.from(text, "utf8"));
  if (found !== entry.sha256) {
    throw expected("the template " + entry.name + " does not match the hash jig recorded for it (recorded " +
      entry.sha256.slice(0, 12) + ", found " + found.slice(0, 12) + "). Nothing was planned — reinstall jig" +
      " rather than generating from a template that changed underneath it.");
  }
  return text;
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------
//
// What jig installed, what it came from, and what it hashed to. Together with
// the journal's pre-images it is the whole uninstall: the journal knows how to
// put a file back, and this knows which files are jig's to put back at all.

function readManifest(root) {
  const buf = readIfExists(statePath(root, MANIFEST_FILE));
  if (buf === null) return { schemaVersion: SCHEMA_VERSION, artifacts: [] };
  let record;
  try {
    record = JSON.parse(stripBom(buf.toString("utf8")));
  } catch (err) {
    throw expected(MANIFEST_FILE + " is not readable JSON (" + err.message + ")");
  }
  if (!isObject(record) || !Array.isArray(record.artifacts)) throw expected(MANIFEST_FILE + " is not a manifest");
  if (record.schemaVersion > SCHEMA_VERSION) {
    throw expected(MANIFEST_FILE + " is schemaVersion " + record.schemaVersion + " and this engine reads " +
      SCHEMA_VERSION + ". Upgrade jig rather than installing beside a manifest it cannot fully read.");
  }
  return record;
}

// The one artifact that is not a file. `git:core.hooksPath` is a pseudo-path
// nothing on disk answers, so every reader that asks the disk about it gets
// `null` and calls a live setting retired. Ask git instead — the same reader
// `revert` already asked, now in one place.
function settingBytes(root) {
  const value = gitConfig(root, GIT_SETTING);
  return value === null ? null : Buffer.from(value, "utf8");
}

// `state` is measured here rather than stored, for the same reason the journal
// is replayed rather than updated: a field somebody has to remember to write
// is a field that goes stale.
//
// `schema`-owned artifacts are exempt from drift. The config is a file users
// are meant to edit, so a hash that no longer matches means
// somebody used it, not that something broke — its correctness is the runner's
// schema check, never a fingerprint.
function manifestStates(root, manifest) {
  return manifest.artifacts.map((a) => {
    const buf = a.path === GIT_SETTING_PATH ? settingBytes(root) : readIfExists(path.join(root, a.path));
    if (buf === null) return { ...a, state: "retired" };
    if (a.ownership === "schema") return { ...a, state: "active" };
    return { ...a, state: hashBytes(buf) === a.hash ? "active" : "drifted" };
  });
}

// The occupancy rule, in one answer. A file jig did not
// install is somebody else's; a file jig installed and somebody then edited is
// theirs now too. Both are refusals rather than overwrites.
function occupancyProblem(root, rel, states) {
  const buf = readIfExists(path.join(root, rel));
  if (buf === null) return null;
  const owned = states.find((a) => a.path === rel);
  if (!owned) {
    return rel + " already exists and jig did not write it — jig will not write over a file it does not own";
  }
  if (owned.state === "drifted") {
    return rel + " was edited after jig wrote it, so it is yours now — revert it or remove it before regenerating";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The computed artifacts
// ---------------------------------------------------------------------------

// The committed guard configuration. A guard NAMES an installed check and
// carries nothing else that could match — the config is a trust boundary a
// teammate edits by design, and a pattern surviving a round trip through it
// would be a matcher nobody reviewed. `check` is the check module's own slug
// under `.jig/checks/` and `proof` is the hash binding the two, so a row
// pointing at a module that changed underneath it cannot arm.
//
// Only an admitted check yields a guard. An edition class taken with `--select`
// and nothing authored behind it installs none, because there would be no
// module for the row to name. There is no top-level mode: one word that
// silently arms twenty checks is too much blast radius (SCOPE).
function configFromSelection(classes, provenance, mode) {
  const guards = [];
  for (const cls of classes) {
    if (!cls.slug) continue;
    for (const det of cls.detectors) {
      if (!HOOK_RUNNERS.includes(det.runner)) continue;
      const guard = {
        id: cls.id + "-" + det.id,
        check: cls.slug,
        classId: cls.id,
        runner: det.runner,
        mode: mode || DEFAULT_INSTALL_MODE,
        // Provenance rides each row, because two mistakes out of one interview
        // can be answered for differently (SCOPE, "Is provenance per-plan or
        // per-guard").
        provenance: PROVENANCES.includes(provenance) ? provenance : "assumed",
      };
      // Teaching is opted into per guard and never derived (SCOPE, "Does an
      // observing guard teach by default"). The authored detector is where the
      // owner says so, and the key is only ever written when it was authored
      // true — a plan proposing one nobody asked for would be jig answering a
      // question it was not given.
      if (det.teach === true) guard.teach = true;
      if (typeof cls.proof === "string") guard.proof = cls.proof;
      guards.push(guard);
    }
  }
  return { schemaVersion: SCHEMA_VERSION, guards };
}

// The guard configuration as it stands on disk, or null when there is none jig
// can read. Null and "no guards" are the same answer to every caller here, so
// neither gets its own branch upstream.
function installedConfig(root) {
  const raw = readIfExists(path.join(root, STATE_DIR, CONFIG_FILE));
  if (raw === null) return null;
  let record = null;
  try {
    record = JSON.parse(stripBom(raw.toString("utf8")));
  } catch {
    return null;
  }
  return isObject(record) && Array.isArray(record.guards) ? record : null;
}

// The config face of ANY plan: the guards already installed, union the ones this
// selection adds. A plan is an interview about what to ADD, and computing the
// whole file from the current selection alone proposed `guards: []` over a
// repository that had two armed — approving it disarmed everything through
// jig's own approval flow.
//
// An installed row is carried forward on its OWNER'S answers — the mode and the
// provenance — and on nothing else. On an id this plan also computes, the
// mechanical half is recomputed: the same plan writes the check module, and
// carrying the row's `proof` would record the proof of the module it replaced,
// leaving a guard jig itself just installed unarmable and drifted. Every other
// key of the installed config rides along too, because `defaultBranches` is
// theirs and a re-run is not where it disappears.
function configFace(root, classes, provenance, mode) {
  const fresh = configFromSelection(classes, provenance, mode);
  const installed = installedConfig(root);
  if (!installed) return { config: fresh, carried: [], added: fresh.guards.map((g) => g.id) };
  const now = new Map(fresh.guards.map((g) => [g.id, g]));
  const carried = installed.guards.filter((g) => isObject(g)).map((row) => {
    const planned = now.get(row.id);
    if (!planned) return row;
    const merged = { ...planned, provenance: row.provenance };
    // Absent `mode` is observe, and that is an answer too — a guard the owner
    // disarmed does not come back armed because they ran the interview again.
    if ("mode" in row) merged.mode = row.mode;
    else delete merged.mode;
    // Teaching is the owner's answer too, and a re-run of the interview is not
    // where it silently reverts to off.
    if ("teach" in row) merged.teach = row.teach;
    return merged;
  });
  const have = new Set(carried.map((g) => g.id));
  const added = fresh.guards.filter((g) => !have.has(g.id));
  return {
    config: { ...installed, schemaVersion: SCHEMA_VERSION, guards: [...carried, ...added] },
    carried: carried.map((g) => g.id),
    added: added.map((g) => g.id),
  };
}

// Printed and persisted, never applied. The host's permission rules match a
// command by prefix; jig's guards match it by pattern. Saying that plainly is
// more use than proposing a rule broad enough to be expressible and wrong.
function permissionsProposal(classes) {
  const proposals = [];
  for (const cls of classes) {
    const classId = cls.id;
    const patterns = cls.detectors
      .filter((d) => d.runner === "PreToolUse")
      .flatMap((d) => (d.params && d.params.patterns) || []);
    if (!patterns.length) continue;
    proposals.push({
      classId,
      title: cls.title,
      patterns,
      hostRule: null,
      gap: "A permission rule matches a command by prefix, and these match it by pattern, so no rule here would" +
        " cover the same commands. jig's own guard is what watches this class.",
    });
  }
  if (!proposals.length) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    note: "jig never edits your settings. This file is a proposal to read, not a file anything reads back.",
    proposals,
  };
}

// What the lanes run besides the check driver (SCOPE's derail pass, N8). jig
// installed a linter, a type checker and a test runner and no lane spawned any
// of them, while the matrix printed DET for the config file — a coverage claim
// resting on a file nobody executes. These entries are that lane, stated as
// data: one row per ticked tool, carrying the argv, the exit code a clean run
// has, the paths the tool speaks for and the lanes that run it.
//
// The argv goes through the installer's own `parseCommand`, so a command a lane
// runs meets the same trust boundary as a command an install runs: no shell, and
// a metacharacter is a refusal rather than something to quote around. The tool's
// own `verify.expectedExit` is the code that means CAUGHT over a planted
// violation, so it is not the code a lane wants — a lane wants the tool clean,
// which is 0.
function verifyEntriesFor(loaded, items, lanes, testScript) {
  const entries = [];
  const refused = [];
  const roles = new Set();
  const extensionsOf = (editionId) => {
    const edition = loaded.find((e) => e.edition === editionId);
    const exts = (edition && edition.detect && edition.detect.extensions) || [];
    return exts.map((ext) => "**/*" + ext);
  };
  for (const row of items) {
    const tool = toolchainToolFor(loaded, row.item.id);
    const argv = tool && tool.verify && Array.isArray(tool.verify.argv) ? tool.verify.argv : null;
    if (!argv) continue;
    let parsed;
    try {
      parsed = toolchainLib.parseCommand(argv.join(" "), row.item.id + "'s verify command");
    } catch (err) {
      if (!err.expected) throw err;
      refused.push(err.message);
      continue;
    }
    if (row.item.role) roles.add(row.item.role);
    entries.push({ id: row.item.id, argv: parsed, expectedExit: 0, paths: extensionsOf(row.item.edition), lanes });
  }
  // The scan already read `package.json`'s test script, and until now nothing
  // did anything with it. Where the owner ticked no test runner, it IS the test
  // runner this project has — so it feeds the entry rather than sitting in a
  // profile as a fact nobody uses.
  if (typeof testScript === "string" && testScript.trim() && !roles.has("test-runner")) {
    try {
      entries.push({
        id: "test-script", argv: toolchainLib.parseCommand(testScript, "the project's own test script"),
        expectedExit: 0, paths: [], lanes,
      });
    } catch (err) {
      if (!err.expected) throw err;
      refused.push(err.message);
    }
  }
  return { entries, refused };
}

// The lane face of any plan, on the same rule `configFace` follows and for the
// same reason: a re-run is an interview about what to ADD, and writing the whole
// file from this run's ticked tools alone would take the linter out of CI
// because the second interview was about the type checker. Installed entries are
// carried verbatim; an id this plan computes is replaced by the new one, which
// is how a changed argv reaches the lane.
function verifyFace(root, entries) {
  const raw = readIfExists(path.join(root, STATE_DIR, VERIFY_FILE));
  const installed = (raw === null ? null : proposedVerifyEntries(raw.toString("utf8"))) || [];
  const now = new Map(entries.map((e) => [e.id, e]));
  const carried = installed.filter((e) => typeof e.id === "string" && !now.has(e.id));
  return {
    entries: [...carried, ...entries],
    carried: carried.map((e) => e.id),
    added: entries.map((e) => e.id),
  };
}

// One step per CI-lane entry, appended to the workflow template. One step and
// not one command: a job that ran three tools and went red has to say WHICH one
// went red, and a step name is the only thing GitHub's own summary shows.
function ciVerifySteps(entries) {
  return entries.filter((e) => Array.isArray(e.lanes) && e.lanes.includes("ci")).map((e) =>
    "      - name: run " + e.id + ", the way " + STATE_DIR + "/" + VERIFY_FILE + " names it\n" +
    "        run: node " + STATE_DIR + "/checks/run.mjs --verify --lane ci --entry " + e.id + "\n").join("");
}

// ---------------------------------------------------------------------------
// Draft from templates
// ---------------------------------------------------------------------------

// The change id carries a short hash of the content, so planning the same
// artifact twice produces the same id and planning a different one produces a
// different id. Without that, a second plan in `.jig/` would claim ids the
// first one already defined and `apply --change` could no longer name one
// thing.
function changeId(name, content) {
  return name + "-" + hashBytes(Buffer.from(content, "utf8")).slice(0, 8);
}

// A `--from` file is either the checks the model wrote or a hand-written draft
// plan, and the file itself says which — the skill hands one path to `admit`
// and then straight to `plan`, so a second flag for the same file would be one
// more thing to get wrong.
function readFromFile(root, from) {
  const what = from === "-" ? "the draft on stdin" : from;
  let raw;
  try {
    raw = from === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(root, from), "utf8");
  } catch (err) {
    throw expected("cannot read " + what + ": " + err.message);
  }
  try {
    return JSON.parse(stripBom(raw));
  } catch (err) {
    throw expected(what + " is not valid JSON: " + err.message);
  }
}

function authoredChecksIn(record) {
  if (Array.isArray(record)) return record;
  return isObject(record) && Array.isArray(record.checks) ? record.checks : null;
}

// The checks the model wrote for this project. Nothing here judges one:
// admission does, against its own pair.
function readAuthored(root, opts) {
  if (opts.authored === undefined) return [];
  if (typeof opts.authored !== "string" || !opts.authored.trim()) {
    throw expected("--authored needs a path to the file holding the authored checks");
  }
  const checks = authoredChecksIn(readFromFile(root, opts.authored));
  if (!checks) throw expected("the authored-check file has no `checks` array");
  return checks;
}

// SCOPE, "Where does an authored id come from": a slug rule with a collision
// refusal. The id is namespaced and a namespace separator is a path separator,
// so the slug is what a file can actually be called.
function checkSlug(id) {
  return String(id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// The admission test, and the whole reason free text can become a check at all
// (SCOPE, "The stance that replaces it"). A check is admitted by its own
// fixture pair and by staying silent on every other check's near miss; anything
// else is discarded, written to `.jig/discarded.json`, and reported — a discard
// that lives only in a transcript is hidden by morning.
function admitAuthored(root, checks) {
  // jig-lib is required lazily: it requires this module back for the shared
  // vocabulary, and a top-level require would be a cycle.
  const { blankRegions, globToRegExp, evalSessionDetector } = require("../hooks/jig-lib.js");
  const discarded = [];
  const testable = [];
  for (const check of checks) {
    if (!isObject(check) || typeof check.id !== "string" || !check.id.trim()) {
      throw expected("every authored check needs a string id — an unnamed check cannot be installed or reverted");
    }
    if (typeof check.module !== "string" || !check.module.trim()) {
      discarded.push({ id: check.id, why: "the check carries no `module` source, so there is nothing to install" });
      continue;
    }
    testable.push(check);
  }

  // The blanker proves a pattern check, the glob matcher proves a paired one,
  // and the runner's own evaluation proves a session lever. All three are the
  // real ones the session guards and the driver use — a pair proved against a
  // toy is a pair that proves nothing about what will run.
  const result = admission.admit(testable, blankRegions, {
    cross: true, match: globToRegExp, evaluate: evalSessionDetector,
  });
  discarded.push(...result.discarded);

  const admitted = [];
  const slugs = new Map();
  for (const row of result.admitted) {
    const slug = checkSlug(row.id);
    if (!slug) throw expected("the authored check " + JSON.stringify(row.id) + " slugs to nothing — give it a name a file can carry");
    if (slugs.has(slug)) {
      throw expected("the authored checks " + slugs.get(slug) + " and " + row.id + " both slug to `" + slug +
        "` — two checks cannot share one module file. Rename one of them.");
    }
    slugs.set(slug, row.id);
    admitted.push({
      ...row,
      slug,
      proof: admission.proofHash(row.check.module, row.check.fixtures.violation, row.check.fixtures.nearMiss),
    });
  }
  return { admitted, discarded, file: STATE_DIR + "/discarded.json" };
}

// The toolchain proposal (SCOPE step 3). proposeInstalls spawns nothing; the
// only command run here is the version probe that decides whether a tool is
// already on this machine. Everything a proposal cannot answer honestly — an
// unknown tool, a package manager two lockfiles disagree about — is refused
// into the disclosure list rather than guessed at.
function toolchainProposal(root, loaded, opts, states) {
  const ids = typeof opts.tools === "string"
    ? [...new Set(opts.tools.split(",").map((s) => s.trim()).filter(Boolean))]
    : [];
  const items = [];
  const refused = [];
  if (!ids.length) return { packageManager: null, items, refused };

  const byEdition = new Map();
  for (const id of ids) {
    const edition = loaded.find((e) => (e.toolchain || []).some((t) => t.id === id));
    if (!edition) {
      refused.push(id + " is not a tool in any edition this project detected (" +
        loaded.map((e) => e.edition).join(", ") + ")");
      continue;
    }
    if (!byEdition.has(edition)) byEdition.set(edition, []);
    byEdition.get(edition).push(id);
  }

  let packageManager = null;
  for (const [edition, toolIds] of byEdition) {
    const manager = typeof opts["package-manager"] === "string" && opts["package-manager"]
      ? opts["package-manager"]
      : toolchainLib.pickPackageManager(root, edition);
    if (!manager) {
      refused.push("no package manager is conclusive for the " + edition.edition + " edition — say which of " +
        edition.detect.packageManagers.join(", ") + " this project uses with --package-manager");
      continue;
    }
    packageManager = packageManager || manager;
    for (const id of toolIds) {
      const tool = edition.toolchain.find((t) => t.id === id);
      let proposed;
      try {
        proposed = toolchainLib.proposeInstalls(root, edition, [id], manager)[0];
      } catch (err) {
        if (!err.expected) throw err;
        refused.push(err.message);
        continue;
      }
      // An existing config file is NOT a reason to throw the tool away. Until
      // 2.2.0 it was, so a Python project that already had a `pyproject.toml`
      // — which is every Python project — got no linter, no type checker
      // and no test runner at all, and the only trace was one refusal line per
      // tool. jig still writes nothing it does not own; the config becomes a
      // note the owner can act on, and the install goes ahead.
      const occupied = occupancyProblem(root, toPosix(proposed.configPath), states);
      items.push({ item: proposed, occupied: occupied || null, ...toolchainLib.presence(root, tool) });
    }
  }
  return { packageManager, items, refused };
}

// Which of the resolved editions have no project on disk yet. `greenfield` is
// not a mode and nothing branches on it twice — it is one fact, read once here,
// so the plan, the toolchain command and the skill all say the same thing.
function greenfieldEditions(root, loaded, manager) {
  return loaded
    .filter((edition) => !editionsLib.projectExists(root, edition))
    .map((edition) => editionsLib.manifestFor(edition, manager));
}

// Several tools, one file. Five python tools configure `pyproject.toml`, four
// dotnet tools configure `.editorconfig`, two rust tools configure
// `Cargo.toml` — and until 2.2.0 each of them was written as its own whole-file
// change, so the last one applied replaced every earlier one and nobody was
// told. This decides, per path, which of three things happens:
//
//   - one tool owns the file       → it is written as it always was
//   - several tools, composable    → one composed body, conflicts reported
//   - several tools, anything else → NOTHING is written; the owner is handed
//                                    each snippet and told where it goes
//
// The third case is the honest one. A `go.mod` sample is an illustration of a
// module file rather than a file to lay down, and the module path is the
// owner's to choose — writing one over somebody's module would be the same bug
// wearing a fix. `sections.mergeable` is the whole list of what composes.
//
// A tool's `wiring` is prose in five editions — a Makefile target, a Gradle
// task — and in the JS edition it is the `package.json` member itself,
// `"lint": "eslint ."`. Only the second shape is composed, and it is tested for
// rather than assumed: a starter with no `scripts` is a project whose own CI
// step has nothing to call, and prose grafted into a manifest is a half-parser
// writing somebody's build file.
function scriptBody(wiring) {
  if (typeof wiring !== "string" || !wiring.trimStart().startsWith("\"")) return null;
  let scripts;
  try {
    scripts = JSON.parse("{" + wiring + "}");
  } catch {
    return null;
  }
  if (!isObject(scripts) || !Object.values(scripts).every((v) => typeof v === "string")) return null;
  return JSON.stringify({ scripts }, null, 2) + "\n";
}

function composeConfigs(items, manifests) {
  // The scripts an edition's tools need in its own manifest, one part each and
  // in the order the tools were proposed, so first-writer-wins is the order the
  // owner read.
  const scriptParts = (manifest) => items
    .filter((row) => row.item.edition === manifest.edition)
    .map((row) => ({ source: row.item.id, body: scriptBody(row.item.wiring) }))
    .filter((part) => part.body !== null);

  const byPath = new Map();
  for (const row of items) {
    const rel = toPosix(row.item.configPath);
    if (!byPath.has(rel)) byPath.set(rel, []);
    byPath.get(rel).push(row);
  }

  const writes = [];
  const notes = [];
  const conflicts = [];
  const composed = new Set();
  const manifestPaths = new Set(manifests.filter((m) => m.path).map((m) => toPosix(m.path)));

  for (const [rel, rows] of byPath) {
    // Somebody else's file. jig does not write it, and each tool's section
    // becomes something the owner can paste rather than a tool jig drops.
    const held = rows.find((r) => r.occupied);
    if (held) {
      for (const row of rows) {
        composed.add(row.item.id);
        notes.push({
          path: rel,
          tool: row.item.id,
          why: held.occupied + ". Here is what " + row.item.id + " needs in it:",
          snippet: row.item.configBody,
          wiring: row.item.wiring || null,
        });
      }
      continue;
    }

    // A manifest jig may write is the first part of its own file, so the
    // starter and the tool sections land composed rather than fighting.
    const starter = manifests.find((m) => m.path && toPosix(m.path) === rel && m.sample);
    const shared = rows.length > 1 || Boolean(starter);
    // A project file jig cannot compose is a project file jig does not touch,
    // even for one tool. The `go.mod` samples in the go edition are pictures of
    // what a module file looks like for that tool, not a fragment to graft on,
    // and laying one down over somebody's module would be the loudest possible
    // way to get this wrong.
    if (!shared && !manifestPaths.has(rel)) continue;

    if (!sectionsLib.mergeable(rel)) {
      const names = rows.map((r) => r.item.id);
      const owners = names.length === 1
        ? names[0] + "'s"
        : names.slice(0, -1).join(", ") + " and " + names[names.length - 1] + "'s";
      for (const row of rows) {
        composed.add(row.item.id);
        notes.push({
          path: rel,
          tool: row.item.id,
          why: rel + " is " + owners + " and jig cannot compose that file, so it writes none of it." +
            " Here is what " + row.item.id + " needs in it:",
          snippet: row.item.configBody,
          wiring: row.item.wiring || null,
        });
      }
      continue;
    }
    if (!shared) continue;

    const parts = [];
    if (starter) {
      parts.push({ source: "the starter " + rel + " jig writes", body: starter.sample });
      parts.push(...scriptParts(starter));
    }
    for (const row of rows) {
      composed.add(row.item.id);
      parts.push({ source: row.item.id, body: row.item.configBody });
    }
    const merged = sectionsLib.merge(parts, rel);
    conflicts.push(...merged.conflicts);
    writes.push({ path: rel, body: merged.body, sources: parts.map((p) => p.source) });
  }

  // A starter manifest nothing else configures is still a file jig has to
  // write — `uv add` has nowhere to record a dependency without it.
  for (const m of manifests) {
    if (!m.path || !m.sample) continue;
    const rel = toPosix(m.path);
    if (writes.some((w) => w.path === rel) || byPath.has(rel)) continue;
    const parts = [{ source: "the starter " + rel + " jig writes", body: m.sample }, ...scriptParts(m)];
    if (parts.length === 1 || !sectionsLib.mergeable(rel)) {
      writes.push({ path: rel, body: m.sample, sources: [parts[0].source] });
      continue;
    }
    const merged = sectionsLib.merge(parts, rel);
    conflicts.push(...merged.conflicts);
    writes.push({ path: rel, body: merged.body, sources: parts.map((p) => p.source) });
  }
  return { writes, notes, conflicts, composed };
}

// Which face of the activation doc a plan writes. The unwired one tells the
// owner how to turn commit-time checks on. The wired ones say the checks are
// already running and how to turn them off, and there are two because undoing
// the two routes is two different things: unsetting `core.hooksPath` for the
// hook jig wrote, taking one line back out of a hook the owner already had.
//
// A plan that does the wiring writes the wired face in the same plan, so the
// file cannot outlive the sentence that made it true. That is the whole defect
// this exists to close: `--wire-commit` runs as its own plan AFTER the install,
// so the unwired file was written while the lane really was dead and then
// nothing ever went back to correct it.
//
// Every other route asks the repository instead of the plan, which is how a
// repo wired under an older jig gets the right file without being rewired —
// and how a re-run never offers the unwired text over a live lane.
function activationFace(root, opts) {
  if (opts["wire-commit"]) return "activation-wired";
  if (opts["weave-precommit"]) return "activation-woven";
  // The lane is consulted on EVERY route, not just `--refresh-activation`. A
  // second interview on a wired repository was re-proposing the unwired text —
  // a document telling the owner to turn on checks that have been running for
  // weeks — over the true one.
  const lane = commitLane(root);
  if (lane.state !== "live") return "activation";
  return lane.setting === STATE_DIR + "/hooks" ? "activation-wired" : "activation-woven";
}

// What each face is for, in the manifest's own words. `inventory` reports this
// back as why the file is here, and "activation-wired" is a template name, not
// a reason.
const ACTIVATION_WHY = {
  "activation": "how to run the committed checks at commit time",
  "activation-wired": "what runs at commit time now that git points at jig's hook, and how to undo it",
  "activation-woven": "what runs at commit time now that jig's line is in your own hook, and how to undo it",
};

function draftFromTemplates(root, opts, checks) {
  // The edition is resolved ONCE, here, and threaded through everything below.
  // Detection walks the tree, and a plan that asked the question twice could
  // answer itself differently halfway through its own coverage matrix.
  const loaded = resolveEditions(root, opts);

  const raw = typeof opts.select === "string" ? opts.select : "";
  const asked = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  const authoredChecks = checks || readAuthored(root, opts);
  // `--wire-commit` is the one plan that proposes no coverage: it points git at
  // checks that are already installed. Every other route still has to say what
  // it is covering.
  if (!asked.length && !authoredChecks.length && !opts["wire-commit"] && !opts["refresh-activation"]) {
    throw expected("plan needs --select <classId,…> (ids are namespaced, e.g. python/swallowed-exception) or" +
      " --from <file> holding the checks the model wrote for this project");
  }

  const provenance = PROVENANCES.includes(opts.provenance) ? opts.provenance : "assumed";
  const mode = installMode(opts);
  const admissionResult = admitAuthored(root, authoredChecks);
  const authoredById = new Map(admissionResult.admitted.map((a) => [a.id, a]));
  const discardedIds = new Set(admissionResult.discarded.map((d) => d.id));

  // Discarded checks never reach the class list — coverage jig has not
  // demonstrated is coverage jig does not claim — but they are on the record
  // before anybody reads the matrix.
  const selection = [...new Set([...asked, ...authoredById.keys()])].filter((id) => !discardedIds.has(id)).sort();
  const classes = selection.map((id) => {
    const found = editionClassById(loaded, id);
    if (found) return found;
    const authored = authoredById.get(id);
    if (!authored) {
      // An id no edition carries and no admitted check answers. Not a refusal
      // (the catalogue never gates), just a class with nothing behind it — the
      // matrix says GAP in every column and the owner sees why.
      return { id, edition: null, title: id, severity: "safety", axes: [], detectors: [], authored: false };
    }
    const check = authored.check;
    return {
      id,
      edition: null,
      title: check.title || id,
      severity: check.severity || "safety",
      axes: Array.isArray(check.axes) ? check.axes : [],
      gapNotes: check.gapNotes || null,
      // The words a blocked call will read, carried onto the class so the plan
      // can print them. Admission already refused an incomplete or garbled one.
      deny: check.deny || (check.detectors || []).map((d) => d && d.deny).find(Boolean) || null,
      detectors: (check.detectors || []).map((det, i) => adaptAuthoredDetector(check, det, i)),
      authored: true,
      expectedNearMissHits: authored.expectedNearMissHits,
      // The two things a guard row is made of: the module file the config may
      // name, and the hash that binds the row to the module on disk.
      slug: authored.slug,
      proof: authored.proof,
    };
  });

  const index = templateIndex();
  const byName = new Map(index.map((t) => [t.name, t]));
  const states = manifestStates(root, readManifest(root));
  const changes = [];
  const refused = [];

  const add = (entry, content, classIds, rationale) => {
    const problem = occupancyProblem(root, entry.target, states);
    if (problem) { refused.push(problem); return; }
    changes.push({
      id: changeId(entry.name, content),
      kind: entry.kind,
      path: entry.target,
      content,
      classIds: classIds || [],
      ownership: entry.ownership,
      provenance,
      template: { name: entry.name, version: entry.version },
      rationale: rationale || ACTIVATION_WHY[entry.name] || entry.name,
    });
  };

  // The toolchain is resolved before the lanes are written, because the lanes
  // now carry it: the CI workflow gains a step per tool and the plan writes the
  // entries those steps read. Nothing is pushed onto `refused` here — that
  // happens where it always did, further down, so the page reads in the same
  // order it always has.
  const toolchain = toolchainProposal(root, loaded, opts, states);
  // A project that does not exist yet cannot be installed into, so a tool for an
  // edition with no project file here is not a tool any lane runs either.
  const greenfield = greenfieldEditions(root, loaded, toolchain.packageManager);
  const blocked = new Set(greenfield.filter((m) => !m.sample).map((m) => m.edition));
  const usable = toolchain.items.filter((row) => !blocked.has(row.item.edition));

  // Which lanes exist to run a tool in. CI unless the owner declined the
  // workflow; the commit lane only when they asked for it, because a full
  // type-check on every commit is a cost they choose (SCOPE's derail pass, N8).
  const verifyLanes = [];
  if (!opts["no-ci"]) verifyLanes.push("ci");
  if (opts["verify-commit"]) verifyLanes.push("commit");
  let stack = null;
  try {
    stack = readProfile(root).profile.stack || null;
  } catch {
    // No scan here yet. The tools the owner ticked are still the lane; the
    // project's own test script is the half only the scan can see.
  }
  const verify = verifyLanes.length
    ? verifyEntriesFor(loaded, usable, verifyLanes, stack && stack.testScript)
    : { entries: [], refused: [] };
  // What the file will hold: what this plan computed, over what is already
  // installed. A re-run adds a lane entry; it never quietly takes one away.
  // Always over the installed list, even when this run ticked nothing: the
  // workflow's steps are rendered from these entries, and short-circuiting on
  // an empty computed list wrote a jig.yml with the linter's step gone while
  // `.jig/verify.json` still said the ci lane runs it.
  const verifyFile = verifyFace(root, verify.entries);

  // The driver and the wiring around it. There is no per-class check template
  // any more: the model authors every check and the fixture pair admits it, so
  // the only check modules this plan writes are the admitted ones below.
  const face = activationFace(root, opts);
  if (opts["refresh-activation"]) {
    const lane = commitLane(root);
    if (lane.state !== "live") {
      throw expected("commit-time checks do not run here yet, so " + STATE_DIR + "/" + ACTIVATION_FILE +
        " already says the right thing. " + WIRE_COMMIT_FIX + " — that is what turns them on.");
    }
    const entry = byName.get(face);
    const current = readIfExists(path.join(root, STATE_DIR, ACTIVATION_FILE));
    if (entry && current !== null && templateText(current) === templateBody(entry)) {
      throw expected(STATE_DIR + "/" + ACTIVATION_FILE + " already says the checks are running — nothing to refresh.");
    }
  }
  // A plan with no coverage behind it is a wiring plan — `--wire-commit`,
  // `--refresh-activation`. The driver, the shim and the workflow are already
  // installed, and re-emitting them byte for byte mints change ids that two
  // plans define, which `apply` refuses by design. The only file such a plan
  // touches is the activation doc, and only to keep it in step with the lane.
  const wiringOnly = !asked.length && !authoredChecks.length;
  // A driver with nothing under it finds nothing by construction, and a CI
  // workflow that runs it is a green lane over no coverage at all. When every
  // check a plan carried was discarded at admission there is nothing left to
  // run, so the lanes are not emitted: an install that claims a commit and a CI
  // lane must have something for them to check.
  const noCoverage = !wiringOnly && !selection.length;
  if (noCoverage) {
    const why = "every check this plan carried was discarded at admission, so no driver, hook or CI workflow" +
      " is proposed — there would be nothing for them to run:\n  - " +
      admissionResult.discarded.map((d) => d.id + ": " + d.why).join("\n  - ");
    // A ticked linter or type checker is coverage of its own, approved by name.
    // Throwing the whole plan away because an unrelated check failed admission
    // would discard an install the owner did give an answer for; the lanes are
    // what has nothing behind them, and only they are dropped.
    if (!(typeof opts.tools === "string" && opts.tools.trim())) {
      throw expected(why + "\nNothing was planned.");
    }
    refused.push(why);
  }
  const wanted = wiringOnly ? [face] : noCoverage ? [] : ["check-driver", face, "hook-shim"];
  if (!wiringOnly && !noCoverage && !opts["no-ci"]) wanted.push("ci-workflow");
  for (const name of wanted) {
    const entry = byName.get(name);
    if (!entry) continue;
    // The workflow is the one artifact that is not a byte copy: it gains a step
    // per tool the CI lane runs, so the job that says the checks passed is the
    // job that ran the linter, the type checker and the test runner too.
    add(entry, name === "ci-workflow" ? templateBody(entry) + ciVerifySteps(verifyFile.entries) : templateBody(entry),
      entry.classId ? [entry.classId] : selection);
  }
  // What those steps read. Item tier: a non-zero exit from anything in it fails
  // somebody's build, which is the whole point of it being here.
  // `added`, not `entries`: a plan that ticked no tool carries the installed
  // list forward for the workflow's sake and proposes no write over it.
  if (!wiringOnly && !noCoverage && verifyFile.added.length) {
    add({ name: "verify", version: "1.0.0", target: STATE_DIR + "/" + VERIFY_FILE, kind: "write-side-file", ownership: "schema" },
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, entries: verifyFile.entries }, null, 2) + "\n", selection,
      "what the " + verifyLanes.join(" and ") + " lane" + (verifyLanes.length === 1 ? "" : "s") + " run" +
        (verifyLanes.length === 1 ? "s" : "") + ": " + verifyFile.added.join(", ") +
        (verifyFile.carried.length ? " — carried forward: " + verifyFile.carried.join(", ") : ""));
  }

  // Every admitted check is one module file carrying its own fixtures inline,
  // so it reverts with the check and the selftest stays re-runnable forever.
  // The proof hash rides the change into the manifest.
  for (const row of admissionResult.admitted) {
    const target = STATE_DIR + "/checks/" + row.slug + ".check.mjs";
    const problem = occupancyProblem(root, target, states);
    if (problem) { refused.push(problem); continue; }
    changes.push({
      id: changeId("check-" + row.slug, row.check.module),
      kind: "write-side-file",
      path: target,
      content: row.check.module,
      classIds: [row.id],
      ownership: "file",
      provenance,
      proof: row.proof,
      template: { name: "check-" + row.slug, version: "authored" },
      rationale: "authored check, admitted on its own fixture pair",
    });
  }

  // The toolchain (SCOPE step 3). One item per tool: a tool the machine does
  // not carry is an install the owner approves by name, a tool it already
  // carries is only its config. Either way the id is the same, so `revert`
  // undoes the tool whole. Resolved above, where the lanes could read it;
  // refused here, where the page has always read it.
  refused.push(...toolchain.refused);
  // A verify command jig cannot run without a shell is a lane entry jig does not
  // write. Said out loud rather than dropped: the tool still installs, and the
  // matrix reports the cell it can no longer claim.
  refused.push(...verify.refused);

  // A project that does not exist yet cannot be installed into. Where the
  // edition can hand over a starter project file, jig writes it and the run
  // continues; where only the owner can name the thing — a Go module path, a
  // Gradle template — the edition says so and every install for it is refused
  // with that sentence rather than run into a folder with no project in it.
  for (const m of greenfield) {
    if (m.sample) continue;
    // Once per edition, not once per tool. The owner has one thing to do and
    // reading it six times would not make it any clearer.
    refused.push("there is no " + m.edition + " project here yet, so nothing can install into it. " + m.hint);
  }

  // Every edition's project file, so composition knows which paths belong to
  // the project rather than to a tool — but the starter text only where there
  // is no project yet, because jig never re-writes one somebody already has.
  //
  // And only for an edition the owner NAMED. Detection is a heuristic over file
  // names: a `pyproject.toml` makes a Python repository match the rust edition
  // too, because `.toml` is one of rust's extensions. Creating a project file
  // is a stated intent, never an inference — so `--edition rust` writes a
  // `Cargo.toml` and a lucky extension match never does.
  const named = typeof opts.edition === "string" && opts.edition.trim()
    ? new Set(opts.edition.split(",").map((s) => s.trim()).filter(Boolean))
    : new Set();
  for (const m of greenfield) {
    if (!m.sample || named.has(m.edition)) continue;
    refused.push("there is no " + m.path + " here, so nothing was scaffolded for the " + m.edition +
      " edition. If this is a " + m.edition + " project, re-run with --edition " + m.edition +
      " and jig writes the starter first.");
  }
  const starting = new Set(greenfield.filter((m) => m.sample && named.has(m.edition)).map((m) => m.edition));
  const manifests = loaded
    .map((e) => editionsLib.manifestFor(e, toolchain.packageManager))
    .map((m) => (starting.has(m.edition) ? m : { ...m, sample: null }));

  // A starter with no `.gitignore` is a first commit carrying `node_modules/`
  // or `target/`, and the checks jig runs straight afterwards read every file
  // in it. The lines are the edition's own — a repository that already has a
  // `.gitignore` keeps it, because occupancy refuses the write like any other.
  const ignoreLines = [];
  for (const edition of loaded) {
    if (!starting.has(edition.edition)) continue;
    const list = (Array.isArray(edition.detect.ignore) ? edition.detect.ignore : [])
      .filter((line) => typeof line === "string" && line.trim() && !ignoreLines.includes(line));
    if (list.length) ignoreLines.push("# " + edition.edition, ...list);
  }
  if (ignoreLines.length) {
    add({ name: "gitignore", version: "1.0.0", target: ".gitignore", kind: "write-side-file", ownership: "file" },
      ignoreLines.join("\n") + "\n", selection,
      "what a " + [...starting].join(" and ") + " project never commits");
  }

  const configs = composeConfigs(usable, manifests);
  for (const write of configs.writes) {
    const problem = occupancyProblem(root, write.path, states);
    if (problem) { refused.push(problem); continue; }
    changes.push({
      id: changeId("toolchain-config-" + write.path, write.body),
      kind: "write-side-file",
      path: write.path,
      content: write.body,
      classIds: selection,
      ownership: "file",
      provenance,
      template: { name: "toolchain-config-" + write.path, version: "composed" },
      rationale: write.sources.length === 1
        ? write.sources[0]
        : write.path + ", composed from " + write.sources.join(", "),
    });
  }

  // The rest of the starter. A `Cargo.toml` with no `src/lib.rs` is a manifest
  // cargo refuses to parse — jig's first act on a project it just scaffolded is
  // to run the checks over it, and a red build there is a harness crying wolf.
  // The edition names the smallest tree its own build and test commands exit 0
  // on; each file is its own approved change, and a path a tool's config
  // already claims is left to the composition that owns it.
  //
  // A starter file may name the tool it belongs to. The JavaScript edition's
  // two smoke tests are why: `node --test` and vitest read different files and
  // neither can read the other's, so writing the vitest one into a project that
  // ticked no test runner would leave an import nothing resolves.
  const claimed = new Set(changes.map((c) => c.path));
  const ticked = new Set(usable.map((row) => row.item.id));
  for (const m of manifests) {
    if (!m.sample) continue;
    for (const file of m.starter) {
      if (file.tool && !ticked.has(file.tool)) continue;
      if (claimed.has(file.path)) continue;
      claimed.add(file.path);
      // The template row is derived, not invented: the edition and the path
      // name it, and the version is the one the catalogue recorded beside the
      // body. A hand-written "1.0.0" here would claim a version no install
      // could check, on files that are most of a greenfield tree.
      add({ name: "starter-" + m.edition + "-" + file.path, version: file.version, target: file.path, kind: "write-side-file", ownership: "file" },
        file.body, selection,
        "part of the starter " + m.edition + " project, so it builds and its tests run before anything else is added");
    }
  }

  for (const row of usable) {
    // A tool whose config was composed above has already had its say in that
    // one file, so the install itself must not write a second copy over it.
    const item = configs.composed.has(row.item.id)
      ? { ...row.item, configBody: null, configPath: row.item.configPath }
      : row.item;
    if (row.present) {
      if (configs.composed.has(item.id)) continue;
      changes.push({
        id: changeId("toolchain-" + item.id, item.configBody),
        kind: "write-side-file",
        path: toPosix(item.configPath),
        content: item.configBody,
        classIds: selection,
        ownership: "file",
        provenance,
        template: { name: "toolchain-" + item.id, version: item.edition || "1.0.0" },
        rationale: item.id + " is already here (" + row.how + ") — this is its config, no install",
        // The rest of the tool, carried on the config-only change too. A tool
        // installed by hand — which on Windows is every JS tool, until 2.9.0
        // fixed the shim — used to arrive as bare config: the `lint` script and
        // the CI step the plan printed had nowhere to be read back from, so the
        // tool was configured and nothing ever ran it.
        tool: item.id,
        wiring: item.wiring,
        ciStep: item.ciStep,
      });
      continue;
    }
    changes.push({
      id: changeId("install-" + item.id, item.command),
      kind: "run-install",
      path: toPosix(item.configPath),
      install: item,
      classIds: selection,
      ownership: "file",
      provenance,
      template: { name: "install-" + item.id, version: item.edition || "1.0.0" },
      rationale: item.command,
    });
  }

  // The two computed artifacts ride the same path as the copied ones: same
  // change kinds, same occupancy rule, same journal.
  //
  // Both are computed FROM THE SELECTION, so a plan with no selection — a
  // wiring plan by definition, or one whose every check was discarded — would
  // compute a guard config holding no guards and propose it over the real one.
  // Approving a plan that only claimed to point git at a hook, or to install a
  // linter, would silently disarm every guard in the repository, which is the
  // exact thing SCOPE says jig must never do, arriving through jig's own
  // approval flow. A plan that proposes no coverage proposes no config.
  if (!wiringOnly && !noCoverage) {
    const face = configFace(root, classes, provenance, mode);
    add({ name: "config", version: "1.0.0", target: STATE_DIR + "/" + CONFIG_FILE, kind: "write-config", ownership: "schema" },
      JSON.stringify(face.config, null, 2) + "\n", selection,
      // Named, not counted: the owner is approving a file that decides which
      // tool calls get refused, and "config" told them nothing about which.
      "the guard configuration" +
        (face.carried.length ? " — carried forward: " + face.carried.join(", ") : "") +
        (face.added.length ? " — added by this plan: " + face.added.join(", ") : ""));
    const permissions = permissionsProposal(classes);
    if (permissions) {
      add({ name: "permissions", version: "1.0.0", target: STATE_DIR + "/" + PERMISSIONS_FILE, kind: "write-side-file", ownership: "file" },
        JSON.stringify(permissions, null, 2) + "\n", selection);
    }
  }

  // The Codex region (0.5.0): computed from the selection, marker-fenced,
  // capped by the loadability ceiling at apply time. Explicit request only.
  if (opts["agents-region"]) {
    const content = agentsRegionText(selection, !opts["no-ci"]);
    changes.push({
      id: changeId("agents-region", content),
      kind: "write-agents-region",
      path: "AGENTS.md",
      content,
      classIds: selection,
      ownership: "line",
      provenance,
      template: { name: "agents-region", version: "1.0.0" },
      rationale: "point Codex sessions at the committed checks",
    });
  }
  // The same brief for the other host (2.9.0). A Claude Code session never
  // reads AGENTS.md, so the region leaves the agent jig actually runs beside
  // with no standing instruction at all — only the deny reply, which arrives
  // after the tool call. Opt-in and item tier like every other file outside
  // `.jig/`, because it is always-loaded prose the owner has to want.
  if (opts["checks-rule"]) {
    const content = "# jig's checks\n\n" + harnessBriefText(selection, !opts["no-ci"]) +
      "\n<!-- " + PROSE_EVIDENCE_MARK + " — the harness brief, computed from the selection." +
      " evidence: reasoned, claude-opus-5 2026-09 -->\n";
    changes.push({
      id: changeId("jig-checks", content),
      kind: "write-rule",
      path: ".claude/rules/jig-checks.md",
      content,
      classIds: selection,
      ownership: "file",
      provenance,
      template: { name: "jig-checks", version: "1.0.0" },
      rationale: "point every Claude Code session at the committed checks",
    });
  }
  // The pre-commit weave: one line into a hook file the repository already
  // committed, taken from shared catalogue data rather than anything typed.
  // `.git/hooks/` is machine-local and jig never writes there, so the only
  // hosts here are files a teammate would see in review anyway.
  if (opts["weave-precommit"]) {
    const { profile } = readProfile(root);
    const hosts = ((profile.guardrails && profile.guardrails.precommit) || []).filter((h) => !h.woven);
    if (!hosts.length) {
      throw expected("there is no committed pre-commit hook here to weave into, or jig's line is already in it." +
        " The activation line stays a printed proposal — see " + STATE_DIR + "/" + ACTIVATION_FILE + ".");
    }
    for (const host of hosts) {
      const entry = ACTIVATION[host.host];
      if (!entry) throw expected(host.path + " is a pre-commit host jig ships no activation line for");
      changes.push({
        id: changeId("weave-precommit", host.path + entry.line),
        kind: "include-line",
        path: host.path,
        line: entry.line,
        marker: entry.marker,
        anchor: host.anchor || undefined,
        content: entry.line,
        classIds: selection,
        ownership: "line",
        provenance,
        template: { name: "activation", version: templateVersion("activation") },
        rationale: "run the committed checks from " + host.path,
      });
    }
  }
  // The other half of the same job, for the repository that has no committed
  // hook to weave into — which is most of them, because `.git/hooks/` is where
  // git looks by default and nothing commits it. jig already wrote a hook
  // there is nothing wrong with; what is missing is git being told to use it,
  // and that is a setting, not a file.
  if (opts["wire-commit"]) {
    const lane = commitLane(root);
    if (lane.state === "live") {
      throw expected("commit-time checks already run here — " + lane.path + " invokes the jig driver." +
        " Nothing to wire.");
    }
    // Repointing git would hide a hook the owner wrote, and a harness that
    // silently disables somebody's own check is worse than one that is not
    // installed. The line goes INTO their hook instead, and that is a different
    // approval.
    if (lane.state === "hook-without-jig") {
      throw expected(lane.path + " is already your commit hook, and pointing git elsewhere would stop it running." +
        "\n  Add jig's line to it instead:\n    " + ACTIVATION.sh.line +
        "\n  See " + STATE_DIR + "/" + ACTIVATION_FILE + ".");
    }
    if (!lane.shimExists) {
      throw expected("there is no hook at " + lane.shim + " to point git at yet." +
        " Run the install first, or use --weave-precommit against a committed hook.");
    }
    const value = STATE_DIR + "/hooks";
    changes.push({
      id: changeId("wire-commit", value),
      kind: "set-git-config",
      path: GIT_SETTING_PATH,
      value,
      classIds: selection,
      ownership: "schema",
      provenance,
      template: { name: "activation", version: templateVersion("activation") },
      rationale: "run the committed checks at commit time, from " + lane.shim,
    });
  }

  // The governance pointer rule: computed from the scan's own orphan list,
  // never from anything a person typed — the same discipline as the config.
  if (opts["wire-governance"]) {
    const { profile } = readProfile(root);
    const orphans = (profile.governance && profile.governance.orphans) || [];
    if (!orphans.length) throw expected("the scan found no orphaned governance docs — nothing to wire");
    const content = orphans.map((p) => "- Before structural work, read `" + p + "` — it governs this repository.").join("\n") +
      "\n\n<!-- " + PROSE_EVIDENCE_MARK + " — governance pointers computed from the scan. evidence: reasoned, claude-opus-5 2026-08 -->\n";
    changes.push({
      id: changeId("jig-governance", content),
      kind: "write-rule",
      path: ".claude/rules/jig-governance.md",
      content,
      classIds: [],
      ownership: "file",
      provenance,
      template: { name: "jig-governance", version: "1.0.0" },
      rationale: "point every session at the governance docs nothing referenced",
    });
  }

  // Written whenever anything was authored at all, discards or none: an absent
  // file and a clean run are the same silence otherwise.
  let discardedFile = null;
  if (authoredChecks.length || admissionResult.discarded.length) {
    admission.writeDiscarded(statePath(root), admissionResult.discarded);
    discardedFile = admissionResult.file;
  }

  return {
    draft: { changes },
    refused,
    selection,
    classes,
    // The loaded editions themselves, so the review can rank a backlog over
    // every class this project matched without loading them a second time.
    loaded,
    provenance,
    mode,
    editions: loaded.map((e) => e.edition),
    toolchain,
    // Three things the owner has to be shown rather than have decided for
    // them: which editions had no project here yet, which tool configs jig
    // refuses to compose and handed back as snippets, and every key two tools
    // disagreed about in a file jig did compose.
    greenfield,
    configNotes: configs.notes,
    configConflicts: configs.conflicts,
    discarded: admissionResult.discarded,
    discardedFile,
    // What this repository was guarding by before the plan. The consent tier of
    // a config change is read against it: a plan that takes a guard away is not
    // the same approval as one that adds three.
    installedGuards: (installedConfig(root) || { guards: [] }).guards.filter((g) => isObject(g)),
  };
}

// ---------------------------------------------------------------------------
// The coverage-by-actor matrix
// ---------------------------------------------------------------------------
//
// The review surface — the screen somebody reads before any guard is written.
// Every cell is computed from two things jig already owns: each detector's own
// metadata — from an edition or from the check the model authored — and the
// changes this plan is about to write. A cell nobody can derive from those two
// goes stale the first time either one moves, and a stale coverage claim is
// worse than no claim at all.
//
// The columns are the engine's actor list, rendered by their exact ids. A
// column comes out GAP everywhere when no detector in this plan names that
// actor — the matrix reporting the truth, not a special case.

const PLAN_MD_FILE = "plan.md";
const PLAN_JSON_FILE = "plan.json";
const BACKLOG_FILE = "backlog.json";

// The release whose artifacts this build can actually generate, and the order
// releases arrive in. A detector on a lever that ships later describes
// coverage jig cannot deliver today, so its cell reads GAP naming the version
// — never DET on a promise. A lever from an EARLIER release stays available;
// availability is an ordering, not an equality.
const RELEASE_ORDER = ["0.1.0-alpha", "0.2.0-alpha", "0.3.0-alpha", "0.4.0-alpha", "0.5.0-alpha", "1.0.0"];
const AVAILABLE_NOW = "0.5.0-alpha";

function leverAvailable(lever) {
  const at = RELEASE_ORDER.indexOf(lever.availableAt);
  return at !== -1 && at <= RELEASE_ORDER.indexOf(AVAILABLE_NOW);
}

// What the repository's own Node toolchain already carries, read from disk.
// Still true, still a fact the interview uses — but no longer the end of the
// story: an absent tool is now an install the owner can approve rather than a
// gap jig stamps and leaves (SCOPE, "What this reverses").
function toolchainFacts(root) {
  const gradleKts = readIfExists(path.join(root, "build.gradle.kts"));
  const gradle = readIfExists(path.join(root, "build.gradle"));
  const gradleText = (gradleKts ? gradleKts.toString("utf8") : "") + (gradle ? gradle.toString("utf8") : "");
  return {
    eslint: fs.existsSync(path.join(root, "node_modules", "eslint")),
    typescript: fs.existsSync(path.join(root, "node_modules", "typescript")),
    gradle: gradleText.length > 0,
    detekt: /detekt/i.test(gradleText),
  };
}

// The edition row for a tool, by the id a detector or a manifest names — so the
// verify command and the expected exit always come from the edition's own
// research rather than from a table in here.
function toolchainToolFor(loaded, toolId) {
  if (!toolId) return null;
  for (const edition of loaded) {
    const hit = (edition.toolchain || []).find((t) => t.id === toolId);
    if (hit) return { edition: edition.edition, ...hit };
  }
  return null;
}

const CELL_RANK = { GAP: 0, PROB: 1, DET: 2 };
const CONSENT_TIERS = ["batch", "item"];

function leverOf(id) {
  return Object.prototype.hasOwnProperty.call(LEVERS, id) ? LEVERS[id] : null;
}

// Deny capability is read off the detector's runner rather than a list of lever
// names, so a lever added later is deny-capable the moment a detector routes it
// through a hook, without anybody remembering to update a list here.
function denyCapable(det) {
  return HOOK_RUNNERS.includes(det.runner);
}

// Which skipped directory a `check-driver` detector has confined itself to, or
// null. The fixture pair cannot see this: a fixture is text and never a file on
// disk, so a check scoped to `.jig/config.json` passes admission and then the
// driver walks straight past the only file it names. jig's own state directory
// is the one every author of a self-protection check reaches for first, which
// is where this was found.
//
// Only literal, non-final segments count. A glob may legitimately end in a file
// named `build` or `vendor`, and a wildcard segment never resolves to a skipped
// name — the walk removed those directories before the glob was ever asked.
//
// An extract detector is blind on either side, and its union side is the worse
// one: a doc the walk never reaches is simply never read, but a union the walk
// never reaches holds none of the names, so the class reports skipped on every
// run. Each side is judged on its own, because a detector with a reachable doc
// and an unreachable union is as blind as one with neither.
function driverBlindDir(det) {
  if (!det || det.lever !== "check-driver") return null;
  const params = det.params || {};
  const sides = Array.isArray(params.extract) && params.extract.length ? ["paths", "pairedWith"] : ["paths"];
  for (const side of sides) {
    const globs = (params[side] || []).filter((p) => typeof p === "string" && p);
    if (!globs.length) continue;
    const blind = globs.map((g) => g.split("/").slice(0, -1).find((seg) => DRIVER_SKIPS.includes(seg)) || null);
    if (blind.every(Boolean)) return blind[0];
  }
  return null;
}

// A driver detector whose only kind is a removal. Since 2.12.0 the driver does
// count removals — but only under `--staged`, which is the commit lane and
// nothing else: `run.mjs` counts nothing on a pathless walk and the CI workflow
// runs it pathless. So this is not "blind" any more, it is "one lane", and
// `commitLaneLive` below is what says whether that lane exists here.
// Only when it is the detector's ONLY kind: a module that also names patterns
// is evaluated on every run.
function removalOnlyDetector(det) {
  if (!det || det.lever !== "check-driver") return false;
  const p = det.params || {};
  const has = (k) => Array.isArray(p[k]) && p[k].length > 0;
  return has("removed") && !has("patterns") && !has("pairedWith");
}

// The floor: something a person or a CI runner can run
// with no agent host involved, and that cannot be wrong about what it found.
function hostNeutralFloor(cls, lane) {
  return cls.detectors.some((d) => {
    const lever = leverOf(d.lever);
    // A driver detector the walk never reaches is host neutral on paper and
    // catches nothing anywhere, which is the enforcement gap this field exists
    // to report. A removal-only one is the same story with a different reason:
    // host neutral, deterministic, and evaluated by nothing at all until a
    // pre-commit hook runs the driver with `--staged`.
    return !!lever && lever.hostNeutral && d.confidence === "deterministic" &&
      !driverBlindDir(d) && (!removalOnlyDetector(d) || lane === true);
  });
}

// The floor as a REPORT (SCOPE, "Does hostNeutralFloor stay a release gate":
// no — a class nothing catches is a disclosed gap, not a refusal). The sentence
// is unchanged; what changed is that it is printed on the plan the owner reads
// instead of thrown before they see anything.
function floorNote(cls, lane) {
  if (hostNeutralFloor(cls, lane)) return null;
  return cls.id + " has no host-neutral deterministic lever in this plan. Nothing a human or a CI runner can run" +
    " catches it, so whatever else the matrix says about it depends on an agent host being in the loop.";
}

function detectorGrade(det) {
  const lever = leverOf(det.lever);
  if (!lever || !leverAvailable(lever)) return "GAP";
  return lever.probabilistic || det.confidence !== "deterministic" ? "PROB" : "DET";
}

// What bounds a PROB cell. jig ships no compliance measurement for any lever, so
// this names the KIND of uncertainty instead of inventing a percentage — a
// number nobody measured is the folklore this plugin exists to avoid.
function detectorCeiling(det) {
  const lever = leverOf(det.lever);
  return lever && lever.probabilistic ? "unmeasured" : det.confidence;
}

// Whether this plan puts the tool in the CI lane — the lane a `tool-rule`
// detector runs in, by the lever's own definition. Read off the plan's own
// changes, like every other cell input: a matrix cell that trusted a
// `verify.json` already on disk would claim coverage from a file this plan is
// not writing.
function verifiesTool(changes, tool) {
  const hit = changes.find((c) => toPosix(c.path) === STATE_DIR + "/" + VERIFY_FILE);
  const entries = hit ? proposedVerifyEntries(hit.content) : null;
  return !!entries && entries.some((e) => e.id === tool && Array.isArray(e.lanes) && e.lanes.includes("ci"));
}

// The installed half of a tool rule: the tool's config artifact in the manifest,
// and the ci-lane entries `.jig/verify.json` already holds. A plan is an
// interview about what to ADD, so a re-plan that ticks no tool proposes neither
// — and grading the cell off this plan's changes alone told an owner their
// linter was uncovered while it sat configured and running in CI. `configFace`
// and `verifyFace` already read the installed side for the files they write;
// this is the matrix reading it for the cell it grades.
function installedToolFace(root) {
  const config = new Map();
  for (const a of readManifest(root).artifacts) {
    const name = a.template && a.template.name;
    if (typeof name !== "string") continue;
    // `toolchain-config-<path>` is a composed file, named after the path rather
    // than a tool, and a plan never gives a composed tool an artifact either.
    if (name.startsWith("toolchain-config-")) continue;
    const prefix = ["toolchain-", "install-"].find((p) => name.startsWith(p));
    if (prefix) config.set(name.slice(prefix.length), a.path);
  }
  const raw = readIfExists(path.join(root, STATE_DIR, VERIFY_FILE));
  const entries = raw === null ? null : proposedVerifyEntries(raw.toString("utf8"));
  const ci = (entries || []).filter((e) => Array.isArray(e.lanes) && e.lanes.includes("ci")).map((e) => e.id);
  // The commit lane, read the same way: a removal is counted by `--staged` and
  // by nothing else, so a removal cell that named its check module in a
  // repository with no hook would be claiming a lane nobody runs.
  // `--wire-commit` is its own plan carrying no coverage, so this can never
  // come from the changes this plan proposes — only from what is installed.
  return { config, ci: new Set(ci), commitLane: commitLane(root).runsChecks };
}

const NO_INSTALLED_TOOLS = { config: new Map(), ci: new Set(), commitLane: false };

// Which artifact does the catching, read off the plan's own changes so a cell
// can never name a file this plan does not write. A hook detector names its
// guard row in the generated config, which is the id the ledger will carry.
function detectorArtifact(cls, det, index, changes, guards, installed) {
  const templated = (name) => {
    const hit = changes.find((c) => c.template && c.template.name === name);
    return hit ? hit.path : null;
  };
  if (det.lever === "check-driver") {
    // A module the driver will never run this detector's paths through catches
    // nothing, whatever the plan installs. Named before the artifact lookup, so
    // no cell can point at a check module as proof of a lane it does not reach.
    if (driverBlindDir(det)) return null;
    // Both halves or nothing, exactly as a tool rule needs its config AND a
    // lane that runs it: a removal is counted under `--staged`, so the module
    // is coverage only where a pre-commit hook runs the driver. The shipped CI
    // workflow runs it pathless, which counts no removals at all.
    if (removalOnlyDetector(det) && !(installed || NO_INSTALLED_TOOLS).commitLane) return null;
    // By what the change is FOR rather than what it was called: an authored
    // check module is named after its own slug, and a cell that keyed on a
    // template name could not see it. The driver itself is deliberately not a
    // match — `run.mjs` runs whatever modules are there, and pointing a
    // coverage cell at it would claim a class is caught by the thing that
    // would have run the check nobody wrote.
    const hit = changes.find((c) => (c.classIds || []).includes(cls.id) &&
      toPosix(c.path).startsWith(STATE_DIR + "/checks/") && toPosix(c.path).endsWith(".check.mjs"));
    return hit ? hit.path : null;
  }
  if (det.lever === "ci-workflow") return templated("ci-workflow");
  if (denyCapable(det)) {
    // The guard id is `<classId>-<detectorId>` — the stable identity the
    // config, the manifest and the ledger all carry since 108.
    const id = cls.id + "-" + det.id;
    const wired = guards.some((g) => g.id === id) && changes.some((c) => c.kind === "write-config");
    return wired ? id : null;
  }
  if (det.lever === "tool-rule") {
    // A tool rule catches nothing until the tool itself is in the plan. The
    // install and the config-only item carry the same tool id, so one lookup
    // covers both.
    //
    // And a config is not a lane. Until 2.9.0 this cell read DET off the config
    // file alone, so the matrix printed `DET eslint.config.mjs` for a CI job
    // that ran the check driver and nothing else — a rule nobody executes,
    // named after a file. Both halves or nothing: a config, and an entry in
    // `.jig/verify.json` that a lane actually runs. Either half may come from
    // this plan or from what is already installed — a re-plan proposes neither
    // and the tool is no less covered for it.
    const tool = det.params && det.params.tool;
    const face = installed || NO_INSTALLED_TOOLS;
    const hit = changes.find((c) => c.template &&
      (c.template.name === "toolchain-" + tool || c.template.name === "install-" + tool));
    const config = hit ? hit.path : (face.config.get(tool) || null);
    return config && (verifiesTool(changes, tool) || face.ci.has(tool)) ? config : null;
  }
  if (det.lever === "agents-region") {
    const hit = changes.find((c) => c.kind === "write-agents-region");
    return hit ? hit.path : null;
  }
  return null;
}

// One detector's cell. `armable` is set on every deny-capable detector whatever
// the cell grades to, because whether a guard CAN block is a different question
// from how well this particular lever happens to be doing.
function detectorCell(cls, det, index, provenance, changes, guards, installed) {
  const lever = leverOf(det.lever);
  const artifact = detectorArtifact(cls, det, index, changes, guards, installed);
  let grade = detectorGrade(det);
  let why = null;
  if (grade === "GAP") {
    why = lever
      ? "the " + det.lever + " lever ships at " + lever.availableAt
      : "this detector names a lever `" + det.lever + "` this build does not run";
  } else if (artifact === null) {
    grade = "GAP";
    // Two gaps are about a lane rather than a file. A tool rule's config is
    // often already there, so naming the artifact it "writes no" sends the owner
    // looking for the wrong thing; what is missing is something running the
    // tool. And a driver detector inside a directory the walk skips has its
    // module installed and still catches nothing, so naming the module would be
    // worse than saying nothing.
    const blind = driverBlindDir(det);
    why = blind ? "the check driver never walks " + blind + "/"
      : removalOnlyDetector(det) ? "a removal is only visible between two versions of a file, so only the" +
        " commit lane counts it — and no pre-commit hook here runs the driver. `jig plan --wire-commit`" +
        " is what turns this cell on"
      : det.lever === "tool-rule"
        ? "no lane runs " + ((det.params && det.params.tool) || det.lever)
        : "this plan writes no " + det.lever + " artifact for " + cls.id;
  }
  return {
    grade,
    lever: det.lever,
    artifact: grade === "GAP" ? null : artifact,
    ceiling: grade === "PROB" ? detectorCeiling(det) : null,
    // What actually arms a guard: the check's own fixture pair passed and the
    // proof hash binds this module to it. Provenance is disclosed on the row
    // and decides nothing here — the runner does not read it either, so a cell
    // claiming it did would be a coverage claim nothing enforces.
    armable: denyCapable(det) ? typeof cls.proof === "string" : null,
    why,
  };
}

function matrixRow(cls, provenance, changes, guards, installed) {
  const cells = {};
  for (const actor of ACTORS) {
    const found = cls.detectors
      .map((det, i) => ({ det, i }))
      .filter(({ det }) => det.actor === actor)
      .map(({ det, i }) => detectorCell(cls, det, i, provenance, changes, guards, installed));
    // Best-of, not first-of: a class with both a shipping lever and a later one
    // for the same actor is covered today by the one that ships today.
    cells[actor] = found.length
      ? found.reduce((best, c) => (CELL_RANK[c.grade] > CELL_RANK[best.grade] ? c : best))
      : { grade: "GAP", lever: null, artifact: null, ceiling: null, armable: null,
        why: "no detector on this class names " + actor };
  }
  const floorCleared = hostNeutralFloor(cls, (installed || NO_INSTALLED_TOOLS).commitLane);
  return {
    classId: cls.id,
    edition: cls.edition || null,
    authored: cls.authored === true,
    title: cls.title,
    severity: cls.severity,
    axes: cls.axes,
    provenance,
    // The floor, reported rather than enforced: a class no host-neutral
    // deterministic lever catches IS the enforcement gap, said once.
    enforcementGap: !floorCleared,
    floorCleared,
    floorNote: floorNote(cls, (installed || NO_INSTALLED_TOOLS).commitLane),
    // The edition's own words about what this class cannot see. Carried through
    // so the matrix can print research instead of jig's paraphrase of it.
    gapNotes: cls.gapNotes || null,
    // What a heuristic check bought up front, disclosed on the row that claims
    // the coverage (SCOPE, "Is any near-miss hit a discard").
    expectedNearMissHits: cls.expectedNearMissHits || 0,
    proof: cls.proof || null,
    cells,
  };
}

// The guard rows a write-config change would leave on disk, or null when the
// change carries no readable config. Null is not "no guards" — a caller that
// cannot see the file must not conclude the file is empty.
function proposedGuards(content) {
  if (typeof content !== "string") return null;
  let record = null;
  try {
    record = JSON.parse(stripBom(content));
  } catch {
    return null;
  }
  if (!isObject(record) || !Array.isArray(record.guards)) return null;
  return record.guards.filter((g) => isObject(g));
}

// Every installed guard this config would take away, by id: one it drops
// outright, or an armed one it steps down. `mode` absent is observe (the runner
// reads it that way), so a row losing its `mode` stops refusing tool calls just
// as surely as a row that is deleted — and a deleted row stops reporting too,
// which is coverage the owner approved and would be losing here.
function guardsWeakened(installed, content) {
  const rows = proposedGuards(content);
  if (!rows) return [];
  const after = new Map(rows.map((g) => [g.id, g.mode]));
  return installed
    .filter((g) => isObject(g) && (!after.has(g.id) || (g.mode === "armed" && after.get(g.id) !== "armed")))
    .map((g) => g.id);
}

// Tiered consent. Batch-approve what only ever reports;
// item-approve anything that can refuse a tool call or fail somebody's build.
// Both tests are mechanical — the change's kind and its target — so no artifact
// lands in the cheap tier because somebody classified it there by hand.
function consentFor(change, guards, installed) {
  if (change.kind === "write-config") {
    // Taking enforcement AWAY is the approval nobody should be able to give in
    // a batch. Named one by one, because "3 guards change mode" is not a thing
    // an owner can check against what they remember installing.
    const weakened = guardsWeakened(installed || [], change.content);
    if (weakened.length) {
      return {
        tier: "item",
        why: "takes " + weakened.length + " installed guard" + (weakened.length === 1 ? "" : "s") +
          " away from what this repository is guarding by: " + weakened.join(", "),
      };
    }
    // Read from the file the plan proposes rather than from the selection that
    // computed it: the face is the installed guards union the new ones, so a
    // re-run adding nothing still hands over every guard already refusing here.
    const wiring = proposedGuards(change.content) || guards;
    if (wiring.length) {
      return {
        tier: "item",
        why: "wires " + wiring.length + " guard" + (wiring.length === 1 ? "" : "s") +
          " into a hook that can refuse a tool call",
      };
    }
  }
  if (change.kind === "include-line") {
    return { tier: "item", why: "edits one line into a file jig does not own" };
  }
  if (change.kind === "write-settings") {
    return { tier: "item", why: "writes into the host's own settings file — the probe-gated capability" };
  }
  if (change.kind === "write-rule") {
    return { tier: "item", why: "adds always-loaded prose every session will carry" };
  }
  if (change.kind === "write-agents-region") {
    return { tier: "item", why: "owns a fenced region inside AGENTS.md, which every Codex session loads" };
  }
  if (change.kind === "run-install") {
    return { tier: "item", why: "runs " + JSON.stringify(change.install ? change.install.command : "an install") + " against this machine" };
  }
  if (change.kind === "set-git-config") {
    return {
      tier: "item",
      why: "changes " + GIT_SETTING + " in this clone, which decides whether your commits are checked at all",
    };
  }
  if (toPosix(change.path).startsWith(".github/workflows/")) {
    return { tier: "item", why: "fails the build for everyone who pushes" };
  }
  // The build verdict itself, and the thing that asks for it. `run.mjs`'s exit
  // code is what the commit hook and the CI job report, and the shim is what
  // makes the commit lane run at all — either one lands under `.jig/` and would
  // otherwise fall through to "reports only", which is the one thing they are
  // not.
  if (toPosix(change.path) === STATE_DIR + "/checks/run.mjs") {
    return { tier: "item", why: "is the check driver every lane runs — its exit code is the commit and CI verdict" };
  }
  if (toPosix(change.path) === STATE_DIR + "/hooks/pre-commit") {
    return { tier: "item", why: "is the hook git runs at commit time, so it decides whether a commit is checked at all" };
  }
  // The lane list. Every command in it runs on somebody's machine or in
  // somebody's CI job, and a non-zero exit from any of them fails their build —
  // which is not "reports only" by any reading.
  if (toPosix(change.path) === STATE_DIR + "/" + VERIFY_FILE) {
    const named = (proposedVerifyEntries(change.content) || []).map((e) => e.id);
    return {
      tier: "item",
      why: "names what the lanes run" + (named.length ? " — " + named.join(", ") : "") +
        " — and a non-zero exit from any of them fails the build",
    };
  }
  // SCOPE, "Which consent tier is an authored check": item. The check driver
  // and CI both run it, so it can fail somebody's build — and it is the thing
  // the owner is really approving when they approve coverage.
  if (toPosix(change.path).startsWith(STATE_DIR + "/checks/") && toPosix(change.path).endsWith(".check.mjs")) {
    return { tier: "item", why: "installs a check the driver and CI both run, so it can fail a build" };
  }
  // The widened boundary's own tier (SCOPE: jig writes anywhere the owner
  // approves BY NAME). Inside `.jig/` a side-file is jig's own reporting;
  // outside it, the file is the owner's and gets approved one at a time.
  if (!toPosix(change.path).startsWith(STATE_DIR + "/")) {
    return { tier: "item", why: "writes " + change.path + ", a file outside .jig/ that is yours" };
  }
  return { tier: "batch", why: "reports only, and refuses nothing" };
}

// The best any detector on this class could do today, used to rank the backlog
// so what comes back next is the thing jig can actually cover.
function bestGrade(cls) {
  return cls.detectors.reduce(
    (best, det) => (CELL_RANK[detectorGrade(det)] > CELL_RANK[best] ? detectorGrade(det) : best), "GAP");
}

// Everything the user did not take, across every edition this project matched.
// Persisted rather than printed, because the re-run ritual (0.5.0) resumes from
// it and a menu nobody wrote down is a menu that has to be rebuilt from scratch
// every time. Ids are namespaced, so a backlog row from the Go edition and one
// from the Python edition are never the same row.
function backlogFor(loaded, selection, lane) {
  const rows = [];
  for (const edition of loaded) {
    for (const cls of edition.classes || []) {
      const id = editionsLib.namespacedId(edition.edition, cls.id);
      if (selection.includes(id)) continue;
      const adapted = { ...cls, id, commentSyntax: (edition.detect && edition.detect.commentSyntax) || null,
        detectors: cls.detectors.map((d, i) => editionsLib.adaptDetector(cls, d, i)) };
      rows.push({
        classId: id,
        edition: edition.edition,
        title: cls.title,
        severity: cls.severity,
        axes: cls.axes,
        enforcementGap: !hostNeutralFloor(adapted, lane),
        best: bestGrade(adapted),
        reason: "not selected",
      });
    }
  }
  return rows;
}

// One tool, as the plan surface and the `toolchain` command both report it.
// `installKind` rides along because a scaffold command and a package install
// are not the same act and must not be described as one (SCOPE).
function toolchainRow(row) {
  const item = row.item;
  return {
    id: item.id,
    role: item.role,
    edition: item.edition,
    installKind: item.installKind,
    present: row.present,
    how: row.how,
    version: row.version,
    packageManager: item.packageManager,
    command: item.command,
    uninstall: item.uninstallCommand,
    configPath: item.configPath,
    wiring: item.wiring,
    ciStep: item.ciStep,
    // Set when this project already carries the tool's config file and jig did
    // not write it. The tool is still installable; its config is not jig's to
    // lay down.
    occupied: row.occupied || null,
  };
}

function buildReview(payload, generated, root) {
  const { selection, classes, provenance, refused, toolchain, discarded, discardedFile, editions } = generated;
  const mode = generated.mode || DEFAULT_INSTALL_MODE;

  const guards = configFromSelection(classes, provenance, mode).guards;
  const artifacts = payload.changes.map((c) => ({
    id: c.id,
    path: c.path,
    kind: c.kind,
    classIds: c.classIds,
    enforcementGap: c.enforcementGap,
    ...consentFor(c, guards, generated.installedGuards || []),
  }));
  const installedTools = installedToolFace(root);
  const backlog = backlogFor(generated.loaded || [], selection, installedTools.commitLane);
  const rows = classes.map((cls) => matrixRow(cls, provenance, payload.changes, guards, installedTools));
  // The exact sentence each armable guard hands back, composed by the hook
  // library itself so the plan cannot describe words other than the ones that
  // ship. Nothing else on this plan shows the owner the text a blocked agent
  // reads, and that text is the whole of what the agent gets.
  // Resolved per DETECTOR, the way `denyOf` resolves it at runtime: a check may
  // state one reply for itself or one per detector, and printing the check's
  // where a detector states its own would show the owner words other than the
  // ones that ship.
  const denyByGuard = new Map();
  for (const cls of classes) {
    for (const det of cls.detectors || []) {
      const deny = (det && det.deny) || cls.deny;
      if (deny) denyByGuard.set(cls.id + "-" + det.id, deny);
    }
  }
  // The harness sentence is gated on the driver, so the preview asks the same
  // question the hook will: is there a `run.mjs` — one this plan writes, or one
  // an earlier install already left behind.
  const hasDriver = payload.changes.some((c) => c.template && c.template.name === "check-driver") ||
    fs.existsSync(path.join(root, STATE_DIR, "checks", "run.mjs"));
  const denyReplies = guards
    .filter((g) => denyByGuard.has(g.id))
    .map((g) => ({ guardId: g.id, text: require("../hooks/jig-lib.js").denyText(g.id, denyByGuard.get(g.id), hasDriver) }));

  const review = {
    schemaVersion: SCHEMA_VERSION,
    kind: "review",
    planId: payload.planId,
    provenance,
    // The mode every guard row in this plan takes. `armed` is what an admitted
    // check earns from its own fixture pair; `observe` is the owner asking for
    // it, never a probation jig imposes.
    mode,
    actors: ACTORS,
    editions,
    denyReplies,
    selection,
    // The derail pass, N14: an `--select` install of a class the catalogue
    // ships with only host-neutral detectors writes no guard that runs inside a
    // session, and nothing on this page said so. The per-actor cells say each
    // class names no session detector; none of them says the install has no
    // session lane at all, which is the thing an owner who works through agents
    // is approving.
    sessionGuards: guards.map((g) => g.id),
    // 2.14.0. A command guard's patterns are matched against the line the shell
    // tool that sent it wrote, and that tool is not always `Bash`. The matrix
    // grades a command guard the same either way — it was proven on its own
    // fixture — so the honest thing is to say so on the page the coverage claim
    // is made. Which tools THIS host sends is not knowable at plan time, and is
    // not guessed here: the ledger answers it once the guards have run.
    commandGuards: classes.some((cls) => (cls.detectors || [])
      .some((d) => require("../hooks/jig-lib.js").isShellLever(d))),
    rows,
    artifacts,
    consent: {
      batch: artifacts.filter((a) => a.tier === "batch").map((a) => a.id),
      item: artifacts.filter((a) => a.tier === "item").map((a) => a.id),
    },
    enforcementGaps: payload.changes.filter((c) => c.enforcementGap).map((c) => c.path),
    // The floor, as a report. Every class nothing host-neutral catches, named
    // on the surface the owner reads instead of thrown before they see it.
    floorGaps: rows.filter((r) => !r.floorCleared).map((r) => ({ classId: r.classId, why: r.floorNote })),
    // Installs and configs the owner is being asked to approve, on the same
    // surface as everything else they approve.
    toolchain: {
      packageManager: toolchain.packageManager,
      items: toolchain.items.map(toolchainRow),
    },
    // Checks the model wrote and the fixture pair threw out. Reported, never
    // hidden — a discard the owner never sees reads as coverage.
    discarded,
    discardedFile,
    refused,
    backlogFile: STATE_DIR + "/" + BACKLOG_FILE,
    backlogCount: backlog.length,
  };
  return { review, backlog };
}

// The one place a cell becomes text. plan.md renders through this and the test
// that compares the two files reads through it, so the markdown cannot drift
// from the JSON without the drift being the thing that fails.
function cellText(cell) {
  if (cell.grade === "GAP") return "GAP — " + (cell.why || "nothing runs here");
  const head = cell.grade === "PROB" ? "PROB(" + cell.ceiling + ")" : "DET";
  const arm = cell.armable === null ? ""
    : cell.armable ? " [proven by its fixture pair]" : " [observe only — no proof binds this check]";
  return head + " " + cell.artifact + arm;
}

function renderReviewMd(review, backlog) {
  const out = [];
  out.push("# jig plan " + review.planId);
  out.push("");
  out.push("Every cell below is computed from each detector's own metadata and from the changes");
  out.push("this plan writes. Nothing here is hand-written prose about coverage.");
  out.push("");
  out.push("- provenance: `" + review.provenance + "`");
  out.push("- mode: `" + review.mode + "` — " + (review.mode === "armed"
    ? "every check below fired on its own violation and stayed silent on its near miss, so it blocks from install"
    : "you asked for observe, so every guard records what it would have blocked and refuses nothing"));
  out.push("- editions read: " + ((review.editions || []).map((e) => "`" + e + "`").join(", ") || "none — every class here was authored"));
  out.push("");
  out.push("## Coverage by actor");
  out.push("");
  out.push("| class | provenance | " + review.actors.join(" | ") + " |");
  out.push("| --- | --- | " + review.actors.map(() => "---").join(" | ") + " |");
  for (const row of review.rows) {
    out.push("| `" + row.classId + "` | " + row.provenance + " | " +
      review.actors.map((a) => cellText(row.cells[a])).join(" | ") + " |");
  }
  out.push("");

  if (review.rows.length && !(review.sessionGuards || []).length) {
    out.push("## No session guard");
    out.push("");
    out.push("This plan installs nothing that runs inside a session. Every detector behind " +
      review.rows.map((r) => "`" + r.classId + "`").join(", ") + " is a committed-lane lever, so these");
    out.push("mistakes are caught by the check driver at commit time and in CI — after the bytes");
    out.push("have landed — and never in the session that wrote them. An edition class carries no");
    out.push("session detector, so a `--select` run installs none: watching one of these in session");
    out.push("means authoring the class a second detector and the fixture pair that proves it.");
    out.push("");
  }

  if (review.commandGuards) {
    out.push("## The shell tool a command guard meets here");
    out.push("");
    out.push("A command guard matches its patterns against the command line exactly as the tool that");
    out.push("sent it wrote it, and that tool is not always called `Bash`: jig's hooks are registered");
    out.push("for " + SHELL_TOOLS.map((t) => "`" + t + "`").join(" and ") + ", and a host that names its shell anything else is a host where these");
    out.push("guards do not evaluate at all.");
    out.push("");
    out.push("It cannot translate one syntax into another, either: a pattern written in POSIX shell");
    out.push("idiom (`&&`, `2>/dev/null`, `| sh`) will not fire on a PowerShell line that does the same");
    out.push("thing. A guard that evaluates and passes is not the same coverage as one that catches, so");
    out.push("read every command guard's patterns against the syntax an agent will actually send here.");
    out.push("");
    out.push("Which of those names this host sends cannot be read before a guard has run, and is not");
    out.push("guessed: `/jig:inventory` reports the ones jig's own hooks have since been seen to record.");
    out.push("");
  }

  const stamped = review.rows.filter((r) => r.enforcementGap);
  if (stamped.length) {
    out.push("## ENFORCEMENT GAP");
    out.push("");
    out.push("Nothing here refuses the plan. These are the classes no host-neutral deterministic");
    out.push("lever catches, said out loud so the matrix above is not read as more than it is:");
    out.push("");
    for (const row of stamped) {
      out.push("- `" + row.classId + "` — " + row.title + (row.gapNotes ? " " + row.gapNotes : ""));
    }
    out.push("");
  }
  const heuristic = review.rows.filter((r) => r.expectedNearMissHits > 0);
  if (heuristic.length) {
    out.push("These checks declared a known false alarm up front and were admitted with it:");
    out.push("");
    for (const row of heuristic) {
      out.push("- `" + row.classId + "` — " + row.expectedNearMissHits + " expected near-miss hit(s)");
    }
    out.push("");
  }
  if ((review.discarded || []).length) {
    out.push("## Discarded");
    out.push("");
    out.push("The model wrote these and the fixture pair threw them out. They are NOT coverage,");
    out.push("and they are written to `" + review.discardedFile + "`:");
    out.push("");
    for (const d of review.discarded) out.push("- `" + d.id + "` — " + d.why);
    out.push("");
  }
  const tools = (review.toolchain && review.toolchain.items) || [];
  if (tools.length) {
    out.push("## Toolchain");
    out.push("");
    out.push("Package manager: `" + (review.toolchain.packageManager || "unresolved") + "`. Nothing below runs");
    out.push("until you approve it by id, and each command is what will run, verbatim:");
    out.push("");
    for (const t of tools) {
      out.push("- **" + t.id + "** (" + (t.role || "tool") + ", " + (t.installKind || "install") + ") — " +
        (t.present ? "already here (" + t.how + (t.version ? " " + t.version : "") + "), config only" : "`" + t.command + "`"));
      out.push("  - config: `" + t.configPath + "`");
      if (t.wiring) out.push("  - wiring: " + t.wiring);
      if (t.ciStep) out.push("  - CI step: `" + t.ciStep + "`");
      out.push("  - undo: " + (t.uninstall ? "`" + t.uninstall + "`" : "nothing to uninstall — jig only writes its config"));
    }
    out.push("");
  }
  if (review.enforcementGaps.length) {
    out.push("These artifacts are written but cannot be read back by jig, so their correctness is");
    out.push("nobody's guarantee:");
    out.push("");
    for (const p of review.enforcementGaps) out.push("- `" + p + "`");
    out.push("");
  }

  out.push("## Consent");
  out.push("");
  out.push("Approve in one go — these only ever report:");
  out.push("");
  for (const a of review.artifacts.filter((x) => x.tier === "batch")) {
    out.push("- `" + a.id + "` → `" + a.path + "` — " + a.why);
  }
  out.push("");
  out.push("Approve one at a time — each of these can refuse something:");
  out.push("");
  const item = review.artifacts.filter((x) => x.tier === "item");
  if (!item.length) out.push("- nothing in this plan can refuse anything");
  for (const a of item) out.push("- `" + a.id + "` → `" + a.path + "` — " + a.why);
  out.push("");

  // The one thing on this plan the owner cannot read anywhere else: the exact
  // sentence a refused call gets back. It ships composed by the hook library, so
  // what is printed here is the string, not a description of it.
  if ((review.denyReplies || []).length) {
    out.push("## What a blocked call will read");
    out.push("");
    out.push("Word for word, the reply each of these guards hands back when it refuses. Approve");
    out.push("the words, not just the guard — this is the whole of what the blocked caller gets:");
    out.push("");
    for (const r of review.denyReplies) out.push("- `" + r.guardId + "` — " + r.text);
    out.push("");
  }

  if (review.refused.length) {
    out.push("## Refused");
    out.push("");
    for (const r of review.refused) out.push("- " + r);
    out.push("");
  }

  out.push("## Backlog");
  out.push("");
  out.push(review.backlogCount + " classes were not selected. They are written to `" +
    review.backlogFile + "` so a later run resumes from them:");
  out.push("");
  for (const b of backlog) out.push("- `" + b.classId + "` (" + b.best + ") — " + b.reason);
  out.push("");
  return out.join("\n");
}

// Written by `plan`, not by `apply`: this is what somebody reads to decide, so
// it has to exist before consent does. Same discipline as the transaction plan
// beside it — it is a review surface, not an installed artifact, so it does not
// go through the journal and `revert` does not take it back out.
function writeReview(root, review, backlog) {
  const write = (name, text) => {
    const rel = STATE_DIR + "/" + name;
    fs.writeFileSync(path.join(root, rel), text);
    return rel;
  };
  const backlogRel = write(BACKLOG_FILE,
    JSON.stringify({ schemaVersion: SCHEMA_VERSION, backlog }, null, 2) + "\n");
  return {
    review: write(PLAN_JSON_FILE, JSON.stringify(review, null, 2) + "\n"),
    rendered: write(PLAN_MD_FILE, renderReviewMd(review, backlog) + "\n"),
    backlog: backlogRel,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// SCOPE step 3, on its own command because the owner ticks the apparatus before
// any plan exists. Nothing here installs anything: proposeInstalls spawns
// nothing at all, and presence only ever asks a tool for its own version.
// A tool with no way back out is refused into `refused` rather than offered.
function cmdToolchain(root, opts) {
  const loaded = resolveEditions(root, opts);
  const ids = loaded.flatMap((e) => (e.toolchain || []).map((t) => t.id));
  const states = manifestStates(root, readManifest(root));
  const proposal = toolchainProposal(root, loaded, { ...opts, tools: ids.join(",") }, states);
  return {
    ok: true,
    editions: loaded.map((e) => e.edition),
    packageManager: proposal.packageManager,
    items: proposal.items.map(toolchainRow),
    refused: proposal.refused,
    // Named here as well as on the plan, because this is the command the skill
    // runs BEFORE it asks anybody to tick a tool — and on a folder with no
    // project in it, half these installs have nowhere to record themselves.
    greenfield: greenfieldEditions(root, loaded, proposal.packageManager),
  };
}

// SCOPE step 5, on its own command because the skill runs admission before it
// builds a plan and has to show the discards first. The verdict is the fixture
// pair and nothing else, and what it threw out is written to
// `.jig/discarded.json` — a report that lives only in a transcript is hidden
// by morning.
function cmdAdmit(root, opts) {
  const from = typeof opts.from === "string" && opts.from ? opts.from
    : typeof opts.authored === "string" && opts.authored ? opts.authored : null;
  if (!from) throw expected("admit needs --from <file> holding the checks you authored");
  const checks = authoredChecksIn(readFromFile(root, from));
  if (!checks) throw expected(from + " has no `checks` array");

  const result = admitAuthored(root, checks);
  ensureStateDir(root);
  admission.writeDiscarded(statePath(root), result.discarded);
  return {
    ok: true,
    admitted: result.admitted.map((a) => ({
      id: a.id,
      check: a.slug,
      // The hash that binds the module to its two fixtures. The manifest
      // records it and the runner re-checks it, so a hand-edited config cannot
      // claim a proof it does not have.
      proof: a.proof,
      violationHits: a.violationHits,
      nearMissHits: a.nearMissHits,
      expectedNearMissHits: a.expectedNearMissHits,
    })),
    discarded: result.discarded,
    discardedFile: result.file,
  };
}

function cmdPlan(root, opts) {
  const from = typeof opts.from === "string" && opts.from ? opts.from : null;
  const record = from ? readFromFile(root, from) : null;
  const fromChecks = record ? authoredChecksIn(record) : null;

  let draft;
  let generated = null;
  // `--wire-commit` is its own reason to plan. It proposes one setting and no
  // coverage, so it needs neither a selection nor an authored check behind it —
  // a repository whose install is already done is exactly where it is used.
  // `--refresh-activation` is the same kind of reason and proposes even less:
  // one file, put back in step with a lane that is already live.
  if (typeof opts.select === "string" || typeof opts.authored === "string" || fromChecks ||
      opts["wire-commit"] || opts["refresh-activation"]) {
    generated = draftFromTemplates(root, opts, fromChecks || undefined);
    draft = generated.draft;
  } else if (record) {
    draft = record;
  } else {
    throw expected("plan needs --from <file> — the checks you authored, or a draft plan (`--from -` reads one" +
      " on stdin) — or --select <classId,…> to generate one from the editions");
  }
  const { problems, payload } = planFromDraft(draft, root);
  if (problems.length) throw expected("The draft plan was rejected:\n  - " + problems.join("\n  - "));

  // Built after the draft is canonical. A hand-written draft has no selection
  // behind it and gets no review surface, for the same reason it gets no
  // manifest: neither would be a record of anything jig decided.
  const built = generated ? buildReview(payload, generated, root) : null;

  ensureStateDir(root);
  const rel = STATE_DIR + "/plan-" + payload.planId + ".json";
  fs.writeFileSync(path.join(root, rel), JSON.stringify(payload, null, 2) + "\n");
  const written = built ? writeReview(root, built.review, built.backlog) : null;
  return {
    ok: true,
    planId: payload.planId,
    plan: rel,
    // The review surface, named on the result so a caller never has to guess
    // which of the files in `.jig/` is the one a person is meant to read.
    review: written ? written.rendered : null,
    matrix: written ? written.review : null,
    backlog: written ? written.backlog : null,
    consent: built ? built.review.consent : null,
    changes: payload.changes.map((c) => ({
      id: c.id, kind: c.kind, path: c.path, creates: c.sourceHash === null,
      eol: c.eol, bom: c.bom, verifyBy: c.verifyBy, enforcementGap: c.enforcementGap,
      // The setting's whole content is its value, so a change list that hid it
      // would name a change without saying what it does.
      value: c.value,
    })),
    enforcementGaps: payload.changes.filter((c) => c.enforcementGap).map((c) => c.path),
    selection: generated ? generated.selection : null,
    editions: generated ? generated.editions : null,
    provenance: generated ? generated.provenance : null,
    // The mode every guard row takes, said on the result as well as in plan.md
    // — the owner is approving a config that blocks, and that is not a detail
    // to leave in a rendered file.
    mode: generated ? generated.mode : null,
    // Slots this selection wanted and could not have. Surfaced on the plan
    // rather than swallowed, because a plan that quietly installs three of the
    // four things you asked for is the plan that lies to you. An occupied slot
    // is a disclosed gap now, not a refusal — the driver and CI still cover the
    // class, and this line is how the owner learns what they did not get.
    refused: generated ? generated.refused : [],
    // Checks the fixture pair threw out, and where they are written down.
    discarded: generated ? generated.discarded : [],
    discardedFile: generated ? generated.discardedFile : null,
    // Classes nothing host-neutral catches. A report since SCOPE, never a
    // refusal.
    floorGaps: built ? built.review.floorGaps : [],
    // The installs and configs waiting on approval, with the exact command.
    toolchain: built ? built.review.toolchain : null,
    // Editions with no project on disk yet. A row carrying `sample` is one jig
    // writes a starter for; a row carrying `hint` is one only the owner can
    // create, and the hint is the sentence to put to them.
    greenfield: generated ? generated.greenfield : [],
    // Tool configuration jig will NOT write, because several tools share a
    // file it cannot compose. Each note carries the snippet and where it goes.
    configNotes: generated ? generated.configNotes : [],
    // Keys two tools set differently in a file jig did compose. The first
    // writer's value is in the file; this is what was dropped to get there.
    configConflicts: generated ? generated.configConflicts : [],
  };
}

// `internal` is the third positional argument and is unreachable from the CLI:
// `main` calls every command with exactly two. It is how jig's own already-
// approved transactions — `arm`, which the owner asked for by guard id, and
// `migrate`, which rewrites an install the owner already has — replay a whole
// plan they wrote themselves. Nothing an owner types can set it.
function cmdApply(root, opts, internal) {
  const named = opts.change.filter((c) => typeof c === "string" && c);
  // The approval token, both halves of it (SCOPE, "What is the approval
  // token"): a change id alone does not name a path, so an edited plan could
  // point an approved id somewhere else entirely. They are paired by position
  // and a mismatch is a refusal.
  const paths = (Array.isArray(opts.path) ? opts.path : opts.path === undefined ? [] : [opts.path])
    .filter((p) => typeof p === "string" && p);
  let selected = [];
  let skipped = [];
  let planId = null;
  if (named.length) {
    if (paths.length !== named.length) {
      throw expected("apply needs one --path <rel> beside every --change <id>: " + named.length + " change" +
        (named.length === 1 ? "" : "s") + " named, " + paths.length + " path" + (paths.length === 1 ? "" : "s") +
        " given. The id says what to do and the path says where — approving one without the other is approving" +
        " a destination nobody read.");
    }
    named.forEach((id, i) => {
      const hit = findChange(root, id);
      if (toPosix(hit.change.path) !== toPosix(paths[i])) {
        throw expected("Refusing to apply " + id + ": it writes " + hit.change.path + ", and the approval names " +
          toPosix(paths[i]) + ". Nothing was written.");
      }
      planId = hit.plan.planId;
      selected.push(hit.change);
    });
  } else if (typeof opts.plan === "string") {
    const record = findPlan(root, opts.plan);
    planId = record.planId;
    // A change this repository already carries is not part of this approval.
    // Without the filter the item-tier refusal below fires for ever: once the
    // owner has approved every item pair by name, the batch half of the same
    // plan — the config, the activation note, the driver, the shim — stays
    // unreachable by `--plan`, which is the batch tier's whole point, and the
    // refusal's "Approve each one by name" is then a promise it does not keep.
    // What is skipped is named back on the result rather than dropped in
    // silence (SCOPE, "May a batch approval skip a change already applied").
    const journal = replayJournal(readJournal(root));
    skipped = record.changes.filter((c) => {
      const state = journal.get(c.id);
      if (state === undefined || changeState(state) !== "applied") return false;
      // The journal records what jig did, not what the repository still has. A
      // file jig wrote and somebody later deleted replays as `applied` for ever,
      // so skipping on that record alone would end re-apply repair: running the
      // approved plan again would report `ok` having written nothing back, and
      // `.jig/checks/run.mjs`, `.jig/config.json` and `.jig/activation.md` would
      // be unrecoverable by the one route that used to restore them. The disk is
      // the authority. A setting is not a file and has no path to stat.
      return [...state.writes.values()]
        .every((w) => w.path === GIT_SETTING_PATH || fs.existsSync(path.join(root, w.path)));
    });
    selected = record.changes.filter((c) => !skipped.includes(c));
    // The widened form SCOPE forbids. A plan id names no path, so approving one
    // approves every destination in it sight unseen — which is exactly the
    // "one approval that lands many writes" the write boundary exists to stop.
    // The engine runs the same tier function the review surface printed, and
    // anything in the item tier has to come back one pair at a time.
    if (!internal) {
      const installed = (installedConfig(root) || { guards: [] }).guards.filter((g) => isObject(g));
      // `guards` is only consentFor's fallback for a write-config it cannot
      // parse; falling back to the installed rows keeps an unreadable config in
      // the item tier instead of waving it through as reporting-only.
      const item = selected.filter((c) => consentFor(c, installed, installed).tier === "item");
      if (item.length) {
        throw expected("Refusing to apply plan " + planId + " as a whole: " + item.length + " of its changes can" +
          " refuse a tool call or fail a build, and --plan names no path for any of them. Approve each one by" +
          " name:\n" + item.map((c) => "  --change " + c.id + " --path " + toPosix(c.path)).join("\n") +
          "\nNothing was written.");
      }
    }
  } else {
    throw expected("apply needs --change <id> --path <rel> (repeatable) or --plan <id> — the argument is the" +
      " approval boundary");
  }

  // Read again here, against the bytes about to land. `planFromDraft` refuses to
  // COMPOSE a config that disarms the repository; a plan file is a file, and the
  // approved token names a change in it rather than the content it held when it
  // was reviewed. This is the gate on what is written.
  for (const change of selected) {
    if (change.kind !== "write-config") continue;
    const dropped = emptiesConfig(root, change.path, change.content);
    if (dropped) throw expected("Refusing to apply " + change.id + ": " + dropped + " Nothing was written.");
  }

  const tx = hashBytes(Buffer.from(String(planId) + "|" + selected.map((c) => c.id).join(",") + "|" + new Date().toISOString()))
    .slice(0, 12);
  const ctx = { tx, plan: planId };
  const results = [];
  try {
    for (const change of selected) results.push(applyChange(root, ctx, change));
  } catch (err) {
    // Earlier changes in this transaction stay applied and journalled — they
    // are individually reversible, and silently undoing approved work because a
    // later change failed is a decision the user did not make.
    if (err.expected && results.length) {
      err.message += "\n  Already applied in this run and left in place (revert them by id if you want them gone): " +
        results.map((r) => r.change).join(", ");
    }
    throw err;
  }
  const manifest = writeManifest(root, ctx, selected, results);
  return {
    ok: true,
    tx,
    plan: planId,
    applied: results,
    // Changes this plan carries that the repository already has. Named, never
    // silent: a batch approval that quietly dropped half its list would be the
    // coverage claim SCOPE forbids.
    skipped: skipped.map((c) => ({ change: c.id, path: c.path })),
    enforcementGaps: results.filter((r) => r.enforcementGap).map((r) => r.path),
    manifest: manifest ? STATE_DIR + "/" + MANIFEST_FILE : null,
    // Everything the user now has to do by hand, in one place: whatever jig
    // could not vet, or was never approved to write, lands here as a proposal.
    proposals: proposalNotes(root, results),
  };
}

// Recorded after the transaction, not inside it: a row names the transaction
// that installed it, and no change can carry an id that does not exist yet.
// A plan with no templates behind it — a hand-written draft, an engine test —
// writes no manifest at all, which is what keeps the manifest a record of what
// jig generated rather than of everything the engine was ever pointed at.
function writeManifest(root, ctx, selected, results) {
  const applied = new Map(results.map((r) => [r.change, r]));
  const rows = selected
    .filter((c) => c.template && applied.has(c.id))
    .map((c) => {
      const buf = readIfExists(path.join(root, c.path));
      return {
        id: c.id,
        classIds: c.classIds || [],
        kind: c.kind,
        path: c.path,
        ownership: c.ownership || "file",
        hash: buf === null ? null : hashBytes(buf),
        // No `mode` row here. A mode belongs to a guard and the config is where
        // guards live (SCOPE, "Does top-level config.mode survive"); a second
        // copy on an artifact row is a field that goes stale the first time
        // anybody arms or disarms anything.
        provenance: c.provenance || "assumed",
        // What binds a proof to the check it proves (SCOPE): a hash over the
        // module and both fixtures. A config claiming a guard is proven can be
        // checked against this and caught.
        proof: c.proof || null,
        // A tool jig installed is a tool `revert` removes, and this is the
        // command that removes it — recorded, shown, never run silently.
        install: c.kind === "run-install" && c.install
          ? { tool: c.install.id, packageManager: c.install.packageManager, command: c.install.command, uninstall: c.install.uninstallCommand }
          : null,
        // Why this artifact is here, carried from the plan item the owner
        // approved rather than recomputed. Additive and optional, so an older
        // jig ignores the field instead of refusing a manifest it reads as
        // newer; a row written before the field existed answers from the plan
        // file it was applied from, which is still on disk beside it.
        rationale: c.rationale || null,
        template: c.template,
        state: "active",
        installedAt: new Date().toISOString(),
        txId: ctx.tx,
      };
    });
  if (!rows.length) return null;

  const byId = new Map(readManifest(root).artifacts.map((a) => [a.id, a]));
  for (const row of rows) {
    // A change id carries the content hash, so rewriting an artifact from a
    // different template — or the same one at a new version — arrives under a
    // new id. Keyed by id alone the old row survives beside the new one, both
    // claiming the same path, and every reader that looks a path up by name
    // gets whichever came first. The path is what a file is; the id is only
    // how this write was named.
    for (const [id, a] of byId) if (a.path === row.path && id !== row.id) byId.delete(id);
    byId.set(row.id, row);
  }
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    artifacts: [...byId.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };

  const rel = STATE_DIR + "/" + MANIFEST_FILE;
  const style = detectStyle(readIfExists(path.join(root, rel)));
  const change = { id: "manifest-" + ctx.tx, kind: "write-side-file", path: rel };
  const check = journalledWrite(root, ctx, change, applyStyle(JSON.stringify(payload, null, 2) + "\n", style));
  if (check.problem) {
    // Same rule as any other change: an artifact that does not read back gets
    // put back the way it was before anybody hears about it.
    const state = replayJournal(readJournal(root)).get(change.id);
    const write = state && state.writes.get(rel);
    if (write) restoreWrite(root, ctx, change.id, write, "post-write validation failed");
    throw expected("the manifest was written and did not read back: " + check.problem);
  }
  return payload;
}

// What is left for the owner to do, in one place, said as an outcome rather
// than a mechanism. The commit-time half is asked of the repository rather than
// assumed: a hook that already runs the checks gets no note at all, because a
// leftover task nobody has is noise that makes the real ones easier to skip.
function proposalNotes(root, results) {
  const notes = [];
  const wrote = new Set(results.map((r) => r.path));
  const lane = commitLane(root);
  if (wrote.has(STATE_DIR + "/" + ACTIVATION_FILE) && lane.state !== "live") {
    notes.push("Your checks run in CI, and CI catches everything before it merges. What is missing is the" +
      " earlier catch, on your own machine, at the moment you commit — so a mistake never reaches a" +
      " pull request at all." +
      (lane.state === "hook-without-jig"
        ? "\n  You already have a commit hook at " + lane.path + ". Add jig's one line to it:" +
          "\n    " + ACTIVATION.sh.line +
          "\n  " + STATE_DIR + "/" + ACTIVATION_FILE + " has the same line for other kinds of hook."
        : "\n  jig wrote a ready-made hook at " + lane.shim + ". One command tells git to use it:" +
          "\n    git config " + GIT_SETTING + " " + STATE_DIR + "/hooks" +
          "\n  Or have jig propose that as an approved, reversible change instead: " + WIRE_COMMIT_FIX +
          "\n  " + STATE_DIR + "/" + ACTIVATION_FILE + " explains both routes and what each costs.") +
      "\n  Skipping this costs you nothing except finding out later. CI still stops the merge.");
  }
  if (wrote.has(STATE_DIR + "/" + PERMISSIONS_FILE)) {
    notes.push("Permission rules are proposed, not applied. " + STATE_DIR + "/" + PERMISSIONS_FILE + " says what" +
      " jig's guards watch and why a permission rule cannot express the same thing. jig never edits your settings.");
  }
  return notes;
}

function cmdStatus(root) {
  // Reads only. `status` on a repository jig has never touched must not create
  // `.jig/` as a side effect of asking.
  const file = statePath(root, JOURNAL_FILE);
  const rows = readJournal(root);
  const changes = [...replayJournal(rows).values()].map((c) => ({
    id: c.id,
    tx: c.tx,
    plan: c.plan,
    state: changeState(c),
    rejected: c.rejected,
    files: [...c.writes.values()].sort((a, b) => a.order - b.order).map((w) => w.path),
    enforcementGap: [...c.writes.values()].some((w) => w.gap),
  }));
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    journal: fs.existsSync(file) ? STATE_DIR + "/" + JOURNAL_FILE : null,
    plans: planFiles(root).map((f) => STATE_DIR + "/" + path.basename(f)),
    changes,
    open: changes.filter((c) => c.state === "applied" || c.state === "interrupted").map((c) => c.id),
  };
}

function cmdRevert(root, opts) {
  const rows = readJournal(root);
  const all = replayJournal(rows);
  let targets;
  if (opts.change.length) {
    targets = opts.change.map((id) => {
      const c = all.get(id);
      if (!c) throw expected("the journal has no change " + id + " — nothing was applied under that id");
      return c;
    });
  } else if (typeof opts.tx === "string") {
    targets = [...all.values()].filter((c) => c.tx === opts.tx);
    if (!targets.length) throw expected("the journal has no transaction " + opts.tx);
  } else if (opts.all) {
    targets = [...all.values()];
  } else {
    throw expected("revert needs --change <id> (repeatable), --tx <id>, or --all");
  }

  const report = [];
  // Newest write first, so a file two changes both touched comes back through
  // the same states it went out by.
  const live = targets
    .flatMap((c) => [...c.writes.values()].filter((w) => w.written && !w.restored).map((w) => ({ c, w })))
    .sort((a, b) => b.w.order - a.w.order);

  if (!live.length) {
    return { ok: true, reverted: [], note: "nothing to revert — every journalled write is already restored" };
  }

  // The guard: a file edited since jig wrote it holds work jig never saw, and
  // restoring the pre-image would throw that away. Refuse by default, name the
  // file, and make --force the explicit way to say "yes, discard it".
  if (!opts.force) {
    // One question per path, asked of the newest live write for it — `live` is
    // newest first, so that is the first row a path appears in. An older write
    // to the same path was superseded by jig, not by the owner: every apply
    // rewrites the manifest, and asking the disk about write N after write N+1
    // landed made jig accuse itself of being a human edit.
    const asked = new Set();
    const drifted = live.filter(({ w }) => {
      if (asked.has(w.path)) return false;
      asked.add(w.path);
      // Same question for the setting, asked of git instead of the disk: is the
      // value still the one jig left there, or did somebody move it since.
      const now = w.path === GIT_SETTING_PATH ? settingBytes(root) : readIfExists(path.join(root, w.path));
      return now === null ? w.hashAfter !== null : hashBytes(now) !== w.hashAfter;
    });
    if (drifted.length) {
      throw expected("Refusing to revert: " + drifted.map(({ w }) => w.path).join(", ") +
        " changed after jig wrote it, so the pre-image would discard that edit." +
        "\n  Re-run with --force to restore the journalled pre-image anyway. Nothing was restored.");
    }
  }

  for (const { c, w } of live) {
    // An install journals every file its ecosystem could have written, so some
    // of those paths never existed and still do not. Saying "removed" about
    // one of them would be a report of work nobody did.
    const setting = w.path === GIT_SETTING_PATH;
    const there = setting ? gitConfig(root, GIT_SETTING) !== null : fs.existsSync(path.join(root, w.path));
    restoreWrite(root, { tx: c.tx, plan: c.plan }, c.id, w, opts.force ? "revert --force" : "revert");
    report.push({
      change: c.id,
      path: w.path,
      outcome: w.preImage !== null ? "restored" : there ? (setting ? "unset" : "removed") : "absent",
    });
  }
  // The manifest and the lockfile are back as they were; the packages on this
  // machine are not, and jig will not run that command behind your back
  // (SCOPE, "How is an install undone").
  const reconcile = [...new Set(live.map(({ w }) => w.reconcile).filter(Boolean))];
  return {
    ok: true,
    reverted: report,
    reconcile,
    notes: reconcile.length
      ? ["The manifest and lockfile are restored. The packages themselves are still installed — run each of these" +
        " yourself to finish undoing it: " + reconcile.join(" ; ")]
      : [],
  };
}

// ---------------------------------------------------------------------------
// selftest — the witnessed catch
// ---------------------------------------------------------------------------
//
// The interview is not finished when the files are on disk. It is finished
// when somebody has watched a guard catch something, because
// an installed guard that never fires and a guard that cannot fire look
// identical from the outside.
//
// Degrade, never stall. Every probe that cannot run reports the exact command
// and the exact thing to look for, and the run still finishes. A close that
// aborted because node was behind a version manager would punish the user for
// the one hazard scan already warned them about.

const RUNNER_PATH = path.join(path.dirname(__dirname), "hooks", "runner.js");
const LEDGER_FILE = "ledger.jsonl";
const DRIVER_PATH = STATE_DIR + "/checks/run.mjs";

// One synthetic tool call per installed guard, built from that guard's own
// check: the violation fixture admission already proved it fires on. There is
// no probe table in here any more — a table keyed on class names could only
// ever witness the four classes jig 1.0.1 shipped, and a witnessed close that
// cannot see an authored check is not a close at all.
function guardProbe(guard, record) {
  const mod = record.mod || {};
  const violation = mod.fixtures && mod.fixtures.violation;
  if (typeof violation !== "string" || !violation.trim()) return null;
  const what = "the violation fixture `" + guard.check + "` was admitted on";
  // Which tool call to build is the detector's lever's answer, not the event's:
  // a bash guard and an edit guard both run at PreToolUse, and probing one with
  // the other's payload reports `caught: false` for a healthy guard.
  const { LEVER_TOOLS, isShellLever } = require("../hooks/jig-lib.js");
  const det = (Array.isArray(mod.detectors) ? mod.detectors : [])
    .find((d) => d && d.runner === guard.runner && LEVER_TOOLS[d.lever]) || {};
  if (isShellLever(det)) {
    // Any name on the shared list evaluates the same guard, so the first is as
    // good as the last; what matters is that the payload is a shell call rather
    // than an edit.
    return { event: guard.runner, tool: SHELL_TOOLS[0], input: { command: violation }, what };
  }
  // The blanker reads comment and string syntax off a filename, and the guard
  // reads its own `paths` off it too, so the seeded path is derived from the
  // detector's own first glob rather than dropped at the root: a probe outside
  // a directory-scoped guard's globs reports `caught: false` for a guard doing
  // exactly what it was installed to do.
  const file_path = fixturePath({ params: det.params || {} });
  return { event: guard.runner, tool: "Write", input: { file_path, content: violation }, what };
}

function ledgerLines(root) {
  const buf = readIfExists(statePath(root, LEDGER_FILE));
  return buf === null ? 0 : buf.toString("utf8").split("\n").filter((l) => l.trim()).length;
}

// Enough of a linter's own words to read what it did — and no more. The close
// report prints this verbatim, and a tool that spilled a whole tree's
// diagnostics into it would bury the rest of the close.
const PROBE_OUTPUT_MAX = 4000;

// A probe never throws. It either ran and says what it saw, or it did not run
// and says what to run instead.
function runProbe(root, guardId, probe, live) {
  const payload = { session_id: "jig-selftest", tool_name: probe.tool, tool_input: probe.input };
  const command = "echo '" + JSON.stringify(payload) + "' | node " + JSON.stringify(RUNNER_PATH) + " " + probe.event;
  const expected_ = 'the runner names guard ' + guardId + ' with a "deny" or "would-deny" decision';
  const base = { probe: guardId, kind: "guard", event: probe.event, what: probe.what, command, expected: expected_ };
  if (!live) return { ...base, ran: false, why: "selftest was not run with --live" };

  const run = spawnSync(process.execPath, [RUNNER_PATH, probe.event], {
    cwd: root, input: JSON.stringify(payload), encoding: "utf-8", windowsHide: true,
  });
  if (run.error) return { ...base, ran: false, why: "node could not be spawned (" + run.error.message + ")" };
  let out = null;
  try {
    out = JSON.parse(run.stdout);
  } catch (err) {
    return { ...base, ran: true, caught: false, why: "the runner printed nothing readable", stderr: (run.stderr || "").trim() || null };
  }
  const jig = (out && out.jig) || {};
  // Both decisions are a catch. An armed guard says `deny` and an observing one
  // says `would-deny`; grading only the second would report the guards that
  // actually block as the ones that caught nothing.
  const fired = (jig.guards || []).filter((g) => g.decision === "would-deny" || g.decision === "deny");
  return {
    ...base,
    ran: true,
    caught: fired.length > 0,
    decision: jig.decision || null,
    mode: jig.mode || null,
    // Shown verbatim, because "it works" from the thing under test is not
    // evidence and the user asked to see the catch.
    output: run.stdout.trim(),
  };
}

function runDriverProbe(root, live) {
  const rel = DRIVER_PATH;
  const command = "node " + rel + " --selftest";
  const expected_ = "every check reports `caught`, and the command exits 0";
  const base = { probe: "check-driver", kind: "checks", command, expected: expected_ };
  if (!fs.existsSync(path.join(root, rel))) return { ...base, ran: false, why: rel + " is not installed here" };
  if (!live) return { ...base, ran: false, why: "selftest was not run with --live" };

  const run = spawnSync(process.execPath, [path.join(root, rel), "--selftest"], {
    cwd: root, encoding: "utf-8", windowsHide: true,
  });
  if (run.error) return { ...base, ran: false, why: "node could not be spawned (" + run.error.message + ")" };
  return { ...base, ran: true, caught: run.status === 0, exitCode: run.status, output: (run.stdout || "").trim() };
}

// One tool proven, start to finish: the baseline first, then the seeded run.
// The seed is jig's own bytes in the owner's tree, so it is journaled going in
// and journaled coming out — a crash between the two rows leaves a line naming
// the file it left behind rather than a mystery under `.jig/`.
function execToolchainProbe(root, tool, base) {
  // The shim is only a dead end when there is no JS entry beside it. `npx` has
  // one, so the JS toolchain is provable on Windows; `./gradlew` does not, and
  // stays a stated limit rather than a skip that reads as a pass.
  const shim = toolchainLib.shellFreeArgv(tool.verify.argv) ? null : toolchainLib.windowsShim(tool.verify.argv[0]);
  if (shim) {
    // Never a skip that reads as a pass. The tool is installed; jig opens no
    // shell, and Node will not start a batch shim without one. That is a limit
    // stated as one, with the command to run by hand printed beside it.
    return { ...base, ran: false, cannotRun: true,
      why: tool.verify.argv[0] + " is a Windows batch shim (" + shim + ") and jig runs every command without" +
        " a shell, so it cannot start this one. Nothing was proven and nothing passed — run it yourself" };
  }
  let baseline;
  try {
    baseline = toolchainLib.execBaseline(root, tool);
  } catch (err) {
    if (!err.expected) throw err;
    return { ...base, ran: false, cannotRun: true, why: err.message };
  }
  // The seed goes where the edition says, at the project root, because that is
  // the only place the project's own tool looks. Nested under `.jig/` it was
  // outside every shipped config's reach — eslint's `globalIgnores` names
  // `.jig/**` and tsconfig's `include` names `src` and `tests` — so the tool
  // exited 0 over a violation it never read and every JavaScript install
  // ledgered `unverified`. `execVerify` refuses rather than writes over a path
  // the project already owns, so a seed named after a manifest is a disclosed
  // "cannot plant" instead of a clobbered `Cargo.toml`.
  const seeded = toPosix((tool.seed && tool.seed.path) || "");
  const tx = hashBytes(Buffer.from(seeded + "|" + new Date().toISOString(), "utf8")).slice(0, 12);
  appendJournal(root, { event: "seed", tx, tool: tool.id, path: seeded });
  try {
    const proof = toolchainLib.execVerify(root, tool, ".");
    return {
      ...base, ran: true, caught: proof.caught, code: proof.code,
      // The guard probes print their runner's stdout verbatim, and that is what
      // makes a catch legible. A toolchain probe owes the owner the same, but a
      // linter over a whole tree is not one JSON object, so it is capped here
      // rather than read out unbounded.
      output: proof.output.length > PROBE_OUTPUT_MAX
        ? proof.output.slice(0, PROBE_OUTPUT_MAX) + "\n… truncated at " + PROBE_OUTPUT_MAX + " characters"
        : proof.output,
      // A repository whose baseline is already red fails the seeded run for the
      // reason it failed the baseline, and the seed proved nothing. SCOPE step
      // 8: that is disclosed as `baseline: red`, never counted as a catch.
      verdict: proof.caught && baseline.baseline === "clean" ? "verified" : "unverified",
      baseline: baseline.baseline, baselineExit: baseline.code,
    };
  } catch (err) {
    if (!err.expected) throw err;
    return { ...base, ran: false, why: err.message, baseline: baseline.baseline, baselineExit: baseline.code };
  } finally {
    removeSeed(root, seeded);
    appendJournal(root, { event: "seed-removed", tx, tool: tool.id, path: seeded });
  }
}

// The seed file and every directory the planting created for it, and nothing
// else: `rmdirSync` refuses a directory with anything left in it, so a `src`
// the project already had survives and a `tests` jig made goes with the seed.
function removeSeed(root, rel) {
  fs.rmSync(path.join(root, rel), { force: true });
  let dir = path.dirname(path.join(root, rel));
  while (dir !== root && dir.startsWith(root)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

// One probe per installed toolchain side-file, and the one place jig starts
// somebody's linter. It is opt-in per tool — `selftest --live --toolchain <ids>`
// — because a type check or a test run costs a build (tsc) or a JVM (detekt),
// and a close that silently spent three minutes is a close nobody runs. A tool
// this run did not name degrades to the exact command and the expected exit
// code, never a stall.
function runToolchainProbes(root, live, wanted) {
  let artifacts = [];
  try {
    artifacts = readManifest(root).artifacts.filter((a) =>
      a.template && typeof a.template.name === "string" && a.state !== "retired" &&
      (a.template.name.startsWith("toolchain-") || a.template.name.startsWith("install-")));
  } catch {
    return [];
  }
  if (!artifacts.length) return [];

  let loaded = [];
  try {
    loaded = resolveEditions(root, {});
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const artifact of artifacts) {
    const toolId = artifact.template.name.replace(/^(?:toolchain|install)-/, "");
    if (seen.has(toolId)) continue;
    seen.add(toolId);
    const tool = toolchainToolFor(loaded, toolId);
    if (!tool || !tool.verify || !Array.isArray(tool.verify.argv)) continue;
    // The proof of a tool config is the tool's own verify run over a seeded
    // violation, and its expected exit code is machine-readable — which is not
    // always 1.
    const base = {
      probe: "toolchain-" + tool.id,
      kind: "toolchain",
      artifact: artifact.path,
      command: tool.verify.argv.join(" "),
      expectedExit: tool.verify.expectedExit,
      expected: tool.verify.expected,
      seed: tool.seed ? tool.seed.path : null,
    };
    if (!live) {
      out.push({ ...base, ran: false, why: "selftest was not run with --live" });
      continue;
    }
    if (!wanted.has(tool.id) && !wanted.has("all")) {
      out.push({ ...base, ran: false,
        why: "jig does not spawn " + tool.id + " unless the run names it — re-run with --toolchain " + tool.id });
      continue;
    }
    out.push(execToolchainProbe(root, tool, base));
  }
  return out;
}

// The violation the commit-lane clone stages: the first installed check's own
// fixture, at a path its own globs match — the same derivation the guard probes
// use, for the same reason.
function stagedSeed(root, lib) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, STATE_DIR, "checks")).filter((f) => f.endsWith(".check.mjs")).sort();
  } catch {
    return null;
  }
  for (const file of names) {
    const record = lib.loadCheck(root, file.replace(/\.check\.mjs$/, ""));
    const mod = record.mod || {};
    const violation = mod.fixtures && mod.fixtures.violation;
    const det = (Array.isArray(mod.detectors) ? mod.detectors : []).find((d) => d && d.runner === "checks");
    if (!det || typeof violation !== "string" || !violation.trim()) continue;
    return { path: fixturePath({ params: det.params || {} }), content: violation, check: mod.id || file };
  }
  return null;
}

// The commit lane, executed instead of described. The shim is a shell script git
// runs in an environment nobody controls — fnm, nvm and volta all put node on a
// PATH a hook does not always inherit — so the only honest report is what
// happens when it runs. It runs over a throwaway clone of the install: the real
// repository's index is not this probe's to stage into, and the shim appends a
// row to `.jig/lane.log` down every path it takes.
//
// `git hook run` and not `sh`: git starts a hook through its own shell, which on
// Windows is the one git ships and nothing on PATH. Running the shim any other
// way would prove a lane nobody has.
function runCommitLaneProbe(root, live, lib) {
  const rel = STATE_DIR + "/hooks/pre-commit";
  const base = {
    probe: "commit-lane", kind: "commit-lane",
    command: "git -c core.hooksPath=" + STATE_DIR + "/hooks hook run pre-commit" +
      "   (over a staged violation, in a throwaway clone of the install)",
    expected: "the shim runs, finds node on PATH, and exits non-zero on the staged violation",
  };
  if (!fs.existsSync(path.join(root, rel))) return { ...base, ran: false, why: rel + " is not installed here" };
  if (!live) return { ...base, ran: false, why: "selftest was not run with --live" };
  const seed = stagedSeed(root, lib);
  if (!seed) {
    return { ...base, ran: false,
      why: "no installed check carries a `checks` detector with a violation fixture the clone could stage" };
  }

  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "jig-lane-"));
  try {
    // The install as a teammate cloning the repository would get it, minus
    // `verify.json`: a clone has no dependencies installed, so the opt-in lane
    // would report a linter that is not there as a blocked commit.
    fs.cpSync(path.join(root, STATE_DIR, "checks"), path.join(clone, STATE_DIR, "checks"), { recursive: true });
    fs.mkdirSync(path.join(clone, STATE_DIR, "hooks"), { recursive: true });
    fs.copyFileSync(path.join(root, rel), path.join(clone, rel));
    const config = readIfExists(path.join(root, STATE_DIR, CONFIG_FILE));
    if (config !== null) fs.writeFileSync(path.join(clone, STATE_DIR, CONFIG_FILE), config);
    fs.mkdirSync(path.dirname(path.join(clone, seed.path)), { recursive: true });
    fs.writeFileSync(path.join(clone, seed.path), seed.content);
    for (const argv of [["init", "-q"], ["add", "-A"]]) {
      const r = spawnSync("git", argv, { cwd: clone, encoding: "utf-8", windowsHide: true });
      if (r.error || r.status !== 0) {
        return { ...base, ran: false,
          why: "git " + argv.join(" ") + " failed in the clone (" +
            (r.error ? r.error.message : (r.stderr || "").trim() || "exit " + r.status) + ")" };
      }
    }
    const run = spawnSync("git", ["-c", "core.hooksPath=" + STATE_DIR + "/hooks", "hook", "run", "pre-commit"],
      { cwd: clone, encoding: "utf-8", windowsHide: true });
    if (run.error) return { ...base, ran: false, why: "git could not be spawned to run the shim (" + run.error.message + ")" };
    const output = ((run.stdout || "") + (run.stderr || "")).trim();
    // `git hook run` landed in git 2.36. An older git cannot start the hook the
    // way git starts it, and guessing at a shell instead would prove a lane
    // nobody has.
    if (/is not a git command/.test(output)) {
      return { ...base, ran: false, why: "this git has no `hook run` subcommand (it arrived in git 2.36), so jig cannot start the shim the way git does" };
    }
    const laneLog = readIfExists(path.join(clone, STATE_DIR, "lane.log"));
    const rows = (laneLog === null ? "" : laneLog.toString("utf8")).split("\n").map((l) => l.trim()).filter(Boolean);
    // The skip is the disclosed hazard, so it is read from both places the shim
    // states it: its own lane row and the line it prints to stderr.
    const skipped = rows.some((l) => /skipped node-not-on-path$/.test(l)) || /node is not on PATH here/.test(output);
    return {
      ...base, ran: true,
      hookRan: run.status !== null,
      nodeFound: !skipped,
      blocked: run.status !== 0,
      caught: run.status !== 0,
      exitCode: run.status,
      staged: seed.path + " — " + seed.check + "'s own violation fixture",
      laneLog: rows,
      output,
    };
  } finally {
    fs.rmSync(clone, { recursive: true, force: true });
  }
}

function cmdSelftest(root, opts) {
  const live = opts.live === true || opts.live === "true";
  const lib = require("../hooks/jig-lib.js");
  const read = lib.readConfig(root);
  const guards = read.problems.length ? [] : lib.validateConfig(read.config).guards;
  const before = ledgerLines(root);

  const probes = [];
  for (const guard of guards) {
    const record = lib.loadCheck(root, guard.check);
    const probe = record.problem ? null : guardProbe(guard, record);
    if (!probe) {
      // A guard jig cannot seed a violation for is reported as unprobed, never
      // skipped: an installed guard nobody watched and a guard that cannot fire
      // look identical from the outside, which is the whole reason for this
      // command.
      probes.push({
        probe: guard.id, kind: "guard", ran: false,
        why: record.problem || "the installed check `" + guard.check + "` carries no violation fixture to seed",
        command: "node " + DRIVER_PATH + " --selftest",
        expected: "the check's own inline violation fixture, which admission proved it fires on",
      });
      continue;
    }
    probes.push(runProbe(root, guard.id, probe, live));
  }
  probes.push(runDriverProbe(root, live));
  probes.push(runCommitLaneProbe(root, live, lib));
  // `--toolchain <ids>` names the tools this run may spawn. The flag on its own
  // is `true` from parseArgs and means all of them: somebody who typed it asked
  // for the tools.
  probes.push(...runToolchainProbes(root, live, new Set(
    typeof opts.toolchain === "string" ? opts.toolchain.split(",").map((s) => s.trim()).filter(Boolean)
      : opts.toolchain === true ? ["all"] : [])));

  // The proof rows. A guard probe writes its own line through the runner; these
  // do not, and a close that cannot point at a ledger line has witnessed
  // nothing. Every toolchain proof is ledgered per tool, and the driver probe is
  // ledgered where it is the only witness there is — a checks-only install has
  // no guard, and reporting one unwitnessed for ever is the coverage claim
  // inverted: jig calling a correct install unproven.
  for (const p of probes) {
    if (p.ran !== true) continue;
    if (p.kind !== "toolchain" && !(p.kind === "checks" && !guards.length)) continue;
    lib.appendLedger(root, {
      session: "jig-selftest", actor: "jig", guardId: null, classId: null, mode: null,
      // The verdict, not the raw exit code: a toolchain probe over a red
      // baseline caught nothing it planted, and the ledger is the line the
      // close points at.
      decision: (p.verdict || (p.caught === true ? "verified" : "unverified")),
      tool: p.probe, matched: null, path: null, durMs: 0,
    });
  }

  const after = ledgerLines(root);
  const caught = probes.filter((p) => p.caught === true);
  const notes = [];
  if (!guards.length) {
    notes.push("No guards are installed in this project, so there is nothing for a guard probe to catch." +
      (read.problems.length ? " " + read.problems.join("; ") : "") +
      " Author the checks, run `admit`, then `plan` and `apply`.");
  }
  for (const p of probes.filter((x) => x.ran === false && x.why !== "selftest was not run with --live")) {
    notes.push(p.probe + " did not run: " + p.why + ". Run it yourself with:\n    " + p.command + "\n  and look for: " + p.expected);
  }
  return {
    ok: true,
    live,
    // The exit criterion, stated as a fact rather than a hope: something was
    // seen catching something AND the ledger grew a line proving it. A guard
    // where there are guards; the check driver where there are none, because
    // that install's whole surface is the driver and a repository with guards
    // still has to see one of them fire.
    witnessed: (caught.some((p) => p.kind === "guard") ||
      (!guards.length && caught.some((p) => p.kind === "checks"))) && after > before,
    ledger: { file: STATE_DIR + "/" + LEDGER_FILE, linesBefore: before, linesAfter: after },
    probes,
    notes,
  };
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------
//
// Never ask what the machine can read. Everything scan
// gathers is a fact the interview is then forbidden to put to a human: the
// stack, whether node is reachable, what guardrails already run here, and
// which of jig's own slots are already taken.
//
// The conflict pre-flight is the load-bearing half. jig generating a second
// PreToolUse[Bash] guard into a repository that already has one produces two
// hooks that do not chain — the user would be told they are protected by
// something that never runs. So an occupied slot is reported as occupied and
// the plan refuses it, rather than writing over it and hoping.

const PROFILE_FILE = "profile.json";

const PROFILE_KEYS = ["schemaVersion", "scannedAt", "stack", "languages", "edition", "editions", "node",
  "guardrails", "governance", "slots", "occupied", "greenfield", "disclosures", "quick"];

// The files jig writes at v1 — the same targets the engine's per-kind
// allowlist permits, named here as slots a human can be shown.
const FILE_SLOTS = [
  { id: "config", path: STATE_DIR + "/config.json", what: "the committed guard configuration" },
  { id: "checks", path: STATE_DIR + "/checks/run.mjs", what: "the check driver jig generates" },
  { id: "ci-workflow", path: ".github/workflows/jig.yml", what: "the CI floor that needs no local node" },
];

// The two hook registrations jig's single-dispatch runner takes.
const HOOK_SLOTS = [
  // Every shell tool a host may name, so a repository whose own PreToolUse hook
  // is registered for `PowerShell` reports the slot occupied instead of taking
  // a second registration that does not chain with it.
  { id: "PreToolUse:Bash", event: "PreToolUse", tools: SHELL_TOOLS, what: "the command guard" },
  { id: "PostToolUse:Edit|Write", event: "PostToolUse", tools: ["Edit", "Write"], what: "the edit guard" },
];

const RULE_FILES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude/CLAUDE.md"];

const SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"];

const LOCKFILES = {
  "package-lock.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
};

const ESLINT_CONFIGS = [
  "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
  ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml",
];

const VERSION_MANAGERS = { FNM_DIR: "fnm", NVM_DIR: "nvm", VOLTA_HOME: "volta", ASDF_DIR: "asdf" };

function readJsonIfExists(full) {
  const buf = readIfExists(full);
  if (buf === null) return null;
  try {
    return JSON.parse(stripBom(buf.toString("utf8")));
  } catch (err) {
    return null;
  }
}

function firstExisting(root, names) {
  return names.find((n) => fs.existsSync(path.join(root, n))) || null;
}

// A Claude Code matcher is a regex tested against the tool name. An absent or
// wildcard matcher takes every tool, which is what makes a bare PreToolUse
// entry the widest possible occupant of a slot.
function matcherMatches(matcher, tool) {
  if (matcher === undefined || matcher === null || matcher === "" || matcher === "*") return true;
  try {
    return new RegExp(matcher).test(tool);
  } catch (err) {
    return String(matcher) === tool;
  }
}

// Flatten one settings.json / hooks.json `hooks` block into rows a human can
// read. Both files share the shape, which is why one reader covers all of them.
function hookRows(source, block) {
  const rows = [];
  if (!isObject(block)) return rows;
  for (const [event, matchers] of Object.entries(block)) {
    for (const group of Array.isArray(matchers) ? matchers : []) {
      if (!isObject(group)) continue;
      const commands = (Array.isArray(group.hooks) ? group.hooks : [])
        .map((h) => (isObject(h) ? [h.command, ...(Array.isArray(h.args) ? h.args : [])].filter(Boolean).join(" ") : ""))
        .filter(Boolean);
      rows.push({ source, event, matcher: typeof group.matcher === "string" ? group.matcher : null, commands });
    }
  }
  return rows;
}

// jig's own registration, by absolute path. Dogfooding jig inside the
// repository that builds it would otherwise have jig report its own two hooks
// as the thing occupying its own two slots, and refuse to install anywhere.
const OWN_HOOKS = path.join(path.dirname(__dirname), "hooks", "hooks.json");

// Project settings, the user's own settings, and any plugin living in the
// tree. The user-level file is read because a hook registered there fires in
// this project too — a conflict jig could not see would be a conflict jig
// walks straight into.
function collectHooks(root) {
  const rows = [];
  for (const rel of SETTINGS_FILES) {
    const settings = readJsonIfExists(path.join(root, rel));
    if (settings) rows.push(...hookRows(rel, settings.hooks));
  }
  const userSettings = readJsonIfExists(path.join(os.homedir(), ".claude", "settings.json"));
  if (userSettings) rows.push(...hookRows("~/.claude/settings.json", userSettings.hooks));

  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (err) {
    entries = [];
  }
  for (const dir of entries) {
    const full = path.join(root, dir.name, "hooks", "hooks.json");
    if (path.resolve(full) === path.resolve(OWN_HOOKS)) continue;
    const found = readJsonIfExists(full);
    if (found) rows.push(...hookRows(dir.name + "/hooks/hooks.json", found.hooks));
  }
  return rows;
}

function gitConfig(root, key) {
  const r = spawnSync("git", ["config", "--get", key], { cwd: root, encoding: "utf-8", windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim() || null;
}

// The fnm hazard, stated rather than assumed. A node that
// resolves here because this shell initialised a version manager is not a node
// a git hook or another terminal will find, and jig's whole human floor is
// node scripts.
function nodeOnPath() {
  const r = spawnSync("node", ["--version"], { encoding: "utf-8", windowsHide: true });
  const ok = !r.error && r.status === 0;
  const manager = Object.keys(VERSION_MANAGERS).find((k) => process.env[k]);
  return {
    onPath: ok,
    version: ok ? r.stdout.trim() : null,
    versionManager: manager ? VERSION_MANAGERS[manager] : null,
    note: manager
      ? "node is managed by " + VERSION_MANAGERS[manager] + ", so it is on PATH only in a shell that initialised it." +
        " A git hook or a fresh terminal may not find it — the CI workflow is the floor that does not depend on this."
      : null,
  };
}

// The language census, and the Node facts that survive it. Which languages
// this project is written in comes from the editions' own detection — no name
// of a language appears here — and every 1.0.1 fact underneath is still true
// and still what the interview asks from.
function stackFacts(root) {
  const pkg = readJsonIfExists(path.join(root, "package.json"));
  const lock = firstExisting(root, Object.keys(LOCKFILES));
  let detected = [];
  try {
    detected = editionsLib.detectEditions(root, editionsLib.loadIndex(PLUGIN_ROOT));
  } catch (err) {
    // A shelf jig cannot read is a broken install, and it is worth saying so
    // on the profile rather than reporting a project with no languages in it.
    detected = [];
  }
  return {
    // Ranked, best first: marker files beat extension counts, and a polyglot
    // repository legitimately answers with several.
    languages: detected.map((d) => ({
      edition: d.id,
      score: d.score,
      markers: d.matchedFiles.slice(0, 8),
      extensions: d.matchedExtensions,
    })),
    edition: detected.length ? detected[0].id : null,
    editions: detected.map((d) => d.id),
    packageJson: pkg !== null,
    name: pkg && typeof pkg.name === "string" ? pkg.name : null,
    moduleType: pkg && typeof pkg.type === "string" ? pkg.type : null,
    packageManager: lock ? LOCKFILES[lock] : (pkg && typeof pkg.packageManager === "string" ? pkg.packageManager : null),
    lockFile: lock,
    testScript: pkg && isObject(pkg.scripts) && typeof pkg.scripts.test === "string" ? pkg.scripts.test : null,
    typescript: fs.existsSync(path.join(root, "tsconfig.json")),
    eslintConfig: firstExisting(root, ESLINT_CONFIGS),
    ciWorkflows: fs.existsSync(path.join(root, ".github", "workflows")),
    // Which toolchain binaries the repo itself carries. Still facts, no longer
    // a verdict: an absent tool is something the owner can approve an install
    // for, and `plan --tools` is where that happens.
    toolchain: toolchainFacts(root),
  };
}

// Token counts here are a rough four-bytes-per-token estimate and labelled as
// one. jig has no tokenizer and adding one to answer "roughly how big is the
// rule corpus" would be a dependency bought for a rounding error.
function ruleCorpus(root) {
  const rels = RULE_FILES.filter((rel) => fs.existsSync(path.join(root, rel)));
  const rulesDir = path.join(root, ".claude", "rules");
  if (fs.existsSync(rulesDir)) {
    for (const name of fs.readdirSync(rulesDir).sort()) {
      if (name.endsWith(".md")) rels.push(".claude/rules/" + name);
    }
  }
  const files = rels.map((rel) => ({ path: rel, bytes: fs.statSync(path.join(root, rel)).size }));
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  return { files, bytes, approxTokens: Math.round(bytes / 4), estimate: "four bytes per token, not a tokenizer" };
}

function conflictPreflight(root, hooks) {
  const slots = [];
  for (const slot of FILE_SLOTS) {
    const occupied = fs.existsSync(path.join(root, slot.path));
    slots.push({
      slot: slot.id,
      kind: "file",
      what: slot.what,
      path: slot.path,
      free: !occupied,
      occupiedBy: occupied ? [slot.path] : [],
    });
  }
  for (const slot of HOOK_SLOTS) {
    const clashes = hooks.filter((h) => h.event === slot.event && slot.tools.some((t) => matcherMatches(h.matcher, t)));
    slots.push({
      slot: slot.id,
      kind: "hook",
      what: slot.what,
      event: slot.event,
      tools: slot.tools,
      free: clashes.length === 0,
      occupiedBy: clashes.map((c) => c.source + " [" + (c.matcher || "*") + "] " + c.commands.join("; ")),
    });
  }
  return slots;
}

// Governance documents by shape — ADRs, scopes, roadmaps, north stars — and
// whether any surface a session actually loads points at them. A doc nothing
// references is invisible however good it is; the scan calls that an orphan
// and the interview turns it into a decision.
const GOVERNANCE_SHAPES = [
  { kind: "adr", globs: ["adr/**", "adrs/**", "docs/adr/**", "docs/adrs/**", "docs/decisions/**", "DECISIONS.md"] },
  { kind: "scope", globs: ["SCOPE.md", "docs/SCOPE.md"] },
  { kind: "roadmap", globs: ["ROADMAP.md", "ROADMAP.jsonl", "docs/ROADMAP.md"] },
  { kind: "north-star", globs: ["NORTH-STAR.md", "NORTHSTAR.md", "VISION.md", "docs/north-star.md"] },
  { kind: "context", globs: ["CONTEXT.md", "docs/CONTEXT.md"] },
  { kind: "phases", globs: ["PHASES.md", "docs/phases/**", "docs/PLAN.md"] },
];

// The committed pre-commit hooks jig could weave its line into. `.git/hooks/`
// is machine-local and jig never writes there, so a repository only has one of
// these if somebody committed it — which is exactly when weaving is safe.
//
// The host decides the line: a node-shebang hook gets the in-process form, and
// everything else gets the sh form that skips silently when node is off PATH.
function precommitHosts(root) {
  const out = [];
  for (const dir of KIND_TARGETS["include-line"]) {
    const rel = toPosix(dir + "pre-commit");
    const buf = readIfExists(path.join(root, rel));
    if (buf === null) continue;
    const body = stripBom(buf.toString("utf8"));
    const host = /^#![^\r\n]*\bnode\b/.test(body) ? "node" : "sh";
    const entry = ACTIVATION[host];
    // Strict mode is a directive prologue: a line inserted above it silently
    // turns strict mode off. Anchor below it when the host has one.
    const anchor = host === "node" && /['"]use strict['"];/.test(body)
      ? (/["']use strict["'];/.exec(body) || [null])[0]
      : null;
    out.push({ path: rel, host, anchor, woven: body.includes(entry.marker) });
  }
  return out;
}

// Where git ACTUALLY reads hooks from, and whether the one it would run at
// commit time already runs jig's checks.
//
// `precommitHosts` above answers a different question — which committed file
// jig could weave a line into — and a repository can easily have none of those
// and still have a working hook, because `.git/hooks/` is where git looks by
// default and nothing commits it. Reporting that repository as unwired is
// reporting a coverage gap that is not there, which is the one thing SCOPE says
// jig must never do. Reading `.git/` is allowed and always was: the refusal in
// `targetProblem` is a write boundary.
function commitLane(root) {
  const configured = gitConfig(root, GIT_SETTING);
  const dir = configured || ".git/hooks";
  const rel = toPosix(dir.replace(/\/+$/, "") + "/pre-commit");
  const full = path.isAbsolute(dir) ? path.join(dir, "pre-commit") : path.join(root, rel);
  const buf = readIfExists(full);
  const body = buf === null ? null : stripBom(buf.toString("utf8"));
  // Either spelling counts: the marker a woven line carries, or the driver path
  // a hand-written hook names. A hook that runs the checks is wired however it
  // came to say so.
  const runsChecks = body !== null &&
    (body.includes(ACTIVATION.sh.marker) || body.includes(STATE_DIR + "/checks/run.mjs"));
  return {
    setting: configured,
    hooksDir: toPosix(dir),
    path: rel,
    exists: body !== null,
    runsChecks,
    // The shim jig wrote, and the value that would point git at it. Both are
    // facts about this repository rather than advice, so the surfaces that give
    // advice can all read the same ones.
    shim: toPosix(STATE_DIR + "/hooks/pre-commit"),
    shimExists: fs.existsSync(path.join(root, STATE_DIR, "hooks", "pre-commit")),
    // Whether git can actually execute the hook it is pointed at. `null` means
    // the question does not apply here rather than "no": win32 has no exec bit
    // and the mode node reports for it is synthesised, so a `false` there would
    // be a report of a problem nobody has.
    executable: body === null || process.platform === "win32" ? null : isExecutable(full),
    state: runsChecks ? "live" : body !== null ? "hook-without-jig" : "no-hook",
  };
}

function isExecutable(full) {
  try {
    return (fs.statSync(full).mode & 0o111) !== 0;
  } catch {
    return null;
  }
}

function governanceFacts(root, rules, hooks) {
  const found = [];
  const seen = new Set();
  const tryPath = (rel, kind) => {
    if (seen.has(rel) || !fs.existsSync(path.join(root, rel))) return;
    seen.add(rel);
    found.push({ path: rel, kind });
  };
  for (const shape of GOVERNANCE_SHAPES) {
    for (const glob of shape.globs) {
      if (!glob.includes("*")) { tryPath(glob, shape.kind); continue; }
      const dir = glob.slice(0, glob.indexOf("*")).replace(/\/$/, "");
      const full = path.join(root, dir);
      if (!fs.existsSync(full)) continue;
      let names = [];
      try { names = fs.readdirSync(full); } catch { continue; }
      for (const name of names) {
        if (/\.(md|jsonl|adoc|txt)$/i.test(name)) tryPath(dir + "/" + name, shape.kind);
      }
    }
  }
  if (!found.length) return { docs: [], orphans: [] };

  // The loaded surfaces: every rule file's text, every hook command line, and
  // every in-tree skill body. A doc is referenced when any of them carries its
  // path or its basename.
  const surfaces = [];
  for (const rule of rules.files) {
    const buf = readIfExists(path.join(root, rule.path));
    if (buf) surfaces.push({ name: rule.path, text: buf.toString("utf8") });
  }
  surfaces.push({ name: "hooks", text: hooks.map((h) => (h.commands || []).join(" ")).join("\n") });
  const skillsDir = path.join(root, ".claude", "skills");
  if (fs.existsSync(skillsDir)) {
    for (const name of fs.readdirSync(skillsDir)) {
      const skill = path.join(skillsDir, name, "SKILL.md");
      const buf = readIfExists(skill);
      if (buf) surfaces.push({ name: ".claude/skills/" + name, text: buf.toString("utf8") });
    }
  }

  for (const doc of found) {
    const base = path.basename(doc.path);
    doc.referencedBy = surfaces
      .filter((s) => s.text.includes(doc.path) || s.text.toLowerCase().includes(base.toLowerCase()))
      .map((s) => s.name);
  }
  return { docs: found, orphans: found.filter((d) => !d.referencedBy.length).map((d) => d.path) };
}

function cmdScan(root, opts) {
  const hooks = collectHooks(root);
  const slots = conflictPreflight(root, hooks);
  const occupied = slots.filter((s) => !s.free);

  const disclosures = [];
  if (occupied.some((s) => s.kind === "hook")) {
    disclosures.push(
      "Hooks registered for the same event do not chain reliably across plugins. A guard jig adds beside one that" +
        " already runs here could silently never fire, which is why the occupied slot is refused rather than shared.",
    );
  }
  for (const slot of occupied.filter((s) => s.kind === "file")) {
    disclosures.push(slot.path + " already exists — jig will not write over it, so " + slot.what + " has no slot here.");
  }
  const node = nodeOnPath();
  if (!node.onPath) {
    disclosures.push("node did not run from this environment, so every check driver jig generates is unrunnable here.");
  } else if (node.note) {
    disclosures.push(node.note);
  }

  // The AGENTS.md chain: a nested file shadows the root one for its subtree,
  // so a region written at the root may never be read where the work happens.
  // Disclosed, never guessed around.
  try {
    const nested = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !["node_modules", ".git", ".jig"].includes(e.name))
      .filter((e) => fs.existsSync(path.join(root, e.name, "AGENTS.md")))
      .map((e) => e.name + "/AGENTS.md");
    if (nested.length && fs.existsSync(path.join(root, "AGENTS.md"))) {
      disclosures.push("AGENTS.md is shadowed for part of the tree: " + nested.join(", ") +
        " override the root file in their own directories, so a jig region at the root is not read there.");
    }
  } catch { /* a scan disclosure is never worth failing the scan for */ }

  const precommit = precommitHosts(root);
  const lane = commitLane(root);
  if (lane.state === "live") {
    disclosures.push("Commit-time checks already run here: " + lane.path + " invokes the jig driver." +
      " Nothing needs wiring.");
  }
  for (const host of precommit) {
    if (host.woven) continue;
    disclosures.push(host.path + " is a committed pre-commit hook, so jig can weave its one check line" +
      " into it on request. Until it does, the line stays a printed proposal.");
  }

  const rules = ruleCorpus(root);
  const governance = governanceFacts(root, rules, hooks);
  for (const orphan of governance.orphans) {
    disclosures.push(orphan + " is a governance document no loaded surface references — a session that never" +
      " hears about it will never read it, however good it is.");
  }

  const stack = stackFacts(root);
  // What jig will work against, which is not always what detection read: on a
  // folder with no code in it the owner names the edition and that answer is
  // recorded here, so every later command inherits it from the profile instead
  // of depending on the flag being passed again.
  const resolved = resolveEditions(root, opts || {});
  const working = resolved.map((e) => e.edition);
  if (!stack.editions.length && working.length) {
    disclosures.push("Nothing on disk names a language, so jig is working against the " + working.join(", ") +
      " edition because you said so. Detection had nothing to read here.");
  } else if (!stack.editions.length) {
    disclosures.push("No shipped edition matched this project, so nothing here is calibrated to a language." +
      " Every check will be authored from scratch and admitted on its own fixture pair — which is the same test," +
      " just without the research behind it.");
  }

  // Is there a project here yet? jig hardens what is about to be written as
  // readily as what already is — that is the whole point of running it
  // first — but a package manager still needs a project file to record an
  // install in, so the scan says plainly which editions have none.
  const greenfield = greenfieldEditions(root, resolved, (opts || {})["package-manager"]).map((m) => ({
    edition: m.edition,
    path: m.path,
    canWrite: m.sample !== null,
    hint: m.hint,
  }));
  for (const row of greenfield) {
    disclosures.push(row.canWrite
      ? "There is no " + row.path + " here yet, so this is a project jig writes the starter for before anything installs into it."
      : row.hint);
  }
  if (!stack.editions.length && !greenfield.length) {
    disclosures.push("Nothing here names a language yet. Say which one with --edition <id> and jig will" +
      " scaffold against that edition instead of guessing from an empty folder.");
  }

  const profile = {
    schemaVersion: SCHEMA_VERSION,
    scannedAt: new Date().toISOString(),
    stack,
    // Promoted out of `stack` because every later command asks which edition
    // this project is, and none of them should have to know where the census
    // happened to be written down.
    languages: stack.languages,
    edition: working[0] || stack.edition,
    editions: working,
    node,
    guardrails: { hooks, coreHooksPath: gitConfig(root, GIT_SETTING), rules, precommit, commitLane: lane },
    governance,
    slots,
    occupied: occupied.map((s) => s.slot),
    greenfield,
    // Null on an ordinary scan: quick start is the only run that selects
    // without asking, so it is the only one that owes a recorded answer.
    quick: null,
    disclosures,
  };

  // `--quick` skips every round, so the selection cannot be a decision somebody
  // makes in the moment and nobody can check afterwards. The engine computes it
  // here from this repository's own history, writes it with its basis, and says
  // what quick start still costs.
  if (opts && opts.quick) {
    let mined = null;
    try {
      mined = require("./forensics.js").runForensics(root, {});
    } catch {
      // History is an improvement on catalogue order, never a gate. A git that
      // will not run leaves the catalogue fallback, which says so in `basis`.
    }
    profile.quick = editionsLib.quickSelection(profile, mined);
    disclosures.push("Quick start selected " + profile.quick.classes.length + " of " + profile.quick.considered +
      " classes on a " + profile.quick.basis + " basis — " + profile.quick.why + ". The selection is written to " +
      STATE_DIR + "/" + PROFILE_FILE + " under `quick`, so what was assumed on your behalf is on disk rather than" +
      " in somebody's head.");
  }

  ensureStateDir(root);
  fs.writeFileSync(statePath(root, PROFILE_FILE), JSON.stringify(profile, null, 2) + "\n");
  return { ok: true, profile: STATE_DIR + "/" + PROFILE_FILE, ...profile };
}

// Same discipline as a plan: a profile written by a newer jig is refused
// outright, and an unknown key at the version this build reads is a warning
// rather than a stop, which is the additive-only rule.
function readProfile(root) {
  const file = statePath(root, PROFILE_FILE);
  const buf = readIfExists(file);
  if (buf === null) throw expected("no " + STATE_DIR + "/" + PROFILE_FILE + " — run `jig.js scan` first");
  let record;
  try {
    record = JSON.parse(stripBom(buf.toString("utf8")));
  } catch (err) {
    throw expected(PROFILE_FILE + " is not readable JSON (" + err.message + ")");
  }
  if (!isObject(record)) throw expected(PROFILE_FILE + " is not a profile");
  if (record.schemaVersion > SCHEMA_VERSION) {
    throw expected(PROFILE_FILE + " is schemaVersion " + record.schemaVersion + " and this engine reads " +
      SCHEMA_VERSION + ". Upgrade jig rather than planning from a profile it cannot fully read.");
  }
  const warnings = Object.keys(record)
    .filter((k) => !PROFILE_KEYS.includes(k))
    .map((k) => PROFILE_FILE + " carries an unknown key `" + k + "` — ignored by this build");
  return { profile: record, warnings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  // `--change` and `--path` are the two halves of one approval and both
  // repeat, so they collect into position-matched lists rather than
  // last-one-wins scalars.
  const opts = { _: [], change: [], path: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--change") { opts.change.push(argv[++i]); continue; }
    if (a === "--path") { opts.path.push(argv[++i]); continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) opts[key] = true;
      else opts[key] = argv[++i];
      continue;
    }
    opts._.push(a);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// The review surface and the arming commands (0.2.0)
// ---------------------------------------------------------------------------
//
// jig-lib is required lazily inside these functions. The cycle that forced it is
// gone — jig-lib takes the shared vocabulary from `vocab.js` now, not from here —
// and it stays lazy because jig-lib is the session hook's whole load cost and no
// jig.js command outside this section touches it.

function configuredGuards(root) {
  const lib = require("../hooks/jig-lib.js");
  const read = lib.readConfig(root);
  if (read.problems.length) {
    throw expected("no readable guard config — " + read.problems.join("; "));
  }
  const check = lib.validateConfig(read.config);
  if (check.problems.length) {
    throw expected("the config is invalid:\n  - " + check.problems.join("\n  - "));
  }
  return { lib, config: read.config, guards: check.guards };
}

// The evidence effectiveState grades a guard on, gathered from the same three
// places the hook gathers it: the check module on disk, the deny reply that
// module ships, and whether a false positive stands. One reader, so the review
// surface and the runner can never disagree about why a guard is observing.
function guardEvidence(lib, root, guard, stats) {
  const record = lib.loadCheck(root, guard.check);
  const dets = record.problem ? [] : lib.sessionDetectors(record.mod, guard.runner);
  const s = stats[guard.id] || {};
  // The same class, caught in a lane the session hook never saw. The commit
  // driver runs the check with no guard and no denominator, so its catches
  // cannot join `fired`/`evaluated` — but a guard whose class only ever fires
  // there read as one that had never fired, which is the retirement offer the
  // review skill makes off that count.
  const lane = stats[lib.CLASS_KEY + guard.classId] || {};
  return {
    problem: record.problem || (dets.length ? null : "the installed check `" + guard.check +
      "` declares no " + guard.runner + " detector"),
    det: dets[0] || null,
    // The module itself, for the readers that describe what a check watches
    // rather than what it has caught. Null when it would not load, because
    // there is nothing honest to say about a module that is not there.
    mod: record.problem ? null : record.mod,
    fired: s.fired || 0,
    // What `fired` never said: out of how many calls, split by what the guard
    // was actually allowed to do, and when the last catch was. A guard that
    // caught four out of four is a different guard from one that caught four
    // out of four thousand, and the report used to render both the same way.
    evaluated: s.evaluated || 0,
    otherLanes: lane.fired || 0,
    denied: s.denied || 0,
    wouldDeny: s.wouldDeny || 0,
    lastFired: s.lastFired || null,
    wavedOff: s.falsePositives || 0,
    // A wave-off the owner raised and never approved the change for. The guard
    // is still doing whatever its config says, which is the opposite of what
    // somebody who ran `fp` and walked away expects.
    pendingWaveOff: !!s.pendingFalsePositive,
    evidence: {
      proof: record.problem ? null : lib.checkProof(record),
      deny: record.problem ? null : lib.denyOf(record.mod, dets[0]),
      falsePositive: !!s.standingFalsePositive,
    },
  };
}

// fired / never fired / waved off, per guard, straight from the ledger — plus
// what arming would say right now, so a review can offer it exactly when it
// would hold and name the barrier when it would not.
// What a guard watches, which is the half `fired` and `mode` never say. The
// patterns are COUNTED rather than printed: the config is a trust boundary a
// teammate edits by design, and a matcher rendered into a report is a matcher
// somebody can paste back in without anybody reviewing it.
function watchesOf(lib, det, mod, deny) {
  if (!det) return null;
  const params = isObject(det.params) ? det.params : {};
  return {
    // `PreToolUse` and `PostToolUse` run inside a session; `checks` runs in the
    // commit hook and in CI, and never appears in a guard row at all.
    event: det.runner || null,
    // The lever's tools, not the event's: PreToolUse now carries both kinds, and
    // reporting a bash guard as watching Edit and Write is a coverage claim.
    tools: (lib.LEVER_TOOLS && lib.LEVER_TOOLS[det.lever]) ||
      (lib.EVENT_TOOLS && lib.EVENT_TOOLS[det.runner]) || [],
    lever: det.lever || null,
    paths: Array.isArray(params.paths) ? params.paths : [],
    patterns: Array.isArray(params.patterns) ? params.patterns.length : 0,
    // The second detector kind: what has to change alongside `paths`. Empty on
    // a pattern detector, which is every session guard.
    pairedWith: Array.isArray(params.pairedWith) ? params.pairedWith : [],
    // And the third: counted, not printed, for the same reason `patterns` is.
    // Non-zero means this detector reads a count going down between the text an
    // edit replaced and the text it wrote, rather than what is in a file.
    removed: Array.isArray(params.removed) ? params.removed.length : 0,
    // And the fourth: counted too. Non-zero means this detector takes names out
    // of `paths` and reports the ones no file in `pairedWith` carries, rather
    // than reporting a file that never moved.
    extract: Array.isArray(params.extract) ? params.extract.length : 0,
    title: mod && typeof mod.title === "string" ? mod.title : null,
    severity: mod && typeof mod.severity === "string" ? mod.severity : null,
    // The three-part reply an armed match shows. Null means this detector
    // cannot arm at all, whatever any config row says about it.
    deny,
  };
}

// Every rationale still recoverable from the plan files in `.jig/`, keyed by
// the change id the manifest row carries. A plan that will not parse is skipped
// rather than thrown on: refusing to describe a whole install because one old
// plan file went bad is worse than saying `none` for the rows it covered.
function rationaleIndex(root) {
  const map = new Map();
  for (const file of planFiles(root)) {
    let record;
    try {
      record = readPlan(file);
    } catch {
      continue;
    }
    for (const c of record.changes) {
      if (typeof c.rationale === "string" && c.rationale.trim()) map.set(c.id, c.rationale.trim());
    }
  }
  return map;
}

// The check modules on disk, read for what they watch. A session detector gets
// a row in the config; a `checks` detector gets none, and it is exactly what
// the commit hook and CI run — so a report built from the config alone would
// present a fraction of the coverage as the whole of it.
function installedChecks(root) {
  const lib = require("../hooks/jig-lib.js");
  const dir = path.join(root, STATE_DIR, "checks");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".check.mjs")).sort().map((f) => {
    const slug = f.slice(0, -".check.mjs".length);
    const record = lib.loadCheck(root, slug);
    if (record.problem) return { slug, problem: record.problem, title: null, severity: null, provable: false, detectors: [] };
    const mod = record.mod;
    const dets = Array.isArray(mod.detectors) ? mod.detectors.filter(isObject) : [];
    return {
      slug,
      problem: null,
      title: typeof mod.title === "string" ? mod.title : null,
      severity: typeof mod.severity === "string" ? mod.severity : null,
      // A fixture pair is what admitted this check. Without one it can never be
      // re-proven, and no guard naming it can arm.
      provable: lib.checkProof(record) !== null,
      detectors: dets.map((det) => watchesOf(lib, det, mod, lib.denyOf(mod, det))),
    };
  });
}

function cmdReview(root) {
  // A repository jig never touched, and one `revert` put back, are the same
  // repository: there is no config, and "what have the guards caught" has the
  // plain answer "nothing is installed". Throwing a raw ENOENT at that question
  // told the owner their install was broken when it was simply gone. A config
  // that exists and cannot be read is still a refusal — that one IS broken.
  if (!fs.existsSync(statePath(root, CONFIG_FILE))) {
    return {
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      installed: false,
      why: "there is no " + STATE_DIR + "/" + CONFIG_FILE + " here, so no guards are installed",
      guards: [],
      lanes: lanesOf(root, []),
      verify: verifyStatus(root),
      ledger: { file: STATE_DIR + "/" + LEDGER_FILE, lines: ledgerLines(root) },
    };
  }
  const { lib, config, guards } = configuredGuards(root);
  const stats = lib.ledgerStats(root);
  const rows = guards.map((g) => {
    const e = guardEvidence(lib, root, g, stats);
    const now = lib.effectiveState(g, config, null, e.evidence);
    const ifArmed = lib.effectiveState({ ...g, mode: "armed" }, config, null, e.evidence);
    return {
      guardId: g.id,
      classId: g.classId,
      check: g.check,
      actor: e.det ? e.det.actor || null : null,
      confidence: e.det ? e.det.confidence || null : null,
      // What this guard watches. A guard reported only by its activity is one
      // nobody can check against the mistake it was installed for.
      watches: watchesOf(lib, e.det, e.mod, e.evidence.deny),
      // A check missing a fixture can never be re-proven, so a row naming it
      // cannot arm however its config reads.
      provable: e.evidence.proof !== null,
      // Opt-in, per guard, off unless the row asked. True means a would-deny
      // from this guard also reaches the transcript as one line of
      // PostToolUse context.
      teach: g.teach,
      provenance: g.provenance,
      fired: e.fired,
      evaluated: e.evaluated,
      // Catches of this guard's class at commit time, where the check runs
      // without a guard. Its own field rather than part of `fired`: that lane
      // has no denominator, and the two numbers answer different questions.
      otherLanes: e.otherLanes,
      denied: e.denied,
      wouldDeny: e.wouldDeny,
      lastFired: e.lastFired,
      wavedOff: e.wavedOff,
      pendingWaveOff: e.pendingWaveOff,
      // A guard whose module will not load or carries nothing for its event is
      // a broken install, and a review that stayed quiet about it would report
      // coverage nothing delivers.
      problem: e.problem,
      mode: now.mode,
      why: now.why,
      // The config says armed and the gate says observe. That gap is the one
      // thing a reader of this row cannot see anywhere else — the config is not
      // in front of them — so it is its own field rather than two to compare.
      demoted: (g.mode || "observe") === "armed" && now.mode !== "armed" ? now.why : null,
      armable: ifArmed.mode === "armed",
      barrier: ifArmed.mode === "armed" ? null : ifArmed.why,
    };
  });
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    installed: true,
    guards: rows,
    lanes: lanesOf(root, rows),
    verify: verifyStatus(root),
    ledger: { file: STATE_DIR + "/" + LEDGER_FILE, lines: ledgerLines(root) },
  };
}

// The last time each lane entry was seen to run green, from the witness rows
// the session hook writes. This is the answer to "do the tests pass" that does
// not depend on anybody saying so: an entry with `lastGreen: null` has never
// been observed passing here, whatever a transcript claims. Its own function
// because a repository with no guard config still has lanes and still has
// rows — the question survives the config being gone.
function verifyStatus(root) {
  const lib = require("../hooks/jig-lib.js");
  const green = lib.lastGreenRuns(lib.verifyRows(root));
  return lib.verifyEntries(root)
    .filter((e) => typeof e.id === "string")
    .map((e) => ({
      id: e.id,
      lanes: Array.isArray(e.lanes) ? e.lanes : [],
      paths: Array.isArray(e.paths) ? e.paths : [],
      lastGreen: green.get(e.id) || null,
    }));
}

// Which lanes actually run today, read fresh rather than remembered. Wiring is
// reported once at install and can go quiet later — a fresh clone, or somebody
// resetting the setting — and a surface that only reported guards would call a
// repository covered while its commit lane was dead. Its own function because
// the answer does not depend on the config, and a report that could not read
// the config still owes it.
function lanesOf(root, rows) {
  const lane = commitLane(root);
  const ci = ciLane(root);
  // The kill switch is the whole answer for the session lane. Every hook exits
  // before it reads anything while `.jig/off` is there, so a report that read
  // the config and not the file said the guards were running when nothing was.
  const off = readIfExists(path.join(root, STATE_DIR, "off")) !== null;
  let offSince = null;
  if (off) {
    try { offSince = fs.statSync(path.join(root, STATE_DIR, "off")).mtime.toISOString(); } catch { /* an unreadable mtime is not a reason to hide the switch */ }
  }
  // Which shell tools this repository has been seen to send, disclosed with the
  // lane rather than left for an owner to discover. jig watches every name on
  // the shared list, so the lane is live either way — but a command guard's
  // patterns are matched against whatever the sending tool wrote, and PowerShell
  // syntax is not shell idiom. `seen` is read off jig's own ledger rows and is
  // empty until a guard has evaluated; the platform is never asked, because on
  // win32 it answers `PowerShell` for a session that also offers `Bash`
  // (HOST-PROBE-2026-09-02, sections 3 and 4).
  const shell = { seen: require("../hooks/jig-lib.js").shellToolsSeen(root), watched: SHELL_TOOLS };
  return {
    session: off
      ? { runs: false, observing: false, off: true, offSince, shell }
      : { runs: rows.some((r) => r.mode === "armed"), observing: rows.some((r) => r.mode === "observe"), off: false, offSince: null, shell },
    commit: {
      runs: lane.state === "live",
      state: lane.state,
      path: lane.path,
      // Read from the file rather than assumed from the write: git runs a hook
      // it can execute, and nothing else.
      executable: lane.executable,
      // The one thing to do about it, named here so every surface that
      // reports the gap offers the same fix.
      fix: lane.state === "live" ? null
        : lane.state === "hook-without-jig"
          ? "add jig's line to " + lane.path + ": " + ACTIVATION.sh.line
          : WIRE_COMMIT_FIX,
    },
    ci,
  };
}

// The workflow file being there is not the CI lane. A file jig wrote and
// somebody later rewrote, and a file jig never wrote at all, both used to read
// as live coverage from `existsSync` alone. jig already knows better: the
// `ci-workflow` artifact carries a measured drift state, and the driver line is
// readable as text — the same way `commitLane` reads the hook, and for the same
// reason. No YAML parser: jig does not take a dependency to read its own
// template back, and whether the workflow's triggers still fire is a question
// only `gh` could answer, which a report does not get to make a network call
// for.
function ciLane(root) {
  const rel = ".github/workflows/jig.yml";
  const buf = readIfExists(path.join(root, rel));
  if (buf === null) return { runs: false, state: "absent", path: null };
  const runsChecks = stripBom(buf.toString("utf8")).includes(STATE_DIR + "/checks/run.mjs");
  let artifact = null;
  try {
    artifact = manifestStates(root, readManifest(root)).find((a) => a.path === rel) || null;
  } catch { /* an unreadable manifest is not a reason to hide the lane */ }
  return {
    // A workflow that still invokes the driver runs the checks however it came
    // to say so; one that does not is the lane this defect called live.
    runs: runsChecks,
    state: !runsChecks ? "unwired" : artifact && artifact.state === "drifted" ? "drifted" : "live",
    path: rel,
  };
}

// The third surface, beside installing and reviewing. `review` answers what the
// guards have CAUGHT; this answers what is here, why it was installed, and
// whether it is watching anything today. Nothing here decides, changes or
// installs — every action stays where it already lives.
function cmdInventory(root) {
  // A report is not an enforcement surface. An absent config means nothing is
  // installed and an invalid one is the single most important thing the owner
  // could be told — refusing the whole report over either would hide the
  // artifacts, the checks and the lanes, which are all still readable.
  let review = null;
  let guardsProblem = null;
  try {
    review = cmdReview(root);
  } catch (err) {
    if (!err.expected) throw err;
    guardsProblem = err.message;
  }
  const manifest = readManifest(root);
  const why = rationaleIndex(root);
  const artifacts = manifestStates(root, manifest).map((a) => {
    const recorded = typeof a.rationale === "string" && a.rationale.trim() ? a.rationale.trim() : null;
    const recovered = recorded ? null : why.get(a.id) || null;
    return {
      id: a.id,
      path: a.path,
      kind: a.kind,
      ownership: a.ownership,
      provenance: a.provenance,
      classIds: a.classIds || [],
      install: a.install || null,
      installedAt: a.installedAt || null,
      // Measured, not remembered: `drifted` means the file is the owner's now,
      // and `retired` means it is gone.
      state: a.state,
      why: recorded || recovered,
      // Where the answer came from. `plan` means the row predates the manifest
      // field and its plan file survives; `none` means neither does, and jig
      // says so rather than inventing a reason it never recorded.
      whySource: recorded ? "manifest" : recovered ? "plan" : "none",
    };
  });
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    guards: review ? review.guards : [],
    // Both surfaces read one truth: `false` means there is no guard config here
    // at all, so the empty list above is "nothing is installed" rather than
    // "every guard was retired". `why` is `cmdReview`'s own sentence for it.
    installed: guardsProblem !== null || (review ? review.installed !== false : false),
    why: review && review.installed === false ? review.why : null,
    // Non-null means no guard below is being reported. Say it first: a silent
    // empty list reads as "nothing installed", which is the opposite of what a
    // config jig refused actually means.
    guardsProblem,
    checks: installedChecks(root),
    artifacts,
    lanes: review ? review.lanes : lanesOf(root, []),
    verify: review ? review.verify : verifyStatus(root),
    ledger: review ? review.ledger : { file: STATE_DIR + "/" + LEDGER_FILE, lines: ledgerLines(root) },
  };
}

// A false positive is a human judgment, recorded as its own ledger line. Acting
// on it stops an armed guard refusing tool calls, which is what `disarm` does —
// the surfaces differ, the effect does not — so SCOPE's derail pass gives it the
// same pause. The line jig writes here is PENDING: it is the judgment, counted
// as a wave-off and reported as one, and it moves nothing. What quiets the guard
// is the planned config change handed back with it, approved by the same
// `--change/--path` pair as any other item-tier write.
//
// `--clear` is the other direction and needs no pause: it appends the
// `false-positive-cleared` line the arming gate already reads, which is how a
// standing wave-off — one a 1.0.1 install carried in, or one raised here and
// thought better of — stops holding a guard in observe. Never an edit to
// history: the ledger is append-only and the earlier line stays where it is.
function cmdFp(root, opts) {
  const { lib, guards } = configuredGuards(root);
  // `--clear` reads as a flag after the id and as an option before it, because
  // both are how a person types it.
  const guardId = typeof opts.guard === "string" ? opts.guard
    : opts._[1] || (typeof opts.clear === "string" ? opts.clear : undefined);
  if (!guardId) throw expected("fp needs the guard id: jig.js fp <guardId> [--clear]");
  const guard = guards.find((g) => g.id === guardId);
  if (!guard) {
    throw expected(guardId + " is not a configured guard. Configured: " +
      guards.map((g) => g.id).join(", "));
  }
  const clearing = opts.clear !== undefined;
  lib.appendLedger(root, {
    session: typeof opts.session === "string" ? opts.session : null,
    actor: "user",
    guardId,
    classId: guard.classId,
    mode: "observe",
    decision: clearing ? "false-positive-cleared" : "false-positive-pending",
    tool: null,
    matched: null,
    path: null,
    durMs: 0,
  });
  const stats = lib.ledgerStats(root)[guardId];
  if (clearing) return { ok: true, recorded: "false-positive-cleared", cleared: guardId, stats };
  return pendingChange("false-positive", guardId,
    planGuardMode(root, guardId, null, "fp", "a report from " + guardId + " was wrong"),
    { recorded: "false-positive-pending", stats });
}

// The one journaled way a guard's mode changes. The whole config is rewritten
// through the engine — plan file, pre-image, journal row — so `revert` can put
// the previous mode back byte for byte. This writes the PLAN and stops; whether
// the change is then applied by jig itself or handed back as a token for the
// owner to approve is the caller's call, because only the caller knows whether
// enforcement is going up or coming down.
function planGuardMode(root, guardId, mode, label, rationale) {
  const rel = STATE_DIR + "/" + CONFIG_FILE;
  const raw = readIfExists(path.join(root, rel));
  if (raw === null) throw expected("no " + rel + " here — run the interview first");
  const config = JSON.parse(stripBom(raw.toString("utf8")));
  const row = (Array.isArray(config.guards) ? config.guards : []).find((g) => g && g.id === guardId);
  if (!row) throw expected(guardId + " is not in " + rel);
  if (mode) row.mode = mode;
  else delete row.mode;
  const content = JSON.stringify(config, null, 2) + "\n";
  const draft = {
    changes: [{
      // Salted with the moment the plan was written, not content-addressed
      // alone: the owner may leave a proposed change unapproved and ask for the
      // same one again, and two plan files defining one change id is a token
      // `apply` refuses to resolve.
      id: label + "-" + guardId + "-" +
        hashBytes(Buffer.from(content + "|" + new Date().toISOString(), "utf8")).slice(0, 8),
      kind: "write-config",
      path: rel,
      content,
      classIds: [row.classId],
      ownership: "schema",
      provenance: row.provenance || "assumed",
      template: { name: "config", version: "1.0.0" },
      rationale,
    }],
  };
  const { problems, payload } = planFromDraft(draft, root);
  if (problems.length) throw expected("the mode change was rejected:\n  - " + problems.join("\n  - "));
  ensureStateDir(root);
  fs.writeFileSync(path.join(root, STATE_DIR, "plan-" + payload.planId + ".json"),
    JSON.stringify(payload, null, 2) + "\n");
  return { planId: payload.planId, change: payload.changes[0] };
}

// Plan-then-stop, for every command that takes enforcement AWAY. The engine
// puts a config change that stops a guard refusing tool calls in the item tier,
// and the item tier is approved one pair at a time — so these commands write
// the plan, change nothing on disk, and hand back the exact token. The owner
// says yes; `apply` is what acts.
function pendingChange(action, guardId, plan, rest) {
  return {
    ok: true,
    applied: false,
    pending: action,
    guardId,
    plan: plan.planId,
    change: plan.change.id,
    path: plan.change.path,
    // The whole command, so a caller reads it back rather than assembling one.
    apply: "apply --change " + plan.change.id + " --path " + plan.change.path,
    ...(rest || {}),
  };
}

// Arming is offered only when it would hold. Asking to arm past the gate is
// refused with the same `why` the runner would compute — there is exactly one
// truth table, and both ends read it.
function cmdArm(root, opts) {
  const { lib, config, guards } = configuredGuards(root);
  const guardId = typeof opts.guard === "string" ? opts.guard : opts._[1];
  if (!guardId) throw expected("arm needs the guard id: jig.js arm <guardId>");
  const guard = guards.find((g) => g.id === guardId);
  if (!guard) {
    throw expected(guardId + " is not a configured guard. Configured: " +
      guards.map((g) => g.id).join(", "));
  }
  const e = guardEvidence(lib, root, guard, lib.ledgerStats(root));
  const ifArmed = lib.effectiveState({ ...guard, mode: "armed" }, config, null, e.evidence);
  if (ifArmed.mode !== "armed") {
    throw expected("the arming gate is not met for " + guardId + ": " + ifArmed.why);
  }
  // Arming keeps its internal apply: the owner named this guard, the gate they
  // are asking past has already been evaluated, and the change puts enforcement
  // UP. The pause the item tier exists for is the one on the way down.
  const plan = planGuardMode(root, guardId, "armed", "arm", "arm " + guardId);
  cmdApply(root, { _: [], change: [], plan: plan.planId }, true);
  return { ok: true, armed: guardId, plan: plan.planId, change: plan.change.id, evidence: ifArmed.why };
}

function cmdDisarm(root, opts) {
  const { guards } = configuredGuards(root);
  const guardId = typeof opts.guard === "string" ? opts.guard : opts._[1];
  if (!guardId) throw expected("disarm needs the guard id: jig.js disarm <guardId>");
  if (!guards.some((g) => g.id === guardId)) {
    throw expected(guardId + " is not a configured guard. Configured: " +
      guards.map((g) => g.id).join(", "));
  }
  return pendingChange("disarm", guardId,
    planGuardMode(root, guardId, null, "disarm", "return to observe: " + guardId));
}

// ---------------------------------------------------------------------------
// The re-run regimen (0.5.0)
// ---------------------------------------------------------------------------
//
// One command reads everything the ritual needs — drift, firing record,
// never-fired guards, the ranked backlog — so the skill can ask its ONE
// question (arm the quiet, take the next backlog row, retire the dead,
// refresh everything) from data instead of impressions.

function cmdRerun(root) {
  const manifest = readManifest(root);
  if (!manifest.artifacts.length) {
    throw expected("nothing is installed here — rerun is the ritual for a repository jig already guards");
  }
  const states = manifestStates(root, manifest);
  const installedAt = manifest.artifacts.map((a) => a.installedAt).sort()[0] || null;

  let guards = [];
  try {
    guards = cmdReview(root).guards;
  } catch {
    guards = [];
  }
  let backlog = [];
  try {
    const record = JSON.parse(stripBom(fs.readFileSync(statePath(root, BACKLOG_FILE), "utf8")));
    backlog = (record.backlog || []).slice(0, 5);
  } catch {
    backlog = [];
  }
  // The ledger only ever saw the agent sessions jig's own hooks ran inside, so
  // on its own this report says the same thing a month later that it said on
  // day one. git saw every lane and every teammate; mine it from the install
  // date. Failing open — an unreadable history subtracts a section, never the
  // report.
  let sinceInstall = null;
  if (installedAt) {
    try {
      sinceInstall = require("./forensics.js").runForensics(root, { since: installedAt }).sinceInstall;
    } catch {
      sinceInstall = null;
    }
  }
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    installedAt,
    sinceInstall,
    drifted: states.filter((s) => s.state === "drifted").map((s) => s.path),
    guards,
    // A class the commit lane has caught is not a class nothing catches, so it
    // is not a retirement candidate however quiet the session lane has been.
    neverFired: guards.filter((g) => g.fired === 0 && !g.otherLanes).map((g) => g.guardId),
    armable: guards.filter((g) => g.armable).map((g) => g.guardId),
    backlog,
    ledgerLines: ledgerLines(root),
  };
}

// Retiring is for a guard that never earned its keep: the row leaves the
// config through the same journaled door arming uses, so `revert` can put it
// back. The ledger keeps its history — evidence is never deleted. Like `disarm`
// it plans and stops: deleting a guard row is the largest step down there is.
function cmdRetire(root, opts) {
  const { guards } = configuredGuards(root);
  const guardId = typeof opts.guard === "string" ? opts.guard : opts._[1];
  if (!guardId) throw expected("retire needs the guard id: jig.js retire <guardId>");
  if (!guards.some((g) => g.id === guardId)) {
    throw expected(guardId + " is not a configured guard. Configured: " +
      guards.map((g) => g.id).join(", "));
  }
  const rel = STATE_DIR + "/" + CONFIG_FILE;
  const config = JSON.parse(stripBom(readIfExists(path.join(root, rel)).toString("utf8")));
  const row = config.guards.find((g) => g && g.id === guardId);
  config.guards = config.guards.filter((g) => g && g.id !== guardId);
  const content = JSON.stringify(config, null, 2) + "\n";
  const draft = {
    changes: [{
      // Time-salted for the same reason the mode plans are: a retirement the
      // owner does not approve must not poison the id of the next one.
      id: "retire-" + guardId + "-" +
        hashBytes(Buffer.from(content + "|" + new Date().toISOString(), "utf8")).slice(0, 8),
      kind: "write-config",
      path: rel,
      content,
      classIds: [row.classId],
      ownership: "schema",
      provenance: row.provenance || "assumed",
      template: { name: "config", version: "1.0.0" },
      rationale: "retire " + guardId + " — it never fired",
    }],
  };
  const { problems, payload } = planFromDraft(draft, root);
  if (problems.length) throw expected("the retirement was rejected:\n  - " + problems.join("\n  - "));
  ensureStateDir(root);
  fs.writeFileSync(path.join(root, STATE_DIR, "plan-" + payload.planId + ".json"),
    JSON.stringify(payload, null, 2) + "\n");
  return pendingChange("retire", guardId, { planId: payload.planId, change: payload.changes[0] });
}

const COMMANDS = {
  scan: cmdScan, toolchain: cmdToolchain, admit: cmdAdmit,
  plan: cmdPlan, apply: cmdApply, status: cmdStatus, revert: cmdRevert, selftest: cmdSelftest,
  review: cmdReview, inventory: cmdInventory, arm: cmdArm, disarm: cmdDisarm, fp: cmdFp,
  rerun: cmdRerun, retire: cmdRetire,
  // Required lazily, like jig-lib: migrate reads this module for the
  // transaction core, and a top-level require here would close that loop.
  migrate: (root, opts) => require("./migrate.js").cmdMigrate(root, opts),
};

function main(argv) {
  const opts = parseArgs(argv);
  const command = opts._[0];
  if (!command || !COMMANDS[command]) {
    process.stderr.write("usage: jig.js <" + Object.keys(COMMANDS).join("|") + "> [options]\n");
    process.exit(1);
  }
  const root = typeof opts.root === "string" ? path.resolve(opts.root) : process.cwd();
  try {
    const result = COMMANDS[command](root, opts);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    if (!err.expected) throw err;
    process.stderr.write(err.message + "\n");
    process.exit(1);
  }
}

module.exports = {
  SCHEMA_VERSION, STATE_DIR, JOURNAL_FILE, PREIMAGE_DIR, PROFILE_FILE,
  CONFIG_FILE, MANIFEST_FILE, PERMISSIONS_FILE, ACTIVATION_FILE, VERIFY_FILE, LEDGER_FILE, HOOK_RUNNERS,
  PLAN_MD_FILE, PLAN_JSON_FILE, BACKLOG_FILE, AVAILABLE_NOW, CELL_RANK, CONSENT_TIERS,
  ACTORS, LEVERS, PLUGIN_ROOT, GIT_DIR, GIT_SETTING, GIT_SETTING_PATH, commitLane,
  leverOf, leverAvailable, toolchainFacts, toolchainToolFor, RELEASE_ORDER,
  denyCapable, hostNeutralFloor, floorNote, detectorGrade, detectorCeiling, DRIVER_SKIPS, driverBlindDir,
  removalOnlyDetector,
  detectorCell, matrixRow, consentFor, bestGrade, backlogFor, buildReview, cellText, renderReviewMd,
  resolveEditions, editionClassById, AUTHORED_RUNNERS, adaptAuthoredDetector, readAuthored, admitAuthored, checkSlug,
  authoredChecksIn, readFromFile, toolchainProposal, toolchainRow, installTouchPaths, guardEvidence,
  PROFILE_KEYS, FILE_SLOTS, HOOK_SLOTS, RULE_FILES,
  CHANGE_KINDS, INSTALLABLE_KINDS, KIND_TARGETS, VALIDATORS, PROSE_BUDGET_BYTES, probeGreen,
  OWNERSHIPS, PROVENANCES, DEFAULT_INSTALL_MODE, installMode, TEMPLATE_DIR, guardProbe, fixturePath,
  execToolchainProbe,
  applyStyle, detectStyle, hasBom, stripBom, hashBytes,
  resolveInsideRoot, resolveWritePath, targetProblem, isEngineOwned,
  formatOf, verifyByFor, verifyWritten,
  planFromDraft, readPlan, planFiles, readJournal, replayJournal, changeState,
  includeLineText, journalledWrite, restoreWrite,
  cmdReview, cmdInventory, cmdArm, cmdDisarm, cmdFp, cmdRerun, cmdRetire,
  activationFace,
  templateIndex, templateBody, draftFromTemplates, configFromSelection, permissionsProposal,
  verifyEntriesFor, verifyFace, ciVerifySteps, proposedVerifyEntries, verifiesTool, installedToolFace,
  readManifest, manifestStates, occupancyProblem,
  matcherMatches, hookRows, collectHooks, nodeOnPath, stackFacts, ruleCorpus, conflictPreflight, readProfile,
  cmdScan, cmdToolchain, cmdAdmit, cmdPlan, cmdApply, cmdStatus, cmdRevert, cmdSelftest, main,
};

// Run the CLI only after module.exports exists: a command that lazy-requires
// jig-lib re-enters this module through the require cache, and jig-lib reads
// SCHEMA_VERSION and STATE_DIR off these exports — calling main() above the
// assignment handed it an empty object. Found live by jig.js review.
if (require.main === module) main(process.argv.slice(2));
