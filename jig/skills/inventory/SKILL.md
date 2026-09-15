---
name: inventory
description: >-
  Reports what jig checks in this repository and where it runs: every guard
  with what it watches and what happens on a match, every check module including
  the ones only the commit hook and CI run, every file jig wrote with the reason
  it was approved and whether it has drifted, and whether the session, commit and
  CI lanes are actually live. Opens with the short answer — what jig checks,
  where that runs, what needs attention — and gives the full report or one
  section on request. Read-only — it changes nothing. Use when the user asks what
  jig has installed, what it is watching, why something is there, how a guard
  works, or whether the checks are really running — e.g. "what guards does jig
  have", "what is jig watching", "why did jig install this", "what did jig do to
  my repo", "how does this check work", "is anything actually running" — or
  invokes /jig:inventory. Do NOT use to report what jig has CAUGHT or to change a
  guard — that is /jig:review — or to install anything, which is /jig:jig.
argument-hint: "[full] [guards] [checks] [files] [lanes] [<guard id or path>]"
allowed-tools: Bash, PowerShell, Read
---

# jig:inventory

Three surfaces, one job each. `/jig:jig` installs, and routes a plain-language
question here. `/jig:review` reports what the guards have **caught** and acts on
it. This one reports what is **here** — and stops. Nothing in this skill arms,
disarms, retires, waves off, migrates or installs anything. When the owner asks
for one of those by name, read the skill that owns it —
`${CLAUDE_PLUGIN_ROOT}/skills/review/SKILL.md` or
`${CLAUDE_PLUGIN_ROOT}/skills/jig/SKILL.md` — and continue its workflow here,
with every consent step it requires; never send the owner off to invoke it.
Shape every answer the way `${CLAUDE_PLUGIN_ROOT}/skills/jig/references/experience.md`
says: the summary first, the detail on request.

