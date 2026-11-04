#!/usr/bin/env node
"use strict";

// anneal's session close-out: what deleting one finished Claude Code session would lose. Reads the whole
// transcript with the session-evidence parser, finds where each file the session changed lives now, and prints
// JSON: one item per changed file, one per turn that ended in text, and a verdict. It writes, moves and deletes
// nothing; its Git queries take no optional locks.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { HOME, directory, excerpt } = require("./session-evidence-redaction.js");
const { textBlocks } = require("./session-evidence-records.js");
const { actorOf, claudeShape, firstCopies, isPrompt, subagentTranscripts } = require("./session-evidence-claude.js");
const { detectHost, findTranscript } = require("./session-evidence.js");

// The tools whose input holds what they wrote. A shell command that removes or moves a file carries no content.
const CONTENT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit", "Write"]);
// Where a changed file lives now. Deleting the session loses the content of a file that is gone and that Git never held.
const KEPT = new Set(["tracked", "ignored"]);

function git(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}

function locate(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return { location: "outside", uncommitted: false };
  const spec = relative.split(path.sep).join("/");
  if (git(root, ["ls-files", "--error-unmatch", "--", spec]).status === 0) {
    return { location: "tracked", uncommitted: git(root, ["status", "--porcelain", "--", spec]).stdout.trim() !== "" };
  }
  if (!fs.existsSync(file)) return { location: "missing", uncommitted: false };
  return { location: git(root, ["check-ignore", "-q", "--", spec]).status === 0 ? "ignored" : "untracked", uncommitted: false };
}

