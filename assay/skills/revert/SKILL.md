---
name: revert
description: >-
  Undoes one completed assay run in full, putting every file it wrote back the
  way it was — restoring the ones it edited and deleting the ones it created —
  from the run's recorded commit or from its copies under `.assay/backup-<txId>/`.
  Reads the run record in `.assay/transactions.jsonl` and refuses the whole undo
  rather than doing half of it. Use when the owner wants a run taken back — e.g.
  "undo that", "revert the last assay run", "put my CLAUDE.md back", "roll back
  those rule rewrites", "take the hook out again", "what runs can I undo" — or
  invokes /assay:revert. Do NOT use to undo one change inside a run that is
  still open, which is `assay.js rollback --change`, or to undo an edit assay
  never made, which git alone covers.
argument-hint: "[transaction id] [--via git|backup]"
allowed-tools: Bash, Read, AskUserQuestion
---

# assay:revert

You undo one whole transaction per run. `$ARGUMENTS`, if present, names the
transaction id and may already name the route.

A transaction is one `apply` — every file that run wrote, recorded as one row in
`.assay/transactions.jsonl` before the first byte was written. This command puts
all of those files back or none of them. There is no partial revert to offer and
you never assemble one by hand.

You never restore a file yourself. Every restore goes through the engine below,
because the engine is what checks the backup digests, finds the recorded commit,
and marks the row `revertedAt` in the same step that does the work.

## 1. Read the record

From the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/safety.js" list
```

If `node` is not on PATH (fnm/nvm setups), register it the way the project's
CLAUDE.md says to, then rerun.

The output is `{ "transactions": [...] }`, newest last. Each row carries:

- `txId` — the id to pass back in step 3.
- `startedAt` and `files` — when the run was and what it touched.
- `revertedAt` — non-null means this run is already undone. It is not a
  candidate; say so and stop rather than running it again.
- `routes[]` — one entry per available route, each with `via` (`git` or
  `backup`), `ready`, and a `problem` naming what is wrong when `ready` is false.
- `blocked[]` — files carrying staged or unmerged changes. Any entry here is a
  refusal for the whole transaction, not for that file.
- `problem` — set when the row cannot be reverted at all.

## 2. Pick the transaction and the route

If `$ARGUMENTS` names a `txId`, use it. Otherwise show the owner the candidate
rows — id, time, file count — and let them pick. Never guess "the last one" when
more than one is revertable.

Then the route, from that row's `routes[]`:

- One entry with `ready: true` → use it, and say which one you used.
- Two entries with `ready: true` → ask, with `AskUserQuestion`. They restore the
  same bytes, so frame the choice by what each depends on: `git` puts the files
  back to the commit the run started from, `backup` puts back the copies assay
  made itself. Recommend `git` in a repository.
- No entry with `ready: true` → do not run anything. Report each route's
  `problem` verbatim and stop.

If `blocked[]` is non-empty, stop there too. Name the files, say the revert was
refused whole, and tell the owner to commit or unstage that work first. Do not
offer to stash it or move it for them.

## 3. Run it

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/safety.js" revert --tx <txId> --via <git|backup>
```

The output is JSON. On success: `ok: true`, `restored[]` (files put back),
`removed[]` (files the run created, now deleted again), and `revertedAt` (the
timestamp written onto the row). On refusal: `ok: false` and a `problem`, exit
code 1, and nothing on disk was touched.

## 4. Report

Say the transaction id, the route, how many files came back and how many were
deleted, and name the deleted ones — a file that disappeared is the outcome an
owner is most likely to be surprised by. Then say the row is marked
`revertedAt`, so the same run cannot be undone twice.

If the command refused, print its `problem` as written and add nothing to it.
The refusal already names what to fix.
