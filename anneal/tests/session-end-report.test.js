"use strict";

// The session-end report through its real entry point: a Git repository in a temp directory with
// a completed task note old enough to propose folding, a transcript file, and a Claude Code home
// of its own, so the spawned docs-maintenance run never reads the real one.

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
require("./temp-root.js");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const { hostDefaults } = require("../scripts/audit.js");
const { reportLine } = require("../hooks/session-end-report.js");

const HOOK = path.join(__dirname, "..", "hooks", "session-end-report.js");
const DAY = 86400 * 1000;

delete process.env.ANNEAL_SESSION_REPORT;
delete process.env.CLAUDE_PROJECT_DIR;
process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
process.env.CODEX_HOME = path.join(os.tmpdir(), "no-codex-home");

const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
};

function write(root, files) {
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

// A project whose completed task note is ten days old, so docs-maintenance has a proposal.
function project() {
  const root = temp("anneal-session-end-");
  execFileSync("git", ["-C", root, "init", "-q"]);
  write(root, {
    ".gitignore": "docs/tasks/\n",
    "docs/tasks/done.md": "---\ntype: task_summary\nsummary: \"Synthetic fixture.\"\nrelated_files: []\nstatus: completed\n---\n",
  });
  const when = new Date(Date.now() - 10 * DAY);
  fs.utimesSync(path.join(root, "docs/tasks/done.md"), when, when);
  const home = temp("anneal-claude-home-");
  return { root, env: { ...process.env, CLAUDE_CONFIG_DIR: home } };
}

const call = (name, input) => ({ type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", name, input }] } });

// The session's transcript, by default in a folder of its own; in the project's Claude Code folder
// it is also the transcript docs-maintenance reads.
function transcript(records, dir = temp("anneal-transcript-")) {
  const file = path.join(dir, "session.jsonl");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function run({ root, env }, transcriptPath, extraEnv = {}, input) {
  const payload = input ?? JSON.stringify({ session_id: "fixture", transcript_path: transcriptPath, cwd: root, hook_event_name: "SessionEnd", reason: "other" });
  const result = spawnSync(process.execPath, [HOOK], { input: payload, encoding: "utf8", env: { ...env, ...extraEnv } });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}

test("a session that wrote under docs/ gets one line with the counts and the command", () => {
  const fixture = project();
  const { project: folder } = hostDefaults(fixture.root, fixture.env);
  const stdout = run(fixture, transcript([call("Write", { file_path: path.join(fixture.root, "docs", "knowledge", "x.md") })], folder));
  const { systemMessage, ...rest } = JSON.parse(stdout);
  assert.deepStrictEqual(rest, {});
  assert.doesNotMatch(systemMessage, /\n/);
  assert.strictEqual(systemMessage, "anneal: 1 documentation proposal, including 1 unread note. See them with /anneal:repo-docs maintain.");
});

test("without transcripts to read, a completed note is counted but not called unread", () => {
  const fixture = project();
  const stdout = run(fixture, transcript([call("Write", { file_path: path.join(fixture.root, "docs", "knowledge", "x.md") })]));
  assert.strictEqual(JSON.parse(stdout).systemMessage, "anneal: 1 documentation proposal. See them with /anneal:repo-docs maintain.");
});

test("the project comes from CLAUDE_PROJECT_DIR when the session's cwd is a subfolder", () => {
  const fixture = project();
  const payload = JSON.stringify({
    session_id: "fixture",
    transcript_path: transcript([call("Write", { file_path: path.join(fixture.root, "docs", "knowledge", "x.md") })]),
    cwd: path.join(fixture.root, "src"),
    hook_event_name: "SessionEnd",
  });
  assert.match(JSON.parse(run(fixture, null, { CLAUDE_PROJECT_DIR: fixture.root }, payload)).systemMessage, /1 documentation proposal/);
});

test("a stale Git index is left as it was", () => {
  const fixture = project();
  const git = (...args) => execFileSync("git", ["-C", fixture.root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args]);
  write(fixture.root, { "docs/guide.md": "---\ntype: guide\nsummary: \"Synthetic fixture.\"\nrelated_files: []\n---\n" });
  git("add", ".");
  git("commit", "-qm", "fixture");
  // Same content with a new file time, so `git status` would refresh the index.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(fixture.root, "docs/guide.md"), later, later);
  const index = path.join(fixture.root, ".git", "index");
  const before = fs.readFileSync(index);
  const stdout = run(fixture, transcript([call("Edit", { file_path: path.join(fixture.root, "docs", "guide.md") })]));
  assert.match(JSON.parse(stdout).systemMessage, /documentation proposal/);
  assert.ok(fs.readFileSync(index).equals(before), "the index was rewritten");
});

test("a docs/ folder inside a package counts, as docs-maintenance reads it", () => {
  const fixture = project();
  const stdout = run(fixture, transcript([call("Edit", { file_path: `${fixture.root.replace(/\\/g, "/")}/pkg/docs/guide.md` })]));
  assert.match(JSON.parse(stdout).systemMessage, /documentation proposal/);
});

test("a session that wrote elsewhere, or under docs/ only through a shell, prints nothing", () => {
  const fixture = project();
  const stdout = run(fixture, transcript([
    call("Write", { file_path: path.join(fixture.root, "src", "app.js") }),
    call("Bash", { command: "echo x > docs/a.md" }),
    call("Read", { file_path: path.join(fixture.root, "docs", "tasks", "done.md") }),
  ]));
  assert.strictEqual(stdout, "");
});

test("ANNEAL_SESSION_REPORT=off turns the report off", () => {
  const fixture = project();
  const file = transcript([call("Write", { file_path: path.join(fixture.root, "docs", "knowledge", "x.md") })]);
  for (const value of ["off", "0", "FALSE"]) assert.strictEqual(run(fixture, file, { ANNEAL_SESSION_REPORT: value }), "");
});

test("a write into the project's memory folder gets the line", () => {
  const fixture = project();
  const { memory } = hostDefaults(fixture.root, fixture.env);
  write(memory, { "MEMORY.md": "- [Note](note.md) — indexed\n", "note.md": "Indexed.\n" });
  const stdout = run(fixture, transcript([call("Write", { file_path: path.join(memory, "note.md") })]));
  assert.match(JSON.parse(stdout).systemMessage, /documentation proposal/);
});

test("a missing transcript or an unreadable payload prints nothing", () => {
  const fixture = project();
  assert.strictEqual(run(fixture, path.join(fixture.root, "absent.jsonl")), "");
  assert.strictEqual(run(fixture, null, {}, "not json"), "");
  assert.strictEqual(run(fixture, null, {}, "null"), "");
});

test("the line counts proposals in words, and there is none without proposals", () => {
  assert.strictEqual(reportLine({}), null);
  assert.strictEqual(reportLine({ drift: 1 }), "anneal: 1 documentation proposal. See them with /anneal:repo-docs maintain.");
  assert.strictEqual(
    reportLine({ drift: 2, "memory-stale-state": 1, "fold-completed": 2 }),
    "anneal: 5 documentation proposals, including 1 stale memory and 2 unread notes. See them with /anneal:repo-docs maintain."
  );
  assert.strictEqual(
    reportLine({ "memory-stale-state": 3 }),
    "anneal: 3 documentation proposals, including 3 stale memories. See them with /anneal:repo-docs maintain."
  );
  assert.strictEqual(
    reportLine({ "memory-stale-state": 1, "fold-completed": 2 }, false),
    "anneal: 3 documentation proposals, including 1 stale memory. See them with /anneal:repo-docs maintain."
  );
});
