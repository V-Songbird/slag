#!/usr/bin/env node
"use strict";

// Claude Code's SessionEnd hook. When the session wrote a file under a `docs/` folder of the
// project, or into the project's Claude Code memory folder, with a file tool, it runs
// docs-maintenance.js with its defaults and shows one line: the number of proposals, the stale
// memories and unread task notes among them, and the command that lists them.
//
// It writes nothing. It is silent when the session wrote nothing there, when there are no
// proposals, when anything fails or the run takes more than 10 seconds, and when
// ANNEAL_SESSION_REPORT is `off`, `0` or `false`.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { hostDefaults } = require("../scripts/audit.js");

const FILE_TOOL = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function reportLine(counts) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (!total) return null;
  const parts = [];
  if (counts["memory-stale-state"]) parts.push(plural(counts["memory-stale-state"], "stale memory", "stale memories"));
  if (counts["fold-completed"]) parts.push(plural(counts["fold-completed"], "unread note", "unread notes"));
  const including = parts.length ? `, including ${parts.join(" and ")}` : "";
  return `anneal: ${plural(total, "documentation proposal", "documentation proposals")}${including}. See them with /anneal:repo-docs maintain.`;
}

// Whether a file tool in the transcript wrote into the memory folder, or below a `docs` folder of
// the root outside dot folders, the files docs-maintenance reads. Paths compare with forward
// slashes, and without case on Windows.
function wroteDocs(transcript, root, memory) {
  const norm = (p) => {
    const full = path.resolve(root, p).replace(/\\/g, "/");
    return process.platform === "win32" ? full.toLowerCase() : full;
  };
  const base = norm(".");
  const mem = memory ? norm(memory) : null;
  for (const line of transcript.split("\n")) {
    if (!line.includes('"tool_use"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    for (const block of Array.isArray(record?.message?.content) ? record.message.content : []) {
      if (block?.type !== "tool_use" || !FILE_TOOL.test(block.name)) continue;
      const target = block.input?.file_path ?? block.input?.notebook_path;
      if (typeof target !== "string" || !target) continue;
      const file = norm(target);
      if (mem && file.startsWith(`${mem}/`)) return true;
      if (!file.startsWith(`${base}/`)) continue;
      const dirs = file.slice(base.length + 1).split("/").slice(0, -1);
      if (dirs.includes("docs") && !dirs.some((d) => d.startsWith("."))) return true;
    }
  }
  return false;
}

function main() {
  if (/^(off|0|false)$/i.test((process.env.ANNEAL_SESSION_REPORT || "").trim())) return;
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  const root = typeof data.cwd === "string" && data.cwd ? data.cwd : process.cwd();
  const defaults = hostDefaults(root);
  const transcript = typeof data.transcript_path === "string" && data.transcript_path
    ? data.transcript_path
    : typeof data.session_id === "string" && defaults.project ? path.join(defaults.project, `${data.session_id}.jsonl`) : null;
  if (!transcript || !wroteDocs(fs.readFileSync(transcript, "utf8"), root, defaults.memory)) return;
  const run = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "docs-maintenance.js"), "--root", root, "--json"], {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) return;
  const line = reportLine(JSON.parse(run.stdout).counts || {});
  if (line) process.stdout.write(JSON.stringify({ systemMessage: line }));
}

if (require.main === module) {
  try {
    main();
  } catch {
    // A report that fails stays silent; it must never be what ends a session badly.
  }
}

module.exports = { reportLine, wroteDocs };
