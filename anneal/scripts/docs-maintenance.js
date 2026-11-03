#!/usr/bin/env node
"use strict";

// Proposes documentation maintenance, without changing anything: docs whose related files changed
// after the doc did, completed task notes to fold and delete, oversized history to condense,
// per-entry docs to merge, and records of an orphaned knowledge store to fold into the docs that
// own their paths. docs-align's maintenance mode acts on these proposals after approval.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { check, docFiles, frontmatter, relatedCandidates } = require("./docs-check.js");

// 96 of 100 task notes that another session ever read were first read within 3 days of their
// last write, so a completed note untouched for longer is very likely never read again.
const FOLD_AFTER_DAYS = 3;
const DAY = 86400;
// A group of at least this many docs in one folder, sharing a name prefix, each summarized as
// one roadmap entry's evidence.
const PER_ENTRY_GROUP = 3;
const ENTRY = /\b(?:roadmap\s+)?entr(?:y|ies)\s+#?\d+/i;

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed.`);
  return result.stdout;
}

// Each path's latest commit time in seconds, from one pass over the history.
function commitTimes(root) {
  const times = new Map();
  if (spawnSync("git", ["-C", root, "rev-parse", "--verify", "-q", "HEAD"]).status !== 0) return times;
  let time = 0;
  for (const line of git(root, ["log", "--no-renames", "--format=%x00%ct", "--name-only"]).split("\n")) {
    if (line.startsWith("\0")) time = Number(line.slice(1));
    else if (line && !times.has(line)) times.set(line, time);
  }
  return times;
}

const day = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);

// Per session file: when each path was written, and when it was read or named in a command.
// A path is matched by its repository-relative form at the end of a tool's file path, or inside a
// shell command, with either slash.
function transcriptUses(dirs, root, files) {
  const uses = new Map(files.map((file) => [file, []]));
  const rootSlash = root.replace(/\\/g, "/").toLowerCase();
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
      const session = name.slice(0, -".jsonl".length);
      for (const line of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
        if (!line.includes('"tool_use"')) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        const time = Date.parse(record.timestamp) / 1000;
        for (const block of Array.isArray(record.message?.content) ? record.message.content : []) {
          if (block?.type !== "tool_use" || !block.input) continue;
          const target = String(block.input.file_path ?? block.input.notebook_path ?? block.input.path ?? "").replace(/\\/g, "/").toLowerCase();
          const command = String(block.input.command ?? "").replace(/\\/g, "/").toLowerCase();
          const kind = /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(block.name) ? "write" : "read";
          for (const file of files) {
            const rel = file.toLowerCase();
            if (target === `${rootSlash}/${rel}` || target.endsWith(`/${rel}`) || target === rel || command.includes(rel)) {
              uses.get(file).push({ session, time, kind });
            }
          }
        }
      }
    }
  }
  return uses;
}

// Tracked files with uncommitted changes in the working tree or the index.
function dirtyFiles(root) {
  const dirty = new Set();
  for (const entry of git(root, ["status", "--porcelain", "-z", "--untracked-files=no"]).split("\0")) {
    if (entry.length > 3 && entry[0] !== "D" && entry[1] !== "D") dirty.add(entry.slice(3));
  }
  return dirty;
}

function maintain(directory, { stores = [], transcripts = [], now = Date.now() / 1000 } = {}) {
  const root = path.resolve(directory);
  const top = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) throw new Error(top.stderr.trim() || "Target is not a Git working tree.");
  const times = commitTimes(root);
  const tracked = new Set(git(root, ["ls-files", "-z"]).split("\0").filter(Boolean));
  const mtime = (file) => fs.statSync(path.join(root, file)).mtimeMs / 1000;
  // An uncommitted edit counts from its file time, so it neither hides nor invents drift.
  for (const file of dirtyFiles(root)) {
    if (fs.existsSync(path.join(root, file))) times.set(file, Math.max(times.get(file) ?? 0, mtime(file)));
  }
  // A tracked doc's time is its last commit or uncommitted edit; an untracked or ignored one has
  // only its file time, which a copy resets to the copy's time. That can only hide a proposal.
  const dated = (file) => (tracked.has(file) && times.has(file) ? "commit" : "file time");
  const written = (file) => (dated(file) === "commit" ? times.get(file) : mtime(file));
  // A related directory counts as changed when any file below it changed.
  const changed = (rel) => {
    const clean = rel.replace(/\/+$/, "");
    if (times.has(clean)) return times.get(clean);
    let latest;
    for (const [file, time] of times) if (file.startsWith(`${clean}/`) && !(latest >= time)) latest = time;
    return latest;
  };

  const proposals = [];
  const add = (id, file, detail) => proposals.push({ id, path: file, detail });
  const docs = docFiles(root);
  const fields = new Map(docs.map((file) => [file, frontmatter(fs.readFileSync(path.join(root, file), "utf8"))]));
  const relatedOf = (file) => (Array.isArray(fields.get(file)?.related_files) ? fields.get(file).related_files : []);

  const isTask = (file) => /(^|\/)docs\/tasks\//.test(file) || fields.get(file)?.type === "task_summary";
  const completed = docs.filter((file) => isTask(file) && fields.get(file)?.status === "completed");
  const uses = transcripts.length ? transcriptUses(transcripts, root, completed) : null;

  for (const file of docs) {
    const meta = fields.get(file);
    if (!meta) continue;
    const docTime = written(file);
    if (completed.includes(file)) {
      if (now - docTime <= FOLD_AFTER_DAYS * DAY) continue;
      const base = `completed, last written ${day(docTime)} (${dated(file)})`;
      if (!uses) {
        add("fold-completed", file, `${base}, no transcripts read; fold its findings into its topic docs and delete it`);
        continue;
      }
      // Another session's read within three days of the last write means the note is in use. A
      // write through a shell command looks like a read, so a call in the minute around the last
      // write is the writer's own.
      const writers = new Set(uses.get(file).filter((u) => u.kind === "write").map((u) => u.session));
      const readers = new Set(uses.get(file)
        .filter((u) => u.kind === "read" && !writers.has(u.session) && u.time > docTime + 60 && u.time <= docTime + FOLD_AFTER_DAYS * DAY)
        .map((u) => u.session));
      if (!readers.size) add("fold-completed", file, `${base}, no other session read it within ${FOLD_AFTER_DAYS} days; fold its findings into its topic docs and delete it`);
      continue;
    }
    // Task notes and decision records describe the past, so later code changes are not drift.
    if (isTask(file) || meta.type === "adr" || /(^|\/)docs\/decisions\//.test(file)) continue;
    const later = [];
    for (const related of relatedOf(file)) {
      if (/[*?[{]/.test(related)) continue;
      const time = relatedCandidates(file, related).map(changed).find((t) => t !== undefined);
      if (time > docTime) later.push(`${related} (${day(time)})`);
    }
    // Private research is often a record of its time, so its drift is reported apart.
    if (later.length) add(/(^|\/)docs\/(knowledge|apis)\/private\//.test(file) ? "drift-private" : "drift", file, `last written ${day(docTime)} (${dated(file)}); changed since: ${later.join(", ")}`);
  }

  for (const finding of check(root).findings) {
    if (finding.id === "history-doc-large" || finding.id === "task-note-large") add("condense", finding.path, finding.detail);
  }

  const groups = new Map();
  for (const file of docs) {
    const prefix = path.posix.basename(file).split("-")[0];
    const key = `${path.posix.dirname(file)}/${prefix}-`;
    if (ENTRY.test(fields.get(file)?.summary || "")) groups.set(key, [...(groups.get(key) || []), file]);
  }
  for (const [key, files] of groups) {
    if (files.length >= PER_ENTRY_GROUP) add("merge-per-entry", `${key}*.md`, `${files.length} docs, each summarized as one roadmap entry's evidence; merge them into one topic doc`);
  }

  for (const store of stores) {
    const lines = fs.readFileSync(path.resolve(root, store), "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }
      if (!Array.isArray(record?.paths) || !record.paths.length) return;
      // The homes are the docs whose covering related_files entry is the most specific, so a doc
      // that lists a whole plugin directory does not collect every record below it.
      let best = 0;
      let homes = [];
      // Task notes are no home: they are folded and deleted themselves.
      for (const file of docs.filter((f) => !isTask(f))) {
        let length = 0;
        for (const related of relatedOf(file)) {
          for (const r of relatedCandidates(file, related)) {
            const clean = r.replace(/\/+$/, "");
            if (record.paths.some((p) => p === clean || p.startsWith(`${clean}/`))) length = Math.max(length, clean.length);
          }
        }
        if (length > best) [best, homes] = [length, [file]];
        else if (length && length === best) homes.push(file);
      }
      add("fold-store", `${store}:${i + 1}`, homes.length ? `fold into ${homes.join(", ")}` : `no doc lists ${record.paths.join(", ")}; keep it in a code comment or drop it`);
    });
  }

  const counts = {};
  for (const p of proposals) counts[p.id] = (counts[p.id] || 0) + 1;
  return { root, docs: docs.length, counts, proposals };
}

