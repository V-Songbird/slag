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

// Each of these discards committed or checked work rather than adding to it.
// The subcommand has to follow `git` itself, past its global flags only, so a
// commit message that merely names one is not a match. `--force-with-lease` is
// left out: it refuses when the remote moved, which is the case this guard
// exists to catch.
const GIT = String.raw`\bgit\b(?:\s+-[cC]\s*\S+)*\s+`;
const ARGS = String.raw`[^\n;|&]*\s`;
const DESTRUCTIVE_GIT = new RegExp(
  GIT +
    "(?:" +
    [
      String.raw`reset\b${ARGS}--hard\b`,
      String.raw`clean\b${ARGS}-[a-zA-Z]*f`,
      String.raw`checkout\b${ARGS}(?:--force|-f)\b`,
      String.raw`push\b${ARGS}(?:--force\b(?!-with-lease)|-f\b)`,
      String.raw`branch\b${ARGS}-D\b`,
    ].join("|") +
    ")"
);

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
  if (typeof command !== "string" || !DESTRUCTIVE_GIT.test(command)) return adapter.allow();
  if (!onMigrationBranch(adapter.cwd(data))) return adapter.allow();
  return adapter.deny(
    "anneal is mid-migration on this branch, and this command discards committed or checked work: " +
      command.trim() +
      ". Each migration step is its own commit; undo one with `git revert`, or leave the branch first if you meant to abandon the migration."
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

module.exports = { decide, DESTRUCTIVE_GIT, onMigrationBranch };
