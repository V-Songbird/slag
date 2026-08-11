---
name: jig
description: >-
  Interviews the owner of a project, then installs a reviewed, reversible set of
  guardrails against the mistakes juniors and drifting AI sessions actually make
  — a committed check driver and two observe-only session guards under `.jig/`,
  plus a CI workflow under `.github/workflows/`. Reads the repository and its
  git history first, so it never asks for a fact it can already see. Nothing
  arms in this release: a
  guard records what it would have blocked and lets the call through, and jig
  writes zero bytes into any file the user owns. Use when the user wants
  guardrails set up, or a repeat mistake caught before it lands — e.g. "set up
  guardrails", "stop the AI deleting my tests", "add checks to this repo", "what
  keeps breaking here", "catch skipped tests before they merge", "guard this
  project against agent mistakes" — or invokes /jig:jig. Do NOT use to grade or
  audit existing rules or skill descriptions — that is /assay:claude — and not
  to write one rule or one skill — those are /assay:craft-rules and
  /assay:craft-skill.
argument-hint: "[--quick] [--select <classId,…>] [--no-ci]"
allowed-tools: Bash, Read, AskUserQuestion, Agent
---

# jig:jig

The engine does everything mechanical. You run it, read its result, and ask the
two questions it cannot answer. Never re-derive by hand what a command already
computed, and never put to a human a fact the scan already read.

Two contracts hold for the whole run, and both are structural rather than a
promise you have to remember. jig writes only under `.jig/` and
`.github/workflows/` — the pre-commit activation line and the permission rules
are printed and saved as proposals, so you never edit a settings file, a rule
file, or a git hook. And nothing this release installs can refuse a tool call: a
guard that matches writes `would-deny` to the ledger and the call proceeds. Say
both plainly when the user asks what they just installed.

Flags in `$ARGUMENTS`: `--quick` (skip Call 2, take all four classes, plan as
`assumed`), `--select <classId,…>` (the user already named the classes, so skip
Call 2 and treat them as elicited), `--no-ci` (pass through to `plan`, which
then generates no CI workflow).

Every command runs from the project root and every one of them is `node
"${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" <scan|plan|apply|status|revert|selftest>`
or `node "${CLAUDE_PLUGIN_ROOT}/scripts/forensics.js"`. There is no other entry
point and nothing is on PATH. Flags take a space-separated value — `--select
a,b`, never `--select=a,b`, which the parser reads as a flag named
`select=a,b`. Every command accepts `--root <path>`; without it the working
directory is the project.

## 1. Scan

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" scan
```

If `node` is not on PATH (fnm/nvm setups), register it the way the project's
CLAUDE.md says to, then rerun.

Writes `.jig/profile.json` and returns its contents. These keys feed the
column-one list you print at step 3:

- `stack` — package manager, lockfile, test script, module type, and whether
  there is a `package.json` at all.
- `node` — `onPath`, the `version`, and the `versionManager` that owns it.
- `guardrails` — `hooks` already registered here named by source file,
  `coreHooksPath`, and the size of the rule corpus under `rules`.
- `slots` and `occupied` — every slot jig would take, and the ids of the ones
  already held by something else.

`disclosures` is prose the engine wrote for a human. Print those lines
**verbatim**; paraphrasing them is how an honest limit turns into a vague one.

**An occupied slot is missing coverage, not a detail.** Hooks registered for the
same event do not chain reliably across plugins, so a guard jig cannot register
is protection the user does not have. Say which slot, and say that the check
driver and the CI workflow are the floor that does not depend on any of it.

## 2. Forensics

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/forensics.js"
```

Deterministic git mining, with no model in the loop. Read `ranking` — catalogue
classes ordered by what this repository actually did — alongside `incidents`,
`cleared`, and `attribution`.

- `ranking[].basis` — `"forensics"` means real hits in this history;
  `"catalogue"` means the row is a default, ranked by nothing. Never present the
  second as evidence.
- `usable` — `false` means nothing was mined, and `fallback` names which of five
  shapes it hit: `not-a-repository`, `no-history`, `young-history` (under twenty
  commits), `squash-merged`, or `below-threshold` (a real history that never
  cleared two distinct signals). The class order falls back to the catalogue.
  Name the shape the field actually reports — never call a `below-threshold`
  repository young. None of the five is an error.
- `attribution` — best-effort, and the field says so in its own words. Author
  lines and `Co-Authored-By` trailers are all git carries, so never present a
  human-versus-agent split as settled.

## 3. The contract printout

Before asking anything, print two columns: **Detected — never asked**, holding
the facts from steps 1 and 2, and **I will ask — never inferred**, holding who
this protects against, the project's phase, and which classes to install. The
template is in [references/interview.md](references/interview.md).

The columns exist so the user can see the boundary. Anything in column one that
you then put to them as a question is a defect in the run.

## 4. Call 1 — persona and posture

Make ONE `AskUserQuestion` call carrying two questions: who the guardrails
protect against, and what phase the project is in. Neither is multi-select.
Wording and options are in [references/interview.md](references/interview.md).

**Under `--quick`, skip this call too.** Quick start is one interaction, and
that interaction is the plan review at step 6. Persona and phase only order the
Call 2 list, which quick start does not ask, so nothing downstream reads them.

There is no arming question. Nothing arms in this release, so offering that
choice would be offering something jig cannot deliver.

## 5. Call 2 — the error classes

Make ONE `AskUserQuestion` call carrying three questions: the four installable
classes (`multiSelect: true`, header `"Guard against"`, ordered by the forensics
ranking), the agent-axis question, and the free-text question. Options, wording,
and the classification protocol are in
[references/interview.md](references/interview.md).

