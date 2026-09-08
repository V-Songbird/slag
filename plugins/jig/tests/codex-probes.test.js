"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fixtureGitEnvironment } = require("../scripts/probes/fixture-isolation.js");
const { runOwnerWorkflow, assertRevertedArtifacts } = require("../scripts/probes/owner-workflow.js");
const { prepareProject, evaluateHostChecks, runCli } = require("../scripts/probes/codex-host.js");

function temporary(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "jig-probe-integrity-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith("jig-probe-integrity-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
const gitVariables = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => /^GIT_/i.test(key)));
function replaceGit(values) {
  for (const key of Object.keys(process.env)) if (/^GIT_/i.test(key)) delete process.env[key];
  Object.assign(process.env, values);
}
function snapshot(root) {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const full = path.join(root, entry.name);
    return entry.isDirectory()
      ? snapshot(full).map(([name, bytes]) => [entry.name + "/" + name, bytes])
      : [[entry.name, fs.readFileSync(full)]];
  });
}

test("owner and host fixture preparation ignore hostile Git routing, config and templates", (t) => {
  const root = temporary(t);
  const sentinel = path.join(root, "sentinel-repository");
  fs.mkdirSync(sentinel);
  const clean = fixtureGitEnvironment(path.join(root, "sentinel-git"));
  const initialized = spawnSync("git", ["init", "-q", "-b", "sentinel"], { cwd: sentinel, env: clean, encoding: "utf8", windowsHide: true, timeout: 20000 });
  assert.equal(initialized.status, 0, initialized.stderr);
  fs.appendFileSync(path.join(sentinel, ".git", "config"), "\n[sentinel]\n\tvalue = preserve-this\n");
  fs.writeFileSync(path.join(sentinel, "sentinel.bin"), Buffer.from([0, 255, 13, 10, 7]));
  const template = path.join(root, "hostile-template");
  fs.mkdirSync(template);
  fs.writeFileSync(path.join(template, "must-not-be-copied"), "owner template");
  const config = path.join(root, "hostile-config");
  fs.writeFileSync(config, "[core]\n\thooksPath = " + JSON.stringify(path.join(sentinel, ".git", "hooks").replace(/\\/g, "/")) + "\n");
  const before = snapshot(sentinel);
  const original = gitVariables();
  const hostile = {
    GIT_DIR: path.join(sentinel, ".git"), GIT_COMMON_DIR: path.join(sentinel, ".git"),
    GIT_WORK_TREE: sentinel, GIT_INDEX_FILE: path.join(sentinel, ".git", "sentinel-index"),
    GIT_CONFIG: path.join(sentinel, ".git", "config"), GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: config, GIT_TEMPLATE_DIR: template,
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: path.join(sentinel, ".git", "hooks"),
  };
  try {
    replaceGit(hostile);
    const owner = runOwnerWorkflow();
    assert.equal(owner.ok, true, JSON.stringify(owner.error));
    assert.deepEqual(gitVariables(), hostile, "owner workflow did not restore caller Git environment");
    const hostEnvironment = fixtureGitEnvironment(path.join(root, "host-git"));
    const project = path.join(root, "host-project");
    prepareProject(project, hostEnvironment);
    assert.ok(fs.existsSync(path.join(project, ".git", "HEAD")), "host fixture did not initialize its own Git repository");
    assert.equal(fs.existsSync(path.join(project, ".git", "must-not-be-copied")), false);
    assert.equal(hostEnvironment.GIT_DIR, undefined);
    assert.equal(hostEnvironment.GIT_CONFIG_COUNT, undefined);
    assert.equal(fs.readFileSync(hostEnvironment.GIT_CONFIG_GLOBAL, "utf8"), "");
    assert.equal(fs.readFileSync(hostEnvironment.GIT_CONFIG_SYSTEM, "utf8"), "");
    assert.deepEqual(gitVariables(), hostile, "host preparation did not restore caller Git environment");
    assert.deepEqual(snapshot(sentinel), before, "fixture preparation modified the sacrificial caller repository");
  } finally {
    replaceGit(original);
  }
  assert.deepEqual(gitVariables(), original);
});

