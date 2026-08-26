# The rule recipe

A rule is one bullet the agent reads mid-task, long after the file loaded. Every
part below maps to a factor the audit grades; nothing here is style.

**Where it was measured.** These levers were measured on the Claude Code
profile, and a host profile that sets `policy.wordingRubric: false` in the scan
record withdraws them along with the grade they sum to. Under such a profile
the anatomy below is still good authoring advice — write to it — but it is not
a graded contract, and the engine produces no wording score to report. Say that
plainly instead of implying a rule was scored. They were measured on
small-model tiers of a pre-Claude-5 generation (haiku 4.5, 2026-07; sonnet-tier
checks mostly saturated) — treat the anatomy as reliability engineering for the
smallest model that will read the rule, not as a law of every model.

One tier of the current generation has since been measured (Claude Sonnet 5,
2026-08-25). Two of these levers showed **no effect** there: where the rule sits
in its file, and whether it says "always" or "prefer". The bare prohibition
still cost something, in one rule intent of two. Every arm was at a ceiling —
once a rule was present at all it was followed — so the honest reading is that
these levers stop separating outcomes on a big model, not that a buried or
softly worded rule became a good one. Write to the anatomy anyway: it is free,
it is what the smallest tier needs, and it is what a human reader needs.

## Anatomy

```
When <firing moment>, <directive verb> <action> — <concrete specific>.
```

For prohibitions:

```
Never <X> — <do Y> instead.
```

Four load-bearing parts, each measured:

1. **Trigger.** Name the firing moment: "When editing X…", "Before
   committing…", "After adding a migration…". Duties on distant files
   (changelog entries, doc sync) get ignored outright by small-tier models
   without one — not merely done late; a stronger model may hold them untriggered.

2. **Directive verb.** Open with it: Use, Never, Always, Run. "Try to",
   "consider", "where possible" read as optional; write them only when the
   rule truly is one.

3. **Named alternative.** Every prohibition pairs with its replacement —
   "Never use var — use `const` instead". A bare prohibition can stall the
   whole task when it bans the only obvious path; if nothing replaces the
   banned action, name the escape hatch ("stop and ask").

4. **Concrete specifics.** A path, an identifier in backticks, a numeric
   threshold, or a one-line example. "Clean", "appropriate", and "properly"
   grade near zero because nothing can check them. Concrete means **checkable,
   not conditional** — one anchor the rule can be verified against; a rule that
   sprouts if-this-then-that branches is case logic and belongs in a hook or
   skill (redirect table below).

Ceiling: one bullet, under ~30 words, one duty. Two duties are two rules.

## Two more levers, and what is known about them

These two are **not measured**. They come from a mechanism account of why
instructions are followed, and that account's own caveat travels with it: it is
a plausible model of the machinery, not testimony about it. The engine grades
neither, so neither can raise a score — use them where they cost nothing, and
never present them to an author as a measured result.

5. **One example of correct output.** Show one, in the rule or beside it:

   ```
   - Before committing, run `npx prettier --write .` over every staged file —
     e.g. `npx prettier --write src/app.ts`.
   ```

   An example is claimed to work on the same machinery
   that produces the answer, where a description of the answer does not. It is
   also the cheapest way to satisfy part 4: an example IS a concrete specific,
   and one line often carries what three sentences of qualification cannot.
   One example, not three — a list of examples reads as a list of cases, and
   case logic belongs in a skill.

6. **Restate what matters most at the end of a long instruction.** This is
   about the whole instruction, not the bullet: a long rule FILE, or a skill
   body, or a task prompt. Close it by restating the two or three constraints
   that would hurt most to lose. Two or three, never a summary of everything —
   restating all of it restates nothing, and a closing block that repeats the
   file is a second copy to keep in sync.

   Watch what this costs elsewhere. A restated rule is a real rule to the
   engine: it is graded, counted, and can come back as a duplicate of the one
   it restates. Write the closing block as prose that names the constraints
   rather than as fresh mandate bullets, or fence it with `<!-- assay-ignore
   -->` so the audit reads it as the reminder it is.

## Placement

The candidate files are `profile.targets.rule.places[]` in the scan record —
one entry per file this host lets a new rule be written into, each carrying the
`scoping` sentence that says what it reaches. Read the menu off the record;
never assume a filename from the host's name.

| The rule is | It goes |
| --- | --- |
| Bound to a file type or path | The scoped target, if the host has one — with the scoping frontmatter its `scoping` line names, and only after the glob is verified to match at least one real file |
| Bound to where the session started | The chain target for that directory, on a host whose instruction system is a directory chain — and say plainly that a session started elsewhere never reads it |
| Universal | The always-loaded target, near the top |

Never add a rule below the halfway line of a long file on the profile where
position is graded — it grades the rule down there; on profiles where position
is ungraded, no penalty is established. Never write into a source the record
marks `selected: false`, or past a `truncatedAtLine`: the host does not read there.

## When the ask is not a rule

| The ask | The right primitive |
| --- | --- |
| A command could verify it with an exit code, or a file matcher could block it | Hook — prose is a stopgap that has to be remembered |
| A multi-step procedure, or "follow the conventions in <doc>" | Skill — build it with `/assay:craft-skill` |
| An audit or review duty that needs fresh context | Subagent |
| "Claude must NEVER, not even once" | Hook — only a hook guarantees; a rule is probabilistic |

Some prose in a rule file is narrative on purpose — a motivating story, a pasted
requirement, a glossary of tiers. It reads like rules but commands nothing, and
the audit will grade it as weak mandates and dock the file for it. Fence it off
so it leaves the grade: `<!-- assay-ignore -->` on the line above a single rule,
or a `<!-- assay-ignore-start -->` / `<!-- assay-ignore-end -->` pair around a
whole block. Fenced lines also leave the position denominator, so a real rule
below the block is not counted as buried under prose that was never graded.
