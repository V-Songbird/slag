---
name: review
description: >-
<!-- host: claude -->
  Reads jig's ledger and reports what every installed guard has done — the short
  answer first: what fired, where the checks run, what needs attention. Then
  acts on it when asked: mark a report as a false alarm. Step a guard down to
  observe or back to blocking. Retire one that never earned its keep. List
  installed files that drifted since jig wrote them. A report-only ask stays
  read-only; a change to a guard keeps its approval step. Use when the user asks
  what jig has caught, whether a guard is worth keeping, to change what a guard
  does on a match, to mark a report as wrong, or to see what has changed since
  the install — e.g. "what did jig catch", "that jig warning was wrong", "stop
  the force-push guard blocking", "has anything drifted", "are my commit checks
  running" — or invokes /jig:review. Do NOT use to install or set up guardrails
  — that is /jig:jig.
argument-hint: "[fp <guardId>] [fp <guardId> --clear] [arm <guardId>] [disarm <guardId>] [retire <guardId>] [rerun]"
allowed-tools: Bash, PowerShell, Read, AskUserQuestion
<!-- host: codex -->
  Explain what Jig detected and manage named guards: record or clear false
  alarms, switch between recording and blocking, retire a guard, or inspect
  drift. Use for Jig activity, alert feedback, guard changes, or $review.
  Report-only requests stay read-only; enforcement changes keep their existing
  approval rules. New checks and installation use Jig's setup workflow.
<!-- host: end -->
---

<!-- host: claude -->
# jig:review
<!-- host: codex -->
# Jig review

Read [Codex runtime and consent](../jig/references/codex-runtime.md) first. Resolve
`<JIG_ROOT>` from this loaded skill's path, and keep detector proof separate from
actual host registration and enforcement.
Read [Conversation and reporting](../jig/references/experience.md) for summary
and detail rules. `$jig` may route here; `$review` remains a direct entry.
Continue requested follow-up work in this conversation by reading its Jig
workflow, without asking the owner to invoke another skill.

For ordinary `$review`, read the ledger and the re-run report (sections 1 and
5), then summarize activity, where checks run and what needs attention. For a
specific alert or guard, read the ledger and the relevant action section; do
not force the owner through unrelated questions. Full/everything requests get
all applicable report detail. An explicit report-only request ends with the
report, without an action menu or any write.

The field rules below govern interpretation and detailed reporting. In a
summary, healthy rows may be grouped; problems, effective mode reductions,
pending approvals, drift and unverified coverage remain visible.
<!-- host: end -->

Everything mechanical is one command. You run it, read its result, and put the
real decisions — keep, quiet, or retire — to the user. Never re-derive what the
command already computed.

<!-- host: claude -->
`/jig:jig` routes a plain-language question here; `/jig:review` is the direct
entry. Shape the answer the way
`${CLAUDE_PLUGIN_ROOT}/skills/jig/references/experience.md` says. For an
ordinary review, read the ledger and the re-run report (sections 1 and 5), then
give the summary: what fired, where the checks run, what needs attention. For
one alert or one guard, read the ledger and the section that acts on it, and
put no unrelated question to the owner. `full`, or a request for everything,
gets every applicable detail below. A report-only request ends with the report
— no action menu, no write. A follow-up the owner asks for that belongs to the
setup skill is continued here by reading
`${CLAUDE_PLUGIN_ROOT}/skills/jig/SKILL.md`, never by sending them to invoke it.

The field rules below say what each thing means and how to show it in detail.
In a summary, healthy rows may be grouped; a `problem`, a guard running below
its configured mode, a pending wave-off, drift and a verify entry never seen
green stay visible every time.

Every command is `node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" <review|rerun|fp|disarm|arm|retire>`
<!-- host: codex -->
Every command is `node "<JIG_ROOT>/scripts/jig.js" --runtime codex <review|rerun|fp|disarm|arm|retire>`
<!-- host: end -->
from the project root. If `node` is not on PATH (fnm/nvm setups), register it
<!-- host: claude -->
the way the project's CLAUDE.md says to, then rerun.
<!-- host: codex -->
the way the project's AGENTS.md says to, then rerun.
<!-- host: end -->

