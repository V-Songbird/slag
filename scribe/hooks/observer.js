#!/usr/bin/env node
"use strict";

// scribe — PostToolUse observer on AskUserQuestion.
//
// Asks are tool calls a hook can see, which makes the "asked" half of the
// ledger hard evidence rather than a self-report (unknowns pass, finding 6).
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
  const root = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  if (lib.isOff(root)) return;

  const session = typeof payload.session_id === "string" ? payload.session_id : null;
  const input = lib.isObject(payload.tool_input) ? payload.tool_input : {};
  const questions = Array.isArray(input.questions)
    ? input.questions.filter(lib.isObject).map((q) => ({
        header: typeof q.header === "string" ? q.header : null,
        question: typeof q.question === "string" ? q.question.slice(0, lib.QUESTION_KEEP) : null,
      }))
    : [];

  lib.appendLedger(root, {
    session, kind: "asked", source: "mechanical",
    count: questions.length, questions,
  });

  let answers = "";
  try {
    answers = JSON.stringify(payload.tool_response) || "";
  } catch {
    /* unserializable response — nothing to scan */
  }
  if (lib.WAVE_OFF_RE.test(answers)) {
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
