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
const {
  analyze, STREAK_WINDOW, STREAK_WAVES, QUIET_JUDGED, QUIET_PASS_RATE,
  OFFMENU_WINDOW, OFFMENU_ROUNDS,
} = require("../scripts/cli.js");

const CLI = path.join(__dirname, "..", "scripts", "cli.js");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scribe-rev-"));
}

function runCli(root, args) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, env: { ...process.env, SCRIBE_OFF: "", CLAUDE_PROJECT_DIR: root }, encoding: "utf-8",
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status };
}

const judged = (session, extra) => ({ session, kind: "judged", source: "mechanical", bar: "conservative", ...extra });
const asked = (session) => ({ session, kind: "asked", source: "mechanical", count: 1, questions: [{ header: "Meaning", question: "Which?" }], answers: ["Speed (Recommended)"] });
const waved = (session) => ({ session, kind: "waved-off", source: "mechanical", via: "prompt" });
// A round that recorded what it offered, and what the user settled on.
const round = (session, answers, options) => ({
  session, kind: "asked", source: "mechanical", count: 1,
  questions: [{ header: "Meaning", question: "Which?", options: options || ["Speed", "Readability"] }],
  answers,
});

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
    // Every suggestion quotes the rule that produced it, so the quoted window
    // has to be the window the rule actually used.
    assert.match(hit, new RegExp("last " + STREAK_WINDOW + "\\)"));
  });

  test("no streak suggestion below the threshold", () => {
    const r = analyze([judged("a"), asked("a"), waved("a"), asked("a"), asked("a"), asked("a")], cfg);
    assert.ok(!r.suggestions.some((s) => /wave-off streak/.test(s)));
  });

  // A ledger of `n` one-prompt sessions, the first `answered` of which got a
  // round. Every other judged row is a derived pass, so the pass-through rate
  // is exactly (n - answered) / n.
  function atRate(n, answered) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push(judged("s" + i));
      if (i < answered) rows.push(asked("s" + i));
    }
    return rows;
  }

  test("a quiet gate is reported on either bar, with the remedy that fits it", () => {
    const rows = atRate(QUIET_JUDGED, 0);

    const con = analyze(rows, { ...cfg, bar: "conservative" }).suggestions.find((s) => /quiet gate/.test(s));
    assert.ok(con, "the conservative bar earns the quiet-gate note");
    assert.match(con, /"bar": "standard"/, "and its remedy is the eager bar");

    // The default bar is the eager one, so there is no bar left to raise — but
    // silence still has to be reported, or the tuning story is one-directional.
    const std = analyze(rows, cfg).suggestions.find((s) => /quiet gate/.test(s));
    assert.ok(std, "the default bar earns it too");
    assert.doesNotMatch(std, /"bar": "standard"/, "it must not suggest the bar already in force");
    assert.match(std, /not landing/, "its remedy points at the install, not the bar");
    assert.match(std, /never asked here/, "zero rounds is still called out by name");
    assert.match(
      std,
      new RegExp("rule: " + QUIET_JUDGED + "\\+ judged, " + Math.round(QUIET_PASS_RATE * 100) + "%\\+ passing"),
      "both constants are quoted verbatim",
    );
  });

  // The defect this rule was rewritten for: a gate that asks sometimes reads as
  // healthy to a rule that only knows total silence. One real project sat at
  // 89% pass-through with seventeen rounds behind it and earned no note at all.
  test("a gate that asks, but rarely, still earns the note", () => {
    const rows = atRate(QUIET_JUDGED, 3); // 17 of 20 pass — exactly the floor
    const hit = analyze(rows, cfg).suggestions.find((s) => /quiet gate/.test(s));
    assert.ok(hit, "asking a few times must not buy silence from the rule");
    assert.match(hit, /17 of 20 judged prompts passed through, 85%/);
    assert.doesNotMatch(hit, /never asked here/, "it has asked, so that clause stays off");
  });

  test("a gate asking often enough stays quiet", () => {
    const rows = atRate(QUIET_JUDGED, 4); // 16 of 20 pass — under the floor
    assert.ok(!analyze(rows, cfg).suggestions.some((s) => /quiet gate/.test(s)));
  });

  test("too few judged prompts is a quiet week, not a quiet gate", () => {
    const rows = atRate(QUIET_JUDGED - 1, 0);
    assert.ok(!analyze(rows, cfg).suggestions.some((s) => /quiet gate/.test(s)));
  });

  test("answers nobody offered earn the option-quality note, and it never blames the bar", () => {
    const rows = [];
    for (let i = 0; i < OFFMENU_ROUNDS; i++) rows.push(round("s", ["something else entirely " + i]));
    const hit = analyze(rows, cfg).suggestions.find((s) => /off-menu answers/.test(s));
    assert.ok(hit, "expected the off-menu suggestion");
    assert.match(hit, new RegExp("rule: " + OFFMENU_ROUNDS + "\\+ in the last " + OFFMENU_WINDOW));
    assert.match(hit, /option-crafting/, "the remedy is the options");
    assert.doesNotMatch(hit, /"bar"/, "it must never propose a bar change");
  });

  test("a picked option is on the menu, however it was truncated", () => {
    const rows = [];
    for (let i = 0; i < OFFMENU_ROUNDS + 2; i++) {
      rows.push(round("s", ["Speed (Recommended)"], ["Speed (Recommended) — it is called in a hot loop", "Readability"]));
    }
    assert.ok(!analyze(rows, cfg).suggestions.some((s) => /off-menu/.test(s)));
  });

  test("rounds recorded before option labels existed are not evidence", () => {
    const rows = [];
    for (let i = 0; i < OFFMENU_ROUNDS + 3; i++) rows.push(asked("s"));
    assert.ok(!analyze(rows, cfg).suggestions.some((s) => /off-menu/.test(s)));
  });

  test("below the threshold the note stays quiet", () => {
    const rows = [round("s", ["typed my own"]), round("s", ["Speed"])];
    assert.ok(!analyze(rows, cfg).suggestions.some((s) => /off-menu/.test(s)));
  });

  test("the fatigue note never names a cap that is not set", () => {
    const capped = [judged("a", { capped: true })];

    const off = analyze(capped, { ...cfg, fatigueCap: 0 }).suggestions.find((s) => /fatigue cap/.test(s));
    assert.ok(off);
    assert.doesNotMatch(off, /after 0 rounds/, "the 1.1.0 default must not print a cap of 0");
    assert.match(off, /historical rows/, "with the cap off, the rows are history");

    const on = analyze(capped, { ...cfg, fatigueCap: 3 }).suggestions.find((s) => /fatigue cap/.test(s));
    assert.match(on, /Raise "fatigueCap"/, "with a cap set, raising it is the live advice");
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

  test("a meaning is an answer, not a rulebook — length is capped", () => {
    const root = tmpRoot();
    const r = runCli(root, ["remember", "improve", "x".repeat(200)]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /keep it short/);
    assert.deepStrictEqual(JSON.parse(runCli(root, ["memory", "--json"]).stdout), {});
  });

  test("a term is a term, not a rulebook either — its length is capped too", () => {
    // Both halves are capped in the same guard; only the meaning half was
    // covered, which left the term as an open door to the same abuse.
    const root = tmpRoot();
    const r = runCli(root, ["remember", "y".repeat(100), "speed"]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /keep it short/);
    assert.deepStrictEqual(JSON.parse(runCli(root, ["memory", "--json"]).stdout), {});
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
