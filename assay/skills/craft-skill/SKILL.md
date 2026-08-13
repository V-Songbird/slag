---
name: craft-skill
description: >-
  Builds one Claude Code skill — `.claude/skills/<name>/SKILL.md`, with the
  format fetched live from the official docs — and installs it as a reviewed,
  reversible change. Also refits an existing skill's description that never
  seems to fire. Use when the user wants a skill created or made to trigger
  reliably — e.g. "make me a skill", "create a skill for X", "my skill never
  fires", "Claude keeps ignoring my skill", "fix this skill description", "craft
  a skill" — or invokes /assay:craft-skill. Do NOT use for auditing CLAUDE.md
  rules — that is /assay:claude.
argument-hint: "[skill name or what it should do]"
allowed-tools: Bash, Read, Write, Glob, AskUserQuestion, WebFetch
---

# assay:craft-skill

You build one skill per run — new, or a refit of an existing one. `$ARGUMENTS`,
if present, names the skill or describes what it should do.

You never write a skill file yourself. Every artifact — the `SKILL.md`, any
metadata sidecar, a companion rule, a hook — goes through the engine's change
transaction in step 5, so each one is previewed before it lands and reversible
after.

## 1. Read the project

Before anything else, from the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" scan
```

If `node` is not on PATH (fnm/nvm setups), register it the way the project's
CLAUDE.md says to, then rerun.

Then read `.assay-tmp/scan.json`. Every fact below comes from it; never assume a
directory or a required field:

- `profile.targets.skill` — `dir` and `file` (where skills live), `requires[]`
  (the frontmatter documented as required), `metadata[]` (any invocation/UI
  sidecar), and `docs` (the page to fetch in step 2).
- `skills[]` — every project skill already discovered, with its `name`, `path`,
  and `checks`. This is where a refit target comes from, and where a name
  collision shows up.
- `coverage.skillBudget` — the collective listing budget, where one is published.
  Every skill's name and description spend from it before any skill is selected,
  so a long description costs the whole list.
- `profile.targets.hook.docs` — the hooks page, for step 4's ladder.

## 2. Scope, and ground the format

Decide new-vs-refit: it is a refit when the user pointed at a skill in
`skills[]`, or one there matches their words. Otherwise it is new.

Collect, from the conversation or one `AskUserQuestion` round at most. Don't
ask for what the user already said; only fill real gaps.

- What the skill does — enough to write a concrete base sentence naming real
  artifacts.
- Three or four ways the user would actually phrase the ask, in their words.
- The nearest adjacent ask the skill should NOT fire on.
- Whether the skill is bound to a file type or path (a candidate for a scoped
  companion rule).
- Which tools or commands the skill depends on.
- How critical firing is: nice-to-have, should-always-run, or
  must-never-be-skipped.

Then fetch `profile.targets.skill.docs` with `WebFetch` and follow the fetched
format exactly — frontmatter keys, directory layout, naming. Never build from a
remembered format. If the fetch fails, stop and tell the user to retry later; a
stale-format skill is worse than no skill. Keep the URL and what the page told
you: step 5 records that pair as the change's `provenance`.

## 3. Write the metadata

Every field in `profile.targets.skill.requires[]` must be present and non-empty.
Beyond that, the description is a router and the measured recipe applies: follow
[references/recipe.md](references/recipe.md) exactly — concrete base sentence,
"Use when…" trigger clause, "Do NOT use…" exclusion, under the listing cap. Read
the finished description once against the recipe's refit checklist before putting
it in the plan. On a refit, edit only the frontmatter description — never the
body's instructions beyond what the user asked. If the file still carries a
separate `when_to_use`, fold it into `description` and delete the field in the
same patch; the engine flags a model-invocable skill that keeps both.

**On a refit, keep the diagnosis.** The checklist tells you exactly which parts
were missing — no trigger clause, no exclusion, nothing concrete named, an
enumeration too long to route on. Write that down as you go: step 5 shows the old
description beside the new one, and step 7 says which of these was why it was not
firing. Working it out and never telling the user leaves them with a new
description and no idea what was wrong with the last one.

Where `coverage.skillBudget` exists, keep the name and description short: they
are spent from a shared listing budget before any skill is selected, and a long
description costs the whole list.

A name already in `skills[]` is a collision, not a version. Say so before
writing — both appear and neither wins.

## 4. Climb the ladder if asked

Only when step 2 said should-always-run or must-never-be-skipped. Description
routing is **probabilistic**, whatever the metadata says, so a must-run duty
needs something above it:

- **should-always-run** — add the companion rule from the recipe, placed per
  `profile.targets.rule.places[]` (the scoped target when the skill is
  file-bound and its glob matches at least one real file; the always-loaded
  target near the top otherwise). Check the drafted rule against `rules[]` for a
  conflict or a duplicate exactly as `/assay:craft-rules` step 3 does: a rule
  that contradicts an active one is surfaced with both texts and their lines,
  and is not written until the user resolves the policy question.
- **must-never-be-skipped** — say plainly that only a hook guarantees execution,
  and offer to build one per the live docs at `profile.targets.hook.docs`. Build
  it only if accepted, and only through step 5.

## 5. Write through the transaction

Mutation is one explicit transaction and the engine owns every mechanical part
of it. You own the wording and the approval. Never write or edit a skill,
sidecar, rule, or settings file directly.

1. **Assemble the draft.** One `.assay-tmp/draft-plan.json`, holding a `changes`
   array. Each change carries an `id` (yours, stable and unique in the plan — it
   is what the user approves and what every later command names), a `kind`, a
   one-sentence `rationale`, and a `patches` array of `{ path, old, new }`, where
   `old` is the **exact** current text with enough context to appear exactly
   once, or `null` to create a file:

   - the new skill is one `placement-promotion` change carrying
     `"mechanism": { "type": "skill", "name": "<name>" }` and one `provenance`
     entry per format claim, each `{ "claim": "<what the page documents>",
     "url": "<the page from step 2>" }` — `plan` rejects an entry missing
     either key, and never reads a date. Its
     `SKILL.md` and every metadata sidecar are **patches of that same change**,
     each with `"old": null`, so they land together or not at all;
   - a companion rule is a separate `rule-rewrite` change;
   - a hook is a separate `placement-promotion` with
     `"mechanism": { "type": "hook", … }` and its own provenance;
   - a refit is a `rule-rewrite` whose `old` is the exact current frontmatter
     block and whose `new` is the rewritten one.

   State no source hash yourself — `plan` fingerprints every affected file.

2. **Plan it.**

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" plan --from .assay-tmp/draft-plan.json
   ```

   Exit 1 means the draft was rejected — a file that already exists, a promotion
   with no provenance, an anchor that matches twice. Fix what the message names
   and rerun. Never route around a rejection by writing the file yourself.

