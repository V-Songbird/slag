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
const { SHELL_TOOLS } = require("../vocab.js");

const RESULTS = path.join(__dirname, "results.json");

// The shell tool the probe's own rules and matcher have to name. Spelling it
// `Bash` here was the same defect roadmap 237 fixed everywhere else, and it is
// worse in a probe: on a session offered only `PowerShell` a `Bash(echo …)`
// rule matches nothing and the `Bash` matcher never fires, so nothing stops the
// call, the command runs and every arm reads that as "the deny did not hold" —
// RED having measured nothing about permissions at all. The tool name a session
// sends is not knowable up front (HOST-PROBE-2026-09-02, section 4), so every
// name jig watches is named.
// Whether a `permissions.deny` specifier takes the same shape for a non-`Bash`
// shell tool is NOT probed. Nothing in HOST-PROBE-2026-09-02 bears on it, and
// what an inert `PowerShell(echo …)` rule does to each arm differs — only one of
// the three fails safely on its own:
//
//   P1  goes RED and says so: an inert deny lets the command run, which is the
//       direction a probe is allowed to fail in. It concludes only where the
//       transcript carries the command's output or a refusal — a crash, a
//       timeout or a session offered no shell tool leaves the same silence a
//       refusal does, and reading that as either answer is the defect P3 was
//       already guarded against.
//   P2  reads its answer off whether the command ran, so an inert deny records
//       "local allow won" having measured nothing. It is `inconclusive` unless
//       P1 passed, because P1 passing is the only evidence that a deny of this
//       shape has teeth at all.
//   P3  registers a hook rather than a rule, so the specifier shape does not
//       reach it — but its own predicate does: absent output is a refusal only
//       if the session got as far as being refused. It is `inconclusive` unless
//       the transcript says so, which a crash, a timeout or a session offered
//       no shell tool does not.
//
// An inconclusive arm is not a pass. `green` requires every arm to have passed
// AND concluded, so a series that measured nothing leaves the `write-settings`
// kind gated instead of unlocking it on a silence.
const SHELL_MATCHER = SHELL_TOOLS.join("|");
const echoRules = (token) => SHELL_TOOLS.map((t) => t + "(echo " + token + "*)");

function cli(args, opts) {
  return spawnSync("claude", args, { encoding: "utf-8", windowsHide: true, timeout: 300000, ...opts });
}

// A fresh mkdtemp root is a workspace the CLI has never been trusted in, and
// HOST-PROBE-2026-09-02 (`## Method`, the traps list) recorded `-p` dropping
// that workspace's `permissions.allow` entries there with one stderr line and
// no failure.
// Whether the same happens to `permissions.deny` was not probed, and no regex
// for that stderr line is written here because nobody measured its text. So it
// stands as a disclosed cause of a RED on P1 and P2 that has nothing to do with
// precedence: read a RED against this note before reading it as an answer.
function tmpProject(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jig-probe-"));
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  fs.writeFileSync(path.join(root, "probe.txt"), "probe target\n");
  return root;
}

// The transcript said a call was refused. Both `pass` predicates below read an
// ABSENT output line as proof of a refusal, and absence has three other causes —
// a crash, a timeout, and a session offered no shell tool at all. This is the
// evidence that separates them, and an arm without it concludes nothing.
const REFUSED = /denied|not permitted|permission/i;

function probeP1() {
  const root = tmpProject({ permissions: { deny: echoRules("probe-p1") } });
  const run = cli(["-p", "Run exactly: echo probe-p1-ran. Then print DONE."], { cwd: root });
  const text = (run.stdout || "") + (run.stderr || "");
  const ran = text.includes("probe-p1-ran");
  // Pass when the denied command visibly did not run: the transcript carries
  // the refusal and never the command's own output line. Neither visible is not
  // a third grade of pass — it is the arm measuring nothing, the same silence a
  // crash, a timeout or a session with no shell tool leaves. `inconclusive: false`
  // here used to assert this arm always concluded, which is the claim SCOPE
  // forbids and the one P2 then derives its own verdict from.
  const inconclusive = !ran && !REFUSED.test(text);
  return {
    id: "P1", what: "project permissions.deny refuses the call",
    pass: !ran && !inconclusive, inconclusive,
    observed: (inconclusive ? "INCONCLUSIVE — the command did not run and nothing in the transcript says it was "
      + "refused; a deny that was never loaded, a crash and a session with no shell tool look identical. " : "")
      + text.slice(0, 400),
  };
}

