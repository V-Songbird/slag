<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="assay" width="240" />
  </picture>
  <h1>assay</h1>
  <p><strong>Your CLAUDE.md is full of rules. assay tells you which ones are too vague, too buried, or too big for prose.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — assay analyzes the instruction files Claude Code loads for your project: what's vague, what's stale, what's buried, what belongs in a hook instead of a paragraph. You get a screen of plain English — each problem at its exact line, with the fix beside it — and the weak rules get offered rewrites. `--verbose` opens the full analysis behind it: evidence levels, grades, and everything already wired in your project.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise; it can change shape or disappear without a migration path. If it breaks your session, that's the deal you took.

## What is this?

"Write clean, maintainable code" is not a rule — it's a wish. assay reads the instruction files Claude Code loads for your project — `CLAUDE.md` and every file it pulls in with `@path` imports, `CLAUDE.local.md`, `.claude/rules/`, nested `CLAUDE.md` files in subfolders, `CLAUDE.md` files in the directories above your project, and your own user-level `CLAUDE.md` and `~/.claude/rules/` — and grades each rule on the parts you control: does it name *when it fires* and *what to do*, is it specific, and does it sit where the file gets read. Then it offers to rewrite the ones that grade badly. An import that points at a missing file is a finding, not a shrug.

It also spots the rules that were never meant to be prose at all — "run prettier before committing" is a hook pretending to be a sentence — and offers to build that mechanism, or to note the plan for later. Either way the rule itself stays put and keeps working.

And when the problem is a skill instead of a rule, `/assay:craft-skill` builds one whose description reads as a trigger instead of a summary of itself, or refits a skill that never seems to fire. A skill that must always run gets a rule backing it up — and, when even that isn't promise enough, a hook.

Rules get the same treatment: `/assay:craft-rules` grills you — when should it fire, what replaces the thing you're banning, what does a violation actually look like — then writes one bullet that would survive its own audit, placed where Claude will actually read it. If what you asked for was never a rule at all, it says so instead of writing you a wish.

Nothing either one writes lands unreviewed: it goes through the same previewed, reversible transaction as the audit's fixes, and a draft that contradicts a rule you already have is shown to you as a question, not resolved behind your back.

## Why you'd want it

- **You stop guessing which rules are weak.** Every rule gets one finding at its exact line, with the kind of evidence behind it stated plainly — and a hygiene grade that never overrules a rule the host can't apply.
- **Prohibitions that dead-end get flagged.** "Never X" with no alternative can stall a session mid-task, so it grades F until it names the replacement.
- **The weak ones get rewritten, not lectured about.** One menu, then the exact patch before you approve it — and every write is reversible.
- **Wishes get unmasked as hooks.** Rules a script could enforce with an exit code are flagged, with the evidence, instead of burning goodwill as text. assay reads the hooks already wired for the project — from its settings, yours, and installed plugins — so a candidate that's already enforced gets marked covered, not proposed again.
- **The same duty stated twice gets named once — and two that argue get named as a pair.** A rule copied from `CLAUDE.md` into a scoped rules file is flagged with both locations and which copy looks worth keeping. A rule that bans what another one commands is flagged with both addresses and *no* winner: assay names the disagreement, says which file the host reads last, and leaves the policy call to you. The grade doesn't move either way.
- **Stale references get caught — and traced.** A rule citing a file that no longer exists is worse than no rule. assay reads the paths in backticks *and* in markdown links, and when the file has merely moved, `--verbose` names where it went, so the fix is one edit instead of a hunt.
- **Skill descriptions written as triggers.** A skill's description is how Claude decides to use it; most are written as documentation instead. Crafted ones name the moment.
- **Skills you already have get graded too.** The audit checks every project skill's description against the same trigger recipe and offers to rewrite the ones missing parts — including one whose opening sentence lists so much that the trigger is buried behind it. Subagent descriptions in `.claude/agents/` get the same treatment — they route by description exactly like skills do.
- **Broken hooks get named.** A hook whose script isn't in the project, a matcher that won't compile, or a settings file that won't parse — each is a finding on the enforcement ladder, because a guardrail that can't fire protects nothing.
- **Contradictions are caught even behind a condition.** "When releasing, always pin dependencies to exact versions" against "when releasing, never pin dependencies to exact versions" is a conflict the moment that condition holds, and it's reported as one — while a rule and its stated exception stay silent. And when several rules or hooks all lean on one path that no longer exists, that's reported once, as the shared dead target it is.

## How it works

Almost all of the scoring is a plain Node script — deterministic, the same input scoring to the same grades. The model judges what a script can't: whether a rule's trigger moment is recognizable, whether a tool could enforce it better, and whether an extracted chunk is a rule at all. Then the script composes the report.

