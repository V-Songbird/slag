"use strict";

// proof watch — the drift monitor, a second verb of the same engine.
//
// A fingerprint is a saved behavior probe keyed to (agent, model, probe): the
// probe run M times yields a firing/pass rate with a bootstrap CI from stats.js,
// never a single run, because the whole difficulty is telling drift from
// nondeterminism. `save` records one; `check` re-runs the probe cheaply and
// flags drift ONLY when the fresh rate falls outside the saved baseline CI.
//
// The store lives at $PROOF_HOME/fingerprints (default ~/.proof), one JSON per
// (agent, model, probe) key. The version the fingerprint was saved under is
// recorded inside it, not in the filename, so a re-save under a new agent
// version overwrites the same key and the SessionStart hook can see the version
// move and nag for a re-check.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { run, readRecords } = require("./runner");
const { lcg, mean, bootstrapRateCI } = require("./stats");
const { DEFAULTS: ADAPTER_DEFAULTS } = require("./claude");

const DEFAULTS = { reps: 8, seed: 42, calRounds: 2000 };

// The baseline decision band. A small saturated sample (e.g. 8/8) makes a raw
// percentile bootstrap collapse to a false-precise point [1,1], which then
// flags every honest re-check whose true rate is below 1.0 — the crying-wolf
// failure. Laplace-smooth the sample (one pseudo-hit + one pseudo-miss) before
// bootstrapping so the band reflects real sampling uncertainty near the
// boundary. razor: add-one smoothing; a probe with a genuinely large N can
// pass rawCI:true to skip it once its sample already spans the true spread.
function rateCI(scores, rand, opts = {}) {
  if (!scores.length) return [null, null];
  const padded = opts.rawCI ? scores : scores.concat([0, 1]);
  return bootstrapRateCI(padded, rand);
}

function homeDir(opts = {}) {
  return opts.store || process.env.PROOF_HOME || path.join(os.homedir(), ".proof");
}
function fpDir(opts = {}) {
  return path.join(homeDir(opts), "fingerprints");
}
function keyOf({ agent, model, probeId }) {
  return [agent, model, probeId].join("__").replace(/[^\w.-]+/g, "_");
}

// The (agent, version, model) the current host presents. version comes from
// `claude --version` — a local, no-API probe; injectable via opts for tests so
// the hook logic is testable without a live binary.
function currentEnv(opts = {}) {
  const model = opts.model || ADAPTER_DEFAULTS.model;
  let version = opts.version;
  if (version == null) {
    try {
      const bin = process.env.PROOF_CLAUDE_BIN || "claude";
      const r = spawnSync(bin, ["--version"], { encoding: "utf-8", shell: true, windowsHide: true });
      version = String(r.stdout || "").trim() || "unknown";
    } catch { version = "unknown"; }
  }
  return { agent: "claude", model, version };
}

// Run a single-arm probe spec M times and return the per-run pass scores. Reuses
// the paired runner (resume-from-disk kept) — a probe is just a spec with one arm.
async function probeRun(spec, opts = {}) {
  const out = opts.out || path.join(os.tmpdir(), "proof-watch", spec.id);
  await run(spec, { ...opts, out });
  const records = readRecords(path.join(out, "cells"));
  const usable = records.filter((r) => r.ok && r.valid);
  return {
    scores: usable.map((r) => r.compliance),
    cost: records.reduce((a, r) => a + (r.costUsd || 0), 0),
    ran: records.length,
    usable: usable.length,
  };
}

function readFingerprint(probeId, env, opts = {}) {
  const file = path.join(fpDir(opts), keyOf({ ...env, probeId }) + ".json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : null;
}

// Every fingerprint in the store, for the SessionStart hook to scan.
function readStore(opts = {}) {
  const dir = fpDir(opts);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")));
}

async function saveFingerprint(spec, opts = {}) {
  const env = currentEnv(opts);
  const seed = opts.seed || spec.seed || DEFAULTS.seed;
  const { scores, cost, ran, usable } = await probeRun(spec, opts);
  const rate = mean(scores);
  const ci = rateCI(scores, lcg(seed), opts);
  const fp = {
    key: keyOf({ ...env, probeId: spec.id }),
    probeId: spec.id, agent: env.agent, model: env.model, version: env.version,
    n: scores.length, rate, ci, scores,
    savedAt: new Date().toISOString(),
  };
  const dir = fpDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fp.key + ".json"), JSON.stringify(fp, null, 2));
  return { fingerprint: fp, cost, ran, usable };
}