3. **Preview from the plan artifact**, not from your draft: read
   the `planFile` path `plan` printed — `.assay/plan-<planId>.json`, named
   for the plan and not for a change id — and show the user each change id, every file it
   writes, why that mechanism fits, and the full text of each new file. Name the
   skill's declared tool dependencies here — they are what the skill will be
   allowed to reach, and the preview is the last point before that is true.

   **On a refit, show the old description above the new one**, both in full, with
   one line naming what the old one was missing. The user is being asked to
   approve a replacement for something they wrote; showing only the replacement
   asks them to approve it blind.

4. **Collect approval per change**, then apply exactly the approved ids:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" apply --change <id>
   ```

   The ids are the approval boundary; there is no apply-everything default. A
   write whose result does not parse — broken frontmatter, an unreadable
   sidecar — is restored automatically and exits 1.

## 6. Validate the files and the dependencies

Per applied change:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" validate --change <id>
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" scan
```

`validate` re-parses every file the change wrote (the `SKILL.md` frontmatter as
YAML, each sidecar as YAML), re-runs the static analysis, and — for a promotion
— asks whether the host profile actually discovers the mechanism. It reports
`configured` and nothing above it: a file on disk is not evidence that anything
ran.

Then check the fresh `.assay-tmp/scan.json` yourself:

- the skill is in `skills[]` under the name you gave it;
- `checks.missing` is empty, and `checks.redundant`, `checks.overCap` and
  `checks.hasWhenToUse` are all false — the last three ride beside `missing`,
  not in it, and `overCap` is the 1,536-char description cap;
- every file the `SKILL.md` body references exists (`Read` or `Glob` each one) —
  a skill pointing at a missing reference is blocked the first time it runs;
- where a metadata sidecar was written, `metadata` is present on the entry and
  `metadataIssue` is not — an issue there means the host cannot read it;
- where `coverage.skillBudget` exists, the listing total still fits it.

Any failure: roll back and fix, rather than patching over it.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" rollback --change <id>
```

## 7. Close

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" clean
```

Run it last. Exit 1 means a change is still open — name it and offer to validate
or roll it back. Then report in a few lines: what was built and where, that it
loads from the next session on, and — on a refit — **why the old description was
not firing**, in one sentence, from the diagnosis you kept in step 3, and the two invocation facts kept separate —
**explicit** invocation, where a session names the skill and it runs, and
**implicit** routing, where the description is matched and it may not. Say the
measured line plainly: description routing is probabilistic, and a duty that
must never be skipped needs the rule or the hook above it. Never
promise invocation. Remind the user that `git diff` shows every change and that
`rollback --change <id>` undoes it. One pass, then done; no follow-up menus.
