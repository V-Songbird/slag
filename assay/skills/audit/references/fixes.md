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

## Rewriting weak skill descriptions

The "Weak skill descriptions" section lists each `.claude/skills/<name>/SKILL.md`
whose frontmatter `description` is missing part of the trigger recipe. Read
`${CLAUDE_PLUGIN_ROOT}/skills/craft-skill/references/recipe.md` first, then fix
each listed skill by editing only its frontmatter — never the skill body:

1. Read the skill's current `description` (and `when_to_use` if the frontmatter
   uses it) with `Read`.
2. Rewrite it to the recipe's three parts: a concrete base sentence naming real
   artifacts, a "Use when…" clause with two to four quoted phrasings in the
   user's words, and a "Do NOT use when…" exclusion. Add only the parts the
   report flagged as missing; keep what already works and keep the author's
   intent.
3. Apply with `Edit`, matching the exact current description text. Re-check the
   result against the recipe's refit checklist before moving on.

Fix only the description and `when_to_use`. A skill that needs a whole new body,
or a brand-new skill, is `/assay:craft-skill`, not this pass.

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

Promotion is automated end to end — checking the menu option is the user's
only manual step. For each candidate the user checked:

1. Fetch the primitive's doc pages from the table above with `WebFetch` —
   once per primitive per run, not once per candidate.
2. Build the artifact at project scope, exactly as the fetched page
   specifies — never from a remembered format:
   - **hook** — wire the event in `.claude/settings.json`; any check script
     goes under `.claude/hooks/`. If that file already wires a hook for the
     same event and matcher, skip this candidate: say the duty is already
     enforced and leave the rule where it is.
   - **skill** — create `.claude/skills/<name>/SKILL.md`; the rule text
     becomes the body's first section. Write the frontmatter description per
     `${CLAUDE_PLUGIN_ROOT}/skills/craft-skill/references/recipe.md` — concrete base
     sentence, quoted trigger phrases, exclusion clause — a plain description
     routes too weakly to replace a rule.
   - **subagent** — create `.claude/agents/<name>.md`; the rule text becomes
     its prompt.
3. Build hooks one at a time — parallel hook builds can collide on the same
   settings file. Skills and subagents may build in parallel.
4. Verify each artifact landed (hook wired, skill directory or agent file
   present), then remove the promoted rule's bullet from its source file with
   `Edit`.
5. Anything that failed — fetch refused, artifact invalid — gets parked
   (below), not retried.

Close by telling the user the built artifacts load from the next session on,
but the promotions themselves are already done.

## Parking placement candidates

For each candidate the user checked:

1. Append an entry to `.claude/assay-promotions.md` (create the file with a
   `# Assay promotions` heading if missing):

   ```
   ## <hook|skill|subagent|compound> — from <file>:<line>

   > <exact rule text>

   Signals: <evidence names from the report>
   Promote with: <the primitive's doc URL(s) from the table above>
   To promote: <one concrete sentence — see below>
   ```

2. Remove the rule's bullet from its source file with `Edit`.

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

The promotions file is a parking lot, not config — nothing loads it. The user
promotes entries at their own pace and deletes them as they land.