A guard's mode is a choice, not a rank. Checks install proven and blocking;
observe is something the owner picks, in either direction, at any time. There is
no clean-session count that earns anything, and nothing here is a waiting
period.

Anything that takes enforcement AWAY — `fp`, `disarm`, `retire` — plans and
stops. The command writes a change and changes nothing; its result carries
<!-- host: claude -->
`applied: false`, the `change` id, the `path`, and an `apply` string. Put the
change to the user with ONE `AskUserQuestion` and run the apply only if they say
yes. Never pre-tick it, never assume it, never run both halves in one breath.
<!-- host: codex -->
`applied: false`, the `change` id, the `path`, and an `apply` string. Show the
change id, exact path and consequence. Apply only with explicit consent for
that named pair, using the runtime reference's conversational fallback. Reuse
unchanged authorization already given in this session. Never pre-tick or assume
consent; a general complaint about a guard does not approve its planned change.
<!-- host: end -->
`arm` is the exception and applies itself: it puts enforcement up, and the owner
already named the guard.

If a command here refuses because the install predates the rework, that install
<!-- host: claude -->
needs upgrading before any of this reads correctly. Say so and stop. Offer the
upgrade through the setup skill; a report request does not authorize it.
<!-- host: codex -->
needs upgrading before any of this reads correctly. Explain the required
upgrade and stop. Offer to prepare it through Jig's setup workflow; a report
request does not authorize migration.
<!-- host: end -->

## 1. Read the ledger

```
<!-- host: claude -->
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" review
<!-- host: codex -->
node "<JIG_ROOT>/scripts/jig.js" --runtime codex review
<!-- host: end -->
```

`installed: false` is the whole report. There is no `.jig/config.json` here — jig
was never installed, or `revert` took it back out — so there is no activity to
<!-- host: claude -->
read. Say `why` and stop; offer `/jig:jig` to install. Do not report the empty
<!-- host: codex -->
read. Say `why` and stop; offer `$jig` to install. Do not report the empty
<!-- host: end -->
`guards` list as guards that never fired.

`guards[]` carries one row per installed guard:

- `fired` — times it matched, out of `evaluated` calls it was run on. Report the
  pair, never `fired` alone: four catches in four calls and four in four
  thousand are different guards. `denied` and `wouldDeny` split `fired` by what
  the guard was allowed to do — a `wouldDeny` count is coverage the user is not
  getting yet. `lastFired` is when the last catch was, or `null`; a guard that
  fired only long ago is as much a retirement candidate as one that never did.
  `wavedOff` — false positives recorded.
- `evaluatedOn` — the shell tool names those `evaluated` calls arrived on, for
  THIS guard. Empty means not yet observed. This is the per-guard field;
  `lanes.session.shell.seen` below is repository-wide and answers a different
  question.
- `otherLanes` — catches of this guard's class at COMMIT time, where the check
  runs with no guard and no denominator, which is why it is not part of `fired`.
  A guard with `fired: 0` and a non-zero `otherLanes` is not a quiet guard: its
  class is being caught, in the lane that stops the commit. Never offer it for
  retirement.
  `pendingWaveOff` — a wave-off the user raised and never approved the change
  for. The guard is still doing whatever its config says, which is not what
  somebody who ran `fp` and walked away expects: say so, and offer the token
  again.
- `problem` — non-null means this guard is broken, not quiet: its check module
  would not load, or it carries nothing for the event it is registered on. Say
  so first and separately. A broken guard reported as "never fired" is coverage
  the user thinks they have.
