#!/usr/bin/env node
"use strict";

// anneal's session close-out: what deleting one finished Claude Code session would lose. Reads the whole
// transcript with the session-evidence parser, finds where each file the session changed lives now, and prints
// JSON: one item per changed file, one per turn that ended in text, a verdict, and a cleanup flag that names leftover
// processes, worktrees and branches and a missing listing of ignored files. It stops no process, and writes, moves and
// deletes nothing; its Git queries take no optional locks.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { HOME, directory, excerpt } = require("./session-evidence-redaction.js");
const { textBlocks } = require("./session-evidence-records.js");
const { actorOf, firstCopies, isPrompt, isQueuedPrompt, subagentTranscripts } = require("./session-evidence-claude.js");
const { normalizePath, programs, withoutData } = require("./session-evidence-shell.js");
const { detectHost, findTranscript } = require("./session-evidence.js");

// The tools whose input holds what they wrote. A shell command that removes or moves a file carries no content.
const CONTENT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit", "Write"]);
// Where a changed file lives now. A file that is gone from disk is at risk: Git holds at most a committed version, not
// an edit the session never committed.
const KEPT = new Set(["tracked", "ignored"]);
const AT_RISK = new Set(["tracked-missing", "missing", "outside-missing", "unresolved"]);
// The cleanup flag: whether the session listed its ignored files after its last change, and which processes it
// started and never saw end, and which worktrees and branches it created and never removed.
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const STOP_TOOLS = new Set(["KillShell", "TaskStop"]);
const WORKTREE_TOOLS = new Set(["EnterWorktree", "ExitWorktree"]);
const PROCESS_KINDS = new Set(["background-command", "preview-server"]);
// Options of `git branch` that still let `git branch <name>` create a branch; with any other option, such as a list,
// rename or copy, the command creates none.
const BRANCH_FLAGS = new Set(["-f", "--force", "-t", "--track", "--no-track", "-q", "--quiet", "--create-reflog", "--recurse-submodules"]);
const BACKGROUND_ID = /running in background with ID: ([\w-]+)/i;
const SERVER_ID = /serverId["']?\s*[:=]\s*["']?([\w-]+)/i;
const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_ID = /<task-id>\s*([^<]*?)\s*<\/task-id>/;
const TASK_STATUS = /<status>\s*([^<]*?)\s*<\/status>/;

// The options and positional words of a git subcommand; each option in `valued` takes the next word as its value.
function parseArgs(args, valued) {
  const options = new Map();
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!args[i].startsWith("-") || args[i] === "-") {
      positional.push(args[i]);
      continue;
    }
    const [name, inline] = args[i].split(/=(.*)/s);
    options.set(name, inline ?? (valued.includes(name) ? args[++i] : true));
  }
  return { options, positional };
}

