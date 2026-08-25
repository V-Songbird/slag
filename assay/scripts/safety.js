"use strict";

// [Foreman: 162] The safety seam: what a run records BEFORE it writes, so the
// writes can be undone after `clean` has taken the journal.
//
// Three jobs, and nothing else:
//   1. `preflight` — is this a git repository, and is its tree clean?
//   2. `backupFiles` — the no-repo substitute for `gitHead`: real copies.
//   3. `appendTransaction` — one append-only row per run, in both cases.
//
// The split between `.assay/` and `.assay-tmp/` is the whole point. `clean`
// exists to remove the disposable directory, and it must never be able to widen
// into removing the only record of what a run changed. So everything this file
// writes lands in `.assay/`, and nothing here ever writes to `.assay-tmp/`.
//
// No dependency is added: node's own `crypto`, `fs` and `child_process` cover
// sha256, file copying and asking git a question.

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STATE_DIR = ".assay";
const TRANSACTIONS_FILE = "transactions.jsonl";

function statePath(root, ...parts) {
  return path.join(root, STATE_DIR, ...parts);
}

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

// A porcelain line is `XY <path>`, or `XY <old> -> <new>` for a rename. The
// destination is the path that matters — it is the one a run could collide
// with. Git quotes a path containing unusual bytes; the quotes are stripped so
// the message names the file the way the user typed it.
function porcelainPath(line) {
  let rel = line.slice(3);
  const arrow = rel.indexOf(" -> ");
  if (arrow !== -1) rel = rel.slice(arrow + 4);
  if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
  return rel;
}

// assay's own state is not the owner's uncommitted work. `plan` writes
// `.assay/plan-*.json` before `apply` ever runs, so counting those as dirt
// would hard-stop every real run on its own footprint.
function isOwnState(rel) {
  return rel === STATE_DIR || rel.startsWith(STATE_DIR + "/") || rel === ".assay-tmp" || rel.startsWith(".assay-tmp/");
}

// The preflight itself. It reports; it never decides. The caller owns the
// refusal, because the refusal is a CLI message and this file has no CLI.
//
// `dirty` is a list of paths and never a boolean, because "commit your work
// first" is not actionable advice unless it says which work.
function preflight(root) {
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside || inside.trim() !== "true") return { repo: false, head: null, dirty: [] };
  const head = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--porcelain"]);
  const dirty = (status || "").split("\n").map((l) => l.trimEnd()).filter(Boolean)
    .map(porcelainPath).filter((rel) => !isOwnState(rel));
  // A repository with no commit yet has no HEAD to point a revert at. It is
  // still a repository, so there is nothing to back up — the row simply carries
  // a null head and the transaction is localized by its files alone.
  return { repo: true, head: head === null ? null : head.trim(), dirty };
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// The no-repo half of the undo story. Every file the run is about to touch is
// copied under `.assay/backup-<txId>/` at its project-relative path, beside a
// manifest naming each one's digest — so a later revert can tell a file it
// restored from a file the owner has edited since.
//
// A patch that CREATES a file has nothing to copy. It is still in the manifest,
// with a null digest, because "this file did not exist before the run" is
// exactly what a revert needs to know to delete it again.
function backupFiles(root, txId, relPaths) {
  const dir = statePath(root, "backup-" + txId);
  const files = [];
  for (const rel of [...new Set(relPaths)].sort()) {
    const from = path.join(root, rel);
    if (!fs.existsSync(from)) {
      files.push({ path: rel, sha256: null, bytes: 0 });
      continue;
    }
    const bytes = fs.readFileSync(from);
    const to = path.join(dir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, bytes);
    files.push({ path: rel, sha256: sha256(bytes), bytes: bytes.length });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ txId, files }, null, 2) + "\n");
  return STATE_DIR + "/backup-" + txId;
}

// One row per run, appended and never rewritten. Written in the git case too:
// there it is a pointer rather than a copy, and `gitHead` is the only thing
// that lets a revert localize the commit the run started from.
function appendTransaction(root, row) {
  fs.mkdirSync(statePath(root), { recursive: true });
  fs.appendFileSync(statePath(root, TRANSACTIONS_FILE), JSON.stringify(row) + "\n");
  return STATE_DIR + "/" + TRANSACTIONS_FILE;
}

function readTransactions(root) {
  const file = statePath(root, TRANSACTIONS_FILE);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

module.exports = {
  STATE_DIR, TRANSACTIONS_FILE, statePath,
  preflight, backupFiles, appendTransaction, readTransactions, sha256,
};
