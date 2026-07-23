# The description recipe

A skill's frontmatter `description` is a router, not documentation: Claude reads
it when deciding whether to invoke the skill, and recall tracks how much of the
user's actual phrasing the description covers. Every part below is there because
it measurably changes whether the skill fires; nothing here is style.

`description` and `when_to_use` share one skill-listing entry capped at 1,536
characters — write to fit well under it. Past the cap the tail truncates, and the
exclusion clause sits last, so it is the first thing lost. More words is not more
recall: spend the budget on distinct trigger phrasings, never on repeating one.

This recipe is for skills Claude can auto-invoke. A `disable-model-invocation`
skill is a user-only slash command — it doesn't route on its description, so it
wants a short plain-English summary instead, and none of the trigger machinery
below applies.

## The three parts, in order

Every description this plugin writes has exactly this shape:

```
<Concrete base sentence>. Use when the user asks to <verb list> — e.g.
"<phrase>", "<phrase>", "<phrase>". Do NOT use when <adjacent ask> — only
for <core use>.
```

1. **Concrete base sentence.** One sentence, naming real artifacts: file
   extensions, paths, tool names, output files. "Generates a Markdown summary
   report from a `.csv` file" — never "processes tabular data". Abstract domain
   words are the single most common reason a skill exists but never runs.

2. **Trigger-phrase list.** The dominant lever. An explicit "Use when the user
   asks to X, Y, or Z" clause followed by two to four quoted example phrasings.
   Write the quotes as **paraphrases in the user's words**, not echoes of the
   base sentence — users who phrase the ask in the skill's own nouns already
   match; the quotes exist to catch everyone else. Cover the casual form
   ("what's in this data"), the imperative form ("summarize data.csv"), and the
   goal form ("make a report from the csv").

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
2. No "Use when…" clause with quoted phrasings → fold part 2 in, turning any
   existing prose trigger into the quoted form rather than adding a second one;
   this is the fix that matters most.
3. Quotes echo the base sentence's nouns instead of paraphrasing → rewrite
   them in user language.
4. No exclusion clause and an adjacent ask exists → fold in part 3.
5. Two trigger clauses, two exclusions, or the same quoted phrase twice → merge
   the pair into one clause, keeping every distinct phrasing and dropping the
   repeat. This is the append fix's leftover; clearing it also buys back length.
6. Combined `description` + `when_to_use` over 1,536 characters → cut duplication
   and padding until it fits; past the cap the listing drops the tail.
7. User reports it still gets skipped → climb the ladder above.
