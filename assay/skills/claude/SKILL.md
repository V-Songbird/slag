---
name: claude
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
  be hooks" — or invokes /assay:claude with any flags. Do NOT use to review code,
  PRs, non-Claude config like eslint, or the AGENTS.md chain — auditing that is
  /assay:codex.
argument-hint: "[--fix] [--verbose] [--json] [--no-verify] [--deterministic] [--semantic] [--artifact] [--project-only]"
allowed-tools: Bash, Read, Write, Edit, Glob, AskUserQuestion, WebFetch, Agent, Artifact
---

# assay:claude

The script measures everything mechanical; you judge two factors and present the
result. Never re-derive by hand what the script already computed.

Flags in `$ARGUMENTS`: `--fix` (apply rewrites without the menu), `--verbose`
(the full report), `--json` (the machine-readable record), `--no-verify` (skip
the subagent in step 2, which otherwise runs), `--deterministic` (skip every
model step and report what the script alone can see), `--semantic` (also propose
paraphrased duplicates and indirect conflicts the script cannot see),
`--project-only` (skip the user's own instruction files), `--artifact` (also
publish the full report as an HTML page).

## 1. Scan

From the project root — pass `--project-only` through if `$ARGUMENTS` has it, to
this step and to every later `assay.js` call:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" scan
```

If `node` is not on PATH (fnm/nvm setups), register it the way the project's
CLAUDE.md says to, then rerun. The output JSON has a `judge` list — every rule
needing your judgment — and writes full data to `.assay-tmp/scan.json`. The scan
also grades every `.claude/skills/*/SKILL.md` description against the trigger
recipe; those need no judgment.

If `ruleCount` and `skillCount` are both 0, tell the user nothing was found and
stop. If only `ruleCount` is 0, write `{}` to `.assay-tmp/judgments.json`, skip
step 2, and continue.

Under `--deterministic`, go straight to step 3 and write no judgments file at
all. The engine has no such flag and never needs one — the absence of
`.assay-tmp/judgments.json` *is* the mode, and the report lands complete,
labelled `deterministic only`, with the model-judged checks named as not run.

A `judge` entry can include `context` when a heading or following clarification
is needed to interpret the rule. Judge the rule with that context, but keep
`text` as the exact source wording — report links and rewrites target that text.

## 2. Judge F3 and F8, then verify

Read [references/rubrics.md](references/rubrics.md), then score every rule in the
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
whose text you doubt is a rule at all, its `key` and text each. Ask for exactly
one verdict per entry: is this an instruction to follow, or is it narration,
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

`kind` is `paraphrase-duplicate` or `indirect-conflict`, and any other kind fails
the run. `keys` names the rules involved. `summary` and `reason` are one sentence
each, in your own words. `accepted` is always `null` here — it is the user's
answer, not yours. Propose only what you would defend, and without the flag write
no `_candidates` key at all.

## 3. Report

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" report
```

Bare, this prints the **short report** — the default, and what the user reads:
what was looked at, **Fix these first**, **Could be automatic instead**, **Also
worth a look**, and one closing line. It names each rule **once**, under its
worst problem, and carries no score, factor code or evidence tag. That is gated:
a release test fails if it runs past 40 lines, repeats a rule, or uses a word
that needs Claude Code internals.

Add a flag only when `$ARGUMENTS` carried it. `--json` prints the record instead.
**`--verbose` prints the full report** — coverage, hard gates, every finding with
its evidence tag, the enforcement ladder, per-file grades, User scope, weak
descriptions, and everything the verify pass suppressed. Pass it when the user
asks for detail, asks about one finding, or wants the grades; nothing is missing
from the short report that is not in this one. Under `--artifact`, also run
`assay.js artifact`, publish the `.assay-tmp/report.html` it writes with the
`Artifact` tool, and give the reader the returned URL.

The report is this skill's deliverable. Print its markdown **verbatim** — every
location is a clickable `[path:line](path:line)` link, so do not reword a cell,
rebuild a table, or replace a link with a bare line number. Do not summarize it
either; it is already the summary. One exception: the scan's `hookInventory` is
yours to work from and never printed. Use it on the hook-candidate list only:
where a candidate is plainly covered by a wired hook (same trigger, same action),
say so beside the entry and drop it from the counts in step 4.

A conflict names both rules and neither winner. Do not resolve it: say which two
disagree, and ask which one they meant. Anything you proposed under `--semantic`
prints as a proposal — ask about each one in the same message and record the
answer back into `_candidates[].accepted` before you clean up. An accepted
proposal never changes a rule's state, its score, or the grade.

Then add at most 2 sentences of your own: the single most valuable fix, and
anything project-specific the report cannot see. Never present a grade as a
prediction that Claude will or won't follow a rule — it measures how the rule is
written, scoped, and placed. If the command errors about judgments, fix
`.assay-tmp/judgments.json` and rerun.

If this run cannot put text in front of the user ahead of a tool call, **skip
step 4**, go to step 6, and make the report the final message: a menu with no
report behind it asks the user to choose blind.

## 4. Offer fixes

Skip to step 6 when the report has no weak rules, no weak descriptions and no
placement candidates. Under `--fix`, skip the question instead: put every rewrite
into one batch named `fix-batch` in the draft plan and apply that batch by name,
which is what keeps `--fix` a recorded approval rather than an implicit one.

Otherwise ask ONE question with `AskUserQuestion` (`multiSelect: true`, header
`"Fix menu"`), including only the options that have evidence:

- `Rewrite [N] weak rules` — "Rewrite the rules below their quality floor; you
  approve each patch and every write is reversible." N counts rules whose problem
  is **wording**. The short report's "N rules need work" also counts dead
  references, which a rewrite does not fix — take the wording count from the rows
  whose problem is a wording one, or from `--verbose`'s Weak rules table.
- `Rewrite [N] weak skill descriptions` — "Rewrite each skill's frontmatter
  description to the trigger recipe; you approve each patch." Count weak subagent
  descriptions here too: same recipe, same patch shape, different file.
- `Promote [N] candidates now` — "Preview each hook, skill, or subagent built
  from the live official docs, and install the ones you approve; the rules stay
  active."
- `Park [N] placement candidates` — "Record a deferred plan for each; nothing is
  written to the rules and the plan artifact keeps the promotion notes."

If both promote and park are checked, promotion wins and parking covers the
remainder. Everything checked goes into ONE draft plan.

## 5. Plan, preview, apply, validate

Mutation is one explicit transaction, and the engine owns every mechanical part
of it: the fingerprints, the exact patch, the staleness check, the journal, the
rollback state, and the retirement gate. You own the wording and the approval.
Never hand-edit a file this flow is going to write — an `Edit` behind the
transaction's back leaves the plan stale and the journal blind.

**Assemble one `.assay-tmp/draft-plan.json`.** Each approved fix is one change:

```json
{
  "changes": [{
    "id": "rewrite-prettier",
    "kind": "rule-rewrite",
    "rationale": "The rule names no firing moment, so the duty gets skipped.",
    "addresses": "<the rule's `key` from the scan, if you have it>",
    "patches": [{
      "path": "CLAUDE.md",
      "old": "- Run prettier before committing.",
      "new": "- Before committing, run `npx prettier --write .` over every staged file."
    }],
    "predicted": "resolves the trigger-distance finding on this rule",
    "limitations": ["wording only — compliance is not measured here"]
  }],
  "batches": { "fix-batch": ["rewrite-prettier"] }
}
```

- `id` — yours, stable and unique in the plan. It is what the user approves and
  what every later command names.
- `kind` — `rule-rewrite`, `stale-reference-repair`, `placement-promotion`, or
  `park`.
- `patches[].old` — the **exact** current text, with enough surrounding context
  to appear exactly once. Match by text, never by line number. `"old": null`
  creates a file, and `plan` refuses if that file already exists.
- Never state a source hash yourself — `plan` fingerprints every affected file.
- `batches` — only under `--fix`.

**What each kind carries:**

- **Weak rule** → `rule-rewrite` on its dominant weakness: one bullet under ~30
  words with a concrete trigger (WHEN), an explicit action (WHAT), and the
  specifics needed to comply. F1 → open with the directive and drop "try to" or
  "where possible" unless the rule truly is optional. F2 → pair the prohibition
  with its alternative, or name the escape hatch when nothing replaces the banned
  action. F3 → name the firing moment ("Before committing…"); distant duties like
  changelog sync need this most. F4 → move it to a `.claude/rules/<topic>.md`
  with `paths:` frontmatter, as two patches in one change, after confirming with
  `Glob` that the glob matches a real file. F5 → move it into the top quarter of
  its file, text unchanged. F7 → replace abstract adjectives with a path, an
  identifier in backticks, or a numeric threshold. Keep the author's intent
  exactly: you are re-phrasing, not re-deciding, and a changed meaning is the one
  thing no check catches. Never merge two rules. A file whose problem is its
  shape lands under **Restructure candidates** and is reshaped by hand — this
  pass never rewrites a whole file.
- **Weak skill or subagent description** → `rule-rewrite` whose `old` is the
  exact current frontmatter block. Read
  `${CLAUDE_PLUGIN_ROOT}/skills/craft-skill/references/recipe.md` first and edit
  only the frontmatter, never the body. A model-invocable one gets the recipe's
  three parts folded into `description` — a concrete base sentence naming real
  artifacts, a "Use when…" clause, a "Do NOT use when…" exclusion — with any
  `when_to_use` merged in and that field deleted. Rephrase in place and come out
  **no longer than you started**, under 1,536 characters: past the cap the tail
  truncates in the listing and the exclusion is the first thing lost. Keep the
  base sentence terse — enumerating a domain's whole surface measurably lowers
  firing, and shortening it is the highest-value edit here. Quoted phrasings are
  optional, and ones that miss the real ask narrow the router: rewrite or delete
  those rather than inventing more. A `disable-model-invocation` skill inverts —
  trim it to one short plain sentence and delete the trigger machinery, because
  nothing routes on it. A skill neither side can invoke is reported, never
  edited.
- **Stale reference** → `stale-reference-repair`. "likely moved to `X`" repoints
  to `X`, keeping the sentence intact. Several matches means pick the one the
  rule meant, asking only when it is genuinely ambiguous. "No file by that name"
  means delete the reference or repoint it at the current source of truth. Only
  ever point at a file you have confirmed exists; never invent a path.
- **Promotion** → `placement-promotion` carrying `mechanism`
  (`{ "type": "skill", "name": "<name>" }`) and `provenance` (the doc URL and the
  date you fetched it). Both are required; a plan without them is rejected. Fetch
  the format live with `WebFetch`, once per primitive per run, from
  `https://code.claude.com/docs/en/hooks.md` (with `hooks-guide.md`),
  `https://code.claude.com/docs/en/skills.md`, or
  `https://code.claude.com/docs/en/sub-agents.md` — never a remembered format,
  and park the candidate instead if a fetch fails. A hook wires its event in
  `.claude/settings.json` with any check script as a second patch in the same
  change; skip it when that file already wires the same event and matcher, and
  keep it to one hook per change or the second goes stale. A skill becomes
  `.claude/skills/<name>/SKILL.md` with the rule text as its first section and a
  description written to the recipe. A subagent becomes
  `.claude/agents/<name>.md` with the rule text as its prompt. Choose the level
  before the primitive: a hook covers exactly its matcher and nothing outside a
  session reaches it, so where the report's ladder already shows a repository or
  remote gate, say plainly that the stronger home exists rather than letting a
  hook read as the same guarantee. **The source rule stays exactly where it is**
  — no kind deletes or deactivates prose. Anything that failed gets parked, not
  retried, and a failed promotion already applied is rolled back first.
- **Park** → `park` with `"patches": []` and nothing written. The promotion note
  goes in `rationale`, naming the mechanism — which hook event fits and what its
  check must verify, the trigger phrase a skill should own, what a subagent
  audits and must return — with the evidence names and the doc URL in
  `limitations`. Split a compound candidate at its conjunction and park each half
  under its own primitive. `apply` refuses a park by design and `clean` never
  deletes a plan artifact: the plan file **is** the park record.

**Then run the transaction.**

1. `plan --from .assay-tmp/draft-plan.json`. Exit 1 means the draft was
   rejected — an anchor that is not in the file, an anchor that matches twice, a
   promotion with no provenance. Fix what the message names and rerun; never
   route around a rejection by editing the file yourself. It prints the plan id
   and every change id, and writes `.assay/plan-<id>.json`.
2. **Preview from the plan, not from your draft.** Read the plan artifact and
   show the user each change: its id, the target path, why that mechanism fits,
   and the exact `old` → `new` text. The plan is what will be applied, so it is
   what they get to see.
3. **Collect approval per change**, then `apply --change <id> --change <id>` with
   exactly the ids approved — or `apply --batch fix-batch` under `--fix`, where
   the batch is the boundary instead. There is no apply-everything default, and a
   change the user did not name is not applied even though the plan carries it. A
   stale file exits 1 naming both fingerprints and writes nothing; re-plan rather
   than forcing it. A write whose result does not parse is restored and exits 1.
4. `validate --change <id>` per applied change. It re-parses what was written,
   re-runs the static analysis and records the delta, and for a promotion checks
   that the host actually discovers the new mechanism. It reports `configured`
   and nothing above: a file on disk is not evidence that anything ran. assay
   never runs the repository's own tests, lint, or a fresh session — those are
   external evidence, recorded with `--external "repo tests: pass"` when the user
   reports one, and a measured record is linked with `--proof <pointer>`, never
   executed. A failure exits 1 and prints the rollback path; nothing is undone
   automatically at this stage.
5. **Say what is now true.** The rule is still active — a promotion added the
   mechanism beside the prose, a rewrite rephrased it in place. Tell the user the
   duty may now be stated twice on purpose, and that `git diff` shows every
   change.

Every command above is `node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" <command>`.
Every applied change stays reversible for as long as the journal exists, through
`rollback --change <id>`, including after an apply interrupted mid-write. Offer
it whenever a validation fails or the user dislikes the result.

Two commands are never a step here and run only when the user asks for them by
name. `retire --change <id>` deactivates the prose behind a promotion; say the
gate plainly — it refuses unless the journal already holds validation evidence
marking that change a success, it needs its own change id as its own approval,
and keeping the prose as documentation is a legitimate outcome. `remeasure`
answers "what did the fixes do to the grades" with the full report; it re-scans
and reuses every cached judgment whose rule is unchanged, and a reworded rule
comes back as a `judge` worklist instead of a report — judge only those, **merge**
them into `.assay-tmp/judgments.json` without disturbing the rest, and run it
once more. At most twice. Both read the journal and the cache, so run them before
step 6.

## 6. Clean up

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" clean
```

Always run this last, whether or not fixes were applied. It removes
`.assay-tmp/`, and the change journal too once every applied change has been
validated, rolled back, or retired. It exits 1 and keeps the journal when one is
still open — a journal holds the only copy of a pre-image, so it is never deleted
while a write is unresolved. That exit is a prompt, not a failure of the audit:
name the open changes it listed, and offer to validate or roll each one back.
Parked plans survive either way.

Then write the final message: whatever step 3 did not already show, your two
sentences, and what step 5 changed.
