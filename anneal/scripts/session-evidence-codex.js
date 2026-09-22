"use strict";

// Codex rollouts: <codex home>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl
// analyzeCodex reads one into the evidence session-evidence.js prints. A result's outcome comes from its exit
// code, or else from the wrapper the host put around a code-mode script's output and what that script calls.

const fs = require("node:fs");
const { bounded, directory, excerpt, timeOf } = require("./session-evidence-redaction.js");
const {
  BROWSER_MISSING, COMMAND_NOT_FOUND, MISSING, OPAQUE, boundaryOf, callEntry, coverageOf, cutoffOf, diagnose, issue, keepLargest,
  keepLast, lineOf, missingIn, noCall, noteBounds, records, selects, settle, textBlocks, tracker,
} = require("./session-evidence-records.js");
const { CONTENT, shellShape } = require("./session-evidence-shell.js");
const { answered, called, navigationOf, navigator, phaseOf } = require("./session-evidence-navigation.js");

// First match wins, so a host's own error text sits above the generic shell ones. A missing path is not listed:
// it is read from a failed read, search or edit alone, with MISSING.
const CODEX_DIAGNOSTICS = [
  ["tool-script-failure", /^Script (?:error:|failed\b)/im],
  // The host's own text in place of a call's output, at its start: a hook refused the call, the owner stopped it,
  // or a collaboration tool failed.
  ["blocked", /^Command blocked by \S+ hook\b/],
  ["interrupted", /^aborted by user\b/],
  ["tool-error", /^collab \w+ failed\b/],
  ["browser-executable-missing", BROWSER_MISSING],
  ["port-in-use", /\bEADDRINUSE\b/],
  ["command-not-found", COMMAND_NOT_FOUND],
  ["permission-denied", /(?:Access is denied\.|Permission denied|Operation not permitted)/i],
];
// Codex marks where it cut a tool's output. Claude Code writes a cut Read's notice in a record of its own.
const CODEX_CUT = /…\d+ tokens truncated…/;

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

// An exit code is an integer. Any other value printed where one belongs is no evidence of a failure.
function exitOf(value) {
  const code = typeof value === "number" ? value : /^\s*-?\d{1,10}\s*$/.test(String(value)) ? Number(value) : NaN;
  return Number.isSafeInteger(code) ? code : null;
}

// A printed shell result states its exit code in its header: the lines before `Output:`, or its first
// line when it has no such marker. A line like that further down is output, as a read can quote one.
// Otherwise results arrive as JSON lines inside the tool's text. Unwrap them without evaluating anything.
function resultParts(text) {
  const marker = /^Output:[ \t]*$/m.exec(text);
  const header = marker ? text.slice(0, marker.index) : text.split("\n", 1)[0];
  const exit = /^(?:Exit code:|Process exited with code) (-?\d+)\b/im.exec(header);
  if (exit) return [[exitOf(exit[1]), text]];
  const parts = [];
  for (const match of text.matchAll(/^[ \t]*(?=\{)/gm)) {
    const value = objectAt(text, match.index + match[0].length);
    if (value && "exit_code" in value && typeof value.output === "string") parts.push([exitOf(value.exit_code), value.output]);
  }
  return parts.length ? parts : [[null, text]];
}

const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

// The index of the quote that closes the string starting at `index`, or -1.
function stringEnd(text, index) {
  for (let i = index + 1; i < text.length; i++) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === text[index]) return i;
  }
  return -1;
}

// The decoded string literal that starts at `index`. Null for anything else, a template with a substitution included.
function stringAt(text, index) {
  if (!`"'\``.includes(text[index] || "x")) return null;
  const end = stringEnd(text, index);
  const body = end === -1 ? null : text.slice(index + 1, end);
  if (body === null || (text[index] === "`" && /(?:^|[^\\])\$\{/.test(body))) return null;
  const value = body.replace(/\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\s\S]))/g, (_, braced, unicode, hex, ch) => {
    const code = parseInt(braced || unicode || hex, 16);
    if (braced || unicode || hex) return code <= 0x10ffff ? String.fromCodePoint(code) : "";
    return /^[\r\n]/.test(ch) ? "" : ESCAPES[ch] ?? ch;
  });
  return { value, end: end + 1 };
}

