#!/usr/bin/env node
"use strict";

// The one guard anneal carries: while a migration is in progress, a destructive
// git command would throw away the commits the migration just made, and the
// working tree they were checked against.
//
// "In progress" is the checked-out branch, not a state file. anneal works only
// on `anneal/<YYYY-MM-DD>` branches, so the scope is exact, needs nothing
// written, and ends by itself the moment you switch away. From any other
// branch, the one thing it watches is a command that deletes a migration
// branch, or forces it to another commit, while that branch holds commits HEAD
// lacks: that command asks first, since only the owner decides whether another
// run's commits go. Everything else is allowed there, which is what the hook
// does in a session that never invoked anneal.
//
// One file serves three hosts, because only two things differ: where the
// command text sits in the payload, and what a decision looks like on the wire.

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const HOSTS = {
  // Claude Code and Codex: PreToolUse names the tool and its input directly.
  claude: {
    command: (data) => (/^(Bash|PowerShell)$/.test(data.tool_name) ? data.tool_input?.command : null),
    cwd: (data) => data.cwd,
    deny: (reason) => decision("deny", reason),
    ask: (reason) => decision("ask", reason),
    allow: () => null,
  },
  // Antigravity: the call is nested under toolCall, with args in PascalCase,
  // and the decision is a bare word.
  antigravity: {
    command: (data) => (data.toolCall?.name === "run_command" ? data.toolCall.args?.CommandLine : null),
    cwd: (data) => data.toolCall?.args?.Cwd || (Array.isArray(data.workspacePaths) ? data.workspacePaths[0] : null),
    deny: (reason) => ({ decision: "deny", reason }),
    ask: (reason) => ({ decision: "ask", reason }),
    allow: () => ({ decision: "allow" }),
  },
};

function decision(permissionDecision, permissionDecisionReason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } };
}

// Each of these discards committed or checked work rather than adding to it,
// or rewrites the commits that record it. The subcommand has to follow `git`
// itself, past its global flags only, so a commit message that merely names one
// is not a match; a message that holds ` --amend` still is. `--force-with-lease`
// is left out: it refuses when the remote moved, which is the case this guard
// exists to catch. A regex cannot see every rewrite of a command, such as git
// run through a variable, so the denial also says what a rewrite would do.
const GIT = String.raw`\bgit\b(?:\s+(?:-[cC]\s*\S+|--?[\w-]+(?:=\S+)?))*\s+`;
const SEGMENT = String.raw`[^\n;|&]*`;
const ARGS = String.raw`${SEGMENT}\s`;
const DESTRUCTIVE_GIT = new RegExp(
  GIT +
    "(?:" +
    [
      String.raw`reset\b${ARGS}--hard\b`,
      String.raw`clean\b${ARGS}(?:-[a-zA-Z]*f|--force\b)`,
      String.raw`checkout\b${ARGS}(?:--force|-f)\b`,
      String.raw`switch\b${ARGS}(?:--discard-changes|--force|-f)\b`,
      String.raw`push\b${ARGS}(?:--force\b(?!-with-lease)|-f\b|\+\S)`,
      String.raw`branch\b${ARGS}-D\b`,
      String.raw`branch\b(?=${ARGS}(?:-[a-zA-Z]*d|--delete\b))(?=${ARGS}(?:-[a-zA-Z]*f|--force\b))`,
      String.raw`commit\b${ARGS}--amend\b`,
      String.raw`rebase\b(?!${ARGS}--(?:abort|quit)\b)`,
      String.raw`update-ref\b${ARGS}(?:-d|--delete)\b`,
      String.raw`reflog\b${ARGS}(?:expire|delete)\b`,
    ].join("|") +
    ")"
);

// A commit that skips the checks a migration step has to pass: `--no-verify`, or
// a short-flag cluster holding `n`. A message with such a word in it matches too.
const SKIPS_HOOKS = new RegExp(GIT + String.raw`commit\b${ARGS}(?:--no-verify\b|-[a-zA-Z]*n[a-zA-Z]*\b)`);

const MIGRATION_BRANCH = /^anneal\/\d{4}-\d{2}-\d{2}(-set-aside-\d+)?$/;
const SUBCOMMAND = new RegExp(GIT + "(checkout|switch|branch)\\b(.*)");

