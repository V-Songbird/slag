---
name: check-writer
description: >-
  Writes a new check for a project that uses collet — the mistake it catches,
  the check itself, and the two fixtures that prove it. Use when asked to
  guard a mistake that keeps happening, to add a check or guardrail, to stop
  an agent repeating a specific error, or when a mistake in this repository
  has a shape that could be caught by a machine. ONLY when the project already
  has a `.collet/` directory. Not for mounting the harness, which task-harness
  does.
license: MIT
compatibility: Requires Node 22 or later and a project with collet already mounted.
metadata:
  version: "1.1"
---

# Check writer

A check is admitted on one basis and no other: **it fires on its own violation fixture and stays
silent on its own near miss.** Nothing else counts — not who wrote it, not how sensible it sounds,
not how many other checks passed beside it. A second pattern is not covered because the pattern
next to it matched.

On Antigravity, give every command the project root the person named as its working directory, the
`Cwd` of `run_command`. Without it, commands can run in Antigravity's own scratch directory instead
of the project. When the person named no project root, ask for it before running anything.

## First, look for an open task

Run `node .collet/task.mjs status` before writing anything. While a task is open, the session guard
refuses writes under `.collet/` other than `.collet/unverified.md`: the checks, their fixtures and
the ledger are the harness's own state, not task files. Widening cannot lift that refusal, and
`task.mjs widen` refuses those paths.

If a task is open, tell the person before any write is refused, and add the check between tasks:

1. Finish the open task and close it:
   `node .collet/task.mjs close --left-out "..." --unverified "..."`. A task whose accept command
   does not pass yet cannot close; name the missing check in `--left-out` when it does close, or in
   your summary, so it is not lost.
2. With no task open, follow the steps below, admission included.
3. Open the next task. The check runs from then on, when a file is written and when a task closes.

Do not work around the refusal. The guard also refuses a shell command that would create a new file
under `.collet/`, `touch`, `ni` and `mkdir` included, a `.collet` path in another letter case, and
removing or moving `.collet` itself. It reads only the shell forms it recognizes, though, and the
close-time scope check skips that directory. A check that gets there another way is never
reviewed, yet it runs when the open task closes, and one without a working `live` keeps that task
open. `.collet/off` silences every session guard, the open task's scope included. Switching it on
is the person's decision, not a step of this skill.

## 1. Say the mistake in one line

Not "we should be more careful". The shape that works names the moment and the slip:

- *"A commit that changes the schema and leaves the migration alone."*
- *"An error caught and dropped on the floor."*
- *"A test file that gets deleted while a suite is red."*

If the person cannot name one, ask for the last time it happened and read the history for it.

## 2. Write the check

`.collet/checks/<name>.mjs` exports:

```js
export const id = 'no-dropped-errors';
export const what = 'an error caught and dropped on the floor';

export function check({ root, task, call }) {   // one call, at the moment it is made
  return { fires: false, reason: '' };          // fires: true means the mistake is present
}

export function live({ root, task }) {          // the same question about the tree; required to close
  return { fires: false, reason: '' };          // skipped: true means it could not look
}
```

Pure function, no network, no writes, no dependencies beyond Node's standard library. The editor
hook calls `check`; closing a task calls `live`. Commit and CI checks run only when the project
separately wires the runner there. A check must be fast and never throw on odd input.
Any input it cannot read, it reports as `fires: false` and says so in `reason`; a check that crashes
is not a check that passed.

**A `live` check that could not look reports `skipped: true`, never a quiet pass.** The runner
prints `skip` for it and `--strict` turns that into a failure. A green for a tool that was not there
is the exact false comfort this whole design exists to refuse.

`task.mjs close` uses that strict mode. A call-only check can be admitted and run by the editor
hook, but it blocks closure until it has a real working-tree check. If the mistake cannot be
checked from the tree, explain that limitation before installing it; never add an always-passing
`live` function to make the task close. A missing Git baseline is also an unavailable check.
Return an explicit synchronous result with boolean `fires` or `skipped: true`; missing results
and Promises fail verification. This interface does not support async checks.

## 3. Write its pair

Two fixtures next to it, and they are the whole point:

- `<name>.violation.json` — input the check **must** fire on.
- `<name>.nearmiss.json` — input that looks like the mistake and is not: the legitimate version of
  the same edit, the edge case that is fine, the false alarm you would hate to be woken by.

A near miss written to be obviously different proves nothing. Write the one that would fool the
check if you had written it carelessly. Several of each is normal and better — the suffix is free,
so `<name>.violation-shell.json` and `<name>.nearmiss-read.json` both count.

A fixture is `{ "what": "...", "setup": {...}, "task": {...}, "call": {...} }`. `setup` is a map of
path to contents, written into a throwaway directory that becomes the check's `root`, so a check
that reads files has files to read.

## 4. Run admission

```bash
node .collet/checks/run.mjs
```

Every check is run against its own pair. Anything that fails is written to
`.collet/checks/discarded.json` and reported — never quietly dropped, never counted as coverage.
That includes a fixture that does not parse and a check that will not load. If your check fails,
fix the check; if the near miss turns out to be a real violation, say so and change the fixture
deliberately, out loud.

## 5. Say what it does not cover

A check catches the shape it was written for, and one line of honest limits is worth more than a
confident summary:

- what it reads (a call, a file, a diff) and what it therefore cannot see;
- whether it blocks or only records;
- that a guard nobody has watched fire is a guard nobody knows the shape of.
