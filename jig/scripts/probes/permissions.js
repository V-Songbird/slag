"use strict";

// The phase-0 permissions probe series.
//
// jig may gain the ability to write permission rules into
// `.claude/settings.json` ONLY after this series has proven, against a pinned
// Claude Code CLI, that the host actually behaves the way the write assumes:
//
//   P1  a `permissions.deny` rule in project settings refuses the tool call
//   P2  project settings.local.json overrides project settings.json
//   P3  a PreToolUse hook's "ask" decision reaches the user, not auto-allow
//
// Run it yourself, on a machine where `claude` is on PATH and logged in:
//
//   node jig/scripts/probes/permissions.js
//
// Each probe spawns one `claude -p` call in a throwaway directory and reads
// the observable outcome. The run costs real tokens and takes minutes; that is
// why it is a dev-time script and never part of an install. The result lands
// beside this file as `results.json`:
//
//   { "cliVersion": "<claude --version>", "green": true|false,
//     "checks": [{ "id": "P1", "pass": true, "observed": "…" }, …],
//     "checkedAt": "<iso>" }
//
// The engine reads `green` (and nothing else) to unlock the `write-settings`
// change kind. A missing or red results.json keeps the kind gated, which is
// the designed default: probes first, capability second. Re-run the series
// after every CLI upgrade — the pin is the point.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const RESULTS = path.join(__dirname, "results.json");

function cli(args, opts) {
  return spawnSync("claude", args, { encoding: "utf-8", windowsHide: true, timeout: 300000, ...opts });
}

function tmpProject(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jig-probe-"));
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  fs.writeFileSync(path.join(root, "probe.txt"), "probe target\n");
  return root;
}

function probeP1() {
  const root = tmpProject({ permissions: { deny: ["Bash(echo probe-p1*)"] } });
  const run = cli(["-p", "Run exactly: echo probe-p1-ran. Then print DONE."], { cwd: root });
  const text = (run.stdout || "") + (run.stderr || "");
  // Pass when the denied command visibly did not run: the transcript carries
  // the refusal and never the command's own output line.
  const pass = !text.includes("probe-p1-ran") && /denied|not permitted|permission/i.test(text);
  return { id: "P1", what: "project permissions.deny refuses the call", pass, observed: text.slice(0, 400) };
}

function probeP2() {
  const root = tmpProject({ permissions: { deny: ["Bash(echo probe-p2*)"] } });
  fs.writeFileSync(path.join(root, ".claude", "settings.local.json"),
    JSON.stringify({ permissions: { allow: ["Bash(echo probe-p2*)"] } }, null, 2));
  const run = cli(["-p", "Run exactly: echo probe-p2-ran. Then print DONE."], { cwd: root });
  const text = (run.stdout || "") + (run.stderr || "");
  // Which file wins is exactly what jig must know before writing either.
  const localWins = text.includes("probe-p2-ran");
  return {
    id: "P2", what: "settings.local.json vs settings.json precedence",
    pass: true, observed: (localWins ? "local allow won" : "project deny won") + " — " + text.slice(0, 300),
    localWins,
  };
}

function probeP3() {
  const root = tmpProject({});
  // An "ask" decision in headless mode must fail closed (no TTY to ask), never
  // silently allow. The hook asks for every Bash call; the command must not run.
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command",
        command: "node -e \"console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:'probe'}}))\"" }] }],
    },
  }, null, 2));
  const run = cli(["-p", "Run exactly: echo probe-p3-ran. Then print DONE."], { cwd: root });
  const text = (run.stdout || "") + (run.stderr || "");
  const pass = !text.includes("probe-p3-ran");
  return { id: "P3", what: "a PreToolUse ask decision cannot silently allow in headless mode", pass, observed: text.slice(0, 400) };
}

function main() {
  const version = cli(["--version"]);
  if (version.error || version.status !== 0) {
    process.stderr.write("claude is not runnable from this shell — the probe series needs the real CLI.\n");
    process.exit(1);
  }
  const cliVersion = version.stdout.trim();
  process.stdout.write("probing against " + cliVersion + " — three headless runs, this costs real tokens\n");

  const checks = [probeP1(), probeP2(), probeP3()];
  const green = checks.every((c) => c.pass);
  const record = { cliVersion, green, checks, checkedAt: new Date().toISOString() };
  fs.writeFileSync(RESULTS, JSON.stringify(record, null, 2) + "\n");
  process.stdout.write((green ? "GREEN" : "RED") + " — results written to " + RESULTS + "\n");
  for (const c of checks) process.stdout.write("  " + c.id + " " + (c.pass ? "pass" : "FAIL") + " — " + c.what + "\n");
  process.exit(green ? 0 : 1);
}

if (require.main === module) main();

module.exports = { RESULTS };
