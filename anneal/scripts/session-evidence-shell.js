"use strict";

// Shell classification: what a shell command line does, the path it names and whether it runs the project's own
// tool, from the command's text alone. Both hosts' readers classify their shell calls here.

const path = require("node:path");

// What a call does, as far as its tool and input show. A shell command outside the read, search and
// write forms below is a `command`, and a compound one that does more than read or search is `mixed`;
// the effect of either is unknown.

// Shell programs that only read or search, each with the flags that take the next word as their value.
const SHELL_READERS = new Map([
  ["cat", []], ["head", ["-n", "-c", "--lines", "--bytes"]], ["tail", ["-n", "-c", "--lines", "--bytes"]],
  ["get-content", ["-totalcount", "-tail", "-head", "-first", "-last", "-encoding", "-readcount", "-delimiter"]],
  ["select-object", ["-first", "-last", "-skip", "-index"]],
]);
const SHELL_SEARCHERS = new Map([
  ["rg", ["-e", "-f", "-g", "-t", "-T", "-m", "-A", "-B", "-C", "-d", "-j", "-M", "-E", "-r", "--regexp", "--file",
    "--glob", "--iglob", "--type", "--type-not", "--max-count", "--context", "--after-context", "--before-context",
    "--max-depth", "--threads", "--max-columns", "--sort", "--sortr", "--encoding", "--replace"]],
  ["grep", ["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--regexp", "--file", "--max-count", "--context",
    "--after-context", "--before-context"]],
  ["ls", ["-I", "-w", "--ignore", "--hide", "--width"]],
  ["get-childitem", ["-filter", "-include", "-exclude", "-depth"]],
  ["select-string", ["-pattern", "-context", "-encoding"]],
]);
// Shell programs that create, move or delete files.
const SHELL_WRITERS = new Set([
  "rm", "rmdir", "mv", "cp", "mkdir", "touch", "ln", "tee", "truncate", "unlink",
  "remove-item", "move-item", "copy-item", "new-item", "rename-item", "set-content", "add-content", "out-file", "clear-content",
]);
// Programs that change nothing between the reads of a compound command.
const NEUTRAL = new Set([
  "cd", "pushd", "popd", "set-location", "echo", "printf", "pwd", "get-location", "write-output", "write-host", "out-null", "true",
]);
// A project's own build, test, package and language tools. Their output is the project's to quiet; the output of a
// read, a formatter, version control or an unknown program is not.
const PROJECT_TOOLS = [
  "npm", "npx", "pnpm", "yarn", "bun", "bunx", "deno", "node", "tsx", "ts-node", "tsc", "jest", "vitest", "mocha", "eslint",
  "prettier", "playwright", "python", "python3", "py", "pytest", "pip", "pip3", "uv", "poetry", "tox", "ruff", "mypy", "cargo",
  "rustc", "go", "make", "cmake", "ninja", "bazel", "dotnet", "msbuild", "mvn", "mvnw", "gradle", "gradlew", "java", "ruby",
  "bundle", "rake", "rspec", "rails", "php", "composer", "phpunit", "swift", "xcodebuild", "flutter", "dart", "mix", "zig",
];
// Language tools that run a script: the project's only when the script is.
const INTERPRETERS = new Set(["node", "tsx", "ts-node", "deno", "bun", "python", "python3", "py", "ruby", "php", "perl", "java"]);
// A path that names a program a shell can run: no extension, or a script's or an executable's.
const RUNNABLE = /(?:^|[\\/])[^\\/.]+$|\.(?:sh|bash|zsh|ps1|cmd|bat|exe|py|rb|pl)$/i;
const CONTENT = new Set(["read", "search"]);
const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const TEMPORARY = /\/(?:tmp|temp)(?:\/|$)/i;