function probeP2(p1) {
  const root = tmpProject({ permissions: { deny: echoRules("probe-p2") } });
  fs.writeFileSync(path.join(root, ".claude", "settings.local.json"),
    JSON.stringify({ permissions: { allow: echoRules("probe-p2") } }, null, 2));
  const run = cli(["-p", "Run exactly: echo probe-p2-ran. Then print DONE."], { cwd: root });
  const text = (run.stdout || "") + (run.stderr || "");
  // Which file wins is exactly what jig must know before writing either.
  const localWins = text.includes("probe-p2-ran");
  // "The command ran, so the local allow beat the project deny" is only an
  // answer where the project deny could have stopped it. A deny specifier the
  // host ignores produces the identical transcript and no precedence was
  // measured at all — so P2 rides on P1, which is the arm that proves the
  // shape. It is the only arm here whose green reads the same either way.
  const inconclusive = !p1.pass;
  return {
    id: "P2", what: "settings.local.json vs settings.json precedence",
    pass: !inconclusive, inconclusive,
    observed: (inconclusive ? "INCONCLUSIVE — P1 did not establish that a deny of this shape refuses anything, so "
      : "") + (localWins ? "local allow won" : "project deny won") + " — " + text.slice(0, 300),
    localWins,
  };
}

function probeP3() {
  const root = tmpProject({});
  // An "ask" decision in headless mode must fail closed (no TTY to ask), never
  // silently allow. The hook asks for every shell call; the command must not run.
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: SHELL_MATCHER, hooks: [{ type: "command",
        command: "node -e \"console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:'probe'}}))\"" }] }],
    },
  }, null, 2));
  const run = cli(["-p", "Run exactly: echo probe-p3-ran. Then print DONE."], { cwd: root });
  const text = (run.stdout || "") + (run.stderr || "");
  const ran = text.includes("probe-p3-ran");
  // The missing half of the same defect the matcher fix closed: a matcher that
  // never fires and a session that never got a shell tool both leave no output,
  // and `!ran` alone reads either as "the ask failed closed". So the refusal has
  // to be visible before the absence means anything.
  const inconclusive = !ran && !REFUSED.test(text);
  return {
    id: "P3", what: "a PreToolUse ask decision cannot silently allow in headless mode",
    pass: !ran && !inconclusive, inconclusive,
    observed: (inconclusive ? "INCONCLUSIVE — the command did not run and nothing in the transcript says it was refused; "
      + "an ask that never fired looks identical. " : "") + text.slice(0, 400),
  };
}

function main() {
  const version = cli(["--version"]);
  if (version.error || version.status !== 0) {
    process.stderr.write("claude is not runnable from this shell — the probe series needs the real CLI.\n");
    process.exit(1);
  }
  const cliVersion = version.stdout.trim();
  process.stdout.write("probing against " + cliVersion + " — three headless runs, this costs real tokens\n");

  const p1 = probeP1();
  const checks = [p1, probeP2(p1), probeP3()];
  // An arm that concluded nothing does not unlock a capability. Reported as its
  // own word, because "FAIL" would send a maintainer looking for a host that
  // refused something when nothing was measured.
  const green = checks.every((c) => c.pass && !c.inconclusive);
  const record = { cliVersion, green, checks, checkedAt: new Date().toISOString() };
  fs.writeFileSync(RESULTS, JSON.stringify(record, null, 2) + "\n");
  process.stdout.write((green ? "GREEN" : "RED") + " — results written to " + RESULTS + "\n");
  for (const c of checks) {
    process.stdout.write("  " + c.id + " " + (c.inconclusive ? "INCONCLUSIVE" : c.pass ? "pass" : "FAIL") + " — " + c.what + "\n");
  }
  process.exit(green ? 0 : 1);
}

if (require.main === module) main();

module.exports = { RESULTS };
