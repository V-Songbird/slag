#!/usr/bin/env node
"use strict";

// anneal's repeated-step search: which deterministic steps several sessions of one repository ran the same way.
// Reads Claude Code transcripts and Codex rollouts with the session-evidence parser, through the calls and owner
// prompts it hands to its hooks, and prints JSON: repeated shell commands, short sequences of steps, file lookups and
// typed owner prompts, each seen in at least --min-sessions sessions. Matching is text equality after normalization; a
// finding is listed, never judged. Read-only: it writes nothing and never touches an instruction file.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { HOME, cut, directory, excerpt, redact } = require("./session-evidence-redaction.js");
const { records } = require("./session-evidence-records.js");
const { analyzeClaude } = require("./session-evidence-claude.js");
const { CODEX_SHELL_TOOLS, analyzeCodex } = require("./session-evidence-codex.js");
const { detectHost } = require("./session-evidence.js");

const WINDOWS = process.platform === "win32";
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const LOOKUP_TOOLS = new Set(["Read", "NotebookRead", "Grep", "Glob", "LS"]);
const MAP_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"];
const KINDS = ["commands", "sequences", "lookups", "prompts"];
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// A hex run of seven or more characters with a digit and a letter in it, such as a commit or a generated id.
const HEX = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi;
const TEMP_FOLDER = /(?:^|\/)(?:tmp|temp|scratchpad)\//i;
// Host envelopes a typed prompt can carry, such as <system-reminder>…</system-reminder>.
const ENVELOPE = /<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMAND_NAME = /<command-name>\s*(\/[^\s<]+)\s*<\/command-name>/;
const CUT = " [excerpt truncated]";
// What redaction writes in place of a secret or a character a reader cannot see.
const MARKERS = /(\[REDACTED\]|<U\+[0-9A-F]{4,6}>|<\d+ Unicode tag characters?>)/;
// A printed step's bound, below the key's.
const SHOWN = 240;

const USAGE = "usage: session-repeats.js --root <repository> [--sessions-dir <dir>]... [--session-file <file>]... [--also-root <repository>]...\n"
  + "       [--claude-home <dir>] [--codex-home <dir>] [--min-sessions <2-20>] [--limit <1-30>]\n";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const slashes = (text) => text.replace(/\\/g, "/");
const same = (a, b) => (WINDOWS ? slashes(a).toLowerCase() === slashes(b).toLowerCase() : slashes(a) === slashes(b));

function git(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}

// A repository's paths: its top level and every worktree Git lists for it. Null outside a Git work tree.
function repositoryPaths(root) {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return null;
  const paths = [path.resolve(top.stdout.trim())];
  for (const line of git(root, ["worktree", "list", "--porcelain"]).stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      const worktree = path.resolve(line.slice(9).trim());
      if (!paths.some((known) => same(known, worktree))) paths.push(worktree);
    }
  }
  return paths;
}

// Claude Code names a project's folder after its path, each character outside [A-Za-z0-9] a hyphen.
const projectKey = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-");

