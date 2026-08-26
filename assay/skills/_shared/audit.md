# The audit procedure

The one statement of how a Claude Code audit runs. Every model command under
`skills/` opens this file and follows it; none of them repeats a step of it.
What differs between them is the **model target** — the model the findings are
written for — which the command that sent you here names in its own `SKILL.md`.

The target is a **measurement**, not a label. Its id is the name of the command
that sent you here — `opus5`, `sonnet5`, `haiku45` or `fable5` — and every call
below that scans takes it as `--model <id>`: `scan`, `remeasure`, `validate` and
`ci`. Pass it on every one of them, or the run scores under a different model
than the one the user asked about. `report` takes no `--model`: it reads the
column back off the scan it renders.

Carry the target into your closing sentences too, so the reader knows who the
advice was written for. One honesty limit stands: only the `haiku45` column was
measured against live runs. The other three declare `profile-inferred` evidence
on every constant they ship, and the report says so itself — do not upgrade that
wording.

The script measures everything mechanical; you judge two factors and present the
result. Never re-derive by hand what the script already computed.

Flags in `$ARGUMENTS`: `--dry-run` (audit and preview only — the menu is not
asked, nothing is written), `--verbose` (the full report), `--json` (the
machine-readable record), `--top <n>` (show more than the default 8 rows in the
fix table), `--no-verify` (skip the subagent in step 2, which otherwise runs),
`--deterministic` (skip every model step and report what the script alone can
see), `--semantic` (also propose paraphrased duplicates and indirect conflicts
the script cannot see), `--project-only` (skip the user's own instruction
files).

## 1. Scan

