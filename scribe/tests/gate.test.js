"use strict";

// Every stand-down path is exercised by piping a synthetic prompt through the
// REAL hook — a spawned node process reading stdin — because the stand-downs
// are the product's silence contract and a unit test of an inner function
// would not notice a broken entry point (release gate, SCOPE.md).

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const lib = require("../hooks/scribe-lib.js");

const GATE = path.join(__dirname, "..", "hooks", "gate.js");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scribe-gate-"));
}

// Spawn the real hook: payload on stdin, project root as cwd. Returns what the
// host would see — stdout, stderr, exit status — plus the ledger left behind.
function runGate(root, payload, env) {
  const res = spawnSync(process.execPath, [GATE], {
    cwd: root,
    input: JSON.stringify({ cwd: root, hook_event_name: "UserPromptSubmit", ...payload }),
    env: { ...process.env, SCRIBE_OFF: "", ...env },
    encoding: "utf-8",
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status, ledger: lib.readLedger(root) };
}

const AMBIGUOUS = { session_id: "s1", prompt: "improve the function" };

describe("stand-downs (silent, no ledger)", () => {
  test("SCRIBE_OFF=1 exits with nothing", () => {
    const root = tmpRoot();
    const r = runGate(root, AMBIGUOUS, { SCRIBE_OFF: "1" });
    assert.strictEqual(r.stdout, "");
    assert.strictEqual(r.ledger.length, 0);
  });

  test(".scribe/off exits with nothing", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, ".scribe"));
    fs.writeFileSync(path.join(root, ".scribe", "off"), "");
    const r = runGate(root, AMBIGUOUS);
    assert.strictEqual(r.stdout, "");
    assert.strictEqual(r.ledger.length, 0);
  });

  test("config off:true exits with nothing", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, ".scribe"));
    fs.writeFileSync(path.join(root, ".scribe", "config.json"),
      JSON.stringify({ schemaVersion: 1, off: true }));
    const r = runGate(root, AMBIGUOUS);
    assert.strictEqual(r.stdout, "");
    assert.strictEqual(r.ledger.length, 0);
  });

  test("slash command exits with nothing", () => {
    const root = tmpRoot();
    const r = runGate(root, { session_id: "s1", prompt: "/compact keep the task" });
    assert.strictEqual(r.stdout, "");
    assert.strictEqual(r.ledger.length, 0);
  });

  test("empty prompt exits with nothing", () => {
    const root = tmpRoot();
    const r = runGate(root, { session_id: "s1", prompt: "   " });
    assert.strictEqual(r.stdout, "");
    assert.strictEqual(r.ledger.length, 0);
  });

  test("bypassPermissions (unattended) exits with nothing", () => {
    const root = tmpRoot();
    const r = runGate(root, { ...AMBIGUOUS, permission_mode: "bypassPermissions" });
    assert.strictEqual(r.stdout, "");
    assert.strictEqual(r.ledger.length, 0);
  });

  test("garbage stdin exits with nothing and status 0", () => {
    const root = tmpRoot();
    const res = spawnSync(process.execPath, [GATE], {
      cwd: root, input: "not json", env: { ...process.env, SCRIBE_OFF: "" }, encoding: "utf-8",
    });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout, "");
  });
});

describe("the judged path", () => {
  test("a plain prompt gets the rubric and a judged line", () => {
    const root = tmpRoot();
    const r = runGate(root, AMBIGUOUS);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.strictEqual(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(ctx, /\[scribe\]/);
    assert.match(ctx, /scribe:clarify/);
    assert.match(ctx, /\(Recommended\)/);
    assert.strictEqual(r.ledger.length, 1);
    const row = r.ledger[0];
    assert.strictEqual(row.schemaVersion, 1);
    assert.strictEqual(row.kind, "judged");
    assert.strictEqual(row.source, "mechanical");
    assert.strictEqual(row.session, "s1");
    assert.strictEqual(row.bar, "conservative");
    assert.strictEqual(row.prompt, "improve the function");
    assert.ok(row.ts);
  });

  test("the judged prompt is truncated, never stored whole", () => {
    const root = tmpRoot();
    const long = "improve ".repeat(100);
    const r = runGate(root, { session_id: "s1", prompt: long });
    assert.strictEqual(r.ledger[0].prompt.length, lib.PROMPT_KEEP);
  });

  test("config bar standard changes the rubric line and the ledger", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, ".scribe"));
    fs.writeFileSync(path.join(root, ".scribe", "config.json"),
      JSON.stringify({ schemaVersion: 1, bar: "standard" }));
    const r = runGate(root, AMBIGUOUS);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /genuinely torn/);
    assert.strictEqual(r.ledger[0].bar, "standard");
  });

  test("both bars stay under the byte cap, envelope included", () => {
    for (const bar of lib.BARS) {
      const bytes = Buffer.byteLength(lib.emission(bar), "utf-8");
      assert.ok(bytes <= lib.RUBRIC_CAP, bar + " emission is " + bytes + " bytes, cap " + lib.RUBRIC_CAP);
    }
  });
});

