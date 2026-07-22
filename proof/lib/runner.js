"use strict";

// Paired runner — seeded, order-controlled, N runs per arm on identical
// fixtures, with resume-from-disk so an interrupted run is recoverable rather
// than re-paid. Each cell materializes its arm's checkout, runs the agent,
// grades tier-1, and persists a RunRecord. `analyze` aggregates the records
// into a per-arm lift + CI + verdict.

const fs = require("fs");
const path = require("path");

const { materialize } = require("./fixture");
const { runAgent, DEFAULTS: ADAPTER_DEFAULTS } = require("./claude");
const { grade } = require("./grade");
const { rubricGrade } = require("./rubric");
const { lcg, mean, bootstrapLiftCI, verdictFor } = require("./stats");

const DEFAULTS = { reps: 8, seed: 42, concurrency: 2 };

// A spec carries either one `task` (M1/M2 single-task specs) or a `tasks` array
// (an M3 task set). Normalize to an array; compliance is pooled across the set.
function tasksOf(spec) { return spec.tasks || (spec.task ? [spec.task] : []); }

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// One cell per (arm, task, repeat); order shuffled deterministically from the
// seed so arms interleave and slow platform drift hits both equally. Single-task
// specs keep the legacy `${arm}__r${rep}` id for on-disk resume compatibility.
function buildCells(spec, opts = {}) {
  const reps = opts.reps || spec.reps || DEFAULTS.reps;
  const seed = opts.seed || spec.seed || DEFAULTS.seed;
  const tasks = tasksOf(spec);
  const multi = tasks.length > 1;
  const cells = [];
  for (const arm of Object.keys(spec.arms)) {
    for (let ti = 0; ti < tasks.length; ti++) {
      for (let rep = 1; rep <= reps; rep++) {
        cells.push({
          id: multi ? `${arm}__t${ti}_r${rep}` : `${arm}__r${rep}`,
          arm, task: ti, taskId: tasks[ti].id || `t${ti}`, rep,
        });
      }
    }
  }
  return shuffle(cells, lcg(seed));
}

async function runCell(spec, cell, opts = {}) {
  const task = tasksOf(spec)[cell.task || 0];
  const dir = materialize(spec, spec.arms[cell.arm]);
  const record = { ...cell, id: cell.id, startedAt: new Date().toISOString() };
  try {
    const r = await runAgent(task.prompt, dir, {
      model: opts.model || spec.model || ADAPTER_DEFAULTS.model,
      maxBudgetUsd: opts.maxBudgetUsd || spec.maxBudgetUsd || ADAPTER_DEFAULTS.maxBudgetUsd,
      timeoutMs: spec.timeoutMs || ADAPTER_DEFAULTS.timeoutMs,
      allowedTools: spec.allowedTools,
    });
    const ctx = { dir, response: r.response, editedFiles: r.editedFiles };
    const validity = grade(task.valid || [{ type: "file_exists", path: "CLAUDE.md" }], ctx);
    let compliance;
    if ((task.assert || []).length) {
      compliance = grade(task.assert, ctx).score;
    } else if (opts.rubric && task.rubric) {
      const rg = await rubricGrade(task.rubric, ctx, { model: opts.model || spec.model });
      compliance = rg.ok ? rg.score : null;
      record.rubricReason = rg.reasonCode;
    } else {
      compliance = 0;
    }
    Object.assign(record, {
      ok: r.ok,
      valid: validity.score === 1,
      compliance,
      turns: r.turns,
      costUsd: r.cost,
      editedFiles: r.editedFiles,
      wallMs: r.wallMs,
      responseTail: (r.response || "").slice(-500),
      stderr: r.ok ? undefined : r.stderr,
    });
  } catch (err) {
    Object.assign(record, { ok: false, valid: false, compliance: null, error: String(err) });
  } finally {
    if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
    else record.fixtureDir = dir;
  }
  return record;
}

// Run all (remaining) cells with a small worker pool, persisting each record to
// cellDir so `--resume` skips anything already on disk.
async function run(spec, opts = {}) {
  const cellDir = path.join(opts.out, "cells");
  fs.mkdirSync(cellDir, { recursive: true });
  let cells = buildCells(spec, opts);
  if (opts.resume) cells = cells.filter((c) => !fs.existsSync(path.join(cellDir, c.id + ".json")));
  if (opts.limit) cells = cells.slice(0, opts.limit);

  const concurrency = opts.concurrency || DEFAULTS.concurrency;
  const queue = cells.slice();
  let done = 0;
  const onCell = opts.onCell || (() => {});
  const workers = Array.from({ length: Math.min(concurrency, queue.length) || 1 }, async () => {
    while (queue.length) {
      const cell = queue.shift();
      const record = await runCell(spec, cell, opts);
      fs.writeFileSync(path.join(cellDir, cell.id + ".json"), JSON.stringify(record, null, 2));
      onCell(record, ++done, cells.length);
    }
  });
  await Promise.all(workers);
  return cellDir;
}

function readRecords(cellDir) {
  if (!fs.existsSync(cellDir)) return [];
  return fs.readdirSync(cellDir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(cellDir, f), "utf-8")));
}

// Aggregate records into per-arm compliance, spend, and — for every non-baseline
// arm — lift over baseline with a bootstrap CI and a verdict.
function analyze(spec, cellDir, opts = {}) {
  const records = readRecords(cellDir);
  const usable = records.filter((r) => r.ok && r.valid);
  const rand = lcg(opts.seed || spec.seed || DEFAULTS.seed);

  const armStats = (arm) => {
    const own = records.filter((r) => r.arm === arm);
    const scores = usable.filter((r) => r.arm === arm).map((r) => r.compliance);
    return {
      n: scores.length,
      ran: own.length,
      mean: mean(scores),
      costUsd: own.reduce((a, r) => a + (r.costUsd || 0), 0),
      scores,
    };
  };

  const baseline = armStats("baseline");
  const arms = { baseline: { n: baseline.n, ran: baseline.ran, mean: baseline.mean, costUsd: baseline.costUsd } };
  for (const arm of Object.keys(spec.arms)) {
    if (arm === "baseline") continue;
    const s = armStats(arm);
    if (!s.scores.length || !baseline.scores.length) {
      arms[arm] = { n: s.n, ran: s.ran, mean: s.mean, costUsd: s.costUsd, lift: null, ci: null, verdict: "INCONCLUSIVE" };
      continue;
    }
    const [lo, hi] = bootstrapLiftCI(s.scores, baseline.scores, rand);
    arms[arm] = { n: s.n, ran: s.ran, mean: s.mean, costUsd: s.costUsd, lift: s.mean - baseline.mean, ci: [lo, hi], verdict: verdictFor(lo, hi) };
  }

  return {
    id: spec.id,
    model: opts.model || spec.model || ADAPTER_DEFAULTS.model,
    seed: opts.seed || spec.seed || DEFAULTS.seed,
    cells: records.length,
    usable: usable.length,
    totalCostUsd: records.reduce((a, r) => a + (r.costUsd || 0), 0),
    arms,
  };
}

module.exports = { buildCells, runCell, run, analyze, readRecords, shuffle, tasksOf, DEFAULTS };