// The absolute path a path names, with forward slashes. Null when a shell would expand it or its
// directory is unknown: only a path that names one file identifies it.
function normalizePath(value, cwd) {
  if (typeof value !== "string" || !value || /[\0\r\n*?$%{}`]|^~/.test(value)) return null;
  const base = typeof cwd === "string" ? cwd : "";
  const windows = (resolved) => resolved.replace(/\\/g, "/").replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  if (WINDOWS_ROOT.test(value)) return windows(path.win32.resolve(value));
  // A drive-relative path, a root-relative one, or a POSIX root under a Windows directory is ambiguous.
  if (/^(?:[A-Za-z]:|[\\/])/.test(value)) return value[0] === "/" && !WINDOWS_ROOT.test(base) ? path.posix.resolve(value) : null;
  if (WINDOWS_ROOT.test(base)) return windows(path.win32.resolve(base, value));
  return base.startsWith("/") ? path.posix.resolve(base, value) : null;
}

// A small recognizer, not a shell parser. The programs of a command line are split at separators
// outside quotes. Null when the line redirects into a file, reads a redirect or here-document,
// substitutes a command or leaves a quote open. A lenient split never gives up, to find the programs a line runs.
function programs(command, lenient = false) {
  const parts = [""];
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const last = parts.length - 1;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "`" || ch === "<" || (ch === "$" && command[i + 1] === "(")) {
      if (!lenient) return null;
    } else if (ch === ">") {
      // Joining streams or discarding output leaves the command's effect as it was.
      const harmless = /^>(?:&[12]|\s*(?:\/dev\/null|\$null|nul)(?![^\s;&|]))/i.exec(command.slice(i));
      if (!harmless && !lenient) return null;
      if (harmless) {
        parts[last] = parts[last].replace(/(^|\s)[12*]$/, "$1");
        i += harmless[0].length - 1;
        continue;
      }
    } else if (/[;&|\r\n]/.test(ch)) {
      parts.push("");
      continue;
    }
    parts[last] += ch;
  }
  return quote && !lenient ? null : parts.map((part) => part.trim()).filter(Boolean);
}

function firstWord(part) {
  return (part.match(/"[^"]*"|'[^']*'|\S+/) || [""])[0].replace(/^(["'])([\s\S]*)\1$/, "$2");
}

function programName(part) {
  return firstWord(part).split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
}

// A command line without the text it carries as data, whose lines would read as commands: here-document bodies,
// PowerShell here-strings and PowerShell block comments.
function withoutData(command) {
  return command
    .replace(/<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\r?\n|$)/g, (text) => text.slice(0, text.indexOf("\n")))
    .replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, "''")
    .replace(/<#[\s\S]*?#>/g, "");
}

// Whose program one part of a command line runs: "project" for a project tool or a script the project keeps and runs
// by a relative path, "outside" for a language tool running a script from outside the project, such as a plugin's,
// and null for anything else. Assignments before a command, such as `CI=1` or PowerShell's `$p = ...`, are skipped;
// one alone runs nothing, and a word with a quote or an array or subexpression, `@(...)` or `$(...)`, is no program.
function toolOf(part, cwd, root) {
  const words = part.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  let i = 0;
  while (/^[\w$:]+=/.test(words[i] || "") || (words[i + 1] === "=" && /^\$[\w:]+$/.test(words[i]))) i += words[i + 1] === "=" ? 2 : 1;
  const word = words[i] || "";
  if (!word || /["']/.test(word) || /^[@$]\(/.test(word)) return null;
  const name = word.split(/[\\/]/).pop().toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "");
  if (INTERPRETERS.has(name)) return scriptPlace(words.slice(i + 1), cwd, root);
  if (PROJECT_TOOLS.includes(name)) return "project";
  return /[\\/]/.test(word) && !/^(?:[\\/]|[A-Za-z]:)/.test(word) && RUNNABLE.test(word) ? "project" : null;
}

// Where the script a language tool runs lies: the project's when it resolves inside the session's working directory,
// "outside" when it lies elsewhere or behind an expansion such as `$CLAUDE_PLUGIN_ROOT`, and null for inline code, a
// scratch script in a temporary directory or no script at all. A module run with -m is the project's when it is a
// project tool, and `--test` runs the project's own tests.
function scriptPlace(args, cwd, root) {
  for (let j = 0; j < args.length; j++) {
    const arg = args[j].replace(/^(["'])([\s\S]*)\1$/, "$2");
    // Code on the command line or on standard input is no script of the project's.
    if (arg === "-" || /^-(?:e|c|p|-eval|-print)$/.test(arg)) return null;
    // A redirection, and the file an operator standing alone redirects, are no script either.
    if (/^\d*[<>]/.test(arg)) {
      if (/^\d*[<>]+&?$/.test(arg)) j += 1;
      continue;
    }
    if (arg === "-m") return PROJECT_TOOLS.includes(String(args[j + 1] || "").toLowerCase()) ? "project" : null;
    if (arg.startsWith("-")) continue;
    if (/^[$%~]/.test(arg)) return "outside";
    const file = normalizePath(arg, cwd);
    if (file === null) return /^(?:[\\/]|[A-Za-z]:)/.test(arg) ? "outside" : "project";
    return { project: "project", temporary: null, outside: "outside" }[placeOf(file, root)];
  }
  return args.some((arg) => /^--test\b/.test(arg)) ? "project" : null;
}

// One program and its plain or quoted words: a read, a search, a file change or another command.
function simpleShape(part, cwd) {
  const words = (part.match(/"[^"]*"|'[^']*'|\S+/g) || []).slice(1).map((word) => word.replace(/^(["'])([\s\S]*)\1$/, "$2"));
  const name = programName(part);
  if (name === "sed") {
    if (words.some((word) => /^(?:-[A-Za-z]*i|--in-place)/.test(word))) return { operation: "write", path: null };
    const prints = words.length === 3 && words[0] === "-n" && /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(words[1]);
    return prints ? { operation: "read", path: normalizePath(words[2], cwd) } : { operation: "command", path: null };
  }
  const writes = SHELL_WRITERS.has(name);
  const valued = writes ? [] : SHELL_READERS.get(name) || SHELL_SEARCHERS.get(name);
  // rg --pre runs a program on every file it searches.
  if (!valued || words.some((word) => /^--pre(?:=|$)/.test(word))) return { operation: "command", path: null };
  const cmdlet = name.includes("-"); // a PowerShell cmdlet: flags ignore case, and -Path names the operand
  const matcher = name === "rg" || name === "grep" || name === "select-string";
  let pattern = matcher; // a content search's first operand is its pattern, unless a flag gives the pattern
  let flags = true;
  const operands = [];
  for (let i = 0; i < words.length; i++) {
    const word = cmdlet ? words[i].toLowerCase() : words[i];
    if (!flags || !word.startsWith("-") || word === "-") operands.push(words[i]);
    else if (word === "--") flags = false;
    else if (cmdlet && (word === "-path" || word === "-literalpath")) operands.push(words[++i]);
    else if (!cmdlet && matcher && (word === "--files" || /^(?:--regexp=|--file=|-[ef].)/.test(word))) pattern = false;
    else if (valued.includes(word)) {
      if (/^(?:-e|-f|--regexp|--file|-pattern)$/.test(word)) pattern = false;
      i += 1;
    }
  }
  if (pattern) operands.shift();
  if (writes) return { operation: "write", path: operands.length === 1 ? normalizePath(operands[0], cwd) : null };
  const reads = SHELL_READERS.has(name);
  const target = operands.length === 1 ? operands[0] : !operands.length && !reads && !matcher ? cwd : null;
  // A read of the whole file, not of its first or last lines.
  const whole = name === "cat" || (name === "get-content" && !words.some((word) => /^-(?:totalcount|tail|head|first|last)$/i.test(word)));
  return { operation: reads ? "read" : "search", path: normalizePath(target, cwd), whole: reads && whole };
}

// A compound whose programs only read or search, with cd or echo between them, is still a read or search,
// but it names no single path. A compound that changes files is a write; any other is mixed. `tool` says
// whether a project tool runs in it, and `outside` whether, with none, a script from outside the project
// does. `root` is the session's working directory, which a script must lie in to be the project's.
function shellShape(command, cwd, root = cwd) {
  const parts = programs(command);
  const code = withoutData(command);
  const places = (programs(code) || programs(code, true)).map((part) => toolOf(part, cwd, root));
  const tool = places.includes("project");
  const origin = { tool, outside: !tool && places.includes("outside") };
  if (!parts) return { operation: "mixed", path: null, ...origin };
  if (parts.length <= 1) return { ...simpleShape(parts[0] || "", cwd), ...origin };
  const acting = parts.filter((part) => !NEUTRAL.has(programName(part))).map((part) => simpleShape(part, cwd));
  if (acting.some((shape) => shape.operation === "write")) return { operation: "write", path: null, ...origin };
  if (acting.length && acting.every((shape) => CONTENT.has(shape.operation))) return { operation: acting[0].operation, path: null, ...origin };
  return { operation: "mixed", path: null, ...origin };
}

// Where a path lies: inside the working directory recorded with its call, in a temporary directory, or elsewhere.
function placeOf(file, cwd) {
  const root = normalizePath(cwd, cwd);
  if (root && (file === root || file.startsWith(root.endsWith("/") ? root : `${root}/`))) return "project";
  return TEMPORARY.test(file) ? "temporary" : "outside";
}

module.exports = { CONTENT, normalizePath, placeOf, shellShape };
