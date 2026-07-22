"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runAgent, parse } = require("../lib/claude");

const FAKE = path.join(__dirname, "fixtures", "fake-claude.js").replace(/\\/g, "/");
const FIX = path.join(__dirname, "fixtures");

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
}

function tmpCheckout() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "proof-adapter-"));
}

test("parse: golden success envelope -> ok, cost, turns, response", () => {
  const stdout = fs.readFileSync(path.join(FIX, "golden-success.json"), "utf-8");
  const p = parse({ code: 0, stdout, timedOut: false });
  assert.equal(p.ok, true);
  assert.equal(p.cost, 0.0137);
  assert.equal(p.turns, 3);
  assert.match(p.response, /clamp/);
});

test("parse: golden error envelope -> ok false even though subtype says success", () => {
  const stdout = fs.readFileSync(path.join(FIX, "golden-error.json"), "utf-8");
  const p = parse({ code: 1, stdout, timedOut: false });
  assert.equal(p.ok, false);          // is_error:true is trusted over subtype:"success"
  assert.equal(p.isError, true);
  assert.equal(p.cost, 0);
});

test("parse: malformed JSON -> ok false, empty response", () => {
  const p = parse({ code: 0, stdout: "not json {oops", timedOut: false });
  assert.equal(p.ok, false);
  assert.equal(p.response, "");
});

test("parse: timedOut flag forces ok false even with a clean envelope", () => {
  const stdout = fs.readFileSync(path.join(FIX, "golden-success.json"), "utf-8");
  const p = parse({ code: 0, stdout, timedOut: true });
  assert.equal(p.ok, false);
});

test("runAgent: success path via fake binary", async () => {
  const dir = tmpCheckout();
  await withEnv({ PROOF_CLAUDE_BIN: `node "${FAKE}"`, PROOF_FAKE_MODE: "ok" }, async () => {
    const r = await runAgent("do it", dir, { model: "haiku" });
    assert.equal(r.ok, true);
    assert.equal(r.cost, 0.0123);
    assert.equal(r.turns, 3);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runAgent: non-zero exit -> ok false", async () => {
  const dir = tmpCheckout();
  await withEnv({ PROOF_CLAUDE_BIN: `node "${FAKE}"`, PROOF_FAKE_MODE: "exit1" }, async () => {
    const r = await runAgent("do it", dir, { model: "haiku" });
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 1);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runAgent: is_error envelope -> ok false", async () => {
  const dir = tmpCheckout();
  await withEnv({ PROOF_CLAUDE_BIN: `node "${FAKE}"`, PROOF_FAKE_MODE: "iserror" }, async () => {
    const r = await runAgent("do it", dir, { model: "haiku" });
    assert.equal(r.ok, false);
    assert.equal(r.isError, true);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runAgent: malformed JSON -> ok false", async () => {
  const dir = tmpCheckout();
  await withEnv({ PROOF_CLAUDE_BIN: `node "${FAKE}"`, PROOF_FAKE_MODE: "malformed" }, async () => {
    const r = await runAgent("do it", dir, { model: "haiku" });
    assert.equal(r.ok, false);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runAgent: timeout is killed and reported", async () => {
  const dir = tmpCheckout();
  await withEnv({ PROOF_CLAUDE_BIN: `node "${FAKE}"`, PROOF_FAKE_MODE: "timeout" }, async () => {
    const r = await runAgent("do it", dir, { model: "haiku", timeoutMs: 400 });
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runAgent: editedFiles reflects files the agent wrote", async () => {
  const dir = tmpCheckout();
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# has trigger: list it in docs/api.md.\n");
  await withEnv({ PROOF_CLAUDE_BIN: `node "${FAKE}"`, PROOF_FAKE_MODE: "pipeline" }, async () => {
    const r = await runAgent("implement clamp", dir, { model: "haiku" });
    assert.equal(r.ok, true);
    assert.ok(r.editedFiles.includes("src/num.js"), `got ${JSON.stringify(r.editedFiles)}`);
    assert.ok(r.editedFiles.includes("docs/api.md"), `got ${JSON.stringify(r.editedFiles)}`);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
