"use strict";

// The observer through the real entry point, plus the ledger schema both hooks
// share. The asked/waved-off lines here are the hard-evidence half of the
// ledger — the conflation guard asserts every line names its source.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const lib = require("../hooks/scribe-lib.js");

const OBSERVER = path.join(__dirname, "..", "hooks", "observer.js");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scribe-obs-"));
}

function runObserver(root, payload, env) {
  const res = spawnSync(process.execPath, [OBSERVER], {
    cwd: root,
    input: JSON.stringify({ cwd: root, hook_event_name: "PostToolUse", ...payload }),
    env: { ...process.env, SCRIBE_OFF: "", ...env },
    encoding: "utf-8",
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status, ledger: lib.readLedger(root) };
}

const ASK = {
  session_id: "s1",
  tool_name: "AskUserQuestion",
  tool_input: {
    questions: [
      {
        question: "\"Improve\" could go several ways here. Which did you mean?",
        header: "Meaning",
        options: [{ label: "Speed (Recommended)" }, { label: "Readability" }],
        multiSelect: false,
      },
    ],
  },
  tool_response: { answers: { Meaning: "Speed (Recommended)" } },
};

describe("observer", () => {
  test("an ask becomes one mechanical ledger line with the round's shape", () => {
    const root = tmpRoot();
    const r = runObserver(root, ASK);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.ledger.length, 1);
    const row = r.ledger[0];
    assert.strictEqual(row.schemaVersion, 1);
    assert.strictEqual(row.kind, "asked");
    assert.strictEqual(row.source, "mechanical");
    assert.strictEqual(row.session, "s1");
    assert.strictEqual(row.count, 1);
    assert.strictEqual(row.questions[0].header, "Meaning");
    assert.match(row.questions[0].question, /Improve/);
    assert.ok(row.answers.includes("Speed (Recommended)"), "the picked answer is harvested");
    assert.ok(row.ts);
  });

  test("the offered option labels are recorded with their question", () => {
    // Without them an answer cannot be told from an answer nobody offered,
    // which is the one thing the review has no other way to see.
    const root = tmpRoot();
    const row = runObserver(root, ASK).ledger[0];
    assert.deepStrictEqual(row.questions[0].options, ["Speed (Recommended)", "Readability"]);
  });

  test("option labels are truncated and junk entries dropped", () => {
    const root = tmpRoot();
    const messy = {
      ...ASK,
      tool_input: {
        questions: [{
          header: "H", question: "Q",
          options: [{ label: "x".repeat(200) }, { label: "  " }, { notALabel: 1 }, "a string"],
        }],
      },
    };
    const row = runObserver(root, messy).ledger[0];
    assert.strictEqual(row.questions[0].options.length, 1);
    assert.strictEqual(row.questions[0].options[0].length, lib.OPTION_KEEP);
  });

  test("a question with no options records an empty list, never undefined", () => {
    const root = tmpRoot();
    const bare = { ...ASK, tool_input: { questions: [{ header: "H", question: "Q" }] } };
    assert.deepStrictEqual(runObserver(root, bare).ledger[0].questions[0].options, []);
  });

  test("the round's own questions never land in the answers", () => {
    // The host echoes each question and header back inside the response. Those
    // would fill every answer slot before a real pick arrived, which is what
    // the review readout and the remembered-answer match both read.
    const root = tmpRoot();
    const echoed = {
      ...ASK,
      tool_input: {
        questions: [
          { header: "Meaning", question: "Which did you mean?", options: [{ label: "Speed (Recommended)" }] },
          { header: "Scope", question: "How far should this go?", options: [{ label: "This call site" }] },
        ],
      },
      tool_response: {
        answers: [
          { question: "Which did you mean?", header: "Meaning", answer: "Speed (Recommended)" },
          { question: "How far should this go?", header: "Scope", answer: "This call site" },
        ],
      },
    };
    const row = runObserver(root, echoed).ledger[0];
    assert.deepStrictEqual(row.answers, ["Speed (Recommended)", "This call site"]);
  });

  test("question text is truncated to the keep limit", () => {
    const root = tmpRoot();
    const long = { ...ASK, tool_input: { questions: [{ question: "x".repeat(500), header: "H" }] } };
    const r = runObserver(root, long);
    assert.strictEqual(r.ledger[0].questions[0].question.length, lib.QUESTION_KEEP);
  });

  test("a wave-off typed into the answers gets its own line", () => {
    const root = tmpRoot();
    const waved = { ...ASK, tool_response: { answers: { Meaning: "just do it, stop asking" } } };
    const r = runObserver(root, waved);
    assert.strictEqual(r.ledger.length, 2);
    assert.strictEqual(r.ledger[1].kind, "waved-off");
    assert.strictEqual(r.ledger[1].via, "answer");
    assert.strictEqual(r.ledger[1].source, "mechanical");
  });

  test("another tool's event writes nothing", () => {
    const root = tmpRoot();
    const r = runObserver(root, { ...ASK, tool_name: "Bash" });
    assert.strictEqual(r.ledger.length, 0);
  });

  test("the kill switch silences the observer too", () => {
    const root = tmpRoot();
    const r = runObserver(root, ASK, { SCRIBE_OFF: "1" });
    assert.strictEqual(r.ledger.length, 0);
  });

  test("a malformed round still logs the ask, defensively", () => {
    const root = tmpRoot();
    const r = runObserver(root, { ...ASK, tool_input: { questions: "not an array" }, tool_response: null });
    assert.strictEqual(r.ledger.length, 1);
    assert.strictEqual(r.ledger[0].count, 0);
  });
});

describe("ledger mechanics", () => {
  test("appendLedger creates .scribe on first write", () => {
    const root = tmpRoot();
    lib.appendLedger(root, { session: "s1", kind: "judged", source: "mechanical" });
    assert.ok(fs.existsSync(path.join(root, ".scribe", "ledger.jsonl")));
  });

  test("readLedger skips torn lines instead of dying", () => {
    const root = tmpRoot();
    lib.appendLedger(root, { session: "s1", kind: "judged", source: "mechanical" });
    fs.appendFileSync(path.join(root, ".scribe", "ledger.jsonl"), "{torn\n");
    lib.appendLedger(root, { session: "s1", kind: "asked", source: "mechanical" });
    assert.strictEqual(lib.readLedger(root).length, 2);
  });

  test("askedCount counts only this session's rounds", () => {
    const root = tmpRoot();
    lib.appendLedger(root, { session: "a", kind: "asked", source: "mechanical" });
    lib.appendLedger(root, { session: "a", kind: "judged", source: "mechanical" });
    lib.appendLedger(root, { session: "b", kind: "asked", source: "mechanical" });
    assert.strictEqual(lib.askedCount(root, "a"), 1);
    assert.strictEqual(lib.askedCount(root, "missing"), 0);
    assert.strictEqual(lib.askedCount(root, null), 0);
  });

  test("conflation guard: every line a hook writes names a mechanical source", () => {
    const root = tmpRoot();
    runObserver(root, ASK);
    lib.appendLedger(root, { session: "s1", kind: "judged", source: "mechanical" });
    for (const row of lib.readLedger(root)) {
      assert.strictEqual(row.source, "mechanical");
      assert.ok(["judged", "asked", "waved-off"].includes(row.kind));
    }
  });
});
