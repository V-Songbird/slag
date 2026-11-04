"use strict";

// The close-out check on synthetic Claude Code transcripts and a temporary Git repository: where each change the
// session made lives now, which turns ended in text only the transcript holds, and the verdict.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { tempDir, transcript, human, use, result, say, meta, started } = require("./session-transcripts.js");
const { closeout } = require("../scripts/session-closeout.js");

const CLI = path.join(__dirname, "..", "scripts", "session-closeout.js");

// GIT_CONFIG_NOSYSTEM drops the system core.longpaths that Git for Windows sets, so the isolated global config restores
// it; the script's own Git queries, here and in a child process, read the same config.
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(tempDir(), "config");
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[core]\n\tlongpaths = true\n");
const git = (dir, ...args) => execFileSync("git", [
  "-c", "core.longpaths=true", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args,
], { cwd: dir, stdio: "pipe", encoding: "utf8" });

// A repository with one committed file, src/cart.js, that ignores notes/.
function repository() {
  const dir = tempDir();
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, ".gitignore"), "notes/\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "cart.js"), "export const total = (cents) => cents / 100;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "initial");
  return dir;
}

const write = (dir, file, content) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};

// The first turn fixes the cart and ends in text; the session works in the repository.
const fixTurn = (dir) => [
  { ...human("fix the cart total", 1), cwd: dir },
  use("e1", "Edit", { file_path: "src/cart.js", old_string: "cents / 100", new_string: "Math.round(cents) / 100" }, 2),
  result("e1", "The file has been updated.", 3),
  say("s1", "Fixed the rounding in cart.js", 4),
];

