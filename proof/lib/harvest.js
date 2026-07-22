"use strict";

// Task harvesting from git history (component 1). Invented tasks flatter the
// config — an author unconsciously writes tasks the config is good at — so proof
// prefers tasks mined from the repo's own past failures: revert commits and
// bug-fix commits. Each mined commit becomes a CANDIDATE task the user curates;
// the assertions are provisional and the linter (lint.js) is what stops a weak
// harvested set from reaching spend.
//
// Split into a pure core (`parseGitLog`, `mineCommits`) that unit tests exercise
// against canned log text, and a thin `harvestRepo` wrapper that shells `git`.

const { execFileSync } = require("child_process");

// Record/unit separators embedded in the --format so subjects/bodies with
// newlines don't corrupt parsing.
const REC = "\x1e";
const UNIT = "\x1f";
const LOG_FORMAT = `${REC}%H${UNIT}%s${UNIT}%b${UNIT}`;

const REVERT_RE = /^revert\b|\breverts?\s+commit\b/i;
const BUGFIX_RE = /\b(fix(e[sd])?|bug|hotfix|regression|broke|breaks|crash|patch)\b/i;
const CODE_FILE_RE = /\.(js|mjs|cjs|ts|tsx|jsx|py|go|java|rb|rs|c|cpp|h|php|md)$/i;

// Parse `git log <LOG_FORMAT> --name-only` output into commit records.
function parseGitLog(raw) {
  return String(raw)
    .split(REC)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha = "", subject = "", body = "", filesBlock = ""] = chunk.split(UNIT);
      const files = filesBlock.split("\n").map((l) => l.trim()).filter(Boolean);
      return { sha: sha.trim(), subject: subject.trim(), body: body.trim(), files };
    })
    .filter((c) => c.sha);
}

function classify(commit) {
  if (REVERT_RE.test(commit.subject)) return "revert";
  if (BUGFIX_RE.test(commit.subject)) return "bugfix";
  return null;
}

// A short, filename-derived token to seed a provisional assertion — good enough
// to be curated, not trusted as-is.
function tokenFromSubject(subject) {
  const words = subject.replace(/^(revert:?|fix:?|bugfix:?)\s*/i, "").match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [];
  return words[0] || null;
}

// Turn classified commits into candidate task descriptors. Provisional fields
// are flagged so the CLI and linter can tell the user what to curate.
function mineCommits(commits, opts = {}) {
  const limit = opts.limit || Infinity;
  const tasks = [];
  for (const c of commits) {
    const type = classify(c);
    if (!type) continue;
    const codeFile = c.files.find((f) => CODE_FILE_RE.test(f)) || c.files[0] || null;
    const token = tokenFromSubject(c.subject);
    const sha7 = c.sha.slice(0, 7);
    const task = {
      id: `${type}-${sha7}`,
      source: "harvested",
      sha: c.sha,
      type,
      surface: "instructions",
      prompt: type === "revert"
        ? `A past change was reverted: "${c.subject}". Re-do the work it attempted, correctly this time.`
        : `Reproduce and fix the problem behind: "${c.subject}".`,
      assert: codeFile && token
        ? [{ type: "file_regex", path: codeFile, pattern: escapeRe(token), _provisional: true }]
        : [],
      assertProvisional: true,
      _files: c.files,
    };
    tasks.push(task);
    if (tasks.length >= limit) break;
  }
  return tasks;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Shell `git log` in repoPath and mine it. Pure functions above are what the
// tests cover; this wrapper is exercised live by the walkthrough.
function harvestRepo(repoPath, opts = {}) {
  const n = opts.scan || 500;
  const raw = execFileSync(
    "git",
    ["-C", repoPath, "log", "--no-merges", "-n", String(n), `--format=${LOG_FORMAT}`, "--name-only"],
    { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 }
  );
  return mineCommits(parseGitLog(raw), opts);
}

module.exports = { parseGitLog, mineCommits, classify, harvestRepo, LOG_FORMAT };