describe("fail-open config", () => {
  test("invalid JSON warns on stderr and still judges at defaults", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, ".scribe"));
    fs.writeFileSync(path.join(root, ".scribe", "config.json"), "{nope");
    const r = runGate(root, AMBIGUOUS);
    assert.match(r.stderr, /scribe: .*not valid JSON.*using defaults/);
    assert.strictEqual(r.ledger[0].bar, "conservative");
    assert.ok(r.stdout.length > 0);
  });

  test("unknown bar warns and falls back to conservative", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, ".scribe"));
    fs.writeFileSync(path.join(root, ".scribe", "config.json"),
      JSON.stringify({ schemaVersion: 1, bar: "aggressive" }));
    const r = runGate(root, AMBIGUOUS);
    assert.match(r.stderr, /unknown bar/);
    assert.strictEqual(r.ledger[0].bar, "conservative");
  });

  test("a future schemaVersion is refused into defaults, not half-read", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, ".scribe"));
    fs.writeFileSync(path.join(root, ".scribe", "config.json"),
      JSON.stringify({ schemaVersion: 2, bar: "standard", off: true }));
    const r = runGate(root, AMBIGUOUS);
    assert.match(r.stderr, /schemaVersion/);
    assert.strictEqual(r.ledger[0].bar, "conservative");
    assert.ok(r.stdout.length > 0, "off:true from a future schema must not be honored");
  });
});

describe("wave-off and fatigue", () => {
  function seedAsks(root, session, n) {
    for (let i = 0; i < n; i++) {
      lib.appendLedger(root, { session, kind: "asked", source: "mechanical", count: 1, questions: [] });
    }
  }

  test("a wave-off prompt after an ask logs waved-off and stays silent", () => {
    const root = tmpRoot();
    seedAsks(root, "s1", 1);
    const r = runGate(root, { session_id: "s1", prompt: "just do it already" });
    assert.strictEqual(r.stdout, "");
    const last = r.ledger[r.ledger.length - 1];
    assert.strictEqual(last.kind, "waved-off");
    assert.strictEqual(last.via, "prompt");
    assert.strictEqual(last.source, "mechanical");
  });

  test("a wave-off phrase with no prior ask is judged normally", () => {
    const root = tmpRoot();
    const r = runGate(root, { session_id: "s1", prompt: "just do it: rename the module" });
    assert.ok(r.stdout.length > 0);
    assert.strictEqual(r.ledger[0].kind, "judged");
  });

  test("another session's asks do not trigger this session's wave-off", () => {
    const root = tmpRoot();
    seedAsks(root, "other", 2);
    const r = runGate(root, { session_id: "s1", prompt: "just do it" });
    assert.ok(r.stdout.length > 0);
  });

  test("the fatigue cap stands the gate down and logs the decision", () => {
    const root = tmpRoot();
    seedAsks(root, "s1", lib.DEFAULT_FATIGUE_CAP);
    const r = runGate(root, AMBIGUOUS);
    assert.strictEqual(r.stdout, "");
    const last = r.ledger[r.ledger.length - 1];
    assert.strictEqual(last.kind, "judged");
    assert.strictEqual(last.capped, true);
  });

  test("fatigueCap 0 disables the cap", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, ".scribe"));
    fs.writeFileSync(path.join(root, ".scribe", "config.json"),
      JSON.stringify({ schemaVersion: 1, fatigueCap: 0 }));
    seedAsks(root, "s1", 10);
    const r = runGate(root, AMBIGUOUS);
    assert.ok(r.stdout.length > 0);
  });
});
