"use strict";

// Cost estimator + confirm-before-spend (component 4). No spend happens without
// an estimate shown first and an explicit `y`. Prices come from the bundled
// prices.json — measured per-run costs, not a vendor $/Mtok feed (none exists;
// M0 item 16). The estimate is a BAND (low..high), never a point, because M0
// item 17 measured up to ~6.6x run-to-run cost spread on an identical prompt.

const fs = require("fs");
const path = require("path");

const PRICES = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "prices.json"), "utf-8"));

function tasksOf(spec) { return spec.tasks || (spec.task ? [spec.task] : []); }

// Estimate the spend for a run. reps/arms/tasks × per-run band, plus optional
// tier-2 rubric grades. Returns dollar low/mid/high and the run shape.
function estimate(spec, opts = {}) {
  const model = normalizeModel(opts.model || spec.model || "haiku");
  const reps = opts.reps || spec.reps || 8;
  const armCount = Object.keys(spec.arms || {}).length || 2;
  const taskCount = Math.max(tasksOf(spec).length, 1);
  const runs = reps * armCount * taskCount;

  const per = PRICES.perRun[model] || PRICES.perRun.haiku;
  const band = { low: runs * per.low, mid: runs * per.mid, high: runs * per.high };

  // Rubric grading (opt-in, tier 2) adds one cheap haiku call per graded run.
  let rubricRuns = 0;
  if (opts.rubric) {
    rubricRuns = tasksOf(spec).filter((t) => t.rubric).length * reps * armCount;
    const r = PRICES.rubricPerCall.haiku;
    band.low += rubricRuns * r.low;
    band.mid += rubricRuns * r.mid;
    band.high += rubricRuns * r.high;
  }

  const cap = opts.maxBudgetUsd != null ? opts.maxBudgetUsd : null;
  return {
    model, reps, arms: armCount, tasks: taskCount, runs, rubricRuns,
    low: round(band.low), mid: round(band.mid), high: round(band.high),
    cap,
    overCap: cap != null && band.high > cap,
    currency: PRICES.currency,
  };
}

// Human-readable pre-spend block. The CLI prints this, then waits for `y`.
function formatEstimate(est) {
  const L = [];
  L.push("  estimate");
  L.push(`    ${est.runs} headless runs (${est.arms} arms × ${est.tasks} task${est.tasks === 1 ? "" : "s"} × ${est.reps} reps) on ${est.model}, fixture prompt-cached`);
  if (est.rubricRuns) L.push(`    + ${est.rubricRuns} tier-2 rubric grades (haiku)`);
  L.push(`    est. cost  $${est.low.toFixed(2)} – $${est.high.toFixed(2)}   (typical $${est.mid.toFixed(2)})${est.cap != null ? `    budget cap  $${est.cap.toFixed(2)}` : ""}`);
  if (est.overCap) L.push(`    ! the high end exceeds the cap — the run stops at $${est.cap.toFixed(2)} and reports what it has`);
  return L.join("\n");
}

function normalizeModel(m) {
  const s = String(m).toLowerCase();
  if (/sonnet|opus|fable/.test(s)) return "sonnet";
  return "haiku";
}
function round(x) { return Math.round(x * 1e4) / 1e4; }

module.exports = { estimate, formatEstimate, PRICES };
