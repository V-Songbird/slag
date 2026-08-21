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
//                                            approval boundary
//   node jig.js status [--root <path>]       replay the journal and print state;
//                                            writes nothing, ever
//   node jig.js revert --change <id> | --tx <id> | --all [--force]
//                                            restore journalled pre-images
//   node jig.js selftest [--live]            probe every installed guard with a
//                                            synthetic violation and show the
//                                            catch; --live actually runs them
//   node jig.js migrate                      rewrite a 1.0.1 install into the
//                                            shape this engine reads, as one
//                                            journalled transaction
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

const PLUGIN_ROOT = path.dirname(__dirname);

// Additive-only rule: every jig schema ships at 1 and only ever
// gains fields. Reading a plan stamped higher is a refusal rather than a guess,
// because a field this build cannot see could be the one that made the write
// safe. Unknown keys at the SAME version are warned about and ignored.
const SCHEMA_VERSION = 1;

const STATE_DIR = ".jig";
const JOURNAL_FILE = "journal.jsonl";
const PREIMAGE_DIR = "preimages";
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// The change kinds the engine can execute. `include-line` was reserved through
// the 0.1.0 line and is installable from 0.2.0: its one caller is git-hook
// activation, it only ever targets a committed hook file, and it always lands
// in the item consent tier — an edit to a file jig does not own is approved by
// name or not at all.
const CHANGE_KINDS = ["write-side-file", "write-config", "include-line", "write-settings", "write-rule", "write-agents-region", "run-install"];
const INSTALLABLE_KINDS = ["write-side-file", "write-config", "include-line", "write-settings", "write-rule", "write-agents-region", "run-install"];

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

function agentsRegionText(selection) {
  return AGENTS_BEGIN + "\n\n" +
    "jig guards this repository. Before calling any work done, run:\n\n" +
    "    node .jig/checks/run.mjs\n\n" +
    "It exits non-zero on: " + selection.join(", ") + ".\n" +
    "Never delete or focus a test to make a suite pass — fix it, or skip it\n" +
    "visibly and say so. The coverage matrix is at .jig/plan.md.\n\n" +
    AGENTS_END + "\n";
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

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
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

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
  if (!resolveInsideRoot(root, rel)) return rel + " escapes the project root";
  if (isEngineOwned(rel)) return rel + " belongs to the engine — a change may not rewrite the transaction record";
  if (matchesTarget(rel, GIT_DIR)) {
    return rel + " is inside .git/ — jig never writes there, whatever it was approved for. A repository is not a" +
      " file the journal can put back.";
  }
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
  // Written once, by us, because the journal and the pre-images can carry
  // verbatim contents of files the user never meant to commit.
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, [JOURNAL_FILE, PREIMAGE_DIR + "/", "ledger.jsonl", "profile.json", "off"].join("\n") + "\n");
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
  if (writes.some((w) => !w.written && !w.restored)) return "interrupted";
  if (writes.every((w) => w.restored)) return "reverted";
  return "applied";
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

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
    } else if (typeof raw.content !== "string") {
      problems.push(label + ": " + rel + " has no `content` string"); continue;
    }

    const full = path.join(root, rel);
    const current = readIfExists(full);
    const style = detectStyle(current);
    const format = formatOf(root, rel) || FORMAT_BY_EXT[path.extname(rel).toLowerCase()] || null;
    const verifyBy = verifyByFor(format);
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
      content: raw.kind === "include-line" ? raw.line : raw.kind === "run-install" ? "" : raw.content,
      // The install item and the fixture-pair proof ride the plan untouched.
      // The proof is what the manifest records, so a hand-edited config cannot
      // claim a proof it does not have (SCOPE, "What binds a proof").
      install: raw.kind === "run-install" ? raw.install : undefined,
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
  const rank = (c) => (c.kind === "run-install" ? 1 : 0);
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
    throw expected("change " + changeId + " is defined by " + hits.length + " plans — the id has to name one change");
  }
  return hits[0];
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
    for (const p of (row && row.detect && row.detect.files) || []) if (!p.includes("*")) rels.add(p);
  }
  return [...rels];
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

  // The approval is the item's own id and its command character for character.
  // Both come off the plan the owner read; nothing here re-assembles either.
  const run = toolchainLib.runInstall(root, item, { id: item.id, command: item.command });

  for (const rel of touched) {
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

function applyChange(root, ctx, change) {
  if (change.kind === "run-install") return applyInstall(root, ctx, change);

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
    const buf = readIfExists(path.join(root, a.path));
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
      if (typeof cls.proof === "string") guard.proof = cls.proof;
      guards.push(guard);
    }
  }
  return { schemaVersion: SCHEMA_VERSION, guards };
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
  const { blankRegions } = require("../hooks/jig-lib.js");
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

  const result = admission.admit(testable, blankRegions, { cross: true });
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
function composeConfigs(items, manifests) {
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
    if (starter) parts.push({ source: "the starter " + rel + " jig writes", body: starter.sample });
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
    writes.push({ path: rel, body: m.sample, sources: ["the starter " + rel + " jig writes"] });
  }
  return { writes, notes, conflicts, composed };
}