describe("the verdict", () => {
  test("a session whose every turn wrote a tracked or ignored file is safe to delete", () => {
    const dir = repository();
    const file = transcript([
      ...fixTurn(dir),
      { ...human("record the decision", 5), cwd: dir },
      use("w1", "Write", { file_path: "notes/decision.md", content: "Totals round half-up." }, 6),
      result("w1", "File created successfully.", 7),
      say("s2", "Decision: totals round half-up; recorded in notes/decision.md", 8),
    ]);
    write(dir, "src/cart.js", "export const total = (cents) => Math.round(cents) / 100;\n");
    git(dir, "commit", "-qam", "round");
    write(dir, "notes/decision.md", "Totals round half-up.\n");

    const report = closeout(file, dir);
    assert.strictEqual(report.verdict, "safe-to-delete");
    assert.deepStrictEqual(report.wouldLose, []);
    const changes = report.items.filter((item) => item.kind === "change");
    assert.deepStrictEqual(changes.map(({ location, uncommitted, callLines, atRisk }) => ({ location, uncommitted, callLines, atRisk })), [
      { location: "tracked", uncommitted: false, callLines: [2], atRisk: false },
      { location: "ignored", uncommitted: false, callLines: [6], atRisk: false },
    ]);
    const turns = report.items.filter((item) => item.kind === "turn");
    assert.deepStrictEqual(turns.map(({ promptLine, endingLine, location }) => ({ promptLine, endingLine, location })), [
      { promptLine: 1, endingLine: 4, location: "file" },
      { promptLine: 5, endingLine: 8, location: "file" },
    ]);
    assert.strictEqual(turns[1].prompt, "record the decision");
    assert.strictEqual(turns[1].ending, "Decision: totals round half-up; recorded in notes/decision.md");
  });

  test("a decision stated in a turn that wrote nothing is what deletion would lose", () => {
    const dir = repository();
    const file = transcript([
      ...fixTurn(dir),
      { ...human("which rounding should we use?", 5), cwd: dir },
      say("s2", "Decision: round half-up at checkout", 6),
    ]);
    write(dir, "src/cart.js", "export const total = (cents) => Math.round(cents) / 100;\n");
    const report = closeout(file, dir);
    assert.strictEqual(report.verdict, "would-lose");
    assert.deepStrictEqual(report.wouldLose, [{ kind: "turn", endingLine: 6 }]);
    const decision = report.items.find((item) => item.kind === "turn" && item.endingLine === 6);
    assert.deepStrictEqual({ location: decision.location, wrote: decision.wrote, atRisk: decision.atRisk },
      { location: "transcript-only", wrote: [], atRisk: true });
    // The uncommitted edit still lives in the tracked file.
    const change = report.items.find((item) => item.kind === "change");
    assert.deepStrictEqual({ location: change.location, uncommitted: change.uncommitted, atRisk: change.atRisk },
      { location: "tracked", uncommitted: true, atRisk: false });
  });

  test("a decision stated before the turn's last text is named by its line", () => {
    const dir = repository();
    const file = transcript([
      { ...human("pick the rounding and run the tests", 1), cwd: dir },
      say("s1", "Decision: round half-up at checkout", 2),
      use("b1", "Bash", { command: "npm test" }, 3),
      result("b1", "1 passing", 4),
      say("s2", "Done.", 5),
    ]);
    const [turn] = closeout(file, dir).items;
    assert.deepStrictEqual({ textLines: turn.textLines, endingLine: turn.endingLine, ending: turn.ending, atRisk: turn.atRisk },
      { textLines: [2, 5], endingLine: 5, ending: "Done.", atRisk: true });
  });

  test("a prompt queued while the agent worked starts a turn, so the earlier decision stays at risk", () => {
    const dir = repository();
    const file = transcript([
      { ...human("which rounding should we use?", 1), cwd: dir },
      say("s1", "Decision: round half-up at checkout", 2),
      { type: "attachment", timestamp: "2026-01-01T00:00:03.000Z",
        attachment: { type: "queued_command", commandMode: "prompt", prompt: "now fix the cart", origin: { kind: "human" } } },
      use("e1", "Edit", { file_path: "src/cart.js", old_string: "cents / 100", new_string: "Math.round(cents) / 100" }, 4),
      result("e1", "The file has been updated.", 5),
      say("s2", "Fixed the rounding in cart.js", 6),
    ]);
    const report = closeout(file, dir);
    const turns = report.items.filter((item) => item.kind === "turn");
    assert.deepStrictEqual(turns.map(({ promptLine, prompt, endingLine, location }) => ({ promptLine, prompt, endingLine, location })), [
      { promptLine: 1, prompt: "which rounding should we use?", endingLine: 2, location: "transcript-only" },
      { promptLine: 3, prompt: "now fix the cart", endingLine: 6, location: "file" },
    ]);
    assert.deepStrictEqual(report.wouldLose, [{ kind: "turn", endingLine: 2 }]);
  });
});

