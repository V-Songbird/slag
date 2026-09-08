# Jig operations and coverage

For everyday use, start with the [quick guide](../README.md#start-here).
This reference explains coverage, verification, migration and reversal.

## What Jig controls

A focused test that silently narrows a suite, a swallowed error, an assertion
deleted to make CI green: Jig turns an owner-selected mistake into an executable
check with a violation and a near miss. A check must catch its violation, spare
its near miss, and pass cross-check admission before it is offered as coverage.
An unprovable check is discarded and reported in `.jig/discarded.json`.

Jig's control is specific to those approved checks. It does not maintain a
task-wide allowlist of edits, understand every unwanted change, or prevent an
agent from bypassing every possible route. Its original behavior is preserved:
named consent, deterministic checks, recorded evidence, and reversible changes.
[The behavior analysis](BEHAVIOR.md) explains the boundaries.

Checks run in the lanes their detectors support:

- **Session:** trusted Codex hooks inspect supported shell commands and patch
  operations. An armed PreToolUse match can deny the call with a reason, an
  alternative and an override. Observe mode records it. Jig deliberately reports
  missing verification at Stop as advice. Codex supports blocking and continuation
  there; Jig requests neither, preserving its original behavior.
- **Commit:** a committed hook runs `.jig/checks/run.mjs` against staged changes.
  This lane needs Git wiring and Node on the hook's PATH. Existing committed
  hooks can receive one reviewed line instead of being displaced.
- **CI:** the generated workflow runs the driver, its selftest and configured
  verification commands. Index-dependent co-change and removal checks are
  disclosed as skipped when no changes are staged.

Driver-capable detectors and registered verification commands can run without
Jig or Codex once their files are installed. Session-only detectors gain no
commit or CI coverage from those files. Session hooks require registration and
trust to be verified in the active Codex host.


## Move an existing Jig project between hosts

Run `$jig migrate --host codex` or `$jig migrate --host claude`
in the intended project checkout. Either plugin build can prepare either
destination. This is a separate, plan-only workflow: it inventories the existing
installation and writes a review plan, then waits for approval of the exact
instruction change and path before applying it. Plain `migrate` keeps its legacy
format-upgrade behavior.

The approved change adds scoped pointers to the source instructions in a
separate owned region of the destination's root instruction file. Codex uses a
nonempty `AGENTS.override.md` when present, otherwise `AGENTS.md`; Claude uses
`CLAUDE.md`. Source instruction files remain required. Existing checks, guard
IDs, modes, proofs, driver and historical records are retained, including any
reported drift. The new transaction has its own undo record.

The report names missing local history and instruction-discovery limits.
Referenced governance documents, external or user instructions, host settings
and policy conflicts still need review. Applying a bridge does not register
hooks or prove that session, commit or CI checks run. Verify the destination
plugin and lanes in the actual checkout and host; desktop, CLI and operating
systems require their own evidence.

See the [host migration workflow](../skills/jig/references/host-migration.md) for
the engine commands, named approval, stale-plan refusal, verification and exact
transaction reversal. No existing project is migrated merely by updating Jig.


## What “proven” means

An admitted detector has demonstrated its own fixture pair. The fixture
benchmark below measures catalogue checks separately from Codex host delivery.
Tool catalogue declarations also remain distinct from actually running the tool
against a clean baseline and a planted violation.

After installation, `selftest --live` sends synthetic events directly through
Jig's runner and checks that its ledger grows. It demonstrates detector behavior;
it does not prove Codex dispatched a hook or blocked a real tool call. Actual
session enforcement needs trusted registration and a separate safe tool-call
probe in the host being used. The close reports missing evidence explicitly.

The shell hook name `Bash` is Codex's canonical event name and can carry a
PowerShell command. Patterns match the command text; a name or operating system
is not proof of dialect coverage. Patch guards reconstruct supported
`apply_patch` changes before they land, including exact, trailing-whitespace,
trimmed and Unicode-normalized context matching. A file that cannot be inspected
remains a disclosed gap; other readable files still evaluate, and their denials
are preserved. External edits and shell-driven rewrites remain outside patch
coverage.

Measured Codex CLI 0.145.0 and 0.153.4 shell PostToolUse events provide raw stdout
without an exit status. A matching named run therefore records `verify-unknown`;
a direct successful shell call does not supply Jig with proof of success. For
an approved verification entry assigned to the commit lane, run:

```text
node .jig/checks/run.mjs --verify --lane commit --entry <id>
```

The driver runs the configured command and records its true zero or nonzero exit.
Read `.jig/verify.json` to select an existing entry and lane; a CI-only entry
requires `--lane ci`. The lane flag selects commands and labels the ledger row.
It does not prove a Git commit or hosted CI job occurred. See the
[Codex runtime guide](../skills/jig/references/codex-runtime.md#reliable-verification-evidence)
for reporting and authorization details.


## Reversibility and maintenance

- Every installation write is journaled with its original bytes. Revert restores
  the manifest and lockfile too, then prints the package manager's reconcile
  command. Installed packages remain on disk until that command is run.
- Drift is reported. Jig refuses to overwrite an owner-edited file during apply
  or revert; forced restoration is an explicit owner decision.
- False-alarm recording does not silently lower enforcement. Quieting or retiring
  a guard produces a concrete change that requires named consent. Clearing a
  mistaken false-alarm record keeps the earlier evidence in the ledger.
- Governance pointers and the standing checks brief share one bounded Jig fence
  in the active root `AGENTS.md`, or `AGENTS.override.md` when present. Owner text
  outside that fence is preserved. A pointer is guidance, not executable scope
  enforcement.
- Commit the install: `.jig/config.json`, `manifest.json`, `checks/`, `hooks/`,
  `activation.md`, `verify.json` and `proposed-permissions.json`. Jig adds ignore
  entries for derived plans and machine-specific records without rewriting owner
  entries. Never treat an ignored ledger's absence in a clone as proof of no
  historical activity.
- Kill switch: create `.jig/off` to silence session guards. The committed checks,
  commit hook and CI workflow keep running.

Ask `$jig` to undo all or a named installation change. For direct engine use,
replace `<JIG_ROOT>` below with this plugin's absolute directory and run from
the target project root:

```text
node "<JIG_ROOT>/scripts/jig.js" status
node "<JIG_ROOT>/scripts/jig.js" revert --all
```
