"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const engine = require("../scripts/jig.js");
const A = require("./authored.js");
const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jig-activation-coverage-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), '{"private":true}\n');
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "owner.js"), "export const owner = true;\n");
  return root;
}
function accurateGuidance(text) {
  const flat = text.replace(/\s+/g, " ");
  assert.match(flat, /Session-only detectors do not gain commit or CI coverage from this wiring/);
  assert.match(flat, /CI coverage requires a configured workflow/);
  assert.doesNotMatch(flat, /checks already run in CI|checks run in CI|run in CI too|CI still|CI catches everything|Nothing below is needed to stay covered|convenience, not safety/i);
}

for (const source of [A.PIPED_INSTALLER, A.EMPTY_CATCH]) {
  test("session-only " + source.id + " activation does not promise commit or CI coverage", () => {
    const root = project();
    const check = A.authored({ ...source, detectors: source.detectors.filter((detector) => detector.actor === "codex-session") });
    const plan = engine.cmdPlan(root, { _: [], change: [], authored: A.writeChecks(root, [check]), provenance: "elicited", "no-ci": true });
    assert.equal(plan.changes.some((change) => change.path === ".github/workflows/jig.yml"), false);
    const payload = engine.planFiles(root).map(engine.readPlan).find((item) => item.planId === plan.planId);
    const activation = payload.changes.find((change) => change.path === ".jig/activation.md");
    assert.ok(activation);
    accurateGuidance(activation.content);
    const applied = A.applyPlan(engine, root, plan);
    const proposal = applied.proposals.find((note) => note.includes("activation.md"));
    accurateGuidance(proposal);
    const review = engine.cmdReview(root);
    assert.equal(review.lanes.ci.runs, false);
    assert.equal(review.lanes.commit.runs, false);
    assert.equal(review.guards.length, 1);
    engine.cmdRevert(root, { _: [], change: [], all: true });
    assert.equal(fs.readFileSync(path.join(root, "src", "owner.js"), "utf8"), "export const owner = true;\n");
    assert.equal(fs.existsSync(path.join(root, ".jig", "activation.md")), false);
  });
}

test("every activation face distinguishes configured wiring from check and CI coverage", () => {
  for (const entry of engine.templateIndex().filter((entry) => entry.name.startsWith("activation"))) {
    const body = engine.templateBody(entry);
    accurateGuidance(body);
    assert.match(body.replace(/\s+/g, " "), /no coverage from (?:this hook|Jig's driver)/);
    if (entry.name !== "activation") {
      assert.match(body, /Commit hook wiring is configured/);
      assert.match(body, /does not establish that a check has run/);
      assert.doesNotMatch(body, /checks are running|Nothing here is a task/);
    }
  }
});

test("missing-node commit shim discloses skipped coverage without assuming CI", (t) => {
  const found = process.platform === "win32"
    ? spawnSync("where.exe", ["sh"], { encoding: "utf8", windowsHide: true })
    : spawnSync("sh", ["-c", "command -v sh"], { encoding: "utf8" });
  let shell = String(found.stdout || "").trim().split(/\r?\n/)[0];
  if ((!shell || !fs.existsSync(shell)) && process.platform === "win32") {
    const git = spawnSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true });
    for (const executable of String(git.stdout || "").trim().split(/\r?\n/)) {
      const candidate = path.resolve(path.dirname(executable), "..", "bin", "sh.exe");
      if (fs.existsSync(candidate)) { shell = candidate; break; }
    }
  }
  if (!shell || !fs.existsSync(shell)) return t.skip("POSIX shell unavailable");
  const root = project();
  fs.mkdirSync(path.join(root, ".jig"));
  const emptyPath = path.join(root, "empty-path");
  fs.mkdirSync(emptyPath);
  const entry = engine.templateIndex().find((entry) => entry.name === "hook-shim");
  const shim = path.join(root, "pre-commit");
  fs.writeFileSync(shim, engine.templateBody(entry));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  env.PATH = emptyPath;
  const run = spawnSync(shell, [shim], { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /checks were skipped/);
  assert.match(run.stderr, /This hook provided no check coverage; inspect CI separately/);
  assert.doesNotMatch(run.stderr, /CI still|CI.*runs them/);
  assert.match(fs.readFileSync(path.join(root, ".jig", "lane.log"), "utf8"), /skipped node-not-on-path/);
});
