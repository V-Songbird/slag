---
type: knowledge
summary: "Explains Collet's task lifecycle, configuration, optional checks, fixture benchmark, and enforcement limits; read when mounting or operating the harness."
related_files:
  - collet/README.md
  - collet/scripts/mount.mjs
  - collet/templates/task.mjs
  - collet/templates/config.json
  - collet/templates/checks/scope.mjs
  - collet/templates/checks/run.mjs
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
     A task cannot be opened while those placeholders are still there.
  2. Open the first task, with the scope derived from reading the code it touches:
       node .collet/task.mjs add --title "..." --why "..." --scope "src/**,test/**"
  …
```

A second run refreshes collet's own scripts: `task.mjs`, `state.mjs` and the built-in scope checks. Keep your own checks in their own files. Your `config.json` and `unverified.md` are kept.

Generated bundle checks, their examples and `source.mjs` are also kept. The rules block sits between its own markers, so a second run replaces it and leaves your text untouched.

In the target project, fill in `.collet/config.json` with real project details and an acceptance command that verifies the work. For a project containing `src/cart.mjs`, open a task with:

```bash
node .collet/task.mjs add --title "Round the cart total" --why "Prices show three decimals" --scope "src/cart.mjs"
```

The command prints the open task, its scope, and the configured acceptance command. Run these task commands from the target project directory.

From here the session is held. A write to a file outside the list comes back refused:

```text
src/checkout.mjs is outside the open task (t1). Writable: src/cart.mjs. If the file is
genuinely part of the task, widen it first: node .collet/task.mjs widen --add <path>
--why "<reason>". That is allowed and recorded. Otherwise leave it alone and say in your
summary what you found instead.
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
| Add a file the task genuinely needs | `node .collet/task.mjs widen --add <path> --why "<reason>"` |
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
| JavaScript/TypeScript | 12 | `package.json` |
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

A fresh mount without `--checks` adds only scope. A later mount preserves each installed check revision and its examples, including your edits. New catalogue patterns do not upgrade those preserved files. A check missing its module or either kind of example stops the mount before writes; review it before trying again.

## Configuration

`.collet/config.json` holds three values. A session is told all of them before it reads a file, so a placeholder left in the file blocks `task.mjs add`.

| Name | Required | Default | What it does |
| --- | --- | --- | --- |
| `project` | yes | `REPLACE ME: …` | One line on what this repository is and what it runs on |
| `conventions` | no | two `REPLACE ME` entries | Decisions that constrain what a change here may look like |
| `accept` | yes | `REPLACE ME: …` | The command a task closes with, unless the task names its own |

The rules block always goes into `AGENTS.md`. It also goes into `CLAUDE.md` when that file exists, and into `.cursor/rules/collet.md` when `.cursor/` exists. The mount does not create a new `CLAUDE.md`. There are no environment variables and no secrets.

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

## Limits

- Antigravity calls that omit workspace context need an absolute tool path to locate the harness. Relative arguments cannot establish that context.

- With no task open, nothing is enforced. That is deliberate.
- The scope check reads the shell forms it can read with certainty: redirects, `cp`, `mv`, `rm`, `tee`, `sed -i`, and the common PowerShell cmdlets. A path built from a variable, or a file written by a program it invoked, goes through. It narrows the hole, and does not close it.
- The optional bundle reads `Write`, `Edit` and `MultiEdit` text. Shell writes, Codex patches, Antigravity file text and unsupported notebook edits wait for `close` or `run.mjs --live`. Only files matching a check's paths are read.
- JavaScript skip and focus checks recognize Jest/Vitest calls and simple native `node:test` inline options such as `{ skip: true }` and `{ only: true }`. Dynamic calls, quoted option keys and complex option objects remain outside that coverage. An Edit containing only an option change needs the later full-file check to see its call context.
- Bundle checks compare each detector's match count in changed files against `HEAD`; untracked files start at zero. An increase fails. Replacing one existing match with another can leave that count unchanged.
- Closing treats the text between the collet markers as the harness's own, so it does not report an edit made there. While a task is open, the session guard still refuses writes to a rules file the task does not list.
- An unavailable `HEAD` or unreadable source is reported as skipped. Closing uses `--live --strict`, so skipped checks prevent completion. Custom checks need a working-tree check to allow closure.
- Planted examples do not establish a false-alarm rate on your code. The mount installs no commit or push hook.
- A green accept command means one command exited zero and the writes stayed inside a list someone drew. It does not mean the work is correct.
