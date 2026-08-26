<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="assay" width="240" />
  </picture>
  <h1>assay</h1>
  <p><strong>Your CLAUDE.md is full of rules. assay tells you which ones are too vague, too buried, or too big for prose.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — assay reads the instruction files Claude Code loads for your project and tells you what's vague, what's stale, what's buried, and what belongs in a hook instead of a paragraph. One screen of plain English, each problem at its exact line with the fix beside it, and the weak rules get offered rewrites.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise; it can change shape or disappear without a migration path. If it breaks your session, that's the deal you took.

## What is this?

"Write clean, maintainable code" is not a rule — it's a wish. assay reads every instruction file Claude Code loads for your project: `CLAUDE.md` and everything it imports, the rules files beside it, the ones in subfolders and in the folders above, your own setup, and the notes Claude keeps about the project. Each rule is graded on the parts you control — does it say *when it fires* and *what to do*, is it specific, does it sit where the file gets read — and the ones that grade badly get offered a rewrite. An import pointing at a missing file is a finding, not a shrug.

It also spots the rules that were never meant to be prose at all — "run prettier before committing" is a hook pretending to be a sentence — and offers to build that mechanism at project scope, from the current official docs fetched at that moment so the format is never stale, or to note the plan for later. Either way the rule itself stays put and keeps working; deactivating the prose is your own edit to make.

`/assay:craft-rules` and `/assay:craft-skill` write new ones from the same recipes, or refit a skill that never seems to fire. Nothing either one writes lands unreviewed: it goes through the same previewed, reversible transaction as the audit's fixes, and a draft that contradicts a rule you already have is shown to you as a question, not resolved behind your back.

## Why you'd want it

- **You stop guessing which rules are weak.** Every rule gets one finding at its exact line, with the kind of evidence behind it stated plainly. "Never X" with no alternative grades F until it names the replacement, because a ban with nowhere to go stalls a session mid-task.
- **The weak ones get rewritten, not lectured about.** One menu, then the exact patch before you approve it — and every write is reversible.
- **Wishes get unmasked as hooks.** A rule a script could settle for you — pass or fail, no judgment needed — is flagged, with the evidence, instead of burning goodwill as text. assay reads the hooks already wired for the project — from its settings, yours, and installed plugins — so a candidate that's already enforced gets marked covered, not proposed again.
- **Skills and subagents get graded like rules.** A description is how Claude decides to reach for one, and most are written as documentation. Every project skill and subagent is checked against the same trigger recipe — including one whose opening sentence lists so much that the trigger is buried behind it — and the ones missing parts get offered rewrites.

## How it works

| Moment | What happens |
| --- | --- |
| You run the audit | Every rule is extracted, scored, and graded |
| The report lands | One screen: what needs fixing, what a script could own, what's worth a look — each line a clickable link that opens the rule where it lives, with the fix beside it |
| You want the detail | `--verbose` prints the full analysis: coverage, evidence levels, grades, and every mechanism already wired in the project |
| You check what to fix | Every fix becomes a written plan first: the exact old-to-new text, the file it touches, and how it would be checked — if that file changes before you approve, the whole thing stops rather than patching over someone else's edit |
| You approve | Only the changes you name get applied, each one journalled with the file as it was before — then checked, and offered back for rollback if you don't want it |
| You're done | A re-run measures the same rules again and prints the before and after; the clean-up takes the temp files and the undo history with them, and `git diff` shows exactly what changed |

> [!NOTE]
> If a fix is applied and then left neither checked nor undone, every command that reads your files says so before it prints anything, and the clean-up refuses to throw away the undo history until you resolve it.

Almost all of the scoring is a plain script — the same input scores the same every time. The model judges what a script can't: whether a rule's moment is recognizable, whether a tool could enforce it better, and whether a chunk of text is a rule at all, so a page of notes never arrives graded as a page of mandates. `--deterministic` skips every model step; the report still lands and names the checks that did not run, and `--verbose` labels the run deterministic only.

Every report opens by saying what it actually looked at, so a number never covers more than it measured. On a monorepo it says how many rules load only when Claude works in that subfolder, and puts the always-loaded ones first. A file whose problem is its shape rather than its wording — too much narrative, its rules all buried low — gets the advice a per-rule rewrite can't reach. And everything already wired around the repo is listed as an enforcement ladder, from the rules themselves up to remote enforcement: a guardrail that can't fire, like a hook whose script isn't in the project, is a finding, because it protects nothing. Every entry says it is configured; none claim it runs, because assay reads files and never watches anything execute.

Your own files, the ones above the project, and Claude's memory for this project all load here too, so they are graded under their own headings and never inside the project's grade, its advice, or a build gate — the fix for one of those lives in your setup, not in the repo. Those memory notes are Claude's record rather than your policy, so a dated note citing a file that has since been deleted is the record working, not a defect. The wording is still graded, under **User scope** with the rest of your own files.

A repository vendored inside yours — a submodule, or a clone somebody dropped into the tree — gets the same treatment. Its rules do load, so the report names the folder they came from, but nothing inside it lands in your fix list, gets offered a rewrite, or can fail a build. You didn't write those rules, and the next update would overwrite the fix anyway.

