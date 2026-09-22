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
