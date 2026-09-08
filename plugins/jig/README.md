<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="jig" width="240" />
  </picture>
  <h1>jig for Codex</h1>
  <p><strong>Catch the recurring mistakes you choose, with changes you can review and undo.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

Jig helps you add checks for mistakes you want to avoid: skipped tests, hidden
errors, or assertions removed to make a build pass. It reads the project, asks
for the decisions it cannot infer, and proposes checks and tools. You approve
the concrete changes before installation; Jig records how to undo them.

> Experimental. Checks cover specific mistakes and supported operations.
> A proven detector is not proof that your Codex host runs it. Jig reports
> session, commit and CI evidence separately. See [compatibility](docs/CODEX-COMPATIBILITY.md).

## Start here

If Jig is installed, use `$jig` in your project and describe what you need:

| You want to… | Say… |
| --- | --- |
| Set up checks | `$jig` |
| Understand current coverage | `$jig what are you checking, and what needs attention?` |
| See detected activity | `$jig what did you catch?` |
| Explain an installed file | `$jig why did you create .jig/activation.md?` |
| Review a mistaken alert | `$jig that alert was wrong` — name the guard or report |
| Add a protection | `$jig help catch skipped tests` |
| Undo an installation change | `$jig undo this installation change` — name the change |

Jig continues the relevant workflow in the same conversation. A question about
status or coverage reads the current state; it does not install or repair
anything. If the request is ambiguous, Jig clarifies the action before changing
anything. Select Jig's entry in the skill picker if another plugin uses the same
name; use the qualified name your host actually displays.

Reports start with **what Jig checks or detected**, **where it runs**, and
**what needs attention**. Ask for a specific check, the installed files, or
"the full report" to see the detail. Problems and unverified coverage stay
visible in the summary.

Setup has three stages:

1. **Understand your needs.** Jig reads the repository and asks only for
   unresolved preferences. Existing answers and detected facts are reused.
2. **Review the changes.** See the coverage and each proposed change, including
   its exact path and consequence. Choosing a tool is a preference for this
   proposal; approving its concrete changes authorizes installation.
3. **Apply and check.** Jig applies approved changes, demonstrates the detectors,
   reports what is still unverified, and explains how to undo the installation.

Jig supports JavaScript/TypeScript, Python, Go, Rust, JVM and .NET catalogues.
It also works in an empty folder, where it can propose the initial toolchain and
project files. Free-text mistakes can become authored checks; every admitted
check must detect its violation and spare its valid example.

## Install

You need Node.js 20 or later, Git for commit/history features, and a Codex host
with the plugin and hook support listed in [compatibility](docs/CODEX-COMPATIBILITY.md).
From the Jig directory (`plugins/jig/` in Slag), package into a new directory:

```text
node scripts/package-codex.js --out ../jig-codex-marketplace
codex plugin marketplace add ../jig-codex-marketplace
codex plugin add jig@jig-local
```

Start a fresh Codex task. Open `/hooks` in the host you use and review and trust
Jig's current definitions. Check trust after hook updates too. Packaging uses a
fresh directory and does not change your Codex settings; each desktop or CLI
installation needs its own runtime verification.

Node must also be available to the Codex hook process and Git hooks. On fnm/nvm
setups, follow your project's runtime instructions; a working terminal alone
does not prove the hooks can find Node.

## Options and direct access

| Need | Invocation |
| --- | --- |
| Skip the interview using the engine's selection, with every value labelled assumed; still approve concrete changes | `$jig --quick` |
| Full inventory of checks, files and coverage | `$inventory full` |
| One part of the inventory | `$inventory guards`, `$inventory checks`, `$inventory files`, or `$inventory lanes` |
| Activity summary and guard management | `$review` |
| Full activity and drift report | `$review full` |
| Move an existing project to Codex | `$jig migrate --host codex` |
| Move an existing project to Claude Code | `$jig migrate --host claude` |

Report detail words select the conversational response, not new engine flags.
Bare `$jig` on an existing installation keeps its setup/re-run workflow.
Use a status question when you only want to inspect it.

## Control and undo

- Each consequential change keeps its named id/path approval. Nothing is
  preselected. Unchanged explicit authorization from this conversation is reused.
- Report-only artifacts can be approved together. Quick mode keeps both
  approval tiers; it does not silently install the proposal.
- Recording a false alarm does not silently disable a guard. Changing its
  enforcement follows the existing named-change workflow.
- Installation writes retain their original bytes. Jig refuses to overwrite
  files you changed afterward. Package removal may need the reconcile command
  printed during undo; restoring a manifest does not remove packages from disk.
- Kill switch: create `.jig/off` to silence session guards. Commit and CI checks keep running.

Ask Jig to undo all or a named installation change. For the precise coverage
boundaries, verification evidence, host migration, direct engine commands and
reversal details, read [Operations and coverage](docs/OPERATIONS.md).

<details>
<summary>Catalogue detector benchmark</summary>

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


</details>

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


## License

MIT — see [LICENSE](./LICENSE).