function formatSummary(report) {
  const totals = Object.entries(report.counts).map(([id, n]) => `${n} ${id}`).join(", ") || "none";
  const lines = [`documents: ${report.docs}; proposals: ${totals}`];
  for (const p of report.proposals) lines.push(`${p.id}: ${p.path} (${p.detail})`);
  return `${lines.join("\n")}\n`;
}

const USAGE = "usage: docs-maintenance.js --root <project-directory> [--store <jsonl file>]... [--transcripts <directory>]... [--json]\n";

// Exit 0 with or without proposals, and 2 for bad arguments, an unreadable store or transcript
// directory, or no Git working tree.
function main(argv) {
  const args = argv.slice(2);
  let root;
  let json = false;
  const stores = [];
  const transcripts = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (args[i] === "--json") json = true;
    else if (args[i] === "--root" && !root && i + 1 < args.length && !args[i + 1].startsWith("--")) root = args[++i];
    else if (args[i] === "--store" && i + 1 < args.length && !args[i + 1].startsWith("--")) stores.push(args[++i]);
    else if (args[i] === "--transcripts" && i + 1 < args.length && !args[i + 1].startsWith("--")) transcripts.push(path.resolve(args[++i]));
    else {
      process.stderr.write(USAGE);
      return 2;
    }
  }
  if (!root) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    const report = maintain(root, { stores, transcripts });
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatSummary(report));
    return 0;
  } catch (error) {
    process.stderr.write(`docs-maintenance.js: ${error.message}\n`);
    return 2;
  }
}

module.exports = { formatSummary, main, maintain };

if (require.main === module) process.exitCode = main(process.argv);
