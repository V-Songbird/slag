---
name: task-harness
description: >-
  Mounts the collet harness into a project — the task ledger, the rules block
  in AGENTS.md/CLAUDE.md/.cursor/rules, and the checks directory — or reports
  on a project that already has one. Use when asked to set up a harness,
  guardrails, scope enforcement or session continuity for a repository, to
  adopt collet, or to see what the current task is, what it may touch, and
  what a session is not allowed to touch. ONLY on an explicit request, never
  from ordinary project work, from a new or empty repository, or from "set up
  this project". Not for writing a new check, which the check-writer skill
  does.
license: MIT
compatibility: Requires Node 22 or later and git.
metadata:
  version: "1.2"
---

# Task harness

The whole design is one sentence: **prose is read, a hook is executed, and a check that has never
been shown to fire is not a check.** Everything below follows from that.

Read the plugin's `README.md` — two directories up — for what ends up in the project. This file is how to mount it,
and the mounting itself is a command — `scripts/mount.mjs` — because the part that must be
identical every time has no business being a list of instructions someone follows by hand.

## Before you write anything

**Ask. Do not infer.** Read the repository first — its README, its test command, its decisions
docs, its git log — so the questions you ask are only the ones the repository cannot answer:

1. What is this project, in one line, and what does it run on?
2. What is the first task, and what command proves it works?
3. What must never happen here without asking? (deploy, spend, publish, delete, install)
4. Do you want checks that stop tests being switched off or checks being weakened during a task?

For question four, offer the bundle for the languages the project uses: JavaScript/TypeScript,
Python, Go, Rust, JVM or .NET. From the corresponding `catalogue/<id>.json`, extract only `title`,
`example` and `gapNotes` for this conversation; the fixture bodies belong to the runner.
Show one short example per mistake and one plain limit drawn from its `gapNotes`. Keep
the internal ids out of the conversation. The choices are the whole bundle or none for now;
another mistake can be added later with `check-writer`.

The bundle is optional. Include it when the person asks for it or accepts that choice; do not
ask again when their request already covers it. These are source-pattern checks; they do not
install compilers, linters or language runtimes. Do not offer coverage for languages outside that list.

Then **derive the task's scope by reading the code the task touches.** Not from the task's title.
This is the one mistake worth spending time on: a scope one file too narrow does not merely block
work, it pushes the session to work *around* the constraint, and a scope one file too wide never
fires at all. Open the modules the task names, follow what they import, and list what genuinely
has to change. For JavaScript/TypeScript, `task.mjs add` follows relative imports and prints what
it added. Other languages need that scope derived and
listed explicitly; a language bundle does not add import analysis for its language.

**The accept command is a decision, not a formality.** If you cannot name a command that can tell
you the task worked, the task is not defined yet — say so instead of inventing one. `echo ok` is
not an accept command.

## Check first: who owns the plan here

Look for a `ROADMAP.jsonl` at the project root or a `.foreman/` directory. If either is there,
**this project plans its work somewhere collet does not reach, and collet is not mounted here.**
`mount.mjs` detects it on its own, writes nothing and exits non-zero. Report that and stop; do not
work around it.

Two records of what a task may touch, with nobody sure which is authoritative, is the outcome this
refusal exists to avoid. There is also nothing to add: the files such a roadmap names are a
forecast the owning tool re-reads and rewrites, so refusing a write against them would enforce a
rule that tool never made.

## Mount

```bash
node "<plugin root>/scripts/mount.mjs" <project-directory> --accept "<the command that proves a task worked>"
```

`<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` on Claude Code. On Codex and Antigravity, resolve
`../../` from this `SKILL.md`.

When the person chose the checks, append `--checks`. Root marker files select every matching
language, including project/solution filename patterns for .NET. Read those markers and the
source so the selected set is part of the person's choice. For packages below the root or a
deliberate subset, repeat `--edition <id>` for each requested language; this replaces automatic
selection. The ids are `javascript-typescript`, `python`, `go`, `rust`, `jvm` and `dotnet`.
`--edition` requires `--checks`. With no supported bundle detected, `--checks` refuses before
writing anything; explain that result and do not silently fall back to mounting without checks.

