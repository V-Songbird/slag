---
name: craft-rules
description: >-
  Interviews you about the behavior you want enforced, then writes one rule into
  the instruction file Claude Code actually loads — `CLAUDE.md` or a scoped
  `.claude/rules/<topic>.md` — after checking the draft against the rules already
  active, and applies it as a reviewed, reversible change. Use when the user
  wants a rule written or made to stick — e.g. "add a rule", "write a CLAUDE.md
  rule for X", "make Claude always do X", "Claude keeps ignoring my
  instructions", "help me write a rule" — or invokes /assay:craft-rules. Do NOT
  use to grade or rewrite existing rules — that is /assay:claude — and not for
  skill descriptions — that is /assay:craft-skill.
argument-hint: "[what the rule should enforce]"
allowed-tools: Bash, Read, Write, Glob, AskUserQuestion, WebFetch
---

# assay:craft-rules

You write one rule per run. The wording and placement are the product: follow
[references/recipe.md](references/recipe.md) exactly — it encodes the same
factors `/assay:claude` grades. `$ARGUMENTS`, if present, describes what the
rule should enforce.

You never write a policy file yourself. Every write goes through the engine's
change transaction in step 5 — `plan`, `apply`, `validate` — so the rule is
previewed before it lands and reversible after.

## 1. Read the project

Before the interview, from the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" scan
```

If `node` is not on PATH (fnm/nvm setups), register it the way the project's
CLAUDE.md says to, then rerun.

Then read `.assay-tmp/scan.json`. It is the only place you learn where a rule can
go; never assume a filename:

- `profile.targets.rule.places[]` — every file a new rule may be written into,
  each with its `scope` and a `scoping` sentence saying what it reaches. This is
  your placement menu in step 4.
- `sources[]` and `files[]` — what already exists, with `selected` and `loaded`.
  A source with `selected: false` is shadowed and never read; writing into it
  would be writing nowhere.
- `rules[]` — the ACTIVE corpus: every rule loaded here, with its exact `text`,
  `file`, and `lineStart`. Step 3 checks your draft against this list.

## 2. Grill

Collect, from the conversation or at most two `AskUserQuestion` rounds. Don't
ask for what the user already said; only fill real gaps.

- The behavior: what the agent must do or stop doing, ideally with one example
  of it going wrong.
- The firing moment: which action, file, or phase should make the agent notice
  the rule applies.
- For prohibitions: what replaces the banned action — and when nothing does,
  the escape hatch.
- Scope: the whole project, or bound to specific file types, paths, or one
  subdirectory.
- The specifics that make compliance checkable: exact paths, identifiers,
  thresholds.
- Stakes: preference, standing mandate, or must-never-be-violated.

Spend the limited rounds in order of what they void. Ask first about the answers
that decide where the rule lives or which primitive owns it — scope, stakes,
whether a command could check it instead — before wording-level specifics: a
wrong answer of the first kind voids the draft, a missing specific only weakens
it. This orders the real gaps; it never licenses re-asking what the user already
said.

Push back on vague answers. "Write clean code" is a wish, not a rule — ask
what a violation looks like and write the rule against that. A wish with no
actionable trigger and no actionable action is **not written**: name it a wish,
say what is missing, and stop there.

Keep the author's intent exactly. You clarify and tighten wording; you never
strengthen a preference into a mandate, and never add a duty nobody asked for.
If the user's words were "prefer", the rule says prefer unless they tell you
otherwise.

## 3. Redirect what isn't a rule, then check the corpus

Check the ask against the recipe's "not a rule" table before writing:

- Mechanically checkable → say a hook enforces it better, and offer to build it
  from the live docs at `profile.targets.hook.docs`. Build only if accepted —
  through step 5 like everything else; otherwise write the rule as a stopgap
  and say so.
- A procedure or follow-the-doc duty → suggest `/assay:craft-skill` instead.
- Must-never-be-violated → say plainly that only a hook guarantees; a rule is
  probabilistic on every model size.

Then compose the draft bullet per the recipe's anatomy and check it against
`rules[]` — the active corpus — before you offer to write it:

- **Conflict.** Does an active rule require the opposite behavior — same
  subject, same action, opposite polarity? If so, **stop**. Show both rules with
  their file and line, say plainly that the draft bans what an active rule
  commands (or the reverse), and ask which policy the user actually means.
  Do not write, do not merge them, and do not pick a winner: assay identifies
  incompatibility and the developer resolves intent. Once they answer, the
  resolution is theirs to state — a change to the existing rule is
  `/assay:claude`'s rewrite path, not something you do quietly here.
- **Duplicate.** Does an active rule already state this duty, in these words or
  other ones? Say so, quote it with its file and line, and ask whether they want
  the existing one reworded instead. A second copy of a rule is corpus noise,
  not enforcement.
- Neither → continue.

This is the reading you can do before anything is written. The engine's own
conflict and duplicate detectors run over the corpus **after** the write, in
step 6 — treat that as the backstop, and roll back if it finds a pair you
missed.

## 4. Choose the target

Pick one entry from `profile.targets.rule.places[]` using its `scoping`
sentence and the scope answer from step 2 — never from a remembered filename.

- A rule bound to file types or paths goes to a scoped target where the host
  has one; verify the glob matches at least one real file with `Glob` first.
- A universal rule goes to the always-loaded target, near the top.
- A rule that should reach only work inside one subdirectory goes to that
  directory's own file — and say plainly what that narrows it to.
- Never write into a source the record marks `selected: false`, and never past a
  `truncatedAtLine` — the host stops reading there.

If the record carries no `profile.targets`, stop: say the profile declares no
supported write target and that you will not guess a filename.

## 5. Write through the transaction

Mutation is one explicit transaction and the engine owns every mechanical part
of it — the fingerprints, the exact patch, the staleness check, the journal and
the rollback state. You own the wording and the approval. Never write or edit a
policy file directly; an edit behind the transaction's back leaves the journal
blind and nothing is reversible.

1. **Assemble the draft.** Write one `.assay-tmp/draft-plan.json` holding a
   single change:

   ```json
   {
     "changes": [{
       "id": "add-prettier-rule",
       "kind": "rule-rewrite",
       "rationale": "A pre-commit formatting duty with a named firing moment.",
       "patches": [{
         "path": "<the target you picked in step 4>",
         "old": "## Conventions",
         "new": "## Conventions\n\n- Before committing, run `npx prettier --write .` over every staged file."
       }],
       "predicted": "the rule loads for every session in this project",
       "limitations": ["wording and placement only — compliance is not measured here"]
     }]
   }
   ```

   - adding a bullet to a file that already exists → `old` is the **exact**
     current text of the line you are inserting after, with enough context that
     it appears exactly once, and `new` is that same text plus your bullet;
   - creating a new instruction file → `"old": null` and the whole file body in
     `new`. `plan` refuses if the file already exists.

   `id` is yours, stable and unique in the plan; it is what the user approves and
   what every later command names. Match by text, never by line number, and state
   no source hash yourself — `plan` fingerprints every affected file.

2. **Plan it.**

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" plan --from .assay-tmp/draft-plan.json
   ```

   Exit 1 means the draft was rejected — an anchor not in the file, an anchor
   that matches twice, a path escaping the project. Fix what the message names
   and rerun. Never route around a rejection by editing the file yourself.