Three rules bind this step:

- **Free text never becomes a pattern.** A sentence the user typed can only
  select a class the catalogue already ships. It is never compiled into a
  matcher, never written into `.jig/config.json`, and never reaches an installed
  guard.
- **The classification is pinned to Sonnet or better.** Run it through one
  `Agent` call with `model: "sonnet"`. If that model is unavailable, say so in
  one line and fall back to the multi-select alone. Never infer a class from
  free text on a smaller model.
- **A classified class is a pre-tick, not a selection.** The user confirms it in
  the multi-select, or it does not get installed.

**Under `--quick`**, skip this call. Select all four installable classes, plan
with `--provenance assumed`, and tag every value you assumed rather than asked
with the word `assumed` in the printout. Say the consequence once: an `assumed`
row can never arm a deny lever, in this release or any later one.

**Disclose an enforcement gap the moment one is named.** The catalogue carries
twenty-two classes and installs four; the rest ship as data so the matrix can be
honest about what nobody watches. When the user names a class that is not
installable, or selects `pipe-to-shell`, say right then what jig can and cannot
see for it — the lines are in
[references/interview.md](references/interview.md), and
[references/catalogue-node.md](references/catalogue-node.md) explains what each
of the four detectors still misses. jig writes no prose rule to cover the
difference, for any class, in this release.

## 6. Plan and review

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" plan --select <classId,…> --provenance <elicited|forensic|assumed>
```

Provenance is the weakest thing that fed the selection, and it is load-bearing
forever: an `assumed` row is structurally barred from ever arming a deny lever.
Choose it honestly — `elicited` when the user ticked the classes themselves,
`forensic` when they accepted the forensics ranking as it stood, `assumed` for
quick start or any default they never saw. An absent or misspelled value
silently becomes `assumed` rather than failing, so pass it explicitly every
time.

The result names `review` — that is `.jig/plan.md`, the coverage matrix. Read it
and walk the user through it. Rows are the selected classes, columns are the
catalogue's four actors (`human-editor`, `human-ci`, `claude-session`,
`codex-session`), and each cell reads `DET`, `PROB`, or `GAP`. The Codex column
is gaps all the way down because no detector names it yet — that is the matrix
reporting the truth, not a defect to explain away.

Then take consent in two tiers, read off `consent` on the result:

- `consent.batch` — artifacts that only ever report. Approve them together.
- `consent.item` — anything that wires a guard into a hook, or fails somebody's
  build. Approve these one at a time, by id.

Two more keys on the result are reported, never swallowed. `refused` names each
slot this selection wanted and could not have, and why; a plan that quietly
installs three of the four things somebody asked for is the plan that lies to
them. `enforcementGaps` names the artifacts jig writes and cannot read back —
`.jig/activation.md` and `.github/workflows/jig.yml` — so their correctness is
nobody's guarantee. That is a different thing from a class carrying the
ENFORCEMENT GAP stamp, which `.jig/plan.md` renders in its own section. Do not
read one as the other.

`plan` refuses rather than installing half of what was asked for, always on
stderr with exit 1. This flow can hit four refusals: a class id the catalogue
does not carry, a class that ships as data and cannot be installed at v1, a
selection that does not clear the host-neutral floor, and every slot the
selection needs already taken. None is retryable as it stands. Read the message,
change the selection, and never route around it.

## 7. Apply

The batch tier once the user approves it, then the item tier one id at a time:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" apply --change <id> --change <id>
```

Or the whole plan, only when the user approved all of it:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" apply --plan <planId>
```

The argument is the approval boundary, which is why there is no form that
applies everything by default.

Print `proposals` from the result **verbatim**. That is the work jig
deliberately left with the user: the pre-commit line to paste, saved at
`.jig/activation.md`, and the permission rules recorded at
`.jig/proposed-permissions.json` and never applied. Do not do either of them on
the user's behalf.

## 8. The witnessed catch

The interview is not finished until a guard has been seen catching something and
the ledger has grown a line proving it.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" selftest --live
```

Read `witnessed`. It is `true` only when a guard probe caught its synthetic
violation **and** `ledger.linesAfter` exceeds `ledger.linesBefore`. Show the
runner's own stdout for at least one probe, verbatim, from `probes[].output` —
"it works" from the thing under test is not evidence.

**Degrade, never stall.** A probe that reports `ran: false` says why, and
carries `command` and `expected`. Print both and tell the user what to look for.
Print `notes` too. The close never aborts because a tool could not run.

**`witnessed: false` is never passed over.** Say which half failed — no guard
caught its probe, or the ledger did not grow — name the probe, and call the
install unwitnessed at step 9. Only `witnessed: true` lets the close describe
coverage as demonstrated.

## 9. Close, and how to undo any of it

Say what is now installed, which actors it covers, what it cannot see, and that
every guard observes rather than blocks. Describe that coverage as demonstrated
only when step 8 returned `witnessed: true`; otherwise say plainly that nothing
has been seen catching anything yet. Name the two things still waiting on the
user: the pre-commit line, and the proposed permission rules.

What is installed, any time, reading the journal and writing nothing ever:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" status
```

The undo, only when the user asks for it:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" revert --all
```

`revert` also takes `--change <id>` and `--tx <id>`, and it refuses when a file
changed after jig wrote it rather than discarding that edit — report the refusal
as it stands. `--force` restores the journalled pre-image anyway, and that is
the user's call to make, never yours.

`.jig/off` is the kill switch: create that file and every guard exits without
running. One pass, then done; no follow-up menus.