function list(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walk(dir) {
  return list(dir).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

// The top-level transcripts of a folder, never a journal.
const transcriptsIn = (dir) => list(dir).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && entry.name !== "journal.jsonl")
  .map((entry) => path.join(dir, entry.name)).sort();

// A Claude Code session's subagent transcripts, which count toward it.
const subagentsOf = (file) => walk(path.join(path.dirname(file), path.basename(file, ".jsonl"), "subagents"))
  .filter((name) => /^agent-.*\.jsonl$/.test(path.basename(name))).sort();

// The sessions that ran in a repository: Claude Code project folders whose key is one of its paths, or a Claude Code
// worktree under one of them, and Codex rollouts whose first session_meta names one of its paths as cwd.
function discover(paths, homes) {
  const keys = paths.map(projectKey);
  const match = (name) => keys.some((key) => (WINDOWS ? name.toLowerCase() : name) === (WINDOWS ? key.toLowerCase() : key)
    || (WINDOWS ? name.toLowerCase() : name).startsWith(`${WINDOWS ? key.toLowerCase() : key}--claude-worktrees-`));
  const claude = homes.claude ? list(path.join(homes.claude, "projects")).filter((entry) => entry.isDirectory() && match(entry.name))
    .flatMap((entry) => transcriptsIn(path.join(homes.claude, "projects", entry.name))) : [];
  const codex = homes.codex ? walk(path.join(homes.codex, "sessions")).filter((file) => {
    const cwd = file.endsWith(".jsonl") ? rolloutMeta(file).cwd : null;
    return typeof cwd === "string" && paths.some((dir) => same(path.resolve(cwd), dir));
  }) : [];
  return [...claude, ...codex.sort()];
}

// A Codex rollout's first session_meta payload, or {} when it has none.
function rolloutMeta(file) {
  try {
    for (const [, row] of records(fs.readFileSync(file), new Set())) {
      if (row.type === "session_meta") return row.payload && typeof row.payload === "object" ? row.payload : {};
    }
  } catch {
    return {};
  }
  return {};
}

// Every spelling a repository path can take in a command: either slash, MSYS's /d/…, and redacted as the evidence
// copies it. Longest first, so a worktree inside the root collapses before the root.
function prefixPattern(paths) {
  const forms = new Set();
  for (const dir of paths) {
    const forward = slashes(dir);
    const msys = forward.replace(/^([A-Za-z]):/, (m, drive) => `/${drive.toLowerCase()}`);
    for (const form of [forward, msys]) for (const spelled of [form, slashes(redact(form))]) forms.add(spelled);
  }
  const body = [...forms].sort((a, b) => b.length - a.length).map((form) => escape(form).replace(/\//g, String.raw`[\\/]+`)).join("|");
  return new RegExp(String.raw`(?:${body})(?=[\\/"'\s;|&)]|$)`, WINDOWS ? "gi" : "g");
}

// A path token under the temporary directory, or in a tmp, temp or scratchpad folder, as <temp>/<its name>. A
// redirect such as 2> before the path keeps its place.
function withoutTemp(text) {
  const temp = slashes(os.tmpdir()).toLowerCase();
  return text.replace(/[^\s"'`=;|&()<>][^\s"'`=;|&()]*/g, (token) => {
    const [, redirect = "", rest] = /^(\d*[<>]+)?(.*)$/s.exec(token);
    const forward = slashes(rest);
    const under = TEMP_FOLDER.test(forward) || (temp.length > 3 && forward.toLowerCase().startsWith(`${temp}/`));
    return under ? `${redirect}<temp>/${forward.split("/").filter(Boolean).pop()}` : token;
  });
}

// Once the repository is `.`, a leading `cd .` or `pwd` and git's `-C .` change nothing, so they are dropped.
const HERE = String.raw`(?:"\."|'\.'|\.)`;
const LEAD = new RegExp(String.raw`^(?:(?:cd|set-location|push-location) ${HERE}|pwd) ?(?:&&|;) ?`, "i");
const GIT_HERE = new RegExp(String.raw`\bgit -C ${HERE}(?= )`, "g");

function normalizer(paths) {
  const prefix = prefixPattern(paths);
  return (text) => {
    let step = text.trim().replace(/\s+/g, " ").replace(prefix, ".").replace(/\.[\\/]+\.claude[\\/]+worktrees[\\/]+[^\\/\s"']+/g, ".");
    while (LEAD.test(step)) step = step.replace(LEAD, "");
    return withoutTemp(step.replace(GIT_HERE, "git")).replace(UUID, "<id>").replace(HEX, "<id>");
  };
}

// The string `name` holds in a JSON arguments object the evidence cut at its bound, directly or as the script of a
// three-item shell array: its text up to the cut, marked as cut unless it closed before it. Null when the cut text
// holds no such key.
function cutString(input, name) {
  if (!input.startsWith("{") || !input.endsWith(CUT)) return null;
  const found = new RegExp(String.raw`"${name}"\s*:\s*(?:\[\s*"(?:[^"\\]|\\.)*"\s*,\s*"-(?:l?c|command)"\s*,\s*)?"((?:[^"\\]|\\.)*)(")?`, "i")
    .exec(input.slice(0, -CUT.length));
  if (!found) return null;
  try {
    return JSON.parse(`"${found[1].replace(/\\u[0-9a-f]{0,3}$/i, "")}"`) + (found[2] ? "" : CUT);
  } catch {
    return null;
  }
}

// The shell command a Codex call ran: `cmd` or `command` in a direct call's arguments, or the one exec_command or
// shell_command literal in a code-mode exec script. Null when the call carries none, or more than one.
function codexCommand(input) {
  if (typeof input !== "string") return null;
  try {
    const args = JSON.parse(input);
    const command = args && (args.cmd ?? args.command);
    if (typeof command === "string") return command;
    if (Array.isArray(command)) return command.length === 3 && /^-(?:l?c|command)$/i.test(String(command[1])) ? String(command[2]) : command.join(" ");
    return null;
  } catch {
    const found = [...input.matchAll(/tools\.(?:exec_command|shell_command)\(\s*\{\s*(?:cmd|command)\s*:\s*("(?:[^"\\]|\\.)*")/g)];
    if (!found.length) return cutString(input, "cmd") ?? cutString(input, "command");
    if (found.length !== 1) return null;
    try {
      return JSON.parse(found[0][1]);
    } catch {
      return null;
    }
  }
}

function argument(input, name) {
  try {
    const value = JSON.parse(input)[name];
    return typeof value === "string" ? value : null;
  } catch {
    return typeof input === "string" ? cutString(input, name) : null;
  }
}

// A call as a step: a lookup for a file tool's read or search and a shell read of one path, a command for any other
// shell command. A command run from a folder inside the repository other than its top level keeps that folder in
// front, as `cd <folder> && <command>`; on Codex the folder is the call's workdir when it names one. A folder outside
// the repository adds nothing. An edit, a write and any other call is no step.
function stepOf(call, host, normalize) {
  const where = (file) => normalize(file).replace(/^\.(?:[\\/]+|$)/, "") || ".";
  if (host === "claude" && LOOKUP_TOOLS.has(call.tool)) {
    if (call.tool === "Grep" || call.tool === "Glob") {
      const pattern = argument(call.commandOrArguments, "pattern");
      return pattern === null ? null : { kind: "lookups", key: `${call.tool} ${normalize(pattern)}` };
    }
    if (call.path === null) return null;
    return { kind: "lookups", key: `${call.tool === "LS" ? "LS" : "read"} ${where(call.path)}` };
  }
  const command = host === "claude" ? (SHELL_TOOLS.has(call.tool) ? call.commandOrArguments : null)
    : CODEX_SHELL_TOOLS.has(call.tool) ? codexCommand(call.commandOrArguments) : null;
  if (typeof command !== "string" || !command.trim()) return null;
  if (call.operation === "read" && call.path !== null) return { kind: "lookups", key: `read ${where(call.path)}` };
  const workdir = host === "codex" ? argument(call.commandOrArguments, "workdir") : null;
  const dir = workdir && call.cwd && !path.isAbsolute(workdir) ? path.join(call.cwd, workdir) : workdir || call.cwd;
  const inside = typeof dir === "string" && dir ? /^\.[\\/]+(.+)$/.exec(normalize(excerpt(dir))) : null;
  const key = normalize(command);
  if (!inside) return { kind: "commands", key };
  const folder = slashes(inside[1]).replace(/\/+$/, "");
  return { kind: "commands", key: `cd ${/^[\w./<>-]+$/.test(folder) ? folder : JSON.stringify(folder)} && ${key}` };
}

// A typed prompt's key, read from the redacted prompt, so a home path or account name that redaction matches by case
// is gone before lower casing: a slash command, a first word whose only slash leads it, by its name; any other prompt
// lower case outside redaction's markers, without host envelopes, with its whitespace collapsed and its closing
// punctuation removed. A prompt that starts with an absolute path is keyed whole.
function promptKey(text) {
  const named = COMMAND_NAME.exec(text);
  const typed = redact(named ? named[1] : text.replace(ENVELOPE, " ")).split(MARKERS)
    .map((part, index) => (index % 2 ? part : part.toLowerCase())).join("").replace(/\s+/g, " ").trim();
  if (/^\/[^\s/]+(?:\s|$)/.test(typed)) return typed.split(" ")[0];
  return typed.replace(/[\s.!?¡¿,;:…]+$/u, "") || null;
}

// What a map file at the root, or a file one of them imports with @, names: each inline code span, each line of a
// fenced block and each link target, whitespace collapsed. A step is named only as one of them whole. `rows` holds
// each prose line with its inline code spans, so a command can be named beside the folder it runs from.
function mapSpans(root) {
  const texts = [];
  for (const name of MAP_FILES) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    texts.push(text);
    for (const [, target] of text.matchAll(/(?:^|\s)@([^\s`]+)/g)) {
      const imported = path.resolve(root, target);
      if (!path.relative(root, imported).startsWith("..") && fs.existsSync(imported) && fs.statSync(imported).isFile()) {
        texts.push(fs.readFileSync(imported, "utf8"));
      }
    }
  }
  const spans = [];
  const rows = [];
  for (const text of texts) {
    const prose = text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^ {0,3}\1[^\n]*$/gm, (block, fence, body) => {
      spans.push(...body.split("\n"));
      return "";
    });
    for (const [, span] of prose.matchAll(/`([^`\n]+)`/g)) spans.push(span);
    for (const [, target] of prose.matchAll(/\]\(\s*<?([^)\s>]+)/g)) spans.push(target.replace(/#.*$/, "").replace(/^\.\//, ""));
    for (const line of prose.split("\n")) {
      const code = [...line.matchAll(/`([^`\n]+)`/g)].map(([, span]) => span);
      if (code.length) rows.push({ spans: code, text: line });
    }
  }
  const collapse = (span) => span.trim().replace(/\s+/g, " ");
  return { spans: new Set(spans.map(collapse).filter(Boolean)), rows: rows.map((row) => ({ spans: row.spans.map(collapse), text: row.text })) };
}

// Whether the map names a command whole, or names a command run from a folder, `cd <folder> && <command>`, as the bare
// command in a row whose text names the folder as a path: `<folder>`, `<folder>/` or `./<folder>`.
function namesCommand(map, command) {
  if (map.spans.has(command)) return true;
  const keyed = /^cd ("(?:[^"\\]|\\.)*"|\S+) && (.+)$/.exec(command);
  if (!keyed) return false;
  const folder = keyed[1].startsWith('"') ? JSON.parse(keyed[1]) : keyed[1];
  const named = new RegExp(String.raw`(?<![\w./-])(?:\./)?${escape(folder)}/?(?![\w-]|[./][\w-])`, WINDOWS ? "i" : "");
  return map.rows.some((row) => row.spans.includes(keyed[2]) && named.test(row.text));
}

// The root package.json script a command runs by name, or whose own text is the command.
function scriptsOf(root) {
  try {
    const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;
    return scripts && typeof scripts === "object" ? scripts : {};
  } catch {
    return {};
  }
}

function projectScript(command, scripts, byName = true) {
  // `bun test` runs Bun's own test runner, whatever the scripts hold, so a Bun script runs by name only with `bun run`.
  const run = byName && /^(?:(?:npm|pnpm|yarn)(?: run(?:-script)?)?|bun run) ([\w:.-]+)\b|^node --run ([\w:.-]+)\b/.exec(command);
  const name = run && (run[1] || run[2]);
  if (name && Object.hasOwn(scripts, name)) return name;
  return Object.keys(scripts).sort().find((key) => scripts[key] === command) ?? null;
}

function parse(argv) {
  const repeatable = new Set(["--sessions-dir", "--session-file", "--also-root"]);
  const options = { "--sessions-dir": [], "--session-file": [], "--also-root": [], "--root": null, "--claude-home": null, "--codex-home": null,
    "--min-sessions": "3", "--limit": "10" };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!(args[i] in options) || i + 1 >= args.length) return null;
    if (repeatable.has(args[i])) options[args[i]].push(args[i + 1]);
    else options[args[i]] = args[i + 1];
  }
  return options;
}

function main(argv, env = process.env) {
  const options = parse(argv);
  if (!options || options["--root"] === null) return fail(USAGE, 2);
  const minimum = Number(options["--min-sessions"]);
  if (!/^\d+$/.test(options["--min-sessions"]) || minimum < 2 || minimum > 20) return fail("session-repeats.js: --min-sessions must be between 2 and 20\n", 2);
  const limit = Number(options["--limit"]);
  if (!/^\d+$/.test(options["--limit"]) || limit < 1 || limit > 30) return fail("session-repeats.js: --limit must be between 1 and 30\n", 2);
  const homes = {
    claude: options["--claude-home"] || env.CLAUDE_CONFIG_DIR || (HOME ? path.join(HOME, ".claude") : null),
    codex: options["--codex-home"] || env.CODEX_HOME || (HOME ? path.join(HOME, ".codex") : null),
  };
  const root = path.resolve(options["--root"]);
  const repositories = [{ root, paths: repositoryPaths(root), own: true }];
  for (const other of options["--also-root"]) repositories.push({ root: path.resolve(other), paths: repositoryPaths(path.resolve(other)), own: false });
  const outside = repositories.find((repository) => repository.paths === null);
  if (outside) return fail(`session-repeats.js: not inside a Git work tree: ${outside.root}\n`, 2);

  // The files to read, each with the repository it belongs to. Named files and folders replace discovery.
  const named = options["--session-file"].length || options["--sessions-dir"].length;
  const searched = named ? [...options["--session-file"], ...options["--sessions-dir"]].map((item) => directory(path.resolve(item)))
    : [`${directory(path.join(homes.claude || "", "projects"))} (Claude Code)`, `${directory(path.join(homes.codex || "", "sessions"))} (Codex)`];
  const sessions = [];
  const seen = new Set();
  const add = (file, repository) => {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    sessions.push({ file: resolved, repository });
  };
  if (named) {
    for (const file of options["--session-file"]) add(file, repositories[0]);
    for (const dir of options["--sessions-dir"]) for (const file of transcriptsIn(path.resolve(dir))) add(file, repositories[0]);
  } else {
    for (const repository of repositories) for (const file of discover(repository.paths, homes)) add(file, repository);
  }
  for (const repository of repositories.slice(named ? 1 : repositories.length)) for (const file of discover(repository.paths, homes)) add(file, repository);

  const running = [env.CLAUDE_CODE_SESSION_ID, env.CODEX_THREAD_ID].filter(Boolean);
  const normalize = normalizer(repositories[0].paths);
  // A script's text and what the map names are normalized as a step is, so that they compare with its key.
  const scripts = Object.fromEntries(Object.entries(scriptsOf(root)).map(([key, text]) => [key, typeof text === "string" ? normalize(text) : null]));
  const spans = mapSpans(root);
  const map = { spans: new Set([...spans.spans].map(normalize)), rows: spans.rows.map((row) => ({ spans: row.spans.map(normalize), text: normalize(row.text) })) };
  const tallies = Object.fromEntries(KINDS.map((kind) => [kind, new Map()]));
  const skipped = [];
  const read = { claude: 0, codex: 0, subagentTranscripts: 0 };
  // The earliest and the latest typed prompt of the sessions read, as their records time them.
  const dates = { first: null, last: null };
  let cutSteps = 0;
  // The uuids of the Claude Code records already counted. A resumed session's transcript copies earlier records with
  // their uuids, and a copy another transcript already gave is not counted again.
  const counted = new Set();
  const fresh = (item, own) => {
    if (!item.uuid) return true;
    own.add(item.uuid);
    return !counted.has(item.uuid);
  };
  // `parts` are a sequence's commands, kept apart since a command's own text can hold the ` -> ` that joins them.
  const count = (kind, key, session, file, line, subagent, repository, parts = [key]) => {
    if (!tallies[kind].has(key)) {
      tallies[kind].set(key, { sessions: new Set(), occurrences: 0, inSubagents: 0, first: new Map(), repositories: new Set(), parts });
    }
    const tally = tallies[kind].get(key);
    tally.sessions.add(session);
    tally.occurrences += 1;
    if (subagent) tally.inSubagents += 1;
    tally.repositories.add(repository);
    if (!tally.first.has(session)) tally.first.set(session, { sessionFile: shown(file), line });
  };
  // A transcript inside the root is named from the root, any other one with the home directory shortened to ~.
  const shown = (file) => {
    const relative = path.relative(root, file);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? slashes(relative) : directory(file);
  };

  // Each session to count, with its main transcript and its subagent transcripts. A Codex rollout whose first
  // session_meta names the thread it was forked from is a sub-agent's: it counts toward the rollout of the thread at
  // the start of that chain, or, when that rollout is not read, toward a session of its own that its sibling forks share.
  const entries = [];
  const parents = new Map(); // a forked Codex thread to the thread it was forked from
  for (const { file, repository } of sessions) {
    let host;
    try {
      host = detectHost(file);
    } catch (error) {
      skipped.push({ sessionFile: directory(file), reason: "unreadable", message: excerpt(error.message, 240) });
      continue;
    }
    const meta = host === "codex" ? rolloutMeta(file) : {};
    const id = typeof meta.id === "string" ? meta.id : null;
    const forked = id !== null && meta.forked_from_id != null;
    if (forked) parents.set(id, String(meta.forked_from_id));
    entries.push({ file, repository, host, id, forked });
  }
  const origin = (id) => {
    const seen = new Set();
    while (parents.has(id) && !seen.has(id)) {
      seen.add(id);
      id = parents.get(id);
    }
    return id;
  };
  const groups = [];
  const byThread = new Map(); // a Codex thread to the session its rollout and its forks count toward
  for (const entry of entries.filter((candidate) => !candidate.forked)) {
    const group = { key: entry.file, file: entry.file, repository: entry.repository, host: entry.host, forks: [] };
    groups.push(group);
    if (entry.id !== null && !byThread.has(entry.id)) byThread.set(entry.id, group);
  }
  for (const entry of entries.filter((candidate) => candidate.forked)) {
    const thread = origin(entry.id);
    if (!byThread.has(thread)) {
      const group = { key: `codex thread ${thread}`, file: null, repository: entry.repository, host: "codex", forks: [] };
      groups.push(group);
      byThread.set(thread, group);
    }
    byThread.get(thread).forks.push(entry.file);
  }

  for (const { key: session, file, repository, host, forks } of groups) {
    const name = file === null ? "" : path.basename(file, ".jsonl");
    if (running.some((id) => name === id || name.endsWith(`-${id}`))) {
      skipped.push({ sessionFile: directory(file), reason: "running-session" });
      continue;
    }
    const agents = host === "claude" ? subagentsOf(file) : forks;
    const transcripts = [...(file === null ? [] : [{ file, subagent: false }]), ...agents.map((agent) => ({ file: agent, subagent: true }))];
    const steps = [];
    let prompts = [];
    let readOne = false;
    // The Codex call ids this session's rollouts already gave: a fork that marks no start of its own history copies
    // its parent's calls with their ids.
    const callIds = new Set();
    for (const transcript of transcripts) {
      const calls = [];
      const typed = [];
      const hooks = {
        onCall: (call) => calls.push(call),
        onPrompt: (prompt) => typed.push(prompt),
      };
      let result;
      try {
        result = host === "codex" ? analyzeCodex(transcript.file, Number.MAX_SAFE_INTEGER, 1, hooks)
          : analyzeClaude(transcript.file, Number.MAX_SAFE_INTEGER, 1, hooks);
      } catch (error) {
        // A session whose main transcript cannot be read is not counted, nor are its subagent transcripts.
        skipped.push({ sessionFile: directory(transcript.file), reason: "unreadable", message: excerpt(error.message, 240) });
        if (transcript.subagent) continue;
        break;
      }
      if (running.includes(result.sessionId)) {
        skipped.push({ sessionFile: directory(transcript.file), reason: "running-session" });
        if (transcript.subagent) continue;
        break;
      }
      readOne = true;
      if (transcript.subagent) read.subagentTranscripts += 1;
      else read[host] += 1;
      const own = new Set();
      for (const call of calls) {
        if (call.callId != null) {
          if (callIds.has(call.callId)) continue;
          callIds.add(call.callId);
        }
        const step = repository.own && fresh(call, own) ? stepOf(call, host, normalize) : null;
        if (step) steps.push({ ...step, file: transcript.file, line: call.callLine, actor: call.actor, promptLine: call.promptLine, subagent: transcript.subagent });
      }
      if (!transcript.subagent) prompts = typed.filter((prompt) => fresh(prompt, own));
      for (const uuid of own) counted.add(uuid);
    }
    if (!readOne) continue;
    // Codex records a typed prompt as an item and again as an event: the second of two adjacent prompts with the same
    // text and no call between them is that copy.
    const kept = [];
    for (const prompt of prompts) {
      const last = kept[kept.length - 1];
      const between = last && steps.some((step) => step.file === file && step.line > last.line && step.line < prompt.line);
      if (host === "codex" && last && last.text === prompt.text && !between) continue;
      kept.push(prompt);
    }
    for (const prompt of kept) {
      if (prompt.timestamp && (dates.first === null || prompt.timestamp < dates.first)) dates.first = prompt.timestamp;
      if (prompt.timestamp && (dates.last === null || prompt.timestamp > dates.last)) dates.last = prompt.timestamp;
      const key = promptKey(prompt.text);
      if (key) count("prompts", cut(key, 120), session, file, prompt.line, false, repository.root);
    }
    for (const step of steps) {
      if (step.key.endsWith(CUT)) cutSteps += 1;
      count(step.kind, step.key, session, step.file, step.line, step.subagent, repository.root);
    }
    // Two or three consecutive commands by one actor for one prompt, in call order; a command run again at once counts
    // once. Lookups between them do not break a run: a repeated read is a lookup finding of its own.
    const runs = new Map();
    for (const step of steps.filter((candidate) => candidate.kind === "commands")) {
      const group = JSON.stringify([step.file, step.actor, step.promptLine]);
      if (!runs.has(group)) runs.set(group, []);
      const run = runs.get(group);
      if (!run.length || run[run.length - 1].key !== step.key) run.push(step);
    }
    for (const run of runs.values()) {
      for (let size = 2; size <= 3; size++) {
        for (let i = 0; i + size <= run.length; i++) {
          const part = run.slice(i, i + size);
          const keys = part.map((step) => step.key);
          count("sequences", keys.join(" -> "), session, part[0].file, part[0].line, part[0].subagent, repository.root, keys);
        }
      }
    }
  }
  if (!read.claude && !read.codex && !read.subagentTranscripts) {
    return fail(`session-repeats.js: no session found to read. Searched: ${searched.join(", ")}. Supply --session-file or --sessions-dir.\n`, 2);
  }

  const findings = {};
  let shortened = 0;
  for (const kind of KINDS) {
    const listed = [...tallies[kind].entries()]
      .filter(([, tally]) => tally.sessions.size >= minimum)
      .map(([key, tally]) => {
        // A prompt's key is already redacted and cut to its bound.
        const finding = {
          kind, step: kind === "prompts" ? key : excerpt(key, SHOWN), sessions: tally.sessions.size, occurrences: tally.occurrences,
          inSubagents: tally.inSubagents,
          examples: [...tally.first.values()].sort((a, b) => (a.sessionFile < b.sessionFile ? -1 : a.sessionFile > b.sessionFile ? 1 : a.line - b.line)).slice(0, 3),
        };
        if (kind === "commands" || kind === "sequences") {
          finding.namedInMap = tally.parts.every((part) => namesCommand(map, part));
          // A sequence is a script's only when the script's own text runs exactly its commands.
          finding.projectScript = kind === "commands" ? projectScript(key, scripts) : projectScript(tally.parts.join(" && "), scripts, false);
        }
        // A lookup is named when the map names its path, also from the root as ./<path>, or its pattern.
        const target = key.slice(key.indexOf(" ") + 1);
        if (kind === "lookups") finding.namedInMap = map.spans.has(target) || map.spans.has(`./${target}`);
        if (kind === "prompts") finding.repositories = tally.repositories.size;
        return { key, finding };
      })
      .sort(({ finding: a }, { finding: b }) => b.sessions - a.sessions || b.occurrences - a.occurrences || (a.step < b.step ? -1 : a.step > b.step ? 1 : 0))
      .slice(0, limit);
    shortened += listed.filter(({ key }) => kind !== "prompts" && key.length > SHOWN).length;
    findings[kind] = listed.map(({ finding }) => finding);
  }
  const warnings = [];
  if (cutSteps) warnings.push(`${cutSteps} steps were cut at the evidence's 480-character bound; steps that differ only after the cut share a key.`);
  if (shortened) {
    warnings.push(`${shortened} listed steps are printed cut to ${SHOWN} characters; findings whose steps differ only after that print the same step.`);
  }
  const output = {
    root: directory(root), repositories: repositories.map((repository) => directory(repository.root)), sessionsRead: read, dates,
    skipped, findings, warnings,
    limits: "Matches are text equality after normalization: whitespace, repository paths, ids and temporary paths. A step is listed, "
      + "not judged: whether it needed judgement is for the reviewer. Antigravity has no known transcript location, so its sessions "
      + "are read only from files handed in. Redaction is best effort. Subagent transcripts, and forked Codex "
      + "rollouts, count toward their parent session, and their prompts are not counted. A Claude Code record another transcript "
      + "already holds, as a resumed session copies them, counts once, toward the first session read. "
      + "Other repositories contribute only to prompts.",
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

function fail(message, code) {
  process.stderr.write(message);
  return code;
}

if (require.main === module) process.exitCode = main(process.argv);

module.exports = { main, promptKey, normalizer, codexCommand, argument };