3. **Preview from the plan artifact**, not from your draft: read
   `.assay/plan-<id>.json` and show the user the change id, the target path, why
   that placement fits, and the exact `old` → `new` text. The plan is what will
   be applied, so it is what they get to see.

4. **Apply only on an explicit yes**, naming the id:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" apply --change <id>
   ```

   The id is the approval boundary; there is no apply-everything default. A
   stale file exits 1 naming both fingerprints and writes nothing — re-plan
   rather than forcing it. A write whose result does not parse is restored
   automatically.

## 6. Verify with the engine

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" validate --change <id>
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" scan
```

`validate` re-parses what was written and re-runs the static analysis, recording
the finding delta. Then find the new rule by its exact text in
`.assay-tmp/scan.json` and check it:

- Not in `rules[]` at all → it reads as prose, not a rule. Its file marked
  `selected: false`, or its line past `truncatedAtLine` → the host will not read
  it where it landed. Either one is a roll back and redraft. A `conflicting` or
  `duplicate` finding naming it → step 3 missed a pair; roll back and take it to
  the user.
- `factors.F2` flagging `stallRisk` → the prohibition lost its alternative;
  restore it. `factors.F7` below 0.5 → too abstract; add the path, identifier, or
  threshold from step 2.

Rollback is available for as long as the journal exists, and you offer it
whenever a check above fails or the user dislikes the result:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" rollback --change <id>
```

Never present factor numbers to the user — they are your check, not the
deliverable.

## 7. Close

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" clean
```

Run it last. Exit 1 means a change is still open — name it and offer to
validate or roll it back. Then report in a few lines: the rule as written, which
target it landed in and what that target reaches, any conflict or duplicate you
surfaced, and any redirect you offered. Remind the user that `git diff` shows
the change and that `rollback --change <id>` undoes it. One pass, then done; no
follow-up menus.
