"use strict";

// Claude Code transcripts: <claude home>/projects/<project>/<session id>.jsonl
// analyzeClaude reads one into the evidence session-evidence.js prints.

const fs = require("node:fs");
const path = require("node:path");
const { bounded, directory, excerpt, timeOf } = require("./session-evidence-redaction.js");
const {
  BROWSER_MISSING, COMMAND_NOT_FOUND, MISSING, OPAQUE, boundaryOf, callEntry, coverageOf, cutoffOf, diagnose, issue, keepLargest,
  keepLast, lineOf, missingIn, noCall, noteBounds, records, selects, settle, textBlocks, tracker,
} = require("./session-evidence-records.js");
const { CONTENT, normalizePath, shellShape } = require("./session-evidence-shell.js");
const { answered, called, navigationOf, navigator, noticed, phaseOf, siblings } = require("./session-evidence-navigation.js");
const { prompted, said, stallTracker, stallsOf, worked } = require("./session-evidence-stall.js");

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const EXIT = /^Exit code (-?\d+)\b/;
// The Read tool's refusal of a file over its token or size limit.
const READ_LIMIT = /exceeds maximum allowed (?:tokens|size)\b/;

// First match wins, so a host's own error text sits above the generic shell ones. A missing path is not listed:
// it is read from a failed read, search or edit alone, with MISSING.
const CLAUDE_DIAGNOSTICS = [
  ["unknown-tool", /No such tool available/],
  ["invalid-tool-input", /InputValidationError/],
  ["stale-file-state", /File has (?:not been read yet|been modified since read)/],
  ["edit-no-match", /String to replace not found/],
  ["output-too-large", READ_LIMIT],
  ["user-declined", /The user doesn't want to proceed with this tool use/],
  ["interrupted", /Command was aborted before completion/],
  ["browser-executable-missing", BROWSER_MISSING],
  ["port-in-use", /\bEADDRINUSE\b|\bPort \d+ is in use\b/i],
  ["command-not-found", COMMAND_NOT_FOUND],
  ["blocked", /\bis blocked\b|\bblocked by policy\b/i],
  ["permission-denied", /(?:Access is denied\.|Permission denied|Operation not permitted|\bEPERM\b)/i],
];

// The file tools, each with the operation it performs.
const FILE_TOOLS = new Map([
  ["Read", "read"], ["NotebookRead", "read"], ["Grep", "search"], ["Glob", "search"], ["LS", "search"],
  ["Edit", "edit"], ["MultiEdit", "edit"], ["NotebookEdit", "edit"], ["Write", "write"],
]);

// Host text a user record can carry in place of a request. Only complete leading envelopes are
// removed, so a request typed after one still counts and prose that mentions one is untouched.
const NOTICE_TAGS = String.raw`(?:task|tool|system)[-_]notification|system-reminder|local-command-(?:caveat|stdout|stderr)`
  + String.raw`|bash-(?:stdout|stderr)|user-prompt-submit-hook`;
const NOTICE = new RegExp(String.raw`^\s*<(${NOTICE_TAGS})>[\s\S]*?<\/\1>`, "i");

// Claude Code keeps only a preview of a large result, and states the size of the output it saved to a file.
const PERSISTED = /^\s*<persisted-output>\s*Output too large \((\d+(?:\.\d+)?)\s*([KMG]?B)\)/i;
const SAVED_TO = /Full output saved to: ([^\r\n]+)/;
// Tools that return another call's output: a background command's, read later.
const BACKGROUND_OUTPUT = /^(?:TaskOutput|BashOutput)$/;

function isNotice(text) {
  let rest = text;
  for (let match = NOTICE.exec(rest); match; match = NOTICE.exec(rest)) rest = rest.slice(match[0].length);
  return rest !== text && !rest.trim();
}

// Reminders the host appends after a tool's output are not output.
function withoutReminders(text) {
  let rest = text;
  while (rest.trimEnd().endsWith("</system-reminder>")) {
    const start = rest.lastIndexOf("<system-reminder>");
    if (start === -1) break;
    rest = rest.slice(0, start);
  }
  return rest === text ? text : rest.trimEnd();
}

// The size of a result the host saved elsewhere, in bytes as it states them.
function persistedSize(match) {
  return Math.round(Number(match[1]) * 1024 ** "BKMG".indexOf(match[2][0].toUpperCase()));
}

// A bridged or resumed session can append its history again, record for record. A record whose uuid
// was already read is that replay, not new work, and is skipped with a warning.
function* firstCopies(buffer, warnings) {
  const seen = new Set();
  let replayed = 0;
  for (const [line, row] of records(buffer, warnings)) {
    if (typeof row.uuid === "string" && row.uuid) {
      if (seen.has(row.uuid)) {
        replayed += 1;
        continue;
      }
      seen.add(row.uuid);
    }
    yield [line, row];
  }
  if (replayed) {
    warnings.add(`Skipped ${replayed} records that repeat an earlier record's uuid, as a bridged or resumed session replays its history.`);
  }
}

// A user record that asks for work: not a tool result, a compaction summary or an automatic host notice.
function isPrompt(row) {
  const content = (row.message || {}).content;
  const carriesResult = Array.isArray(content) && content.some((block) => block && block.type === "tool_result");
  return row.type === "user" && !carriesResult && !row.isCompactSummary && !isNotice(textBlocks(content).join("\n"));
}

// A prompt typed while the agent works arrives as a queued command, not as a user record.
function isQueuedPrompt(row) {
  const queued = row.type === "attachment" && row.attachment;
  return Boolean(queued) && queued.type === "queued_command" && queued.commandMode === "prompt"
    && (queued.origin ? queued.origin.kind === "human" : !queued.isMeta)
    && !isNotice(textBlocks(queued.prompt).join("\n"));
}

// Who wrote a record: the main session, or a subagent whose records share the transcript.
function actorOf(row) {
  if (!row.isSidechain) return "main";
  return typeof row.agentId === "string" && row.agentId ? row.agentId : "sidechain";
}

function claudeShape(tool, input, cwd) {
  if (SHELL_TOOLS.has(tool)) return shellShape(typeof input.command === "string" ? input.command : "", cwd);
  const operation = FILE_TOOLS.get(tool) || "other";
  if (operation === "other") return { operation, path: null, opaque: OPAQUE.test(String(tool)) };
  const named = [input.file_path, input.notebook_path, input.path].find((value) => typeof value === "string");
  const whole = operation === "read" && ["offset", "limit", "pages"].every((range) => input[range] === undefined);
  return { operation, path: normalizePath(named === undefined && operation === "search" ? cwd : named, cwd), whole };
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
    return { file: path.join(folder, name), agentType: bounded(meta.agentType), description: excerpt(meta.description || "", 120) };
  });
}