function countFiles(folder) {
  try {
    return fs.readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

function closeout(file, root) {
  const warnings = new Set();
  const buffer = fs.readFileSync(file);
  // A turn starts at a prompt the owner typed, by the rule session-evidence uses.
  const prompts = [];
  let originAware = false;
  let sessionId = null;
  for (const [line, row] of firstCopies(buffer, warnings)) {
    sessionId = sessionId || (typeof row.sessionId === "string" ? row.sessionId.slice(0, 120) : null);
    originAware = originAware || (row.origin !== null && typeof row.origin === "object");
    if (actorOf(row) === "main" && isPrompt(row)) prompts.push({ line, row });
  }
  const typed = new Set(prompts
    .filter(({ row }) => (originAware ? Boolean(row.origin) && row.origin.kind === "human" : !row.isMeta))
    .map(({ line }) => line));

  const turns = [];
  const changes = new Map();
  const pending = new Map();
  let cwd = null;
  let sidechain = 0;
  let turn = null;
  for (const [line, row] of firstCopies(buffer, warnings)) {
    if (actorOf(row) !== "main") {
      sidechain += 1;
      continue;
    }
    if (row.cwd) cwd = row.cwd;
    const message = row.message || {};
    if (typed.has(line) || !turn) {
      turn = { promptLine: typed.has(line) ? line : null, prompt: typed.has(line) ? excerpt(textBlocks(message.content).join("\n"), 240) : null,
        textLines: [], endingLine: null, ending: null, wrote: new Set() };
      turns.push(turn);
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!block || typeof block !== "object") continue;
      if (row.type === "assistant" && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        if (turn.textLines.at(-1) !== line) turn.textLines.push(line);
        Object.assign(turn, { endingLine: line, ending: excerpt(block.text, 480) });
      } else if (block.type === "tool_use" && CONTENT_TOOLS.has(block.name)) {
        const shape = claudeShape(block.name, block.input && typeof block.input === "object" ? block.input : {}, cwd);
        if (shape.path) pending.set(block.id, { path: shape.path, line, turn });
      } else if (block.type === "tool_result" && pending.has(block.tool_use_id)) {
        const call = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        // A refused or failed call changed nothing.
        if (block.is_error) continue;
        if (!changes.has(call.path)) changes.set(call.path, []);
        changes.get(call.path).push(call.line);
        call.turn.wrote.add(call.path);
      }
    }
  }
  if (sidechain) warnings.add(`Skipped ${sidechain} subagent records in the transcript; only the main session's turns are listed.`);

  const located = new Map([...changes.keys()].map((changed) => [changed, locate(root, changed)]));
  const items = [...changes].map(([changed, lines]) => {
    const { location, uncommitted } = located.get(changed);
    return { kind: "change", path: excerpt(changed), location, uncommitted, callLines: lines, atRisk: location === "missing" };
  });
  for (const { wrote, ...rest } of turns.filter((each) => each.ending !== null)) {
    const location = [...wrote].some((changed) => KEPT.has(located.get(changed).location)) ? "file" : "transcript-only";
    items.push({ kind: "turn", ...rest, wrote: [...wrote].map((changed) => excerpt(changed)), location, atRisk: location === "transcript-only" });
  }
  const wouldLose = items.filter((item) => item.atRisk)
    .map((item) => (item.kind === "turn" ? { kind: "turn", endingLine: item.endingLine } : { kind: "change", path: item.path }));
  const folder = path.join(path.dirname(file), path.basename(file, ".jsonl"));
  return {
    sessionFile: file, sessionId, context: { cwd: directory(cwd) }, root: directory(root),
    verdict: wouldLose.length ? "would-lose" : "safe-to-delete", wouldLose, items,
    alsoDeleted: { folder: directory(folder), subagentTranscripts: subagentTranscripts(file).length, savedOutputs: countFiles(path.join(folder, "tool-results")) },
    warnings: [...warnings].sort(),
    limits: "Claude Code only. A change is a call of Edit, MultiEdit, NotebookEdit or Write that reported no error; a shell "
      + "command that changed files is not listed. A turn counts as in a file when it changed any tracked or ignored file, "
      + "even an unrelated one, and as transcript-only otherwise, including a turn of questions or status. Only a turn's "
      + "last text is copied; textLines names every line where the turn wrote text. A file edited "
      + "and later reverted still counts as tracked. Subagent records, subagent transcripts and saved outputs were counted, "
      + "not read. Redaction is best effort.",
  };
}

const USAGE = "usage: session-closeout.js (--session-file <file> | --session-id <id> [--claude-home <dir>]) [--root <repository>]\n";

function main(argv, env = process.env) {
  const options = {
    "--session-file": null, "--session-id": null, "--root": process.cwd(),
    "--claude-home": env.CLAUDE_CONFIG_DIR || (HOME ? path.join(HOME, ".claude") : null),
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!(args[i] in options) || i + 1 >= args.length) return fail(USAGE, 2);
    options[args[i]] = args[i + 1];
  }
  let file = options["--session-file"];
  if (file === null) {
    const sessionId = options["--session-id"] || "";
    if (!/^[a-fA-F0-9-]{16,64}$/.test(sessionId)) return fail(USAGE, 2);
    // Never the latest session by guess: one id, and exactly one file that carries it.
    const matches = findTranscript("claude", sessionId, { claude: options["--claude-home"] });
    if (matches.length !== 1) {
      return fail(`session-closeout.js: expected one transcript for that session, found ${matches.length}. Supply --session-file.\n`, 2);
    }
    file = matches[0];
  }
  const root = path.resolve(options["--root"]);
  if (git(root, ["rev-parse", "--show-toplevel"]).status !== 0) return fail(`session-closeout.js: --root is not inside a Git work tree: ${root}\n`, 1);
  try {
    file = path.resolve(file);
    if (detectHost(file) !== "claude") return fail("session-closeout.js: only Claude Code transcripts are supported\n", 1);
    process.stdout.write(`${JSON.stringify(closeout(file, root), null, 2)}\n`);
    return 0;
  } catch (error) {
    return fail(`session-closeout.js: cannot read the transcript reliably: ${error.message}\n`, 1);
  }
}

function fail(message, code) {
  process.stderr.write(message);
  return code;
}

if (require.main === module) process.exitCode = main(process.argv);

module.exports = { closeout, main };
