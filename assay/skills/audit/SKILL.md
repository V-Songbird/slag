---
name: audit
description: >-
  Grades every rule in the project's CLAUDE.md and .claude/rules/ for structural
  clarity — verb strength, framing, trigger distance, loading scope, position in
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
argument-hint: "[--fix] [--verbose] [--json] [--no-verify]"
allowed-tools: Bash, Read, Write, Edit, Glob, AskUserQuestion, WebFetch, Agent
---

# assay:audit

The script measures everything mechanical; you judge two factors and present the
result. Never re-derive by hand what the script already computed. Flags in
`$ARGUMENTS`: `--fix` (apply rewrites without the menu), `--verbose` (full factor
table), `--json` (machine-readable report), `--no-verify` (skip step 2b, which
otherwise runs).

## 1. Scan

From the project root:

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

## 2b. Verify

Run this step by default. Skip it only when `$ARGUMENTS` contains `--no-verify`.
A measured run earned it the default slot — see the model note below.

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

Change nothing else. The pass may drop an entry and that is all it may do —
never edit an `F3` or `F8` you already wrote, never reword a rule, never add
`notRule` on your own judgment instead of the subagent's. An entry with
`notRule` leaves the counts, the file grades, and the corpus grade; it does not
get rescored.

## 3. Report

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" report
```

Add `--verbose` or `--json` if the user asked. The command prints the finished
markdown report — corpus grade, per-file grades, weak rules with suggested
fixes, stall risks, buried rules, stale references, hook opportunities,
placement candidates, weak skill descriptions. With `--verbose` it also lists
everything step 2b suppressed, each with its reason quoted. If step 2b
suppressed anything and the user did not pass `--verbose`, say how many entries
were dropped in your own three sentences below — a silent drop is the one thing
this pass must never do.

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
it "already enforced by `<command>`" next to the entry and drop it from the
promote/park counts in step 4.

Then add at most 3 sentences of your own: the single most valuable fix and
anything project-specific the numbers can't see. If the project visibly runs subagents or headless automation, one
of those sentences should say the grades apply at full severity there; if it
clearly does neither, say severity reads one notch softer. If it errors about
judgments, fix `.assay-tmp/judgments.json` and rerun.

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
  "Build each hook, skill, or subagent at project scope, straight from the
  live official docs."
- `Park [N] placement candidates` — only if placement candidates exist.
  Description: "Move them out of the rule files into .claude/assay-promotions.md
  with instructions to promote each into its hook/skill/subagent."

Apply what was checked, per [references/fixes.md](references/fixes.md). If both
promote and park are checked, promotion wins and parking covers the remainder.
Match rules by exact text, never by line number. After applying, remind the
user to review with `git diff`. Do not loop, re-audit, or offer follow-up
menus — one pass, then done. If the user wants to measure the improvement they
can run `/assay:audit` again.

## 5. Clean up

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" clean
```

Always run this last, whether or not fixes were applied. Then write the final
message: whatever step 3 did not already show, your three sentences, and what
step 4 changed.
