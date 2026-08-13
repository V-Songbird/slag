---
name: review
description: >-
  Reads jig's ledger and shows what every installed guard has done — fired,
  never fired, or waved off as a false alarm — then acts on it: mark a report
  as a false alarm, step a guard down to observe or back to blocking, retire a
  guard that never earned its keep, and report any installed file that has
  drifted since jig wrote it. Use when the user asks what jig has caught,
  whether a guard is worth keeping, to change what a guard does on a match, to
  mark a report as wrong, or to see what has changed since the install — e.g.
  "what did jig catch", "that jig warning was wrong", "stop the force-push
  guard blocking", "has anything drifted" — or invokes /jig:review. Do NOT use
  to install or set up guardrails — that is /jig:jig.
argument-hint: "[fp <guardId>] [disarm <guardId>] [retire <guardId>]"
allowed-tools: Bash, Read, AskUserQuestion
---

# jig:review

Everything mechanical is one command. You run it, read its result, and put the
real decisions — keep, quiet, or retire — to the user. Never re-derive what the
command already computed.

Every command is `node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" <review|rerun|fp|disarm|arm|retire>`
from the project root. If `node` is not on PATH (fnm/nvm setups), register it
the way the project's CLAUDE.md says to, then rerun.

A guard's mode is a choice, not a rank. Checks install proven and blocking;
observe is something the owner picks, in either direction, at any time. There is
no clean-session count that earns anything, and nothing here is a waiting
period.

## 1. Read the ledger

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" review
```

`guards[]` carries one row per installed guard:

- `fired` — times it matched. `wavedOff` — false positives recorded.
- `mode` — `armed` (it blocks) or `observe` (it records and lets the call
  through). `why` states what put it there; print it verbatim, because
  paraphrasing an honest limit blurs it.
- `provenance` — how the row was chosen. An `assumed` row is a default the owner
  never saw, and it is labelled as one wherever it is reported.

Show the rows as three groups: fired, never fired, waved off. Then say what each
group means:

- **Fired** — working, unless the user says otherwise. Ask whether any of the
  reports were wrong.
- **Never fired** — a guard that has sat quiet through many sessions is a
  candidate for retirement, not pride. Say so plainly.
- **Waved off** — a guard the user has already contradicted. Repeated wave-offs
  on one guard mean the check is miscalibrated; retiring it is the honest move.

## 2. False alarms

When the user says a report was wrong:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" fp <guardId>
```

This writes the false positive into the ledger as its own line — a human
judgment, recorded where the guard's history lives. Report the fresh stats back.
A guard that keeps producing them belongs in section 3 or 4, and the ledger is
the evidence for that conversation.

## 3. Quiet a guard, or let it block again

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" disarm <guardId>
```

The guard drops to observe on the next call: it still writes a ledger line, and
the call proceeds. This is the move for a check that is right often enough to
keep and wrong often enough to be in the way.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" arm <guardId>
```

Back to blocking. From the next session a match denies the call and shows the
reason, the alternative and the override path. Say that plainly before the user
answers. Both commands re-check the guard's proof hash and refuse if the check
module or its fixtures no longer match what was proven — report a refusal
verbatim, never retry.

## 4. Retire a guard

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" retire <guardId>
```

For a guard that never earned its keep. The row leaves the config through the
same journaled door everything else uses, so `revert` puts it back. The ledger
keeps its history — evidence is never deleted. Only ever offer this for a guard
the user confirmed, one at a time.

## 5. Drift, and the re-run question

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" rerun
```

Show `drifted` — files jig installed that have changed since — alongside
`neverFired`. Drift is reported, never repaired
silently: a file the user edited is the user's file, and the journal still holds
the pre-image if they want it back.

Then ask ONE `AskUserQuestion`, and do exactly the chosen one:

- **Retire the dead** — `retire <guardId>` for each never-fired guard the user
  confirms.
- **Quiet the noisy** — `disarm <guardId>` for each guard the wave-offs
  indict.
- **Cover something new** — hand off to `/jig:jig`, which authors and proves the
  new checks.
- **Nothing, just the report** — stop here.

One pass, then done; no follow-up menus. The kill switch for everything at once
is still a file named `.jig/off`.