Everything comes from one command:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" inventory
```

Run it from the project root. If `node` is not on PATH (fnm/nvm setups),
register it the way the project's CLAUDE.md says to, then rerun. If the command
refuses because the install predates the rework, say that the install needs
upgrading before anything below reads correctly, and stop. Offer the upgrade
through the setup skill; an inventory request does not authorize a migration.

With no argument, give the summary: what jig checks, the session, commit and CI
states each on their own, and what needs attention. Read all four sections
below to build it — a check with no guard row is still an installed check — and
surface every broken configuration, silenced lane, coverage gap, pending
approval or drifted file the result carries.

An argument narrows the detail to one section: `guards`, `checks`, `files` or
`lanes`; a named guard or file gets its own detail. `full`, or a request for
everything, prints all four sections in that order, after the summary. These
are choices about the answer, not flags the engine's `inventory` command takes.

The sections below say what each field means and how to show it when it is
asked for. Every guard, check and file you detail gets the same two-part
treatment: a sentence saying what it does in plain words, then the facts under
it. Readable first, checkable second. Never one without the other — a sentence
nobody can verify is a claim, and a field dump nobody can read is not a report.
A `why`, a `problem` or a `fix` the section says to print verbatim stays
verbatim in the summary too; healthy rows may be grouped, never hidden.

## 1. Guards — what runs inside a session

`guardsProblem` non-null comes first, before anything else in the report. It
means jig refused the guard config outright, so `guards` is empty for that
reason and not because nothing is installed. Print it verbatim, say what repair
it needs without applying one, and go on to the checks, the files and the lanes
— those still read.

`installed: false` is the other reason `guards` can be empty, and it is not the
same one: there is no `.jig/config.json` here at all — jig was never installed,
or `revert` took it back out. `why` is the sentence for it. Say that instead of
showing an empty list, which reads as "everything was retired".

`guards[]`, one row per configured guard. `watches` is the new half and the
reason this skill exists:

- `watches.event` — `PreToolUse` (before the call, which is where a `bash-guard`
  and an `edit-guard` both run) or `PostToolUse` (after the edit, where the older
  `edit-observe-guard` runs and the bytes have already landed). `watches.tools`
  names the tools it sees, and it is the lever that decides them: the two events
  no longer split Bash from Edit.
- `watches.paths` — the globs it looks at. `watches.patterns` — how many
  matchers it carries. The matchers themselves are counted, never printed: they
  live behind an approval boundary and a report is not a place to re-issue one.
- `watches.deny` — the reply an armed match shows. Null means this guard
  **cannot arm at all**, whatever its row says. Say that out loud.
- `mode` — `armed` (it blocks) or `observe` (it records and lets the call
  through), and `why` says what put it there. Print `why` verbatim; paraphrasing
  an honest limit blurs it.
- `problem` — non-null means the guard is **broken, not quiet**. Report it first
  and separately. A broken guard read as "never fired" is coverage the user
  thinks they have.
- `provable: false` — a fixture is missing, so this check can never be
  re-proven and no row naming it can arm.
- `teach` — whether an observing match also says so in the transcript: one line
  of context carrying this guard's id and its deny triple, and no source. Off
  unless the guard's own row set it, and available on either runner.
  Report it where it is on; a guard that teaches is one the owner will hear from
  and should be able to find here.
- `provenance: "assumed"` — a default the owner never saw. Label it as one every
  time it is reported.

## 2. Checks — what runs at commit time and in CI

`checks[]`, one row per module under `.jig/checks/`. These overlap the guards
but are not the same list, and the difference is the point: a detector whose
`event` is `checks` has **no guard row anywhere** and is exactly what the commit
hook and CI run. A report built from the guards alone would show a fraction of
the coverage as the whole of it.

Each row carries `title`, `severity`, `provable`, and its `detectors[]` in the
same `watches` shape as above. A detector with a non-empty `pairedWith` and no
`extract` is the second kind: it does not match text at all — it reports a file
in `paths` that changed with nothing in `pairedWith` changing beside it. A
non-zero `removed` is the third: it counts what stopped being there rather than
what is there, so the driver reports that class **skipped** on a normal run —
say so, because a class this lane cannot evaluate is not a class that came back
clean. A non-zero `extract` is the fourth: it takes names out of the files in
`paths` and reports the ones no file matching `pairedWith` carries, which is the
doc that names a flag the code renamed away. Every RUN of the driver evaluates
that one — unlike `removed`, which only the commit lane can count — so it is
watched wherever the driver runs and nowhere else: there is no session lever for
it, and a class whose only detector is this kind is watched by two of the three
lanes.

## 3. Files — what jig wrote, and why

`artifacts[]`, one row per file jig installed.

- `why` is the reason the owner approved it, and `whySource` says where that came
  from: `manifest` (recorded at install), `plan` (recovered from the plan file
  the row was applied from), or `none`. On `none`, say the reason was not
  recorded. Never supply one.
- `state` — `active`, `drifted` (edited after jig wrote it, so it is the owner's
  file now) or `retired` (gone). Drift is reported, never repaired: the journal
  still holds the pre-image if they want it back, and `/jig:jig` is where a
  repair is approved.
- `install` non-null means jig ran a package install, and the row carries the
  exact command that undoes it.

One row deserves a second look every time: `.jig/activation.md`. Its `template`
name says which face is on disk — `activation` for "here is how to turn
commit-time checks on", `activation-wired` or `activation-woven` for "they are
running, here is how to turn them off". If `lanes.commit.runs` is true while the
template still reads `activation`, the file is handing the owner a task they do
not have. That is a repository wired under an older jig. Say so, and name
`jig plan --refresh-activation` through `/jig:jig` as the fix. Never apply it
here.

## 4. Lanes — is any of this actually running

`lanes`, read fresh rather than remembered from the install.

- `lanes.session` — whether anything is armed, and whether anything is
  observing. `off: true` means `.jig/off` is present and NOTHING in this lane
  runs, whatever the guard rows above say; `offSince` is when the switch went
  on. Report that before anything else about the guards.
- `lanes.session.shell` — `watched` is every name jig's hooks match, and `seen`
  is every name jig's own ledger rows have recorded IN THIS REPOSITORY: not per
  guard, not per host, and not time-bounded, so it carries a retired guard's
  rows and, where `.jig/ledger.jsonl` was committed, another machine's. Report
  it in those words, never as "this host sends". An empty `seen` is "not yet
  observed" — say that, never guess from the operating system. Which shell a
  particular guard has met is `evaluatedOn` on that guard's own row, not this
  field; report that one wherever a single guard is being described.
  Wherever `seen` names more than one shell, say plainly that a command guard's
  patterns are matched as text against the line as sent: a pattern spelling only
  one shell's syntax evaluates on the other and passes, and passing is not
  coverage. Name no example idiom — jig has measured which spellings differ on
  no host.
- `lanes.commit` — the git hook. `runs` says the hook invokes the checks and
  `executable` says git can actually run it: `false` is a live-looking lane that
  does nothing, and `null` means win32, where the question does not apply. Both
  have to hold. `state` says why when `runs` is false and `fix` is the one thing
  to do about it — print `fix` verbatim, because nothing puts `jig` on a PATH.
- `lanes.ci` — the workflow, and the floor. A live CI lane is why a dead commit
  lane is an inconvenience rather than a hole. `runs` means the workflow still
  invokes the driver, read from the file; `state` is `live`, `drifted` (it runs,
  and the file is the owner's now), `unwired` (a workflow that no longer runs
  the checks) or `absent`.

Report a dead lane in plain terms: what does not run, what still does, and the
one command that fixes it. Name the fix; never run it. Applying it is an
approved, reversible change like any other, which means the setup skill — read
it and continue there only when the owner asks for the repair.

`verify` is one row per lane entry — the commands the lanes run besides the
check driver — and `lastGreen` is the last time jig WITNESSED that command run
green — in a Claude session, or in this machine's own commit lane — or `null`
for one nothing here has been seen to pass. A repository whose CI runs the suite
green on every push reads `null` too: the CI lane's row is written into the
runner's own checkout, which is thrown away with the job. Report it with the
lanes: a lane that is live and an entry that has never run green are two
different facts, and only the second one answers "do the tests pass".

## Closing

End with the answer, and mention once what more there is — the guards, the
checks, the files, the lanes, or the full report. Name a next step only if a
finding earned it, in the owner's words: "ask jig to review that alert", "ask
jig to repair the commit hook". `/jig:review` and `/jig:jig` stay available as
direct entries; the owner need not learn them to continue. If nothing is
installed, say so and say that jig can prepare a setup proposal. The kill switch
for the session guards is a file named `.jig/off`; the commit hook and CI keep
running.
