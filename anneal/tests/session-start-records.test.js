"use strict";

// The session-start line through its real entry point: a Git repository in a temp directory with
// task notes and, in some tests, a record index.

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
require("./temp-root.js");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const HOOK = path.join(__dirname, "..", "hooks", "session-start-records.js");

delete process.env.ANNEAL_SESSION_REPORT;
delete process.env.CLAUDE_PROJECT_DIR;
process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();

const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

const note = (status) => `---\ntype: task_summary\nsummary: "Synthetic fixture."\nrelated_files: []\nstatus: ${status}\n---\n`;

function project(files, git = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anneal-session-start-"));
  created.push(root);
  if (git) execFileSync("git", ["-C", root, "init", "-q"]);
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function run(root, extraEnv = {}, input) {
  const payload = input ?? JSON.stringify({ session_id: "fixture", cwd: root, hook_event_name: "SessionStart", source: "startup" });
  const result = spawnSync(process.execPath, [HOOK], { input: payload, encoding: "utf8", env: { ...process.env, ...extraEnv } });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}

const context = (stdout) => {
  const { hookSpecificOutput, ...rest } = JSON.parse(stdout);
  assert.deepStrictEqual(rest, {});
  assert.strictEqual(hookSpecificOutput.hookEventName, "SessionStart");
  return hookSpecificOutput.additionalContext;
};

test("completed notes are counted and named, ignored ones included, and the index is located", () => {
  const root = project({
    ".gitignore": "docs/tasks/\n",
    "docs/tasks/1-done.md": note("completed"),
    "docs/tasks/2-open.md": note("active"),
    "pkg/docs/tasks/3-done.md": note("completed"),
    "docs/index.md": "# Record index\n",
  });
  assert.strictEqual(
    context(run(root)),
    "anneal: 2 completed task notes are still on disk: docs/tasks/1-done.md, pkg/docs/tasks/3-done.md. Fold each one's findings into its topic documents, then ask the owner before deleting it. Record index: docs/index.md; search it before guessing a docs path."
  );
});

test("with no completed note and no index, the line says only that the index is missing", () => {
  const root = project({ "docs/tasks/2-open.md": note("active") });
  assert.strictEqual(context(run(root)), "anneal: No record index at docs/index.md; anneal's repo-docs skill writes one in its adopt mode.");
});

test("past ten notes the rest are counted, not listed", () => {
  const files = {};
  for (let i = 10; i < 22; i++) files[`docs/tasks/${i}-done.md`] = note("completed");
  const line = context(run(project(files)));
  assert.match(line, /^anneal: 12 completed task notes are still on disk: docs\/tasks\/10-done\.md, /);
  assert.match(line, /docs\/tasks\/19-done\.md and 2 more\. /);
  assert.doesNotMatch(line, /20-done/);
});

test("one note reads in the singular, and a task_summary outside docs/tasks counts", () => {
  const root = project({ "docs/knowledge/misfiled.md": note("completed") });
  assert.match(context(run(root)), /^anneal: 1 completed task note is still on disk: docs\/knowledge\/misfiled\.md\. /);
});

test("the working tree's root is used from a subfolder, and CLAUDE_PROJECT_DIR wins over cwd", () => {
  const root = project({ "docs/tasks/1-done.md": note("completed"), "src/app.js": "" });
  const from = (cwd) => JSON.stringify({ session_id: "fixture", cwd, hook_event_name: "SessionStart" });
  assert.match(context(run(root, {}, from(path.join(root, "src")))), /1 completed task note/);
  assert.match(context(run(root, { CLAUDE_PROJECT_DIR: root }, from(os.tmpdir()))), /1 completed task note/);
});

test("a folder outside Git is still read", () => {
  const root = project({ "docs/tasks/1-done.md": note("completed") }, false);
  assert.match(context(run(root)), /1 completed task note/);
});

test("a project with no Markdown under docs/ prints nothing", () => {
  assert.strictEqual(run(project({ "README.md": "# Fixture\n", "src/app.js": "" })), "");
});

test("ANNEAL_SESSION_REPORT=off turns the line off", () => {
  const root = project({ "docs/tasks/1-done.md": note("completed") });
  for (const value of ["off", "0", "FALSE"]) assert.strictEqual(run(root, { ANNEAL_SESSION_REPORT: value }), "");
});

test("an unreadable payload prints nothing", () => {
  const root = project({ "docs/tasks/1-done.md": note("completed") });
  assert.strictEqual(run(root, {}, "not json"), "");
  assert.strictEqual(run(root, {}, "null"), "");
});

test("the hook leaves the working tree as it was", () => {
  const root = project({ "docs/tasks/1-done.md": note("completed") });
  const before = execFileSync("git", ["-C", root, "status", "--porcelain", "--ignored"], { encoding: "utf8" });
  run(root);
  assert.strictEqual(execFileSync("git", ["-C", root, "status", "--porcelain", "--ignored"], { encoding: "utf8" }), before);
  assert.ok(fs.existsSync(path.join(root, "docs/tasks/1-done.md")));
});
