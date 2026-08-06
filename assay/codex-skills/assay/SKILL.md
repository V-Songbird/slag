---
name: assay
description: >-
  Audits the instruction system Codex loads for a project — the AGENTS.md chain
  it actually reads, the .agents/skills it lists with their agents/openai.yaml
  metadata, and the hooks wired around them — and reports what never takes
  effect, with reviewable fixes: a file shadowed further up the chain, a file
  the host stops reading at its size limit, a rule pointing at a path that no
  longer exists, two rules that contradict each other, a skill description too
  long to survive the listing budget. Use when the user wants their instruction
  files checked — "audit my AGENTS.md", "check my instruction files", "what
  does Codex actually load here", "which AGENTS.md files get ignored", "audit
  the skills" — or invokes $assay. Do not use to review source code, pull
  requests, or configuration unrelated to agent instructions.
---

# assay

The engine ships with this skill: from the directory holding this SKILL.md, it
is `../../scripts/assay.js`. Resolve that to an absolute path once and use it
in every command below. If `node` is not on PATH, activate it the way the
project's own setup notes say to, then rerun.

Every engine call that reads or writes the project's instruction files carries
`--host codex` — `scan`, `report`, `plan`, `apply`, `validate`. The profile
decides which files are sources, which analyses apply, and what `validate`
checks, so never drop it partway through. `rollback` and `clean` work off the
journal and take no host.