// The comma or closing brace that ends the expression starting at `index`, outside brackets and strings; -1 if none.
function expressionEnd(text, index) {
  let depth = 0;
  for (let i = index; i < text.length; i++) {
    const ch = text[i];
    if (`"'\``.includes(ch)) {
      i = stringEnd(text, i);
      if (i === -1) return -1;
    } else if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) {
      if (depth === 0) return ch === "}" ? i : -1;
      depth -= 1;
    } else if (ch === "," && !depth) return i;
  }
  return -1;
}

// The string literals of the object a script passes to a tool, `{key: "value", ...}`. A computed value is left
// out; null when the argument is not an object literal.
function literalArguments(text, index) {
  let i = index;
  const space = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };
  space();
  if (text[i] !== "{") return null;
  i += 1;
  const args = Object.create(null);
  for (;;) {
    space();
    if (text[i] === "}") return args;
    const key = /^(["']?)([A-Za-z_$][\w$]*)\1\s*:/.exec(text.slice(i, i + 80));
    if (!key) return null;
    i += key[0].length;
    space();
    const literal = stringAt(text, i);
    if (literal) args[key[2]] = literal.value;
    i = literal ? literal.end : expressionEnd(text, i);
    if (i === -1) return null;
    space();
    if (text[i] !== ",") return text[i] === "}" ? args : null;
    i += 1;
  }
}

// The shell command a call's arguments carry, `cmd` or `command`, as a string or an argument list, run in
// `workdir` when the call names one.
function commandShape(args, cwd) {
  const command = args.cmd ?? args.command;
  const dir = typeof args.workdir === "string" ? args.workdir : cwd;
  if (typeof command === "string") return shellShape(command, dir, cwd);
  if (!Array.isArray(command)) return null;
  const script = command.length === 3 && /^-(?:l?c|command)$/i.test(String(command[1])) ? command[2] : command.join(" ");
  return shellShape(String(script), dir, cwd);
}

// Comments and string literals carry patches and messages rather than code, and so does a template without a substitution.
const LITERALS = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|`(?:[^`\\$]|\\[\s\S]|\$(?!\{))*`/g;
const TOOL_CALL = /\btools\.([A-Za-z_$][\w$]*)\s*\(/g;

// A script's code: its comments and literals blanked, each to its own length, so positions still match the script. A
// quote left unpaired throws the blanking off, as a template with a substitution, which holds code, leaves a backtick
// and the regex literal /'/ a quote, and so does an escaped slash before a slash or a star, as in the regex literal
// /\//, which opens a comment over code: a script with either is read whole.
function codeOf(script) {
  const blank = script.replace(LITERALS, (literal) => `"${" ".repeat(literal.length - 2)}"`);
  return /["'`]/.test(blank.replace(/" *"/g, "")) || /\\\/[/*]/.test(script) ? script : blank;
}

// A code-mode `exec` script is what its tool calls do: the literal command of each exec_command or
// shell_command, apply_patch as an edit, and write_stdin or a computed command as an unknown command. A
// patch beside a command is a write, as a compound command with a writer is, so a path one of the
// commands does not find is no failed edit.
function scriptShape(script, cwd) {
  const shapes = [];
  let opaque = false;
  for (const match of codeOf(script).matchAll(TOOL_CALL)) {
    const tool = match[1];
    if (tool === "exec_command" || tool === "shell_command") {
      const args = literalArguments(script, match.index + match[0].length);
      shapes.push((args && commandShape(args, cwd)) || { operation: "command", path: null });
    } else if (tool === "apply_patch") shapes.push({ operation: "edit", path: null });
    else if (tool === "write_stdin") shapes.push({ operation: "command", path: null });
    else if (OPAQUE.test(tool)) opaque = true;
  }
  if (shapes.length === 1) return { ...shapes[0], opaque };
  // A command the script computes is none that the evidence can name, so it is no project tool.
  const tool = shapes.some((shape) => shape.tool);
  const origin = { opaque, tool, outside: !tool && shapes.some((shape) => shape.outside) };
  if (shapes.some((shape) => shape.operation === "edit" || shape.operation === "write")) {
    return { operation: shapes.every((shape) => shape.operation === "edit") ? "edit" : "write", path: null, ...origin };
  }
  if (shapes.length && shapes.every((shape) => CONTENT.has(shape.operation))) return { operation: shapes[0].operation, path: null, ...origin };
  return { operation: shapes.length ? "mixed" : "other", path: null, ...origin };
}

// Whether `Script completed` vouches for a script. Codex throws a tool's failure into the script, which then
// ends as `Script failed`: a patch that does not apply, a hook's block, a command that cannot start and a
// shell_command that exits nonzero all do. exec_command and write_stdin return a nonzero exit instead, and a
// tool a server provides, named `server__tool`, may return its failure. So only a script whose code calls neither,
// reaches its tools as `tools.name(...)` alone, not through globalThis, Reflect or a key in brackets such as
// self["tools"], and drops no failure through catch, allSettled, Promise.any or Promise.race is vouched for:
// `command` when it runs shell_command, whose output reads like any command's, and otherwise `content`. False if not.
// How a script can drop a failure its tools threw and complete as if nothing had gone wrong.
const SWALLOWS = /\bcatch\b|\ballSettled\b|\bPromise\s*\.\s*(?:any|race)\b/;

function vouches(script) {
  const code = codeOf(script);
  const names = [...code.matchAll(TOOL_CALL)].map((match) => match[1]);
  const vouched = names.every((name) => name !== "exec_command" && name !== "write_stdin" && !name.includes("__"))
    && names.length === (code.match(/\btools\b/g) || []).length && !/[\w$)\].]\[\s*" *"\s*\]/.test(code)
    && !SWALLOWS.test(code) && !/\b(?:globalThis|Reflect)\b/.test(code);
  return vouched && (names.includes("shell_command") ? "command" : "content");
}

// What a script's code calls, by the evidence each call leaves. exec_command and write_stdin return an exit code for
// the script to print, so a completed script that printed fewer exit codes than it made such calls left one out, and
// that one may have failed. exec_command and a server's tool also leave a record of their own, which `recordOf` reads.
// apply_patch, view_image, write_stdin and shell_command leave none, so a script that can drop the failure of one of
// those is `uncovered`: no record of its commands says how it ended. A call in a loop counts once. `spelled` is what
// the code names outright of the calls that leave a record: each command it passes to exec_command as a literal, and
// each server tool it calls.
function callsIn(script) {
  const code = codeOf(script);
  const matches = [...code.matchAll(TOOL_CALL)];
  const names = matches.map((match) => match[1]);
  return {
    printing: names.filter((name) => name === "exec_command" || name === "write_stdin").length,
    commands: names.filter((name) => name === "exec_command").length,
    tools: names.filter((name) => name.includes("__")).length,
    uncovered: SWALLOWS.test(code) && names.some((name) => name !== "exec_command" && !name.includes("__")),
    spelled: matches.flatMap((match) => {
      if (match[1].includes("__")) return [match[1]];
      if (match[1] !== "exec_command") return [];
      const args = literalArguments(script, match.index + match[0].length);
      const command = args && (args.cmd ?? args.command);
      return typeof command === "string" ? [command.trim()] : [];
    }),
  };
}

// A tool execution the host wrote down for itself, beside the call's own result: a command's exit code, or whether a
// server's tool reported an error. `started` is when the run began: the host's own `started_at_ms` where it differs
// beyond clock rounding, 1 ms, from the record's time less how long the run took, which it can precede by a minute,
// and that difference otherwise. `thread` is the thread that ran it, and `last` what a script's code would name it by:
// the command itself, the last argument of the shell that ran it, or the server and tool a code name carries.
function recordOf(payload, row) {
  const item = payload.item;
  if (!item || (item.type !== "CommandExecution" && item.type !== "McpToolCall")) return null;
  const command = item.type === "CommandExecution";
  const code = command ? exitOf(item.exit_code) : null;
  const ran = item.duration ? Number(item.duration.secs || 0) * 1000 + Number(item.duration.nanos || 0) / 1e6 : 0;
  const ended = Date.parse(row.timestamp || "");
  const derived = Number.isNaN(ended) ? null : ended - ran;
  const direct = Number.isFinite(payload.started_at_ms) ? payload.started_at_ms : null;
  const result = item.result || {};
  return {
    id: item.id, command, exitCode: code,
    failed: command ? (code === null ? item.status === "failed" : code !== 0) : item.status === "failed" || Boolean(result.isError),
    output: command ? String(item.aggregated_output ?? "") : textBlocks(result.content).join("\n"),
    name: command ? (Array.isArray(item.command) ? item.command.join(" ") : "") : `${item.server ?? ""} ${item.tool ?? ""}`.trim(),
    last: command ? String((Array.isArray(item.command) ? item.command[item.command.length - 1] : "") ?? "").trim()
      : `${item.server ?? ""}__${item.tool ?? ""}`,
    started: direct !== null && (derived === null || Math.abs(direct - derived) > 1) ? direct : derived,
    thread: bounded(payload.thread_id),
  };
}

// Whether the script's own code names what a record ran: a command it spells out, or a server tool whose code name
// ends in the server and tool the record reports. The evidence a record needs when no call bounds its window, or when
// it names no thread while another agent is at work, so that the run may be that agent's.
function mentions(want, record) {
  return Boolean(want) && want.spelled.some((name) => name === record.last || (!record.command && name.endsWith(`__${record.last}`)));
}

// What the host's own records say of a call, as a fact, for a candidate that its text alone found.
function recordNote({ commands, tools }) {
  const seen = [];
  if (commands) seen.push(`${commands} command${commands === 1 ? " that exited 0" : "s, all of which exited 0"}`);
  if (tools) seen.push(`${tools} tool call${tools === 1 ? " that reported no error" : "s, none of which reported an error"}`);
  return `For this call the host recorded ${seen.join(" and ")}.`;
}

// Codex runs shell commands through exec_command {cmd} and shell_command {command}, called directly or
// from a code-mode exec script; apply_patch edits.
function codexShape(payload, input, cwd) {
  if (payload.name === "apply_patch") return { operation: "edit", path: null };
  if (payload.type === "custom_tool_call" && payload.name === "exec") return scriptShape(input, cwd);
  let args = null;
  try {
    args = payload.type === "function_call" ? JSON.parse(input) : null;
  } catch {
    args = null;
  }
  const shape = args && typeof args === "object" ? commandShape(args, cwd) : null;
  return shape || { operation: "other", path: null, opaque: OPAQUE.test(String(payload.name)) };
}

// A user message is a prompt unless the host injected it: a tagged block such as <environment_context>,
// or the AGENTS.md instructions. The owner's answer to the agent's question is tagged too, and is one.
// A user_message event always is one.
function isCodexPrompt(row) {
  const payload = row.payload || {};
  if (row.type === "event_msg") return payload.type === "user_message";
  if (row.type !== "response_item" || payload.type !== "message" || payload.role !== "user") return false;
  const text = textBlocks(payload.content).join("\n");
  return !/^\s*<(?!send_user_message_question_reply>)/.test(text) && !/^\s*# AGENTS\.md instructions\b/.test(text);
}

function analyzeCodex(file, before = null, limit = 6) {
  const warnings = new Set();
  const buffer = fs.readFileSync(file);
  const starts = [];
  // The rollout's own thread is its first session_meta, the id its file name and the host's records of its own work
  // carry. A sub-agent's rollout copies the session_meta of the thread it was forked from after its own.
  let sessionId;
  let fork = null; // what the first session_meta says of a fork: the thread it came from, and where its own history starts
  let history = null; // that start, once the rollout shows it copied the parent's session_meta, and so its history
  for (const [line, row] of records(buffer, warnings)) {
    const payload = row.payload || {};
    if (row.type === "session_meta" && sessionId === undefined) {
      sessionId = bounded(payload.id);
      if (payload.forked_from_id != null && Number.isFinite(payload.subagent_history_start_ordinal)) {
        fork = { from: payload.forked_from_id, start: payload.subagent_history_start_ordinal };
      }
    } else if (row.type === "session_meta" && fork && payload.id === fork.from) history = fork.start;
    if (row.type === "event_msg" && payload.type === "task_started") starts.push({ line, time: timeOf(row), agent: false, prompted: false });
    const turn = starts[starts.length - 1];
    if (turn && row.type === "inter_agent_communication_metadata" && payload.trigger_turn === true) turn.agent = true;
    if (turn && isCodexPrompt(row)) turn.prompted = true;
  }
  if (before === null && !starts.length) throw new Error("No task_started boundary found. Supply --before or --before-line for a known audit cutoff.");
  // A turn another agent started, with no prompt from the owner in it, is that agent's work and not the audit.
  const owned = starts.filter((turn) => !turn.agent || turn.prompted);
  const turns = owned.length ? owned : starts;
  const cutoff = cutoffOf(before, before === null ? turns[turns.length - 1].line : null);
  let cutoffTime = null;

  const track = tracker();
  // Only a rollout can carry the host's own records, so only its coverage counts the outcomes they settled.
  track.coverage.recordedOutcomes = 0;
  const nav = navigator(limit);
  const failures = [];
  const counts = {};
  const largest = [];
  const scripts = new Map(); // an exec call's id, or the cell its script runs in, to what `vouches` says of the script
  const operations = new Map(); // a cell to the operation of the call that started its script
  const unprinted = new Map(); // an exec call's id, or its script's cell, to its commands whose exit codes were not printed yet
  const expected = new Map(); // an exec call's id, or its script's cell, to the calls its code makes
  const recorded = new Map(); // a call's id, or its script's cell, to what the host's own records say of it
  const issued = new Set(); // every call id seen, so that a record naming one belongs to that call
  const open = new Map(); // an open call's id, to when it was issued and which script it runs
  const waits = new Map(); // a wait call's id to the cell it waits on
  const running = new Set(); // cells whose script still ran at their latest result
  const agents = new Set(); // sub-agent threads started or spoken to and not yet finished
  let handed = false; // whether this session has handed work to agents of its own, which run beside it from then on
  const owns = (key) => {
    const own = recorded.get(key) || { commands: 0, tools: 0, failed: null, ambiguous: false };
    recorded.set(key, own);
    return own;
  };
  let context = {};
  let cwd = null;
  let promptLine = null;
  let selected = 0;
  for (const [line, row] of records(buffer, warnings)) {
    const payload = row.payload || {};
    const answer = row.type === "response_item"
      && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output");
    if (line === cutoff.line) cutoffTime = timeOf(row);
    if (!selects(line, row, cutoff)) {
      if (answer) settle(track, payload.call_id, false);
      continue;
    }
    selected += 1;
    // A fork that copied its parent's history holds it below the ordinal where its own starts, written when the fork
    // was made. No call, result, record or compaction there is the fork's work; its prompts and turn_context stay, as
    // the context the sub-agent was given.
    if (history !== null && Number.isFinite(row.ordinal) && row.ordinal < history && row.type !== "turn_context" && !isCodexPrompt(row)) continue;
    if (row.type === "compacted") nav.compactions += 1;
    if (row.type === "turn_context") {
      cwd = payload.cwd || null;
      context = { cwd: directory(payload.cwd), model: bounded(payload.model), effort: bounded(payload.effort) };
    }
    if (isCodexPrompt(row)) promptLine = line;
    // The host writes its own record of each command and server tool call. It belongs to a call when it names it, or
    // when that call was the only one open, no other cell was running to have started the command, and the run began
    // at or after it. With no call open at all, the only cell still running is the only candidate owner, and it has to
    // name what ran. A record another thread ran is that agent's and decides nothing here; one that names no thread
    // may be another agent's while one is at work, so the open call has to name what ran as well. Anything else leaves
    // every open script in doubt or belongs to a run of its own.
    if (row.type === "event_msg" && payload.type === "item_completed") {
      const item = payload.item || {};
      if (item.type === "SubAgentActivity") {
        if (item.kind === "started" || item.kind === "interacted") agents.add(bounded(item.agent_thread_id));
        else agents.delete(bounded(item.agent_thread_id));
        continue;
      }
      if (item.type === "CollabAgentToolCall") handed = true;
      const record = recordOf(payload, row);
      if (!record || (record.thread !== null && record.thread !== sessionId)) continue;
      const doubt = record.thread === null && (agents.size > 0 || handed);
      const [only] = open.values();
      const [cell] = running;
      const named = issued.has(record.id);
      const alone = open.size === 1 && only.key
        && running.size === (only.key.startsWith("cell ") && running.has(only.key.slice(5)) ? 1 : 0);
      const key = alone ? only.key : open.size === 0 && running.size === 1 ? `cell ${cell}` : null;
      const want = key === null ? null : expected.get(key);
      const since = alone ? only.when : want ? want.since ?? null : null;
      const shown = key !== null && (alone && !doubt ? true : mentions(want, record));
      if (named || (shown && since !== null && record.started !== null && record.started >= since)) {
        const own = owns(named ? `call ${record.id}` : key);
        if (record.command) own.commands += 1;
        else own.tools += 1;
        own.failed = own.failed || (record.failed ? record : null);
      } else if (open.size > 1) {
        for (const call of open.values()) if (call.key) owns(call.key).ambiguous = true;
      }
      continue;
    }
    if (row.type !== "response_item") continue;
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      let input = payload.arguments === undefined ? payload.input : payload.arguments;
      if (typeof input !== "string") input = JSON.stringify(input === undefined ? "" : input);
      const shape = codexShape(payload, input, cwd);
      const call = callEntry(payload.name, "main", line, promptLine, phaseOf(nav, "main", promptLine, null), shape, input);
      if (issue(track, payload.call_id, call, shape.opaque)) called(nav, call, shape, { actor: "main", key: payload.call_id, message: null, cwd });
      if (payload.type === "custom_tool_call" && payload.name === "exec") {
        scripts.set(`call ${payload.call_id}`, vouches(input));
        const makes = callsIn(input);
        unprinted.set(`call ${payload.call_id}`, makes.printing);
        expected.set(`call ${payload.call_id}`, makes);
      }
      const waited = payload.name === "wait" ? objectAt(input, 0)?.cell_id : null;
      if (typeof waited === "string" || typeof waited === "number") waits.set(payload.call_id, String(waited));
      const when = Date.parse(row.timestamp || "");
      issued.add(payload.call_id);
      open.set(payload.call_id, {
        when: Number.isNaN(when) ? null : when,
        key: waits.has(payload.call_id) ? `cell ${waits.get(payload.call_id)}` : expected.has(`call ${payload.call_id}`) ? `call ${payload.call_id}` : null,
      });
    } else if (answer) {
      const settled = settle(track, payload.call_id, true);
      // When the call returns, its own time is what a record of its script has to begin at or after.
      const issuedAt = open.get(payload.call_id)?.when ?? null;
      open.delete(payload.call_id);
      if (settled === false) continue;
      const call = settled || noCall("main");
      const texts = textBlocks(payload.output);
      const parts = texts.flatMap((text) => resultParts(text));
      // A script still running when its call returns names its cell, and a wait call on that cell returns the rest.
      const head = texts[0] || "";
      const cell = waits.get(payload.call_id) ?? null;
      const key = cell === null ? `call ${payload.call_id}` : `cell ${cell}`;
      const script = scripts.get(key);
      // A wait's result reads like one from the call that started the script.
      const operation = cell === null ? call.operation : operations.get(cell) ?? call.operation;
      // The exit codes a running script printed count with those of the result that completes it.
      const exits = parts.filter(([code]) => code !== null).length;
      const left = (unprinted.get(key) ?? 0) - exits;
      const run = /^Script running with cell ID (\S+)/.exec(head);
      if (run) {
        running.add(run[1]);
        scripts.set(`cell ${run[1]}`, script || false);
        operations.set(run[1], operation);
        unprinted.set(`cell ${run[1]}`, left);
        // The cell keeps what the script calls and when it was first started, whatever later wait returns to it.
        if (expected.has(key)) expected.set(`cell ${run[1]}`, { since: issuedAt, ...expected.get(key) });
        if (recorded.has(key)) recorded.set(`cell ${run[1]}`, recorded.get(key));
      } else if (cell !== null && /^Script\b/.test(head)) running.delete(cell);
      // A script that runs on is pending, and one stopped is unknown, whatever exit a command it finished printed.
      // Otherwise a printed exit code decides, unless `Script completed` printed fewer than its script's commands;
      // without one, a success when `Script completed` vouches for its script, and unknown if not. Any failed part
      // fails the result.
      const completed = /^Script completed\b/.test(head);
      const status = run ? "pending" : /^Script terminated\b/.test(head) ? "unknown"
        : exits ? (completed && left > 0 ? "unknown" : null) : completed && script ? "ok" : "unknown";
      // A read or search that exited 0 printed content, as did a vouched script that read, searched or ran no shell command.
      const printed = status === "ok" && (script === "content" || CONTENT.has(operation));
      // The records that belong to this call, what its script calls, and what they say of a candidate its text finds.
      const own = recorded.get(key);
      const want = expected.get(key) || { commands: 0, tools: 0, uncovered: false };
      const settles = Boolean(own) && !own.ambiguous && own.commands + own.tools > 0 && (completed || !/^Script\b/.test(head));
      const note = settles && !own.failed ? recordNote(own) : null;
      let outcome = null;
      let missing = null;
      let reported = false;
      // A result is one later success, whatever number of parts print exit 0: its first qualifying part stands for it.
      const succeed = (output) => {
        outcome = outcome || "ok";
        if (reported) return;
        reported = true;
        const success = { line, timestamp: timeOf(row), ...call, outputExcerpt: excerpt(output, 350) };
        for (const failure of failures) {
          // A call issued before the failure was reported ran beside it, so it cannot follow it.
          if (call.callLine > failure.line && failure.nearbyReportedSuccesses.length < 2) failure.nearbyReportedSuccesses.push(success);
        }
      };
      for (const text of texts) {
        keepLargest(largest, {
          line, characters: text.length, persisted: false, tool: call.tool, actor: call.actor, callLine: call.callLine, path: call.path,
        });
      }
      for (const [code, output] of parts) {
        // Content quotes errors.
        const diagnostic = printed || (code === 0 && CONTENT.has(operation)) ? null : diagnose(CODEX_DIAGNOSTICS, output);
        const failed = code !== null && code !== 0;
        if (failed || diagnostic) {
          outcome = "failed";
          missing = missing || lineOf(MISSING, output);
          const named = missingIn(call.operation, output) || diagnostic;
          const category = named ? named.name : "nonzero-exit";
          keepLast(failures, {
            line, timestamp: timeOf(row), ...call, exitCode: code, category,
            evidenceBasis: failed ? "reported-nonzero-exit" : "diagnostic-text-match-only",
            diagnosticCandidate: excerpt(output.slice(named ? Math.max(0, named.index - 100) : 0)),
            ...(failed || !note ? {} : { hostRecord: note }),
            nearbyReportedSuccesses: [],
          }, limit);
          counts[category] = (counts[category] || 0) + 1;
        } else if (code === 0 && status === null) succeed(output);
      }
      const joined = texts.join("\n");
      if (!outcome && status === "ok") succeed(joined);
      outcome = outcome || status;
      // A record the host kept decides a finished result where it belongs to its call beyond doubt: a failure it saw
      // stands, and records covering every call the script makes turn an unknown result into a success. A record
      // never turns a failure into a success, and an ambiguous or missing one leaves the reading as it was.
      if (settles && own.failed && outcome !== "failed") {
        outcome = "failed";
        const category = own.failed.command ? "nonzero-exit" : "tool-error";
        keepLast(failures, {
          line, timestamp: timeOf(row), ...call, exitCode: own.failed.exitCode, category, evidenceBasis: "host-record",
          recordedCommand: excerpt(own.failed.name), diagnosticCandidate: excerpt(own.failed.output || own.failed.name),
          nearbyReportedSuccesses: [],
        }, limit);
        counts[category] = (counts[category] || 0) + 1;
        track.coverage.recordedOutcomes += 1;
      } else if (settles && !own.failed && outcome === "unknown" && !want.uncovered
        && own.commands >= want.commands && own.tools >= want.tools) {
        outcome = "ok";
        succeed(joined);
        track.coverage.recordedOutcomes += 1;
      }
      if (settled && outcome === "unknown") track.coverage.outcomeUnknown += 1;
      answered(nav, call, {
        line, timestamp: timeOf(row), output: joined, size: joined.length, persisted: false, saved: null, appended: 0, outcome, missing,
        cut: outcome === "failed" ? null : lineOf(CODEX_CUT, joined),
      });
    }
  }
  noteBounds(warnings, counts, limit, selected);
  if (selected && !track.coverage.calls) {
    warnings.add("No tool calls precede the selected cutoff. If the session is finished, its latest task start is not this audit; pass --before-line or --before.");
  }
  track.coverage.pending = running.size;
  const navigation = navigationOf(nav, warnings);
  const boundary = boundaryOf(cutoff, cutoffTime, buffer.length, before === null ? "before-latest-task-start" : null, warnings);
  return {
    sessionFile: file, sessionId: sessionId ?? null, boundary,
    context, recordsSelected: selected, coverage: coverageOf(track, limit), candidateCounts: counts, candidates: failures,
    navigationCounts: nav.counts, navigationCandidates: navigation, largestToolTexts: largest, warnings: [...warnings].sort(),
    limits: "Counts are text, exit and record candidates, not verified independent failures. Output of a read or "
      + "search that exited 0 is content and is not text-matched, and so is that of a vouched script that ran no shell "
      + "command. A result without an exit code is a success only when Script completed vouches for its script, and a "
      + "completed script that printed fewer exit codes than its commands is unknown; otherwise, unless its text reads "
      + "like a failure, its outcome is pending or unknown. The host's own records settle an outcome only where a "
      + "record names its call, or one call was open and the run began at or after it; with no call open the only cell "
      + "still running takes the record instead, and there only a record the script spells out is used. A record "
      + "another thread ran decides nothing, and one that names no thread is used while another agent is at work only "
      + "when the script spells it out. An ambiguous or missing record leaves the reading as it was, and no record "
      + "turns a failure into a success. Redaction is best effort. A "
      + "nearby success is not proof of recovery. A navigation candidate's cause is a hypothesis, and a scope of none "
      + "or transient means no change. A rollout does not include child tasks. No other session was read.",
  };
}

module.exports = { analyzeCodex };
