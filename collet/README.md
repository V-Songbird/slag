# collet

collet holds a coding session inside the task it was given. One task is open at a time. That task names the files it may write and the command that decides when it is finished. A write outside that list is refused at the moment the session reaches for it, not found afterwards in a diff nobody read.

Use it on a repository where an agent drifts past the task, or calls work finished without running anything. It is not a planner and not a test runner: it constrains work that is already planned.

> **Experimental.** No support and no stability promise. It can change shape or disappear without a migration path.

## Requirements

- Node 20 or later, with no other dependencies.
- Claude Code, Codex or Antigravity for the session hooks. The checks themselves run on plain `node`, with no plugin installed.
- A git repository. The scope check reads `git diff` and `git ls-files` to see what changed.

## Install

**Claude Code**

```text
/plugin marketplace add V-Songbird/slag
/plugin install collet@slag
```

Takes effect next session.

**Codex** — add this repository as a marketplace, then install `collet` from `Slag · Codex`.

**Antigravity** — there is no marketplace. Clone the repository and run `agy plugin install <path-to-clone>/collet`, or copy the `collet/` directory to `.agents/plugins/collet/` for one workspace or `~/.gemini/config/plugins/collet/` for every workspace.

Once installed, collet runs three hooks. It states the open task at session start, guards each write, and writes a handoff before compaction. Only the guard is wired on Antigravity, which has no session start or compaction event. There, the rules block and `node .collet/task.mjs status` state the open task.

## Quick start

Ask the session to set the harness up. On Claude Code, type `/collet:collet`. On Codex, type `$collet`. On Antigravity, type `/collet`. That runs the mount command below, which you can also run yourself from a clone of this repository:

```bash
node collet/scripts/mount.mjs <project-directory> --accept "<the command that proves a task worked>"
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

A second run refreshes collet's own scripts: `task.mjs`, `state.mjs` and the shipped checks. Keep your own checks in their own files. Your `config.json` and `unverified.md` are kept. The rules block sits between its own markers, so a second run replaces it and leaves your text untouched.

Fill in `.collet/config.json`, then open a task:

```bash
node .collet/task.mjs add --title "Round the cart total" --why "Prices show three decimals" --scope "src/cart.mjs"
```

Expected output:

```text
task t1 — Round the cart total [in_progress]
  why:    Prices show three decimals
  scope:  src/cart.mjs
  accept: node -e 0
  widened 0x
```

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

Expected output:

```text
checking the working tree against the task:
open task t1 — "Round the cart total"
ok   scope — everything changed is inside the task

running accept command: node -e 0
task t1 closed. Nothing changed outside its files, and the accept command exited 0.
```

Either half failing leaves the task open.

## What you can do

| You want to… | Command |
| --- | --- |
| Set the harness up in a repository | `/collet:collet` |
| See the open task and what it may touch | `/collet:collet what's the task?`, or `node .collet/task.mjs status` |
| Open a task | `node .collet/task.mjs add --title "..." --why "..." --scope "src/cart.mjs,test/**"` |
| Add a file the task genuinely needs | `node .collet/task.mjs widen --add <path> --why "<reason>"` |
| Finish one | `node .collet/task.mjs close --left-out "..." --unverified "..."` |
| Prove the checks still catch what they claim | `node .collet/checks/run.mjs` |
| Check the working tree against the open task | `node .collet/checks/run.mjs --live` |
| Guard a mistake that keeps happening | `/collet:collet-check help me catch skipped tests` |

## How it works

- **"Finished" stops being an opinion.** Closing runs the accept command itself. A non-zero exit leaves the task open.
- **Drift gets refused, not reported.** The guard reads write tools, patches, and the shell forms it can read with certainty. It also reads `rm -rf` on a directory, which is the one command worth catching before it lands.
- **The list corrects itself.** Name the module that owns the behaviour, and collet pulls in what that module imports. It prints the reason for each addition. A list one file too narrow does not block work. It quietly pushes the change into the wrong file.
- **"Covered" means caught.** Every check ships with a planted mistake and a lookalike. One that cannot catch its own violation is discarded and named, not counted.
- **It stays out of a project that plans its work elsewhere.** The mount refuses and writes nothing there. A repository that keeps a `ROADMAP.jsonl` or a `.foreman/` directory owns its own plan, and [the decision record](../docs/decisions/roadmap-ownership.md) says why.

## Configuration

`.collet/config.json` holds three values. A session is told all of them before it reads a file, so a placeholder left in the file blocks `task.mjs add`.

| Name | Required | Default | What it does |
| --- | --- | --- | --- |
| `project` | yes | `REPLACE ME: …` | One line on what this repository is and what it runs on |
| `conventions` | no | two `REPLACE ME` entries | Decisions that constrain what a change here may look like |
| `accept` | yes | `REPLACE ME: …` | The command a task closes with, unless the task names its own |

The rules block always goes into `AGENTS.md`. It also goes into `CLAUDE.md` when that file exists, and into `.cursor/rules/collet.md` when `.cursor/` exists. The mount never creates a `CLAUDE.md`, which would hide `AGENTS.md` from Claude Code. There are no environment variables and no secrets.

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

- With no task open, nothing is enforced. That is deliberate.
- The scope check reads the shell forms it can read with certainty: redirects, `cp`, `mv`, `rm`, `tee`, `sed -i`, and the common PowerShell cmdlets. A path built from a variable, or a file written by a program it invoked, goes through. It narrows the hole, and does not close it.
- A green accept command means one command exited zero and the writes stayed inside a list someone drew. It does not mean the work is correct.

## Development

Run the suite from a clone of this repository:

```bash
cd collet
node --test
```

Expected output:

```text
# tests 65
# pass 65
# fail 0
```

`npm run check` from the repository root runs every suite in the repository.

The suite drives the hooks the way each host does, with that host's event on stdin.

Why each mechanism exists, and the defect behind it, is in [the design notes](../docs/knowledge/collet-design.md).

Two things are not proven. On Claude Code the plugin has loaded and refused a write in two short headless sessions, and in nothing longer or interactive. On Codex, the first runs found three defects that kept the guard from running at all, and with them fixed the guard has refused one file edit outside the task on codex-cli 0.155.1, in a headless session that bypassed hook trust. It has not been seen with its hooks trusted from `/hooks`, which is how you would run it; until you trust them there, that host skips them without saying so. On Antigravity the guard has not been seen to fire or to fail.

## Support

- Bugs, questions and security reports: the [issue tracker](https://github.com/V-Songbird/slag/issues) for this repository. It is the only channel, so anything you file is public.
- What changed: [CHANGELOG.md](./CHANGELOG.md), which follows Keep a Changelog.

## License

MIT — see [LICENSE](./LICENSE).
