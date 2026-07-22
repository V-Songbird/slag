"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { estimate, PRICES } = require("../lib/estimate");

const baseSpec = {
  id: "e", model: "haiku", reps: 8,
  arms: { baseline: null, treatment: "x" },
  tasks: [{ id: "t1", assert: [] }, { id: "t2", assert: [] }],
};

test("run count is arms × tasks × reps", () => {
  const e = estimate(baseSpec, { reps: 8 });
  assert.equal(e.arms, 2);
  assert.equal(e.tasks, 2);
  assert.equal(e.reps, 8);
  assert.equal(e.runs, 2 * 2 * 8);
});

test("cost band uses bundled prices and low <= mid <= high", () => {
  const e = estimate(baseSpec, { reps: 8 });
  const p = PRICES.perRun.haiku;
  assert.equal(e.low, round(e.runs * p.low));
  assert.equal(e.high, round(e.runs * p.high));
  assert.ok(e.low <= e.mid && e.mid <= e.high);
});

test("sonnet aliases normalize to the sonnet price row", () => {
  const e = estimate({ ...baseSpec, model: "claude-sonnet-5" });
  assert.equal(e.model, "sonnet");
  assert.equal(e.high, round(e.runs * PRICES.perRun.sonnet.high));
});

test("overCap flags when the high end exceeds the budget", () => {
  const cheap = estimate(baseSpec, { reps: 8, maxBudgetUsd: 100 });
  assert.equal(cheap.overCap, false);
  const tight = estimate(baseSpec, { reps: 8, maxBudgetUsd: 0.01 });
  assert.equal(tight.overCap, true);
});

test("rubric adds tier-2 grade cost only for rubric-carrying tasks", () => {
  const withRubric = { ...baseSpec, tasks: [{ id: "t1", assert: [] }, { id: "t2", assert: [], rubric: { question: "?" } }] };
  const plain = estimate(withRubric, { reps: 8 });
  const graded = estimate(withRubric, { reps: 8, rubric: true });
  assert.equal(plain.rubricRuns, 0);
  assert.equal(graded.rubricRuns, 1 * 8 * 2); // one rubric task × reps × arms
  assert.ok(graded.high > plain.high);
});

test("single-task legacy spec (spec.task) estimates one task", () => {
  const legacy = { id: "L", model: "haiku", arms: { baseline: null, treatment: "x" }, task: { assert: [] } };
  const e = estimate(legacy, { reps: 4 });
  assert.equal(e.tasks, 1);
  assert.equal(e.runs, 2 * 1 * 4);
});

function round(x) { return Math.round(x * 1e4) / 1e4; }
