"use strict";

// What both hosts' readers share: transcript records, one per line; the audited interval; the calls, their
// results and the coverage they add up to; and the failure candidates kept from them.

const { excerpt } = require("./session-evidence-redaction.js");

const BROWSER_MISSING = /(?:Executable doesn't exist|browserType\.launch:.*(?:not found|missing))/i;
const COMMAND_NOT_FOUND = /(?:is not recognized as (?:a|the) name|command not found|MODULE_NOT_FOUND)/i;
// A path that does not exist, as a file tool, a shell, PowerShell, Windows or Node says it. Read only in a failed
// read, search or edit, since content quotes errors; both the failure and the navigation views name it missing-path.
const MISSING = /(?:File|Path|Directory) does not exist|No such file or directory|Cannot find path|cannot find the (?:file|path) specified|\bENOENT\b/i;
const FOLLOWED = new Set(["read", "search", "edit"]);
// Tools whose effect on files the transcript does not show: a subagent, a workflow of them, an MCP server.
const OPAQUE = /^(?:Agent|Task|Workflow|spawn_agent|js)$|^mcp__/;

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

// The end of the audited interval: a time given as a Date, or a line, either given as a number or the default one.
function cutoffOf(before, line) {
  return before instanceof Date ? { time: before, skipped: 0, withMessage: 0 } : { line: before === null ? line : before, skipped: 0, withMessage: 0 };
}

// Whether a record falls inside the audited interval. A time cutoff skips a record without a usable timestamp and
// counts it; only one that held conversation, not host metadata, earns a warning.
function selects(line, row, cutoff) {
  if (!cutoff.time) return line < cutoff.line;
  const time = new Date(row.timestamp || NaN);
  if (!Number.isNaN(time.getTime())) return time < cutoff.time;
  cutoff.skipped += 1;
  if (row.message || row.attachment || row.type === "response_item" || row.type === "event_msg") cutoff.withMessage += 1;
  return false;
}

// The cutoff as the evidence reports it. `before` is the time of the record at the cutoff line, or the time given.
function boundaryOf(cutoff, cutoffTime, bytes, defaultMode, warnings) {
  const count = cutoff.withMessage;
  if (count) warnings.add(`Skipped ${count} record${count === 1 ? "" : "s"} with a message but without a usable timestamp while using --before.`);
  return {
    before: cutoff.time ? cutoff.time.toISOString() : cutoffTime, line: cutoff.time ? null : cutoff.line, snapshotBytes: bytes,
    mode: cutoff.time ? "explicit-time" : defaultMode || "explicit-line", skippedWithoutTimestamp: cutoff.skipped,
  };
}

// A failed read, search or edit whose result says its path does not exist names that cause first, whatever else its
// result says, so that the failure and its navigation candidate agree.
function missingIn(operation, output) {
  const match = FOLLOWED.has(operation) ? MISSING.exec(output) : null;
  return match ? { name: "missing-path", index: match.index } : null;
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

function callEntry(tool, actor, callLine, promptLine, phase, shape, input) {
  return {
    tool: tool == null ? null : excerpt(tool, 120), actor: excerpt(actor, 120), callLine, promptLine, phase, operation: shape.operation,
    path: shape.path === null ? null : excerpt(shape.path), commandOrArguments: excerpt(input),
  };
}

// What a result names when no issued call carries its id.
function noCall(actor) {
  return {
    tool: null, actor: excerpt(actor, 120), callLine: null, promptLine: null, phase: null, operation: null, path: null, commandOrArguments: null,
  };
}

// Calls wait here for their results, so a result pairs by id whatever order results arrive in.
function tracker() {
  return {
    pending: new Map(),
    done: new Set(),
    opaque: 0,
    coverage: {
      calls: 0, answered: 0, answeredAfterCutoff: 0, unanswered: 0, unansweredCallLines: [], pending: 0, outcomeUnknown: 0,
      resultsWithoutCall: 0, repeatedCallIds: 0, operations: { read: 0, search: 0, edit: 0, write: 0, command: 0, mixed: 0, other: 0 },
      readOnly: true,
    },
  };
}

// A call id seen again, before or after its result, is a repeated record, as a replayed history repeats
// it, not a second call. True when the call is new.
function issue(track, key, call, opaque) {
  if (track.pending.has(key) || track.done.has(key)) {
    track.coverage.repeatedCallIds += 1;
    return false;
  }
  track.pending.set(key, call);
  track.coverage.calls += 1;
  track.coverage.operations[call.operation] += 1;
  if (opaque) track.opaque += 1;
  return true;
}

// The call a result answers, or false when the result repeats one already settled. Past the cutoff a
// result only settles its call; inside, one with no call is counted.
function settle(track, key, inside) {
  if (track.done.has(key)) return false;
  const call = track.pending.get(key) || null;
  track.pending.delete(key);
  track.done.add(key);
  if (!inside) track.coverage.answeredAfterCutoff += call ? 1 : 0;
  else if (call) track.coverage.answered += 1;
  else track.coverage.resultsWithoutCall += 1;
  return call;
}

function coverageOf(track, limit) {
  const { coverage, pending } = track;
  const { edit, write, command, mixed } = coverage.operations;
  coverage.unanswered = pending.size;
  coverage.unansweredCallLines = [...pending.values()].slice(-limit).map((call) => call.callLine);
  // An edit or write settles it. No call at all, a shell command of unknown effect, or a call into a
  // subagent or an MCP server leaves it open.
  coverage.readOnly = edit + write > 0 ? false : coverage.calls === 0 || command + mixed + track.opaque > 0 ? null : true;
  return coverage;
}

// The line of a text around `index`, from at most 120 characters before it.
function lineAt(text, index) {
  const end = text.indexOf("\n", index);
  return text.slice(Math.max(text.lastIndexOf("\n", index) + 1, index - 120), end === -1 ? text.length : end);
}

function lineOf(pattern, text) {
  const match = pattern.exec(text);
  return match ? lineAt(text, match.index) : null;
}

function noteBounds(warnings, counts, limit, selected) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (total > limit) warnings.add(`Only the last ${limit} candidates are shown; counts cover the selected interval.`);
  if (!selected) warnings.add("No work records precede the selected cutoff.");
}

module.exports = {
  BROWSER_MISSING, COMMAND_NOT_FOUND, MISSING, FOLLOWED, OPAQUE, textBlocks, parseCutoff, records, cutoffOf, selects, boundaryOf,
  missingIn, diagnose, keepLargest, keepLast, callEntry, noCall, tracker, issue, settle, coverageOf, lineOf, noteBounds,
};
