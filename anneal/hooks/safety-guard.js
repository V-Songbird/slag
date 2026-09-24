#!/usr/bin/env node
"use strict";

// The one guard anneal carries: while a migration is in progress, a destructive
// git command would throw away the commits the migration just made, and the
// working tree they were checked against.
//
// "In progress" is the checked-out branch, not a state file. anneal works only
// on `anneal/<YYYY-MM-DD>` branches, so the scope is exact, needs nothing
// written, and ends by itself the moment you switch away. On every other branch
// this hook allows everything, which is what it does in a session that never
// invoked anneal.
//
// One file serves three hosts, because only two things differ: where the
// command text sits in the payload, and what a denial looks like on the wire.

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const HOSTS = {
  // Claude Code and Codex: PreToolUse names the tool and its input directly.
  claude: {
    command: (data) => (/^(Bash|PowerShell)$/.test(data.tool_name) ? data.tool_input?.command : null),
    cwd: (data) => data.cwd,
    deny: (reason) => ({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }),
    allow: () => null,
  },
  // Antigravity: the call is nested under toolCall, with args in PascalCase,
  // and the decision is a bare allow/deny.
  antigravity: {
    command: (data) => (data.toolCall?.name === "run_command" ? data.toolCall.args?.CommandLine : null),
    cwd: (data) => data.toolCall?.args?.Cwd || (Array.isArray(data.workspacePaths) ? data.workspacePaths[0] : null),
    deny: (reason) => ({ decision: "deny", reason }),
    allow: () => ({ decision: "allow" }),
  },
};

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

// A shell line continuation, `\` in POSIX shells and a backtick in PowerShell,
// joins one command across lines; read it as the one line it runs as.
const isDestructive = (command) => DESTRUCTIVE_GIT.test(command.replace(/[\\`]\r?\n/g, " "));

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
function onMigrationBranch(cwd) {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^anneal\/\d{4}-\d{2}-\d{2}(-set-aside-\d+)?$/.test(branch);
  } catch {
    return false;
  }
}

function decide(host, data) {
  const adapter = HOSTS[host] || HOSTS.claude;
  const command = adapter.command(data);
  if (typeof command !== "string" || !isDestructive(command)) return adapter.allow();
  if (!onMigrationBranch(adapter.cwd(data))) return adapter.allow();
  return adapter.deny(
    "anneal is mid-migration on this branch, and this command discards or rewrites committed or checked work: " +
      command.trim() +
      ". Each migration step is its own commit; undo one with `git revert`, or leave the branch first if you meant to abandon the migration. The same command in another form would discard or rewrite the same work."
  );
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

module.exports = { decide, DESTRUCTIVE_GIT, isDestructive, onMigrationBranch };
