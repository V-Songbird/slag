# What assay measures

This page is for you, the person reading the report. It explains every check
behind a wording verdict, in the same shape each time: what the check looks at,
a rule that fails it, the same rule passing, and what the check does **not**
claim.

Two of the checks need a model to run; the other five are a script, and give the
same answer every time on the same text. The report says which is which, and
says plainly when a check did not run at all.

No part of this predicts whether the agent will follow a rule. It measures how the
rule is written, where it sits, and what it names — the parts you control.

---

## No clear action

**Looks at:** whether an instruction verb leads the line. `Always`, `Never`,
`Run`, `Use`, `Add` — and the hedges that soften them, like `try to` or
`where possible`.

> ✗ `CHANGELOG entries are short and user-facing.`
> ✓ `Keep CHANGELOG entries under three lines, written for the user.`

The first is a description of a state of affairs. The second asks for something.

**Does not claim:** that a firmly-worded rule gets followed. A hedge is a real
signal on smaller models; on a large one in an interactive session it matters
much less.

---

## Says what not to do, never what to do

**Looks at:** a prohibition with no replacement named beside it, and no escape
hatch.

> ✗ `Never edit the generated files.`
> ✓ `Never edit the generated files — change the template in `templates/` and
> re-run `npm run gen` instead.`

**Why it matters:** a ban with nowhere to go turns a blocked task into a stopped
one. The agent needed the thing you banned, has no alternative, and stalls.

**Does not claim:** that every prohibition needs one. Some bans really are
absolute — say so, and say what to do instead of continuing ("stop and ask").

---

## No clear moment it applies

**Looks at:** how far the rule's firing moment sits from the action it asks for.
This one is judged by a model, not a script, because recognizing a moment is not
something a pattern can settle.

> ✗ `Keep the changelog in step with the code.`
> ✓ `Before opening a pull request, add a line to `CHANGELOG.md` for every
> user-visible change in it.`

The first needs the agent to remember, unprompted, at some future point. The
second names the moment.

**Does not claim:** that a named moment is a guarantee. It is the difference
between a rule that can fire and one that has to be recalled.

---

## Applies too broadly

**Looks at:** whether the file's scope matches what the rule talks about. A rule
about TypeScript in a file that loads for every session is a mismatch; so is a
rule about everything in a file scoped to `**/*.py`.

> ✗ in the always-loaded file: `When editing TypeScript files, prefer named
> exports.`
> ✓ in a file bound to `**/*.ts` and `**/*.tsx`: `Use named exports.`

**Why it matters:** an always-loaded rule is paid for by every session, whether
or not it applies. Scoping it moves the cost to the sessions it is about.

**Does not claim:** that scoping is always better. A rule that genuinely applies
everywhere belongs in the always-loaded file.

---

## Buried near the bottom

**Looks at:** where the rule sits in the graded content of its file, and only in
files long enough for position to matter. Fenced-off narrative does not count
against a rule below it.

> ✗ line 180 of a 200-line file.
> ✓ the same rule in the top quarter, or the file split by topic.

**Does not claim:** that the bottom of a file is unread. It is the weakest place
to put something you need followed, and it is one of the few parts of loading you
control directly.

---

## Too vague to act on

**Looks at:** what the rule names. A path, a command, an identifier in backticks,
a number with a unit — against the adjectives that leave the standard to the
reader: `clean`, `proper`, `appropriate`, `reasonable`, `careful`.

> ✗ `Write clean, maintainable code.`
> ✓ `Keep functions under 40 lines; extract a helper rather than nesting a third
> `if`.`

When the report says a rule is too vague, it quotes the words that made it so.

**Does not claim:** that every rule needs a path. Some need a threshold, some a
worked example, and a few genuinely need judgment — those are the ones the next
check is about.

---

## Could be automatic instead

**Looks at:** whether a command with an exit code could settle the rule. Judged
by a model, like the trigger check.

> ✗ as prose: `Run prettier before committing.`
> ✓ as a hook: a `PreToolUse` entry that runs `npx prettier --check .` and fails
> the commit.

**Why it matters:** prose asks the agent to remember. A hook does not ask.

**Does not claim:** that prose is wrong. A rule that needs real judgment belongs
in prose, and the report says so about those instead — the check runs in both
directions.

---

## The checks that need no wording at all

These run on every rule, in every language, and none of them is a judgment about
how the rule reads:

- **It points at a file that is not there.** Read out of the working tree. When
  the file merely moved, the report says where it went.
- **Two rules disagree.** One bans exactly what another commands, on the same
  subject. assay names both and picks no winner — which policy is right is your
  decision, not a wording question.
- **The same duty is stated twice.** Either word for word, or close enough that
  the two read as one duty. The report names the copy that looks worth keeping.
- **The host never loads it.** A file scoped to a pattern that matches nothing, a
  file another one shadows, a rule past a documented read limit.
- **A hook already covers it.** Read out of the settings files — configured, not
  watched running.

---

## What "no finding" means

A rule with nothing on it passed the checks above. That is all. No static check
can tell you an agent will comply, and this one does not try: it tells you the
rule is written so that it could.
