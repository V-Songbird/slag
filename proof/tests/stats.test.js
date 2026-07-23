"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { lcg, mean, bootstrapLiftCI, bootstrapRateCI, verdictFor } = require("../lib/stats");

test("verdictFor maps a CI to the four-way verdict", () => {
  assert.equal(verdictFor(0.2, 0.8), "CONFIRMED+");
  assert.equal(verdictFor(-0.8, -0.2), "CONFIRMED-");
  assert.equal(verdictFor(-0.05, 0.05), "NULL");   // tight around zero
  assert.equal(verdictFor(-0.3, 0.4), "INCONCLUSIVE"); // wide, straddles zero
});

test("bootstrap CI is exact at the extremes (seeded)", () => {
  const rand = lcg(1);
  const [lo, hi] = bootstrapLiftCI([1, 1, 1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0, 0, 0], rand);
  assert.equal(lo, 1);
  assert.equal(hi, 1);
});

test("no shift (identical constant arms) => CI [0,0] => NULL", () => {
  const rand = lcg(7);
  const x = [1, 1, 1, 1, 1, 1, 1, 1];
  const [lo, hi] = bootstrapLiftCI(x, x, rand);
  assert.equal(lo, 0);
  assert.equal(hi, 0);
  assert.equal(verdictFor(lo, hi), "NULL");
});

test("clean +0.8 shift => CONFIRMED+ with CI above zero (seeded, deterministic)", () => {
  const rand = lcg(42);
  const treat = [1, 1, 1, 1, 1, 1, 1, 1, 0, 0]; // mean 0.8
  const base = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];  // mean 0.0
  const [lo, hi] = bootstrapLiftCI(treat, base, rand);
  assert.ok(lo > 0, `expected lo>0, got ${lo}`);
  assert.equal(verdictFor(lo, hi), "CONFIRMED+");
  // determinism: same seed, same numbers
  assert.deepEqual([lo, hi], bootstrapLiftCI(treat, base, lcg(42)));
});

test("clean -0.8 shift => CONFIRMED-", () => {
  const rand = lcg(42);
  const [lo, hi] = bootstrapLiftCI([0, 0, 0, 0, 0, 0, 0, 0, 1, 1], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], rand);
  assert.ok(hi < 0, `expected hi<0, got ${hi}`);
  assert.equal(verdictFor(lo, hi), "CONFIRMED-");
});

test("wide low-N mix => INCONCLUSIVE", () => {
  const rand = lcg(3);
  const [lo, hi] = bootstrapLiftCI([1, 0, 1, 0, 1], [0, 1, 0, 1, 0], rand);
  assert.equal(verdictFor(lo, hi), "INCONCLUSIVE");
});

test("bootstrapRateCI: constant arm => point CI, spread => band inside [0,1]", () => {
  assert.deepEqual(bootstrapRateCI([1, 1, 1, 1], lcg(1)), [1, 1]);
  assert.deepEqual(bootstrapRateCI([0, 0, 0, 0], lcg(1)), [0, 0]);
  const [lo, hi] = bootstrapRateCI([1, 1, 1, 0, 0, 0, 0, 0], lcg(9)); // rate 0.375
  assert.ok(lo >= 0 && hi <= 1 && lo <= hi, `band in [0,1], got [${lo}, ${hi}]`);
  assert.deepEqual(bootstrapRateCI([], lcg(1)), [null, null]);
});

test("mean handles empty arrays", () => {
  assert.equal(mean([]), null);
  assert.equal(mean([2, 4]), 3);
});
