---
name: inventory
description: >-
  Reports everything jig put in this repository and why it is there: every guard
  with what it watches and what happens on a match, every check module including
  the ones only the commit hook and CI run, every file jig wrote with the reason
  it was approved and whether it has drifted, and whether the session, commit and
  CI lanes are actually live. Read-only — it changes nothing. Use when the user
  asks what jig has installed, what it is watching, why something is there, how a
  guard works, or whether the checks are really running — e.g. "what guards does
  jig have", "what is jig watching", "why did jig install this", "what did jig do
  to my repo", "how does this check work", "is anything actually running" — or
  invokes /jig:inventory. Do NOT use to report what jig has CAUGHT or to change a
  guard — that is /jig:review — or to install anything, which is /jig:jig.
argument-hint: "[guards] [checks] [files] [lanes]"
allowed-tools: Bash, Read
---

# jig:inventory

Three surfaces, one job each. `/jig:jig` installs. `/jig:review` reports what the
guards have **caught** and acts on it. This one reports what is **here** — and
stops. Nothing in this skill arms, disarms, retires, waves off or installs
anything, and offering to would be taking another skill's job.

Everything comes from one command:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jig.js" inventory
```

Run it from the project root. If `node` is not on PATH (fnm/nvm setups),
register it the way the project's CLAUDE.md says to, then rerun. If the command
refuses because the install predates the rework, send the user to `/jig:jig`,
which runs the migration, and stop — nothing below reads correctly until then.

An argument narrows the report to one section: `guards`, `checks`, `files` or
`lanes`. With no argument, print all four in that order.

Every guard, check and file gets the same two-part treatment: a sentence saying
what it does in plain words, then the facts under it. Readable first, checkable
second. Never one without the other — a sentence nobody can verify is a claim,
and a field dump nobody can read is not a report.

## 1. Guards — what runs inside a session

`guardsProblem` non-null comes first, before anything else in the report. It
means jig refused the guard config outright, so `guards` is empty for that
reason and not because nothing is installed. Print it verbatim and send the user
to `/jig:jig`.

`guards[]`, one row per configured guard. `watches` is the new half and the
reason this skill exists:

- `watches.event` — `PreToolUse` (before a `Bash` call) or `PostToolUse` (after
  an `Edit` or `Write`). `watches.tools` names the tools it sees.
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
- `provenance: "assumed"` — a default the owner never saw. Label it as one every
  time it is reported.

## 2. Checks — what runs at commit time and in CI

`checks[]`, one row per module under `.jig/checks/`. These overlap the guards
but are not the same list, and the difference is the point: a detector whose
`event` is `checks` has **no guard row anywhere** and is exactly what the commit
hook and CI run. A report built from the guards alone would show a fraction of
the coverage as the whole of it.

Each row carries `title`, `severity`, `provable`, and its `detectors[]` in the
same `watches` shape as above. A detector with a non-empty `pairedWith` is the
second kind: it does not match text at all — it reports a file in `paths` that
changed with nothing in `pairedWith` changing beside it.

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

- `lanes.session` — whether anything is armed, and whether anything is observing.
- `lanes.commit` — the git hook. `runs` is the whole answer; `state` says why
  when it is false and `fix` is the one thing to do about it.
- `lanes.ci` — the workflow, and the floor. A live CI lane is why a dead commit
  lane is an inconvenience rather than a hole.

Report a dead lane in plain terms: what does not run, what still does, and the
one command that fixes it. Name the fix; never run it. Applying it is an
approved, reversible change like any other, which means `/jig:jig`.

## Closing

End with one line naming where to go next, and only if something earned it:
`/jig:review` for what the guards have caught or to change one, `/jig:jig` to
install or repair. If nothing is installed, say so and point at `/jig:jig`. The
kill switch for everything at once is a file named `.jig/off`.
