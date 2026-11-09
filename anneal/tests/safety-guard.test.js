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

// A migration branch with one commit of its own, and a set-aside branch main
// already holds, left checked out on main.
function migrationRepo(branch) {
  const root = repoOn(branch);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "b.txt"), "b\n");
  git("add", "-A");
  git("commit", "-qm", "step");
  git("checkout", "-q", "-");
  git("branch", `${branch}-set-aside-1`);
  return { root, git };
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

describe("a migration branch that holds commits of its own", () => {
  const branch = "anneal/2026-11-09";
  const decision = (command, root) => decide("claude", claudeCall(command, root))?.hookSpecificOutput?.permissionDecision || "allow";

  test("on that branch, a command that resets, overwrites or deletes it, or skips the hooks, is denied", () => {
    const { root, git } = migrationRepo(branch);
    git("checkout", "-q", branch);
    for (const command of [
      `git checkout -B ${branch} HEAD~1`,
      `git switch -C ${branch} HEAD~1`,
      `git branch -f ${branch} HEAD~1`,
      `git checkout -qB ${branch} HEAD~1`,
      `git switch -qC ${branch} HEAD~1`,
      `git switch --force-create ${branch} HEAD~1`,
      `git branch --force ${branch} HEAD~1`,
      `git branch -d --force ${branch}`,
      `git branch -M main ${branch}`,
      `git branch -C main ${branch}`,
      `git branch -m -f main ${branch}`,
      `git branch -c -f main ${branch}`,
      `git update-ref refs/heads/${branch} HEAD~1`,
      `git update-ref -m "step back" refs/heads/${branch} HEAD~1`,
      `git push . +main:${branch}`,
      `git push . :refs/heads/${branch}`,
      "git commit --no-verify -m x",
      "git commit -n -m x",
      "git -c core.hooksPath=/dev/null commit -m x",
      "git -c core.hookspath=none commit -m x",
      "git merge --no-verify main",
    ]) {
      assert.strictEqual(decision(command, root), "deny", command);
    }
    const reason = decide("claude", claudeCall("git commit -n -m x", root)).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /in another form/);
    assert.match(reason, /reword the message/);
  });

  test("from another branch, deleting, overwriting or moving it asks first", () => {
    const { root } = migrationRepo(branch);
    for (const command of [
      `git branch -D ${branch}`,
      `git checkout -B ${branch}`,
      `git switch -C ${branch}`,
      `git switch -qC${branch}`,
      `git branch -f ${branch} main`,
      `git branch -d --force ${branch}`,
      `git switch --force-create ${branch}`,
      `git switch --force-create=${branch}`,
      `git branch --force ${branch} main`,
      `git branch -M main ${branch}`,
      `git branch -C main ${branch}`,
      `git branch -m -f main ${branch}`,
      `git branch -c -f main ${branch}`,
      `git update-ref -d refs/heads/${branch}`,
      `git update-ref refs/heads/${branch} main`,
      `git push . +main:${branch}`,
      `git push . :${branch}`,
      `git push --delete . ${branch}`,
    ]) {
      assert.strictEqual(decision(command, root), "ask", command);
    }
    assert.match(decide("claude", claudeCall(`git branch -D ${branch}`, root)).hookSpecificOutput.permissionDecisionReason, /owner/);
    assert.strictEqual(decide("antigravity", antigravityCall(`git branch -D ${branch}`, root)).decision, "ask");
  });

  test("the commands that leave its commits alone are allowed", () => {
    const { root, git } = migrationRepo(branch);
    for (const command of [
      `git branch -d ${branch}-set-aside-1`,
      `git branch -D ${branch}-set-aside-1`,
      `git checkout -B scratch ${branch}`,
      `git switch ${branch}`,
      "git commit -m x",
      `git branch -m ${branch} renamed`,
      `git branch -c ${branch} copy`,
      "git update-ref refs/heads/other main",
      `git update-ref refs/tags/${branch} main`,
      `git push origin +main:${branch}`,
      "git -c core.hooksPath=/dev/null commit -m x",
      "git merge --no-verify scratch",
    ]) {
      assert.strictEqual(decision(command, root), "allow", command);
    }
    git("checkout", "-q", branch);
    for (const command of ["git commit -m x", "git checkout -B scratch", `git switch -c ${branch}-set-aside-2`, "git merge -n main", "git -c core.pager=cat commit -m x"]) {
      assert.strictEqual(decision(command, root), "allow", command);
    }
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
