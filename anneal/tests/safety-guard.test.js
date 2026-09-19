"use strict";

// The guard on real branches, through the payload shape each host actually
// sends. The branch check is what scopes it, so every case names a branch.

const { test, describe, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const { decide, DESTRUCTIVE_GIT } = require("../hooks/safety-guard.js");

const HOOK = path.join(__dirname, "..", "hooks", "safety-guard.js");

process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();

const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function repoOn(branch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anneal-guard-"));
  created.push(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  git("checkout", "-qb", branch);
  return root;
}

const claudeCall = (command, cwd) => ({ tool_name: "Bash", tool_input: { command }, cwd });
const antigravityCall = (command, cwd) => ({ toolCall: { name: "run_command", args: { CommandLine: command, Cwd: cwd } } });

const denied = (out) => out?.hookSpecificOutput?.permissionDecision === "deny" || out?.decision === "deny";

describe("what counts as destructive", () => {
  test("the commands that discard committed or checked work", () => {
    for (const command of [
      "git reset --hard HEAD~1",
      "git reset --hard",
      "git clean -fd",
      "git clean -xdf",
      "git clean -f",
      "git checkout --force main",
      "git push origin main --force",
      "git push -f origin main",
      "git branch -D anneal/2026-09-19",
      "npm test && git reset --hard",
      "git -C ../other reset --hard",
      "git reset HEAD~1 --hard",
    ]) {
      assert.strictEqual(DESTRUCTIVE_GIT.test(command), true, command);
    }
  });

  test("a commit message that only names one is not a match", () => {
    for (const command of [
      "git commit -m 'anneal: undo the reset --hard'",
      "git log --oneline --grep 'clean -fd'",
      "git commit -m \"document why we never push --force\"",
    ]) {
      assert.strictEqual(DESTRUCTIVE_GIT.test(command), false, command);
    }
  });

  test("the commands a migration runs every step", () => {
    for (const command of [
      "git status --porcelain",
      "git checkout -b anneal/2026-09-19",
      "git mv src/utils/format.js src/cart/format.js",
      "git add -A",
      "git commit -m 'anneal: move format'",
      "git revert --no-edit HEAD",
      "git push --force-with-lease",
      "git config user.email",
      "git rev-parse --show-toplevel",
    ]) {
      assert.strictEqual(DESTRUCTIVE_GIT.test(command), false, command);
    }
  });
});

describe("scope", () => {
  test("a destructive command on an anneal branch is denied", () => {
    const root = repoOn("anneal/2026-09-19");
    const out = decide("claude", claudeCall("git reset --hard", root));
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /git revert/);
  });

  test("a set-aside branch is guarded too", () => {
    const root = repoOn("anneal/2026-09-19-set-aside-1");
    assert.ok(denied(decide("claude", claudeCall("git clean -fd", root))));
  });

  test("the same command on any other branch is allowed", () => {
    for (const branch of ["main", "feature/anneal", "anneal/not-a-date", "anneal/2026-09-19-extra"]) {
      const root = repoOn(branch);
      assert.strictEqual(denied(decide("claude", claudeCall("git reset --hard", root))), false, branch);
    }
  });

  test("outside a git repository nothing is denied", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "anneal-guard-nogit-"));
    created.push(root);
    assert.strictEqual(denied(decide("claude", claudeCall("git reset --hard", root))), false);
  });
});

describe("host payloads", () => {
  test("Antigravity sends the command under toolCall.args.CommandLine", () => {
    const root = repoOn("anneal/2026-09-19");
    const out = decide("antigravity", antigravityCall("git reset --hard", root));
    assert.strictEqual(out.decision, "deny");
    assert.strictEqual(decide("antigravity", antigravityCall("git status", root)).decision, "allow");
  });

  test("a payload with no command at all is allowed", () => {
    assert.strictEqual(denied(decide("claude", { tool_name: "Read", tool_input: { file_path: "a.js" } })), false);
    assert.strictEqual(decide("antigravity", { toolCall: { name: "view_file", args: {} } }).decision, "allow");
  });
});

describe("wire", () => {
  test("a denial reaches stdout as the host's own shape", () => {
    const root = repoOn("anneal/2026-09-19");
    const run = (host, payload) =>
      spawnSync(process.execPath, [HOOK, host], { input: JSON.stringify(payload), encoding: "utf8" });

    const claude = run("claude", claudeCall("git reset --hard", root));
    assert.strictEqual(claude.status, 0);
    assert.strictEqual(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecision, "deny");

    const antigravity = run("antigravity", antigravityCall("git reset --hard", root));
    assert.strictEqual(JSON.parse(antigravity.stdout).decision, "deny");
  });

  test("an allow is silent on Claude Code and explicit on Antigravity", () => {
    const root = repoOn("main");
    const claude = spawnSync(process.execPath, [HOOK, "claude"], { input: JSON.stringify(claudeCall("git reset --hard", root)), encoding: "utf8" });
    assert.strictEqual(claude.stdout, "");

    const antigravity = spawnSync(process.execPath, [HOOK, "antigravity"], { input: JSON.stringify(antigravityCall("git reset --hard", root)), encoding: "utf8" });
    assert.strictEqual(JSON.parse(antigravity.stdout).decision, "allow");
  });

  test("an unreadable payload never blocks the tool call", () => {
    for (const host of ["claude", "antigravity"]) {
      const run = spawnSync(process.execPath, [HOOK, host], { input: "not json", encoding: "utf8" });
      assert.strictEqual(run.status, 0);
      assert.strictEqual(denied(run.stdout ? JSON.parse(run.stdout) : null), false);
    }
  });
});
