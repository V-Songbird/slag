# Applying fixes

Every fix that touches a file goes through the engine's change transaction, not
through `Edit`. You assemble one draft plan; `plan` fingerprints it, `apply`
writes only the change ids you name, `validate` checks the result, and the
journal makes each write reversible. Your job is the wording and the approval —
never the write.

## The draft plan

Write one `.assay-tmp/draft-plan.json`. Every fix the user approved is one change
in its `changes` array:

```json
{
  "changes": [
    {
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
    }
  ],
  "batches": { "fix-batch": ["rewrite-prettier"] }
}
```

- `id` — yours to choose, stable and unique within the plan. It is what the user
  approves and what every later command names.
- `kind` — `rule-rewrite`, `stale-reference-repair`, `placement-promotion`, or
  `park`.
- `rationale` — one sentence on why this change, and why this mechanism fits.
- `patches[].old` — the **exact** current text, with enough surrounding context
  to appear exactly once in the file. `plan` refuses an anchor it cannot find and
  an anchor it finds twice; extend the context rather than arguing with it. Use
  `"old": null` for a patch that creates a new file — `plan` then refuses if the
  file already exists.
- `patches[].new` — the replacement text, verbatim.
- Never state a source hash yourself. `plan` fingerprints every affected file and
  stamps the result; a fingerprint is a mechanical fact, not a judgment.
- `batches` — only for `--fix`: one entry named `fix-batch` listing every rewrite,
  so `apply --batch fix-batch` still records what was approved.

A `park` change carries `"patches": []` and nothing else is written — see
"Parking placement candidates" below. A `placement-promotion` needs two more
fields, `mechanism` and `provenance` — see "Promoting candidates now".

Then run `plan`, preview each change from the plan artifact, and apply only the
ids the user approved. The sections below say what belongs in each change; the
transaction says how it lands.

## Rewriting weak rules

One `rule-rewrite` change per weak rule, targeting its dominant weakness from
the report. A good rewrite has, in one bullet: a concrete trigger (WHEN), an
explicit action (WHAT), and the specifics Claude needs to comply — file paths,
API names, thresholds. Keep the author's intent exactly; you are re-phrasing,
not re-deciding. The engine applies the patch byte for byte, so preserving the
rule's meaning is entirely your duty and the only part of this no check catches.

Per-factor moves:

- **F1 weak verb** — open with the directive: "Use X", "Never Y", "Always Z".
  Drop "try to", "consider", "where possible" unless the rule truly is optional
  (then leave it — don't harden a preference into a mandate).
- **F2 bare prohibition** — pair the prohibition with its alternative: "Never
  use var — use `const` instead". A bare prohibition can stall the whole task
  when it bans the only obvious path; if nothing replaces the banned action,
  name the escape hatch instead ("stop and ask").
- **F3 no trigger** — name the firing moment: "When editing X…", "Before
  committing…", "After adding a migration…". Duties on distant files (changelog,
  doc sync) need this most — without it they get skipped entirely.
- **F4 wrong scope** — the fix is location, not wording: recommend moving the
  rule to a `.claude/rules/<topic>.md` with `paths:` frontmatter matching the
  files it governs. That is two patches in one change — one creating the scoped
  file, one removing the rule from where it was — so both land or neither does.
  Verify the glob matches at least one real file with `Glob` before planning it.
- **F5 buried** — the fix is position, not wording: move the rule into the top
  quarter of its file, or split the long file into scoped `.claude/rules/`
  files. Preserve the text as-is.
- **F7 vague** — replace abstract adjectives with checkable specifics: a path,
  an identifier in backticks, a numeric threshold, or a one-line example.

Keep each rewrite to a single bullet under ~30 words. Never merge two rules,
never invent policy the original didn't state.

When a file's problem is its shape rather than any one rule's wording — mostly
narrative, most rules sitting past the midpoint, or simply too long — the
per-rule rewrite above can't reach it. The report's **Restructure candidates**
section names those files and the reshape each needs (fence the narrative, move
the load-bearing rules up, or split into scoped `.claude/rules/` files). Those
are applied by hand, not by this fix pass — it never rewrites a whole file.

## Rewriting weak skill descriptions

The "Weak skill descriptions" section lists each `.claude/skills/<name>/SKILL.md`
whose `description` (plus `when_to_use`, if present) is missing part of the
trigger recipe, carries a duplicated clause, still keeps a separate `when_to_use`
field, or runs over the 1,536-character listing cap. Read
`${CLAUDE_PLUGIN_ROOT}/skills/craft-skill/references/recipe.md` first, then fix
each listed skill by editing only its frontmatter — never the skill body.

The Issue column says which case each skill is, and the fix differs by case:

- **Model-invocable** (the default) — rewrite to the recipe, as below, folding
  any `when_to_use` content into `description` and deleting the field. A proof
  A/B (`docs/research/proof/skill-trim/`, confirmed on sonnet) found no firing
  penalty from dropping it and a measurable recall lift over keeping it.
- **`disable-model-invocation`, still user-invocable** — the description is a
  slash-command summary, not a router. The fix inverts: trim it to one short
  plain-English sentence and delete `when_to_use` and any quoted trigger
  phrasings. No "Use when", no "Do NOT use" — nothing routes on it.
- **Neither model- nor user-invocable ("dead")** — report only. Tell the user
  the skill can't be invoked and suggest removing its directory; never edit or
  delete it as a fix.

For a model-invocable skill: rewrite in place, the way the rule rewrites do — rephrase, don't re-decide, and
come out **no longer than you started**. Do not append the recipe parts as
trailing sentences: read what the description already says, then fold the missing
parts in, turning an existing prose trigger into the quoted "Use when…" form
rather than adding a second clause beside it.

1. Read the skill's current `description` and `when_to_use` with `Read`, and note
   the report's Chars figure — that combined length is your budget, and it all
   lands in one field.
2. Rewrite to the recipe's three parts, all inside `description`: a concrete
   base sentence naming real artifacts, key use case first; a "Use when…" clause;
   and a "Do NOT use when…" exclusion. Keep what already works and keep the
   author's intent — cut only duplication and padding. If `when_to_use` exists,
   fold its content in and remove the field from the frontmatter entirely — a
   model-invocable skill never keeps both.

   Two things the measurement changed about how to write part 1 and part 2:

   - **Keep the base sentence terse.** If it enumerates the domain's whole
     surface ("the full command set and constant registry, scoping, event
     labels, …"), cut it to a `<domain> — <key commands/nouns>` opener. The
     enumeration measurably lowers firing, most sharply on niche domains. This
     is the highest-value edit on the description.
   - **Quoted phrasings are optional, and must fit.** There is no minimum count
     — one is fine, none is fine, and adding more never improved firing. What
     does hurt is quotes that miss what the skill is actually asked for: they
     narrow the router's scope and can collapse firing. Rewrite off-target
     quotes to match the real ask, or delete them. Never invent quotes just to
     reach a count.
3. `description` alone must end **under 1,536 characters**. If it was already
   over, the rewrite has to remove more than it adds — past the cap the tail
   truncates in the listing and the "Do NOT use" clause is the first thing lost.
   Put it in the draft plan as a `rule-rewrite` change whose `old` is the exact
   current frontmatter block, then re-check against the recipe's refit checklist.
   `validate` re-parses the frontmatter as YAML after the write, and a patch that
   breaks it is restored automatically.

Fix only `description`, deleting `when_to_use` for a model-invocable skill when
it exists. A skill that needs a whole new body, or a brand-new skill, is
`/assay:craft-skill`, not this pass.

## Fixing stale references

The "Stale references" section lists each rule citing a path that no longer
resolves, with the engine's basename search appended:

Each is one `stale-reference-repair` change in the draft plan:

- **likely moved to `X`** — one file of that name exists elsewhere. Repoint the
  reference to `X`, keeping the surrounding sentence intact.
- **same name lives at: …** — several matches. Pick the one the rule means and
  update it; ask the user only when it's genuinely ambiguous.
- **no file by that name in the repo** — the target is gone, not moved. Delete
  the reference or repoint it at the current source of truth. Never invent a path.

Only rewrite a reference to a file you have confirmed exists.

## Official docs

Hook, skill, and agent formats drift between Claude Code releases, so every
build starts from the current official page — fetched live, never recalled
from memory:

| Primitive | Fetch |
| --- | --- |
| hook | `https://code.claude.com/docs/en/hooks.md` (reference) and `https://code.claude.com/docs/en/hooks-guide.md` |
| skill | `https://code.claude.com/docs/en/skills.md` |
| subagent | `https://code.claude.com/docs/en/sub-agents.md` |

If a fetch fails, park that candidate instead of building from memory.

## Promoting candidates now

Promotion never touches the source rule. It writes a new mechanism beside the
rule, on approval, and leaves the prose active. For each candidate the user
checked:

Choose the target level before the primitive. A hook guards the agent's own
lifecycle and covers exactly its matcher — a `Bash` hook sees no other tool, and
nothing outside a Claude Code session reaches it at all. A policy that must be
impossible to merge or deploy belongs in a repository or remote gate — a lint
rule, a test, a pre-commit check, a CI job. This flow does not build those: it
promotes to skills, subagents, and hooks only. When the report's ladder shows
level 4 or 5 mechanisms in the project, say plainly that the stronger home
exists and that the user would wire it themselves, rather than promoting to a
hook and letting it read as the same guarantee.

1. Fetch the primitive's doc pages from the table above with `WebFetch` —
   once per primitive per run, not once per candidate.
2. Compose the artifact at project scope, exactly as the fetched page
   specifies — never from a remembered format — and put it in the draft plan as
   one `placement-promotion` change:

   ```json
   {
     "id": "promote-changelog",
     "kind": "placement-promotion",
     "rationale": "A multi-step changelog duty is a workflow, not a sentence.",
     "mechanism": { "type": "skill", "name": "changelog" },
     "provenance": [{ "claim": "SKILL.md frontmatter",
                      "url": "https://code.claude.com/docs/en/skills.md",
                      "verified": "<the date you fetched it>" }],
     "patches": [{ "path": ".claude/skills/changelog/SKILL.md", "old": null, "new": "<the full file>" }],
     "limitations": ["invocation is probabilistic — a description routes it, nothing guarantees it is reached"]
   }
   ```

   `mechanism` and `provenance` are both required for this kind: `validate` uses
   `mechanism` to ask whether the host profile actually discovers the artifact,
   and `provenance` is where the fetched page is recorded so the format is never
   an untraceable dependency. A plan without them is rejected.
   - **hook** — wire the event in `.claude/settings.json`; any check script
     goes under `.claude/hooks/` as a second patch in the same change. If that
     file already wires a hook for the same event and matcher, skip this
     candidate: say a hook for that event and matcher is already configured and
     leave the rule where it is.
   - **skill** — create `.claude/skills/<name>/SKILL.md`; the rule text
     becomes the body's first section. Write the frontmatter description per
     `${CLAUDE_PLUGIN_ROOT}/skills/craft-skill/references/recipe.md` — concrete base
     sentence, quoted trigger phrases, exclusion clause — a plain description
     routes too weakly to stand in for a rule.
   - **subagent** — create `.claude/agents/<name>.md`; the rule text becomes
     its prompt.
3. Preview each change from the plan artifact and apply only the ids the user
   explicitly approves. No approval, no `--change`. One hook per change — two
   hook changes patching the same settings file would make the second one stale.
4. `validate --change <id>` each promotion. The host-discovery check is what
   confirms the artifact landed somewhere the host will find it, and it reports
   `configured` and nothing above: no file on disk is evidence that a mechanism
   ran.
5. Anything that failed — fetch refused, plan rejected, validation failed — gets
   parked (below), not retried. A failed promotion that was already applied is
   rolled back first.

**The source rule stays exactly where it is.** No apply kind deletes or
deactivates prose; the engine will not do it and neither will you. Close by
telling the user what was installed, that it loads from the next session on, and
that the rule is still active — so the duty is now stated in two places. Say the
duplication is deliberate: removing or deactivating the prose is `retire`, a
separate command with its own approval that refuses until validation evidence
exists, and retaining the prose as documentation is a perfectly good answer.

## Parking placement candidates

Parking records a deferred plan. The rule stays in its source file, untouched
and active — parking deletes nothing and moves no text. Each parked candidate is
a `park` change in the same draft plan, carrying no patch:

```json
{
  "id": "park-format-hook",
  "kind": "park",
  "rationale": "PreToolUse hook on Bash(git commit:*) — the check script must exit non-zero when prettier would reformat a staged file.",
  "patches": [],
  "predicted": "level 3 guardrail covering the agent's own commits",
  "limitations": ["a hook covers only its matcher, and nothing outside a session reaches it"]
}
```

Put the promotion note in `rationale` — the same sentence the old promotions file
carried — and the report's evidence names and the primitive's doc URL in
`limitations` beside it. `apply` refuses a park by design, so nothing can turn
one into a write by accident, and `clean` never deletes a plan artifact: the
plan file **is** the park record, and the user promotes from it at their own
pace by drafting a real change for that entry later.

"To promote" wording by primitive — one sentence in `rationale`, naming the
mechanism:

- **hook** — which event fits (a command gate before the matched tool runs, a
  check after edits, or a PostToolUse reminder for keep-file-in-sync duties
  like changelog or doc updates), and what the check script must verify. The
  build follows the live hooks docs, never a remembered config format.
- **skill** — the trigger phrase the skill should own and what its SKILL.md
  covers; the rule text usually becomes the skill body's first section, built
  per the live skills docs with a description following the craft skill's
  trigger recipe (or via `/assay:craft-skill` directly).
- **subagent** — what the subagent audits and what it must return; note that
  the value is the fresh context, so the rule text becomes its prompt, built
  per the live subagents docs.
- **compound** — split the sentence at the conjunction and park each half as its
  own change under its own primitive.

A plan artifact is a parking lot, not config — nothing loads it, so the parked
rule is still doing its work from its own file, unchanged.
