# anneal

anneal helps coding agents navigate an existing project, review session detours, find steps sessions repeat that a plain script could run, and align documentation with current behavior. It provides four skills for those tasks.

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

Start a new session to load it. In a terminal, `claude plugin list` names `anneal` once it is installed.

**Codex** — add this repository as a marketplace and install `anneal` from the `slag` marketplace, shown as `Slag`. The Codex commands for those two steps are not recorded here; follow Codex's own plugin documentation.
Before guarded work, open `/hooks` in Codex CLI and review and trust the plugin's `PreToolUse` hook.
Changed hook definitions need another review; see [Codex hook trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

**Antigravity CLI** — clone the repository, replace `<path-to-clone>` below, and run:

```shell
agy plugin install "<path-to-clone>/anneal"
agy plugin list
```

The list names `anneal`. If it does not, the install did not register: run the install command again with the clone path. With `--sandbox`, headless `agy` runs no shell command.

anneal acts on your request. Its guard hook inspects shell commands: on a migration branch it refuses the git commands that would discard or rewrite the migration's work, and on any other branch it asks first only before a command deletes, overwrites or moves a migration branch that holds commits the current branch lacks. On Claude Code that question is a permission prompt; how Codex and Antigravity handle it is unverified. On Claude Code, a second hook shows one line at session end when the session changed `docs/` or the memory folder and there are documentation proposals.

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

It prints the findings, discovered map files, available checks, and the characters each session loads before its first prompt. Add `--json` for the evidence behind each count.

## What you can do

These examples use Claude Code syntax. On Codex use `$<skill-name>`; on Antigravity use `/<skill-name>`.

| Task | Request |
| --- | --- |
| Audit without edits | `/anneal:repo-layout audit` |
| Plan a migration and approve each step | `/anneal:repo-layout` |
| Propose instruction changes from one session | `/anneal:session-review [transcript file]` |
| Check whether deleting a finished session would lose work | `/anneal:session-review closeout <session id or transcript file>` |
| Find repeated session steps a plain script could run | `/anneal:session-repeats [sessions folder or transcript files]` |
| Reconcile documentation, write a page for people, or write and review a README | `/anneal:repo-docs [audit\|maintain\|adopt\|readme] [path or concern]` |

A migration runs baseline checks, proposes changes, and creates an `anneal/<YYYY-MM-DD>` branch for approved steps.
Each successful step is checked and committed. Session review proposes edits and waits for approval; it commits nothing.
The repeated-step search reads this project's past sessions and proposes, for each step they repeated, a command or a short no-model script and the map-file line that names it; it writes only what you approve.
Documentation cleanup applies authorized corrections. Its `audit` mode reports findings without edits and saves a report only after you say yes to its offer. Its `adopt` mode writes the project-local documentation rule, a map pointer and, for a public solo repository, ignore rules from a shipped template, each after you approve it.
Its `readme` mode writes, reviews or repairs one README and runs a bundled checker on it.
Asked to write or review a help page, guide, FAQ or changelog, it follows its writing reference and reports what it could not check against the product.

The [workflow guide](docs/knowledge/workflows.md) covers every audit finding, approval boundary, map-file format, safety hook, and eval.

## Configuration

Choose a skill and its mode. To turn off the [session-end report](docs/knowledge/workflows.md#the-session-end-report), set `ANNEAL_SESSION_REPORT=off` in the `env` block of Claude Code's `settings.json` or in your shell.

## Limits

- Findings are heuristics; framework conventions and project instructions take precedence.
- Import rewriting covers relative imports in JavaScript and TypeScript family files (`.js`, `.ts`, `.vue`, `.svelte` and their variants). Other references need review.
- Session review reads one transcript. Redaction is best effort; inspect excerpts before sharing them.
- The repeated-step search matches steps as text after normalization. It finds Claude Code and Codex sessions on its own; on Antigravity it reads only the files you hand it. It has not run live on any host yet.
- Transcript parsing depends on the formats covered by tests. Antigravity requires an explicit transcript file. The close-out check reads Claude Code transcripts only.
- Documentation checks cover the stated evidence and do not scan Git history by default.
- A complete migration, with the Git guard's refusal on its branch, has been observed in Claude Code, Codex CLI and the Antigravity IDE. On Codex it only changed the map file, so a migration that moves files is unverified there.
- The audits and session review have run in Claude Code and in headless Codex and Antigravity CLI sessions. In the Antigravity IDE, flows other than the repo-layout audit and a migration are unverified.
- These results come from runs on specific host versions, some with a script rather than a person answering the prompts. [Host coverage](docs/knowledge/workflows.md#host-coverage) lists each run.

Read the [full limits](docs/knowledge/workflows.md#limits) before migrating a shared repository.

## Development

From a clone of Slag, run:

```shell
cd anneal
node --test
```

The command reports test results and exits non-zero when a test fails. The suite covers the scripts, the safety hook and the eval graders.
From the Slag root, `npm run check` runs all repository suites and also exits non-zero when a suite fails outside its tests.
The [eval instructions](docs/knowledge/workflows.md#running-the-evals) describe the additional sandbox and host requirements for session tests.

## Support

- Learn more: [workflow guide](docs/knowledge/workflows.md).
- Bugs and questions: the [issue tracker](https://github.com/V-Songbird/slag/issues), the only listed channel.
- Security: no dedicated reporting policy is provided; avoid posting sensitive details publicly.
- What changed: [changelog](docs/knowledge/changelog.md), which follows Keep a Changelog.

## License

MIT — see [LICENSE](LICENSE).
