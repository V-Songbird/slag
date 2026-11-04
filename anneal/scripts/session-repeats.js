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
const { HOME, directory, excerpt, redact } = require("./session-evidence-redaction.js");
const { records } = require("./session-evidence-records.js");
const { analyzeClaude } = require("./session-evidence-claude.js");
const { analyzeCodex } = require("./session-evidence-codex.js");
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
  const codex = homes.codex ? walk(path.join(homes.codex, "sessions")).filter((file) => file.endsWith(".jsonl") && paths.some((dir) => {
    const cwd = rolloutCwd(file);
    return cwd !== null && same(path.resolve(cwd), dir);
  })) : [];
  return [...claude, ...codex.sort()];
}

function rolloutCwd(file) {
  try {
    for (const [, row] of records(fs.readFileSync(file), new Set())) {
      if (row.type === "session_meta") return row.payload && typeof row.payload.cwd === "string" ? row.payload.cwd : null;
    }
  } catch {
    return null;
  }
  return null;
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

// A path token under the temporary directory, or in a tmp, temp or scratchpad folder, as <temp>/<its name>.
function withoutTemp(text) {
  const temp = slashes(os.tmpdir()).toLowerCase();
  return text.replace(/[^\s"'`=;|&()<>][^\s"'`=;|&()]*/g, (token) => {
    const forward = slashes(token);
    const under = TEMP_FOLDER.test(forward) || (temp.length > 3 && forward.toLowerCase().startsWith(`${temp}/`));
    return under ? `<temp>/${forward.split("/").filter(Boolean).pop()}` : token;
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
// shell command. An edit, a write and any other call is no step.
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
  const command = host === "claude" ? (SHELL_TOOLS.has(call.tool) ? call.commandOrArguments : null) : codexCommand(call.commandOrArguments);
  if (typeof command !== "string" || !command.trim()) return null;
  if (call.operation === "read" && call.path !== null) return { kind: "lookups", key: `read ${where(call.path)}` };
  return { kind: "commands", key: normalize(command) };
}

// A typed prompt's key: a slash command by its name, any other prompt lower case, without host envelopes, with its
// whitespace collapsed and its closing punctuation removed.
function promptKey(text) {
  const named = COMMAND_NAME.exec(text);
  const typed = (named ? named[1] : text.replace(ENVELOPE, " ")).toLowerCase().replace(/\s+/g, " ").trim();
  if (typed.startsWith("/")) return typed.split(" ")[0];
  return typed.replace(/[\s.!?¡¿,;:…]+$/u, "") || null;
}

// What a map file at the root, or a file one of them imports with @, names: each inline code span, each line of a
// fenced block and each link target, whitespace collapsed. A step is named only as one of them whole.
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
  for (const text of texts) {
    const prose = text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^ {0,3}\1[^\n]*$/gm, (block, fence, body) => {
      spans.push(...body.split("\n"));
      return "";
    });
    for (const [, span] of prose.matchAll(/`([^`\n]+)`/g)) spans.push(span);
    for (const [, target] of prose.matchAll(/\]\(\s*<?([^)\s>]+)/g)) spans.push(target.replace(/#.*$/, "").replace(/^\.\//, ""));
  }
  return new Set(spans.map((span) => span.trim().replace(/\s+/g, " ")).filter(Boolean));
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
  const run = byName && /^(?:npm|pnpm|yarn|bun)(?: run(?:-script)?)? ([\w:.-]+)\b|^node --run ([\w:.-]+)\b/.exec(command);
  const name = run && (run[1] || run[2]);
  if (name && Object.hasOwn(scripts, name)) return name;
  return Object.keys(scripts).sort().find((key) => typeof scripts[key] === "string" && scripts[key].trim().replace(/\s+/g, " ") === command) ?? null;
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
  const scripts = scriptsOf(root);
  const map = mapSpans(root);
  const tallies = Object.fromEntries(KINDS.map((kind) => [kind, new Map()]));
  const skipped = [];
  const read = { claude: 0, codex: 0, subagentTranscripts: 0 };
  // The earliest and the latest typed prompt of the sessions read, as their records time them.
  const dates = { first: null, last: null };
  let cut = 0;
  const count = (kind, key, session, file, line, subagent, repository) => {
    if (!tallies[kind].has(key)) tallies[kind].set(key, { sessions: new Set(), occurrences: 0, inSubagents: 0, first: new Map(), repositories: new Set() });
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

  for (const { file, repository } of sessions) {
    let host;
    try {
      host = detectHost(file);
    } catch (error) {
      skipped.push({ sessionFile: directory(file), reason: "unreadable", message: excerpt(error.message, 240) });
      continue;
    }
    const name = path.basename(file, ".jsonl");
    if (running.some((id) => name === id || name.endsWith(`-${id}`))) {
      skipped.push({ sessionFile: directory(file), reason: "running-session" });
      continue;
    }
    const transcripts = [{ file, subagent: false }, ...(host === "claude" ? subagentsOf(file).map((agent) => ({ file: agent, subagent: true })) : [])];
    const steps = [];
    let prompts = [];
    let readOne = false;
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
        skipped.push({ sessionFile: directory(transcript.file), reason: "unreadable", message: excerpt(error.message, 240) });
        continue;
      }
      if (!transcript.subagent && running.includes(result.sessionId)) {
        skipped.push({ sessionFile: directory(file), reason: "running-session" });
        break;
      }
      readOne = true;
      if (transcript.subagent) read.subagentTranscripts += 1;
      else read[host] += 1;
      for (const call of calls) {
        const step = repository.own ? stepOf(call, host, normalize) : null;
        if (step) steps.push({ ...step, file: transcript.file, line: call.callLine, actor: call.actor, promptLine: call.promptLine, subagent: transcript.subagent });
      }
      if (!transcript.subagent) prompts = typed;
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
      if (key) count("prompts", excerpt(key, 120), file, file, prompt.line, false, repository.root);
    }
    for (const step of steps) {
      if (step.key.endsWith(CUT)) cut += 1;
      count(step.kind, step.key, file, step.file, step.line, step.subagent, repository.root);
    }
    // Two or three consecutive commands by one actor for one prompt, in call order; a command run again at once counts
    // once. Lookups between them do not break a run: a repeated read is a lookup finding of its own.
    const groups = new Map();
    for (const step of steps.filter((candidate) => candidate.kind === "commands")) {
      const group = JSON.stringify([step.file, step.actor, step.promptLine]);
      if (!groups.has(group)) groups.set(group, []);
      const run = groups.get(group);
      if (!run.length || run[run.length - 1].key !== step.key) run.push(step);
    }
    for (const run of groups.values()) {
      for (let size = 2; size <= 3; size++) {
        for (let i = 0; i + size <= run.length; i++) {
          const part = run.slice(i, i + size);
          count("sequences", part.map((step) => step.key).join(" -> "), file, part[0].file, part[0].line, part[0].subagent, repository.root);
        }
      }
    }
  }
  if (!read.claude && !read.codex) {
    return fail(`session-repeats.js: no session found to read. Searched: ${searched.join(", ")}. Supply --session-file or --sessions-dir.\n`, 2);
  }

  const findings = {};
  for (const kind of KINDS) {
    findings[kind] = [...tallies[kind].entries()]
      .filter(([, tally]) => tally.sessions.size >= minimum)
      .map(([key, tally]) => {
        const finding = {
          kind, step: excerpt(key, kind === "prompts" ? 120 : 240), sessions: tally.sessions.size, occurrences: tally.occurrences,
          inSubagents: tally.inSubagents,
          examples: [...tally.first.values()].sort((a, b) => (a.sessionFile < b.sessionFile ? -1 : a.sessionFile > b.sessionFile ? 1 : a.line - b.line)).slice(0, 3),
        };
        if (kind === "commands" || kind === "sequences") {
          const parts = key.split(" -> ");
          finding.namedInMap = parts.every((part) => map.has(part));
          // A sequence is a script's only when the script's own text runs exactly its commands.
          finding.projectScript = kind === "commands" ? projectScript(key, scripts) : projectScript(parts.join(" && "), scripts, false);
        }
        // A lookup is named when the map names its path or pattern.
        if (kind === "lookups") finding.namedInMap = map.has(key.slice(key.indexOf(" ") + 1));
        if (kind === "prompts") finding.repositories = tally.repositories.size;
        return finding;
      })
      .sort((a, b) => b.sessions - a.sessions || b.occurrences - a.occurrences || (a.step < b.step ? -1 : a.step > b.step ? 1 : 0))
      .slice(0, limit);
  }
  const warnings = [];
  if (cut) warnings.push(`${cut} steps were cut at the evidence's 480-character bound; steps that differ only after the cut share a key.`);
  const output = {
    root: directory(root), repositories: repositories.map((repository) => directory(repository.root)), sessionsRead: read, dates,
    skipped, findings, warnings,
    limits: "Matches are text equality after normalization: whitespace, repository paths, ids and temporary paths. A step is listed, "
      + "not judged: whether it needed judgement is for the reviewer. Antigravity has no known transcript location, so its sessions "
      + "are read only from files handed in. Redaction is best effort. Subagent transcripts count toward their parent session. "
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