// The drift verdict: flag ONLY when the fresh rate falls OUTSIDE the saved
// baseline CI. The band is inclusive — a fresh rate exactly on lo/hi is not
// drift — so nondeterminism inside the baseline's own spread never cries wolf.
function driftVerdict(saved, freshRate) {
  const [lo, hi] = saved.ci;
  const drift = freshRate < lo || freshRate > hi;
  return {
    drift,
    freshRate,
    savedRate: saved.rate,
    ci: [lo, hi],
    direction: freshRate < lo ? "down" : freshRate > hi ? "up" : "none",
  };
}

// The false-alarm (crying-wolf) rate: how often an UNCHANGED probe would trip
// the DETECTOR'S OWN band by nondeterminism alone. Draw `rounds` fresh M-sized
// samples from the baseline's observed outcome distribution and count the
// fraction that land outside `ci` — the exact band a live re-check is judged
// against. Costs nothing live: it is the null re-check done in software.
function falseAlarmRate(nullScores, ci, rand, opts = {}) {
  if (!nullScores.length || !ci || ci[0] == null) return null;
  const rounds = opts.rounds || DEFAULTS.calRounds;
  const m = opts.m || nullScores.length;
  const [lo, hi] = ci;
  let outside = 0;
  for (let i = 0; i < rounds; i++) {
    let s = 0;
    for (let j = 0; j < m; j++) s += nullScores[Math.floor(rand() * nullScores.length)];
    const r = s / m;
    if (r < lo || r > hi) outside++;
  }
  return outside / rounds;
}

async function checkFingerprint(spec, opts = {}) {
  const env = currentEnv(opts);
  const saved = readFingerprint(spec.id, env, opts);
  if (!saved) throw new Error(`no saved fingerprint for probe "${spec.id}" (${env.agent}/${env.model}) — run \`proof watch save\` first`);
  const seed = opts.seed || spec.seed || DEFAULTS.seed;
  const { scores, cost, ran, usable } = await probeRun(spec, opts);
  const freshRate = mean(scores);
  const verdict = driftVerdict(saved, freshRate);
  verdict.versionChanged = saved.version !== env.version;
  verdict.savedVersion = saved.version;
  verdict.currentVersion = env.version;
  verdict.falseAlarmRate = falseAlarmRate(saved.scores, saved.ci, lcg(seed + 7), { rounds: opts.calRounds || DEFAULTS.calRounds, m: scores.length || saved.n });
  return { verdict, saved, freshScores: scores, cost, ran, usable };
}

// Live calibration: K real re-checks of an UNCHANGED probe against its own saved
// fingerprint, counting how many falsely flag drift. Complements the software
// false-alarm estimate with a measured number over repeated live re-checks.
async function calibrate(spec, opts = {}) {
  const rounds = opts.rounds || 3;
  const results = [];
  let cost = 0;
  for (let k = 0; k < rounds; k++) {
    const out = path.join(os.tmpdir(), "proof-watch-cal", spec.id, "round-" + k);
    const r = await checkFingerprint(spec, { ...opts, out });
    cost += r.cost;
    results.push({ round: k, freshRate: r.verdict.freshRate, drift: r.verdict.drift });
    if (opts.onRound) opts.onRound(results[results.length - 1], k + 1, rounds);
  }
  const flagged = results.filter((r) => r.drift).length;
  return { rounds, flagged, liveFalseAlarmRate: rounds ? flagged / rounds : null, results, cost };
}

// One short nag line when any fingerprint predates the current agent version or
// model; empty array (silent) when nothing is due or the store is empty. Pure —
// the hook is a thin wrapper so this is testable without a live session.
function nagLines(store, current) {
  const due = store.filter((fp) => fp.agent === current.agent && (fp.version !== current.version || fp.model !== current.model));
  if (!due.length) return [];
  const probes = [...new Set(due.map((fp) => fp.probeId))];
  return [`proof watch: ${probes.length} fingerprint(s) predate claude ${current.version}/${current.model} — re-check for drift with \`proof watch check\`.`];
}

module.exports = {
  DEFAULTS, homeDir, fpDir, keyOf, currentEnv,
  saveFingerprint, checkFingerprint, calibrate,
  readFingerprint, readStore, driftVerdict, falseAlarmRate, rateCI, nagLines,
};
