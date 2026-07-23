# The description recipe

A skill's frontmatter `description` is a router, not documentation: Claude reads
it when deciding whether to invoke the skill, and recall tracks how much of the
user's actual phrasing the description covers. Every part below is there because
it measurably changes whether the skill fires; nothing here is style.

Write the whole recipe into `description` alone — never add a separate
`when_to_use` field. A proof A/B (`docs/research/proof/skill-trim/`, confirmed
on sonnet) found no firing penalty from dropping `when_to_use` entirely, and a
measurable recall lift over keeping it: the field just dilutes routing. The
listing entry is capped at 1,536 characters — write to fit well under it. Past
the cap the tail truncates, and the exclusion clause sits last, so it is the
first thing lost. More words is not more recall: spend the budget on distinct
trigger phrasings, never on repeating one.

This recipe is for skills Claude can auto-invoke. A `disable-model-invocation`
skill is a user-only slash command — it doesn't route on its description, so it
wants a short plain-English summary instead, and none of the trigger machinery
below applies.

## The three parts, in order

Every description this plugin writes has exactly this shape:

```
<Concrete base sentence>. Use when the user asks to <verb list> [— e.g.
"<phrase>", "<phrase>"]. Do NOT use when <adjacent ask> — only for <core use>.
```

1. **Concrete base sentence.** One sentence, naming real artifacts: file
   extensions, paths, tool names, output files. "Generates a Markdown summary
   report from a `.csv` file" — never "processes tabular data". Abstract domain
   words are the single most common reason a skill exists but never runs.

   Keep it **short and specific — do not enumerate the domain's whole surface.**
   An "authoritative reference for X — the full command set and constant
   registry, scoping rules, event labels, …" opener measurably *lowers* firing
   against a terse "`<domain>` — `<key commands/nouns>`" one. The enumeration
   reads as breadth and routes worse than a narrow, concrete claim. This is the
   largest single effect measured on description wording, and it bites hardest
   on niche domains, where routing is least certain.

2. **Trigger clause — and quoted phrasings only if they fit.** The explicit
   "Use when the user asks to X, Y, or Z" clause is required. The **quoted
   example phrasings are optional**: adding more of them never improved firing
   in measurement, and there is no minimum count — one is fine, none is fine.

   The rule that does matter is **coverage**. Quotes that don't match what the
   skill is really asked for are worse than no quotes at all — they narrow the
   router's sense of scope and can collapse firing outright. If you quote asks,
   they must cover the actual use; if you can't write ones that do, omit them.

   When you do write them, make them **paraphrases in the user's words**, not
   echoes of the base sentence — users who phrase the ask in the skill's own
   nouns already match; the quotes exist to catch everyone else. Cover the
   casual form ("what's in this data"), the imperative form ("summarize
   data.csv"), and the goal form ("make a report from the csv").

3. **Exclusion clause.** "Do NOT use when…" naming the nearest adjacent ask the
   skill should stay quiet for. It costs nothing on recall and it is the only
   thing that stops the skill firing on close-but-wrong requests — a specific
   question when the skill produces a full report, a one-function ask when the
   skill documents whole modules.

Things that do NOT help, measured directly: imperative framing ("Use this skill
to…" vs "Generates…") and politeness padding. Spend the words on triggers.

## The reliability ladder

A description — even a perfect one — is probabilistic routing. When the user
says a skill must ALWAYS run, climb the ladder; each step is additive:

1. **Recipe description** (always). Strong on small models, but larger models
   skip description-routed skills more often, not less. Never promise
   "always" from a description alone.

2. **Companion rule.** One bullet, shaped exactly like this, placed in the top
   quarter of `CLAUDE.md`:

   ```
   When the user asks <trigger in plain words>, ALWAYS use the <name> skill —
   never <do the core thing> without running it.
   ```

   The trigger clause, the hard verb, the skill named concretely, and the
   paired never-clause are each load-bearing; keep all four.

3. **Scoped companion rule.** When the skill is bound to a file type, put the
   same rule in `.claude/rules/<name>-rule.md` with `paths:` frontmatter
   (e.g. `- "*.csv"`) instead of CLAUDE.md. It performs identically where the
   globs match and keeps CLAUDE.md short. Verify the glob matches at least one
   real project file before writing it.

4. **Hook.** The only true guarantee. If skipping the skill even once is a
   real failure — formatting gates, safety checks — the ask is a hook, not a
   skill description; say so and offer to build it per the live hooks docs.

## Refitting an existing description

Rewrite in place and come out no longer than you started — fold each fix into the
existing text, never append a trailing clause. Diagnose in this order, fix the
first miss, re-check:

1. Base sentence names zero concrete artifacts → rewrite it with the real
   file types and outputs.
2. Base sentence enumerates the domain's whole surface ("the full command set
   and constant registry, scoping, event labels, …") → cut it to a terse
   `<domain> — <key commands/nouns>` opener. This is the fix that matters most.
3. No "Use when…" clause → fold part 2's trigger in, turning any existing prose
   trigger into the clause form rather than adding a second one.
4. Quoted asks don't cover what the skill is really used for → rewrite them to
   match the real ask, or delete them; off-target quotes cost firing.
5. Quotes echo the base sentence's nouns instead of paraphrasing → rewrite
   them in user language.
6. No exclusion clause and an adjacent ask exists → fold in part 3.
7. Two trigger clauses, two exclusions, or the same quoted phrase twice → merge
   the pair into one clause, keeping every distinct phrasing and dropping the
   repeat. This is the append fix's leftover; clearing it also buys back length.
8. A separate `when_to_use` field still exists → fold its content into
   `description` and delete the field; a model-invocable skill never keeps both.
9. `description` over 1,536 characters → cut duplication and padding until it
   fits; past the cap the listing drops the tail.
10. User reports it still gets skipped → climb the ladder above.
