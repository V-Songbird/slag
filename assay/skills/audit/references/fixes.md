# Applying fixes

Both fix classes edit the user's files. Match every rule by its exact current
text (`Edit` with the rule's text as `old_string`), never by line number —
earlier edits shift lines. If a rule's text is no longer found, skip it and
note that in one line.

## Rewriting weak rules

Rewrite each weak rule in place, targeting its dominant weakness from the
report. A good rewrite has, in one bullet: a concrete trigger (WHEN), an
explicit action (WHAT), and the specifics Claude needs to comply — file paths,
API names, thresholds. Keep the author's intent exactly; you are re-phrasing,
not re-deciding.

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
  files it governs. Create the file if the user approved rewrites; verify the
  glob matches at least one real file with `Glob` before writing it.
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
   Apply with `Edit`, matching the exact current text, then re-check against the
   recipe's refit checklist.

Fix only `description`, deleting `when_to_use` for a model-invocable skill when
it exists. A skill that needs a whole new body, or a brand-new skill, is
`/assay:craft-skill`, not this pass.

## Fixing stale references

The "Stale references" section lists each rule citing a path that no longer
resolves, with the engine's basename search appended:

- **likely moved to `X`** — one file of that name exists elsewhere. Update the
  reference to `X` in place with `Edit`, keeping the surrounding sentence intact.
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
   specifies — never from a remembered format — and show it to the user as a
   preview before anything is written: the target path, and the full file or
   settings block it would contain.
   - **hook** — wire the event in `.claude/settings.json`; any check script
     goes under `.claude/hooks/`. If that file already wires a hook for the
     same event and matcher, skip this candidate: say a hook for that event and
     matcher is already configured and leave the rule where it is.
   - **skill** — create `.claude/skills/<name>/SKILL.md`; the rule text
     becomes the body's first section. Write the frontmatter description per
     `${CLAUDE_PLUGIN_ROOT}/skills/craft-skill/references/recipe.md` — concrete base
     sentence, quoted trigger phrases, exclusion clause — a plain description
     routes too weakly to stand in for a rule.
   - **subagent** — create `.claude/agents/<name>.md`; the rule text becomes
     its prompt.
3. Install only what the user explicitly approves, one preview at a time. No
   approval, no write. Build hooks one at a time — parallel hook builds can
   collide on the same settings file. Skills and subagents may build in
   parallel.
4. Verify each artifact landed (hook wired, skill directory or agent file
   present) and **leave the source rule exactly where it is**. An installed
   artifact is configured, not verified: nothing has yet shown it firing on a
   real edit.
5. Anything that failed — fetch refused, artifact invalid — gets parked
   (below), not retried.

Close by telling the user what was installed, that it loads from the next
session on, and that the rule is still active — so the duty is now stated in
two places. Say the duplication is deliberate and name it: once the mechanism
has been seen doing its job, removing or deactivating the prose is a separate
decision they make then, not part of this pass. Never offer to delete it now,
and never call a file that exists proof the duty is enforced.

## Parking placement candidates

Parking records a deferred plan. The rule stays in its source file, untouched
and active — parking deletes nothing and moves no text. For each candidate the
user checked:

1. Append an entry to `.claude/assay-promotions.md` (create the file with a
   `# Assay promotions` heading if missing):

   ```
   ## <hook|skill|subagent|compound> — from <file>:<line>

   > <exact rule text>

   Signals: <evidence names from the report>
   Promote with: <the primitive's doc URL(s) from the table above>
   To promote: <one concrete sentence — see below>
   ```

2. Leave the source file alone. The entry quotes the rule; it does not move it.

"To promote" wording by primitive — one sentence, naming the mechanism:

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
- **compound** — split the sentence at the conjunction and park each half under
  its own primitive with its own "to promote" line.

The promotions file is a parking lot, not config — nothing loads it, so the
parked rule is still doing its work from its own file, unchanged. The user
promotes entries at their own pace and deletes them as they land.