// The worktrees and branches one shell command line creates or removes through git, as far as its text and output
// show, and whether it lists ignored files. A worktree is keyed by its absolute path, so a relative add and an absolute
// remove pair. A forced branch creation that git reports as resetting a branch that already existed creates nothing.
function gitEffects(command, cwd, output) {
  const effects = [];
  const add = (op, kind, id, base) => {
    if (typeof id !== "string" || !id) return;
    const key = kind === "worktree"
      ? (normalizePath(id, base, true) || id).replace(/\\/g, "/").replace(/\/+$/, "").replace(/^[A-Z]:\/.*/, (text) => text.toLowerCase())
      : id;
    effects.push({ op, kind, id, key });
  };
  const create = (name, forced) => {
    if (!forced || !["Reset", "reset", "resetting"].some((verb) => output.includes(`${verb} branch '${name}'`))) add("create", "branch", name);
  };
  for (const part of programs(withoutData(command), true)) {
    const words = (part.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((word) => word.replace(/^(["'])([\s\S]*)\1$/, "$2"));
    // Assignments before the program, such as `GIT_TRACE=0`, only set its environment.
    let i = 0;
    while (/^[\w$:]+=/.test(words[i] || "")) i++;
    if ((words[i] || "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "") !== "git") continue;
    let base = cwd;
    for (i++; i < words.length && words[i].startsWith("-"); i++) {
      if (words[i] === "-C") base = normalizePath(words[++i], base, true);
      else if (/^(?:-c|--git-dir|--work-tree|--namespace)$/.test(words[i])) i++;
    }
    const [sub, ...rest] = words.slice(i);
    if (sub === "worktree" && rest[0] === "add") {
      const { options, positional } = parseArgs(rest.slice(1), ["-b", "-B", "--reason"]);
      add("create", "worktree", positional[0], base);
      if (typeof options.get("-b") === "string") create(options.get("-b"), false);
      else if (typeof options.get("-B") === "string") create(options.get("-B"), true);
    } else if (sub === "worktree" && rest[0] === "remove") {
      add("remove", "worktree", parseArgs(rest.slice(1), []).positional[0], base);
    } else if (sub === "checkout" || sub === "switch") {
      const valued = sub === "checkout" ? ["-b", "-B", "--orphan"] : ["-c", "-C", "--create", "--force-create", "--orphan"];
      const { options } = parseArgs(rest, valued);
      const flag = valued.find((name) => typeof options.get(name) === "string");
      if (flag) create(options.get(flag), ["-B", "-C", "--force-create"].includes(flag));
    } else if (sub === "status") {
      const ignored = parseArgs(rest, []).options.get("--ignored");
      if (ignored !== undefined && ignored !== "no") effects.push({ op: "list-ignored" });
    } else if (sub === "branch") {
      const { options, positional } = parseArgs(rest, []);
      const names = [...options.keys()];
      if (names.some((name) => name === "--delete" || /^-[a-zA-Z]*[dD]/.test(name))) positional.forEach((name) => add("remove", "branch", name));
      else if (names.every((name) => BRANCH_FLAGS.has(name))) add("create", "branch", positional[0]);
    }
  }
  return effects;
}

function git(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}

function locate(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { location: fs.existsSync(file) ? "outside" : "outside-missing", uncommitted: false };
  }
  const spec = relative.split(path.sep).join("/");
  // A pathspec names this one file, never a glob pattern; check-ignore takes plain path names.
  const literal = `:(literal)${spec}`;
  if (git(root, ["ls-files", "--error-unmatch", "--", literal]).status === 0) {
    const uncommitted = git(root, ["status", "--porcelain", "--", literal]).stdout.trim() !== "";
    return { location: uncommitted && !fs.existsSync(file) ? "tracked-missing" : "tracked", uncommitted };
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
  // A turn starts at a prompt the owner typed or queued while the agent worked, by the rule session-evidence uses.
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
  const unresolved = new Set();
  const pending = new Map();
  const processCalls = new Map();
  // What the session started or created, each marked ended by a later stop or removal that names it.
  const started = [];
  const end = (kinds, key) => started.forEach((each) => {
    if (kinds.has(each.kind) && each.key !== null && each.key === key) each.ended = true;
  });
  let ignoredStatusLine = null;
  // The worktree the session's last EnterWorktree created while the session is still in it; ExitWorktree acts on it only.
  let entered = null;
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
    // A background command that ended, however it ended, says so in a notification.
    const notices = row.type === "user" || row.type === "attachment"
      ? textBlocks(row.type === "user" ? message.content : (row.attachment || {}).prompt).join("\n") : "";
    for (const [, body] of notices.matchAll(NOTIFICATION)) {
      const id = (TASK_ID.exec(body) || [])[1];
      const status = (TASK_STATUS.exec(body) || [])[1];
      if (id && status && status !== "running") end(PROCESS_KINDS, id);
    }
    const queued = isQueuedPrompt(row);
    if (typed.has(line) || queued || !turn) {
      const starts = typed.has(line) || queued;
      turn = { promptLine: starts ? line : null,
        prompt: starts ? excerpt(textBlocks(queued ? row.attachment.prompt : message.content).join("\n"), 240) : null,
        textLines: [], endingLine: null, ending: null, wrote: new Set() };
      turns.push(turn);
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!block || typeof block !== "object") continue;
      if (row.type === "assistant" && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        if (turn.textLines.at(-1) !== line) turn.textLines.push(line);
        Object.assign(turn, { endingLine: line, ending: excerpt(block.text, 480) });
      } else if (block.type === "tool_use" && CONTENT_TOOLS.has(block.name)) {
        const input = block.input && typeof block.input === "object" ? block.input : {};
        const named = [input.file_path, input.notebook_path].find((value) => typeof value === "string" && value);
        // The tool takes its path literally. One the script cannot resolve, such as `~/plan.md`, is kept as written.
        const resolved = named && normalizePath(named, cwd, true);
        if (named) pending.set(block.id, { path: resolved || named, resolved: Boolean(resolved), line, turn });
      } else if (block.type === "tool_use" && (SHELL_TOOLS.has(block.name) || STOP_TOOLS.has(block.name)
        || WORKTREE_TOOLS.has(block.name) || /preview_st(?:art|op)$/.test(block.name))) {
        processCalls.set(block.id, { tool: block.name, input: block.input && typeof block.input === "object" ? block.input : {}, line });
      } else if (block.type === "tool_result" && processCalls.has(block.tool_use_id)) {
        const { tool, input, line: callLine } = processCalls.get(block.tool_use_id);
        processCalls.delete(block.tool_use_id);
        if (block.is_error) continue;
        const output = textBlocks(block.content).join("\n");
        const command = typeof input.command === "string" ? input.command : "";
        const start = (kind, id, key, text) => started.push({ kind, id, key, callLine, command: excerpt(text, 240), ended: false });
        if (SHELL_TOOLS.has(tool)) {
          const background = input.run_in_background === true;
          for (const effect of gitEffects(command, cwd, output)) {
            if (effect.op === "create") start(effect.kind, effect.id, effect.key, command);
            else if (effect.op === "remove") end(new Set([effect.kind]), effect.key);
            else if (!background) ignoredStatusLine = callLine;
          }
          if (background) {
            const id = (BACKGROUND_ID.exec(output) || [])[1] || null;
            start("background-command", id, id, command);
          }
        } else if (tool.endsWith("preview_start")) {
          // A call with only a url opens a page and starts no server.
          if (typeof input.name === "string" && input.name) {
            const id = (SERVER_ID.exec(output) || [])[1] || null;
            start("preview-server", id, id, input.name);
          }
        } else if (tool === "EnterWorktree") {
          // A call with a path enters a worktree that already exists.
          entered = null;
          if (!input.path) {
            start("worktree", typeof input.name === "string" ? input.name : null, `EnterWorktree:${callLine}`, "EnterWorktree");
            entered = started.at(-1);
          }
        } else if (tool === "ExitWorktree") {
          // It leaves the worktree, and with remove deletes it and its branch.
          if (entered && input.action === "remove") entered.ended = true;
          entered = null;
        } else {
          end(PROCESS_KINDS, input.serverId ?? input.task_id ?? input.shell_id ?? input.bash_id);
        }
      } else if (block.type === "tool_result" && pending.has(block.tool_use_id)) {
        const call = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        // A refused or failed call changed nothing.
        if (block.is_error) continue;
        if (!call.resolved) unresolved.add(call.path);
        if (!changes.has(call.path)) changes.set(call.path, []);
        changes.get(call.path).push(call.line);
        call.turn.wrote.add(call.path);
      }
    }
  }
  if (sidechain) warnings.add(`Skipped ${sidechain} subagent records in the transcript; only the main session's turns are listed.`);

  const located = new Map([...changes.keys()].map((changed) => [changed,
    unresolved.has(changed) ? { location: "unresolved", uncommitted: false } : locate(root, changed)]));
  const items = [...changes].map(([changed, lines]) => {
    const { location, uncommitted } = located.get(changed);
    return { kind: "change", path: excerpt(changed), location, uncommitted, callLines: lines, atRisk: AT_RISK.has(location) };
  });
  for (const { wrote, ...rest } of turns.filter((each) => each.ending !== null)) {
    const location = [...wrote].some((changed) => KEPT.has(located.get(changed).location)) ? "file" : "transcript-only";
    items.push({ kind: "turn", ...rest, wrote: [...wrote].map((changed) => excerpt(changed)), location, atRisk: location === "transcript-only" });
  }
  const wouldLose = items.filter((item) => item.atRisk)
    .map((item) => (item.kind === "turn" ? { kind: "turn", endingLine: item.endingLine } : { kind: "change", path: item.path }));
  const lastChangeLine = Math.max(0, ...[...changes.values()].flat());
  const statusAfterChanges = ignoredStatusLine !== null && ignoredStatusLine > lastChangeLine ? ignoredStatusLine : null;
  // A start whose id the transcript does not show is never paired with a stop, so it is always listed.
  const leftovers = started.filter((each) => !each.ended)
    .map(({ kind, id, callLine, command }) => ({ kind, id: id === null ? null : excerpt(id, 240), callLine, command }));
  const folder = path.join(path.dirname(file), path.basename(file, ".jsonl"));
  return {
    sessionFile: file, sessionId, context: { cwd: directory(cwd) }, root: directory(root),
    verdict: wouldLose.length ? "would-lose" : "safe-to-delete", wouldLose, items,
    alsoDeleted: { folder: directory(folder), subagentTranscripts: subagentTranscripts(file).length, savedOutputs: countFiles(path.join(folder, "tool-results")) },
    cleanup: {
      flag: statusAfterChanges !== null && !leftovers.length ? "clean" : "needs-cleanup",
      lastChangeLine: lastChangeLine || null, ignoredStatusLine: statusAfterChanges, leftovers,
      limits: "Reported from the transcript only; no process, worktree, branch or file was checked. The ignored-file listing "
        + "is a successful Bash or PowerShell call of git status with --ignored, other than --ignored=no, after the session's "
        + "last Edit, MultiEdit, NotebookEdit or Write change, or anywhere in a session with none, since a shell command can "
        + "write files. A leftover is a background command or preview server the session started and never saw stopped or "
        + "ended by its id, or a worktree or branch it created with git worktree add (-b or -B), git checkout -b, -B or "
        + "--orphan, git switch -c, -C, --create, --force-create or --orphan, git branch <name> or EnterWorktree and never "
        + "removed with git worktree remove of the same path, git branch -d or -D, or ExitWorktree remove, which removes only "
        + "the worktree the session is in. A worktree from EnterWorktree is removed only by ExitWorktree remove; a later git "
        + "worktree remove of it is not seen, so it stays listed. A forced form (-B, -C, --force-create) whose output says git reset a branch that already "
        + "existed creates none; one with no such output, as in quiet mode or another language, is listed. A start whose "
        + "id the transcript does not show is always listed. A process started any other way, such as with & in a shell "
        + "command, the branch git worktree add creates without -b, a branch name joined to its option, a cd earlier in the "
        + "same command line, worktree prune, branch renames, every git command in a shell call that reported an error "
        + "and every git command inside a here-document body, a PowerShell here-string or a block comment, even a body "
        + "fed to a shell such as bash, sh or pwsh, which runs it, are not seen.",
    },
    warnings: [...warnings].sort(),
    limits: "Claude Code only. A change is a call of Edit, MultiEdit, NotebookEdit or Write that reported no error; a shell "
      + "command that changed files is not listed. A path the script cannot resolve, such as one starting with ~, is "
      + "unresolved and at risk until checked by hand. A turn counts as in a file when it changed any file whose location is now tracked "
      + "or ignored, even an unrelated one, and as transcript-only otherwise, including a turn of questions or status. Only a turn's "
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
  // A live session is not finished: the session running this command is never closed out.
  const running = (env.CLAUDE_CODE_SESSION_ID || "").toLowerCase();
  const isRunning = (id) => Boolean(running) && id.toLowerCase() === running;
  const RUNNING = "session-closeout.js: that is the session running this command, and a live session is not finished. "
    + "Run the close-out from another session once this one has ended.\n";
  let file = options["--session-file"];
  if (file === null) {
    const sessionId = options["--session-id"] || "";
    if (!/^[a-fA-F0-9-]{16,64}$/.test(sessionId)) return fail(USAGE, 2);
    if (isRunning(sessionId)) return fail(RUNNING, 2);
    // Never the latest session by guess: one id, and exactly one file that carries it.
    const matches = findTranscript("claude", sessionId, { claude: options["--claude-home"] });
    if (matches.length !== 1) {
      return fail(`session-closeout.js: expected one transcript for that session, found ${matches.length}. Supply --session-file.\n`, 2);
    }
    file = matches[0];
  }
  if (isRunning(path.basename(file, ".jsonl"))) return fail(RUNNING, 2);
  const root = path.resolve(options["--root"]);
  if (git(root, ["rev-parse", "--show-toplevel"]).status !== 0) return fail(`session-closeout.js: --root is not inside a Git work tree: ${root}\n`, 1);
  try {
    file = path.resolve(file);
    if (detectHost(file) !== "claude") return fail("session-closeout.js: only Claude Code transcripts are supported\n", 1);
    const report = closeout(file, root);
    // A renamed copy of the running session's transcript still carries its id in the records.
    if (isRunning(report.sessionId || "")) return fail(RUNNING, 2);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
