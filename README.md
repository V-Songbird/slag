<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="jig" width="240" />
  </picture>
  <h1>jig for Codex</h1>
  <p><strong>Install the guardrails your project needs, approve every consequential change by name, and watch each check catch a planted mistake before calling it proven.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

Jig interviews the project's owner, reads the repository and its Git history,
and installs reviewed, reversible tooling and checks for the mistakes the owner
chooses. It can prepare an empty project before application code is written.
This is the Codex-only port of Jig from the [Slag marketplace](https://github.com/V-Songbird/slag),
targeting the Codex desktop app and CLI on Windows, macOS and Linux.

> Experimental. The supported Codex hook contract and verification limits are
> recorded in [Codex compatibility](docs/CODEX-COMPATIBILITY.md). Detector tests
> and a plugin installation do not by themselves prove runtime enforcement in
> every host.

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
[The behavior analysis](docs/BEHAVIOR.md) explains the boundaries.

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

## Install

You need Node.js 20 or later, Git for commit/history features, and a Codex host
with the plugin and hook capabilities listed in [Codex compatibility](docs/CODEX-COMPATIBILITY.md).
From this repository, create a local marketplace in a new directory:

```text
node scripts/package-codex.js --out ../jig-codex-marketplace
codex plugin marketplace add ../jig-codex-marketplace
codex plugin add jig@jig-local
```

The packager creates a self-contained marketplace with the Jig plugin. It
refuses an existing output directory. Use a fresh output directory to package
an update, then use the Codex plugin manager to update its registration.
Packaging does not change the current user's Codex configuration.

Start a fresh Codex task. In the active host, open `/hooks` and review and trust
Jig's current hook definitions before expecting session guards to run. Check
trust again after a hook update. Confirm this separately in each desktop or CLI
installation you use; a successful CLI check does not certify another host.
If hooks are unavailable or untrusted, report the session lane as unverified.

The skills resolve their scripts from the actual loaded `SKILL.md` path. There
is no requirement to export a plugin-root variable in your shell. Node must
also be available to the Codex hook process and Git hooks; a working terminal
alone does not establish that.

## Use

| You want to… | Skill invocation |
| --- | --- |
| Set up guardrails, interview included | `$jig` |
| Use the engine's history-based or catalogue selection, with every value labelled assumed, then approve the concrete plan | `$jig --quick` |
| Prepare a new project's toolchain and checks | `$jig` in the empty folder |
| Review catches, record a false alarm or change a named guard's mode | `$review` |
| List every installed guard, check, file and lane, with reasons and drift | `$inventory` |

Select Jig's entry in the skill picker if another installed plugin uses the
same skill name. Use the qualified name that the host actually displays.

The scan runs before the interview, so repository facts are read once rather
than asked again. The owner supplies intent, mistakes, tools and mode choices.
Selection lists use stable ids and explicit replies; no multi-select UI is
required and no approval is preselected. Existing explicit authorization for
an unchanged named change, path and consequence is reused within the session.

Every plan shows a coverage matrix and concrete changes. Reporting artifacts
can be approved together. Each consequential change—including authored checks,
tool installs, hook wiring and writes outside `.jig/`—needs its named id/path
approval. The engine applies it with one `--change <id> --path <rel>` pair.
Quick mode skips interview rounds, and still requires these approvals.

Jig supports JavaScript/TypeScript, Python, Go, Rust, JVM and .NET catalogues.
It can write approved starter project files for supported editions. If a
project needs an owner-selected identity, such as a Go module path, the scan
returns the exact prerequisite. A starter is a project file, not an application
template. Tool installs show their exact commands, config bytes and undo steps.

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
[Codex runtime guide](skills/jig/references/codex-runtime.md#reliable-verification-evidence)
for reporting and authorization details.

## Fixture benchmark

These numbers measure the shipped language catalogues, not Codex host delivery.
They are recalculated by the test suite on every change.

| What | Score |
| --- | --- |
| Catalogue detector fixtures, each passing their own pair | **147 of 147** |
| Patterns those checks name, each proved on its own | **256 of 256** |
| Mistake classes across the six editions | 165 |
| Cross-sample hits, disclosed | 8 |

The eight cross-sample hits are declared findings against other checks' near-miss
samples; every check still passes its own violation/near-miss pair.

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

## License

MIT — see [LICENSE](./LICENSE).

## Develop and validate

Run `npm test` for the portable fixture and engine suite, or `npm run test:codex`
for the Codex-specific regressions. Run `npm run test:toolchains` on a provisioned
machine to enable the optional real ecosystem starter builds, tool executions
and version probes. Each unexecuted external smoke check is explicitly reported
as skipped; it is not counted as verified tool coverage. The CI matrix runs the
portable suite on Node 20, 22 and 24 across Windows, macOS and Linux.

Run `npm run probe:workflow` to replay the owner-control workflow in a disposable
repository, including named approvals, arming, false-positive review and exact
restoration of original project and Git bytes, retaining Jig audit records.
Decisions are predeclared fixtures; this does not simulate a human
interview or prove host delivery. Use the separate
[host probe](docs/CODEX-COMPATIBILITY.md#validation-evidence) for native tool
blocking. [Desktop acceptance](docs/DESKTOP-ACCEPTANCE.md) records the installed
plugin checks and their remaining limits.
