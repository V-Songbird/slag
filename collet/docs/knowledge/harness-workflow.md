---
type: knowledge
summary: "Explains Collet's task lifecycle, configuration, optional checks, fixture benchmark, interactive Claude Code setup and enforcement limits; read when mounting, operating or testing the harness."
related_files:
  - collet/README.md
  - collet/scripts/mount.mjs
  - collet/templates/task.mjs
  - collet/templates/config.json
  - collet/templates/checks/scope.mjs
  - collet/templates/checks/run.mjs
  - collet/hooks/handoff.js
  - collet/hooks/session-start.js
  - collet/catalogue/
  - collet/skills/task-harness/SKILL.md
  - collet/skills/check-writer/SKILL.md
---

# Collet harness workflow

Requires Node 22 or later and a Git repository with a committed baseline. Host installation is in the [README](../../README.md).

## Mount and open a task

Use the skill invocation in the [README](../../README.md), or run the command below from the Slag repository root. Replace `<project-directory>` with the target repository path and the accept placeholder with its real verification command:

```bash
node collet/scripts/mount.mjs "<project-directory>" --accept "<the command that proves a task worked>"
```

Expected output:

```text
collet mounted into /path/to/project

  wrote    .collet/task.mjs
  wrote    .collet/state.mjs
  wrote    .collet/checks/run.mjs
  wrote    .collet/checks/scope.mjs
  …
  wrote    .collet/.gitignore
  wrote    .collet/config.json — fill in the project line, the conventions and the accept command
  wrote    .collet/unverified.md
  wrote    AGENTS.md

next:
  1. Fill in .collet/config.json — the project line and the conventions a change must respect.
     A task cannot be opened while the project line or the accept command is a placeholder.
  2. Open the first task, with the scope derived from reading the code it touches:
       node .collet/task.mjs add --title "..." --why "..." --scope "src/**,test/**"
  …
```

A second run refreshes collet's own scripts: `task.mjs`, `state.mjs` and the built-in scope checks. Keep your own checks in their own files. Your `config.json` and `unverified.md` are kept.

Generated bundle checks and their examples are also kept. `.collet/source.mjs`, the bundle checks' shared runtime, is refreshed while it still holds what collet wrote; a copy with edits of your own is kept, and the mount says how to take this version's fixes to it: remove it and mount again. After a refresh the mount proves the checks against their examples, as a mount with `--checks` does. The rules block sits between its own markers, so a second run replaces it and leaves your text untouched.

In the target project, fill in `.collet/config.json` with real project details and an acceptance command that verifies the work. For a project containing `src/cart.mjs`, open a task with:

```bash
node .collet/task.mjs add --title "Round the cart total" --why "Prices show three decimals" --scope "src/cart.mjs"
```

The command prints the open task, its scope, and the configured acceptance command. Run these task commands from the target project directory.

From here the session is held. A write to a file outside the list comes back refused:

```text
src/checkout.mjs is outside the open task (t1). Writable: src/cart.mjs. Widen the task
only for a file the stated task needs: node .collet/task.mjs widen --add <path>
--why "<reason>". If the file goes beyond what the person asked for, ask them first.
When the file is not needed, or nobody can be asked, leave it alone and name it in your
summary.
```

Closing proves the scope held before it runs the accept command:

```bash
node .collet/task.mjs close --left-out "currency formatting" --unverified "nobody ran this against real prices"
```

The command checks the changed files against the task scope, runs the configured acceptance command, and closes the task only when both succeed.

Either half failing leaves the task open. Checks that cannot run also prevent closure; the accept command waits until live checks pass.

The mount's own writes are not task changes: `.collet/` and the rules block between its markers in `AGENTS.md`, `CLAUDE.md` or `.cursor/rules/collet.md`. The first task can therefore close before you commit the mount. Any other change outside the scope still keeps the task open, including your own text in those files.

## Commands

| You want to… | Command |
| --- | --- |
| Set the harness up in a repository | `/collet:task-harness` |
| Add the optional language checks | Ask `/collet:task-harness` to mount with the checks for tests and verification settings |
| See the open task and what it may touch | `/collet:task-harness what's the task?`, or `node .collet/task.mjs status` |
| Open a task | `node .collet/task.mjs add --title "..." --why "..." --scope "src/cart.mjs,test/**"` |
| Add a file the stated task needs; ask the person first for one beyond their request | `node .collet/task.mjs widen --add <path> --why "<reason>"` |
| Finish one | `node .collet/task.mjs close --left-out "..." --unverified "..."` |
| Prove the checks still catch what they claim | `node .collet/checks/run.mjs` |
| Check the working tree against the open task | `node .collet/checks/run.mjs --live` |
| Guard a mistake that keeps happening | `/collet:check-writer help me catch skipped tests` |

