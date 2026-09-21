#!/usr/bin/env node
"use strict";

// anneal's session evidence: where one session lost time. Reads one Claude Code
// transcript or one Codex rollout and prints bounded candidates as JSON.
// Read-only: it opens no other session and never touches an instruction file.
// Neither host documents its transcript format, so every record shape read here
// is held by a fixture in tests/session-evidence.test.js.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const EXIT = /^Exit code (-?\d+)\b/;
const SESSION_VARIABLES = { claude: "CLAUDE_CODE_SESSION_ID", codex: "CODEX_THREAD_ID" };

const BROWSER_MISSING = /(?:Executable doesn't exist|browserType\.launch:.*(?:not found|missing))/i;
const COMMAND_NOT_FOUND = /(?:is not recognized as (?:a|the) name|command not found|MODULE_NOT_FOUND)/i;

// First match wins, so a host's own error text sits above the generic shell ones.
const CLAUDE_DIAGNOSTICS = [
  ["unknown-tool", /No such tool available/],
  ["invalid-tool-input", /InputValidationError/],
  ["stale-file-state", /File has (?:not been read yet|been modified since read)/],
  ["edit-no-match", /String to replace not found/],
  ["missing-path", /(?:File|Path) does not exist/],
  ["output-too-large", /exceeds maximum allowed tokens/],
  ["user-declined", /The user doesn't want to proceed with this tool use/],
  ["interrupted", /Command was aborted before completion/],
  ["browser-executable-missing", BROWSER_MISSING],
  ["port-in-use", /\bEADDRINUSE\b|\bPort \d+ is in use\b/i],
  ["command-not-found", COMMAND_NOT_FOUND],
  ["blocked", /\bis blocked\b|\bblocked by policy\b/i],
  ["permission-denied", /(?:Access is denied\.|Permission denied|Operation not permitted|\bEPERM\b)/i],
];
const CODEX_DIAGNOSTICS = [
  ["tool-script-failure", /^Script (?:error:|failed\b)/im],
  ["browser-executable-missing", BROWSER_MISSING],
  ["port-in-use", /\bEADDRINUSE\b/],
  ["command-not-found", COMMAND_NOT_FOUND],
  ["permission-denied", /(?:Access is denied\.|Permission denied|Operation not permitted)/i],
];

const HOME = os.homedir();
// The same directory as a shell, a URL and a JSON string each spell it.
const HOME_SPELLINGS = [...new Set([HOME, HOME.replace(/\\/g, "/"), HOME.replace(/\\/g, "\\\\")])].filter(Boolean);

function redact(value) {
  let text = String(value)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\b((?:set-)?cookie\s*:)\s*[^\r\n]+/gim, "$1 [REDACTED]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[REDACTED]@")
    .replace(/(--(?:api-key|access-token|password|secret|token)\s+)\S+/gi, "$1[REDACTED]")
    .replace(
      /(\b(?:[a-z][a-z0-9_]*_)?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)\b["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}&]+)/gi,
      "$1[REDACTED]",
    );
  for (const home of HOME_SPELLINGS) text = text.split(home).join("~");
  return text;
}

function excerpt(value, size = 480) {
  const text = redact(value);
  return text.length <= size ? text : `${text.slice(0, size)} [excerpt truncated]`;
}

function textBlocks(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textBlocks);
  if (value && typeof value.text === "string") return [value.text];
  return [];
}

function parseCutoff(value) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new Error(`Not an ISO timestamp: ${value}`);
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) throw new Error("The cutoff must include a timezone.");
  return time;
}

