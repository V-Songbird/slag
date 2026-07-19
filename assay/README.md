<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="assay" width="240" />
  </picture>
  <h1>assay</h1>
  <p><strong>Your CLAUDE.md is full of rules. assay tells you which ones Claude can actually follow.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — You wrote rules for Claude; it keeps ignoring some. assay grades every rule on whether Claude can tell when it fires and what to do, then offers rewrites for the weak ones. The grading is almost entirely a script — a re-run gives the same numbers.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise; it can change shape or disappear without a migration path. If it breaks your session, that's the deal you took.

## What is this?

You wrote rules for Claude. Claude keeps ignoring some of them. Before you conclude the model is lazy, consider that "write clean, maintainable code" is not a rule — it's a wish. assay reads every rule in your `CLAUDE.md` and `.claude/rules/`, grades each one on whether Claude can actually tell *when it fires* and *what to do*, and offers to rewrite the ones that grade badly.

It also spots the rules that were never meant to be prose at all — "run prettier before committing" is a hook pretending to be a sentence — and offers to park them for promotion into the mechanism that would actually enforce them.

## Why you'd want it

- **You stop guessing which rules work.** Every rule gets a grade and the one factor most worth fixing, not vibes.
- **Prohibitions that dead-end get flagged.** "Never X" with no alternative can stall a session mid-task, so it grades F until it names the replacement.
- **The weak ones get rewritten, not lectured about.** One menu, your approval, then in-place edits you review with `git diff`.
- **Wishes get unmasked as hooks.** Rules a script could enforce with an exit code are flagged, with the evidence, instead of burning goodwill as text.
- **Stale references get caught.** A rule citing a file that no longer exists is worse than no rule — assay notices before Claude does.

## How it works

Almost all of the scoring is a plain Node script — deterministic, same input, same grades. The model judges exactly two things a script can't: whether a rule's trigger moment is recognizable, and whether a tool could enforce it better. Then the script composes the report.

| Moment | What happens |
| --- | --- |
| You run the audit | Every rule is extracted, scored, and graded |
| The report lands | Weakest rules first, each with its suggested fix |
| You check what to apply | Rewrites happen in place; placement candidates get built by their companion plugin, or parked with promotion notes |
| You're done | Temp files are cleaned up; `git diff` shows exactly what changed |

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/slag
/plugin install assay
```

Nothing to configure. Works at the next session.

## What you can do

| You want to… | Command |
| --- | --- |
| Grade your rules and get the fix list | `/assay:audit` |
| Same, but apply rewrites without the menu | `/assay:audit --fix` |
| See every factor score per rule | `/assay:audit --verbose` |

## Good to know

- The grade measures **structural clarity** — whether a rule is parseable, triggerable, specific, and placed where it will be seen. It does not predict compliance; a perfectly clear rule can still lose to the model's habits. Clarity is the part you control.
- Scoring is English-only. Rules in other languages will grade wrong.
- Building promoted rules is delegated to the official companion plugins for hooks, skills, and subagents. A missing companion is installed on the spot.
- Skip a rule you like as-is by putting `<!-- assay-ignore -->` on the line above it.
- Dead-glob detection (a scoped rules file whose file patterns match nothing) needs Node 22+; everything else runs on older Node.

## Under the hood

One scoring script and one skill with its two rubrics — all there to read in the plugin's files.

## License

MIT — see [LICENSE](./LICENSE).
