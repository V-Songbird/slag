#!/usr/bin/env node
"use strict";

// [Foreman: 094] The live Codex host check — the manual step behind the two
// disclosed release-gate cells "codex installed-host end-to-end" and "codex
// fresh-session loading".
//
// It builds a three-level AGENTS.md chain in a temp directory, starts a REAL
// Codex session in the innermost directory, and asks it to repeat the sentinel
// tokens its project instructions carried. What the session echoes back is the
// one thing no static read can know: which files the installed host actually
// loaded, in which order, at session start. A second session adds an
// AGENTS.override.md and checks the per-directory selection the adapter
// encodes.
//
// Deliberately NOT part of `node --test`: each run spends two live model
// sessions (~35k tokens on the account the CLI is signed into). It is a manual
// pre-release step, exactly like assay-doc-drift.js.
//
// Usage: node scripts/assay-live-host-codex.js
//   exit 0  the live host loaded the chain exactly as the adapter models it
//   exit 2  MISMATCH — the codex profile is blocked for release
//   exit 1  could not run (no binary, no auth, timeout) — nothing disproved
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RUN_TIMEOUT_MS = 180000;
const TOKENS = { root: "ROOT-77413", svc: "SVC-52901", api: "API-96348", override: "OVR-33847" };
const PROMPT = "Give me the loading report: list every sentinel token your project AGENTS " +
  "instructions gave you, in the order those instructions appear in your context. " +
  "Output only the tokens, one per line. Use no tools.";

// npm installs the CLI as a .cmd shim on Windows, which newer Node refuses to
// spawn directly — route through cmd.exe there. The prompt travels on stdin
// ("-" as the prompt argument), so no argument ever needs shell quoting.
function run(cmd, args, opts) {
  const attempts = process.platform === "win32"
    ? [["cmd.exe", ["/d", "/s", "/c", cmd, ...args]], [cmd, args]]
    : [[cmd, args]];
  for (const [bin, argv] of attempts) {
    try {
      const r = spawnSync(bin, argv, { encoding: "utf-8", windowsHide: true, ...opts });
      if (r.error) continue;
      return r;
    } catch {
      // next attempt
    }
  }
  return null;
}

function policy(token) {
  return "# Policy\n\nWhen asked for the loading report, include the token " + token + ".\n";
}

function session(cwd, label) {
  const out = path.join(cwd, "last-message-" + label + ".txt");
  const r = run("codex", ["exec", "-s", "read-only", "-o", out, "-"],
    { cwd, timeout: RUN_TIMEOUT_MS, input: PROMPT });
  if (!r || r.status !== 0) {
    process.stdout.write("UNREACHABLE — codex exec did not complete (" +
      (r ? "exit " + r.status : "no binary") + "). Nothing was disproved; no profile is blocked.\n");
    if (r && r.stderr) process.stdout.write(r.stderr.split("\n").slice(-4).join("\n") + "\n");
    process.exit(1);
  }
  return fs.existsSync(out) ? fs.readFileSync(out, "utf-8") : r.stdout;
}

// Every expected token present, in order, and every banned token absent.
function check(label, reply, expected, banned) {
  const positions = expected.map((t) => reply.indexOf(t));
  const problems = [];
  expected.forEach((t, i) => { if (positions[i] === -1) problems.push("missing " + t); });
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] !== -1 && positions[i - 1] !== -1 && positions[i] < positions[i - 1]) {
      problems.push(expected[i] + " arrived before " + expected[i - 1]);
    }
  }
  for (const t of banned) if (reply.includes(t)) problems.push(t + " should not have loaded");
  if (problems.length) {
    process.stdout.write("MISMATCH   " + label + " — " + problems.join("; ") + "\n" +
      "  the live host did not load the chain the adapter models\n" +
      "  BLOCKED FOR RELEASE: profile `codex`\n");
    process.exit(2);
  }
  process.stdout.write("OK         " + label + "\n");
}

const version = (() => {
  const r = run("codex", ["--version"], { timeout: 10000 });
  const m = r && r.status === 0 && r.stdout ? r.stdout.match(/\d+\.\d+\.\d+\S*/) : null;
  return m ? m[0] : null;
})();
if (!version) {
  process.stdout.write("UNREACHABLE — no codex binary on this machine. Nothing was disproved.\n");
  process.exit(1);
}
process.stdout.write("codex " + version + " — two live sessions follow\n");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "assay-live-codex-"));
fs.mkdirSync(path.join(base, "svc", "api"), { recursive: true });
fs.writeFileSync(path.join(base, "AGENTS.md"), policy(TOKENS.root));
fs.writeFileSync(path.join(base, "svc", "AGENTS.md"), policy(TOKENS.svc));
fs.writeFileSync(path.join(base, "svc", "api", "AGENTS.md"), policy(TOKENS.api));
const git = run("git", ["-C", base, "init", "-q"], { timeout: 20000 });
if (!git || git.status !== 0) {
  process.stdout.write("UNREACHABLE — could not `git init` the fixture, and codex exec expects a repository.\n");
  process.exit(1);
}
const cwd = path.join(base, "svc", "api");

// Session 1: the chain, root first, delivered at session start with no tool use.
check("chain + fresh-session (root → svc → api)", session(cwd, "chain"),
  [TOKENS.root, TOKENS.svc, TOKENS.api], []);

// Session 2: AGENTS.override.md replaces AGENTS.md at its own level only.
fs.writeFileSync(path.join(base, "svc", "AGENTS.override.md"), policy(TOKENS.override));
check("per-directory override selection", session(cwd, "override"),
  [TOKENS.root, TOKENS.override, TOKENS.api], [TOKENS.svc]);

process.stdout.write("\nOK — the installed host loaded the chain exactly as the adapter models it.\n");
