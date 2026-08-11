---
name: review
description: >-
  Reads jig's ledger and shows what every installed guard has done — fired,
  never fired, or waved off as a false alarm — then arms a guard exactly when
  its evidence gate is met, records false positives, and returns an armed
  guard to observe. Arming is earned: a guard needs ten clean observed
  sessions with no standing false positive, twenty-five for a heuristic one,
  and an assumed-provenance install can never arm. Use when the user asks
  what jig has caught, whether a guard can arm yet, to arm or disarm a guard,
  to mark a report as a false alarm — e.g. "what did jig catch", "arm the
  force-push guard", "that jig warning was wrong" — or invokes /jig:review.
  Do NOT use to install or set up guardrails — that is /jig:jig.
argument-hint: "[arm <guardId>] [fp <guardId>]"
allowed-tools: Bash, Read, AskUserQuestion
---

# jig:review

Everything mechanical is one command. You run it, read its result, and put the
one real decision — arm, or not — to the user. Never re-derive what the
command already computed.

Every command is `node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" <review|arm|disarm|fp>`
from the project root. If `node` is not on PATH (fnm/nvm setups), register it
the way the project's CLAUDE.md says to, then rerun.

## 1. Read the ledger

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" review
```

`guards[]` carries one row per installed guard:

- `fired` — times it matched. `cleanSessions` — distinct sessions observed
  since the last false positive. `wavedOff` — false positives recorded.
- `mode` and `why` — what the guard runs at now, and the bar that holds it
  there. Print `why` verbatim; paraphrasing an honest limit blurs it.
- `armable` — `true` exactly when arming would hold right now. `barrier` says
  what still blocks it otherwise.

Show the rows as three groups: fired, never fired, waved off. A guard that
never fired in many sessions is a candidate for retirement, not pride —
say so.

## 2. Offer arming — only what the gate already cleared

For each row with `armable: true`, ask the user whether to arm it. One
question, all armable guards, multi-select. Never offer a guard whose
`armable` is `false`; name its `barrier` instead if the user asks.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" arm <guardId>
```

The command re-checks the gate itself and refuses if it no longer holds —
report a refusal verbatim, never retry. An armed guard **denies**: from the
next session, a match blocks the call and shows the reason, the alternative,
and the override path. Say that plainly before the user answers.

## 3. False alarms and the way back

When the user says a report was wrong:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" fp <guardId>
```

This writes the false positive into the ledger and resets that guard's
arming clock. If the guard was armed, it returns to observe on the next call.
To step a guard down by hand:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" disarm <guardId>
```

Both are reported back with the guard's fresh stats. The kill switch for
everything at once is still a file named `.jig/off`.
