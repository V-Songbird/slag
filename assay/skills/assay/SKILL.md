---
name: assay
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
  be hooks" — or invokes /assay:assay or /assay:audit with any flags. Do NOT use to review code,
  PRs, or non-Claude config like eslint.
argument-hint: "[--fix] [--verbose] [--json] [--no-verify] [--deterministic] [--semantic] [--artifact] [--project-only] [--host codex] [--startup <path>]"
allowed-tools: Bash, Read, Write, Edit, Glob, AskUserQuestion, WebFetch, Agent, Artifact
---

# assay:assay

The script measures everything mechanical; you judge two factors and present the
result. Never re-derive by hand what the script already computed. Flags in
`$ARGUMENTS`: `--fix` (apply rewrites without the menu), `--verbose` (full factor
table), `--json` (machine-readable report), `--no-verify` (skip step 2b, which
otherwise runs), `--deterministic` (skip every model step — steps 2 and 2b — and
report what the script alone can see), `--semantic` (while judging, also propose
paraphrased duplicates and indirect conflicts the script cannot see),
`--project-only` (skip the user's own instruction files), `--host codex` (audit
the Codex instruction system — the `AGENTS.md` chain, `.agents/skills`, and
`.codex` hooks — instead of the Claude Code one). `--startup <path>` (with
`--host codex`) audits the chain for a session started in that subdirectory;
pass it through to every `assay.js` call like the other flags.

## 1. Scan

