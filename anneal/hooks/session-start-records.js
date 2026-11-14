#!/usr/bin/env node
"use strict";

// The SessionStart hook of Claude Code and Codex. It adds one line to the session's context: the
// task notes with `status: completed` still on disk, with their count and up to ten paths, and
// where the record index is, or that there is none.
//
// It only reads, and uses no model. It is silent when the project has no Markdown under a `docs/`
// folder, when anything fails, and when ANNEAL_SESSION_REPORT is `off`, `0` or `false`.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { docFiles, frontmatter } = require("../scripts/docs-check.js");

const LISTED = 10;
const INDEX = "docs/index.md";

function recordsLine(root) {
  const docs = docFiles(root);
  if (!docs.length) return null;
  const completed = docs.filter((file) => {
    const fields = frontmatter(fs.readFileSync(path.join(root, file), "utf8"));
    return (/(^|\/)docs\/tasks\//.test(file) || fields?.type === "task_summary") && fields?.status === "completed";
  });
  const parts = [];
  if (completed.length) {
    const more = completed.length > LISTED ? ` and ${completed.length - LISTED} more` : "";
    const notes = completed.length === 1 ? "1 completed task note is" : `${completed.length} completed task notes are`;
    parts.push(`${notes} still on disk: ${completed.slice(0, LISTED).join(", ")}${more}. Fold each one's findings into its topic documents, then ask the owner before deleting it.`);
  }
  parts.push(fs.existsSync(path.join(root, INDEX))
    ? `Record index: ${INDEX}; search it before guessing a docs path.`
    : `No record index at ${INDEX}; anneal's repo-docs skill writes one in its adopt mode.`);
  return `anneal: ${parts.join(" ")}`;
}

function main() {
  if (/^(off|0|false)$/i.test((process.env.ANNEAL_SESSION_REPORT || "").trim())) return;
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  const start = process.env.CLAUDE_PROJECT_DIR || (typeof data.cwd === "string" && data.cwd ? data.cwd : process.cwd());
  // A session started in a subfolder still reads the whole working tree.
  const top = spawnSync("git", ["-C", start, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const line = recordsLine(top.status === 0 && top.stdout.trim() ? top.stdout.trim() : start);
  if (line) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: line } }));
}

if (require.main === module) {
  try {
    main();
  } catch {
    // A line that fails stays silent; it must never be what starts a session badly.
  }
}

module.exports = { recordsLine };
