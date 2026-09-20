<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="collet" width="260" />
  </picture>
  <h1>collet</h1>
  <p><strong>A session will finish work it never did. collet makes "done" a command that exited zero.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — Your agent drifted three files past the task, called it finished, and the tests were never run. collet gives the session one open task, the exact files it may touch, and a command that decides when it's over. Writes outside the list are refused as they happen. 5 of 5 planted violations caught, 0 false alarms on the lookalikes.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise — it can change shape or vanish without a migration path.

## What is this?

A collet is the sleeve in a lathe that grips the work so it cannot wander while it's being cut. This one does that to a coding session. One task is open at a time. That task names the files it may write and the command that proves it worked. A write outside the list is refused at the moment the session reaches for it, not found afterwards in a diff nobody read.

It isn't tied to one agent. The state is a JSONL file, the tools are Node scripts with no dependencies, and the rules go into `AGENTS.md`, `CLAUDE.md` and `.cursor/rules/` — the files every assistant already reads. Uninstall the plugin and the project's own checks still run on plain `node`.

## Why you'd want it

- **"Finished" stops being an opinion.** Closing a task runs the accept command itself. Non-zero exit, task stays open, and no amount of confidence changes that.
- **Drift gets refused, not reported.** The guard sees write tools, patches, and the shell forms it can read with certainty. It also sees `rm -rf` on a directory, which is the one command worth catching before it lands.
- **The list corrects itself.** Name the module that owns the behaviour and collet pulls in what that module imports, with the reason printed. A list one file too narrow doesn't block work — it quietly pushes the change into the wrong file.
- **"Covered" means caught.** Every check ships with a planted mistake and a lookalike. One that can't catch its own violation is thrown out and named, not counted.
- **It stays out of the way of a plan you already have.** If the project keeps a `ROADMAP.jsonl`, collet writes no ledger of its own and enforces the files that roadmap already declares.

## How it works

| Moment | What happens |
| --- | --- |
| **A session starts** | It's told the open task, the files it may touch, the command that ends it and the conventions a change has to respect — before it reads a single file. |
| **It reaches outside the list** | The write is refused, with the one command that widens the list and records why. Widening is allowed. Working around the list is not the same thing. |
| **It says it's done** | `close` checks the working tree against the task first, then runs the accept command. Either one failing leaves the task open. |
| **The context fills up** | A handoff is written with the task's id on it, so the next session is told where things stood instead of rebuilding it from a diff. |
| **You come back later** | `status` prints the open task, what it may touch, and the last few writes the guard refused. |
| **Nothing is open** | Nothing is enforced. That hole is deliberate and written down rather than hidden. |

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/slag
/plugin install collet@slag
```

Takes effect next session. On Codex, install collet from this repository's Codex marketplace, `Slag · Codex`.

## What you can do

| You want to… | Command |
| --- | --- |
| Set up the harness in a repository | `/collet` |
| See what the open task is and what it may touch | `/collet what's the task?` |
| Open a task | `node .collet/task.mjs add --title "..." --why "..." --scope "src/cli.mjs,test/**"` |
| Add a file the task genuinely needs | `node .collet/task.mjs widen --add <path> --why "<reason>"` |
| Finish one | `node .collet/task.mjs close --left-out "..." --unverified "..."` |
| Prove the checks still catch what they claim | `node .collet/checks/run.mjs` |
| Check the working tree against the open task | `node .collet/checks/run.mjs --live` |
| Guard a mistake that keeps happening | `/collet-check help me catch skipped tests` |

## Benchmarks

Every check ships with planted mistakes and the lookalikes written to fool it.

| What | Score |
| --- | --- |
| Planted violations the scope check catches | **5 of 5** |
| Lookalikes it leaves alone | **6 of 6** |
| Behaviour tests across the plugin | **68 of 68** |

How we tested: `node --test collet/tests/*.test.js` ships in the repo and reruns on every change; the fixtures are the same ones `node .collet/checks/run.mjs` uses for admission.

## Under the hood

Three hooks and two commands. The hooks state the task at session start, refuse a write at the moment it's made, and write a handoff before compaction. The refusing is done by a check that lives *in your project* — committed, reviewable, and runnable in CI with no plugin installed — so the thing that blocks a write in the editor is the same code that fails a build.

## Good to know

- Commit what lands in `.collet/`. The `.collet/.gitignore` it writes already leaves out what's derived or belongs to your machine.
- Kill switch: create `.collet/off` and every session guard goes silent. The committed checks never read it and go on running.
- The scope check reads the shell forms it can read with certainty — redirects, `cp`/`mv`/`rm`/`tee`, `sed -i`, and the common cmdlets. A path built from a variable, or a file written by a program it invoked, goes through. This narrows the hole that guarding write tools alone leaves; it does not close it.

> [!IMPORTANT]
> A green accept command means one command exited zero and the writes stayed inside a list someone drew. It does not mean the work is correct, and it is not a reason to review less.

## License

MIT — see [LICENSE](./LICENSE).