describe("where a change lives", () => {
  test("a file written and then removed, which Git never held, is missing and at risk", () => {
    const dir = repository();
    const file = transcript([
      ...fixTurn(dir),
      use("w1", "Write", { file_path: "plan.md", content: "Round half-up." }, 5),
      result("w1", "File created successfully.", 6),
    ]);
    const report = closeout(file, dir);
    const plan = report.items.find((item) => item.kind === "change" && item.path.endsWith("/plan.md"));
    assert.deepStrictEqual({ location: plan.location, atRisk: plan.atRisk }, { location: "missing", atRisk: true });
    assert.strictEqual(report.verdict, "would-lose");
    assert.deepStrictEqual(report.wouldLose, [{ kind: "change", path: plan.path }]);
  });

  test("a path is one literal file name, a removed file is at risk wherever it was, and so is an unresolved path", () => {
    const dir = repository();
    write(dir, "a.js", "x");
    git(dir, "add", "a.js");
    git(dir, "commit", "-qm", "a");
    const gone = path.join(tempDir(), "notes.md");
    write(dir, "notes/[id].md", "x");
    const writes = [["w1", "[ab].js"], ["w2", "routes/$id.tsx"], ["w3", gone], ["w4", "~/plan.md"], ["w5", "notes/[id].md"]];
    const file = transcript([
      { ...human("draft them", 1), cwd: dir },
      ...writes.flatMap(([id, target], i) => [
        use(id, "Write", { file_path: target, content: "x" }, 2 + 2 * i),
        result(id, "File created successfully.", 3 + 2 * i),
      ]),
    ]);
    const report = closeout(file, dir);
    assert.deepStrictEqual(report.items.map(({ path: changed, location, atRisk }) => ({ name: path.basename(changed), location, atRisk })), [
      { name: "[ab].js", location: "missing", atRisk: true },
      { name: "$id.tsx", location: "missing", atRisk: true },
      { name: "notes.md", location: "outside-missing", atRisk: true },
      { name: "plan.md", location: "unresolved", atRisk: true },
      { name: "[id].md", location: "ignored", atRisk: false },
    ]);
    assert.strictEqual(report.verdict, "would-lose");
  });

  test("a tracked file the session removed is still held by Git", () => {
    const dir = repository();
    const file = transcript(fixTurn(dir));
    fs.rmSync(path.join(dir, "src", "cart.js"));
    const [change] = closeout(file, dir).items;
    assert.deepStrictEqual({ location: change.location, uncommitted: change.uncommitted, atRisk: change.atRisk },
      { location: "tracked", uncommitted: true, atRisk: false });
  });

  test("an untracked file and a file outside the repository survive, and neither puts a turn in a file", () => {
    const dir = repository();
    const elsewhere = tempDir();
    const file = transcript([
      { ...human("draft it", 1), cwd: dir },
      use("w1", "Write", { file_path: "draft.md", content: "x" }, 2),
      result("w1", "File created successfully.", 3),
      use("w2", "Write", { file_path: path.join(elsewhere, "out.md"), content: "x" }, 4),
      result("w2", "File created successfully.", 5),
      say("s1", "Drafted it.", 6),
    ]);
    write(dir, "draft.md", "x");
    write(elsewhere, "out.md", "x");
    const report = closeout(file, dir);
    assert.deepStrictEqual(report.items.map(({ kind, location, atRisk }) => ({ kind, location, atRisk })), [
      { kind: "change", location: "untracked", atRisk: false },
      { kind: "change", location: "outside", atRisk: false },
      { kind: "turn", location: "transcript-only", atRisk: true },
    ]);
  });

  test("a failed write and a shell command that removes a file add no change", () => {
    const dir = repository();
    const file = transcript([
      { ...human("write the plan", 1), cwd: dir },
      use("w1", "Write", { file_path: "plan.md", content: "x" }, 2),
      result("w1", "Permission to use Write has been denied.", 3, true),
      use("b1", "Bash", { command: "rm src/cart.js" }, 4),
      result("b1", "", 5),
    ]);
    const report = closeout(file, dir);
    assert.deepStrictEqual(report.items, []);
    assert.strictEqual(report.verdict, "safe-to-delete");
  });
});

