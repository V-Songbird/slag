# collet

collet constrains a coding session to one open task, its writable files, and the command required to finish it. Hooks refuse recognized out-of-scope writes.

Use it when agents exceed the task's scope or finish without verification. It constrains already planned work; it does not plan the work.

> **Experimental.** No support or stability promise. It can change or disappear without a migration path.

## Requirements

- Node 22 or later, with no other dependencies.
- Claude Code, Codex or Antigravity for session hooks. Checks also run directly with Node.
- A Git repository with a committed baseline readable by the host. Scope checks use `git diff` and `git ls-files`.

## Install

**Claude Code**

```text
/plugin marketplace add V-Songbird/slag
/plugin install collet@slag
```

Start a new session to load it.

**Codex** — add this repository as a marketplace and install `collet` from `Slag`.
Before guarded work, open `/hooks` in Codex CLI and trust the plugin's `SessionStart`, `PreToolUse` and `PreCompact` hooks.
Changed definitions need another review; see [Codex hook trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

**Antigravity CLI** — clone the repository, replace `<path-to-clone>` below, and run:

```shell
agy plugin install "<path-to-clone>/collet"
agy plugin list
```

The list should name `collet`. Use CLI installation; workspace-directory discovery is unverified.

With hooks active, the session receives its task at startup, recognized writes are guarded, and a handoff is written before compaction.
Antigravity wires only the write guard. Its rules block and `node .collet/task.mjs status` provide task context.

## Quick start

Ask the session to mount the harness using your host's invocation:

| Host | Request |
| --- | --- |
| Claude Code | `/collet:task-harness` |
| Codex | `$task-harness` |
| Antigravity | `/task-harness` |

The skill establishes your project details, first task, scope, and real acceptance command before mounting.
It creates `.collet/`, adds the rules block to `AGENTS.md`, opens the task, and reports the fixture check results.
On Claude Code, it can also add the permission ask rules you confirm for your ask-first list to the project's `.claude/settings.json`.
It stops before performing the task itself.

Mounting refuses a project with `.foreman/` or a recognized planning record in `ROADMAP.jsonl` without writing files.
The [roadmap detection contract](docs/knowledge/harness-workflow.md#roadmap-detection) describes the accepted record shapes.
A placeholder left in the `project` or `accept` configuration value also blocks opening a task; fill them with the project's actual details.

In the mounted project, inspect the result:

```shell
node .collet/task.mjs status
node .collet/checks/run.mjs
```

The first command prints the open task, scope and acceptance command. The second reports whether each check catches its violations and permits its near misses.
When an active guard refuses a write, it names the affected path and the remedy that fits the refusal: widen the task with a recorded reason for a file the stated task needs (asking the person first for one beyond their request), change a harness file between tasks, or fix an edit that a check caught.

See the [harness workflow](docs/knowledge/harness-workflow.md) for direct mounting, task commands, optional language checks, and the fixture benchmark.

## What you can do

| Task | Request or command |
| --- | --- |
| Inspect the task | `node .collet/task.mjs status` |
| Check changed files | `node .collet/checks/run.mjs --live` |
| Add a check for a recurring mistake | `/collet:check-writer help me catch skipped tests` |

The skill example uses Claude Code syntax. On Codex use `$check-writer`; on Antigravity use `/check-writer`.
Optional bundles cover JavaScript/TypeScript, Python, Go, Rust, JVM and .NET source patterns without installing their toolchains.

## Configuration

Values live in `.collet/config.json`. There are no environment settings or secrets.

| Name | Required | Default | What it does |
| --- | --- | --- | --- |
| `project` | yes | `REPLACE ME: …` | Describes the project and runtime |
| `conventions` | no | two `REPLACE ME` entries | Constrains project changes |
| `accept` | yes | `REPLACE ME: …` | Command for closing tasks without their own override |
| `ask_first` | no | absent; set by `mount.mjs --ask-first` | Things the person is asked about before they happen |
| `exclude` | no | absent; set by `mount.mjs --exclude` | Path globs no bundle check reads, such as a generated mirror |
| `removed_checks` | no | absent; set by `mount.mjs --remove` | Bundle checks a remount keeps out |

Replace the `project` and `accept` placeholders before opening a task; leftover `conventions` placeholders are ignored. Creating `.collet/off` silences session guards; committed checks keep running.
The [configuration reference](docs/knowledge/harness-workflow.md#configuration) explains generated files, host rules, and remount behavior.

## Limits

- No open task means no enforcement.
- Shell analysis recognizes specific forms. Dynamic paths and writes performed by invoked programs can escape the guard.
- Optional checks inspect some edit tools immediately; other writes wait for working-tree checks.
- Closing requires strict live checks and the acceptance command to pass. Unavailable verification leaves the task open.
- Fixture success does not measure false alarms on your code, and an acceptance command passing does not establish correctness.
- A manual `/compact` on Claude Code 2.1.278 carries the open task into the compacted session. A collet refusal and a verified close inside a long interactive session have been observed on Claude Code 2.1.278, with a script rather than a person answering the prompts, and in the Antigravity IDE 2.17.0 across two interactive conversations, with a person answering. Automatic compaction has been observed only on headless Codex CLI 0.155.1. The published skills are discovered in Claude Code, Codex and the Antigravity IDE. Mounting and check writing have run in Claude Code, headless Codex CLI 0.155.1 and headless Antigravity CLI 1.2.9 without `--sandbox`, and on Codex a collet refusal stopped a write outside the open task. Both flows in the Antigravity IDE remain unverified.

The [full limits](docs/knowledge/harness-workflow.md#limits) describe host context requirements, pattern coverage, and baseline comparison behavior.

## Development

From a clone of Slag, run:

```shell
cd collet
node --test
```

The suite supplies host-shaped events to hooks, reports test results, and exits non-zero when a test fails.
From the Slag root, `npm run check` runs every suite and also exits non-zero when a suite fails outside its tests. Unit tests do not prove live host integration.

## Support

- Learn more: [harness workflow](docs/knowledge/harness-workflow.md).
- Bugs and questions: the [issue tracker](https://github.com/V-Songbird/slag/issues), the only listed channel.
- Security: no dedicated reporting policy is provided; avoid posting sensitive details publicly.
- What changed: [changelog](docs/knowledge/changelog.md), which follows Keep a Changelog.

## License

MIT — see [LICENSE](LICENSE).
