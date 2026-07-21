# The rule recipe

A rule is one bullet Claude reads mid-task, long after the file loaded. Every
part below maps to a factor the audit grades; nothing here is style.

## Anatomy

```
When <firing moment>, <directive verb> <action> — <concrete specific>.
```

For prohibitions:

```
Never <X> — <do Y> instead.
```

Four load-bearing parts:

1. **Trigger.** Name the firing moment: "When editing X…", "Before
   committing…", "After adding a migration…". Duties on distant files
   (changelog entries, doc sync) get ignored outright without one — not merely
   done late.

2. **Directive verb.** Open with it: Use, Never, Always, Run. "Try to",
   "consider", "where possible" read as optional; write them only when the
   rule truly is one.

3. **Named alternative.** Every prohibition pairs with its replacement —
   "Never use var — use `const` instead". A bare prohibition can stall the
   whole task when it bans the only obvious path; if nothing replaces the
   banned action, name the escape hatch ("stop and ask").

4. **Concrete specifics.** A path, an identifier in backticks, a numeric
   threshold, or a one-line example. "Clean", "appropriate", and "properly"
   grade near zero because nothing can check them.

Ceiling: one bullet, under ~30 words, one duty. Two duties are two rules.

## Placement

| The rule is | It goes |
| --- | --- |
| Bound to a file type or path | `.claude/rules/<topic>.md` with `paths:` frontmatter — verify the glob matches at least one real file first |
| Universal | Top quarter of `CLAUDE.md` |

Never add a rule below the halfway line of a long file — position alone
grades it down, and buried rules lose force.

## When the ask is not a rule

| The ask | The right primitive |
| --- | --- |
| A command could verify it with an exit code, or a file matcher could block it | Hook — prose is a stopgap that has to be remembered |
| A multi-step procedure, or "follow the conventions in <doc>" | Skill — build it with `/assay:craft` |
| An audit or review duty that needs fresh context | Subagent |
| "Claude must NEVER, not even once" | Hook — only a hook guarantees; a rule is probabilistic |
