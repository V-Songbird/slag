# Codex compatibility and validation

This is a Codex-only port of Jig 2.15.1 from the Slag marketplace. The source
snapshot is Slag commit `1e590477147cd3bc3aff1cc2812101484ed7961b`, imported as
standalone baseline commit `4d25001`. Development is on `Codex/jig`; the Slag
checkout and its `main` branch were not changed. See [behavior analysis](BEHAVIOR.md)
for the original harness workflow and its control boundaries.

## Preserved contract

Jig interviews the owner, authors checks for selected mistakes, proves them with
violation and near-miss fixtures, and installs the exact approved plan changes.
The journal, pre-image checks, proof drift demotion, observe mode, false-positive
review, committed driver, Git/CI wiring, and reversal remain in place. It does
not add a task-wide list of permitted edits or claim to prevent every form of
agent drift. Approval tokens bind changes and paths; they are not human identity
authentication.

## Host mapping

| Original surface | Codex implementation |
| --- | --- |
| Claude plugin manifest | `.codex-plugin/plugin.json`, native skills, default `hooks/hooks.json` |
| `/jig:jig`, `/jig:review`, `/jig:inventory` | `$jig`, `$review`, `$inventory` |
| Claude rule files | One owned fenced region in the effective root `AGENTS.md` or `AGENTS.override.md`, preserving owner prose and earlier governance pointers |
| Claude settings writes/probes | Retired; old records cannot authorize Codex settings writes; historical journal entries remain reversible |
| Shell tool guards | Native `Bash` hook payload, regardless of the model-facing shell tool name |
| Edit/Write guards | Native `apply_patch` reconstructed before/after, including add, update, delete, move, overwrite and Codex context matching |
| Verification observations | Explicit structured exit status only; raw stdout cannot establish success |
| Stop/SubagentStop | Advisory `systemMessage`, preserving Jig's original choice; no blocking or continuation request |

Codex discovers plugin hooks in `hooks/hooks.json`. The runtime command reads
`process.env.PLUGIN_ROOT` inside Node, avoiding shell-specific environment
expansion. Node.js 20 or later must be available on the host command runner's
PATH. This is a stdlib-only runtime; Git is needed for history and commit lanes.
Plugin structure and trust behavior follow the [official plugin specification](https://developers.openai.com/plugins/build/plugins).

Native hook output contains only accepted top-level fields. The internal `jig`
diagnostic object is available with `node hooks/runner.js <event> --diagnostic`
for direct tests; it is never sent to Codex. Unknown output fields can invalidate
a hook response, including a denial. The transport follows Codex's
[command runner](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/hooks/src/engine/command_runner.rs)
and [output parser](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/hooks/src/engine/output_parser.rs).

Patch reconstruction follows exact, trailing-whitespace, trimmed, and Unicode
matching with native first-match and replacement ordering. An unreadable or
unsupported file reports a gap without discarding another file's known denial.
The reference implementation is Codex 0.153.4's
[sequence search](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/apply-patch/src/seek_sequence.rs)
and [file update logic](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/apply-patch/src/file_update.rs).
A mutation through another tool remains outside this session edit lane.

## Trust and verification

Install and trust the generated package through Codex. Inspect `/hooks` in the
host to confirm Jig's source is enabled and trusted. A config entry or Jig's
`selftest --live` proves neither registration nor delivery in a real session;
reports leave host execution unverified until actual evidence exists. Errors
and invalid config retain the original fail-open contract. A changed proof can
demote enforcement to observing. Codex's [hook documentation](https://learn.chatgpt.com/docs/hooks)
describes the host controls; Jig deliberately keeps Stop advisory.

The measured Windows hosts deliver raw shell stdout without an exit code in
`PostToolUse`. Both a silent exit 0 and a silent exit 3 therefore become
`verify-unknown`. Output text claiming an exit status is never accepted as
execution evidence. To record a named approved check with its actual exit code,
use the existing driver and a lane the registry entry already allows:

```sh
node .jig/checks/run.mjs --verify --lane commit --entry <id>
```

The driver spawns the configured argv itself and records `verified` or
`verify-failed`. Here `commit` selects that command variant; the label does not
prove that Git invoked it. Likewise manually selecting `ci` does not prove a
hosted CI run. Do not change lane registration just to obtain a green record.

## Validation evidence

The host probe installs an unmodified generated marketplace package into an
isolated Codex home. A local deterministic Responses server supplies fixed tool
calls to the real runtime; it uses no model inference and copies no account
credentials. It checks command denial, edit denial, an allowed edit, unknown raw
shell outcomes, and actual passing/failing driver ledger records.

The Windows and Linux runtimes passed all eight assertions:

| Runtime | Version | Result |
| --- | --- | --- |
| Installed Codex CLI | 0.145.0 | 8/8 host assertions |
| Desktop-bundled Codex runtime on Windows, invoked as CLI | 0.153.4 | 8/8 host assertions |
| Official Linux Codex runtime under Ubuntu WSL | 0.153.4 | 8/8 host assertions |

Sanitized result records are in [validation](validation/). These runs used the
explicit `--host-only` option: this machine's Windows sandbox setup failed or
stalled on allowed writes, and the standalone Linux archive/WSL environment
lacked the required `bwrap` helper. That option disables the child runtime's
OS sandbox for the fixed local fixtures. It tests the plugin's hook behavior,
not OS isolation. Normal probe runs request `workspace-write`.

```sh
npm test
npm run test:codex
# Optional real ecosystem builds/checkers on a provisioned machine:
npm run test:toolchains
node scripts/probes/codex-host.js --codex <native-codex-executable>
# Only for isolating hook behavior from a broken OS sandbox:
node scripts/probes/codex-host.js --codex <native-codex-executable> --host-only
```

The probe bypasses hook trust only for its freshly copied, vetted temporary
package. It does not change the owner's normal plugin configuration or trust.
Do not use that bypass as normal installation guidance.

Final regression runs on 2026-09-06 had zero failures:

| Environment | Node | Passed | Skipped | Mode |
| --- | --- | ---: | ---: | --- |
| Windows | 22.22.2 | 963 | 20 | Full suite including available ecosystem smoke checks |
| Ubuntu Linux under WSL | 22.23.2 | 926 | 61 | Portable suite with a native Linux PATH |

Skips are named in test output and do not establish coverage. The optional
external smoke checks, absent tools, OS-specific cases, editions without a
starter, and duplicate tool commands explain the different totals. Manifest
validation and all three skill validators passed. See the machine-readable
[regression results](validation/regression-results.json).

The CI matrix covers Node 20, 22 and 24 on Windows, macOS and Linux. It runs the
portable fixture and engine suite; use `npm run test:toolchains` on a provisioned
machine for external starter builds, tool executions and version probes. The
workflow has not run remotely, and those other Node/OS combinations are not
claimed as measured results.

## Remaining platform limits

The implementation targets desktop and CLI on Windows, macOS and Linux, but
this Windows workspace cannot prove every host combination. Native macOS
execution and desktop UI installation/trust have not been exercised. Invoking
the desktop-bundled binary validates its runtime hooks, not the UI. Linux host
behavior was also measured directly under Ubuntu WSL with the official Codex
runtime; native Linux desktop UI behavior remains unmeasured. These checks
remain release validation work; full end-to-end platform parity is not claimed.
