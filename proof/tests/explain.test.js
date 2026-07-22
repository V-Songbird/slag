"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { explainVerdict } = require("../lib/explain");

const haiku = { tier: "haiku" };
const sonnet = { tier: "sonnet" };

test("a positive verdict gets no null explanation", () => {
  assert.equal(explainVerdict({ verdict: "CONFIRMED+", lift: 0.7, ci: [0.4, 0.9] }, 0.1, haiku), null);
  assert.equal(explainVerdict({ verdict: "CONFIRMED-", lift: -0.5, ci: [-0.7, -0.2] }, 0.6, haiku), null);
});

test("saturated baseline → TIER_SATURATION, and on sonnet suggests re-running on haiku", () => {
  const ex = explainVerdict({ verdict: "NULL", lift: 0.02, ci: [-0.03, 0.06] }, 0.95, sonnet);
  assert.equal(ex.cause, "TIER_SATURATION");
  assert.match(ex.action, /haiku/);
});

test("wide CI with room to move → BELOW_DETECTION_FLOOR (not inert)", () => {
  const ex = explainVerdict({ verdict: "INCONCLUSIVE", lift: 0.14, ci: [-0.09, 0.38] }, 0.44, haiku);
  assert.equal(ex.cause, "BELOW_DETECTION_FLOOR");
  assert.match(ex.action, /power ladder|reps/i);
});

test("tight CI around zero with room to move → GENUINELY_INERT (delete it)", () => {
  const ex = explainVerdict({ verdict: "NULL", lift: 0.02, ci: [-0.06, 0.05] }, 0.44, haiku);
  assert.equal(ex.cause, "GENUINELY_INERT");
  assert.match(ex.action, /deletion|delete/i);
});

test("saturation is checked before underpower — a wide CI on a ceilinged baseline is still saturation", () => {
  const ex = explainVerdict({ verdict: "INCONCLUSIVE", lift: 0.05, ci: [-0.1, 0.2] }, 0.9, sonnet);
  assert.equal(ex.cause, "TIER_SATURATION");
});
