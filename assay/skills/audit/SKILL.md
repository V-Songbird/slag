---
name: audit
description: >-
  Grades every rule in the project's CLAUDE.md and .claude/rules/ for structural
  hygiene — verb strength, framing, trigger distance, loading scope, position in
  the file, concreteness — and detects rules that would work better as hooks,
  skills, or subagents. Also grades each project skill's frontmatter description
  in .claude/skills/ against the trigger recipe. Most of the scoring is a
  deterministic Node script; the model judges only two factors.
  Offers to rewrite weak rules and to park placement candidates for promotion.
  English-only scoring. Use when the user wants feedback on existing rule files
  — e.g. "are my rules any good", "check my CLAUDE.md", "grade my instruction
  files", "which rules are weak or vague", "audit my rules", "which rules should
  be hooks" — or invokes /assay:audit with any flags. Do NOT use to review code,
  PRs, or non-Claude config like eslint.
argument-hint: "[--fix] [--verbose] [--json] [--no-verify] [--deterministic] [--semantic] [--artifact] [--project-only]"
allowed-tools: Bash, Read, Write, Edit, Glob, AskUserQuestion, WebFetch, Agent, Artifact
---

# assay:audit

The script measures everything mechanical; you judge two factors and present the
result. Never re-derive by hand what the script already computed. Flags in
`$ARGUMENTS`: `--fix` (apply rewrites without the menu), `--verbose` (full factor
table), `--json` (machine-readable report), `--no-verify` (skip step 2b, which
otherwise runs), `--deterministic` (skip every model step — steps 2 and 2b — and
report what the script alone can see), `--semantic` (while judging, also propose
paraphrased duplicates and indirect conflicts the script cannot see),
`--project-only` (skip the user's own instruction files).

## 1. Scan

From the project root — pass `--project-only` through if `$ARGUMENTS` has it:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" scan
```

If `node` is not on PATH (fnm/nvm setups), register it the way the project's
CLAUDE.md says to, then rerun. The output JSON has a `judge` list — every rule
needing your judgment — and writes full data to `.assay-tmp/scan.json`. The
scan also grades every `.claude/skills/*/SKILL.md` frontmatter description
against the trigger recipe; those need no judgment.

If `ruleCount` and `skillCount` are both 0, tell the user nothing was found and
stop. If only `ruleCount` is 0, write `{}` to `.assay-tmp/judgments.json`, skip
step 2, and continue.

If `$ARGUMENTS` contains `--deterministic`, go straight to step 3 from here:
write no judgments file at all and skip steps 2 and 2b. The engine has no such
flag and never needs one — the absence of `.assay-tmp/judgments.json` *is* the
mode. The report lands complete, labelled `deterministic only`, with the
model-judged checks named in the Coverage block as not run.

A `judge` entry can include `context` when a heading or following clarification
is needed to interpret the rule. Judge the rule with that context, but keep
`text` as the exact source wording — report links and rewrites target that text.

## 2. Judge F3 and F8

Read [references/rubrics.md](references/rubrics.md), then score every rule in
the `judge` list on both factors:

- **F3 — trigger-action distance**: will Claude recognize the moment this rule
  fires? 0.95 immediate → 0.05 no trigger at all.
- **F8 — enforceability ceiling**: could a hook or linter enforce this better
  than prose? 0.90 judgment-only → 0.15 fully mechanical.

Score all rules in one continuous pass — do not interleave other tool calls, or
your scale drifts between batches. Where a rule has `needsF1: true`, add an `F1`
value too (verb strength per the rubric note).

Write the result with the `Write` tool to `.assay-tmp/judgments.json`, keyed by
each rule's `key` from the `judge` list — the stable content hash, not the `R###`
display id. Keying by the hash is what lets a judgment survive an edit elsewhere
in the file: on a re-scan an unchanged rule keeps its key and its judgment, and
only a new or reworded rule needs a fresh one.

```json
{ "a1b2c3d4e5f6": { "F3": 0.75, "F8": 0.9 }, "9f8e7d6c5b4a": { "F3": 0.45, "F8": 0.15, "F1": 0.7 } }
```

Then add one more top-level key, `_provenance`, recording who judged and under
what. It sits beside the rule keys and is never one of them:

```json
{ "_provenance": { "model": "claude-sonnet-4-5", "promptVersion": "2", "judgedAt": "2026-07-28T09:41:00Z", "pass": "F3/F8" } }
```

- `model` — the model you are running as. Use its id if you know it plainly
  (`claude-sonnet-4-5` style); otherwise a plain name is fine. Never guess a
  version number you are unsure of.
- `promptVersion` — the number on the `Rubric version:` line at the top of
  [references/rubrics.md](references/rubrics.md), as a string.
- `judgedAt` — the current time, ISO 8601.
- `pass` — which judgments this file holds: `"F3/F8"` now, `"F3/F8+verify"`
  once step 2b has run.

A judgment survives an edit elsewhere in the file because its key is a content
hash; the rubric is the axis a hash cannot see, so the report prints a one-line
warning when these judgments were made under an older rubric than the engine
ships.

### When `$ARGUMENTS` contains `--semantic`

The script already finds duplicates and conflicts by token overlap and polarity.
It cannot see two rules that state one duty in unrelated words, or two that only
collide once you know what each is for. While you are judging — you are reading
every rule anyway — collect those, and write them to one more top-level key,
`_candidates`, beside `_provenance`:

```json
{ "_candidates": [
  { "kind": "paraphrase-duplicate", "keys": ["a1b2c3d4e5f6", "9f8e7d6c5b4a"], "summary": "Both require input validation at the API edge.", "reason": "Different words, one duty.", "accepted": null }
] }
```

- `kind` — `paraphrase-duplicate` or `indirect-conflict`. Any other kind the
  engine does not know fails the run.
- `keys` — the rules involved, by their `key` from the `judge` list.
- `summary` — one sentence, your own words.
- `reason` — one sentence on why you propose it.
- `accepted` — always `null` here. It is the user's answer, not yours.

Propose only what you would defend. Without the flag, write no `_candidates` key
at all; a proposal nobody asked for costs the report more than it adds.

## 2b. Verify

Run this step by default. Skip it when `$ARGUMENTS` contains `--no-verify` or
`--deterministic`. A measured run earned it the default slot — see the model
note below.

Extraction cannot tell a directive from a retrospective, so a lessons file can
arrive graded as a page of mandates. This step asks one question about those
entries and acts on nothing else.

Send **one** `Agent` call — `subagent_type: "general-purpose"`, `model:
"sonnet"`, `run_in_background: false` — carrying every rule from the `judge` list
whose text you doubt is a rule at all, its `key` and text each. Ask for exactly one
verdict per entry: is this an instruction to follow, or is it narration,
history, an example, or a description of what the project does? Ask for a
one-sentence reason on every entry it rejects, in its own words.

The model is `sonnet`, not a cheaper tier, and that is load-bearing — it is what
lets this step run by default. A measured run on a realistically-phrased corpus —
directives buried in lessons learned, requirements stated with soft modals —
dropped a real rule about one batch in four on haiku, and none at all on sonnet.
A directive is only obvious once you already see it as one; telling it from a
retrospective is the judgment this whole step exists for, so it does not get
delegated to a model that fails it. One batched call per audit, so the cost is a
single request. If that request is unwelcome — a metered key, an offline run —
`--no-verify` skips the step and the report grades every extracted chunk as
before.

Then, for each rejected entry only, add a `notRule` key to that rule's object in
`.assay-tmp/judgments.json` — the same object you keyed by its `key` in step 2 —
holding the returned reason verbatim:

```json
{ "a1b2c3d4e5f6": { "F3": 0.75, "F8": 0.9 }, "9f8e7d6c5b4a": { "F3": 0.45, "F8": 0.15, "notRule": "Records what the team decided last quarter; it asks for nothing." } }
```

Change nothing else, with one exception: set `_provenance.pass` to
`"F3/F8+verify"`, so the drops recorded here travel under the same provenance as
the scores above them. The pass may drop an entry and that is all it may do —
never edit an `F3` or `F8` you already wrote, never reword a rule, never add
`notRule` on your own judgment instead of the subagent's. An entry with
`notRule` leaves the counts, the file grades, and the corpus grade; it does not
get rescored, and it never leaves the inventory — the report regroups it, the
line count and span classification of its file are unchanged.

## 3. Report

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" report
```

Add `--verbose` or `--json` if the user asked. The command prints the finished
markdown report, findings first, in this order:

- a **Coverage** block — what was parsed, graded, set aside, excluded,
  suppressed, or unreadable — so a drop is never silent and you never have to
  restate those counts yourself;
- a headline counting the findings by kind, which is the report's verdict;
- **Hard gates** — rules the host cannot apply at all;
- **Operational findings** — loaded rules that carry a risk: conflicting pairs,
  weak rules with suggested fixes, stall risks, buried rules, stale references,
  duplicates, overlapping scopes, unknown category annotations;
- **Policy placement** — hook opportunities, placement candidates, restructure
  candidates, and the count of rules that appropriately stay prose;
- **Structural hygiene (secondary)** — the corpus grade, the per-file grades,
  and **User scope** when the user's own `CLAUDE.md` was graded. Those user rules
  are fixed in the user's setup, not in this repo, and they never move the
  project grade — do not fold them into the project's numbers when you
  summarize;
- **Weak skill descriptions**.

Every finding line carries a bracketed evidence tag — `[mechanical]`,
`[heuristic]`, `[model-inferred]`, `[experiment-supported: …]`. Keep them: they
are what stops a heuristic from reading as a fact. With `--verbose` the report
also lists everything step 2b suppressed, each with its reason quoted.

A conflict names both rules and neither winner. Do not resolve it for the user:
say which two rules disagree, and ask which one they meant.

Anything you proposed in step 2 prints under **Model-proposed relationships**,
labelled `[model-inferred]` and marked `proposed`. Ask the user about each one in
the same message, then record their answer back into `_candidates[].accepted` —
`true` or `false` — before you clean up. An accepted proposal is still a
proposal: it never changes a rule's state, its score, or the grade.

The report is this skill's deliverable and the user must have read it before
the step 4 menu asks them to choose anything. Length limits from an output
style never apply to it: reproduce every table in full.

Some output styles discard text written before a tool call, so the report has
to reach the user differently depending on the style in force:

- If you can write text before a tool call, print the report now, then go to
  step 4 and ask the menu underneath it.
- If you cannot — a style requiring silence until the work is done, or a hook
  telling you your next output must be a tool call — then **skip step 4
  entirely**, go to step 5, and make the report your final message. Close it
  with one line: rerun with `--fix` to apply every rewrite, or name what to
  rewrite. Never ask the menu when the report cannot precede it; a menu with
  no report behind it asks the user to choose blind.

Print its markdown **verbatim** — each rule cell is a clickable
`[rule](file:line)` link, so do not rebuild the tables as an artifact, reword
the cells, or replace a link with a bare line number.

Present it as-is, with one exception. The scan output carries a
`hookInventory` — every hook already wired for this project, from its settings,
the user's, and installed plugins. It is yours to work from, not the user's to
read: never print it. Use it on the hook-candidates list only. Where a
candidate is plainly covered by a wired hook (same trigger, same action), mark
it "already wired to `<command>`" next to the entry and drop it from the
promote/park counts in step 4.

Then add at most 3 sentences of your own: the single most valuable fix and
anything project-specific the numbers can't see. Never present a grade as a
prediction that Claude will or won't follow a rule — it measures how the rule is
written, scoped, and placed. If the project visibly runs subagents or headless automation, one
of those sentences should say the grades apply at full severity there; if it
clearly does neither, say severity reads one notch softer. If it errors about
judgments, fix `.assay-tmp/judgments.json` and rerun.

## 3a. Interactive HTML report — only with `--artifact`

Skip this whole step unless `$ARGUMENTS` contains `--artifact`. The markdown
tables above still print in full either way — this is an extra view of the same
`audit.json`, never a replacement for them.

When `--artifact` was passed, after the report, build the clickable HTML version:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" artifact
```

It writes `.assay-tmp/report.html` — a self-contained page (no external assets,
the audit data embedded as inline JSON) with a sortable rule table — hard gates
first, then worst score — carrying each rule's state and evidence tag, where
clicking a row expands that rule's full untruncated text, every factor score,
its grade, and the suggested fix. Publish it with the `Artifact` tool, passing that file's
path: the file is already page content only, so the Artifact skeleton wraps it
unchanged. Give the reader the returned URL.

## 4. Offer fixes

Skip this step entirely (go to 5) when the report has no weak rules, no weak
skill descriptions, and no placement candidates, or when step 3 left the report
for the final message. If `--fix` was passed, skip the question and apply every
rewrite — weak rules and weak skill descriptions — only.

Otherwise ask ONE question with `AskUserQuestion` (`multiSelect: true`,
header `"Fix menu"`), including only options that have evidence:

- `Rewrite [N] weak rules` — only if weak rules exist. Description: "Rewrite the
  rules below their quality floor in place; you review via git diff."
- `Rewrite [N] weak skill descriptions` — only if the report has a "Weak skill
  descriptions" section. Description: "Rewrite each skill's frontmatter
  description to the trigger recipe in place; you review via git diff."
- `Promote [N] candidates now` — only if placement candidates exist. Description:
  "Preview each hook, skill, or subagent built from the live official docs, and
  install the ones you approve; the rules stay active."
- `Park [N] placement candidates` — only if placement candidates exist.
  Description: "Record a deferred plan for each in .claude/assay-promotions.md;
  the rules stay where they are, untouched."

Apply what was checked, per [references/fixes.md](references/fixes.md). If both
promote and park are checked, promotion wins and parking covers the remainder.
Match rules by exact text, never by line number. After applying, remind the
user to review with `git diff`.

## 4b. Remeasure — once, only if a rewrite was applied

Skip this step unless step 4 rewrote at least one weak rule or skill description.
Promotions and parks leave every graded rule where it was, so they change no
grade; a rewrite changes a rule in place and its effect is exactly what this
step shows. Do not clean between step 4 and here — the cached judgments and the
prior `audit.json` are what make the before/after possible.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" remeasure
```

It re-scans the rewritten files and reuses every cached judgment whose rule is
unchanged. A rewrite gives a rule new text, so its content hash is new and its
old judgment no longer applies: `remeasure` prints those rules as a `judge`
worklist and a `pending` count instead of a report. When that happens, judge
only the listed rules exactly as in step 2 (and step 2b if not `--no-verify`),
**merge** them into `.assay-tmp/judgments.json` without disturbing the existing
entries, and run `remeasure` once more. The second run finds every hash known and
prints the report, which now leads with a **Since last audit** section: the
finding counts before → after, then corpus grade before → after, then each
file's before/after.

Run `remeasure` at most twice — once to surface the reworded rules, once to
report. Do not loop further: one rewrite-and-remeasure, then done. Show the
before/after section to the user; it is the evidence the fixes landed.

## 5. Clean up

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" clean
```

Always run this last, whether or not fixes were applied. Then write the final
message: whatever step 3 did not already show, your three sentences, and what
step 4 changed.