// One record per line. The buffer is a snapshot: a session that is still running
// keeps appending, and a half-written last line is dropped, not parsed.
function* records(buffer, warnings) {
  let start = 0;
  let number = 0;
  while (start < buffer.length) {
    const end = buffer.indexOf(10, start);
    number += 1;
    if (end === -1) {
      warnings.add("Ignored an incomplete trailing record at the snapshot boundary.");
      return;
    }
    const raw = buffer.toString("utf8", start, end).trim();
    start = end + 1;
    if (!raw) continue;
    let row;
    try {
      row = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON record at line ${number}; no reliable audit produced.`);
    }
    if (row && typeof row === "object") yield [number, row];
  }
}

// Whether a record falls inside the audited interval.
function selects(line, row, cutoffLine, before, warnings) {
  if (before === null) return line < cutoffLine;
  const time = new Date(row.timestamp || NaN);
  if (Number.isNaN(time.getTime())) {
    warnings.add("Skipped a record without a usable timestamp while using --before.");
    return false;
  }
  return time < before;
}

function diagnose(patterns, output) {
  for (const [name, pattern] of patterns) {
    const match = pattern.exec(output);
    if (match) return { name, index: match.index };
  }
  return null;
}

function keepLargest(largest, entry) {
  largest.push(entry);
  largest.sort((a, b) => b.characters - a.characters);
  if (largest.length > 3) largest.length = 3;
}

function keepLast(failures, failure, limit) {
  failures.push(failure);
  if (failures.length > limit) failures.shift();
}

// Claude Code transcripts: <claude home>/projects/<project>/<session id>.jsonl

// A user record that is not a tool result: a typed prompt, a peer message or a host notice.
function isPrompt(row) {
  const content = (row.message || {}).content;
  const carriesResult = Array.isArray(content) && content.some((block) => block && block.type === "tool_result");
  return row.type === "user" && !carriesResult;
}

function subagentTranscripts(file) {
  const folder = path.join(path.dirname(file), path.basename(file, ".jsonl"), "subagents");
  let names = [];
  try {
    names = fs.readdirSync(folder).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(folder, name.replace(/\.jsonl$/, ".meta.json")), "utf8"));
    } catch {
      meta = {};
    }
    return { file: path.join(folder, name), agentType: meta.agentType || null, description: excerpt(meta.description || "", 120) };
  });
}

function analyzeClaude(file, before = null, limit = 6) {
  const warnings = new Set();
  const buffer = fs.readFileSync(file);
  const prompts = [];
  const sidechain = new Set();
  let sessionId = null;
  let originAware = false;
  for (const [line, row] of records(buffer, warnings)) {
    sessionId = sessionId || row.sessionId || null;
    originAware = originAware || (row.origin !== null && typeof row.origin === "object");
    sidechain.add(Boolean(row.isSidechain));
    if (isPrompt(row)) prompts.push({ line, time: row.timestamp, origin: row.origin, meta: row.isMeta });
  }
  // Newer transcripts tag a typed prompt with origin.kind "human"; older ones only mark injected text as isMeta.
  const starts = prompts.filter((p) => (originAware ? Boolean(p.origin) && p.origin.kind === "human" : !p.meta));
  if (sidechain.size > 1) warnings.add("The transcript mixes main and sidechain records; subagent activity may be included.");
  if (before === null && !starts.length) throw new Error("No human prompt boundary found. Supply --before for a known audit cutoff.");
  const last = starts[starts.length - 1];
  const cutoffLine = before === null ? last.line : null;

  const calls = new Map();
  const failures = [];
  const counts = {};
  const largest = [];
  const context = {};
  let selected = 0;
  for (const [line, row] of records(buffer, warnings)) {
    if (!selects(line, row, cutoffLine, before, warnings)) continue;
    selected += 1;
    const message = row.message || {};
    if (row.cwd) Object.assign(context, { cwd: row.cwd, version: row.version || null });
    if (row.type === "assistant" && message.model) context.model = message.model;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use") {
        let input = block.input === undefined ? {} : block.input;
        if (input && typeof input.command === "string") input = input.command;
        else if (typeof input !== "string") input = JSON.stringify(input);
        calls.set(block.id, { tool: block.name, callLine: line, commandOrArguments: excerpt(input) });
      } else if (block.type === "tool_result") {
        const call = calls.get(block.tool_use_id) || {};
        calls.delete(block.tool_use_id);
        const output = textBlocks(block.content).join("\n");
        keepLargest(largest, { line, characters: output.length, tool: call.tool || null });
        const reported = Boolean(block.is_error);
        const exit = EXIT.exec(output);
        // Text matching on successful output is limited to shells; a file that was read or searched quotes errors.
        const diagnostic = reported || SHELL_TOOLS.has(call.tool) ? diagnose(CLAUDE_DIAGNOSTICS, output) : null;
        if (reported || diagnostic) {
          let category = "tool-error";
          if (diagnostic) category = diagnostic.name;
          else if (exit) category = "nonzero-exit";
          else if (output.includes("<tool_use_error>")) category = "tool-use-error";
          keepLast(failures, {
            line, timestamp: row.timestamp || null, ...call,
            exitCode: exit ? Number(exit[1]) : null, category,
            evidenceBasis: reported ? "reported-error" : "diagnostic-text-match-only",
            diagnosticCandidate: excerpt(output.slice(diagnostic ? Math.max(0, diagnostic.index - 100) : 0)),
            laterSameToolSuccesses: [],
          }, limit);
          counts[category] = (counts[category] || 0) + 1;
        } else {
          const success = { line, timestamp: row.timestamp || null, ...call, outputExcerpt: excerpt(output, 350) };
          for (const failure of failures) {
            if (failure.line < line && failure.tool === call.tool && failure.laterSameToolSuccesses.length < 2) {
              failure.laterSameToolSuccesses.push(success);
            }
          }
        }
      }
    }
  }
  const subagents = subagentTranscripts(file);
  if (subagents.length > 20) warnings.add(`Only the first 20 of ${subagents.length} subagent transcripts are listed.`);
  noteBounds(warnings, counts, limit, selected);
  if (selected && !context.model) {
    warnings.add("No assistant records precede the selected cutoff. For a finished session, the latest prompt is not this audit; pass --before.");
  }
  return {
    sessionFile: file, sessionId,
    boundary: {
      before: before === null ? last.time || null : before.toISOString(), line: cutoffLine, snapshotBytes: buffer.length,
      mode: before === null ? "before-latest-human-prompt" : "explicit-time",
    },
    context, recordsSelected: selected, candidateCounts: counts, candidates: failures,
    largestToolTexts: largest, subagentTranscripts: subagents.slice(0, 20), warnings: [...warnings].sort(),
    limits: "Counts are is_error and text candidates, not verified independent failures; is_error also marks hook blocks, "
      + "permission denials and user interrupts. Redaction is best effort. A later same-tool success is not proof of "
      + "recovery. Subagent transcripts were listed, not read. No other session was read.",
  };
}

function noteBounds(warnings, counts, limit, selected) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (total > limit) warnings.add(`Only the last ${limit} candidates are shown; counts cover the selected interval.`);
  if (!selected) warnings.add("No work records precede the selected cutoff.");
}

// Codex rollouts: <codex home>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl

// The JSON object that starts at `index`, whatever follows it. JSON.parse has no prefix mode.
function objectAt(text, index) {
  let depth = 0;
  let inString = false;
  for (let i = index; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(index, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Code-mode shell results arrive as JSON lines inside the tool's text; unwrap them without evaluating anything.
function resultParts(text) {
  const parts = [];
  for (const match of text.matchAll(/^[ \t]*(?=\{)/gm)) {
    const value = objectAt(text, match.index + match[0].length);
    if (value && "exit_code" in value && typeof value.output === "string") parts.push([value.exit_code, value.output]);
  }
  if (parts.length) return parts;
  const exited = /^Process exited with code (-?\d+)\b/im.exec(text);
  return [[exited ? Number(exited[1]) : null, text]];
}

function analyzeCodex(file, before = null, limit = 6) {
  const warnings = new Set();
  const buffer = fs.readFileSync(file);
  const starts = [];
  let sessionId = null;
  for (const [line, row] of records(buffer, warnings)) {
    const payload = row.payload || {};
    if (row.type === "session_meta") sessionId = payload.id || null;
    if (row.type === "event_msg" && payload.type === "task_started") starts.push({ line, time: row.timestamp });
  }
  if (before === null && !starts.length) throw new Error("No task_started boundary found. Supply --before for a known audit cutoff.");
  const last = starts[starts.length - 1];
  const cutoffLine = before === null ? last.line : null;

  const calls = new Map();
  const failures = [];
  const counts = {};
  const largest = [];
  let context = {};
  let selected = 0;
  for (const [line, row] of records(buffer, warnings)) {
    if (!selects(line, row, cutoffLine, before, warnings)) continue;
    selected += 1;
    const payload = row.payload || {};
    if (row.type === "turn_context") {
      context = { cwd: payload.cwd || null, model: payload.model || null, effort: payload.effort || null };
    }
    if (row.type !== "response_item") continue;
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      let input = payload.arguments === undefined ? payload.input : payload.arguments;
      if (typeof input !== "string") input = JSON.stringify(input === undefined ? "" : input);
      calls.set(payload.call_id, { tool: payload.name, callLine: line, commandOrArguments: excerpt(input) });
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const call = calls.get(payload.call_id) || {};
      calls.delete(payload.call_id);
      for (const text of textBlocks(payload.output)) {
        keepLargest(largest, { line, characters: text.length, tool: call.tool || null });
        for (const [code, output] of resultParts(text)) {
          const diagnostic = diagnose(CODEX_DIAGNOSTICS, output);
          const failed = code !== null && code !== 0;
          if (failed || diagnostic) {
            const category = diagnostic ? diagnostic.name : "nonzero-exit";
            keepLast(failures, {
              line, timestamp: row.timestamp || null, ...call, exitCode: code, category,
              evidenceBasis: failed ? "reported-nonzero-exit" : "diagnostic-text-match-only",
              diagnosticCandidate: excerpt(output.slice(diagnostic ? Math.max(0, diagnostic.index - 100) : 0)),
              nearbyReportedSuccesses: [],
            }, limit);
            counts[category] = (counts[category] || 0) + 1;
          } else if (code === 0) {
            const success = { line, timestamp: row.timestamp || null, ...call, outputExcerpt: excerpt(output, 350) };
            for (const failure of failures) {
              if (failure.line < line && failure.nearbyReportedSuccesses.length < 2) failure.nearbyReportedSuccesses.push(success);
            }
          }
        }
      }
    }
  }
  noteBounds(warnings, counts, limit, selected);
  return {
    sessionFile: file, sessionId,
    boundary: {
      before: before === null ? last.time || null : before.toISOString(), line: cutoffLine, snapshotBytes: buffer.length,
      mode: before === null ? "before-latest-task-start" : "explicit-time",
    },
    context, recordsSelected: selected, candidateCounts: counts, candidates: failures,
    largestToolTexts: largest, warnings: [...warnings].sort(),
    limits: "Counts are text and exit candidates, not verified independent failures. Redaction is best effort. A nearby "
      + "success is not proof of recovery. A rollout does not include child tasks. No other session was read.",
  };
}

const ANALYZERS = { claude: analyzeClaude, codex: analyzeCodex };

// Codex rollout records wrap their data in a payload; Claude Code transcript records do not.
function detectHost(file) {
  const warnings = new Set();
  for (const [, row] of records(fs.readFileSync(file), warnings)) return "payload" in row ? "codex" : "claude";
  throw new Error("The transcript holds no complete record.");
}

function walk(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

// Never the latest session by guess: one id, and exactly one file that carries it.
function findTranscript(host, sessionId, homes) {
  if (host === "codex") return walk(path.join(homes.codex, "sessions")).filter((file) => file.endsWith(`${sessionId}.jsonl`));
  const projects = path.join(homes.claude, "projects");
  let names = [];
  try {
    names = fs.readdirSync(projects);
  } catch {
    return [];
  }
  return names.map((name) => path.join(projects, name, `${sessionId}.jsonl`)).filter((file) => fs.existsSync(file));
}

const USAGE = "usage: session-evidence.js [--session-file <file>] [--host claude|codex] [--session-id <id>]\n"
  + "       [--claude-home <dir>] [--codex-home <dir>] [--before <ISO time with zone>] [--limit <1-30>]\n";

function main(argv, env = process.env) {
  const options = {
    "--session-file": null, "--host": null, "--session-id": null, "--before": null, "--limit": "6",
    "--claude-home": env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"),
    "--codex-home": env.CODEX_HOME || path.join(HOME, ".codex"),
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!(args[i] in options) || i + 1 >= args.length) return fail(USAGE, 2);
    options[args[i]] = args[i + 1];
  }
  const limit = Number(options["--limit"]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) return fail("session-evidence.js: --limit must be between 1 and 30\n", 2);
  let host = options["--host"];
  if (host !== null && !(host in ANALYZERS)) return fail(USAGE, 2);

  let file = options["--session-file"];
  if (file === null) {
    if (host === null) {
      const present = Object.keys(SESSION_VARIABLES).filter((name) => env[SESSION_VARIABLES[name]]);
      if (present.length !== 1) {
        return fail("session-evidence.js: cannot tell the host, because CLAUDE_CODE_SESSION_ID and CODEX_THREAD_ID are both set "
          + "or both missing. Supply --host or --session-file.\n", 2);
      }
      host = present[0];
    }
    const sessionId = options["--session-id"] || env[SESSION_VARIABLES[host]] || "";
    if (!/^[a-fA-F0-9-]{16,64}$/.test(sessionId)) {
      return fail("session-evidence.js: no unambiguous session id. Supply --session-file or --session-id.\n", 2);
    }
    const matches = findTranscript(host, sessionId, { claude: options["--claude-home"], codex: options["--codex-home"] });
    if (matches.length !== 1) {
      return fail(`session-evidence.js: expected one transcript for that session, found ${matches.length}. Supply --session-file.\n`, 2);
    }
    file = matches[0];
  }
  try {
    file = path.resolve(file);
    const before = options["--before"] === null ? null : parseCutoff(options["--before"]);
    host = host || detectHost(file);
    process.stdout.write(`${JSON.stringify({ host, ...ANALYZERS[host](file, before, limit) }, null, 2)}\n`);
    return 0;
  } catch (error) {
    return fail(`session-evidence.js: cannot extract reliable session evidence: ${error.message}\n`, 1);
  }
}

function fail(message, code) {
  process.stderr.write(message);
  return code;
}

if (require.main === module) process.exitCode = main(process.argv);

module.exports = { analyzeClaude, analyzeCodex, detectHost, redact, main };
