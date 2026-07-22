#!/usr/bin/env node
"use strict";

// proof CLI — the ops entry point. v0.1 ships one verb:
//
//   proof run --spec <file.json> [--reps N] [--seed N] [--model M]
//             [--max-budget-usd N] [--out <dir>] [--resume] [--keep]
//             [--concurrency N] [--limit N] [--json]
//
// Runs a paired A/B end to end and prints the verdict table. Results persist
// under --out (default: <tmp>/proof-runs/<specId>) so --resume recovers an
// interrupted run without re-spending.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { run, analyze } = require("../lib/runner");
const { renderReport } = require("../lib/report");

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spec") opts.spec = argv[++i];
    else if (a === "--reps") opts.reps = Number(argv[++i]);
    else if (a === "--seed") opts.seed = Number(argv[++i]);
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--max-budget-usd") opts.maxBudgetUsd = Number(argv[++i]);
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--concurrency") opts.concurrency = Number(argv[++i]);
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--resume") opts.resume = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--json") opts.json = true;
  }
  return opts;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (command !== "run" || !opts.spec) {
    console.error("Usage: proof run --spec <file.json> [--reps N] [--seed N] [--model M] [--out <dir>] [--resume] [--json]");
    process.exit(2);
  }
  const spec = JSON.parse(fs.readFileSync(opts.spec, "utf-8"));
  opts.out = opts.out || path.join(os.tmpdir(), "proof-runs", spec.id);

  if (!opts.json) {
    console.error(`[proof] ${spec.id}: ${Object.keys(spec.arms).length} arms × ${opts.reps || spec.reps || 8} reps on ${opts.model || spec.model || "haiku"} -> ${opts.out}`);
  }
  await run(spec, {
    ...opts,
    onCell: (rec, done, total) => {
      if (!opts.json) console.error(`[proof] ${done}/${total} ${rec.id} ok=${rec.ok} valid=${rec.valid} compliance=${rec.compliance}`);
    },
  });
  const analysis = analyze(spec, path.join(opts.out, "cells"), opts);
  if (opts.json) console.log(JSON.stringify(analysis, null, 2));
  else console.log("\n" + renderReport(analysis));
}

main().catch((err) => { console.error(err); process.exit(1); });