The same duty stated twice gets named once, with both locations and which copy looks worth keeping. Two rules that argue get named as a pair with *no* winner — even behind a condition: "When releasing, always pin dependencies to exact versions" against "when releasing, never pin dependencies to exact versions" is a conflict the moment that condition holds, while a rule and its stated exception stay silent. A rule citing a file that isn't there is a finding too; when the file has merely moved, `--verbose` names where it went, so the fix is one edit instead of a hunt — and when several rules or hooks all lean on one path that's gone, that's reported once, as the shared dead target it is.

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/slag
/plugin install assay@slag
```

On Codex, point its plugin install at this repository's `assay/` directory. There the front door is the `$assay` skill: the same audit, the same reviewable fixes, written for that host's own tooling. Either way it needs Node 18 or newer on your PATH — nothing else to install, and nothing to configure. Works at the next session. One check, spotting a rules file whose file patterns match nothing, wants Node 22 or newer; everything else runs on older Node.

## What you can do

| You want to… | Where you run it | Command |
| --- | --- | --- |
| See what's wrong with your rules | Claude Code | `/assay:opus5` |
| The same audit, written for another model | Claude Code | `/assay:sonnet5`, `/assay:haiku45`, `/assay:fable5` |
| Read the whole audit without changing anything | Claude Code | `/assay:opus5 --dry-run` |
| See the full analysis behind the short report | Claude Code | `/assay:opus5 --verbose` |
| Audit what Codex loads instead | Claude Code | `/assay:codex` |
| The same audit, from inside Codex | Codex | `$assay` |
| Write a new rule that sticks | Claude Code | `/assay:craft-rules` |
| Build a skill that reliably triggers | Claude Code | `/assay:craft-skill` |
| Fix a skill Claude keeps ignoring | Claude Code | `/assay:craft-skill <skill name>` |

<details>
<summary>Less common flags</summary>

| You want to… | Command |
| --- | --- |
| Grade the repo's files only, not your own | `/assay:opus5 --project-only` |
| Skip every model step and see what the script alone finds | `/assay:opus5 --deterministic` |
| Also propose duplicates and conflicts that share no words | `/assay:opus5 --semantic` |
| Skip the "is this a rule at all" check | `/assay:opus5 --no-verify` |
| Get the whole record as JSON instead of a report | `/assay:opus5 --json` |
| Show more than the first eight rows | `assay.js report --top 20` |
| Audit a Codex session started in a subdirectory | `/assay:codex --startup <path>` |
| Enforce the findings in a build instead of reading them | `assay.js ci` |
| See every command the engine takes | `assay.js --help` |

</details>

`/assay:codex` audits the instruction system Codex loads instead of the Claude Code one: the `AGENTS.md` files it actually reads, the skills it lists, the hooks wired around them. The findings say what never takes effect and why — a file the host stops reading at its size limit, more skills listed than the shared listing budget holds (one budget for every listed skill together, not one per description), a hook configured but not yet trusted. It is findings only; the hygiene grade stays off, because that rubric carries no evidence for this host. Which files load, in what order, from the start of a session is confirmed against a real Codex install; the size caps, skills and hooks are checked against the documentation only.

`assay.js ci` is the door into a build pipeline: read-only, writes nothing at all, and it fails only on findings a machine can prove — what the host won't load, a rule pointing at a file that isn't there, metadata that doesn't validate. `--fail-on` picks which of those gates apply, from a closed set: fewer than the default four, or the opt-in duplicate and unreadable-config checks on top. Nothing heuristic or model-judged can fail a build, with no flag to opt in.

## Under the hood

One scoring script and five skills — an audit per host from Claude Code, one native door on Codex, craft-skill with its trigger recipe, craft-rules with its rule recipe — all there to read in the plugin's files. Every wording check behind a verdict is explained with a worked example, and the mechanical checks it never scores are listed beside them, in [references/what-assay-measures.md](./references/what-assay-measures.md).

## Good to know

- The grade lives in `--verbose`, as a **secondary** summary of structural hygiene printed under the findings. It is not a prediction that Claude will comply; a perfectly clear rule can still lose to the model's habits, and even a crafted skill description is a strong hint rather than a promise. That's why `craft-skill` backs a must-run skill with a rule, and names a hook as the only true guarantee.
- Scoring is English-only, and assay says so rule by rule. A rule or skill description in another script — or in Spanish, Portuguese, French, Italian, or German — is set aside from the wording checks and from every grade, and named as the language it reads as. Everything that doesn't depend on the language still applies to it: stale references, duplicates, conflicts, what the host loads, the byte budgets.
- Skip a rule you like as-is by putting `<!-- assay-ignore -->` on the line above it, or fence off a whole block of prose that reads like rules — a motivating story, a pasted requirement, a glossary — between `<!-- assay-ignore-start -->` and `<!-- assay-ignore-end -->`. Block quotes are already read as quoted content, so a pasted requirement never grades as a mandate; state a rule in your own voice, outside a quote, if you want it graded.

## License

MIT — see [LICENSE](./LICENSE).
