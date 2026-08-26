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

// The copies half of the undo story, taken on every run — [Foreman: 176] in a
// repository too, because a commit can be rebased or garbage-collected away and
// a copy cannot. Every file the run is about to touch is copied under
// `.assay/backup-<txId>/` at its project-relative path, beside a manifest
// naming each one's digest — so a later revert can tell a file it restored
// from a file the owner has edited since.
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

// One row per run, appended and never rewritten. In a repository it carries
// both routes: `gitHead` localizes the commit the run started from, and the
// backup directory holds copies that survive a rewritten history.
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

// ---------------------------------------------------------------------------
// [Foreman: 163] The other half of the story: putting a transaction back.
// ---------------------------------------------------------------------------
//
// A revert is all-or-nothing by construction. Every reason it could fail is
// discovered by `revertPlan` BEFORE a single byte moves, and the caller either
// gets a route it can run to completion or a refusal naming what stopped it.
// Half a revert is worse than none: the owner would be left with a tree that
// matches neither the run nor the commit before it, and no record saying which
// files are which.
//
// Two routes, and they must agree byte for byte:
//   git    — `git checkout <gitHead> -- <files>`, plus deleting the files that
//            did not exist at that commit, because a checkout cannot remove
//            what the tree never had.
//   backup — the copies under `.assay/backup-<txId>/`, plus deleting every
//            manifest entry whose digest is null, which is the marker
//            `backupFiles` writes for "this file did not exist before the run".
//
// The refusals are deliberately narrow, because a refusal nobody can clear is
// just a broken command. A file the run itself rewrote is EXPECTED to differ
// from the commit — that is not dirt. What blocks a revert is work the revert
// would destroy without saying so: a staged or unmerged change on a named file,
// which `git checkout -- <file>` overwrites in the index as well as the tree.

// Every path a revert touches comes off a recorded row, and a row is a file the
// owner can edit. `..` in one of them would let a revert write outside the
// project, so each is resolved and refused rather than trusted.
function resolveInside(root, rel) {
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

// Deleting a file the run created leaves behind the directories the run had to
// make. Same rule `assay.js` applies to a rollback, for the same reason: an
// empty `.claude/skills/<name>/` reads as a skill that is still installed.
function pruneEmptyDirs(root, full) {
  const base = path.resolve(root) + path.sep;
  for (let dir = path.dirname(full); dir.startsWith(base); dir = path.dirname(dir)) {
    if (!fs.existsSync(dir) || fs.readdirSync(dir).length) break;
    fs.rmdirSync(dir);
  }
}

function readManifest(root, backupDir) {
  const full = resolveInside(root, path.join(backupDir, "manifest.json"));
  if (!full || !fs.existsSync(full)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(full, "utf-8"));
    return Array.isArray(parsed.files) ? parsed : null;
  } catch {
    return null;
  }
}

// Paths carrying work a revert would silently overwrite. The index half of a
// `git checkout -- <path>` is the whole risk: an unstaged edit the owner made
// after the run is theirs to lose knowingly, but a staged one disappears with
// no trace at all, and an unmerged one is a conflict a revert must not resolve.
function blockedPaths(root, files) {
  const status = git(root, ["status", "--porcelain", "--", ...files]);
  if (status === null) return [];
  return status.split("\n").map((l) => l.trimEnd()).filter(Boolean)
    .filter((l) => l[0] !== " " && l[0] !== "?")
    .map(porcelainPath);
}

// What could be run, and what could not, with a reason for each. Nothing here
// writes: this is the whole refusal surface, in one function, ahead of the work.
function revertPlan(root, txId) {
  const rows = readTransactions(root);
  const tx = rows.find((r) => r.txId === txId);
  if (!tx) {
    return { problem: "No transaction " + txId + " in " + STATE_DIR + "/" + TRANSACTIONS_FILE +
      ". Recorded runs: " + (rows.map((r) => r.txId).join(", ") || "(none)") + "." };
  }
  if (tx.revertedAt) {
    return { problem: "Transaction " + txId + " was already reverted at " + tx.revertedAt +
      ". Reverting it twice would undo whatever was written since." };
  }
  const files = Array.isArray(tx.files) ? tx.files : [];
  if (!files.length) {
    return { problem: "Transaction " + txId + " names no files, so there is nothing to put back." };
  }
  for (const rel of files) {
    if (!resolveInside(root, rel)) {
      return { problem: "Transaction " + txId + " names " + rel + ", which resolves outside the project root. " +
        "The record was edited after it was written; nothing was restored." };
    }
  }

  const routes = [];
  if (tx.gitHead) {
    const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside || inside.trim() !== "true") {
      routes.push({ via: "git", ready: false, problem: "the run recorded a commit, but this is no longer a git repository" });
    } else if (git(root, ["cat-file", "-e", tx.gitHead + "^{commit}"]) === null) {
      routes.push({ via: "git", ready: false, problem: "the recorded commit " + tx.gitHead + " is not in this repository any more" });
    } else {
      routes.push({ via: "git", ready: true, problem: null });
    }
  }
  if (tx.backupDir) {
    const manifest = readManifest(root, tx.backupDir);
    if (!manifest) {
      routes.push({ via: "backup", ready: false, problem: tx.backupDir + "/manifest.json is missing or unreadable" });
    } else {
      const bad = [];
      for (const entry of manifest.files) {
        if (entry.sha256 === null) continue;
        const copy = resolveInside(root, path.join(tx.backupDir, entry.path));
        if (!copy || !fs.existsSync(copy)) {
          bad.push(entry.path + " (the backup copy is gone)");
        } else if (sha256(fs.readFileSync(copy)) !== entry.sha256) {
          bad.push(entry.path + " (the backup copy no longer matches its recorded digest)");
        }
      }
      routes.push(bad.length
        ? { via: "backup", ready: false, problem: "the backup is not intact: " + bad.join("; ") }
        : { via: "backup", ready: true, problem: null });
    }
  }
  if (!routes.length) {
    return { problem: "Transaction " + txId + " records neither a commit nor a backup directory, " +
      "so there is nothing to restore from." };
  }

  const blocked = blockedPaths(root, files);
  return { tx, files, routes, blocked, ready: routes.filter((r) => r.ready).map((r) => r.via) };
}

