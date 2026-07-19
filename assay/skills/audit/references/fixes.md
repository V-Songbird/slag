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

## Companion plugins

Building a hook, skill, or subagent is never assay's own job — each primitive
has an official companion plugin that owns creation:

| Primitive | Companion | Install |
| --- | --- | --- |
| hook | hookify | `/plugin install hookify@claude-plugins-official` |
| skill | skill-creator | `/plugin install skill-creator@claude-plugins-official` |
| subagent | plugin-dev | `/plugin install plugin-dev@claude-plugins-official` |
| broader Claude Code config | claude-code-setup | `/plugin install claude-code-setup@claude-plugins-official` |

Info pages live at `https://claude.com/plugins/<companion>`.

These are plugins, so a companion counts as installed when a skill prefixed
with its plugin name appears in the session's available-skills list. Never
guess a skill name that is not listed, and never hand-write hook config,
SKILL.md scaffolding, or agent definitions yourself.

## Promoting candidates now

Promotion is automated end to end — checking the menu option is the user's
only manual step. For each candidate the user checked:

1. If the primitive's companion is in the session's available-skills list,
   invoke its skill with the rule text, the target primitive, and the signal
   evidence as the argument, and let it do the building. One invocation per
   candidate.
2. If the companion is missing, install it yourself with Bash:
   `claude plugin install <companion>@claude-plugins-official`. A fresh
   install is invisible to the running session, so build that candidate in a
   child session instead, from the project root:
   `claude -p "<promotion prompt>" --permission-mode acceptEdits`. The prompt
   must be self-contained: name the companion skill to invoke, the target
   primitive, and the exact rule text. The child loads the new plugin and
   builds the artifact.
3. Build hooks one at a time — parallel hook builds can collide on the same
   settings file. Skills and subagents may build in parallel.
4. Verify each artifact landed (hook wired, skill directory or agent file
   present), then remove the promoted rule's bullet from its source file with
   `Edit`.
5. Anything that failed — install refused, child errored or stalled — gets
   parked (below) with its install command, not retried.

Close by telling the user which companions were newly installed: their skills
join the user's own session after `/reload-plugins`, but the promotions
themselves are already done.

After all candidates are handled, remove each promoted rule's bullet from its
source file with `Edit` — the built artifact replaces the prose.

## Parking placement candidates

For each candidate the user checked:

1. Append an entry to `.claude/assay-promotions.md` (create the file with a
   `# Assay promotions` heading if missing):

   ```
   ## <hook|skill|subagent|compound> — from <file>:<line>

   > <exact rule text>

   Signals: <evidence names from the report>
   Promote with: <companion plugin> — <install command>
   To promote: <one concrete sentence — see below>
   ```

2. Remove the rule's bullet from its source file with `Edit`.

"To promote" wording by primitive — one sentence, naming the mechanism:

- **hook** — which event fits (a command gate before the matched tool runs, a
  check after edits, or a PostToolUse reminder for keep-file-in-sync duties
  like changelog or doc updates), and what the check script must verify. The
  build itself belongs to hookify, not to hand-written config.
- **skill** — the trigger phrase the skill should own and what its SKILL.md
  covers; the rule text usually becomes the skill body's first section, built
  via skill-creator.
- **subagent** — what the subagent audits and what it must return; note that
  the value is the fresh context, so the rule text becomes its prompt, built
  via plugin-dev.
- **compound** — split the sentence at the conjunction and park each half under
  its own primitive with its own "to promote" line.

The promotions file is a parking lot, not config — nothing loads it. The user
promotes entries at their own pace and deletes them as they land.
