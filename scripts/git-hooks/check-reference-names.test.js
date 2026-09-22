"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { scanText } = require("./check-reference-names.js");

const script = path.join(__dirname, "check-reference-names.js");

function fixture(t, files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "reference-gate-test-"));
  const project = path.join(root, "project");
  mkdirSync(project);
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("reference-gate-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  for (const [name, contents] of Object.entries(files)) {
    const destination = path.join(root, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents, "utf8");
  }
  return { root, project };
}

function runHook(project, mode = "message", extraEnv = {}) {
  const env = { ...process.env };
  delete env.HOUSE_REFERENCE_BLOCKLIST;
  return spawnSync(process.execPath, [script, mode, path.join(project, "message.txt")], {
    cwd: project,
    encoding: "utf8",
    env: { ...env, ...extraEnv },
  });
}

function git(project, args) {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("a standalone clone without a blocklist fails open", (t) => {
  const { project } = fixture(t, {
    "project/message.txt": "sample-project-alpha\n",
  });
  for (const mode of ["message", "staged"]) {
    const result = runHook(project, mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  }
});

test("the canonical private blocklist filters comments and scans messages", (t) => {
  const { project } = fixture(t, {
    "project/.private/reference-names.txt": "# Local names\n\n  sample-project-alpha  \r\n",
    "project/message.txt": "An ordinary summary\nUse SAMPLE-PROJECT-ALPHA here.\n",
  });
  const result = runHook(project);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /commit message:2: contains "sample-project-alpha"/);
  assert.match(result.stderr, /docs\/knowledge\/private\//);
});

test("an empty local list falls back to the parent private blocklist", (t) => {
  const { project } = fixture(t, {
    ".private/reference-names.txt": "sample-project-alpha\n",
    "project/.private/reference-names.txt": "# No local names\n\n",
    "project/message.txt": "sample-project-alpha\n",
  });
  const result = runHook(project);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contains "sample-project-alpha"/);
});

test("a local blocklist takes precedence over the parent blocklist", (t) => {
  const { project } = fixture(t, {
    ".private/reference-names.txt": "sample-project-alpha\n",
    "project/.private/reference-names.txt": "sample-project-beta\n",
    "project/message.txt": "sample-project-alpha\n",
  });
  const result = runHook(project);
  assert.equal(result.status, 0, result.stderr);
});

test("an explicit blocklist takes precedence over the canonical location", (t) => {
  const { root, project } = fixture(t, {
    "override.txt": "sample-project-beta\n",
    "project/.private/reference-names.txt": "sample-project-alpha\n",
    "project/message.txt": "sample-project-beta\n",
  });
  const result = runHook(project, "message", {
    HOUSE_REFERENCE_BLOCKLIST: path.join(root, "override.txt"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contains "sample-project-beta"/);
});

test("matching is case insensitive, bounded, and literal", () => {
  assert.deepEqual(scanText("alpha beta\n(ALPHA.BETA)\nxalpha.betay", ["alpha.beta"], "fixture"), [
    'fixture:2: contains "alpha.beta"',
  ]);
});

test("an unreadable message still fails open when the list exists", (t) => {
  const { project } = fixture(t, {
    "project/.private/reference-names.txt": "sample-project-alpha\n",
  });
  const result = runHook(project);
  assert.equal(result.status, 0, result.stderr);
});

test("staged scanning checks added contents, excluding filenames and unstaged text", (t) => {
  const { project } = fixture(t, {
    "project/.gitignore": ".private/\n",
    "project/.private/reference-names.txt": "sample-project-alpha\n",
    "project/sample-project-alpha.txt": "An ordinary public description.\n",
  });
  git(project, ["init", "-q"]);
  git(project, ["add", "--", "sample-project-alpha.txt"]);
  writeFileSync(path.join(project, "sample-project-alpha.txt"), "Mention SAMPLE-PROJECT-ALPHA.\n");

  const cleanStage = runHook(project, "staged");
  assert.equal(cleanStage.status, 0, cleanStage.stderr);

  git(project, ["add", "--", "sample-project-alpha.txt"]);
  const blockedStage = runHook(project, "staged");
  assert.equal(blockedStage.status, 1);
  assert.match(blockedStage.stderr, /staged change:1: contains "sample-project-alpha"/);
});
