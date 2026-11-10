"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// Runs one fixture with the arguments that npm run check passes to node.
function check(fixture) {
  const [command, ...args] = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts.check.split(" ");
  assert.equal(command, "node");
  return spawnSync(process.execPath, [...args, path.join(__dirname, "fixtures", fixture)], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
}

test("npm run check fails when a suite throws while defining its tests", () => {
  const run = check("suite-throws.js");
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /Suite failed outside its tests: "a suite that throws while defining its tests" \(.+suite-throws\.js:\d+\): fixture setup failed/);
});

test("npm run check fails when a suite's after hook throws", () => {
  const run = check("after-hook-throws.js");
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /Suite failed outside its tests: "a suite whose after hook throws" \(.+after-hook-throws\.js:\d+\): failed running after hook/);
});

test("the guard's line adds a hook's own error and never repeats a message", () => {
  assert.match(check("after-hook-throws.js").stderr, /: failed running after hook: fixture cleanup failed$/m);
  assert.match(check("suite-throws.js").stderr, /\): fixture setup failed$/m);
});

test("npm run check passes a suite that defines its tests", () => {
  const run = check("suite-passes.js");
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stderr, /Suite failed/);
});

test("a passing run prints its counts and no line for a test that passed", () => {
  const run = check("suite-passes.js");
  assert.match(run.stdout, /^ℹ pass [1-9]\d*$/m);
  assert.match(run.stdout, /^ℹ fail 0$/m);
  assert.doesNotMatch(run.stdout, /✔/);
  assert.ok(run.stdout.split("\n").length < 15, run.stdout);
});

test("a failing run prints the failed test with its file, line and both values, and not the test that passed", () => {
  const run = check("one-test-fails.js");
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^✖ a fixture test that fails \(.+one-test-fails\.js:\d+\)$/m);
  assert.match(run.stdout, /actual total/);
  assert.match(run.stdout, /expected total/);
  assert.doesNotMatch(run.stdout, /a fixture test that passes/);
  assert.match(run.stdout, /^ℹ fail 1$/m);
});

test("check:verbose is the same run with the spec reporter on stdout", () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  assert.equal(scripts["check:verbose"], scripts.check.replace("./scripts/quiet-reporter.js", "spec"));
});
