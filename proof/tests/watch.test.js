"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  saveFingerprint, checkFingerprint, readFingerprint, readStore,
  driftVerdict, falseAlarmRate, rateCI, nagLines, fpDir, keyOf,
} = require("../lib/watch");
const { lcg } = require("../lib/stats");

const FAKE = path.join(__dirname, "fixtures", "fake-claude.js").replace(/\\/g, "/");

// A single-arm probe the offline fake can drive: the fake writes docs/api.md
// only when CLAUDE.md carries the "list it in docs/api.md" duty, so the good
// probe fires every run and the damaged probe (same id, duty removed) never does.
function goodProbe() {
  return {
    id: "watch-offline-probe",
    claudeMd: "# Notes\n\nWhen you add a function, list it in docs/api.md.\n",
    fixture: {},
    arms: { probe: null },
    task: {
      prompt: "Add a clamp function.",
      valid: [{ type: "file_exists", path: "src/num.js" }],
      assert: [{ type: "file_exists", path: "docs/api.md" }],
    },
    reps: 4, seed: 42,
  };
}
function damagedProbe() {
  return { ...goodProbe(), claudeMd: "# Notes\n\nSmall internal utility.\n" };
}

function withFake(fn) {
  return async () => {
    const saved = { bin: process.env.PROOF_CLAUDE_BIN, mode: process.env.PROOF_FAKE_MODE };
    process.env.PROOF_CLAUDE_BIN = `node "${FAKE}"`;
    process.env.PROOF_FAKE_MODE = "pipeline";
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "proof-fp-"));
    try { await fn(store); }
    finally {
      if (saved.bin === undefined) delete process.env.PROOF_CLAUDE_BIN; else process.env.PROOF_CLAUDE_BIN = saved.bin;
      if (saved.mode === undefined) delete process.env.PROOF_FAKE_MODE; else process.env.PROOF_FAKE_MODE = saved.mode;
      fs.rmSync(store, { recursive: true, force: true });
    }
  };
}

test("driftVerdict flags only outside the inclusive baseline CI", () => {
  const fp = { ci: [0.6, 1.0], rate: 0.8 };
  assert.equal(driftVerdict(fp, 0.6).drift, false, "on the lower bound is not drift");
  assert.equal(driftVerdict(fp, 1.0).drift, false, "on the upper bound is not drift");
  assert.equal(driftVerdict(fp, 0.8).drift, false, "inside is not drift");
  const d = driftVerdict(fp, 0.59);
  assert.equal(d.drift, true);
  assert.equal(d.direction, "down");
  const u = driftVerdict({ ci: [0.0, 0.4], rate: 0.2 }, 0.5);
  assert.equal(u.drift, true);
  assert.equal(u.direction, "up");
});

test("nagLines is silent when nothing changed, one line when it did", () => {
  const cur = { agent: "claude", version: "2.1.0", model: "haiku" };
  const same = [{ probeId: "p", agent: "claude", version: "2.1.0", model: "haiku" }];
  assert.deepEqual(nagLines(same, cur), []);
  assert.deepEqual(nagLines([], cur), []);
  const newVer = [{ probeId: "p", agent: "claude", version: "2.0.0", model: "haiku" }];
  assert.equal(nagLines(newVer, cur).length, 1);
  const newModel = [{ probeId: "p", agent: "claude", version: "2.1.0", model: "sonnet" }];
  assert.equal(nagLines(newModel, cur).length, 1);
  // multiple probes, one due => still one line naming the count
  const mixed = [
    { probeId: "a", agent: "claude", version: "2.1.0", model: "haiku" },
    { probeId: "b", agent: "claude", version: "2.0.0", model: "haiku" },
  ];
  assert.equal(nagLines(mixed, cur).length, 1);
});

test("rateCI is Laplace-smoothed so a saturated sample is not a false-precise point", () => {
  // Raw bootstrap of 8/8 collapses to [1,1]; the smoothed band must open below 1.
  const [lo, hi] = rateCI([1, 1, 1, 1, 1, 1, 1, 1], lcg(1));
  assert.ok(lo < 1, `smoothed lower bound should drop below 1, got ${lo}`);
  assert.ok(hi <= 1);
  assert.deepEqual(rateCI([], lcg(1)), [null, null]);
  // rawCI:true skips smoothing (opt-out for a genuinely large, spread sample).
  assert.deepEqual(rateCI([1, 1, 1, 1], lcg(1), { rawCI: true }), [1, 1]);
});

test("falseAlarmRate counts resamples that fall outside the detector's band", () => {
  assert.equal(falseAlarmRate([1, 1, 1, 1], [1, 1], lcg(1), { rounds: 500 }), 0);
  assert.equal(falseAlarmRate([0, 0, 0, 0], [0, 0], lcg(1), { rounds: 500 }), 0);
  // Wider band admits more of the spread => lower false-alarm rate.
  const tight = falseAlarmRate([1, 1, 1, 0, 0], [0.5, 1], lcg(3), { rounds: 1000 });
  const wide = falseAlarmRate([1, 1, 1, 0, 0], [0, 1], lcg(3), { rounds: 1000 });
  assert.ok(tight >= wide, `tighter band should not false-alarm less (${tight} vs ${wide})`);
  assert.ok(tight >= 0 && tight <= 1);
  assert.equal(falseAlarmRate([], [0, 1], lcg(1)), null);
  assert.equal(falseAlarmRate([1, 0], null, lcg(1)), null);
});

test("store round-trip: saved fingerprint reads back identically", withFake(async (store) => {
  const spec = goodProbe();
  const env = { version: "test-v1", model: "haiku" };
  const { fingerprint } = await saveFingerprint(spec, { store, reps: 4, ...env, out: path.join(store, "save") });
  const file = path.join(fpDir({ store }), keyOf({ agent: "claude", model: "haiku", probeId: spec.id }) + ".json");
  assert.ok(fs.existsSync(file), "fingerprint file written to the store");
  const back = readFingerprint(spec.id, { agent: "claude", model: "haiku" }, { store });
  assert.deepEqual(back, fingerprint);
  assert.equal(back.rate, 1, "good probe fires every run under the fake");
  assert.ok(back.ci[0] < 1 && back.ci[1] <= 1, "smoothed baseline band is not a false-precise point");
  assert.equal(readStore({ store }).length, 1);
}));

test("check: unchanged probe does not drift; damaged probe drifts down", withFake(async (store) => {
  const env = { version: "test-v1", model: "haiku" };
  await saveFingerprint(goodProbe(), { store, reps: 4, ...env, out: path.join(store, "save") });

  const same = await checkFingerprint(goodProbe(), { store, reps: 4, ...env, out: path.join(store, "check-same") });
  assert.equal(same.verdict.drift, false, "no-change control must not flag");
  assert.equal(same.verdict.freshRate, 1);

  const damaged = await checkFingerprint(damagedProbe(), { store, reps: 4, ...env, out: path.join(store, "check-damaged") });
  assert.equal(damaged.verdict.drift, true, "a killed behavior must flag drift");
  assert.equal(damaged.verdict.direction, "down");
  assert.equal(damaged.verdict.freshRate, 0);
}));