Add checks between tasks. While a task is open, the guard refuses writes under `.collet/` except `.collet/unverified.md`, because the harness's own files are not task files. Widening the task does not lift that refusal. Close the open task first, write and admit the check, then open the next task. The check then runs at write time and when that task closes.

## How it works

- **"Finished" stops being an opinion.** Closing runs the accept command itself. A non-zero exit leaves the task open.
- **Drift gets refused, not reported.** The guard reads write tools, patches, and the shell forms it can read with certainty. It also reads `rm -rf` on a directory, which is the one command worth catching before it lands.
- **JavaScript/TypeScript imports expand the list.** Name the module that owns the behaviour, and collet adds its relative imports, with a reason for each addition. For other languages, derive and list the scope by reading the code.
- **"Covered" means caught.** Every check ships with a planted mistake and a lookalike. A failed pair is reported and never counted as coverage.
- **It stays out of a project that plans its work elsewhere.** The mount refuses recognized planning records and writes nothing there; see [roadmap detection](#roadmap-detection).

### Roadmap detection

The mount refuses when `.foreman` exists, or when parsed `ROADMAP.jsonl` records match either condition:

- The first valid record has a `foreman_roadmap_format` property.
- A record has an `id` and an array named `planned_touches` or `touches`.

An absent, empty, malformed or unrecognized roadmap alone does not trigger this automatic refusal.
The mounting skill asks who owns the plan before invoking the script.
See [runtime contracts](runtime-contracts.md) for scope, host context and closure behavior.

### Optional checks for tests and verification settings

Optional language checks catch patterns that weaken the command used to finish a task. Examples include skipped tests, empty test bodies, blanket suppressions and commands that hide test failures.

| Language | Checks | Example root marker |
| --- | --- | --- |
| JavaScript/TypeScript | 11, plus 1 opt-in | `package.json` |
| Python | 8 | `pyproject.toml` |
| Go | 5 | `go.mod` |
| Rust | 7 | `Cargo.toml` |
| JVM | 6 | `build.gradle.kts` or `pom.xml` |
| .NET | 9 | `*.csproj` or `*.sln` |

From the Slag repository root, replace `<project-directory>` with your repository's path and the accept command with its real verification command:

```bash
node collet/scripts/mount.mjs "<project-directory>" --accept "npm test" --checks
```

The mount selects every language detected at the project root and proves its examples before writing. It then runs the example pairs in the mounted project. A failed pair exits non-zero. The checks read source text; they do not require installing those languages' toolchains.

Failures in mounted checks are recorded in `.collet/checks/discarded.json`. This report does not disable a check.

For nested packages or a subset of languages, repeat `--edition <id>` to replace automatic selection. For example, append `--edition javascript-typescript --edition python` to select those two. Available ids are `javascript-typescript`, `python`, `go`, `rust`, `jvm` and `dotnet`. The override requires `--checks`. If no supported bundle is detected, mounting with `--checks` refuses before writing anything.

`type-widened-to-any` is opt-in: mount with `--with javascript-typescript.type-widened-to-any` to add it. The mount names each opt-in class it leaves out.

A fresh mount without `--checks` adds only scope. A later mount preserves each installed check revision and its examples, including your edits. New catalogue patterns do not upgrade those preserved files. A check missing its module or either kind of example stops the mount before writes; review it before trying again.

## Configuration

`.collet/config.json` holds three values, plus up to three optional ones that the mount writes only when asked: `ask_first`, `exclude` and `removed_checks`. A session is told all of them before it reads a file, so a placeholder left in `project` or `accept` blocks `task.mjs add`. A leftover `conventions` placeholder is dropped instead, and an empty list is valid.

| Name | Required | Default | What it does |
| --- | --- | --- | --- |
| `project` | yes | `REPLACE ME: …` | One line on what this repository is and what it runs on |
| `conventions` | no | two `REPLACE ME` entries | Decisions that constrain what a change here may look like |
| `accept` | yes | `REPLACE ME: …` | The command a task closes with, unless the task names its own |
| `ask_first` | no | absent unless the mount got `--ask-first` | What must never happen here without asking the person; the rules block and the session start state it as a fact |
| `exclude` | no | absent unless the mount got `--exclude` | Path globs that no bundle check reads, at write time or at close, such as a committed generated mirror |
| `removed_checks` | no | absent unless the mount got `--remove` | Bundle checks the project took out; a remount keeps them out until `--restore` |

The rules block always goes into `AGENTS.md`. It also goes into `CLAUDE.md` when that file exists, and into `.cursor/rules/collet.md` when `.cursor/` exists. The mount does not create a new `CLAUDE.md`.

On Claude Code, the skill offers two permission ask rules for each `ask_first` item with a clear command, such as `Bash(npm publish *)` and `PowerShell(npm publish *)`, and says which items get none. A rule guards only the shell tool it names, and the project's settings are shared by contributors whose Claude Code may run commands through either tool, so both are offered and you confirm each one. It passes the rules you confirm as `--ask-rule "<rule>"`, and the mount adds them to `permissions.ask` in the project's `.claude/settings.json`, keeping everything already there. A headless or automated run cannot answer that prompt and stops at the matching command. With no confirmed rule, no settings file is written, and the mount never touches your user settings, `.claude/settings.local.json` or another host's configuration. There are no environment variables and no secrets.

Commit what lands in `.collet/`. The `.collet/.gitignore` it writes already leaves out what is derived or belongs to your machine.

Kill switch: create `.collet/off` and every session guard goes silent. The committed checks never read it.

## Benchmarks

| What | Score |
| --- | --- |
| Planted violations the scope check catches | **5 of 5** |
| Lookalikes it leaves alone | **6 of 6** |

How we tested: `node .collet/checks/run.mjs` in a mounted project, on the fixtures the scope check is admitted on.

Expected output:

```text
ok   scope — 5 violation(s) caught, 6 near miss(es) left alone
```

## In an interactive Claude Code session

On Claude Code 2.1.278:

- Auto is the default permission mode, and in it a classifier answers most permission prompts. Start the session with `claude --permission-mode manual` to approve or refuse each tool call yourself, including `widen` and `close`.
- Answering No to a permission prompt ends the turn at once, and nothing more runs until you send a message.
- A manual `/compact` runs the `PreCompact` hook, which writes `.collet/handoff.md`, and then the `SessionStart` hook again. That second start gives the compacted session the open task, its scope with any widening, and the handoff.

## In a headless Codex session

On Codex CLI 0.155.1, `SessionStart` context is added at the start of every `codex exec` and `codex exec resume` turn. An automatic compaction runs the `PreCompact` hook, which writes `.collet/handoff.md`, and within the same turn the `SessionStart` context reappears with the open task, its scope with any widening, and the handoff. This was observed with a script answering and the context window lowered per run with `-c model_context_window`.

Automatic compaction on Claude Code, and compaction in an interactive Codex session, have not been observed.

## Limits

- Antigravity calls that omit workspace context need an absolute tool path to locate the harness. Relative arguments cannot establish that context.
- With no task open, nothing is enforced. That is deliberate.
- The scope check reads the shell forms it can read with certainty: redirects, `cp`, `mv`, `rm`, `tee`, `sed -i`, and the common PowerShell cmdlets. A path built from a variable, or a file written by a program it invoked, goes through. It narrows the hole, and does not close it.
- The optional bundle reads `Write`, `Edit` and `MultiEdit` text. Shell writes, Codex patches, Antigravity file text and unsupported notebook edits wait for `close` or `run.mjs --live`. Only files matching a check's paths are read. On Codex CLI 0.155.1 a skipped test added by a patch was allowed at the call and refused at `close`.
- JavaScript skip and focus checks recognize Jest/Vitest calls and simple native `node:test` inline options such as `{ skip: true }` and `{ only: true }`. Dynamic calls, quoted option keys and complex option objects remain outside that coverage. An Edit containing only an option change needs the later full-file check to see its call context.
- Bundle checks compare each detector's match count in changed files against `HEAD`; untracked files start at zero. An increase fails unless the matches moved: one removed from another changed file and added with the same text, ignoring whitespace, is not new. Replacing one existing match with another can leave that count unchanged, and removing an identical line from an unrelated file reads as a move.
- The call-time check compares an edit only with that file's own text, so it refuses matches moved into a new file even though closing accepts them. To split a file, copy it with a shell command or `git mv`, then trim each copy with edits that only remove lines; closing checks the moved result against `HEAD`.
- Closing treats the text between the collet markers as the harness's own, so it does not report an edit made there. While a task is open, the session guard still refuses writes to a rules file the task does not list.
- An unavailable `HEAD` or unreadable source is reported as skipped. Closing uses `--live --strict`, so skipped checks prevent completion. Custom checks need a working-tree check to allow closure.
- Planted examples do not establish a false-alarm rate on your code. The mount installs no commit or push hook.
- A green accept command means one command exited zero and the writes stayed inside a list someone drew. It does not mean the work is correct.

### Host coverage

The published skills are discovered in Claude Code, Codex and the Antigravity IDE. Mounting and check writing have run in Claude Code, headless Codex CLI 0.155.1 and headless Antigravity CLI 1.2.9 without `--sandbox`, and on Codex a collet refusal stopped a write outside the open task. Both flows in the Antigravity IDE remain unverified.

A collet refusal and a verified close inside a long interactive session have been observed on Claude Code 2.1.278, with a script rather than a person answering the prompts, and in the Antigravity IDE 2.17.0 across two interactive conversations, with a person answering.

A manual `/compact` on Claude Code 2.1.278 carries the open task into the compacted session. Automatic compaction has been observed only on headless Codex CLI 0.155.1. The sections [In an interactive Claude Code session](#in-an-interactive-claude-code-session) and [In a headless Codex session](#in-a-headless-codex-session) describe each.