From the project root — pass `--project-only` through if `$ARGUMENTS` has it, to
this step and to every later call that re-scans: `remeasure` and `ci`. The rest
work from the saved scan and refuse the flag, because they have nothing left to
discover:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" scan --model <id>
```

assay needs Node 18 or newer. If `node` is not on PATH (fnm/nvm setups),
register it the way the project says to — its `CLAUDE.md` if there is one, else
its README or `.nvmrc`/`.node-version`. On a project with none of those, ask the
user how they start node rather than pointing at a file that does not exist.
Then rerun.

The output JSON has a `judge` list — every rule needing your judgment — and
writes full data to `.assay-tmp/scan.json`. The scan also grades every
`.claude/skills/*/SKILL.md` description against the trigger recipe; those need no
judgment.

Then say one sentence before the silence of step 2: how many rules in how many
files were found, that each is being graded and then checked, and that it takes
about a minute. Between the scan and the report the only thing the user can see
is a `Write` of hash-keyed decimals.

If `ruleCount` and `skillCount` are both 0, tell the user nothing was found,
**run step 6's clean-up**, and stop — the scan wrote `.assay-tmp/`, and leaving
it behind is litter in someone's repository. If only `ruleCount` is 0, write
`{}` to `.assay-tmp/judgments.json`, skip step 2, and continue.

Under `--deterministic`, go straight to step 3 and write no judgments file at
all. The engine has no such flag and never needs one — the absence of
`.assay-tmp/judgments.json` *is* the mode, and the report lands complete, and
its provenance line says what did not run — "Did not check: whether each rule
names a clear moment to act, and whether a script could do the job instead."
(`--verbose` adds a `deterministic only` banner on top of that).

A `judge` entry can include `context` when a heading or following clarification
is needed to interpret the rule. Judge the rule with that context, but keep
`text` as the exact source wording — report links and rewrites target that text.

## 2. Judge F3 and F8, then verify

Read [../../references/rubrics.md](../../references/rubrics.md), then score every rule in the
`judge` list on both factors:

- **F3 — trigger-action distance**: will Claude recognize the moment this rule
  fires? 0.95 immediate → 0.05 no trigger at all.
- **F8 — enforceability ceiling**: could a hook or linter enforce this better
  than prose? 0.90 judgment-only → 0.15 fully mechanical.

Score every rule in one continuous pass — interleaving other tool calls drifts
your scale between batches. Where a rule has `needsF1: true`, add an `F1` value
too (verb strength per the rubric note).

Write the result with the `Write` tool to `.assay-tmp/judgments.json`, keyed by
each rule's `key` from the `judge` list — the stable content hash, not the `R###`
display id. The hash is what lets a judgment survive an edit elsewhere in the
file. Add one more top-level key, `_provenance`; it sits beside the rule keys and
is never one of them.

```json
{
  "a1b2c3d4e5f6": { "F3": 0.75, "F8": 0.9 },
  "9f8e7d6c5b4a": { "F3": 0.45, "F8": 0.15, "F1": 0.7 },
  "_provenance": { "model": "claude-sonnet-4-5", "promptVersion": "2", "judgedAt": "2026-07-28T09:41:00Z", "pass": "F3/F8" }
}
```

`model` is the model you are running as — its id if you know it plainly, a plain
name otherwise, never a version number you are unsure of. `promptVersion` is the
number on the `Rubric version:` line at the top of the rubrics file, as a string.
`judgedAt` is the current time, ISO 8601. `pass` is `"F3/F8"` now, and
`"F3/F8+verify"` once the check below has run. The rubric is the axis a content
hash cannot see, so the report warns when judgments predate the one shipped.

**Verify what is a rule at all.** Run this by default; `--no-verify` and
`--deterministic` skip it. Extraction cannot tell a directive from a
retrospective, so a lessons file can arrive graded as a page of mandates.

Send **one** `Agent` call — `subagent_type: "general-purpose"`, `model:
"sonnet"`, `run_in_background: false` — carrying every rule from the `judge` list
whose text you doubt is a rule at all: its `key`, `text`, `file`, `scope`, and
`autoMemory` when the entry has it. An `autoMemory: true` entry is a note the
assistant wrote about this project, not an instruction the user authored, and
the subagent needs that to answer at all. Ask for exactly one verdict per
entry: is this an instruction to follow, or is it narration,
history, an example, or a description of what the project does? Ask for a
one-sentence reason on every entry it rejects, in its own words.

`sonnet` is load-bearing, not a default to economize on: a measured run on
realistically-phrased rules — directives buried in lessons learned, requirements
stated with soft modals — dropped a real rule about one batch in four on haiku,
and none at all on sonnet. One batched call per audit, so the cost is a single
request.

For each rejected entry only, add a `notRule` key to that rule's object holding
the returned reason verbatim, and set `_provenance.pass` to `"F3/F8+verify"`:

```json
{ "9f8e7d6c5b4a": { "F3": 0.45, "F8": 0.15, "notRule": "Records what the team decided last quarter; it asks for nothing." } }
```

Dropping an entry is all this pass may do — never edit an `F3` or `F8` you
already wrote, never reword a rule, never add `notRule` on your own judgment
instead of the subagent's. A dropped entry still counts in its file's coverage
and never leaves the inventory; the report simply regroups it.

**Under `--semantic`**, also collect what the script cannot see — two rules
stating one duty in unrelated words, or two that only collide once you know what
each is for — into a `_candidates` key beside `_provenance`:

```json
{ "_candidates": [
  { "kind": "paraphrase-duplicate", "keys": ["a1b2c3d4e5f6", "9f8e7d6c5b4a"], "summary": "Both require input validation at the API edge.", "reason": "Different words, one duty.", "accepted": null }
] }
```

`kind` is `paraphrase-duplicate` or `indirect-conflict` — the two kinds this
pass proposes; a kind the engine does not recognize fails the run. `keys` names
the rules involved. `summary` and `reason` are one sentence
each, in your own words. `accepted` is always `null` here — it is the user's
answer, not yours. Propose only what you would defend, and without the flag write
no `_candidates` key at all.

## 3. Report

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" report
```

Bare, this prints the **short report** — the default, and what the user reads:
one headline of counts, a provenance line saying what was read and which whole
checks did not run, **Fix these first**, **Could be automatic instead**, **Also
worth a look**, and one closing line. It names each rule **once**, under its
worst problem, and carries no score, factor code or evidence tag. That is gated:
a release test fails if it runs past 40 lines, repeats a rule, or uses a word
that needs Claude Code internals.

Add a flag only when `$ARGUMENTS` carried it. `--json` prints the whole record —
over a thousand lines on a four-rule project, and unreadable in a chat. `report`
has already written that same record to `.assay-tmp/audit.json` on its own, so
run the bare command, print none of the body, and name that path and how big it
is instead. Do not redirect anything over that file — step 7's before/after
reads it.

**`--verbose` prints the full report** — coverage, hard gates, every finding with
its evidence tag, the enforcement ladder, per-file grades, User scope, weak
descriptions, and everything the verify pass suppressed. Pass it when the user
asks for detail, asks about one finding, or wants the grades; nothing is missing
from the short report that is not in this one.

The report is this skill's deliverable. Print its markdown **verbatim** — every
location is a clickable `[path:line](path:line)` link, so do not reword a cell,
rebuild a table, or replace a link with a bare line number. Do not summarize it
either; it is already the summary. One exception: the scan's `hookInventory` is
yours to work from and never printed. Use it on the hook-candidate list only:
where a candidate is plainly covered by a wired hook (same trigger, same action),
say so beside the entry and drop it from the counts in step 4.

A conflict names both rules and neither winner, and no change this engine applies
can retire a rule — so do not ask a question nothing here can carry out. Say
which two disagree, print the finding's own next steps from `--verbose` as the
manual options they are, and say plainly that acting on one of them is the user's
own edit. Anything you proposed under `--semantic`
prints as a proposal — ask about each one in the same message and record the
answer back into `_candidates[].accepted` before you clean up. An accepted
proposal never changes a rule's state, its score, or the grade.

Then add at most 2 sentences of your own: the single most valuable fix, and
anything project-specific the report cannot see. Never present a grade as a
prediction that Claude will or won't follow a rule — it measures how the rule is
written, scoped, and placed.

Wording severities are reliability levers whose measured effects come from small
pre-Claude-5 tiers (haiku 4.5) — weight them most where haiku-class models,
subagents, and pipelines run. Availability gates and byte-cap findings are
model-independent; conflict, duplicate, and stale-reference detection are
deterministic checks on the corpus, reported at their own evidence levels, not
compliance claims.

If the command errors about judgments, fix `.assay-tmp/judgments.json` and rerun.

If this run cannot put text in front of the user ahead of a tool call, **skip
step 4**, go to step 6, and make the report the final message: a menu with no
report behind it asks the user to choose blind.

## 4. Offer fixes

Skip to step 6 when the report has no weak rules, no weak descriptions, no dead
references, and nothing under **Could be automatic instead**.

Under `--dry-run`, do not ask the question at all and write nothing. Say what
each option below would have covered and how many rules it names, say plainly
that nothing was changed, then go to step 6. Do not assemble a draft plan and do
not run `plan`: that command writes a file, and this flag exists so a person can
see the whole audit with no artifact left behind. Name the command they ran
without the flag as the way to act on any of it.

Otherwise ask ONE question with `AskUserQuestion` (`multiSelect: true`, header
`"Fix menu"`), including only the options that have evidence:

Every label below is read by the user, so it says what happens in words they had
before they installed anything — never "quality floor", "plan artifact",
"placement candidate", or a bare "park".

- `Reword [N] unclear rules` — "Rewrite the rules the report calls too vague or
  says have no clear action. You see each change before it lands, and any of them
  can be undone." N is the number of rows in **Fix these first** whose Fix cell
  offers a wording fix. It is *not* the headline's "N rules need work" — that
  count also covers rows whose Fix cell reads "A hook … could do this on every
  run — build that instead of rewording it" or "A hook is already wired for
  this", and a rewrite is the one thing those rows say not to do. If the table
  ends with "N more not shown here", rerun `report --top <n>` past that total so
  every row prints before you count. Those mechanism-owned rows are missing from
  **Could be automatic instead** as well — the report names each rule once, under
  its worst problem — so add them to `Build the mechanism now` and `Just write
  down the plan` rather than dropping them. Dead paths, duplicates and
  disagreements have their own rows and their own headline clauses, and none of
  them count here.
- `Repair [N] dead references` — "Repoint the rules naming a file that is not
  there, or drop the mention. You see each change first." This is the
  `stale-reference-repair` kind the engine already implements; offer it whenever
  the report has a "points at … which is not there" row, and rank it above the
  rewrites, exactly as the report does.
- `Rewrite [N] skill descriptions` and `Rewrite [N] subagent descriptions` — two
  separate options. "A description is how Claude decides to reach for it, and
  these read as summaries instead." The two headings that carry those counts are
  in the full report, not the short one — a default run merges skills and
  subagents into the capped **Also worth a look** list — so take both from
  `report --verbose`, whose `## Weak skill descriptions (N to fix)` and
  `## Weak subagent descriptions (N to fix)` headings state them directly. Never
  count them yourself off the short report. Never fold subagents under a label
  that says skill: they are different files, and the count then matches no
  number the user has seen.
- `Build the mechanism now (N)` — "Preview the hook, skill, or subagent built
  from the current official docs, and install the ones you approve. The rules
  stay where they are."
- `Just write down the plan (N)` — "Write the plan for each one into a file you
  keep, and change nothing else."

The last two cover **the same N items** — say so in the question text, because
the two counts being equal looks like a mistake otherwise. If both are checked,
building wins and the plan is written for whatever is left. Everything checked
goes into ONE draft plan.

## 5. Plan, preview, apply, validate

Read [fixes.md](fixes.md) and follow it. It carries the
draft-plan shape, what each change kind must carry, and the five transaction
steps — assemble, plan, preview, apply per approved id, validate.

Two things hold whichever kind you write. Never hand-edit a file this flow is
going to write: an `Edit` behind the transaction's back leaves the plan stale and
the journal blind. And **the source rule stays exactly where it is** — no kind
this engine applies deletes or deactivates prose, so after a promotion the duty
may be stated twice on purpose.

## 6. Clean up

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" clean
```

Run this after step 7's remeasure, when there was one — remeasure reads
`.assay-tmp/`, and this deletes it. It removes `.assay-tmp/`, and the change
journal too once every applied change has been validated or rolled back.

**Say what it destroys before running it.** Removing the journal removes the
undo — after this, `git diff` is the only way back. While the user is still
deciding whether to keep a change, offer to leave it and clean up later.

It exits 1 and keeps the journal when a change is still open: a journal holds the
only copy of a file as it was, so it is never deleted while a write is
unresolved. That exit is a prompt, not a failure of the audit — name the open
changes it listed, and offer to validate or roll each one back. Plans written
down rather than applied survive either way, and `clean` prints their paths;
name them in the final message so the user can find them.

## 7. Say what the fixes did

Only when something was applied, and before step 6, because both commands here
read the journal and the judgment cache.

First, what actually landed:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" applied
```

It prints the last run out of its own records — every file written, the kind of
each change, the rule it addressed, and the one command that undoes the whole
run. Print what it says. Do not rewrite it from what you believe you did: an
apply that died mid-write leaves a journal and a transaction row, and this is
the only thing that reads them. Pass `--transaction <id>` to name an earlier run.

Then the before and after:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" remeasure --model <id>
```

It re-scans, reuses every cached judgment whose rule is unchanged, and prints the
before and after. A reworded rule comes back as a `judge` worklist instead of a
report — judge only those, **merge** them into `.assay-tmp/judgments.json`
without disturbing the rest, and run it once more. At most twice.

Then write the final message: whatever step 3 did not already show, your two
sentences, what `applied` reported landing, the before/after this step measured,
and the undo command, verbatim, so the way back is on screen beside the change.