test("full reversal rejects leftover installed files and unknown .jig artifacts", (t) => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, ".jig", "checks"), { recursive: true });
  const installed = ".jig/checks/left-behind.check.mjs";
  fs.writeFileSync(path.join(root, installed), "export const stale = true;\n");
  assert.throws(() => assertRevertedArtifacts(root, new Map([[installed, null]])), /left installed artifact/);
  fs.unlinkSync(path.join(root, installed));
  fs.writeFileSync(path.join(root, ".jig", "verify.json"), "{}");
  assert.throws(() => assertRevertedArtifacts(root, new Map([[installed, null]])), /non-audit artifact/);
  fs.unlinkSync(path.join(root, ".jig", "verify.json"));
  fs.writeFileSync(path.join(root, ".jig", "profile.json"), "{}");
  assert.deepEqual(assertRevertedArtifacts(root, new Map([[installed, null]])), ["profile.json"]);
});

function evidence(t) {
  const project = temporary(t);
  fs.writeFileSync(path.join(project, "safe-edit.js"), "JIG_PROBE_SAFE();\n");
  const native = { host: "codex", actor: "codex-session", session: "probe-session" };
  const rows = [
    ...["probe-command", "probe-edit"].map((classId) => ({ ...native, classId, decision: "deny" })),
    ...["probe-pass", "probe-fail"].map((verify) => ({ ...native, verify, tool: "Bash", event: "PostToolUse", decision: "verify-unknown", exitCode: null })),
    { verify: "probe-pass", decision: "verified", exitCode: 0, lane: "commit", tool: null, session: null },
    { verify: "probe-fail", decision: "verify-failed", exitCode: 3, lane: "commit", tool: null, session: null },
  ];
  return { project, rows, execution: { code: 0, timedOut: false }, requestCount: 8, expectedRequests: 8, serverError: null };
}

test("host evidence rejects fabricated raw outcomes alongside unknown rows", (t) => {
  const input = evidence(t);
  assert.ok(Object.values(evaluateHostChecks(input)).every(Boolean));
  input.rows.push({ ...input.rows[2], decision: "verified", exitCode: 0 });
  assert.equal(evaluateHostChecks(input).rawShellOutcomesNotInvented, false);
  input.rows.pop();
  input.rows[2].exitCode = 0;
  assert.equal(evaluateHostChecks(input).rawShellOutcomesNotInvented, false);
});

test("host evidence requires exact near-miss bytes and actual driver witnesses", (t) => {
  const input = evidence(t);
  fs.writeFileSync(path.join(input.project, "safe-edit.js"), "");
  assert.equal(evaluateHostChecks(input).nearMissAllowed, false);
  input.rows[4].tool = "Bash";
  input.rows[5].host = "codex";
  const checks = evaluateHostChecks(input);
  assert.equal(checks.driverPassingVerificationRecorded, false);
  assert.equal(checks.driverFailingVerificationRecorded, false);
  input.execution.timedOut = true;
  assert.equal(evaluateHostChecks(input).hostExited, false);
});

test("host subprocess timeout terminates its descendant tree", { timeout: 12000 }, async (t) => {
  const root = temporary(t);
  const sentinel = path.join(root, "descendant-survived");
  const script = "const child = require('node:child_process').spawn(process.execPath, ['-e', \"setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'survived'), 2500)\", process.argv[1]], { stdio: 'inherit' }); console.log('descendant-started:' + child.pid); setInterval(() => {}, 1000);";
  const started = Date.now();
  const result = await runCli({ command: process.execPath, prefix: [] }, ["-e", script, sentinel], { cwd: root }, 1000);
  assert.equal(result.timedOut, true);
  assert.match(result.stdout, /descendant-started:\d+/);
  assert.ok(Date.now() - started < 5000, "the subprocess timeout did not settle promptly");
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, 3800 - (Date.now() - started))));
  assert.equal(fs.existsSync(sentinel), false, "a descendant survived the probe timeout");
});