describe("the cleanup flag", () => {
  test("a session that stopped what it started and listed ignored files after its last change closed clean", () => {
    const dir = repository();
    const file = transcript([
      ...fixTurn(dir),
      use("b1", "Bash", { command: "npm run dev", run_in_background: true }, 5),
      result("b1", "Command running in background with ID: bg1. Output is being written to: /work/shop/bg1.output", 6),
      use("p1", "mcp__Claude_Browser__preview_start", { name: "shop" }, 7),
      result("p1", "{\"serverId\": \"srv-1\", \"port\": 3000}", 8),
      use("b2", "Bash", { command: "npm test -- --watch", run_in_background: true }, 9),
      result("b2", "Command running in background with ID: bg2. Output is being written to: /work/shop/bg2.output", 10),
      use("k1", "KillShell", { shell_id: "bg1" }, 11),
      result("k1", "Shell bg1 killed.", 12),
      use("p2", "mcp__Claude_Browser__preview_stop", { serverId: "srv-1" }, 13),
      result("p2", "Stopped.", 14),
      { type: "attachment", timestamp: "2026-01-01T00:00:15.000Z", attachment: { type: "queued_command", commandMode: "task-notification",
        prompt: "<task-notification><task-id>bg2</task-id><status>completed</status></task-notification>" } },
      use("g1", "Bash", { command: "git status --short --ignored" }, 16),
      result("g1", "!! notes/", 17),
      say("s2", "Closed.", 18),
    ]);
    const { cleanup, verdict } = closeout(file, dir);
    assert.deepStrictEqual({ flag: cleanup.flag, ignoredStatusLine: cleanup.ignoredStatusLine, leftovers: cleanup.leftovers },
      { flag: "clean", ignoredStatusLine: 16, leftovers: [] });
    assert.strictEqual(verdict, "safe-to-delete");
  });

  test("a preview server never stopped and no ignored-file listing after the last change need cleanup", () => {
    const dir = repository();
    const file = transcript([
      { ...human("start the shop", 1), cwd: dir },
      use("g1", "Bash", { command: "git status --short --ignored" }, 2),
      result("g1", "", 3),
      use("p1", "mcp__Claude_Browser__preview_start", { name: "shop" }, 4),
      result("p1", "{\"serverId\": \"srv-1\", \"port\": 3000}", 5),
      use("p2", "mcp__Claude_Browser__preview_stop", { serverId: "srv-9" }, 6),
      result("p2", "No such server.", 7, true),
      use("e1", "Edit", { file_path: "src/cart.js", old_string: "cents / 100", new_string: "Math.round(cents) / 100" }, 8),
      result("e1", "The file has been updated.", 9),
      say("s1", "Fixed it; the shop runs on port 3000.", 10),
    ]);
    const { cleanup } = closeout(file, dir);
    assert.deepStrictEqual(cleanup.flag, "needs-cleanup");
    assert.strictEqual(cleanup.ignoredStatusLine, null);
    assert.deepStrictEqual(cleanup.leftovers, [{ kind: "preview-server", id: "srv-1", callLine: 4, command: "shop" }]);
  });
});

describe("the command line", () => {
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

  test("it prints the report, and changes nothing in the repository or the transcript", () => {
    const dir = repository();
    const file = transcript([
      ...fixTurn(dir),
      use("w1", "Write", { file_path: "notes/decision.md", content: "x" }, 5),
      result("w1", "File created successfully.", 6),
    ]);
    write(dir, "notes/decision.md", "x");
    const status = () => git(dir, "status", "--porcelain", "--ignored");
    const index = path.join(dir, ".git", "index");
    const before = { status: status(), bytes: fs.readFileSync(file), time: fs.statSync(file).mtimeMs, index: fs.statSync(index).mtimeMs };
    const done = run(["--session-file", file, "--root", dir]);
    assert.strictEqual(done.status, 0, done.stderr);
    assert.strictEqual(JSON.parse(done.stdout).verdict, "safe-to-delete");
    // Read before the next status, which may refresh the index itself.
    assert.strictEqual(fs.statSync(index).mtimeMs, before.index);
    assert.strictEqual(status(), before.status);
    assert.deepStrictEqual(fs.readFileSync(file), before.bytes);
    assert.strictEqual(fs.statSync(file).mtimeMs, before.time);
  });

  test("a session id with no transcript exits 2, and nothing is a guess", () => {
    const done = run(["--session-id", "0a1b2c3d-0000-4000-8000-00000000ffff", "--claude-home", tempDir(), "--root", repository()]);
    assert.strictEqual(done.status, 2);
    assert.match(done.stderr, /expected one transcript for that session, found 0/);
    assert.strictEqual(run(["--root", repository()]).status, 2);
  });

  test("a Codex rollout, a record that is not JSON and a root outside Git exit 1", () => {
    const dir = repository();
    const codex = run(["--session-file", transcript([meta, started(1)]), "--root", dir]);
    assert.strictEqual(codex.status, 1);
    assert.match(codex.stderr, /only Claude Code transcripts are supported/);
    const broken = run(["--session-file", transcript(fixTurn(dir), { tail: "{not json\n" }), "--root", dir]);
    assert.strictEqual(broken.status, 1);
    assert.match(broken.stderr, /cannot read the transcript reliably: Invalid JSON record at line 5/);
    const outside = run(["--session-file", transcript(fixTurn(dir)), "--root", tempDir()]);
    assert.strictEqual(outside.status, 1);
    assert.match(outside.stderr, /--root is not inside a Git work tree/);
  });
});
