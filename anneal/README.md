# anneal

anneal helps coding agents navigate an existing project, review session detours, and align documentation with current behavior. It provides three skills for those tasks.

Use it on an existing project. A single rename or a new scaffold does not need it.

> **Experimental.** No support or stability promise. It can change or disappear without a migration path.

## Requirements

- Node 22 or later.
- Claude Code, Codex or Antigravity.
- For migration: a Git repository with a commit, a clean working tree, and `git config user.email` set. Audit mode does not require these.

## Install

**Claude Code**

```text
/plugin marketplace add V-Songbird/slag
/plugin install anneal@slag
```

Start a new session to load it.

**Codex** — add this repository as a marketplace and install `anneal` from `Slag`.
Before guarded work, open `/hooks` in Codex CLI and review and trust the plugin's `PreToolUse` hook.
Changed hook definitions need another review; see [Codex hook trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

**Antigravity CLI** — clone the repository, replace `<path-to-clone>` below, and run:

```shell
agy plugin install "<path-to-clone>/anneal"
agy plugin list
```

The list should name `anneal`, as it does on CLI 1.2.7. On CLI 1.2.8 and 1.2.9, headless runs without `--sandbox` ran the repo-layout audit, the docs-align audit and session review. With `--sandbox`, headless `agy` runs no shell command.

anneal acts on your request. Its enabled hook inspects shell commands and stays silent outside a migration branch.

## Quick start

Ask for an audit using the invocation for your host:

| Host | Request |
| --- | --- |
| Claude Code | `/anneal:repo-layout audit` |
| Codex | `$repo-layout audit` |
| Antigravity | `/repo-layout audit` |

The skill runs the scan and reports findings by severity, with counts and example paths, followed by informational observations that carry no severity. Audit mode changes nothing in the project on its own; it saves its findings only after you say yes to its offer.
A missing Node runtime prevents the scan from running; confirm `node --version` reports 22 or later in the host's environment.

From the Slag repository root, you can also run the scan directly. Replace `<your-repository>` with the directory to inspect:

```shell
node anneal/scripts/audit.js --root "<your-repository>"
```

It prints the findings, discovered map files, and available checks. Add `--json` for the evidence behind each count.

## What you can do

These examples use Claude Code syntax. On Codex use `$<skill-name>`; on Antigravity use `/<skill-name>`.

| Task | Request |
| --- | --- |
| Audit without edits | `/anneal:repo-layout audit` |
| Plan a migration and approve each step | `/anneal:repo-layout` |
| Propose instruction changes from one session | `/anneal:session-review [transcript file]` |
| Reconcile documentation and development files | `/anneal:docs-align [audit] [path or concern]` |

A migration runs baseline checks, proposes changes, and creates an `anneal/<YYYY-MM-DD>` branch for approved steps.
Each successful step is checked and committed. Session review proposes edits and waits for approval; it commits nothing.
Documentation cleanup applies authorized corrections. Its `audit` mode reports findings without edits and saves a report only after you say yes to its offer.

The [workflow guide](docs/knowledge/workflows.md) covers every audit finding, approval boundary, map-file format, safety hook, and standalone script.

## Configuration

anneal has no settings. Choose a skill and its mode.

## Limits

- Findings are heuristics; framework conventions and project instructions take precedence.
- Import rewriting covers relative JavaScript and TypeScript imports. Other references need review.
- Session review reads one transcript. Redaction is best effort; inspect excerpts before sharing them.
- Transcript parsing depends on the formats covered by tests. Antigravity requires an explicit transcript file.
- Documentation checks cover the stated evidence and do not scan Git history by default.
- A complete migration and the Git guard's refusal on its branch have been observed in interactive Claude Code 2.1.278 sessions, with a script rather than a person answering the prompts, and in the Antigravity IDE 2.17.0, with a person answering. On Codex CLI 0.155.1 a complete migration and the Git guard's refusal have been observed with a script answering and the project's `.git` added as a writable root; that plan only changed the map file, so a migration that moves files remains unverified on Codex. The published package installs on all three hosts, and its skills are discovered in Claude Code, Codex and the Antigravity IDE. The audits and session review have run from it in Claude Code, headless Codex CLI 0.155.1 and headless Antigravity CLI, and a repo-layout audit has run in the Antigravity IDE and the Codex desktop app 26.917. The other flows in the Antigravity IDE remain unverified.

Read the [full limits](docs/knowledge/workflows.md#limits) before migrating a shared repository.

## Development

From a clone of Slag, run:

```shell
cd anneal
node --test
```

The command reports test results and exits non-zero when a test fails. The suite covers the scripts and safety hook.
From the Slag root, `npm run check` runs all repository suites and also exits non-zero when a suite fails outside its tests.
The [eval instructions](docs/knowledge/workflows.md#running-the-evals) describe the additional sandbox and host requirements for session tests.

## Support

- Learn more: [workflow guide](docs/knowledge/workflows.md).
- Bugs and questions: the [issue tracker](https://github.com/V-Songbird/slag/issues), the only listed channel.
- Security: no dedicated reporting policy is provided; avoid posting sensitive details publicly.
- What changed: [changelog](docs/knowledge/changelog.md), which follows Keep a Changelog.

## License

MIT — see [LICENSE](LICENSE).