From the project root — pass `--project-only`, `--host <name>`, and
`--startup <path>` through if `$ARGUMENTS` has them, to this step and to every
later `assay.js` call:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" scan
```

If `node` is not on PATH (fnm/nvm setups), register it the way the project's
CLAUDE.md says to, then rerun. The output JSON has a `judge` list — every rule
needing your judgment — and writes full data to `.assay-tmp/scan.json`. The
scan also grades every `.claude/skills/*/SKILL.md` frontmatter description
against the trigger recipe; those need no judgment. Under `--host codex` there
is no grade and no trigger recipe: the report is findings only, and skills are
validated against the metadata that host documents as required rather than
scored.

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

Bare, this prints the **short report** — the default, and what the user reads:

- one line saying what was looked at and what needs doing;
- **Fix these first** — a table of rules that never load, pairs that disagree,
  dead paths, and weak wording, each with the problem and the fix in plain
  words;
- **Could be automatic instead** — rules a script could own;
- **Also worth a look** — file shape, buried rules, weak skill and subagent
  descriptions, and any weak rules of the user's own that load from outside this
  repository;
- one closing line pointing at `--fix` and `--verbose`.

Add a flag only when `$ARGUMENTS` carried it: `--json` for the record instead of
the report, `--verbose` for the full report described below.

It names each rule **once**, in the section for its worst problem, and carries
no score, factor code, or evidence tag. That is deliberate and gated: a release
test fails if the short report grows past 40 lines, repeats a rule, or uses a
word that needs Claude Code internals to read.

**`--verbose` prints the full report instead** — Coverage, hard gates, every
operational finding with its evidence tag, the enforcement ladder, structural
hygiene, per-file grades, User scope, weak skill and subagent descriptions, and
everything step 2b suppressed. Pass it when the user asks for detail, when they
ask about a specific finding, or when they want the grades. Nothing is missing
from the short report that is not in this one.

A conflict names both rules and neither winner. Do not resolve it for the user:
say which two rules disagree, and ask which one they meant.

Anything you proposed in step 2 prints under **Model-proposed relationships**,
labelled `[model-inferred]` and marked `proposed`. Ask the user about each one in
the same message, then record their answer back into `_candidates[].accepted` —
`true` or `false` — before you clean up. An accepted proposal is still a
proposal: it never changes a rule's state, its score, or the grade.

The report is this skill's deliverable. Print its markdown **verbatim** — every
location is a clickable `[path:line](path:line)` link, so do not reword a cell,
rebuild the table, or replace a link with a bare line number. Do not summarize
it either; it is already the summary.

Where the report lands depends on whether this run can put text in front of the
user ahead of a tool call:

- If it can, print the report now, then go to step 4 and ask the menu
  underneath it.
- If it cannot, **skip step 4 entirely**, go to step 5, and make the report the
  final message. A menu with no report behind it asks the user to choose blind,
  so the menu waits for a run that can show one first.

Present it as-is, with one exception. The scan output carries a
`hookInventory` — every hook already wired for this project, from its settings,
the user's, and installed plugins. It is yours to work from, not the user's to
read: never print it. Use it on the hook-candidates list only. Where a
candidate is plainly covered by a wired hook (same trigger, same action), say so
beside the entry and drop it from the promote/park counts in step 4.

Then add at most 2 sentences of your own: the single most valuable fix, and
anything project-specific the report cannot see. Never present a grade as a
prediction that Claude will or won't follow a rule — it measures how the rule is
written, scoped, and placed. If it errors about judgments, fix
`.assay-tmp/judgments.json` and rerun.

## 3a. Interactive HTML report — only with `--artifact`

Skip this whole step unless `$ARGUMENTS` contains `--artifact`. Then run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" artifact`, which writes
`.assay-tmp/report.html` — a self-contained page carrying the full report.
Publish it with the `Artifact` tool, passing that file's path, and give the
reader the returned URL.

## 4. Offer fixes

Skip this step entirely (go to 5) when the report has no weak rules, no weak
skill descriptions, and no placement candidates, or when step 3 left the report
for the final message. If `--fix` was passed, skip the question: put every
rewrite — weak rules and weak skill descriptions — into one batch named
`fix-batch` in the draft plan below and apply that batch by name. A named batch
is what keeps `--fix` a recorded approval instead of an implicit one.

Otherwise ask ONE question with `AskUserQuestion` (`multiSelect: true`,
header `"Fix menu"`), including only options that have evidence:

- `Rewrite [N] weak rules` — only if weak rules exist. Description: "Rewrite the
  rules below their quality floor; you approve each patch and every write is
  reversible." N is the count of rules whose problem is **wording**. The short
  report's "N rules need work" also counts dead references, which a rewrite does
  not fix — take the wording count from the rows whose problem is a wording one,
  or from `--verbose`'s Weak rules table.
- `Rewrite [N] weak skill descriptions` — only if any skill or subagent
  description is weak. Both reports name them: the short one under **Also worth
  a look**, `--verbose` under its own sections. Description: "Rewrite each
  skill's frontmatter description to the trigger recipe; you approve each patch."
  Count weak subagent descriptions here too — same recipe, same patch shape,
  different file.
- `Promote [N] candidates now` — only if placement candidates exist. Description:
  "Preview each hook, skill, or subagent built from the live official docs, and
  install the ones you approve; the rules stay active."
- `Park [N] placement candidates` — only if placement candidates exist.
  Description: "Record a deferred plan for each; nothing is written to the rules
  and the plan artifact keeps the promotion notes."

If both promote and park are checked, promotion wins and parking covers the
remainder. Everything checked goes into ONE draft plan — step 4a.

## 4a. Plan, preview, apply, validate

Mutation is one explicit transaction, and the engine owns every mechanical part
of it: the source fingerprints, the exact patch, the staleness check, the change
journal, rollback state, and the retirement gate. You own the wording and the
approval. Never hand-edit a file this flow is going to write — an `Edit` behind
the transaction's back leaves the plan stale and the journal blind.

1. **Assemble the draft.** Write one `.assay-tmp/draft-plan.json` holding every
   change the user checked, per [references/fixes.md](references/fixes.md).
   Match each rule by its exact current text, never by line number.
2. **Plan it.**

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" plan --from .assay-tmp/draft-plan.json
   ```

   Exit 1 means the draft was rejected — an anchor that is not in the file, an
   anchor that matches twice, a promotion with no documentation provenance. Fix
   what the message names and rerun. Never route around a rejection by editing
   the file yourself. The command prints the plan id and every change id, and
   writes `.assay/plan-<id>.json`. It writes no policy file.
3. **Preview from the plan, not from your draft.** Read the plan artifact and
   show the user each change: its id, the target path, why that mechanism fits,
   and the exact `old` → `new` text. The plan is what will be applied, so it is
   what they get to see.
4. **Collect approval per change**, then apply exactly the approved ids:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" apply --change <id> --change <id>
   ```

   Under `--fix` there is no per-change menu, so the batch is the boundary
   instead: `apply --batch fix-batch`. Either way the ids are the approval
   boundary — there is no apply-everything default, and a change the user did not
   name is not applied even though the plan carries it. A stale file exits 1
   naming both fingerprints and writes nothing; re-plan rather than forcing it. A
   write whose result does not parse is restored automatically and exits 1.
5. **Validate each applied change.**

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" validate --change <id>
   ```

   It re-parses what was written, re-runs the static analysis and records the
   delta, and — for a promotion — checks the host profile actually discovers the
   new mechanism. assay never runs the repository's own tests, lint, or a fresh
   session: those are external evidence, recorded as an attestation with
   `--external "repo tests: pass"` when the user reports one, and a Proof record
   is linked with `--proof <pointer>`, never executed. A failure exits 1 and
   prints the rollback path; nothing is undone automatically at this stage.
6. **Say what is now true.** The rule is still active — a promotion added the
   mechanism beside the prose, a rewrite rephrased it in place. Tell the user
   the duty may now be stated twice on purpose, and that `git diff` shows every
   change.

Every applied change is reversible for as long as the journal exists:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" rollback --change <id>
```

Offer it whenever a validation fails or the user dislikes the result. It works
after every failure stage, including an apply that was interrupted mid-write.

**Retiring the prose is a separate decision, never a step in this flow.** Offer
it only if the user asks, and say the gate plainly: `retire --change <id>`
refuses unless the journal already holds validation evidence marking that change
a success, it needs its own change id as its own approval, and keeping the prose
as documentation or defence in depth is a legitimate outcome. Because the gate
reads the journal, retire before step 5 cleans it — a cleaned journal has no
evidence left to satisfy the gate.

**Parking is a plan nobody applied.** A parked candidate is a `park` change in
the plan artifact: recorded with its signals, its target primitive and its
promotion note, with no patch and nothing written to the rules. `apply` refuses
a park by design. The plan file is the park record and `clean` never deletes it.

## 4b. Remeasure — only when the user asks for a before/after

Not part of the default run. `git diff` already shows what changed, and the
patches were approved one at a time in step 4a, so a second scoring pass adds
numbers nobody asked for.

If the user does ask what the fixes did to the grades, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" remeasure`. It prints the **full**
report, not the short one — a before/after is a detail question by definition, so
it answers at that level. It re-scans and reuses
every cached judgment whose rule is unchanged; a reworded rule has a new content
hash, so `remeasure` prints those rules as a `judge` worklist instead of a
report. Judge only those, exactly as in step 2, **merge** them into
`.assay-tmp/judgments.json` without disturbing the existing entries, and run
`remeasure` once more. Run it at most twice, then stop. Do not `clean` before
this — the cached judgments and the prior `audit.json` are what make the
before/after possible.

## 5. Clean up

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" clean
```

Always run this last, whether or not fixes were applied. It removes
`.assay-tmp/`, and the change journal too once every applied change has been
validated, rolled back, or retired. It exits 1 and keeps the journal when one is
still open — a journal holds the only copy of a pre-image, so it is never
deleted while a write is unresolved. That exit is a prompt, not a failure of the
audit: name the open changes it listed, and offer to validate or roll each one
back. Parked plans survive either way.

Then write the final message: whatever step 3 did not already show, your three
sentences, and what step 4a changed.
