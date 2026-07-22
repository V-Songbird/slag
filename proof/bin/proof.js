#!/usr/bin/env node
"use strict";

// proof CLI — the ops entry point. Verbs:
//
//   proof harvest --repo <dir> [--out <spec.json>] [--limit N]
//       Mine revert / bug-fix commits from a repo's git history into candidate
//       tasks, lint them (blocking), and optionally scaffold a spec.
//
//   proof lint --spec <file.json>
//       Run the blocking task linter on a spec's task set. Exit 1 if it fails.
//
//   proof run --spec <file.json> [--reps N] [--seed N] [--model M]
//             [--max-budget-usd N] [--out <dir>] [--resume] [--keep]
//             [--concurrency N] [--limit N] [--rubric] [--yes] [--json]
//       The first-time path: lint (blocking) → tier note → cost estimate +
//       confirm → run → report with the representativeness disclosure and, on a
//       non-positive verdict, a diagnosed null explanation.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { run, analyze, tasksOf } = require("../lib/runner");
const { renderReport } = require("../lib/report");
const { lintTaskSet } = require("../lib/lint");
const { disclosure } = require("../lib/disclosure");
const { estimate, formatEstimate } = require("../lib/estimate");
const { tierFor } = require("../lib/tier");
const { explainVerdict } = require("../lib/explain");
const { harvestRepo } = require("../lib/harvest");

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spec") opts.spec = argv[++i];
    else if (a === "--repo") opts.repo = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--reps") opts.reps = Number(argv[++i]);
    else if (a === "--seed") opts.seed = Number(argv[++i]);
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--max-budget-usd") opts.maxBudgetUsd = Number(argv[++i]);
    else if (a === "--concurrency") opts.concurrency = Number(argv[++i]);
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--resume") opts.resume = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--rubric") opts.rubric = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--json") opts.json = true;
  }
  return opts;
}

// Print lint result; return true iff the set is runnable. Blocking on errors.
function printLint(lint) {
  console.error(`  task-set lint  (${lint.summary.n} tasks, ${lint.summary.types.length} type(s), ${lint.summary.files} file(s))`);
  for (const w of lint.warnings) console.error(`    warning: ${w}`);
  for (const e of lint.errors) console.error(`    ERROR:   ${e}`);
  console.error(`    ${lint.ok ? "ok — set is runnable" : "BLOCKED — fix the errors above before running"}`);
  return lint.ok;
}

// Read a single y/n line from stdin. Confirm-before-spend is a hard gate.
function confirm(question) {
  return new Promise((resolve) => {
    process.stderr.write(question);
    const onData = (d) => {
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      resolve(/^\s*y(es)?\s*$/i.test(String(d)));
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

async function cmdHarvest(opts) {
  if (!opts.repo) { console.error("Usage: proof harvest --repo <dir> [--out <spec.json>] [--limit N]"); process.exit(2); }
  const tasks = harvestRepo(opts.repo, { limit: opts.limit });
  console.error(`[proof] harvested ${tasks.length} candidate task(s) from ${opts.repo}`);
  for (const t of tasks) {
    console.error(`  - ${t.id}  (${t.type})  ${t.assert.length ? "provisional assert on " + t.assert[0].path : "NO assertion — needs one"}`);
  }
  const lint = lintTaskSet(tasks);
  console.error("");
  const runnable = printLint(lint);
  console.error("\n  harvested tasks are CANDIDATES with provisional assertions — curate the prompts and assertions before running.");
  if (opts.out) {
    const spec = {
      id: path.basename(opts.out).replace(/\.json$/, ""),
      surface: "instructions", model: opts.model || "haiku", reps: opts.reps || 8, seed: opts.seed || 42,
      claudeMd: "# Project notes\n\n{{CONFIG}}\n",
      fixture: {}, arms: { baseline: null, treatment: "" },
      tasks,
    };
    fs.writeFileSync(opts.out, JSON.stringify(spec, null, 2));
    console.error(`\n[proof] wrote candidate spec -> ${opts.out} (fill in fixture + arms + real assertions)`);
  }
  process.exit(runnable ? 0 : 1);
}

function cmdLint(opts) {
  if (!opts.spec) { console.error("Usage: proof lint --spec <file.json>"); process.exit(2); }
  const spec = JSON.parse(fs.readFileSync(opts.spec, "utf-8"));
  const runnable = printLint(lintTaskSet(tasksOf(spec)));
  process.exit(runnable ? 0 : 1);
}

async function cmdRun(opts) {
  if (!opts.spec) { console.error("Usage: proof run --spec <file.json> [flags]"); process.exit(2); }
  const spec = JSON.parse(fs.readFileSync(opts.spec, "utf-8"));
  opts.out = opts.out || path.join(os.tmpdir(), "proof-runs", spec.id);
  const tasks = tasksOf(spec);

  // 1. Lint (BLOCKING).
  const lint = lintTaskSet(tasks);
  if (!opts.json) printLint(lint);
  if (!lint.ok) { console.error("\n[proof] refusing to spend on a task set that failed the linter."); process.exit(1); }

  // 2. Tier note.
  const tier = tierFor(spec, opts.model);
  if (!opts.json) {
    console.error(`\n  tier note`);
    console.error(`    surface ${tier.surface} → ${tier.tier}${tier.valid ? " (valid)" : " (INVALID for this surface)"}`);
    console.error(`    ${tier.reason}`);
    if (tier.warning) console.error(`    ! ${tier.warning}`);
  }

  // 3. Estimate + confirm-before-spend (hard gate).
  const est = estimate(spec, opts);
  if (!opts.json) console.error("\n" + formatEstimate(est));
  if (!opts.yes && !opts.json && !opts.resume) {
    const ok = await confirm("\n  proceed?  [y/N] > ");
    if (!ok) { console.error("[proof] aborted — no spend."); process.exit(0); }
  }

  // 4. Run.
  if (!opts.json) console.error(`\n[proof] ${spec.id}: ${Object.keys(spec.arms).length} arms × ${tasks.length} task(s) × ${opts.reps || spec.reps || 8} reps on ${est.model} -> ${opts.out}`);
  await run(spec, {
    ...opts,
    onCell: (rec, done, total) => {
      if (!opts.json) console.error(`[proof] ${done}/${total} ${rec.id} ok=${rec.ok} valid=${rec.valid} compliance=${rec.compliance}`);
    },
  });

  // 5. Report + disclosure + null explanation.
  const analysis = analyze(spec, path.join(opts.out, "cells"), opts);
  analysis.disclosure = disclosure(tasks);
  const baseMean = analysis.arms.baseline ? analysis.arms.baseline.mean : null;
  analysis.explanations = {};
  for (const [arm, d] of Object.entries(analysis.arms)) {
    if (arm === "baseline") continue;
    const ex = explainVerdict(d, baseMean, tier);
    if (ex) analysis.explanations[arm] = ex;
  }

  if (opts.json) { console.log(JSON.stringify(analysis, null, 2)); return; }

  console.log("\n" + renderReport(analysis));
  console.log(`\nrepresentativeness: ${analysis.disclosure}`);
  for (const [arm, ex] of Object.entries(analysis.explanations)) {
    console.log(`\n  ${arm}: ${ex.headline}`);
    console.log(`    ${ex.body}`);
    console.log(`    suggested action: ${ex.action}`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (command === "harvest") return cmdHarvest(opts);
  if (command === "lint") return cmdLint(opts);
  if (command === "run") return cmdRun(opts);
  console.error("Usage: proof <harvest|lint|run> ...  (see: proof run --spec <file.json>)");
  process.exit(2);
}

main().catch((err) => { console.error(err); process.exit(1); });