The model steps are optional. `--deterministic` runs the audit offline: the report still lands, and its opening line names the checks that did not run. Each score is computed over the factors that were measured. When the model does judge, the audit records which model, which rubric version, and when.

Before the report, one more question gets asked of each doubtful entry: is this a rule at all? A file of notes or history would otherwise arrive graded as a page of mandates. The answer can only drop an entry from the report — nothing is ever rescored or reworded — and `--verbose` lists every drop with the reason. It costs one model call per audit; `--no-verify` skips it.

Every report opens by saying what it actually looked at. Under `--verbose` that becomes a full coverage account: every line of every file it read is graded, set aside, ignored on purpose, or named as something assay couldn't parse — and any file it couldn't read at all is named. A number in the report never covers more than that.

Your user-level `CLAUDE.md` and `~/.claude/rules/` load for this project too, so they get graded — but under their own **User scope** heading, and never inside the project's grade. The fix for one of those rules lives in your setup, not in the repo. The same goes for `CLAUDE.md` files in directories above your project: they load in full at launch, so they're graded under **Above the project root**, apart from the project's numbers. `--project-only` leaves all of them out.

Claude's own memory for this project loads too, and assay reads it so you can see what's in your context — the always-loaded index and the topic files behind it. Those are notes Claude wrote, not rules you set, so a dated note citing a file that has since moved is the record working, not a defect. Nothing there is reported as a rule the host can't apply, and none of it reaches the project's grade, the restructure advice, or a build gate. The wording is still graded, under **User scope** with the rest of your own files, so you can see what's in the context and fix it where it lives. The short report says how many rules load from outside the repo, so the number you see never quietly covers more than the repo.

| Moment | What happens |
| --- | --- |
| You run the audit | Every rule is extracted, scored, and graded |
| The report lands | One screen: what needs fixing, what a script could own, what's worth a look — each line a clickable link that opens the rule where it lives, with the fix beside it |
| You want the detail | `--verbose` prints the full analysis: coverage, evidence levels, grades, and every mechanism already wired in the project |
| You check what to fix | Every fix becomes a written plan first: the exact old-to-new text, the file it touches, and how it would be checked |
| You approve | Only the changes you name get applied, each one journalled with the file as it was before — then checked, and offered back for rollback if you don't want it |
| You want to know if it helped | A re-run measures the same rules again and prints the before and after |
| You're done | Temp files are cleaned up, and the undo history with them; `git diff` shows exactly what changed |

