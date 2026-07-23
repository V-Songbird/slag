---
name: craft-rules
description: >-
  Interviews you about the behavior you want enforced, then writes one rule
  into CLAUDE.md or a scoped .claude/rules/<topic>.md — firing trigger,
  directive verb, named alternative, concrete specifics — and verifies the
  result with the same engine /assay:audit grades with. Use when the user wants
  a rule written or made to stick — e.g. "add a rule", "write a CLAUDE.md rule
  for X", "make Claude always do X", "Claude keeps ignoring my instructions",
  "help me write a rule" — or invokes /assay:craft-rules. Do NOT use to grade
  or rewrite existing rules — that is /assay:audit — and not for skill
  descriptions — that is /assay:craft-skill.
argument-hint: "[what the rule should enforce]"
allowed-tools: Bash, Read, Write, Edit, Glob, AskUserQuestion, WebFetch
---

# assay:craft-rules

You write one rule per run. The wording and placement are the product: follow
[references/recipe.md](references/recipe.md) exactly — it encodes the same
factors `/assay:audit` grades. `$ARGUMENTS`, if present, describes what the
rule should enforce.

## 1. Grill

Collect, from the conversation or at most two `AskUserQuestion` rounds. Don't
ask for what the user already said; only fill real gaps.

- The behavior: what Claude must do or stop doing, ideally with one example
  of it going wrong.
- The firing moment: which action, file, or phase should make Claude notice
  the rule applies.
- For prohibitions: what replaces the banned action — and when nothing does,
  the escape hatch.
- Scope: the whole project, or bound to specific file types or paths.
- The specifics that make compliance checkable: exact paths, identifiers,
  thresholds.
- Stakes: preference, standing mandate, or must-never-be-violated.

Push back on vague answers. "Write clean code" is a wish, not a rule — ask
what a violation looks like and write the rule against that.

## 2. Redirect what isn't a rule

Check the ask against the recipe's "not a rule" table before writing:

- Mechanically checkable → say a hook enforces it better, and offer to build
  it from the live docs (`https://code.claude.com/docs/en/hooks.md`). Build
  only if accepted; otherwise write the rule as a stopgap and say so.
- A procedure or follow-the-doc duty → suggest `/assay:craft-skill` instead.
- Must-never-be-violated → say plainly that only a hook guarantees; a rule is
  probabilistic on every model size.

## 3. Write

Compose the rule per the recipe's anatomy — one bullet, under ~30 words —
and place it per the recipe's placement table. For a scoped rules file,
verify the `paths:` glob matches at least one real file with `Glob` before
writing it. New rules land in the top quarter of `CLAUDE.md`, never appended
to the bottom of a long file.

## 4. Verify with the engine

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" scan
```

Find the new rule by its exact text in `.assay-tmp/scan.json`:

- Not extracted at all → it reads as prose, not a rule; reword and rescan.
- `F2` flags `stallRisk` → the prohibition lost its alternative; restore it.
- `F7` below 0.5 → too abstract; add the path, identifier, or threshold from
  step 1.

Then run `clean`. Never present the factor numbers to the user — they are
your check, not the deliverable.

## 5. Close

Report in a few lines: the rule as written, where it landed, and any redirect
you offered. Remind the user to review with `git diff`. One pass, then done;
no follow-up menus.