<!-- host: claude -->
- `mode` — `armed` (it blocks) or `observe` (it records and lets the call
<!-- host: codex -->
- `mode` — `armed` (eligible to block supported calls with trusted active
  hooks) or `observe` (it records and lets the call
<!-- host: end -->
  through). `why` states what put it there; print it verbatim, because
  paraphrasing an honest limit blurs it.
- `demoted` — non-null means the config says `armed` and the guard is running as
  `observe` anyway: drift, a stale proof, a standing false positive, a zone. The
  owner cannot see that gap anywhere else, so report it beside `problem` rather
  than leaving `mode` to imply somebody chose observe.
- `provenance` — how the row was chosen. An `assumed` row is a default the owner
  never saw, and it is labelled as one wherever it is reported.

`lanes` carries the three places the checks can run, read fresh on every review
rather than remembered from the install:

<!-- host: claude -->
- `lanes.session` — the guards above, inside a Claude session. `off: true` means
<!-- host: codex -->
These are repository configuration and ledger facts. This command cannot
inspect whether the current Codex host enabled and trusted the plugin. Verify
`/hooks` separately before claiming the session lane is active. Synthetic
selftests and historical counts do not establish current host registration.
Jig deliberately keeps Stop advisory even though Codex supports blocking and
continuation there; Jig requests neither.

- `lanes.session` — the guards above, inside a Codex session. `off: true` means
<!-- host: end -->
  `.jig/off` is present and NOTHING in this lane runs, whatever the guard rows
  say; `offSince` is when the switch went on. Report that before anything else.
  `shell.watched` is every tool name jig's hooks match. `shell.seen` is every
  name ANY of jig's own ledger rows recorded in this repository — not per guard,
  not per host, and not time-bounded: it carries a retired guard's rows, and a
  committed `.jig/ledger.jsonl` carries another machine's. Report it as that.
  The per-guard fact is on the guard row itself: `evaluatedOn` is the shell
  tools that guard's own `evaluated` calls arrived on. Report `evaluatedOn`
  beside any command guard's catch count — it says which syntax that count was
  earned against, and a command guard armed with zero catches whose
  `evaluatedOn` names a shell its patterns were not written for has been
  evaluating and passing, not covering. An empty `evaluatedOn` or `seen` is "not
  yet observed" — never fill either in from the operating system.
- `lanes.commit` — the git hook. `runs` is the whole answer; `state` says why
  when it is false, and `fix` is the one thing to do about it. `executable` is
  whether git can run the hook at all — `false` is a live-looking lane that does
  nothing, and `null` means win32, where the question does not apply.
- `lanes.ci` — the workflow. This is the floor, and it is the reason a dead
  commit lane is an inconvenience rather than a hole. `runs` is read from the
  workflow rather than from the file being there: `state` `unwired` is a
  workflow that no longer invokes the driver, and `drifted` is one that still
  does under edits jig cannot vouch for.

Report a dead lane in plain terms: what does not run, what still does, and the
one command that fixes it. Offer the fix; never run it unasked. Print `fix`
verbatim — it names the real invocation, and nothing puts `jig` on a PATH.
<!-- host: claude -->
Wiring the commit lane is an approved, reversible change like any other. When
the owner asks for it, read the setup skill and continue the repair here; a
report does not authorize applying it.
<!-- host: codex -->
Wiring the commit lane is an approved, reversible change like any other. If
the owner requests it, read Jig's setup workflow and continue the repair here;
a report does not authorize applying it.
<!-- host: end -->

`verify` is one row per lane entry, and `lastGreen` is the last time jig
<!-- host: claude -->
WITNESSED that command run green — in a Claude session, or in this machine's own
<!-- host: codex -->
WITNESSED that command run green — in a Codex session, or in this machine's own
<!-- host: end -->
commit lane — a timestamp, or `null` for one nothing here has ever been seen to
pass. Report it beside the lanes. It is the one fact in this report that
contradicts a claim rather than recording a catch, and `null` does not mean the
tests fail: it means nothing here has been seen to run them. Hosted CI is the
case to say out loud, because it looks like the opposite: the CI lane writes its
row into the runner's own checkout, the ledger is git-ignored and the checkout is
thrown away, so a repository whose CI runs the suite green on every push still
reads `null`. Say which claim the number answers.

<!-- host: codex -->
Measured Codex CLI 0.145.0 and 0.153.4 shell PostToolUse payloads contain raw
stdout without exit status. A matching named run records `verify-unknown`, which
must not be reported as green or as a failed command. If the user wants a named
verification run, use the existing driver for the approved entry and its
configured lane, as described in
[the runtime guide](../jig/references/codex-runtime.md#reliable-verification-evidence):
`node .jig/checks/run.mjs --verify --lane commit --entry <id>` when the entry
includes `commit`. The driver records the true exit itself. The lane label is
not proof that Git ran a commit or that hosted CI ran a job. A report-only review does not authorize extra test runs; reuse any explicit
authorization already given for the named verification.

<!-- host: end -->
`ledger.lines` is how far the ledger has grown. It is never compacted — deleting
rows deletes the evidence a wave-off is undone from — so this number only goes
up, and it is the one signal the user has that it is getting large. Report it
once, plainly, at the end of this section.

In the full report, show the guard rows as three groups: fired, never fired,
<!-- host: claude -->
waved off. In the summary, give the activity that matters and every exception,
with its evidence. Read the groups as follows:
<!-- host: codex -->
waved off. In the summary, give the relevant activity and exceptions with their
evidence. Interpret the groups as follows:
<!-- host: end -->

<!-- host: claude -->
- **Fired** — recorded matches, `denied` kept apart from `wouldDeny`. Working,
  unless the user says otherwise; say that they can name a report that was
  wrong. A read-only question needs no follow-up interview.
<!-- host: codex -->
- **Fired** — recorded matches, with actual denials distinguished from
  observation. Explain that the owner can name a mistaken report; a read-only
  question does not require a follow-up interview.
<!-- host: end -->
- **Never fired** — a guard that has sat quiet through many sessions is a
  candidate for retirement, not pride. Say so plainly. A guard with a non-zero
  `otherLanes` does not belong in this group at all: its class is being caught
  at commit time.
- **Waved off** — a guard the user has already contradicted. Repeated wave-offs
  on one guard mean the check is miscalibrated; retiring it is the honest move.

## 2. False alarms

When the user says a report was wrong:

```
<!-- host: claude -->
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" fp <guardId>
<!-- host: codex -->
node "<JIG_ROOT>/scripts/jig.js" --runtime codex fp <guardId>
<!-- host: end -->
```

This writes the judgment into the ledger as its own line — a human judgment,
recorded where the guard's history lives — and **quiets nothing yet**. Acting on
a false alarm stops an armed guard refusing tool calls, which is the same step
down `disarm` takes, so it gets the same pause. The result carries the token:

```
<!-- host: claude -->
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" apply --change <change> --path <path>
<!-- host: codex -->
node "<JIG_ROOT>/scripts/jig.js" --runtime codex apply --change <change> --path <path>
<!-- host: end -->
```

<!-- host: claude -->
Ask ONE `AskUserQuestion` — quiet this guard, or leave it blocking and keep the
report on the record — and run the apply only on a yes. On a no, stop; the
<!-- host: codex -->
Show the returned id/path pair and ask whether to quiet this guard or leave it
blocking with the report on record. Apply only with explicit approval, reusing
that authorization if it was already given for the same pair and consequence. On a no, stop; the
<!-- host: end -->
ledger line stands as evidence either way and `review` reports it as
`pendingWaveOff`.

A guard that keeps producing false alarms belongs in section 3 or 4, and the
ledger is the evidence for that conversation.

```
<!-- host: claude -->
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" fp <guardId> --clear
<!-- host: codex -->
node "<JIG_ROOT>/scripts/jig.js" --runtime codex fp <guardId> --clear
<!-- host: end -->
```

The other direction, and it needs no pause: it appends the cleared line the
arming gate reads, so a wave-off stops holding the guard in observe. Nothing is
edited — the earlier line stays on the record. Use it when a wave-off was itself
a mistake, or when an install migrated in carrying one that will not let `arm`
through.

## 3. Quiet a guard, or let it block again

```
<!-- host: claude -->
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" disarm <guardId>
<!-- host: codex -->
node "<JIG_ROOT>/scripts/jig.js" --runtime codex disarm <guardId>
<!-- host: end -->
```

This plans and stops, exactly as `fp` does: put the named change to the user and
apply it only on a yes. Once applied the guard drops to observe on the next
call: it still writes a ledger line, and the call proceeds. This is the move for
a check that is right often enough to keep and wrong often enough to be in the
way.

```
<!-- host: claude -->
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" arm <guardId>
<!-- host: codex -->
node "<JIG_ROOT>/scripts/jig.js" --runtime codex arm <guardId>
<!-- host: end -->
```

<!-- host: claude -->
Back to blocking, and this one applies itself. From the next session a match
denies the call and shows the reason, the alternative and the override path. Say
<!-- host: codex -->
Back to blocking, and this one applies itself. With trusted, active Codex
hooks, a supported PreToolUse match denies the call and shows the reason, the alternative and the override path. Say
<!-- host: end -->
that plainly before the user answers.

`arm` re-derives the guard's proof and refuses when the check module or its
fixtures no longer match what was proven — report that refusal verbatim, never
retry.

## 4. Retire a guard

```
<!-- host: claude -->
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" retire <guardId>
<!-- host: codex -->
node "<JIG_ROOT>/scripts/jig.js" --runtime codex retire <guardId>
<!-- host: end -->
```

For a guard that never earned its keep. Plans and stops like the rest, and the
user approves the named change before anything moves. The row then leaves the
config through the same journaled door everything else uses, so `revert` puts it
back. The ledger keeps its history — evidence is never deleted. Only ever offer
this for a guard the user confirmed, one at a time.

## 5. Drift, and the re-run question

```
<!-- host: claude -->
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" rerun
<!-- host: codex -->
node "<JIG_ROOT>/scripts/jig.js" --runtime codex rerun
<!-- host: end -->
```

Show `drifted` — files jig installed that have changed since — alongside
`neverFired`. Drift is reported, never repaired
silently: a file the user edited is the user's file, and the journal still holds
the pre-image if they want it back.

Then `sinceInstall`, which is the only part of this report that comes from git
rather than from jig's own hooks — so it covers every lane and every teammate,
not just the agent sessions the ledger saw. Print it whenever it is non-null:

- `commits` since `since` (the install date), split by `actors` into human and
  agent. `attribution` is the caveat that goes with that split; say it out loud
  the way the ranking already does, because an author line and a Co-Authored-By
  trailer are all git carries.
- `byClass` — for each class this repository's diffs still show, the hits
  `before` the install and `after` it. A class whose `after` outruns its
  `before` is one the repository kept producing and nobody covered. Lead the
  offer below with it.
- `truncated: true` means the content window `byClass` was built from does not
  reach back to the install, so `before` is a floor and not a count. Say so
  rather than reading the drop as progress. An EMPTY `byClass` with
  `truncated: true` means nothing was mined at all — never report that as a
  repository where no class is still occurring.

`null` is not a finding: it means there is nothing to mine here — no install
date, not a git repository, or git would not run.

<!-- host: claude -->
If the owner already asked for an action, continue it through its section and
its consent rules. If they asked only for the report, stop after it. Otherwise
suggest the one next action the findings support, and put the four choices
below as ONE `AskUserQuestion` only when the owner asks what they can do or
wants help choosing — then do exactly the chosen one. Anything that takes
enforcement away still needs its named change:
<!-- host: codex -->
If the owner already requested an action, continue it using the relevant
section and its consent rules. If they asked only for a report, stop after the
report. Otherwise, suggest the next action supported by the findings; present
the choices below when the owner asks what they can do or wants help choosing.
Actions that remove enforcement still require their named plan item:
<!-- host: end -->

- **Retire the dead** — `retire <guardId>` for each never-fired guard the user
  confirms, then the `apply` it hands back.
- **Quiet the noisy** — `disarm <guardId>` for each guard the wave-offs
  indict, then the `apply` it hands back.
- **Cover something new** — name the `backlog` rows the command already
  computed (`classId` — `reason`), a class `sinceInstall.byClass` shows still
<!-- host: claude -->
  climbing first, then read `${CLAUDE_PLUGIN_ROOT}/skills/jig/SKILL.md` and
  continue the fresh pass here; it authors and proves the new checks. Never
  invent a class that is not in `backlog`.
<!-- host: codex -->
  climbing first, then read [Jig setup](../jig/SKILL.md) and continue the
  requested fresh pass here. Never invent a class that is not in `backlog`.
<!-- host: end -->
- **Nothing, just the report** — stop here.

One pass, then done; no follow-up menus. The kill switch for the session guards
<!-- host: claude -->
is still a file named `.jig/off`; the commit hook and CI keep running.
<!-- host: codex -->
is still a file named `.jig/off`; commit and CI checks keep running.
<!-- host: end -->
