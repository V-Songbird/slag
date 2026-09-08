#!/usr/bin/env node
"use strict";

// Offline acceptance of Jig's owner-control workflow. The decisions below are
// predeclared fixture choices, not a human interview or evidence of host hooks.
// Only a newly created temporary repository is changed. No package manager,
// network request, user configuration, or native Codex session is involved.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const engine = require("../jig.js");
const { fixtureGitEnvironment, withFixtureGitEnvironment } = require("./fixture-isolation.js");

const OPTIONS = Object.freeze({ _: [], change: [] });
const FORBIDDEN = "JIG_OWNER_FIXTURE_FORBIDDEN";
const ALLOWED = "JIG_OWNER_FIXTURE_ALLOWED";
const OWNER_DECISIONS = Object.freeze([
  "Configure the supplied fixture check in observe mode; do not install tools or CI.",
  "Approve only the reviewed change-id/path pairs, including the fenced AGENTS brief and SCOPE pointer.",
  "Arm both admitted guards, then verify fixture denials and allowed near misses.",
  "Request a shell-guard disarm, inspect its pending token, and explicitly approve that token.",
  "Re-arm; record a fixture false-positive judgment, explicitly approve its pending token, clear it, and re-arm.",
  "Revert all journaled changes and compare the original project files byte for byte.",
]);

function fixtureCheck(lever) {
  const id = "owner-" + (lever === "bash-guard" ? "command" : "edit") + "-fixture";
  const detectors = [
    { lever, actor: "codex-session", confidence: "deterministic",
      params: { patterns: [FORBIDDEN], ...(lever === "edit-guard" ? { paths: ["**/*.js"], onlyWhenIntroduced: true } : {}) } },
    { lever: "check-driver", actor: "human-editor", confidence: "deterministic",
      params: { patterns: [FORBIDDEN], paths: ["**/*.js"] } },
  ];
  const values = {
    id, title: "Fixture owner boundary: reject the forbidden marker", severity: "safety",
    actor: "codex-session", confidence: "deterministic",
    fixtures: { violation: FORBIDDEN + "\n", nearMiss: ALLOWED + "\n" },
    deny: { reason: "The fixture owner prohibited this marker.", alternative: "Use the allowed fixture marker.",
      override: "The fixture owner can review and approve a named guard change." },
    detectors: detectors.map((detector, index) => ({ ...detector, id: detector.lever + "-" + index,
      runner: detector.lever === "check-driver" ? "checks" : "PreToolUse" })),
  };
  return { ...values, axes: ["agent"], detectors,
    module: Object.entries(values).map(([key, value]) => "export const " + key + " = " + JSON.stringify(value) + ";").join("\n") + "\n" };
}

function snapshot(root, excludeAudit = true) {
  const files = new Map();
  function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      if (excludeAudit && rel === ".jig") continue;
      assert.equal(entry.isSymbolicLink(), false, "fixture unexpectedly contains a symlink: " + rel);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) files.set(rel, fs.readFileSync(full));
    }
  }
  walk(root, "");
  return files;
}