function draftFromTemplates(root, opts, checks) {
  // The edition is resolved ONCE, here, and threaded through everything below.
  // Detection walks the tree, and a plan that asked the question twice could
  // answer itself differently halfway through its own coverage matrix.
  const loaded = resolveEditions(root, opts);

  const raw = typeof opts.select === "string" ? opts.select : "";
  const asked = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  const authoredChecks = checks || readAuthored(root, opts);
  if (!asked.length && !authoredChecks.length) {
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

  const add = (entry, content, classIds) => {
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
      rationale: entry.name,
    });
  };

  // The driver and the wiring around it. There is no per-class check template
  // any more: the model authors every check and the fixture pair admits it, so
  // the only check modules this plan writes are the admitted ones below.
  const wanted = ["check-driver", "activation", "hook-shim"];
  if (!opts["no-ci"]) wanted.push("ci-workflow");
  for (const name of wanted) {
    const entry = byName.get(name);
    if (!entry) continue;
    add(entry, templateBody(entry), entry.classId ? [entry.classId] : selection);
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
  // undoes the tool whole.
  const toolchain = toolchainProposal(root, loaded, opts, states);
  refused.push(...toolchain.refused);

  // A project that does not exist yet cannot be installed into. Where the
  // edition can hand over a starter project file, jig writes it and the run
  // continues; where only the owner can name the thing — a Go module path, a
  // Gradle template — the edition says so and every install for it is refused
  // with that sentence rather than run into a folder with no project in it.
  const greenfield = greenfieldEditions(root, loaded, toolchain.packageManager);
  const blocked = new Set();
  for (const m of greenfield) {
    if (m.sample) continue;
    blocked.add(m.edition);
    // Once per edition, not once per tool. The owner has one thing to do and
    // reading it six times would not make it any clearer.
    refused.push("there is no " + m.edition + " project here yet, so nothing can install into it. " + m.hint);
  }
  const usable = toolchain.items.filter((row) => !blocked.has(row.item.edition));

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
  const config = configFromSelection(classes, provenance, mode);
  add({ name: "config", version: "1.0.0", target: STATE_DIR + "/" + CONFIG_FILE, kind: "write-config", ownership: "schema" },
    JSON.stringify(config, null, 2) + "\n", selection);
  const permissions = permissionsProposal(classes);
  if (permissions) {
    add({ name: "permissions", version: "1.0.0", target: STATE_DIR + "/" + PERMISSIONS_FILE, kind: "write-side-file", ownership: "file" },
      JSON.stringify(permissions, null, 2) + "\n", selection);
  }

  // The Codex region (0.5.0): computed from the selection, marker-fenced,
  // capped by the loadability ceiling at apply time. Explicit request only.
  if (opts["agents-region"]) {
    const content = agentsRegionText(selection);
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
        template: { name: "activation", version: "1.0.0" },
        rationale: "run the committed checks from " + host.path,
      });
    }
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

// The floor: something a person or a CI runner can run
// with no agent host involved, and that cannot be wrong about what it found.
function hostNeutralFloor(cls) {
  return cls.detectors.some((d) => {
    const lever = leverOf(d.lever);
    return !!lever && lever.hostNeutral && d.confidence === "deterministic";
  });
}

