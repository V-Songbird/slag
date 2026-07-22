"use strict";

// The one test that costs money. Self-skips unless PROOF_LIVE=1, so the default
// suite is free and offline. When enabled it runs the gold A/B against the real
// `claude` binary at a tiny N and asserts the verdict lands on the same side of
// zero as the reference (treatment lifts a distant-file duty over no rule).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { run, analyze } = require("../lib/runner");

const LIVE = process.env.PROOF_LIVE === "1";

test("live gold-cell reproduction (PROOF_LIVE=1)", { skip: !LIVE ? "set PROOF_LIVE=1 to run (spends real API budget)" : false }, async () => {
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "gold-trigger-docs-sync.json"), "utf-8"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "proof-live-"));
  const reps = Number(process.env.PROOF_LIVE_REPS || 3);
  await run(spec, { out, reps, seed: 42, concurrency: 2 });
  const analysis = analyze(spec, path.join(out, "cells"), { reps, seed: 42 });
  assert.ok(analysis.usable > 0, "expected at least one usable cell");
  const t = analysis.arms.treatment;
  assert.ok(t.lift > 0, `expected positive lift (same side as gold), got ${t.lift}`);
  fs.rmSync(out, { recursive: true, force: true });
});
