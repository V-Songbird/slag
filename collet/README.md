# collet

collet holds a coding session inside the task it was given. One task is open at a time. That task names the files it may write and the command that decides when it is finished. A write outside that list is refused at the moment the session reaches for it, not found afterwards in a diff nobody read.

Use it on a repository where an agent drifts past the task, or calls work finished without running anything. It is not a planner and not a test runner: it constrains work that is already planned.

> **Experimental.** No support and no stability promise. It can change shape or disappear without a migration path.

## Requirements

- Node 20 or later, with no other dependencies.
- A git repository. The scope check reads `git diff` and `git ls-files` to see what changed.
- Claude Code or Codex for the session hooks. The checks themselves run on plain `node`, with no plugin installed.

## Install

**Claude Code**

```text
/plugin marketplace add V-Songbird/slag
/plugin install collet@slag
```

Takes effect next session.

**Codex** — add this repository as a marketplace, then install `collet` from `Slag · Codex`.

## Quick start

Ask the session to set the harness up, with `/collet`. That runs the mount command below, which you can also run yourself:

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
  wrote    .collet/config.json — fill in the project line, the conventions and the accept command
  wrote    .collet/unverified.md
  wrote    AGENTS.md
  wrote    CLAUDE.md

next:
  1. Fill in .collet/config.json — the project line and the conventions a change must respect.
     A task cannot be opened while those placeholders are still there.
  2. Open the first task, with the scope derived from reading the code it touches:
       node .collet/task.mjs add --title "..." --why "..." --scope "src/**,test/**"
```

Mounting never overwrites a file that is already there. The rules block goes between its own markers, so a second run replaces the block and leaves your own text untouched.

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

## Why you would want it

- **"Finished" stops being an opinion.** Closing runs the accept command itself. A non-zero exit leaves the task open, and no amount of confidence changes that.
- **Drift gets refused, not reported.** The guard reads write tools, patches, and the shell forms it can read with certainty. It also reads `rm -rf` on a directory, which is the one command worth catching before it lands.
- **The list corrects itself.** Name the module that owns the behaviour, and collet pulls in what that module imports. It prints the reason for each addition. A list one file too narrow does not block work. It quietly pushes the change into the wrong file.
- **"Covered" means caught.** Every check ships with a planted mistake and a lookalike. One that cannot catch its own violation is discarded and named, not counted.
- **It stays out of a project that plans its work elsewhere.** A repository that already keeps a `ROADMAP.jsonl` or a `.foreman/` directory is left untouched: the mount refuses and writes nothing. That tool owns the plan, and the files its entries name are a forecast it rewrites, not a boundary to refuse a write against.

## What you can do

| You want to… | Command |
| --- | --- |
| Set the harness up in a repository | `/collet` |
| See the open task and what it may touch | `/collet what's the task?`, or `node .collet/task.mjs status` |
| Open a task | `node .collet/task.mjs add --title "..." --why "..." --scope "src/cart.mjs,test/**"` |
| Add a file the task genuinely needs | `node .collet/task.mjs widen --add <path> --why "<reason>"` |
| Finish one | `node .collet/task.mjs close --left-out "..." --unverified "..."` |
| Prove the checks still catch what they claim | `node .collet/checks/run.mjs` |
| Check the working tree against the open task | `node .collet/checks/run.mjs --live` |
| Guard a mistake that keeps happening | `/collet-check help me catch skipped tests` |

## Configuration

`.collet/config.json` holds three values. A session is told all of them before it reads a file, so a placeholder left in the file blocks `task.mjs add`.

| Name | Required | Default | What it does |
| --- | --- | --- | --- |
| `project` | yes | `REPLACE ME: …` | One line on what this repository is and what it runs on |
| `conventions` | no | two `REPLACE ME` entries | Decisions that constrain what a change here may look like |
| `accept` | yes | `REPLACE ME: …` | The command a task closes with, unless the task names its own |

The rules block is written into `AGENTS.md` and `CLAUDE.md`, and into `.cursor/rules/collet.md` when the project already has a `.cursor/` directory. There are no environment variables and no secrets.

## Benchmarks

Every check ships with planted mistakes and the lookalikes written to fool it.

| What | Score |
| --- | --- |
| Planted violations the scope check catches | **5 of 5** |
| Lookalikes it leaves alone | **6 of 6** |
| Behaviour tests across the plugin | **59 of 59** |

Reproduce them with `node --test collet/tests/*.test.js` and `node .collet/checks/run.mjs`, which reads the same fixtures it uses for admission.

## Good to know

- Commit what lands in `.collet/`. The `.collet/.gitignore` it writes already leaves out what is derived or belongs to your machine.
- Kill switch: create `.collet/off` and every session guard goes silent. The committed checks never read it and go on running.
- With no task open, nothing is enforced. That hole is deliberate and written down rather than hidden.
- The scope check reads the shell forms it can read with certainty: redirects, `cp`, `mv`, `rm`, `tee`, `sed -i`, and the common PowerShell cmdlets. A path built from a variable, or a file written by a program it invoked, goes through. This narrows the hole that guarding write tools alone leaves; it does not close it.
- A green accept command means one command exited zero and the writes stayed inside a list someone drew. It does not mean the work is correct, and it is not a reason to review less.

## Development

```bash
node --test collet/tests/*.test.js
```

59 tests across five suites. The hooks are driven the way a host drives them, with the event on stdin.

Why each mechanism exists, and the defect behind it, is in [the design notes](../docs/knowledge/collet-design.md).

Two things are not proven. No session has loaded the plugin and reported `Loading hooks from plugin: collet`. The Codex wiring has unit coverage, but has never run on that host.

## Support

- Bugs and questions: the [issue tracker](https://github.com/V-Songbird/slag/issues) for this repository.
- What changed: [CHANGELOG.md](./CHANGELOG.md), which follows Keep a Changelog. Versions live in the marketplace entry, [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json).

## License

MIT — see [LICENSE](./LICENSE).
