#!/usr/bin/env node
"use strict";

// scribe — PostToolUse observer on AskUserQuestion.
//
// Asks are tool calls a hook can see, which makes the "asked" half of the
// ledger hard evidence rather than a self-report.
// One line per question round: the headers and truncated question texts —
// enough to evaluate ask quality at review time, never the full transcript.
//
// A wave-off typed INTO the round ("just do it" in an answer) is visible here
// too, in the tool response — that gets its own line, so the review can see
// consent draining before the user ever reaches for the kill switch.

const lib = require("./scribe-lib");

function main() {
  const payload = lib.readInput();
  if (payload.tool_name !== "AskUserQuestion") return;
  const root = lib.projectRoot(payload.cwd);
  if (lib.isOff(root)) return;

  const session = typeof payload.session_id === "string" ? payload.session_id : null;
  const input = lib.isObject(payload.tool_input) ? payload.tool_input : {};
  // The offered option labels ride along with the question. Without them an
  // answer can never be matched against what was on the menu, and the one
  // thing the method calls load-bearing — whether the options were any good —
  // stays invisible to the review.
  const questions = Array.isArray(input.questions)
    ? input.questions.filter(lib.isObject).map((q) => ({
        header: typeof q.header === "string" ? q.header : null,
        question: typeof q.question === "string" ? q.question.slice(0, lib.QUESTION_KEEP) : null,
        options: Array.isArray(q.options)
          ? q.options
              .filter(lib.isObject)
              .map((o) => (typeof o.label === "string" ? o.label.trim().slice(0, lib.OPTION_KEEP) : ""))
              .filter(Boolean)
          : [],
      }))
    : [];

  // The response's shape varies by host version, so the harvest walks it for
  // short strings — those are the picked labels and typed answers. But the
  // response also echoes the round's own questions and headers, and those
  // would fill the eight slots before a single answer landed, leaving the
  // review (and the remembered-answer match, which reads this field) with a
  // record of what scribe asked instead of what the user chose. So anything
  // the round already said is skipped on the way in.
  const asked = new Set();
  if (Array.isArray(input.questions)) {
    for (const q of input.questions.filter(lib.isObject)) {
      for (const s of [q.header, q.question]) {
        if (typeof s === "string" && s.trim()) asked.add(s.trim());
      }
    }
  }
  const answers = [];
  (function harvest(v, depth) {
    if (answers.length >= lib.ANSWERS_KEEP || depth > 4) return;
    if (typeof v === "string") {
      const s = v.trim();
      if (s && s.length <= lib.ANSWER_MAX && !asked.has(s)) answers.push(s);
    } else if (Array.isArray(v)) {
      for (const x of v) harvest(x, depth + 1);
    } else if (lib.isObject(v)) {
      for (const x of Object.values(v)) harvest(x, depth + 1);
    }
  })(payload.tool_response, 0);

  lib.appendLedger(root, {
    session, kind: "asked", source: "mechanical",
    count: questions.length, questions, answers,
  });

  let raw = "";
  try {
    raw = JSON.stringify(payload.tool_response) || "";
  } catch {
    /* unserializable response — nothing to scan */
  }
  if (lib.WAVE_OFF_RE.test(raw)) {
    lib.appendLedger(root, { session, kind: "waved-off", source: "mechanical", via: "answer" });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    // A dropped ledger line must never cost the tool call.
    process.stderr.write("scribe: observer failed open (" + err.message + ")\n");
  }
  process.exitCode = 0;
}

module.exports = { main };
