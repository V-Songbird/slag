---
name: jig
description: >-
  Interviews the owner of a project, then installs a reviewed, reversible set of
  guardrails against the mistakes juniors and drifting AI sessions actually make
  — a committed check driver and two session guards under `.jig/`, plus a CI
  workflow under `.github/workflows/`. Reads the repository and its git
  history first, so it never asks for a fact it can already see. Every guard
  starts observing — recording what it would have blocked and letting the
  call through — and can only be armed later from /jig:review once its ledger
  shows a clean record. jig writes zero bytes into any file the user owns. Use when the user wants
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
are printed and saved as proposals, so you never edit a settings file or a rule
file, and a git hook is touched only through the consent-gated weave in step 7.
And nothing installs armed: a guard that matches writes `would-deny` to the
ledger and the call proceeds, until the user arms it from `/jig:review` after
its clean record is in. Say both plainly when the user asks what they just
installed.

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

## 1. Scan — or the re-run ritual

When `.jig/manifest.json` already exists this is a re-run, and the whole visit
is ONE question. Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" rerun
```

Show the drift report — `drifted`, `neverFired`, `armable`, the top of
`backlog` — then ask one `AskUserQuestion`: arm the quiet (`arm` each id in
`armable`, via `/jig:review`'s rules), take the next backlog row (`plan
--select` it), retire the dead (`retire <guardId>` for each never-fired guard
the user confirms), or refresh (fall through to the full flow below). Then do
exactly the chosen one and stop.

On a fresh repository:

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
- `governance` — the ADRs, scopes, roadmaps and north-stars the repo carries,
  each with the loaded surfaces that reference it. `orphans` lists the ones
  nothing references — vital documents every session is blind to.

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

## 4. The blind-spot pass

Before asking anything, name the unknown unknowns. Read the profile and the
forensics record and write down, as short numbered findings, everything the
user probably does not know they have to decide: a forensics leader jig cannot
install yet, a hook slot another plugin holds, a toolchain tool the repo does
not carry, a history signal nobody mentioned. The template and the quadrant
rule are in [references/interview.md](references/interview.md).

Print the findings under the contract printout. Each one seeds a branch of the
interview tree — a finding is never silently folded into a default.

## 5. The grilling rounds

The interview is a design tree worked in rounds, not a fixed script. Each
round asks the whole **frontier** — every question whose prerequisites are
already answered — as ONE `AskUserQuestion` call, numbered `Q1…`, each
question's recommended answer listed first and marked `(Recommended)`. A
question whose answer depends on another question still open this round waits
for the next round. The close is mechanical: the interview ends exactly when
the frontier is empty.

Round one is always: who this protects, project phase, the class multi-select
ordered by the forensics ranking, and the agent-damage anchor. Round two opens
with what round one settled: the worst-bug free-text, the CI workflow
decision, and the hook-weave offer when the scan found a committed hook.
Wording, options, and what may unlock a round three are all in
[references/interview.md](references/interview.md).

Three rules bind every round:

- **Facts are never questions.** Anything the scan or the forensics read is
  already settled (D21). A finding from step 4 becomes a question about what
  to DO, never a question about what is true.
- **Free text never becomes a pattern.** A sentence the user typed can only
  select a class the catalogue already ships — classification is pinned to
  Sonnet or better through one `Agent` call, degrades hard to the multi-select,
  and a classified class is a pre-tick the user must confirm in a later round.
  The whole protocol is in the reference.
- **Disclose an enforcement gap the moment one is named**, mid-round, with the
  reference's own lines — never in a summary at the end.

**Under `--quick`, skip the rounds entirely.** Select all four installable
classes, plan with `--provenance assumed`, tag every assumed value in the
printout, and say the consequence once: an `assumed` row can never arm a deny
lever, in this release or any later one. Quick start's one interaction is the
plan review at step 6.

There is no arming question in any round. Nothing installs armed — arming
belongs to `/jig:review`, after a guard has a clean observed record to show.

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

`toolchain` on the result is the consultant half: `included` lists the
side-files this plan writes for tools the repository already carries — print
each `wiring` line verbatim, it is the one line the user pastes to make their
own tool run jig's config. `absent` names every tool the selection wanted that
the repo does not carry; say plainly that jig never downloads one, and that
installing the tool and re-running `plan` closes the gap.

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

One exception, offered rather than done: when the scan found a pre-commit hook
COMMITTED to the repository (`scripts/git-hooks/` or `.husky/`), jig can weave
the activation line into it as a reviewed, journaled, reversible change. Ask
first, then build a draft using the catalogue's own `activation` entry — the
`sh` line for an sh hook, the `node` line for a node-shebang hook — as an
`include-line` change, plan it with `--from`, and apply it only on the user's
yes. It is always item-approve. A hook under `.git/hooks/` is machine-local
and stays a printed proposal.

Prose is the same shape of exception. When the user asked for a rule during
the rounds — for a class no tool can watch, or to wire orphaned governance
docs — re-run `plan` with `--prose <classId,…>` or `--wire-governance` on top
of the same `--select`. Every emitted rule is item-approve, lands as
`.claude/rules/jig-<slug>.md`, and the plan refuses past the byte budget —
report a budget refusal verbatim and drop a rule rather than arguing with it.
Never pass `--prose` for a class the user did not ask about.

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
every guard observes rather than blocks until it is armed from `/jig:review`.
Describe that coverage as demonstrated only when step 8 returned
`witnessed: true`; otherwise say plainly that nothing has been seen catching
anything yet. Name the two things still waiting on the user: the pre-commit
line, and the proposed permission rules. Point at `/jig:review` as the place
the guards' record accrues and arming is eventually offered.

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