// A shell line continuation, `\` in POSIX shells and a backtick in PowerShell,
// joins one command across lines; read it as the one line it runs as.
const oneLine = (command) => command.replace(/[\\`]\r?\n/g, " ");
const isDestructive = (command) => DESTRUCTIVE_GIT.test(oneLine(command));

// The migration branches a command deletes or forces to another commit,
// whatever they hold: the value of `checkout -B`, `switch -C` or
// `--force-create`, the branch `branch -f` or `--force` moves, and every
// branch a `branch -D` or forced delete removes. A start point is not a target.
// In a short-flag cluster such as `-qB`, git takes the rest of the word after
// `B` or `C` as the value, or the next word when nothing follows.
function forcedBranches(line) {
  const names = [];
  for (const segment of line.split(/[\n;|&]/)) {
    const match = SUBCOMMAND.exec(segment);
    if (!match) continue;
    const words = match[2].trim().split(/\s+/).map((word) => word.replace(/^["']|["']$/g, ""));
    if (match[1] === "branch") {
      const short = words.filter((word) => /^-[a-zA-Z]+$/.test(word)).join("");
      const force = short.includes("f") || words.includes("--force");
      const remove = short.includes("D") || (force && (short.includes("d") || words.includes("--delete")));
      const operands = words.filter((word) => word && !word.startsWith("-"));
      if (remove) names.push(...operands);
      else if (force) names.push(operands[0]);
    } else {
      const flag = match[1] === "checkout" ? /^-[a-zA-Z]*?B(.*)$/ : /^(?:-[a-zA-Z]*?C|--force-create=?)(.*)$/;
      words.forEach((word, i) => {
        const value = flag.exec(word);
        if (value) names.push(value[1] || words[i + 1]);
      });
    }
  }
  return names.filter((name) => MIGRATION_BRANCH.test(name || ""));
}

function readInput() {
  try {
    const value = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// Only anneal's own migration branches are guarded. Anything that stops git
// from answering means no guard, which is the fail-open direction: this hook
// must never be what blocks an unrelated command.
function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const holdsOwnCommits = (cwd, name) => Number(git(cwd, ["rev-list", "--count", `HEAD..refs/heads/${name}`])) > 0;

function decide(host, data) {
  const adapter = HOSTS[host] || HOSTS.claude;
  const command = adapter.command(data);
  if (typeof command !== "string") return adapter.allow();
  const line = oneLine(command);
  const destructive = DESTRUCTIVE_GIT.test(line);
  const skipsHooks = SKIPS_HOOKS.test(line);
  const forced = forcedBranches(line);
  if (!destructive && !skipsHooks && !forced.length) return adapter.allow();

  const cwd = adapter.cwd(data);
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const migrating = MIGRATION_BRANCH.test(branch);
  if ((migrating && destructive) || forced.includes(branch)) {
    return adapter.deny(
      "anneal is mid-migration on this branch, and this command discards or rewrites committed or checked work: " +
        command.trim() +
        ". Each migration step is its own commit; undo one with `git revert`, or leave the branch first if you meant to abandon the migration. The same command in another form would discard or rewrite the same work."
    );
  }
  if (migrating && skipsHooks) {
    return adapter.deny(
      "anneal is mid-migration on this branch, and this commit skips the checks each migration step has to pass: " +
        command.trim() +
        ". Commit without `--no-verify` or `-n`, and fix what a check reports; if such a word is only part of the commit message, reword the message. The same command in another form would skip the same checks."
    );
  }
  const held = forced.find((name) => holdsOwnCommits(cwd, name));
  if (held) {
    return adapter.ask(
      `${held} holds commits that HEAD lacks, and this command would delete the branch or move it off them: ` +
        command.trim() +
        ". It is an anneal migration branch; whether those commits go is the owner's call, not the session's."
    );
  }
  return adapter.allow();
}

function main(argv = process.argv) {
  const host = argv[2] || process.env.ANNEAL_HOST || "claude";
  const output = decide(host, readInput());
  if (output) process.stdout.write(JSON.stringify(output));
}

if (require.main === module) {
  try {
    main();
  } catch {
    // A guard that crashes must not take the tool call with it.
    if ((process.argv[2] || process.env.ANNEAL_HOST) === "antigravity") {
      process.stdout.write(JSON.stringify({ decision: "allow" }));
    }
  }
}

module.exports = { decide, DESTRUCTIVE_GIT, SKIPS_HOOKS, isDestructive, forcedBranches };