> [!NOTE]
> If a fix is applied and then left neither checked nor undone, every command that reads your files says so before it prints anything, and the clean-up refuses to throw away the undo history until you resolve it.

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/slag
/plugin install assay@slag
```

On Codex, point its plugin install at this repository's `assay/` directory.

Needs Node 18 or newer on your PATH — nothing else to install, and nothing to configure. Works at the next session.

## Codex

`/assay:codex` audits the instruction system Codex loads instead of the Claude Code one: the `AGENTS.md` files it actually reads, the skills it lists, and the hooks wired around them. The findings say what never takes effect and why — a file the host stops reading at its size limit, more skills listed than the shared listing budget holds, a hook configured but not yet trusted. A Codex report is findings only; the hygiene grade stays off, because that rubric carries no evidence for this host.

`--startup <path>` audits a session that begins in a subdirectory, since the chain runs from the project root down to wherever the session started.

assay also installs on Codex itself — the same plugin, pointed at this repository's `assay/` directory. There the front door is the `$assay` skill: the same audit, the same report, and the same reviewable fixes, written for that host's own tooling — nothing a Codex session loads mentions Claude Code. The engine CLI sits underneath it, as it does here.

> [!NOTE]
> Codex support is built from the official Codex documentation, and a real
> Codex install has confirmed the core of it: which files load, in what order,
> from the start of a session. The size caps, skills, and hooks are checked
> against the documentation only, not yet against a live host.

## What you can do

| You want to… | Where you run it | Command |
| --- | --- | --- |
| See what's wrong with your rules | Claude Code | `/assay:claude` |
| Apply the rewrites without the menu | Claude Code | `/assay:claude --fix` |
| See the full analysis behind the short report | Claude Code | `/assay:claude --verbose` |
| Audit what Codex loads instead | Claude Code | `/assay:codex` |
| The same audit, from inside Codex | Codex | `$assay` |
| Write a new rule that sticks | Claude Code | `/assay:craft-rules` |
| Build a skill that reliably triggers | Claude Code | `/assay:craft-skill` |
| Fix a skill Claude keeps ignoring | Claude Code | `/assay:craft-skill <skill name>` |

<details>
<summary>Less common flags</summary>

| You want to… | Command |
| --- | --- |
| Grade the repo's files only, not your own | `/assay:claude --project-only` |
| Skip every model step and see what the script alone finds | `/assay:claude --deterministic` |
| Also propose duplicates and conflicts that share no words | `/assay:claude --semantic` |
| Skip the "is this a rule at all" check | `/assay:claude --no-verify` |
| Get the whole record as JSON instead of a report | `/assay:claude --json` |
| Show more than the first eight rows | `assay.js report --top 20` |
| Audit a Codex session started in a subdirectory | `/assay:codex --startup <path>` |
| See every command the engine takes | `assay.js --help` |

</details>

Every wording check behind a verdict is explained with a worked example, and the mechanical checks it never scores are listed beside them, in [references/what-assay-measures.md](./references/what-assay-measures.md).

## Under the hood

One scoring script and five skills — an audit per host from Claude Code, one native door on Codex, craft-skill with its trigger recipe, craft-rules with its rule recipe — all there to read in the plugin's files. It reads your Markdown and YAML with real parsers and ships them with it; there is still nothing to install.

## Good to know

- The default report is short on purpose, and mechanically so: a release test fails the build if it runs past 40 lines, names one rule in two places, or uses a word you'd need the Claude Code docs to read. Every number, score, evidence level and grade still exists — `--verbose` prints them, and the JSON record carries all of it either way.
- The grade lives in `--verbose`, as a **secondary** summary of structural hygiene printed under the findings. It is not a prediction that Claude will comply; a perfectly clear rule can still lose to the model's habits. Structure is the part you control.
- Scoring is English-only, and assay says so rule by rule. A rule or skill description in another script — or in Spanish, Portuguese, French, Italian, or German — is set aside from the wording checks and from every grade, named as the language it reads as, and counted that way in coverage. Everything that doesn't depend on the language still applies to it: stale references, duplicates, conflicts, what the host loads, the byte budgets. Scoring the wording of a new language would take an analyzer validated for that language; assay detects and discloses instead of guessing.
- `assay.js ci` is the build-pipeline entry point: deterministic, read-only, and it writes nothing at all. It exits non-zero only on findings a machine can prove — what the host won't load, a rule pointing at a file that isn't there, metadata that doesn't validate — and `--fail-on` picks which of those gates apply, from a closed set: fewer than the default four, or the opt-in duplicate and unreadable-config checks on top. Nothing heuristic or model-judged can fail a build, with no flag to opt in. Wire it into your CI when you want the report enforced rather than read.
- Promotions are built at project scope, straight from the current official docs — fetched at promotion time, so the formats are never stale. You see each one before it's written, and nothing else gets installed.
- The report lists what's already wired around the repo — skills, subagents, hooks, npm scripts, CI workflows — as an enforcement ladder, from the rules themselves up to remote enforcement. Every entry says it is configured; none of them claim it runs, because assay reads files and never watches anything execute.
- Nothing assay does takes a rule away from you. A promotion adds the mechanism and leaves the prose active; parking only writes down the plan. The duty is then stated twice on purpose — assay says so rather than quietly deleting one copy. Deactivating the prose is your own edit to make, and keeping it as documentation is a perfectly good answer.
- Every write goes through a plan you see first. If the file changed since the plan was drawn up, the whole thing stops rather than patching over someone else's edit. Whatever does land is recorded with the file exactly as it was, so one command puts it back — including after an interrupted run.
- Some files score low because of their shape, not their wording — too much narrative, most of their rules buried low, or just too long. Those land under **Restructure candidates**, which names the fix a per-rule rewrite can't reach: fence the narrative, move the load-bearing rules up, or split the file into scoped rule files.
- Block quotes are read as quoted content, not as rules — a pasted requirement or a retro line never grades as a mandate. State a rule in your own voice, outside a quote, if you want it graded.
- Skip a rule you like as-is by putting `<!-- assay-ignore -->` on the line above it. To fence off a whole block of prose that reads like rules but isn't — a motivating story, a pasted requirement, a glossary — wrap it in `<!-- assay-ignore-start -->` and `<!-- assay-ignore-end -->`. Those lines leave the grade entirely, and a real rule below the block is no longer counted as buried under it.
- Dead-glob detection (a scoped rules file whose file patterns match nothing) needs Node 22+; everything else runs on older Node.
- `--semantic` is optional and off by default. It lets the audit propose duplicates and conflicts that share no words — the kind no mechanical check finds. Every one is labelled model-proposed, you accept or reject it in conversation, and none of them move a score or a grade.
- Even a crafted description is a strong hint, not a promise — on any model size. That's why `craft-skill` backs must-run skills with a rule, and names a hook as the only true guarantee.

## License

MIT — see [LICENSE](./LICENSE).