function analyzeClaude(file, before = null, limit = 6) {
  const warnings = new Set();
  const buffer = fs.readFileSync(file);
  const prompts = [];
  const sidechain = new Set();
  let sessionId = null;
  let originAware = false;
  for (const [line, row] of firstCopies(buffer, warnings)) {
    sessionId = sessionId || bounded(row.sessionId);
    originAware = originAware || (row.origin !== null && typeof row.origin === "object");
    sidechain.add(Boolean(row.isSidechain));
    if (actorOf(row) === "main" && isPrompt(row)) prompts.push({ line, time: timeOf(row), origin: row.origin, meta: row.isMeta });
  }
  // Newer transcripts tag a typed prompt with origin.kind "human"; older ones only mark injected text as isMeta.
  const starts = prompts.filter((p) => (originAware ? Boolean(p.origin) && p.origin.kind === "human" : !p.meta));
  if (sidechain.size > 1) warnings.add("The transcript mixes main and sidechain records; each entry names its actor.");
  if (before === null && !starts.length) throw new Error("No human prompt boundary found. Supply --before or --before-line for a known audit cutoff.");
  const cutoff = cutoffOf(before, before === null ? starts[starts.length - 1].line : null);
  let cutoffTime = null;
  const typed = new Set(starts.map((prompt) => prompt.line));

  const track = tracker();
  const nav = navigator(limit);
  const stalls = stallTracker(limit);
  const actors = new Map();
  const failures = [];
  const failedCalls = new WeakMap();
  const counts = {};
  const largest = [];
  const context = {};
  let selected = 0;
  for (const [line, row] of firstCopies(buffer, warnings)) {
    const actor = actorOf(row);
    const message = row.message || {};
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (line === cutoff.line) cutoffTime = timeOf(row);
    if (!selects(line, row, cutoff)) {
      // Past the cutoff a result is read only to settle a call issued before it.
      for (const block of blocks) if (block && block.type === "tool_result") settle(track, JSON.stringify([actor, block.tool_use_id]), false);
      continue;
    }
    selected += 1;
    if (row.isCompactSummary || row.subtype === "compact_boundary") nav.compactions += 1;
    const notice = row.type === "attachment" && row.attachment && row.attachment.type === "read_truncation_notice" ? row.attachment : null;
    if (notice && typeof notice.toolUseID === "string") noticed(nav, JSON.stringify([actor, notice.toolUseID]), line, String(notice.banner || ""));
    if (!actors.has(actor)) actors.set(actor, { cwd: null, promptLine: null });
    const state = actors.get(actor);
    if (row.cwd) {
      state.cwd = row.cwd;
      Object.assign(context, { cwd: directory(row.cwd), version: bounded(row.version) });
    }
    if (row.type === "assistant" && message.model) context.model = bounded(message.model);
    // A prompt claims only the calls its actor issues after it: the typed or queued prompt, or a subagent's task.
    if (actor === "main" ? typed.has(line) || isQueuedPrompt(row) : !row.isMeta && isPrompt(row)) state.promptLine = line;
    // The owner's typed prompt settles the main session's turn before it. A prompt queued while the session worked, or
    // one that carries more than text, such as an image, makes no stall candidate.
    if (actor === "main" && (typed.has(line) || isQueuedPrompt(row))) {
      const content = typed.has(line) ? message.content : row.attachment.prompt;
      const text = (block) => typeof block === "string" || (block && block.type === "text");
      const plain = typed.has(line) && (!Array.isArray(content) || content.every(text));
      prompted(stalls, { line, timestamp: timeOf(row), text: textBlocks(content).join("\n"), plain });
    }
    // Claude Code writes each call of an assistant message as a record of its own, and all of them carry its id.
    const messageId = typeof message.id === "string" && message.id ? message.id : null;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (actor === "main" && row.type === "assistant" && block.type === "text" && typeof block.text === "string") {
        said(stalls, block.text, line, timeOf(row));
      }
      if (block.type === "tool_use") {
        if (actor === "main") worked(stalls);
        const fields = block.input && typeof block.input === "object" ? block.input : {};
        let input = block.input === undefined ? {} : block.input;
        if (input && typeof input.command === "string") input = input.command;
        else if (typeof input !== "string") input = JSON.stringify(input);
        const shape = claudeShape(block.name, fields, state.cwd);
        const key = JSON.stringify([actor, block.id]);
        const call = callEntry(block.name, actor, line, state.promptLine, phaseOf(nav, actor, state.promptLine, messageId), shape, input);
        if (issue(track, key, call, shape.opaque)) {
          const task = fields.task_id ?? fields.bash_id;
          called(nav, call, shape, {
            actor, key, message: messageId, cwd: state.cwd, background: SHELL_TOOLS.has(block.name) && fields.run_in_background === true,
            task: BACKGROUND_OUTPUT.test(String(block.name)) ? String(task ?? "").slice(0, 120) : null,
          });
        }
      } else if (block.type === "tool_result") {
        const settled = settle(track, JSON.stringify([actor, block.tool_use_id]), true);
        if (settled === false) continue;
        const call = settled || noCall(actor);
        const text = textBlocks(block.content).join("\n");
        const output = withoutReminders(text);
        const persisted = PERSISTED.exec(output);
        const size = persisted ? persistedSize(persisted) : output.length;
        keepLargest(largest, {
          line, characters: size, persisted: Boolean(persisted), tool: call.tool, actor: call.actor, callLine: call.callLine, path: call.path,
        });
        const reported = Boolean(block.is_error);
        const exit = EXIT.exec(output);
        // Successful output is text-matched only for a shell command that neither reads nor searches: content quotes errors.
        const diagnostic = reported || (SHELL_TOOLS.has(call.tool) && !CONTENT.has(call.operation)) ? diagnose(CLAUDE_DIAGNOSTICS, output) : null;
        const failed = reported || Boolean(diagnostic);
        if (call.actor === "main") worked(stalls, failed ? "failed" : "ok");
        const saved = persisted && SAVED_TO.exec(output);
        answered(nav, call, {
          line, timestamp: timeOf(row), output, size, persisted: Boolean(persisted), saved: saved ? normalizePath(saved[1].trim(), state.cwd) : null,
          appended: text.length - output.length, outcome: failed ? "failed" : "ok", missing: failed ? lineOf(MISSING, output) : null,
          // A Read over the tool's limit returned nothing, and a persisted result only a preview.
          cut: failed ? lineOf(READ_LIMIT, output) : persisted ? lineOf(/Output too large/, output) : null,
        });
        if (failed) {
          const named = missingIn(call.operation, output) || diagnostic;
          let category = "tool-error";
          if (named) category = named.name;
          else if (exit) category = "nonzero-exit";
          else if (output.includes("<tool_use_error>")) category = "tool-use-error";
          const failure = {
            line, timestamp: timeOf(row), ...call,
            exitCode: exit ? Number(exit[1]) : null, category,
            evidenceBasis: reported ? "reported-error" : "diagnostic-text-match-only",
            diagnosticCandidate: excerpt(output.slice(named ? Math.max(0, named.index - 100) : 0)),
            laterSameToolSuccesses: [],
          };
          failedCalls.set(failure, call);
          keepLast(failures, failure, limit);
          counts[category] = (counts[category] || 0) + 1;
        } else {
          const success = { line, timestamp: timeOf(row), ...call, outputExcerpt: excerpt(output, 350) };
          for (const failure of failures) {
            // A call issued before the failure was reported ran beside it, so it cannot follow it, and neither can a
            // call from the failure's own assistant message, whenever the host wrote it down.
            if (failure.actor === call.actor && failure.tool === call.tool && call.callLine > failure.line
              && !siblings(nav, failedCalls.get(failure), settled) && failure.laterSameToolSuccesses.length < 2) {
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
    warnings.add("No assistant records precede the selected cutoff. For a finished session, the latest prompt is not this audit; pass --before-line or --before.");
  }
  const navigation = navigationOf(nav, warnings);
  const stalled = stallsOf(stalls, warnings);
  const boundary = boundaryOf(cutoff, cutoffTime, buffer.length, before === null ? "before-latest-human-prompt" : null, warnings);
  return {
    sessionFile: file, sessionId, boundary,
    context, recordsSelected: selected, coverage: coverageOf(track, limit), candidateCounts: counts, candidates: failures,
    navigationCounts: nav.counts, navigationCandidates: navigation, ...stalled,
    largestToolTexts: largest, subagentTranscripts: subagents.slice(0, 20), warnings: [...warnings].sort(),
    limits: "Counts are is_error and text candidates, not verified independent failures; is_error also marks hook blocks, "
      + "permission denials and user interrupts. Successful output of a read or search is content and is not text-matched. "
      + "Redaction is best effort. A later same-tool success is not proof of recovery. A path is resolved from the "
      + "working directory recorded with its call, and a write does not show that a file was created. A navigation "
      + "candidate's cause is a hypothesis, and a scope of none or transient means no change. Subagent transcripts were "
      + "listed, not read. No other session was read.",
  };
}

module.exports = { analyzeClaude };