// The floor as a REPORT (SCOPE, "Does hostNeutralFloor stay a release gate":
// no — a class nothing catches is a disclosed gap, not a refusal). The sentence
// is unchanged; what changed is that it is printed on the plan the owner reads
// instead of thrown before they see anything.
function floorNote(cls) {
  if (hostNeutralFloor(cls)) return null;
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

// Which artifact does the catching, read off the plan's own changes so a cell
// can never name a file this plan does not write. A hook detector names its
// guard row in the generated config, which is the id the ledger will carry.
function detectorArtifact(cls, det, index, changes, guards) {
  const templated = (name) => {
    const hit = changes.find((c) => c.template && c.template.name === name);
    return hit ? hit.path : null;
  };
  if (det.lever === "check-driver") {
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
    const tool = det.params && det.params.tool;
    const hit = changes.find((c) => c.template &&
      (c.template.name === "toolchain-" + tool || c.template.name === "install-" + tool));
    return hit ? hit.path : null;
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
function detectorCell(cls, det, index, provenance, changes, guards) {
  const lever = leverOf(det.lever);
  const artifact = detectorArtifact(cls, det, index, changes, guards);
  let grade = detectorGrade(det);
  let why = null;
  if (grade === "GAP") {
    why = lever
      ? "the " + det.lever + " lever ships at " + lever.availableAt
      : "this detector names a lever `" + det.lever + "` this build does not run";
  } else if (artifact === null) {
    grade = "GAP";
    why = "this plan writes no " + det.lever + " artifact for " + cls.id;
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

function matrixRow(cls, provenance, changes, guards) {
  const cells = {};
  for (const actor of ACTORS) {
    const found = cls.detectors
      .map((det, i) => ({ det, i }))
      .filter(({ det }) => det.actor === actor)
      .map(({ det, i }) => detectorCell(cls, det, i, provenance, changes, guards));
    // Best-of, not first-of: a class with both a shipping lever and a later one
    // for the same actor is covered today by the one that ships today.
    cells[actor] = found.length
      ? found.reduce((best, c) => (CELL_RANK[c.grade] > CELL_RANK[best.grade] ? c : best))
      : { grade: "GAP", lever: null, artifact: null, ceiling: null, armable: null,
        why: "no detector on this class names " + actor };
  }
  const floorCleared = hostNeutralFloor(cls);
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
    floorNote: floorNote(cls),
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

// Tiered consent. Batch-approve what only ever reports;
// item-approve anything that can refuse a tool call or fail somebody's build.
// Both tests are mechanical — the change's kind and its target — so no artifact
// lands in the cheap tier because somebody classified it there by hand.
function consentFor(change, guards) {
  if (change.kind === "write-config" && guards.length) {
    return {
      tier: "item",
      why: "wires " + guards.length + " guard" + (guards.length === 1 ? "" : "s") +
        " into a hook that can refuse a tool call",
    };
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
  if (toPosix(change.path).startsWith(".github/workflows/")) {
    return { tier: "item", why: "fails the build for everyone who pushes" };
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
function backlogFor(loaded, selection) {
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
        enforcementGap: !hostNeutralFloor(adapted),
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
    // Set when this project already carries the tool's config file and jig did
    // not write it. The tool is still installable; its config is not jig's to
    // lay down.
    occupied: row.occupied || null,
  };
}

function buildReview(payload, generated) {
  const { selection, classes, provenance, refused, toolchain, discarded, discardedFile, editions } = generated;
  const mode = generated.mode || DEFAULT_INSTALL_MODE;

  const guards = configFromSelection(classes, provenance, mode).guards;
  const artifacts = payload.changes.map((c) => ({
    id: c.id,
    path: c.path,
    kind: c.kind,
    classIds: c.classIds,
    enforcementGap: c.enforcementGap,
    ...consentFor(c, guards),
  }));
  const backlog = backlogFor(generated.loaded || [], selection);
  const rows = classes.map((cls) => matrixRow(cls, provenance, payload.changes, guards));

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
    selection,
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
  if (typeof opts.select === "string" || typeof opts.authored === "string" || fromChecks) {
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
  const built = generated ? buildReview(payload, generated) : null;

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

function cmdApply(root, opts) {
  const named = opts.change.filter((c) => typeof c === "string" && c);
  // The approval token, both halves of it (SCOPE, "What is the approval
  // token"): a change id alone does not name a path, so an edited plan could
  // point an approved id somewhere else entirely. They are paired by position
  // and a mismatch is a refusal.
  const paths = (Array.isArray(opts.path) ? opts.path : opts.path === undefined ? [] : [opts.path])
    .filter((p) => typeof p === "string" && p);
  let selected = [];
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
    selected = record.changes;
  } else {
    throw expected("apply needs --change <id> --path <rel> (repeatable) or --plan <id> — the argument is the" +
      " approval boundary");
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
    enforcementGaps: results.filter((r) => r.enforcementGap).map((r) => r.path),
    manifest: manifest ? STATE_DIR + "/" + MANIFEST_FILE : null,
    // Everything the user now has to do by hand, in one place: whatever jig
    // could not vet, or was never approved to write, lands here as a proposal.
    proposals: proposalNotes(results),
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
        template: c.template,
        state: "active",
        installedAt: new Date().toISOString(),
        txId: ctx.tx,
      };
    });
  if (!rows.length) return null;

  const byId = new Map(readManifest(root).artifacts.map((a) => [a.id, a]));
  for (const row of rows) byId.set(row.id, row);
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

// The two things v1 refuses to install for you. Both were already written to
// `.jig/` as files you can read; this is the printed half of "printed AND
// persisted", so a run that installs them says so instead of leaving them to
// be found.
function proposalNotes(results) {
  const notes = [];
  const wrote = new Set(results.map((r) => r.path));
  if (wrote.has(STATE_DIR + "/" + ACTIVATION_FILE)) {
    notes.push("Commit-time checks are not wired up. " + STATE_DIR + "/" + ACTIVATION_FILE + " holds the exact line" +
      " to paste into your own pre-commit hook — jig does not edit it. Until you do, the CI workflow is the floor.");
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
    const drifted = live.filter(({ w }) => {
      const full = path.join(root, w.path);
      const now = readIfExists(full);
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
    const there = fs.existsSync(path.join(root, w.path));
    restoreWrite(root, { tx: c.tx, plan: c.plan }, c.id, w, opts.force ? "revert --force" : "revert");
    report.push({ change: c.id, path: w.path, outcome: w.preImage === null ? (there ? "removed" : "absent") : "restored" });
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
  if (guard.runner === "PreToolUse") return { event: "PreToolUse", tool: "Bash", input: { command: violation }, what };
  // The blanker reads comment and string syntax off a filename, so the seeded
  // path takes its extension from the detector's own first path glob — the same
  // derivation admission used when it proved this fixture.
  const det = (Array.isArray(mod.detectors) ? mod.detectors : []).find((d) => d && d.runner === guard.runner) || {};
  const glob = ((det.params && det.params.paths) || ["x.txt"])[0];
  const ext = (String(glob).match(/\.[A-Za-z0-9]+$/) || [".txt"])[0];
  return { event: "PostToolUse", tool: "Write", input: { file_path: "seeded" + ext, content: violation }, what };
}

function ledgerLines(root) {
  const buf = readIfExists(statePath(root, LEDGER_FILE));
  return buf === null ? 0 : buf.toString("utf8").split("\n").filter((l) => l.trim()).length;
}

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

// One probe per installed toolchain side-file. Only the eslint probe is ever
// spawned live — it takes its seeded violation on stdin and its exit code is
// the whole verdict. The others cost a build (tsc) or a JVM (detekt), so they
// degrade to the exact command and the expected outcome, never a stall.
function runToolchainProbes(root, live) {
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
    // violation, and its expected exit code is machine-readable now — but jig
    // does not spawn somebody's linter, type checker or test runner behind a
    // selftest. It says exactly what to run and what a catch looks like.
    out.push({
      probe: "toolchain-" + tool.id,
      kind: "toolchain",
      artifact: artifact.path,
      command: tool.verify.argv.join(" "),
      expectedExit: tool.verify.expectedExit,
      expected: tool.verify.expected,
      seed: tool.seed ? tool.seed.path : null,
      ran: false,
      why: live
        ? "jig does not spawn " + tool.id + " from a selftest — plant " + (tool.seed ? "`" + tool.seed.path + "`" : "a violation") + " and run it yourself"
        : "selftest was not run with --live",
    });
  }
  return out;
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
  probes.push(...runToolchainProbes(root, live));

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
    // The exit criterion, stated as a fact rather than a hope: a guard was seen
    // catching something AND the ledger grew a line proving it.
    witnessed: caught.some((p) => p.kind === "guard") && after > before,
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
  "guardrails", "governance", "slots", "occupied", "greenfield", "disclosures"];

// The files jig writes at v1 — the same targets the engine's per-kind
// allowlist permits, named here as slots a human can be shown.
const FILE_SLOTS = [
  { id: "config", path: STATE_DIR + "/config.json", what: "the committed guard configuration" },
  { id: "checks", path: STATE_DIR + "/checks/run.mjs", what: "the check driver jig generates" },
  { id: "ci-workflow", path: ".github/workflows/jig.yml", what: "the CI floor that needs no local node" },
];

// The two hook registrations jig's single-dispatch runner takes.
const HOOK_SLOTS = [
  { id: "PreToolUse:Bash", event: "PreToolUse", tools: ["Bash"], what: "the command guard" },
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
    guardrails: { hooks, coreHooksPath: gitConfig(root, "core.hooksPath"), rules, precommit },
    governance,
    slots,
    occupied: occupied.map((s) => s.slot),
    greenfield,
    disclosures,
  };

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
// jig-lib is required lazily inside these functions: it requires this module
// for the shared vocabulary, and a top-level require here would make that a
// cycle with half-initialized exports.

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
  return {
    problem: record.problem || (dets.length ? null : "the installed check `" + guard.check +
      "` declares no " + guard.runner + " detector"),
    det: dets[0] || null,
    fired: s.fired || 0,
    wavedOff: s.falsePositives || 0,
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
function cmdReview(root) {
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
      provenance: g.provenance,
      fired: e.fired,
      wavedOff: e.wavedOff,
      // A guard whose module will not load or carries nothing for its event is
      // a broken install, and a review that stayed quiet about it would report
      // coverage nothing delivers.
      problem: e.problem,
      mode: now.mode,
      why: now.why,
      armable: ifArmed.mode === "armed",
      barrier: ifArmed.mode === "armed" ? null : ifArmed.why,
    };
  });
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    guards: rows,
    ledger: { file: STATE_DIR + "/" + LEDGER_FILE, lines: ledgerLines(root) },
  };
}

// A false positive is a human judgment, recorded as its own ledger line. The
// arming gate reads it as the reset it is.
function cmdFp(root, opts) {
  const { lib, guards } = configuredGuards(root);
  const guardId = typeof opts.guard === "string" ? opts.guard : opts._[1];
  if (!guardId) throw expected("fp needs the guard id: jig.js fp <guardId>");
  const guard = guards.find((g) => g.id === guardId);
  if (!guard) {
    throw expected(guardId + " is not a configured guard. Configured: " +
      guards.map((g) => g.id).join(", "));
  }
  lib.appendLedger(root, {
    session: typeof opts.session === "string" ? opts.session : null,
    actor: "user",
    guardId,
    classId: guard.classId,
    mode: "observe",
    decision: "false-positive",
    tool: null,
    matched: null,
    path: null,
    durMs: 0,
  });
  return { ok: true, recorded: "false-positive", guardId, stats: lib.ledgerStats(root)[guardId] };
}

// The one journaled way a guard's mode changes. The whole config is rewritten
// through the engine — plan file, pre-image, journal row — so `revert` can put
// the previous mode back byte for byte.
function rewriteGuardMode(root, guardId, mode) {
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
      id: (mode === "armed" ? "arm-" : "disarm-") + guardId + "-" + hashBytes(Buffer.from(content, "utf8")).slice(0, 8),
      kind: "write-config",
      path: rel,
      content,
      classIds: [row.classId],
      ownership: "schema",
      provenance: row.provenance || "assumed",
      template: { name: "config", version: "1.0.0" },
      rationale: (mode === "armed" ? "arm " : "return to observe: ") + guardId,
    }],
  };
  const { problems, payload } = planFromDraft(draft, root);
  if (problems.length) throw expected("the mode change was rejected:\n  - " + problems.join("\n  - "));
  ensureStateDir(root);
  fs.writeFileSync(path.join(root, STATE_DIR, "plan-" + payload.planId + ".json"),
    JSON.stringify(payload, null, 2) + "\n");
  cmdApply(root, { _: [], change: [], plan: payload.planId });
  return payload.planId;
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
  const planId = rewriteGuardMode(root, guardId, "armed");
  return { ok: true, armed: guardId, plan: planId, evidence: ifArmed.why };
}

function cmdDisarm(root, opts) {
  const { guards } = configuredGuards(root);
  const guardId = typeof opts.guard === "string" ? opts.guard : opts._[1];
  if (!guardId) throw expected("disarm needs the guard id: jig.js disarm <guardId>");
  if (!guards.some((g) => g.id === guardId)) {
    throw expected(guardId + " is not a configured guard. Configured: " +
      guards.map((g) => g.id).join(", "));
  }
  const planId = rewriteGuardMode(root, guardId, null);
  return { ok: true, disarmed: guardId, plan: planId };
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
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    installedAt,
    drifted: states.filter((s) => s.state === "drifted").map((s) => s.path),
    guards,
    neverFired: guards.filter((g) => g.fired === 0).map((g) => g.guardId),
    armable: guards.filter((g) => g.armable).map((g) => g.guardId),
    backlog,
    ledgerLines: ledgerLines(root),
  };
}

// Retiring is for a guard that never earned its keep: the row leaves the
// config through the same journaled door arming uses, so `revert` can put it
// back. The ledger keeps its history — evidence is never deleted.
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
      id: "retire-" + guardId + "-" + hashBytes(Buffer.from(content, "utf8")).slice(0, 8),
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
  cmdApply(root, { _: [], change: [], plan: payload.planId });
  return { ok: true, retired: guardId, plan: payload.planId };
}

const COMMANDS = {
  scan: cmdScan, toolchain: cmdToolchain, admit: cmdAdmit,
  plan: cmdPlan, apply: cmdApply, status: cmdStatus, revert: cmdRevert, selftest: cmdSelftest,
  review: cmdReview, arm: cmdArm, disarm: cmdDisarm, fp: cmdFp,
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
  CONFIG_FILE, MANIFEST_FILE, PERMISSIONS_FILE, ACTIVATION_FILE, LEDGER_FILE, HOOK_RUNNERS,
  PLAN_MD_FILE, PLAN_JSON_FILE, BACKLOG_FILE, AVAILABLE_NOW, CELL_RANK, CONSENT_TIERS,
  ACTORS, LEVERS, PLUGIN_ROOT, GIT_DIR,
  leverOf, leverAvailable, toolchainFacts, toolchainToolFor, RELEASE_ORDER,
  denyCapable, hostNeutralFloor, floorNote, detectorGrade, detectorCeiling,
  detectorCell, matrixRow, consentFor, bestGrade, backlogFor, buildReview, cellText, renderReviewMd,
  resolveEditions, editionClassById, adaptAuthoredDetector, readAuthored, admitAuthored, checkSlug,
  authoredChecksIn, readFromFile, toolchainProposal, toolchainRow, installTouchPaths, guardEvidence,
  PROFILE_KEYS, FILE_SLOTS, HOOK_SLOTS, RULE_FILES,
  CHANGE_KINDS, INSTALLABLE_KINDS, KIND_TARGETS, VALIDATORS, PROSE_BUDGET_BYTES, probeGreen,
  OWNERSHIPS, PROVENANCES, DEFAULT_INSTALL_MODE, installMode, TEMPLATE_DIR, guardProbe,
  applyStyle, detectStyle, hasBom, stripBom, hashBytes,
  resolveInsideRoot, resolveWritePath, targetProblem, isEngineOwned,
  formatOf, verifyByFor, verifyWritten,
  planFromDraft, readPlan, planFiles, readJournal, replayJournal, changeState,
  includeLineText, journalledWrite, restoreWrite,
  cmdReview, cmdArm, cmdDisarm, cmdFp, cmdRerun, cmdRetire,
  templateIndex, templateBody, draftFromTemplates, configFromSelection, permissionsProposal,
  readManifest, manifestStates, occupancyProblem,
  matcherMatches, hookRows, collectHooks, nodeOnPath, stackFacts, ruleCorpus, conflictPreflight, readProfile,
  cmdScan, cmdToolchain, cmdAdmit, cmdPlan, cmdApply, cmdStatus, cmdRevert, cmdSelftest, main,
};

// Run the CLI only after module.exports exists: a command that lazy-requires
// jig-lib re-enters this module through the require cache, and jig-lib reads
// SCHEMA_VERSION and STATE_DIR off these exports — calling main() above the
// assignment handed it an empty object. Found live by jig.js review.
if (require.main === module) main(process.argv.slice(2));
