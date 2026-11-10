"use strict";

// The overview script on a small Git repository in a temp directory, through its real entry point: one part per
// script it runs, the skill each part names, and what it says when a script has nothing to read.

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
require("./temp-root.js");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "scripts", "overview.js");

// Keep git from treating a temp directory as part of a repository above it.
process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();

const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

// A repository with two files of one name and no map file, and host homes that hold no session.
function repo() {
  const root = temp("anneal-overview-");
  execFileSync("git", ["-C", root, "init", "-q"]);
  for (const file of ["src/cart/format.js", "src/order/format.js"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "module.exports = {};\n");
  }
  return root;
}

// The scripts find global instruction files, native memory and sessions under the home directory, so the run gets an
// empty one.
const HOME = temp("anneal-overview-user-");
const ENV = { ...process.env, HOME, USERPROFILE: HOME };
for (const name of ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_PROJECT_DIR"]) delete ENV[name];

function run(args) {
  const empty = temp("anneal-overview-home-");
  return spawnSync(process.execPath, [CLI, ...args, "--claude-home", empty, "--codex-home", empty], { encoding: "utf8", env: ENV });
}

test("each part names its skill, what its script found and what to run next", () => {
  const root = repo();
  const ran = run(["--root", root, "--json"]);
  assert.strictEqual(ran.status, 0, ran.stderr);
  const report = JSON.parse(ran.stdout);
  assert.deepStrictEqual(report.parts.map((part) => [part.part, part.skill]), [
    ["Navigation", "repo-layout"], ["Documentation", "repo-docs"], ["Past sessions", "session-review"], ["This session", "session-review"],
  ]);
  const [navigation, documentation, sessions] = report.parts;
  assert.match(navigation.found, /no map file/);
  assert.strictEqual(navigation.next, "repo-layout audit");
  assert.strictEqual(navigation.counts.mapFiles, 0);
  assert.deepStrictEqual([documentation.found, documentation.next], ["no maintained records under docs/", "repo-docs adopt"]);
  // A project with no session gets the repeated-step search's own message, not a count of zero.
  assert.strictEqual(sessions.found, null);
  assert.match(sessions.note, /no session found to read/);
  assert.strictEqual(sessions.next, null);
});

test("the text form prints two lines per part, and --no-sessions leaves past sessions unread", () => {
  const root = repo();
  const ran = run(["--root", root, "--no-sessions"]);
  assert.strictEqual(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^Navigation {2,}.*no map file.*\n {2,}next: repo-layout audit$/m);
  assert.match(ran.stdout, /^Documentation {2,}no maintained records under docs\/\n {2,}next: repo-docs adopt$/m);
  assert.doesNotMatch(ran.stdout, /^Past sessions/m);
  assert.match(ran.stdout, /\/anneal:<name> on Claude Code, \$<name> on Codex or \/<name> on Antigravity/);
});

test("the same repository prints the same bytes twice, and nothing is written in it", () => {
  const root = repo();
  const before = execFileSync("git", ["-C", root, "status", "--porcelain", "--ignored"], { encoding: "utf8" });
  const runs = [1, 2].map(() => run(["--root", root, "--json", "--no-sessions"]).stdout);
  assert.strictEqual(runs[0], runs[1]);
  assert.strictEqual(execFileSync("git", ["-C", root, "status", "--porcelain", "--ignored"], { encoding: "utf8" }), before);
});

test("a directory outside Git still gets its navigation line, and bad arguments exit 2", () => {
  const dir = temp("anneal-overview-plain-");
  fs.writeFileSync(path.join(dir, "a.js"), "");
  const ran = run(["--root", dir, "--json", "--no-sessions"]);
  assert.strictEqual(ran.status, 0, ran.stderr);
  const [navigation, documentation] = JSON.parse(ran.stdout).parts;
  assert.strictEqual(navigation.skill, "repo-layout");
  assert.strictEqual(documentation.found, null);
  assert.ok(documentation.note.length > 0);
  for (const args of [[], ["--root"], ["--root", dir, "--verbose"]]) assert.strictEqual(spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: ENV }).status, 2);
});
