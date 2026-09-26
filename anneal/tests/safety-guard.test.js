"use strict";

// The guard on real branches, through the payload shape each host actually
// sends. The branch check is what scopes it, so every case names a branch.

const { test, describe, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
require("./temp-root.js");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const { decide, DESTRUCTIVE_GIT, isDestructive } = require("../hooks/safety-guard.js");

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
      "git clean --force -d",
      "git switch --discard-changes main",
      "git switch -f main",
      "git push origin +anneal/2026-09-19",
      "git branch --delete --force anneal/2026-09-19",
      "git branch -d -f anneal/2026-09-19",
      "git branch -df anneal/2026-09-19",
    ]) {
      assert.strictEqual(DESTRUCTIVE_GIT.test(command), true, command);
    }
  });

  test("the same commands behind global flags or split across lines", () => {
    for (const command of [
      "git --no-pager reset --hard HEAD~1",
      "git --git-dir=.git --work-tree=. clean -fd",
      "git -c core.pager=cat -P push --force",
      "git reset \\\n  --hard",
      "git reset `\r\n  --hard",
    ]) {
      assert.strictEqual(isDestructive(command), true, JSON.stringify(command));
    }
  });

  test("the commands that rewrite the commits a migration made", () => {
    for (const command of [
      "git commit --amend --no-edit",
      "git rebase -i HEAD~3",
      "git rebase main",
      "git rebase --continue",
      "git update-ref -d refs/heads/anneal/2026-09-19",
      "git reflog expire --expire=now --all",
      "git reflog delete HEAD@{1}",
      "git rebase --abort && git rebase main",
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
      "git switch anneal/2026-09-19",
      "git switch -c anneal/2026-09-19-set-aside-1",
      "git --no-pager log -1 --format=%s anneal/2026-09-19-set-aside-1",
      "git push origin anneal/2026-09-19",
      "git branch -d merged-topic",
      "git rebase --abort",
      "git reflog",
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
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /in another form/);
  });

  test("a command split across lines is denied on an anneal branch", () => {
    const root = repoOn("anneal/2026-09-19");
    assert.ok(denied(decide("claude", claudeCall("git reset \\\n  --hard", root))));
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

  // Codex on Windows hands a hook's command to PowerShell. A `commandWindows` that wrapped the
  // script in a double-quoted `-Command` had `$env:` and `$LASTEXITCODE` expanded by that outer
  // shell, failed, and the host carried on with the call. Seen in a live session on the sibling
  // plugin, where the plain command ran as it is.
  test("the Codex hook names one command, with no Windows override to break", () => {
    const file = path.join(__dirname, "..", "hooks", "codex-hooks.json");
    const { hooks } = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const groups of Object.values(hooks))
      for (const { hooks: handlers } of groups)
        for (const handler of handlers) {
          assert.strictEqual(handler.commandWindows, undefined);
          assert.match(handler.command, /^node "\$\{PLUGIN_ROOT\}\/hooks\/[a-z-]+\.js" claude$/);
        }
  });
});