It prints every path it wrote and every path it kept. A re-run refreshes collet's own scripts —
`task.mjs`, `state.mjs` and the built-in scope checks — and keeps the project's `config.json`,
`unverified.md`, generated bundle checks, their examples and `source.mjs`. Preserved checks keep
their own revision; newly shipped patterns and examples are not automatically applied to them.
A missing module or missing kind of example refuses the mount before writes; valid older pairs
and custom fixture suffixes are preserved and rechecked. The rules block goes
between its own markers, so a re-run replaces the block and leaves everything around it exactly
as it was. An existing `AGENTS.md` or `CLAUDE.md` keeps its text.

The block always goes into `AGENTS.md`. It goes into `CLAUDE.md` only when the project already has
one, and into `.cursor/rules/collet.md` only when `.cursor/` exists. **Do not create a `CLAUDE.md`
to receive it.** Claude Code reads `AGENTS.md` only while no `CLAUDE.md` exists, so a new one
holding just the block would hide the project's own instructions from that host.

Then fill in `.collet/config.json` — the one-line description of the project and the conventions a
change here has to respect. **A task cannot be opened while those placeholders are still in the
file**, because a session is told that file before it reads anything and `REPLACE ME` is not a fact.

Then open the first task:

```bash
node .collet/task.mjs add --title "..." --why "..." --scope "src/cli.mjs,test/**"
```

Then prove the harness works before saying it does:

```bash
node .collet/task.mjs status
node .collet/checks/run.mjs
```

The second one runs each check against its own violation and near-miss fixtures. Mounting with
`--checks` also runs this proof before reporting success. Report the actual number of bundle
checks that caught their planted mistake and left their look-alike alone, separately from scope.
If any fail, name them in plain words and say that setup did not pass. A failed check already in
the mounted project is recorded in `.collet/checks/discarded.json`; that file does not disable
the check, so never claim a failing check has stopped running. A fresh mount without the bundle
adds only scope; report any existing checks separately on a rerun.

Explain the bundle's limits before stopping:

- `Write`, `Edit` and `MultiEdit` can be checked while a task is open. Shell writes, Codex patch
  text, Antigravity file text and unsupported notebook edits are checked only by the later
  working-tree check, when their resulting files match the bundle's paths.
- JavaScript skip and focus checks recognize Jest/Vitest calls and simple native `node:test`
  inline options such as `{ skip: true }` and `{ only: true }`. Dynamic/aliased calls, quoted
  option keys and complex option objects are not covered. A tiny Edit without the test call's
  surrounding context can escape the editor check and is caught by the later full-file check.
- Closing compares each detector's match count in changed files with `HEAD` and refuses an
  increase. It does not locate each newly added mistake; replacing one existing match with
  another can leave the count unchanged. Untracked files have no prior matches.
- Closing runs `--live --strict`: unavailable baselines, missing working-tree checks and checks
  reported as skipped leave the task open and prevent the accept command from running. Restore
  the real prerequisite instead of weakening the check or substituting a quiet pass.
- Passing the planted examples does not measure false alarms on the person's real code. A
  refusal of an honest line belongs in the summary; do not remove a check to finish the task.
- The mount installs no commit or push hook. Those need a separate request.

**Then stop.** Do not start executing the task you just created. Show what you wrote, name the
first task, and let the person decide. Say that the mount's files are left uncommitted and that
committing them is the person's call. The first task can close before that commit: closing does not
count `.collet/` or the rules block between its markers, while any other change outside the task,
the project's own text in those files included, still keeps it open.

## Reporting the open task

When asked what is going on, answer from the ledger, not from the conversation:

```bash
node .collet/task.mjs status
```

It prints the open task, the files it may touch, the accept command, any widening already recorded,
and the last few writes the guard refused. Say also whether the harness is actually running: a
project with `.collet/` and no hooks wired is a project where nobody enforces anything, and that is
worth knowing before trusting it. `.collet/off` is the kill switch — if it exists, every session
guard is deliberately silent while the committed checks keep running.

## What to say when you are done

Three things, in your own words:

- **The guard binds only while a task is in progress.** With no open task it allows every write.
  Starting one is a command nobody runs by accident; that hole is deliberate and written down.
- **A green accept command is not a review.** It means one command exited zero and the writes
  stayed inside a list someone drew. It does not mean the work is correct.
- **The rules are the weakest part.** They are prose, and prose is followed at about the rate you
  would expect. The hook and the command are the parts that hold.
