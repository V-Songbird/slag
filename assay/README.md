<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="assay" width="240" />
  </picture>
  <h1>assay</h1>
  <p><strong>Your CLAUDE.md is full of rules. assay tells you which ones Claude can actually follow.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — You wrote rules for Claude; it keeps ignoring some. assay grades every rule on whether Claude can tell when it fires and what to do, then offers rewrites for the weak ones. The grading is almost entirely a script — a re-run gives the same numbers. It also builds skills whose descriptions actually trigger.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise; it can change shape or disappear without a migration path. If it breaks your session, that's the deal you took.

## What is this?

You wrote rules for Claude. Claude keeps ignoring some of them. Before you conclude the model is lazy, consider that "write clean, maintainable code" is not a rule — it's a wish. assay reads every rule in your `CLAUDE.md` and `.claude/rules/`, grades each one on whether Claude can actually tell *when it fires* and *what to do*, and offers to rewrite the ones that grade badly.

It also spots the rules that were never meant to be prose at all — "run prettier before committing" is a hook pretending to be a sentence — and offers to park them for promotion into the mechanism that would actually enforce them.

And when the problem is a skill instead of a rule, `/assay:craft-skill` builds one whose description Claude actually notices, or refits a skill Claude keeps ignoring. A skill that must always run gets a rule backing it up — and, when even that isn't promise enough, a hook.

Rules get the same treatment: `/assay:craft-rules` grills you — when should it fire, what replaces the thing you're banning, what does a violation actually look like — then writes one bullet that would survive its own audit, placed where Claude will actually read it. If what you asked for was never a rule at all, it says so instead of writing you a wish.

## Why you'd want it

- **You stop guessing which rules work.** Every rule gets a grade and the one factor most worth fixing, not vibes.
- **Prohibitions that dead-end get flagged.** "Never X" with no alternative can stall a session mid-task, so it grades F until it names the replacement.
- **The weak ones get rewritten, not lectured about.** One menu, your approval, then in-place edits you review with `git diff`.
- **Wishes get unmasked as hooks.** Rules a script could enforce with an exit code are flagged, with the evidence, instead of burning goodwill as text. assay reads the hooks already wired for the project — from its settings, yours, and installed plugins — so a candidate that's already enforced gets marked covered, not proposed again.
- **Stale references get caught — and traced.** A rule citing a file that no longer exists is worse than no rule. assay reads the paths in backticks *and* in markdown links, and when the file has merely moved it names where it went, so the fix is one edit instead of a hunt.
- **Skills that actually fire.** A skill's description is how Claude decides to use it; most are written as documentation instead. Crafted ones are written as triggers.
- **Skills you already have get graded too.** The audit checks every project skill's description against the same trigger recipe and offers to rewrite the ones missing parts, in the same fix menu as the rules.

## How it works

Almost all of the scoring is a plain Node script — deterministic, same input, same grades. The model judges exactly two things a script can't: whether a rule's trigger moment is recognizable, and whether a tool could enforce it better. Then the script composes the report.

| Moment | What happens |
| --- | --- |
| You run the audit | Every rule is extracted, scored, and graded |
| The report lands | Weakest rules first, each with its suggested fix — every rule is a clickable link that opens it at its line |
| You check what to apply | Rewrites happen in place; placement candidates get built from the live official docs, or parked with promotion notes |
| You're done | Temp files are cleaned up; `git diff` shows exactly what changed |

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/slag
/plugin install assay@slag
```

Nothing to configure. Works at the next session.

## What you can do

| You want to… | Command |
| --- | --- |
| Grade your rules and get the fix list | `/assay:audit` |
| Same, but apply rewrites without the menu | `/assay:audit --fix` |
| See every factor score per rule | `/assay:audit --verbose` |
| Build a skill that reliably triggers | `/assay:craft-skill` |
| Fix a skill Claude keeps ignoring | `/assay:craft-skill <skill name>` |
| Write a new rule that sticks | `/assay:craft-rules` |

## Under the hood

One scoring script and three skills — the audit with its two rubrics, craft-skill with its trigger recipe, craft-rules with its rule recipe — all there to read in the plugin's files.

## Good to know

- The grade measures **structural clarity** — whether a rule is parseable, triggerable, specific, and placed where it will be seen. It does not predict compliance; a perfectly clear rule can still lose to the model's habits. Clarity is the part you control.
- Scoring is English-only. Rules in other languages will grade wrong; the report counts the ones in a non-Latin script so their numbers aren't mistaken for real grades.
- Promoted rules are built at project scope, straight from the current official docs — fetched at promotion time, so the formats are never stale. Nothing else gets installed.
- Skip a rule you like as-is by putting `<!-- assay-ignore -->` on the line above it.
- Dead-glob detection (a scoped rules file whose file patterns match nothing) needs Node 22+; everything else runs on older Node.
- Even a crafted description is a strong hint, not a promise — on any model size. That's why `craft-skill` backs must-run skills with a rule, and names a hook as the only true guarantee.

## License

MIT — see [LICENSE](./LICENSE).
