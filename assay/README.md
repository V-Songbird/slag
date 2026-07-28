<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="assay" width="240" />
  </picture>
  <h1>assay</h1>
  <p><strong>Your CLAUDE.md is full of rules. assay tells you which ones are too vague, too buried, or too big for prose.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — assay analyzes the instruction files Claude Code loads for your project: what's vague, what's stale, what's buried, what belongs in a hook instead of a paragraph. Each finding lands at its exact line, labelled with the kind of evidence behind it, and the weak rules get offered rewrites. A structural-hygiene grade follows as a secondary summary, never a prediction that the model will comply.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise; it can change shape or disappear without a migration path. If it breaks your session, that's the deal you took.

## What is this?

"Write clean, maintainable code" is not a rule — it's a wish. assay reads the instruction files Claude Code loads for your project — `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/`, and your own user-level `CLAUDE.md` — and grades each rule on the parts you control: does it name *when it fires* and *what to do*, is it specific, and does it sit where the file gets read. Then it offers to rewrite the ones that grade badly.

It also spots the rules that were never meant to be prose at all — "run prettier before committing" is a hook pretending to be a sentence — and offers to build that mechanism, or to note the plan for later. Either way the rule itself stays put and keeps working.

And when the problem is a skill instead of a rule, `/assay:craft-skill` builds one whose description reads as a trigger instead of a summary of itself, or refits a skill that never seems to fire. A skill that must always run gets a rule backing it up — and, when even that isn't promise enough, a hook.

Rules get the same treatment: `/assay:craft-rules` grills you — when should it fire, what replaces the thing you're banning, what does a violation actually look like — then writes one bullet that would survive its own audit, placed where Claude will actually read it. If what you asked for was never a rule at all, it says so instead of writing you a wish.

## Why you'd want it

- **You stop guessing which rules are weak.** Every rule gets one finding at its exact line, with the kind of evidence behind it stated plainly — and a hygiene grade that never overrules a rule the host can't apply.
- **Prohibitions that dead-end get flagged.** "Never X" with no alternative can stall a session mid-task, so it grades F until it names the replacement.
- **The weak ones get rewritten, not lectured about.** One menu, your approval, then in-place edits you review with `git diff`.
- **Wishes get unmasked as hooks.** Rules a script could enforce with an exit code are flagged, with the evidence, instead of burning goodwill as text. assay reads the hooks already wired for the project — from its settings, yours, and installed plugins — so a candidate that's already enforced gets marked covered, not proposed again.
- **Stale references get caught — and traced.** A rule citing a file that no longer exists is worse than no rule. assay reads the paths in backticks *and* in markdown links, and when the file has merely moved it names where it went, so the fix is one edit instead of a hunt.
- **Skill descriptions written as triggers.** A skill's description is how Claude decides to use it; most are written as documentation instead. Crafted ones name the moment.
- **Skills you already have get graded too.** The audit checks every project skill's description against the same trigger recipe and offers to rewrite the ones missing parts, in the same fix menu as the rules.

## How it works

Almost all of the scoring is a plain Node script — deterministic, the same input scoring to the same grades. The model judges what a script can't: whether a rule's trigger moment is recognizable, whether a tool could enforce it better, and whether an extracted chunk is a rule at all. Then the script composes the report.

The model steps are optional. `--deterministic` runs the audit offline: the full report still lands, labelled as such, with the checks that need a model named as not run and each score computed over the factors that were measured. When the model does judge, the audit records which model, which rubric version, and when.

Before the report, one more question gets asked of each doubtful entry: is this a rule at all? A file of notes or history would otherwise arrive graded as a page of mandates. The answer can only drop an entry from the report — nothing is ever rescored or reworded — and `--verbose` lists every drop with the reason. It costs one model call per audit; `--no-verify` skips it.

Every report opens by saying what it actually looked at — and names any file it couldn't read. Every line of every file it did read is accounted for: graded, set aside, ignored on purpose, or named as something assay couldn't parse. A number in the report never covers more than that.

Your user-level `CLAUDE.md` loads for this project too, so it gets graded — but under its own **User scope** heading, and never inside the project's grade. The fix for one of those rules lives in your setup, not in the repo. `--project-only` leaves them out.

| Moment | What happens |
| --- | --- |
| You run the audit | Every rule is extracted, scored, and graded |
| The report lands | Findings first — what can't load, what's risky, what belongs in another mechanism — each a clickable link that opens the rule at its line; the hygiene grade follows at the bottom |
| You check what to apply | Rewrites happen in place; placement candidates get previewed and built on your say-so, or parked with promotion notes |
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
| Open a sortable, expandable HTML report | `/assay:audit --artifact` |
| Grade the repo's files only, not your own | `/assay:audit --project-only` |
| Build a skill that reliably triggers | `/assay:craft-skill` |
| Fix a skill Claude keeps ignoring | `/assay:craft-skill <skill name>` |
| Write a new rule that sticks | `/assay:craft-rules` |

## Under the hood

One scoring script and three skills — the audit with its two rubrics, craft-skill with its trigger recipe, craft-rules with its rule recipe — all there to read in the plugin's files. It reads your Markdown and YAML with real parsers and ships them with it; there is still nothing to install.

## Good to know

- The grade is a **secondary** summary of structural hygiene, printed under the findings. It is not a prediction that Claude will comply; a perfectly clear rule can still lose to the model's habits. Structure is the part you control.
- Scoring is English-only. Rules in other languages will grade wrong; the report counts the ones in a non-Latin script so their numbers aren't mistaken for real grades.
- Promotions are built at project scope, straight from the current official docs — fetched at promotion time, so the formats are never stale. You see each one before it's written, and nothing else gets installed.
- Nothing assay does takes a rule away from you. A promotion adds the mechanism and leaves the prose active; parking only writes down the plan. The duty is then stated twice on purpose — assay says so rather than quietly deleting one copy. A new file is configured, not proven: retiring the prose is your call, later, once you've watched the mechanism work.
- Some files score low because of their shape, not their wording — too much narrative, most of their rules buried low, or just too long. Those land under **Restructure candidates**, which names the fix a per-rule rewrite can't reach: fence the narrative, move the load-bearing rules up, or split the file into scoped rule files.
- Skip a rule you like as-is by putting `<!-- assay-ignore -->` on the line above it. To fence off a whole block of prose that reads like rules but isn't — a motivating story, a pasted requirement, a glossary — wrap it in `<!-- assay-ignore-start -->` and `<!-- assay-ignore-end -->`. Those lines leave the grade entirely, and a real rule below the block is no longer counted as buried under it.
- Dead-glob detection (a scoped rules file whose file patterns match nothing) needs Node 22+; everything else runs on older Node.
- Even a crafted description is a strong hint, not a promise — on any model size. That's why `craft-skill` backs must-run skills with a rule, and names a hook as the only true guarantee.

## License

MIT — see [LICENSE](./LICENSE).
