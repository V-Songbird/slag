"use strict";

// The review readout: derived passes, the streak and quiet-gate rules, and
// the CLI through its real entry point. The analyze() rules are the tuning
// story's contract — every suggestion names its rule, and these tests pin
// the rules to the constants the output quotes.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const lib = require("../hooks/scribe-lib.js");
const { analyze, STREAK_WAVES, QUIET_JUDGED } = require("../scripts/cli.js");

const CLI = path.join(__dirname, "..", "scripts", "cli.js");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scribe-rev-"));
}

function runCli(root, args) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, env: { ...process.env, SCRIBE_OFF: "" }, encoding: "utf-8",
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status };
}

const judged = (session, extra) => ({ session, kind: "judged", source: "mechanical", bar: "conservative", ...extra });
const asked = (session) => ({ session, kind: "asked", source: "mechanical", count: 1, questions: [{ header: "Meaning", question: "Which?" }], answers: ["Speed (Recommended)"] });
const waved = (session) => ({ session, kind: "waved-off", source: "mechanical", via: "prompt" });

describe("analyze", () => {
  const cfg = lib.defaults();

  test("derived passes: judged rows no round answered", () => {
    const r = analyze([judged("a"), asked("a"), judged("a"), judged("a"), asked("a")], cfg);
    assert.strictEqual(r.totals.judged, 3);
    assert.strictEqual(r.totals.rounds, 2);
    assert.strictEqual(r.totals.passed, 1);
  });

  test("interleaved sessions keep their own pending judgments", () => {
    const r = analyze([judged("a"), judged("b"), asked("a")], cfg);
    assert.strictEqual(r.totals.passed, 1, "only b's judged row passed");
  });

  test("a follow-up round in the same turn is not a second pass", () => {
    const r = analyze([judged("a"), asked("a"), asked("a")], cfg);
    assert.strictEqual(r.totals.passed, 0);
    assert.strictEqual(r.totals.rounds, 2);
  });

  test("capped rows count as capped, never as judged or passed", () => {
    const r = analyze([judged("a", { capped: true })], cfg);
    assert.strictEqual(r.totals.capped, 1);
    assert.strictEqual(r.totals.judged, 0);
    assert.strictEqual(r.totals.passed, 0);
    assert.match(r.suggestions.join(" "), /fatigue cap engaged/);
  });

  test("wave-off streak triggers the bar suggestion, and quotes its rule", () => {
    const rows = [judged("a"), asked("a"), waved("a"), judged("a"), asked("a"), waved("a")];
    const r = analyze(rows, cfg);
    const hit = r.suggestions.find((s) => /wave-off streak/.test(s));
    assert.ok(hit, "expected the streak suggestion");
    assert.match(hit, new RegExp("rule: " + STREAK_WAVES + "\\+"));
  });

  test("no streak suggestion below the threshold", () => {
    const r = analyze([judged("a"), asked("a"), waved("a"), asked("a"), asked("a"), asked("a")], cfg);
    assert.ok(!r.suggestions.some((s) => /wave-off streak/.test(s)));
  });

  test("a quiet gate on the conservative bar earns the standard-bar note", () => {
    const rows = [];
    for (let i = 0; i < QUIET_JUDGED; i++) rows.push(judged("s" + i));
    const r = analyze(rows, cfg);
    assert.ok(r.suggestions.some((s) => /quiet gate/.test(s)));
    const std = analyze(rows, { ...cfg, bar: "standard" });
    assert.ok(!std.suggestions.some((s) => /quiet gate/.test(s)));
  });
});

describe("the cli entry", () => {
  test("review --json reports the totals", () => {
    const root = tmpRoot();
    lib.appendLedger(root, judged("a"));
    lib.appendLedger(root, asked("a"));
    lib.appendLedger(root, judged("a"));
    const r = runCli(root, ["review", "--json"]);
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.deepStrictEqual(out.totals, { judged: 2, capped: 0, rounds: 1, wavedOff: 0, passed: 1 });
    assert.strictEqual(out.sessions, 1);
  });

  test("review prints a readable readout with the recent round", () => {
    const root = tmpRoot();
    lib.appendLedger(root, judged("a"));
    lib.appendLedger(root, asked("a"));
    const r = runCli(root, ["review"]);
    assert.match(r.stdout, /judged 1/);
    assert.match(r.stdout, /Meaning: Which\?/);
    assert.match(r.stdout, /Speed \(Recommended\)/);
  });

  test("an empty project says so instead of inventing zeros", () => {
    const root = tmpRoot();
    const r = runCli(root, ["review"]);
    assert.match(r.stdout, /No ledger yet/);
  });

  test("an unknown command exits 2 with the known list", () => {
    const root = tmpRoot();
    const r = runCli(root, ["nope"]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /unknown command/);
  });
});

describe("memory", () => {
  test("remember, list, forget round-trip through the real cli", () => {
    const root = tmpRoot();
    assert.strictEqual(runCli(root, ["remember", "Improve", "speed, profile first"]).status, 0);
    assert.strictEqual(runCli(root, ["remember", "tests", "node:test only"]).status, 0);
    let out = runCli(root, ["memory", "--json"]);
    assert.deepStrictEqual(JSON.parse(out.stdout),
      { improve: "speed, profile first", tests: "node:test only" });
    assert.strictEqual(runCli(root, ["forget", "improve"]).status, 0);
    out = runCli(root, ["memory", "--json"]);
    assert.deepStrictEqual(JSON.parse(out.stdout), { tests: "node:test only" });
  });

  test("the latest line for a term wins the fold", () => {
    const root = tmpRoot();
    runCli(root, ["remember", "improve", "speed"]);
    runCli(root, ["remember", "improve", "readability"]);
    assert.deepStrictEqual(JSON.parse(runCli(root, ["memory", "--json"]).stdout),
      { improve: "readability" });
  });

  test("remembering after a forget resurrects the term", () => {
    const root = tmpRoot();
    runCli(root, ["remember", "improve", "speed"]);
    runCli(root, ["forget", "improve"]);
    runCli(root, ["remember", "improve", "memory use"]);
    assert.deepStrictEqual(JSON.parse(runCli(root, ["memory", "--json"]).stdout),
      { improve: "memory use" });
  });

  test("forgetting the unremembered exits 1; bad args exit 2", () => {
    const root = tmpRoot();
    assert.strictEqual(runCli(root, ["forget", "nothing"]).status, 1);
    assert.strictEqual(runCli(root, ["remember", "onlyterm"]).status, 2);
    assert.strictEqual(runCli(root, ["forget"]).status, 2);
  });

  test("review lists remembered answers", () => {
    const root = tmpRoot();
    lib.appendLedger(root, judged("a"));
    runCli(root, ["remember", "improve", "speed"]);
    const r = runCli(root, ["review"]);
    assert.match(r.stdout, /Remembered answers/);
    assert.match(r.stdout, /improve = speed/);
  });

  test("memory lines carry the v1 schema fields", () => {
    const root = tmpRoot();
    runCli(root, ["remember", "improve", "speed"]);
    const line = JSON.parse(fs.readFileSync(path.join(root, ".scribe", "memory.jsonl"), "utf-8").trim());
    assert.strictEqual(line.schemaVersion, 1);
    assert.ok(line.ts);
    assert.strictEqual(line.term, "improve");
  });
});