function digest(files) {
  const hash = crypto.createHash("sha256");
  for (const [rel, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    hash.update(JSON.stringify([rel, bytes.length]) + "\n");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function assertRevertedArtifacts(root, beforeArtifacts) {
  for (const [rel, original] of beforeArtifacts) {
    const full = path.join(root, rel);
    if (original === null) assert.equal(fs.existsSync(full), false, "revert left installed artifact: " + rel);
    else assert.ok(fs.readFileSync(full).equals(original), "revert changed prior artifact bytes: " + rel);
  }
  const auditFiles = [...snapshot(path.join(root, ".jig"), false).keys()];
  const retained = new Set([".gitignore", "discarded.json", "journal.jsonl", "ledger.jsonl", "owner-fixture.json", "profile.json"]);
  for (const rel of auditFiles) {
    assert.ok(retained.has(rel) || /^plan-[0-9a-f]{12}\.(?:json|md)$/.test(rel) || /^preimages\/[0-9a-f]{64}$/.test(rel),
      "revert retained a non-audit artifact: .jig/" + rel);
  }
  return auditFiles;
}

function runOwnerWorkflow(options = {}) {
  const parent = fs.realpathSync(os.tmpdir());
  const workspace = fs.mkdtempSync(path.join(parent, "jig-owner-workflow-"));
  const root = path.join(workspace, "project");
  fs.mkdirSync(root);
  const gitEnvironment = fixtureGitEnvironment(path.join(workspace, "git-isolation"));
  const report = {
    schemaVersion: 1, evidence: "automated-owner-workflow-fixture", ok: false,
    humanInterview: false, nativeHostVerified: false, networkUsed: false, packagesInstalled: false,
    ownerDecisions: [...OWNER_DECISIONS], platform: process.platform, node: process.version,
    project: root, workspace, steps: [],
  };
  const record = (step, detail) => report.steps.push({ step, passed: true, ...detail });
  const applyPair = (change) => engine.cmdApply(root, { ...OPTIONS, change: [change.id || change.change], path: [change.path] });
  const guardRow = (id) => engine.cmdReview(root).guards.find((guard) => guard.guardId === id);
  const runtime = (tool, text) => {
    const command = tool === "Bash" ? text : "*** Begin Patch\n*** Add File: src/fixture-candidate.js\n+" + text + "\n*** End Patch";
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "..", "hooks", "runner.js"), "PreToolUse", "--diagnostic"], {
      cwd: root, windowsHide: true, encoding: "utf8", timeout: 20000,
      // No hook_event_name: these are local synthetic calls, not host-delivery rows.
      input: JSON.stringify({ cwd: root, session_id: "jig-owner-workflow-fixture", tool_name: tool, tool_input: { command } }),
    });
    assert.equal(result.error, undefined, result.error && result.error.message);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.ok(output.jig, "local diagnostic output is missing");
    assert.equal(fs.existsSync(path.join(root, "src", "fixture-candidate.js")), false, "a pre-tool fixture executed its patch");
    return output;
  };
  try {
    withFixtureGitEnvironment(gitEnvironment, () => {
      fs.mkdirSync(path.join(root, "src"));
      fs.mkdirSync(path.join(root, "assets"));
      fs.writeFileSync(path.join(root, "AGENTS.md"), Buffer.from("\ufeff# Owner instructions\r\nPreserve owner text and only change approved paths.\r\n"));
      fs.writeFileSync(path.join(root, "SCOPE.md"), "# Fixture scope\nThe owner permits only the predeclared acceptance workflow.\n");
      fs.writeFileSync(path.join(root, "src", "controlled.js"), "export const marker = '" + ALLOWED + "';\n");
      fs.writeFileSync(path.join(root, "assets", "original.bin"), Buffer.from([0, 255, 13, 10, 128, 7]));
      const git = spawnSync("git", ["init", "-q", "-b", "jig-owner-workflow"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 20000 });
      assert.equal(git.status, 0, git.stderr || "git init failed");
      const original = snapshot(root);
      const originalHash = digest(original);
      record("disposable-project", { originalFiles: original.size, originalSha256: originalHash });

      engine.cmdScan(root, OPTIONS);
      const authored = path.join(root, ".jig", "owner-fixture.json");
      fs.writeFileSync(authored, JSON.stringify({ schemaVersion: 1, checks: [fixtureCheck("bash-guard"), fixtureCheck("edit-guard")] }, null, 2) + "\n");
      const plan = engine.cmdPlan(root, { ...OPTIONS, authored, provenance: "elicited", observe: true,
        "no-ci": true, "agents-region": true, "wire-governance": true });
      assert.ok(plan.changes.length > 0);
      assert.ok(plan.changes.some((change) => change.path === "AGENTS.md"));
      assert.ok(plan.changes.every((change) => ["write-side-file", "write-config", "write-agents-region"].includes(change.kind)), "fixture planned an unexpected mutation kind");
      assert.ok(plan.changes.every((change) => change.path === "AGENTS.md" || change.path.startsWith(".jig/")), "fixture planned an unapproved path");
      assert.ok(plan.consent.item.length > 0);
      assert.throws(() => engine.cmdApply(root, { ...OPTIONS, plan: plan.planId }), /Approve each one by name|Refusing to apply/);
      const first = plan.changes[0];
      assert.throws(() => engine.cmdApply(root, { ...OPTIONS, change: [first.id], path: ["unapproved.txt"] }), /Refusing to apply/);
      assert.deepEqual([...snapshot(root)], [...original], "planning or refused approval changed original project bytes");
      record("reviewed-plan-and-consent-refusals", { planId: plan.planId,
        approvals: plan.changes.map(({ id, path: target, kind }) => ({ id, path: target, kind })) });
      const beforeArtifacts = new Map(plan.changes.filter((change) => change.path.startsWith(".jig/")).map(({ path: target }) => {
        const full = path.join(root, target);
        return [target, fs.existsSync(full) ? fs.readFileSync(full) : null];
      }));
      for (const change of plan.changes) applyPair(change);
      assert.ok(fs.readFileSync(path.join(root, "AGENTS.md")).subarray(0, original.get("AGENTS.md").length).equals(original.get("AGENTS.md")));
      assert.match(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /SCOPE\.md/);
      let review = engine.cmdReview(root);
      assert.equal(review.guards.length, 2);
      assert.ok(review.guards.every((guard) => guard.mode === "observe"));
      assert.equal(review.lanes.session.runs, null);
      record("named-apply-and-review", { guards: review.guards.map(({ guardId, mode }) => ({ guardId, mode })), sessionHostState: review.lanes.session.state });

      assert.equal(runtime("Bash", FORBIDDEN).jig.decision, "would-deny");
      for (const guard of review.guards) engine.cmdArm(root, { ...OPTIONS, guard: guard.guardId });
      for (const tool of ["Bash", "apply_patch"]) {
        const denied = runtime(tool, FORBIDDEN);
        assert.equal(denied.jig.decision, "deny");
        assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
        assert.equal(runtime(tool, ALLOWED).jig.decision, "pass");
      }
      const selftest = engine.cmdSelftest(root, { ...OPTIONS, live: true });
      assert.equal(selftest.witnessed, true);
      assert.ok(selftest.probes.filter((probe) => probe.kind === "guard").every((probe) => probe.caught === true && probe.hostVerified === false));
      record("armed-runtime-fixtures", { evidence: "local-runtime-replay", nativeHostVerified: false,
        denied: ["Bash", "apply_patch"], nearMissPassed: ["Bash", "apply_patch"], selftestWitnessed: true });

      const shellGuard = review.guards.find((guard) => guard.guardId.includes("bash-guard")).guardId;
      const configPath = path.join(root, ".jig", "config.json");
      const beforeDisarm = fs.readFileSync(configPath);
      const disarm = engine.cmdDisarm(root, { ...OPTIONS, guard: shellGuard });
      assert.equal(disarm.applied, false);
      assert.ok(fs.readFileSync(configPath).equals(beforeDisarm));
      assert.equal(runtime("Bash", FORBIDDEN).jig.decision, "deny");
      assert.throws(() => engine.cmdApply(root, { ...OPTIONS, change: [disarm.change], path: ["src/controlled.js"] }), /Refusing to apply/);
      applyPair(disarm);
      assert.equal(runtime("Bash", FORBIDDEN).jig.decision, "would-deny");
      engine.cmdArm(root, { ...OPTIONS, guard: shellGuard });
      assert.equal(guardRow(shellGuard).mode, "armed");
      record("disarm-requires-approved-token", { guard: shellGuard, approval: { change: disarm.change, path: disarm.path }, rearmed: true });

      const beforeFp = fs.readFileSync(configPath);
      const fp = engine.cmdFp(root, { ...OPTIONS, guard: shellGuard, session: "jig-owner-workflow-fixture" });
      assert.equal(fp.recorded, "false-positive-pending");
      assert.equal(fp.applied, false);
      assert.ok(fs.readFileSync(configPath).equals(beforeFp));
      assert.equal(runtime("Bash", FORBIDDEN).jig.decision, "deny");
      applyPair(fp);
      assert.equal(runtime("Bash", FORBIDDEN).jig.decision, "would-deny");
      engine.cmdFp(root, { ...OPTIONS, guard: shellGuard, clear: true, session: "jig-owner-workflow-fixture" });
      engine.cmdArm(root, { ...OPTIONS, guard: shellGuard });
      assert.equal(runtime("Bash", FORBIDDEN).jig.decision, "deny");
      review = engine.cmdReview(root);
      record("false-positive-requires-approved-token", { judgment: "predeclared fixture decision, not a measured false positive",
        guard: shellGuard, approval: { change: fp.change, path: fp.path }, cleared: true, rearmed: true,
        evaluated: guardRow(shellGuard).evaluated, sessionHostState: review.lanes.session.state });

      const reverted = engine.cmdRevert(root, { ...OPTIONS, all: true });
      assert.ok(reverted.reverted.length > 0);
      const restored = snapshot(root);
      assert.deepEqual([...restored.keys()], [...original.keys()], "revert left or removed project files");
      for (const [rel, bytes] of original) assert.ok(restored.get(rel).equals(bytes), "revert changed original bytes: " + rel);
      assert.equal(digest(restored), originalHash);
      const auditFiles = assertRevertedArtifacts(root, beforeArtifacts);
      assert.equal(engine.cmdRevert(root, { ...OPTIONS, all: true }).reverted.length, 0);
      assert.deepEqual(assertRevertedArtifacts(root, beforeArtifacts), auditFiles);
      record("full-journal-revert", { exactOriginalProjectBytes: true, comparedFiles: original.size,
        originalSha256: originalHash, restoredSha256: digest(restored), idempotent: true,
        restoredInstallPaths: [...beforeArtifacts.keys()],
        retainedAudit: { directory: ".jig", files: auditFiles,
          explanation: "Only named audit/plan/preimage records, the fixture input, and audit ignore/profile metadata remain; each approved install path was checked separately." } });
      report.ok = true;
    });
  } catch (error) {
    report.error = { message: error.message, stack: error.stack };
  }
  report.kept = options.keep === true || !report.ok;
  if (!report.kept) {
    // Only this exact mkdtemp result; never a caller-supplied deletion target.
    assert.equal(path.dirname(path.resolve(workspace)), parent);
    assert.ok(path.basename(workspace).startsWith("jig-owner-workflow-"));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  return report;
}

function main(argv = process.argv.slice(2)) {
  if (argv.some((arg) => arg !== "--keep")) throw new Error("Usage: node scripts/probes/owner-workflow.js [--keep]");
  const report = runOwnerWorkflow({ keep: argv.includes("--keep") });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.ok ? 0 : 1;
}
if (require.main === module) main();
module.exports = { runOwnerWorkflow, assertRevertedArtifacts };
