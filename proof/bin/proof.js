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
//
//   proof watch save  --spec <probe.json> [--reps M] [--store <dir>] [--yes]
//   proof watch check --spec <probe.json> [--reps M] [--store <dir>]
//   proof watch calibrate --spec <probe.json> [--rounds K] [--store <dir>]
//       Drift monitor. `save` fingerprints a probe's behavior as a distribution
//       (M runs → rate + bootstrap CI) keyed to (agent, model, probe). `check`
//       re-runs it and flags drift ONLY when the fresh rate falls outside the
//       saved CI; it also reports the measured false-alarm rate. `calibrate`
//       re-checks an unchanged fingerprint K times and reports how often it
//       cries wolf. `check` exits 3 on drift, 0 otherwise.

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
const watch = require("../lib/watch");

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
    else if (a === "--rounds") opts.rounds = Number(argv[++i]);
    else if (a === "--store") opts.store = argv[++i];
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

function pct(x) { return x == null ? "—" : (x * 100).toFixed(1) + "%"; }

async function cmdWatch(sub, opts) {
  if (!opts.spec) { console.error("Usage: proof watch <save|check|calibrate> --spec <probe.json> [flags]"); process.exit(2); }
  const spec = JSON.parse(fs.readFileSync(opts.spec, "utf-8"));
  const tick = (rec, done, total) => { if (!opts.json) console.error(`[proof] ${done}/${total} ${rec.id} ok=${rec.ok} valid=${rec.valid} compliance=${rec.compliance}`); };

  if (sub === "save") {
    const est = estimate(spec, opts);
    if (!opts.json) console.error(formatEstimate(est));
    if (!opts.yes && !opts.json) {
      const ok = await confirm("\n  fingerprint this probe now?  [y/N] > ");
      if (!ok) { console.error("[proof] aborted — no spend."); process.exit(0); }
    }
    const { fingerprint: fp, cost } = await watch.saveFingerprint(spec, { ...opts, onCell: tick });
    if (opts.json) { console.log(JSON.stringify(fp, null, 2)); return; }
    console.log(`\n[proof] fingerprint saved — ${fp.probeId} @ ${fp.agent} ${fp.version}/${fp.model}`);
    console.log(`  rate ${fp.rate == null ? "—" : fp.rate.toFixed(3)}  baseline CI [${fp.ci.map((x) => x == null ? "—" : x.toFixed(3)).join(", ")}]  n=${fp.n}  spend $${cost.toFixed(4)}`);
    console.log(`  stored at ${watch.fpDir(opts)}`);
    return;
  }

  if (sub === "check") {
    const { verdict: v, cost } = await watch.checkFingerprint(spec, { ...opts, onCell: tick });
    if (opts.json) { console.log(JSON.stringify(v, null, 2)); process.exit(v.drift ? 3 : 0); }
    console.log(`\nproof watch — ${spec.id}`);
    console.log(`  baseline rate ${v.savedRate == null ? "—" : v.savedRate.toFixed(3)}  CI [${v.ci.map((x) => x == null ? "—" : x.toFixed(3)).join(", ")}]  (saved under ${v.savedVersion})`);
    console.log(`  fresh rate    ${v.freshRate == null ? "—" : v.freshRate.toFixed(3)}  (current ${v.currentVersion})`);
    console.log(`  verdict: ${v.drift ? `DRIFT (${v.direction}) — fresh rate is outside the baseline CI` : "no drift — fresh rate within the baseline CI"}`);
    if (v.versionChanged) console.log(`  note: agent version moved since this fingerprint was saved.`);
    console.log(`  measured false-alarm rate at this n: ${pct(v.falseAlarmRate)} (an unchanged probe trips the CI this often by chance)`);
    console.log(`  spend $${cost.toFixed(4)}`);
    process.exit(v.drift ? 3 : 0);
  }

  if (sub === "calibrate") {
    const onRound = (r, done, total) => { if (!opts.json) console.error(`[proof] round ${done}/${total} freshRate=${r.freshRate == null ? "—" : r.freshRate.toFixed(3)} drift=${r.drift}`); };
    const c = await watch.calibrate(spec, { ...opts, onCell: tick, onRound });
    if (opts.json) { console.log(JSON.stringify(c, null, 2)); return; }
    console.log(`\nproof watch calibrate — ${spec.id}`);
    console.log(`  ${c.rounds} unchanged re-checks, ${c.flagged} falsely flagged drift`);
    console.log(`  measured live false-alarm rate: ${pct(c.liveFalseAlarmRate)}`);
    console.log(`  spend $${c.cost.toFixed(4)}`);
    return;
  }

  console.error("Usage: proof watch <save|check|calibrate> --spec <probe.json> [flags]");
  process.exit(2);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "watch") return cmdWatch(rest[0], parseArgs(rest.slice(1)));
  const opts = parseArgs(rest);
  if (command === "harvest") return cmdHarvest(opts);
  if (command === "lint") return cmdLint(opts);
  if (command === "run") return cmdRun(opts);
  console.error("Usage: proof <harvest|lint|run|watch> ...  (see: proof run --spec <file.json>)");
  process.exit(2);
}

main().catch((err) => { console.error(err); process.exit(1); });
