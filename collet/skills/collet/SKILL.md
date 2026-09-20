---
name: collet
description: Mounts the collet harness into a project — the task ledger, the rules block in AGENTS.md/CLAUDE.md/.cursor/rules, and the checks directory — or reports on a project that already has one. Use when asked to set up a harness, guardrails, scope enforcement or session continuity for a repository, to adopt collet, or to see what the current task is, what it may touch, and what a session is not allowed to touch. ONLY on an explicit request: never from ordinary project work, from a new or empty repository, or from "set up this project".
---

# collet

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

Then **derive the task's scope by reading the code the task touches.** Not from the task's title.
This is the one mistake worth spending time on: a scope one file too narrow does not merely block
work, it pushes the session to work *around* the constraint, and a scope one file too wide never
fires at all. Open the modules the task names, follow what they import, and list what genuinely
has to change. `task.mjs add` will close your list over the files those files import and print what
it added, so name the modules that own the behaviour and let it pull in the rest.

**The accept command is a decision, not a formality.** If you cannot name a command that can tell
you the task worked, the task is not defined yet — say so instead of inventing one. `echo ok` is
not an accept command.

## Check first: who owns the plan here

Look for a `ROADMAP.jsonl` at the project root or a `.foreman/` directory. If either is there,
**this project already has a ledger and collet does not write a second one.** `mount.mjs` detects
this on its own and writes the harness in its other shape: no ledger, no `add`/`widen`/`close`, and
the guard enforcing the files the open roadmap entry already declares.

Say that out loud when you report. Two records of what a task may touch, with nobody sure which is
authoritative, is a worse outcome than having only one — and that is the outcome this split exists
to avoid. The gap collet fills there is real and narrow: a roadmap *declares* the files a task
should touch, and nothing stops a write landing somewhere else. This does, at the moment of the
write.

## Mount

```bash
node scripts/mount.mjs <project-directory> --accept "<the command that proves a task worked>"
```

It prints every path it wrote and every path it kept. It never overwrites a file that is already
there: the rules block goes between its own markers, so a re-run replaces the block and leaves
everything around it exactly as it was, and an existing `AGENTS.md` or `CLAUDE.md` keeps its text.

Then fill in `.collet/config.json` — the one-line description of the project and the conventions a
change here has to respect. **A task cannot be opened while those placeholders are still in the
file**, because a session is told that file before it reads anything and `REPLACE ME` is not a fact.

Then, on a project that owns its own ledger, open the first task:

```bash
node .collet/task.mjs add --title "..." --why "..." --scope "src/cli.mjs,test/**"
```

Then prove the harness works before saying it does:

```bash
node .collet/task.mjs status
node .collet/checks/run.mjs
```

The second one runs each check against its own violation and near-miss fixtures. A check that fails
its pair is discarded and reported, never counted. If the directory ships with no checks for this
project yet, say that plainly rather than showing an empty pass.

**Then stop.** Do not start executing the task you just created. Show what you wrote, name the
first task, and let the person decide.

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
