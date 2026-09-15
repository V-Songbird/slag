# Codex runtime and consent

Read this before running a Jig command. These instructions apply to the Codex
CLI and desktop app on Windows, macOS and Linux. Use the tools actually available
in the session and respect their documented limits and execution permissions.

## Resolve the installed plugin

Find the absolute path of the SKILL.md that Codex loaded. Its directory is
`<JIG_ROOT>/codex-skills/<skill-name>/`, so the plugin root is two parent directories
above that directory. Resolve that path and verify that `scripts/jig.js` exists.
If the loaded skill location is an alias, resolve the alias first. Never assume
a shell variable named `PLUGIN_ROOT` exists.

In the command examples, replace `<JIG_ROOT>` with that verified absolute path;
it is a placeholder, not an environment variable. Keep the script path quoted,
and run from the target project root or pass `--root <absolute-project-path>`.
For example, `node "<JIG_ROOT>/scripts/jig.js" --runtime codex scan` works in PowerShell and a
POSIX shell once the path has been substituted. With a process API, pass the
script path and each argument as separate argv elements instead of building a
shell command. Do not copy text from a check description into executable code.

Every `scripts/jig.js` command in these skills carries `--runtime codex`. It
makes the engine scan, plan, report and probe for Codex's instruction and hook
files; without it the engine answers for Claude Code. Keep it on any command you
compose yourself.

Node.js 20 or later must be available to the command runner and separately to
Git hooks and Codex's hook process. Follow the project's documented runtime setup
when it exists; installing a runtime is its own authorized action. A successful
interactive shell invocation does not prove either hook process can find Node.

Use `$jig` with a plain-language request as the common entry. It reads the
appropriate workflow from this plugin and continues in the same conversation.
`$review` and `$inventory` remain direct entries. Follow
[Conversation and reporting](experience.md) for summaries and visible labels. If another plugin
uses the same name, select Jig's entry from the skill picker; use the qualified
name the installed host actually displays, without inventing slash commands.

## Ask preferences, then approve concrete changes

Read the current conversation first. Reuse answers and explicit authorization
already given for the same named change, path and consequence. A general request
to set up guardrails authorizes scan, draft and plan records under `.jig/`; it is
not approval for an unspecified install or for every item on a later plan.

For optional interview preferences, use `request_user_input_async` when offered,
or `request_user_input` only in a mode where it is permitted. Follow the actual
tool schema: single-select choices and text are sufficient. Split independent
questions into supported batches, and defer questions that depend on an answer.
If no suitable tool is available, ask concise questions in the conversation.
An absent answer is never consent to a mutation. A recommended option is advice,
not a submitted answer.

For a list with multiple independent selections, show an enumerated table with
stable ids and descriptions, and ask the owner to reply with the ids they want
(or `none`), plus any free text. A single-select UI cannot represent a multi-select;
do not silently select a recommended bundle or pretend it returned several ids.

For mandatory plan-item consent, first show the concrete plan and an enumerated
table of change id, exact path, kind and consequence, including install commands
and config bytes when applicable. Ask the owner to name approved id/path pairs,
or refer to rows by id only when that displayed table binds each id to one exact
path. Use an explicit conversational approval question when the available input
tool does not support approval requests. **Nothing is pre-ticked.** Do not apply
unanswered, declined, or implicitly selected rows. A changed path or consequence
needs new consent; do not ask again for an unchanged pair already authorized in
this session. Apply each approved item with exactly one
`--change <id> --path <rel>` pair. Report every declined or unanswered item as
not applied. Batch-tier consent does not approve an item-tier change.

## Runtime evidence

Codex must enable and trust Jig's hooks before session guards can run. After
installation or a hook update, open `/hooks` in the active Codex host and verify
that Jig's current hook snapshot is trusted and enabled. Do not claim that a
plugin manifest, a repository config, or `mode: armed` proves host registration.
When the host has no hooks surface or the snapshot cannot be inspected, disclose
that session enforcement is unverified and report the commit and CI lanes
separately. Do not silently edit the user's global Codex configuration.

`selftest --live` is a local detector and ledger demonstration. It calls Jig's
runner with synthetic events; it does not prove Codex dispatched or enforced a
real hook. Report a successful selftest as detector proof. Claim actual session
enforcement only with separate evidence from that host's trusted registration
and a safe, user-authorized real tool-call probe. A host probe must use a
throwaway fixture and harmless near miss, never execute the dangerous action a
check describes. An unavailable host probe is a disclosed gap, not a reason to
pretend the selftest tested the host.

Jig deliberately keeps Stop advisory, preserving its original harness contract.
Codex supports blocking and continuation at Stop, but Jig requests neither: it
reports a verification gap as a warning and lets the turn end. Do not describe
this choice as a Codex capability limitation. PostToolUse is after the operation
and cannot undo bytes already written. Supported PreToolUse denials prevent the
covered calls before they run.

The patch adapter follows Codex's exact, `trimEnd`, `trim` and Unicode-normalized
context matching, including ordered hunks and duplicate-context first matches.
An unreadable or malformed file, or an outside-repository path, remains a
disclosed gap. Other readable files in that patch still evaluate, and a known
denial survives another file's gap. External edits and shell-driven rewrites
remain outside patch coverage.

## Reliable verification evidence

Measured Codex CLI 0.145.0 and 0.153.4 shell PostToolUse payloads contain raw
stdout without exit status. For a command matching a named verification entry,
Jig records `verify-unknown` when that payload supplies no explicit exit evidence.
Do not infer success from PostToolUse, output text or a displayed successful tool
call. This gap does not affect PreToolUse command or patch denials.

For an approved named verification, use the committed driver, which starts the
configured command and records its actual exit status itself:

```text
node .jig/checks/run.mjs --verify --lane commit --entry <id>
```

Read `.jig/verify.json` first: `<id>` must name the approved command, and this
invocation requires its `lanes` to include `commit`. If it is assigned only to
another lane, use that existing lane, for example `--lane ci`; do not rewrite the
configuration to make the example work. Honor the user's existing authorization
for the named verification. A missing entry or lane selection is no verification,
and a command that could not start is never a pass.

The driver records actual zero and nonzero exits as `verified` or `verify-failed`
according to the entry's configured expected exit. `--lane commit` selects the
command and ledger label; it is not proof a Git commit occurred. Likewise, a
manual `--lane ci` invocation does not prove hosted CI ran. Report the executed
command, recorded exit and origin of that evidence separately from lane wiring.
The fixture-seeding `selftest --live --toolchain <ids>` has a different purpose:
it checks whether those tools detect planted violations on a clean baseline.