// One append-only row gains one field. The file is rewritten rather than
// appended to, because a second row carrying the same txId would make "was this
// reverted" a question with two answers.
function markReverted(root, txId, at) {
  const rows = readTransactions(root).map((r) => (r.txId === txId ? { ...r, revertedAt: at } : r));
  fs.writeFileSync(statePath(root, TRANSACTIONS_FILE), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return at;
}

function revertTransaction(root, txId, via) {
  const plan = revertPlan(root, txId);
  if (plan.problem) return { ok: false, problem: plan.problem };
  if (plan.blocked.length) {
    return { ok: false, problem: "Refusing to revert " + txId + ": these files carry staged or unmerged changes " +
      "that a revert would overwrite without a trace.\n  " + plan.blocked.join("\n  ") +
      "\n  Commit or unstage them yourself first. Nothing was restored." };
  }
  if (!via) {
    return { ok: false, problem: "revert needs --via git or --via backup. Ready here: " +
      (plan.ready.join(", ") || "(none)") + "." };
  }
  const route = plan.routes.find((r) => r.via === via);
  if (!route) return { ok: false, problem: "Transaction " + txId + " has no " + via + " route recorded." };
  if (!route.ready) {
    return { ok: false, problem: "Refusing to revert " + txId + " via " + via + ": " + route.problem +
      ". Nothing was restored." };
  }

  const restored = [];
  const removed = [];
  if (via === "git") {
    // Split first, write second. A file the run CREATED is absent from the
    // recorded commit, and `git checkout <head> -- <it>` fails the whole
    // command rather than removing it — so it is deleted, never checked out.
    const atHead = plan.files.filter((rel) => git(root, ["cat-file", "-e", plan.tx.gitHead + ":" + rel]) !== null);
    if (atHead.length && git(root, ["checkout", plan.tx.gitHead, "--", ...atHead]) === null) {
      return { ok: false, problem: "git refused to restore " + atHead.join(", ") + " from " + plan.tx.gitHead +
        ". Nothing was marked reverted." };
    }
    restored.push(...atHead);
    for (const rel of plan.files.filter((rel) => !atHead.includes(rel))) {
      const full = resolveInside(root, rel);
      fs.rmSync(full, { force: true });
      pruneEmptyDirs(root, full);
      removed.push(rel);
    }
  } else {
    for (const entry of readManifest(root, plan.tx.backupDir).files) {
      const full = resolveInside(root, entry.path);
      if (!full) {
        return { ok: false, problem: "The backup manifest names " + entry.path +
          ", which resolves outside the project root. Nothing was marked reverted." };
      }
      if (entry.sha256 === null) {
        fs.rmSync(full, { force: true });
        pruneEmptyDirs(root, full);
        removed.push(entry.path);
        continue;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, fs.readFileSync(resolveInside(root, path.join(plan.tx.backupDir, entry.path))));
      restored.push(entry.path);
    }
  }
  return { ok: true, txId, via, restored: restored.sort(), removed: removed.sort(),
    revertedAt: markReverted(root, txId, new Date().toISOString()) };
}

module.exports = {
  STATE_DIR, TRANSACTIONS_FILE, statePath,
  preflight, backupFiles, appendTransaction, readTransactions, sha256,
  revertPlan, revertTransaction, markReverted,
};

// The one command surface this file has. `assay.js` owns plan/apply/rollback,
// which move a change; undoing a whole COMPLETED transaction is this file's own
// machinery, so it is reached here rather than threaded back through the
// analyzer. Both commands print JSON, and a refusal exits non-zero.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const root = process.cwd();
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  if (argv[0] === "list") {
    const rows = readTransactions(root).map((r) => {
      const plan = revertPlan(root, r.txId);
      return {
        txId: r.txId, startedAt: r.startedAt, files: r.files, revertedAt: r.revertedAt || null,
        routes: plan.problem ? [] : plan.routes, blocked: plan.problem ? [] : plan.blocked,
        problem: plan.problem || null,
      };
    });
    process.stdout.write(JSON.stringify({ transactions: rows }, null, 2) + "\n");
  } else if (argv[0] === "revert") {
    const result = revertTransaction(root, flag("--tx"), flag("--via"));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (!result.ok) process.exitCode = 1;
  } else {
    process.stderr.write("usage: safety.js list | safety.js revert --tx <id> --via <git|backup>\n");
    process.exitCode = 2;
  }
}
