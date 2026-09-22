---
type: knowledge
summary: "Collet's task, scope and check contracts; read before changing mounting, root resolution, the guard or task closure."
related_files:
  - collet/scripts/mount.mjs
  - collet/hooks/lib.js
  - collet/hooks/guard.js
  - collet/templates/
  - collet/tests/
---

# Collet runtime contracts

Collet holds one open task with an explicit writable scope and an acceptance command. It mounts
only where no other roadmap owns planning. Mounting never installs a Git hook or CI workflow.
The delivered project runtime uses .mjs files independently of the target package's module type.

## Project state and scope

The task CLI owns its ledger. Opening a task requires filled configuration and resolves supported
JavaScript/TypeScript imports to include the directly related files. Widening records a reason and
only expands from the added entries. Other language scopes must be derived from their source.

Scope accepts literal files, folders and supported globs. Reads are allowed outside writable
scope. Literal shell deletion checks every operand; moving checks source and destination, while
copy sources remain reads. Patches include every file operation and the Move to destination.
Dynamic shell expressions are outside this bounded parser. Existing policy permits paths outside
the repository and new shell scratch paths; live working-tree checks cover repository changes.

Explicit host project context takes precedence. With missing Antigravity workspace context,
absolute tool paths may identify the nearest mounted harness. Relative paths do not anchor a
project from the plugin's working directory.

## Checks and closure

A check is admitted only when it catches each shipped violation and leaves its near misses alone.
The session guard loads project checks with the scope fallback from the plugin. Hook errors fail
open; the explicit .collet/off file disables hooks, not committed standalone checks.

Closing a task first requires strict live checks against the Git baseline, including untracked
files, then runs the acceptance command. Missing scope, unavailable Git, skipped required checks
or invalid results cannot prove completion. A failing stage leaves the task open. A successful
close records what was left out and unverified and clears obsolete handoff state.

The optional language catalogue is a source-pattern policy, not a judgment of intent. Code text
unavailable at write time is evaluated later against the working tree. Custom checks must provide
real live coverage to support strict closure. Existing custom/generated checks are preserved
according to the mount preflight; collet-owned runtime files are refreshed on remount.

## Verification

Run npm run check for the repository or node --test from collet/. Fixtures are self-contained and
require no private notes or owner profile. See the [plugin README](../../README.md) for commands
and current limits, and the [harness workflow](harness-workflow.md) for configuration and usage.