Flags the user's request may carry: `--startup <path>` (audit a session that
begins in a subdirectory — the chain runs from the project root down to where
the session starts; pass it to `scan`, which fixes it in the saved context
every later command reads),
`--fix` (apply repairs without the menu), `--verbose` (the full report),
`--json` (the machine-readable record), `--no-verify` (skip the second pass in
step 2), `--deterministic` (skip every model step), `--semantic` (also propose
duplicates and conflicts the script cannot see), `--project-only` (skip the
user's own instruction files).

**What this profile does not do.** There is no letter grade and no wording
score here: those weights carry no evidence for this host. Skills are checked
against the metadata this host documents as required — `name`, `description`,
the `agents/openai.yaml` sidecar, duplicate names, the collective listing
budget. Say that plainly rather than implying anything here was scored, and
never present a finding as a prediction that any instruction will be obeyed.

## 1. Scan

From the project root:

```
node <engine> scan --host codex
```

The output JSON has a `judge` list — every rule needing your judgment — and
writes full data to `.assay-tmp/scan.json`.

If `ruleCount` and `skillCount` are both 0, tell the user nothing was found and
stop. If only `ruleCount` is 0, write `{}` to `.assay-tmp/judgments.json`, skip
step 2, and continue.

Under `--deterministic`, go straight to step 3 and write no judgments file at
all. The engine has no such flag and never needs one — the absence of
`.assay-tmp/judgments.json` *is* the mode, and the report lands complete,
labelled `deterministic only`, with the model-judged checks named as not run.

Read `.assay-tmp/scan.json` before you say anything about this host. It is the
only place you learn host facts: `sources[]` says which files are selected and
which are shadowed, `profile.targets` says where a new rule, skill or hook may
be written, and `profile.nouns` gives the words this profile's advice uses for
its own mechanisms. Never assume a filename or a primitive from the host's
name.

## 2. Judge, then verify

Read `../../references/rubrics.md` (relative to this file), then score every
rule in the `judge` list on both factors:

- **F3 — trigger-action distance**: will the agent recognize the moment this
  rule fires? 0.95 immediate → 0.05 no trigger at all.
- **F8 — enforceability ceiling**: could a hook or linter enforce this better
  than prose? 0.90 judgment-only → 0.15 fully mechanical.

These feed the placement findings — which rules a mechanism would own better —
and nothing else on this profile: they sum to no grade here. Score every rule
in one continuous pass, and where a rule has `needsF1: true` add an `F1` value
too.

Write the result to `.assay-tmp/judgments.json`, keyed by each rule's `key`
from the `judge` list — the stable content hash, not the `R###` display id —
plus one `_provenance` key beside them:

```json
{
  "a1b2c3d4e5f6": { "F3": 0.75, "F8": 0.9 },
  "_provenance": { "model": "<your model>", "promptVersion": "2", "judgedAt": "2026-07-28T09:41:00Z", "pass": "F3/F8" }
}
```

`model` is the model you are running as — a plain name, never a version you are
unsure of. `promptVersion` is the number on the `Rubric version:` line at the
top of the rubrics file, as a string. `judgedAt` is the current time in ISO
8601, and `pass` is `"F3/F8"` now, `"F3/F8+verify"` once the check below has
run.

**Verify what is a rule at all.** Run this by default; `--no-verify` and
`--deterministic` skip it. Extraction cannot tell a directive from a
retrospective, so a notes file can arrive graded as a page of mandates.

After every score is written, make a second, separate pass over the entries
whose text you doubt is a rule at all, asking exactly one question of each: is
this an instruction to follow, or is it narration, history, an example, or a
description of what the project does? For each entry that is not an
instruction, add a `notRule` key to that rule's object holding a one-sentence
reason, and set `_provenance.pass` to `"F3/F8+verify"`:

```json
{ "9f8e7d6c5b4a": { "F3": 0.45, "F8": 0.15, "notRule": "Records what the team decided last quarter; it asks for nothing." } }
```

Keep the two passes separate — never revisit an `F3` or `F8` while answering
the is-this-a-rule question, and never reword a rule. Dropping an entry is all
this pass may do; a dropped entry still counts in its file's coverage and never
leaves the inventory. The report simply regroups it.

**Under `--semantic`**, also collect the duplicates and conflicts the script
cannot see — two rules stating one duty in unrelated words, or two that only
collide once you know what each is for — into a `_candidates` key beside
`_provenance`:

```json
{ "_candidates": [
  { "kind": "paraphrase-duplicate", "keys": ["a1b2c3d4e5f6", "9f8e7d6c5b4a"], "summary": "Both require input validation at the API edge.", "reason": "Different words, one duty.", "accepted": null }
] }
```

`kind` is `paraphrase-duplicate` or `indirect-conflict` — the two kinds this
pass proposes; a kind the engine does not recognize fails the run. `accepted`
is always `null` here — it is the user's answer, not yours. Propose only what you would defend, and without the flag write no
`_candidates` key at all.

## 3. Report

```
node <engine> report --host codex
```

Bare, this prints the short report: what was looked at, **Fix these first**,
**Could be automatic instead**, **Also worth a look**, and one closing line. It
names each rule **once**, under its worst problem. `--json` prints the record
instead; **`--verbose`** prints the full report — the resolved instruction
chain with its byte totals, coverage, every finding with its evidence tag, the
enforcement ladder, and everything the verify pass suppressed.

Print the markdown **verbatim**. Every location is a clickable
`[path:line](path:line)` link, so do not reword a cell, rebuild a table, or
replace a link with a bare line number, and do not summarize it — it is
already the summary. One exception: the scan's `hookInventory` is yours to work
from and never printed. Use it on the hook-candidate list only, and where a
candidate is plainly covered by a wired hook, say so and drop it from the
counts in step 4.

Use the words in `profile.nouns` for this host's mechanisms. A conflict names
both rules and neither winner: say which two disagree and ask which one they
meant. Anything you proposed under `--semantic` prints as a proposal — ask
about each one in the same message and record the answer back into
`_candidates[].accepted` before you clean up.

Then add at most 2 sentences of your own: the single most valuable fix, and
anything project-specific the report cannot see. A finding says a file is
configured a certain way, never that any instruction was obeyed.

## 4. Offer fixes

Skip to step 6 when the report has nothing repairable. Under `--fix`, skip the
question instead: put every repair into one batch named `fix-batch` in the
draft plan and apply that batch by name.

Otherwise ask the user one question, listing only the options that have
evidence, and let them pick any combination:

- **Repair N dead references** — repoint each rule that cites a path no longer
  in the repository; they approve each patch and every write is reversible.
- **Fix N skill metadata problems** — add the fields this host documents as
  required, or shorten a description past the listing budget.
- **Promote N candidates now** — preview each mechanism built from the live
  official docs, and install the ones they approve; the rules stay active.
- **Park N placement candidates** — record a deferred plan for each; nothing
  is written to the rules.

If both promote and park are chosen, promotion wins and parking covers the
remainder. Everything chosen goes into ONE draft plan.

## 5. Plan, preview, apply, validate

Mutation is one explicit transaction, and the engine owns every mechanical part
of it: the fingerprints, the exact patch, the staleness check, the journal and
the rollback state. You own the wording and the approval. Never hand-edit a
file this flow is going to write.

**Assemble one `.assay-tmp/draft-plan.json`.** Each approved fix is one change:

```json
{
  "changes": [{
    "id": "repoint-release-doc",
    "kind": "stale-reference-repair",
    "rationale": "The rule cites `docs/release.md`, which moved to `docs/ship.md`.",
    "patches": [{
      "path": "AGENTS.md",
      "old": "- Follow `docs/release.md` before tagging.",
      "new": "- Follow `docs/ship.md` before tagging."
    }],
    "predicted": "resolves the stale-reference finding on this rule",
    "limitations": ["the path is repointed; nothing verifies the doc still says what the rule assumes"]
  }],
  "batches": { "fix-batch": ["repoint-release-doc"] }
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

**What each kind carries here:**

- **Stale reference** → `stale-reference-repair`. "likely moved to `X`"
  repoints to `X`, keeping the sentence intact. Several matches means pick the
  one the rule meant, asking only when it is genuinely ambiguous. "No file by
  that name" means delete the reference or repoint it at the current source of
  truth. Only ever point at a file you have confirmed exists; never invent a
  path.
- **Skill metadata** → `rule-rewrite` whose `old` is the exact current
  frontmatter block or sidecar body. Fill every field in
  `profile.targets.skill.requires[]`, write the files named in
  `profile.targets.skill.metadata[]` as the YAML this host documents, and where
  `coverage.skillBudget` exists keep the name and description short — they are
  spent from a shared listing budget before any skill is selected.
- **Rule wording** → `rule-rewrite` only where the finding is availability or
  structure, not style. A prohibition with no alternative can stall a task, so
  restoring the escape hatch is fair game; polishing verbs against weights this
  profile never had is not.
- **Promotion** → `placement-promotion` carrying `mechanism` and `provenance` —
  a non-empty list of `{ "claim": "<what the page documents>", "url": "<the
  page>" }` entries. Both are required, and `plan` rejects a provenance entry
  missing either field. Read the target from `profile.targets`, fetch that
  primitive's `docs` page live — never a remembered format — and park the
  candidate instead if the page cannot be reached. **The source rule stays
  exactly where it is**: no kind deletes or deactivates prose.
- **Park** → `park` with `"patches": []` and nothing written. The promotion
  note goes in `rationale` and the doc URL in `limitations`. `apply` refuses a
  park by design and `clean` never deletes a plan artifact: the plan file
  **is** the park record.

**Then run the transaction**, `--host codex` on every command:

1. `plan --from .assay-tmp/draft-plan.json --host codex`. Exit 1 means the
   draft was rejected — an anchor that is not in the file, an anchor that
   matches twice, a promotion with no provenance. Fix what the message names
   and rerun; never route around a rejection by editing the file yourself.
2. **Preview from the plan artifact, not from your draft.** Read
   `.assay/plan-<id>.json` and show the user each change id, the target path,
   why that mechanism fits, and the exact `old` → `new` text.
3. **Collect approval per change**, then `apply --change <id> --host codex`
   with exactly the ids approved — or `apply --batch fix-batch --host codex`
   under `--fix`. There is no apply-everything default. A stale file exits 1
   naming both fingerprints and writes nothing; re-plan rather than forcing
   it. A write whose result does not parse is restored and exits 1.
4. `validate --change <id> --host codex` per applied change. It re-parses what
   was written, re-runs the static analysis under this profile, and for a
   promotion checks that the profile actually discovers the mechanism. It
   reports `configured` and nothing above: a file on disk is not evidence that
   anything ran.
5. **Say what is now true**, and that `git diff` shows every change. Rollback
   stays available for as long as the journal exists:
   `rollback --change <id>`. Offer it whenever a validation fails or the user
   dislikes the result.

## 6. Clean up

```
node <engine> clean
```

Always run this last, whether or not fixes were applied. It removes
`.assay-tmp/`, and the change journal too once every applied change has been
validated or rolled back. It exits 1 and keeps the journal when one is still
open — a journal holds the only copy of a pre-image, so it is never deleted
while a write is unresolved. That exit is a prompt, not a failure: name the
open changes it listed, and offer to validate or roll each one back. Parked
plans survive either way.

Then close with whatever step 3 did not already show, your two sentences, and
what step 5 changed.
