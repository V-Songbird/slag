"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildCells, run, analyze } = require("../lib/runner");
const { renderReport } = require("../lib/report");

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "gold-trigger-docs-sync.json"), "utf-8"));
const FAKE = path.join(__dirname, "fixtures", "fake-claude.js").replace(/\\/g, "/");

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "proof-run-"));
}

test("buildCells is a deterministic shuffled arms×reps cross", () => {
  const a = buildCells(SPEC, { reps: 4, seed: 42 });
  assert.equal(a.length, 2 * 4);
  assert.deepEqual(a, buildCells(SPEC, { reps: 4, seed: 42 }));
  assert.notDeepEqual(a, buildCells(SPEC, { reps: 4, seed: 7 }));
});

test("end-to-end offline: baseline 0, treatment 1, verdict CONFIRMED+ (pipeline fake)", async () => {
  const out = outDir();
  const saved = { bin: process.env.PROOF_CLAUDE_BIN, mode: process.env.PROOF_FAKE_MODE };
  process.env.PROOF_CLAUDE_BIN = `node "${FAKE}"`;
  process.env.PROOF_FAKE_MODE = "pipeline";
  try {
    await run(SPEC, { out, reps: 4, seed: 42, concurrency: 2 });
    const analysis = analyze(SPEC, path.join(out, "cells"), { reps: 4, seed: 42 });
    assert.equal(analysis.usable, 8);
    assert.equal(analysis.arms.baseline.mean, 0);
    assert.equal(analysis.arms.treatment.mean, 1);
    assert.equal(analysis.arms.treatment.lift, 1);
    assert.equal(analysis.arms.treatment.verdict, "CONFIRMED+");
    assert.ok(analysis.arms.treatment.ci[0] > 0);
    // report renders without throwing and mentions the verdict
    assert.match(renderReport(analysis), /CONFIRMED\+/);
  } finally {
    if (saved.bin === undefined) delete process.env.PROOF_CLAUDE_BIN; else process.env.PROOF_CLAUDE_BIN = saved.bin;
    if (saved.mode === undefined) delete process.env.PROOF_FAKE_MODE; else process.env.PROOF_FAKE_MODE = saved.mode;
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("resume skips cells already on disk", async () => {
  const out = outDir();
  const saved = { bin: process.env.PROOF_CLAUDE_BIN, mode: process.env.PROOF_FAKE_MODE };
  process.env.PROOF_CLAUDE_BIN = `node "${FAKE}"`;
  process.env.PROOF_FAKE_MODE = "pipeline";
  try {
    await run(SPEC, { out, reps: 2, seed: 42 });
    const first = fs.readdirSync(path.join(out, "cells")).length;
    assert.equal(first, 4);
    let ran = 0;
    await run(SPEC, { out, reps: 2, seed: 42, resume: true, onCell: () => ran++ });
    assert.equal(ran, 0, "resume should re-run nothing");
    assert.equal(fs.readdirSync(path.join(out, "cells")).length, 4);
  } finally {
    if (saved.bin === undefined) delete process.env.PROOF_CLAUDE_BIN; else process.env.PROOF_CLAUDE_BIN = saved.bin;
    if (saved.mode === undefined) delete process.env.PROOF_FAKE_MODE; else process.env.PROOF_FAKE_MODE = saved.mode;
    fs.rmSync(out, { recursive: true, force: true });
  }
});
