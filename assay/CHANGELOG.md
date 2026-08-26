# Changelog

All notable changes to assay are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [2.0.0] — 2026-08-25

### Removed

- **Breaking.** `/assay:claude` is gone. Four commands replace it, one per model: `/assay:opus5`, `/assay:sonnet5`, `/assay:haiku45` and `/assay:fable5`. They run the same audit and differ only in who the advice is written for
- **Breaking.** `--fix` is retired everywhere it shipped, on both hosts. `--dry-run` is the flag now: the audit runs and the report prints, but nothing is offered to write and nothing is written

### Added

- `/assay:revert` takes back a whole run in one command, by Git or by the copies assay kept. Files the run created are deleted again, and a run that cannot be undone completely is refused whole rather than half-applied
- Every run records itself before it writes anything, so a batch interrupted halfway is still a run that revert can find. A run already taken back refuses to be taken back twice
- Without a repository, every file a run will touch is copied aside first, so the undo works with no version control at all
- Applying a fix now stops on a dirty working tree and names the paths, rather than mixing its writes into changes you have not committed
- `assay.js report --plain` is a third report beside the short one and `--verbose`: simple English, worst finding first, no grades or codes, ending with every hook it would install named by event and matcher
- The scoring weights and thresholds are a named model profile now, and four ship — one per command. Only the Haiku 4.5 column has ever been measured; the other three say so on every constant they carry

### Changed

- `clean` no longer removes assay's own directory wholesale. The undo history and the copies it holds outlive it; only the temporary working files go

## [1.16.0] — 2026-08-18

### Added

- A repository vendored inside yours — a submodule, or a clone dropped into the tree — is recognized as somebody else's. Its instruction files still load, so the report names the folder, but nothing inside it is counted in your fix list, offered a rewrite, or able to fail a `ci` run
- `--semantic` now also proposes the near misses the script drops on its own: two rules that command the same thing with opposite polarity but share too few words to call it a contradiction. A proposal, never a finding — it changes no count, no grade and no build
- A skill whose description carries several of the shapes the current routing guidance argues against is named as one written against older advice, so it is one rewrite instead of several patches
- After a re-measure, a file whose grade rose while its rules, its dead references and its disagreements all stayed put is called out. A grade can rise because a rule got better or because it picked up the words the rubric rewards, and only reading both versions tells them apart
- `validate` accepts `--host`, which it always did; the help text now says so

### Changed

- The fix table gives every kind of problem a row before any kind gets a second. A project with twenty dead paths and twenty weak rules used to get eight dead paths and a closing line offering to rewrite weak rules it never showed you
- The line under the table says what it left out and of what kind, and names the flag that shows more
- "Looked at N rules in M files" counts every file the report read, so it agrees with the list of files named beside it. A file that was read and held no rule is still a file that was looked at
- Files with the same shape problem share one row in **Also worth a look** instead of repeating one identical sentence per file
- `--project-only` is refused by the commands that do not scan, instead of being accepted and ignored
- Every proposed relationship says whether the model proposed it or a script did

### Fixed

- The `$assay` skill on Codex was missing three guards its sibling had: it could offer a fix menu with no report behind it, it could rewrite a skill description against a recipe that host does not grade, and it described a file as shadowed from further up the chain when shadowing there is same-directory only
- The changelog entry for the live Codex host check named a path that does not exist and is not part of the installed plugin

## [1.15.0] — 2026-08-13

### Added

- `assay.js --help` prints the commands and exits 0. The list now says which ones you run and which the skill drives on your behalf
- **Repair dead references** is an option in the fix menu. The engine could already do it; nothing offered it
- After a fix is applied, the audit re-measures and shows you the before and after
- A page explaining every wording check behind a verdict, with a worked example each, and the mechanical checks it never scores — [references/what-assay-measures.md](./references/what-assay-measures.md), linked from `--verbose`
- A skill or subagent description whose opening sentence lists too much is now flagged. That opening is what a description is routed on
- `scan` writes a `.gitignore` into its own temp directory, so a first run leaves nothing in your working tree
- `scan`, `report` and `ci` now say up front when an earlier fix was left half-finished
- The requirement is stated where you install: Node 18 or newer on your PATH, and the one line that installs assay on Codex
- Every finding in `--verbose` now prints its own next step under it
- Duplicated rules reach the short report. One duty written twice is one row naming every place it appears, with the copy worth keeping named
- `report --top <n>` shows more rows without dropping into the full analysis
- `assay.js ci` prints the repair beside each failure
- The report now says what it read and what it did not check. One line under the headline names the files it looked at, any file it could not open, and any whole check that never ran — a run with no model behind it, a corpus too large to compare rule against rule, a host whose wording checks do not apply, or rules written in a language assay does not score
- A rule pointing at a missing `@path` import is now a finding. The host pulls that file into the session, so a dead one is reported beside every other dead path instead of grading well
- `assay.js ci` prints what it looked at — rules, files and skills — so a run that scanned nothing no longer reads like a clean project
- A file assay could not read now fails a `ci` run by default

### Changed

- The fix menu is written in plain words. Building a mechanism and writing the plan down are labelled as what they do, and both say they cover the same items
- Skill descriptions and subagent descriptions are two options, matching the two headings in the report
- Before applying a rewrite, assay points out any path, name or number the new wording introduces that the old one did not have
- Approval is collected in a surface that has one — a question with the changes as options, or a numbered list you answer
- `clean` says what it destroys: removing the change journal removes the undo, and it names any plan it kept instead of counting them
- A broken judgments file reports its problems grouped by cause, with each rule's file and line, and names the recovery that needs no model at all
- Error messages name commands you can actually type
- craft-rules asks its questions in one order, says why each answer matters, and has an answer for "I don't know". A request it will not write as a rule now comes back with the closest rule it could write, the one answer that would unlock it, and where else to take it
- craft-skill shows the old description beside the new one when refitting, and says in the close why the old one was not firing
- `--json` writes the record to a file and tells you the path, instead of printing a thousand lines into the conversation
- On a monorepo, the report says how many of the rules load only when Claude works in their own folder, and puts the always-loaded ones first
- On Codex the report no longer offers a flag that host does not take
- "Claude keeps ignoring my instructions" now routes to the audit rather than to writing a new rule
- The audit says what it found and roughly how long the grading takes before it goes quiet, and cleans up after itself when there was nothing to grade
- `--verbose` is roughly half the length it was. Limits true of every wired mechanism are stated once per section, the enforcement ladder is one line per mechanism carrying what it reaches, and mechanisms inherited from your settings and installed plugins are summarized by source; the rest is still in `--json`
- The full report opens with a one-line contents list
- "All rules" covers this project's rules; everything else is still in `--json`
- Both reports now use the same words for the same problem. The full one adds the score and the kind of evidence around that sentence instead of replacing it with a terser one
- Every state word in the full report gets a one-line legend, and the tick-and-cross chain after each mechanism is gone — a state that is switched off is named, and the rest is stated once
- The full report drops the terms that needed the rubric to read: the first rung of the ladder is "the rules themselves", and a run with no model behind it says so in plain words
- Lists of rules from outside the repository are capped, with the count and a pointer at `--json`
- Notes about a surface your project does not have — auto memory, saved workflows — no longer open the report
- "3 could be handled by a script instead" says what it is counting
- Claude's own memory notes for a project are no longer graded as project rules. They are read and listed, so you can see what is in your context, and they stay out of the fix list, out of the counts the grade averages, and out of the restructure advice
- A dated note citing a file that has since been deleted is no longer reported as a rule the host cannot apply. That is the note working
- Nothing outside the repository can fail a `ci` run any more — not your own instruction files, not the ones above the project root, not the memory notes. They are still reported, and `ci` says how many files it saw that the checkout does not contain
- The short report says how many rules load from outside the repo, and names the flag that leaves them out. That sentence used to be pushed last into a capped list and cut
- "Rules across N files" in the full report now counts the rules the grade beside it actually averages
- The full report's hard gates are the project's own. A gated rule in a file outside the repo is still reported, under the section for the files it lives in
- A file that declares its own kind in its frontmatter is read instead of being reported as something the parser could not handle
- The list of rules sent for judging now carries which file each one came from, so notes can be set aside by where they live instead of guessed at from their text
- "Too vague to act on" now quotes the words that made it vague, and asks for what passes instead of a path the rule may not have
- A rule a script could own gets that as its fix, instead of a wording lecture
- A rule a wired hook already covers is no longer proposed for automation. It gets its own line saying to check the hook first
- The closing line follows the table above it: a rewrite offer when something is weak, the manual decisions when there are dead paths or disagreements, `/assay:craft-skill` when a description never fires
- "4 rules sit near the bottom of a long file" now names the file and links it
- The fix for a rule with no clear action asks for the action, not for four specific opening words
- A rule that cites a missing file is no longer reported as one the host never loads. It loads fine; the path is what is gone, and the report now says that and offers the fix that repairs it
- Every "the host never loads this" row now carries the analyzer's own reason and its own next step, instead of one sentence written for every case
- Missing paths get their own line in the headline, apart from rules that need rewording
- Two rules that disagree are one row even when the same pair is written into several files — one decision, named once, with every location
- A rule explained after a semicolon or a full stop is compared on the part that gives the order. An added "; the gateway does it" used to hide the disagreement entirely
- A project with no rules is no longer congratulated. It says there is nothing to look at yet and points at `/assay:craft-rules`
- Run from a subdirectory, assay now finds the project root by looking upward instead of auditing wherever you stood

### Fixed

- Validating a rewrite finds the rewritten rule and says where it is now. It used to report that the rule "no longer exists" beside a pass
- The weak-rules table no longer prints a per-rule state beside the grade — a rule with nothing else wrong read as "healthy" in a table headed "Weak rules"
- Paths render the same way everywhere: no raw backslashes in a link, no full home directory in a shareable report
- `--root` at a path that does not exist is refused instead of silently creating the directory and reporting it clean; `--root` at a file says so instead of throwing
- `report` refuses a `.assay-tmp/scan.json` taken from another project instead of rendering a full report about files that are not here
- `report`, `plan`, `apply`, `clean` and `rollback` refuse `--host` instead of accepting it and quietly ignoring it — the flag belongs to the commands that scan
- Under `--project-only`, the hook inventory no longer reaches past a configured user directory into the real home folder

## [1.10.0] — 2026-08-06

### Added

- assay now reads Claude Code's auto-memory — the `memory/` folder loaded at the start of every session. It grades the `MEMORY.md` index like any other always-loaded file and treats the topic files as loaded on demand. A rule sitting past the point where the index stops loading — its first 200 lines or 25 KB, whichever comes first — is reported as one the host will not actually load
- On the Claude host, a mostly-prose memory or instruction file that could be trimmed now points you at `/doctor` for the cut; the tip never appears under Codex

### Changed

- Each wording severity in the report now names the model tier it applies to
- A short, mostly-prose `CLAUDE.md` is no longer flagged as a restructure candidate
- Refreshed what assay knows about the Claude host for the current model generation: the memory index budget, the skills description cap, and where `/doctor` and workflows now live

## [1.9.0] — 2026-08-05

### Added

- Installed on Codex, assay now has a front door of its own: the `$assay` skill audits what that host loads — the `AGENTS.md` chain, the skills it lists, the hooks wired around them — then judges, reports, and runs the same reviewable fix transaction the Claude Code commands use. Nothing a Codex session loads mentions Claude Code. The engine CLI is still there underneath

### Fixed

- `remeasure` on a project with no `.assay-tmp/` directory no longer crashes with a stack trace; it scans and reports the way `scan` already did
- Validating a fix from a `--startup` audit now re-checks the same root-to-startup chain the audit read, not the project root alone
- `report`, `plan`, `apply` and `rollback` now refuse `--startup` instead of accepting it and quietly doing nothing with it — the flag belongs to the commands that scan

## [1.8.0] — 2026-08-01

### Removed

- **Breaking.** `--artifact` and the HTML report are gone. Every location in the markdown report is already a link that opens the rule where it lives, which is what the page was for
- **Breaking.** The `retire` command is gone. Nothing assay runs takes a rule out of your files now — a promotion adds the mechanism beside the prose, and removing the prose afterwards is your own edit. `rollback` still undoes anything assay wrote
- **Breaking.** Attaching a saved measurement to a rule is gone, along with the `link` command, the `--proof` argument to `validate`, and the report section that showed it. It only ever worked if you matched a record to the right rule by hand, and the short report never showed the result
- The two release-tooling scripts no longer ship inside the plugin. They were never yours to run

### Changed

- The audit skill loads about 145 fewer lines every session: the instructions for writing and applying a fix moved back into a reference file the fix step opens when a fix is actually approved

## [1.7.0] — 2026-08-01

### Added

- `/assay:codex` is its own command: it audits what Codex loads for a project — the `AGENTS.md` chain, the skills it lists, and the hooks wired around them. `--startup <path>` audits a session that begins in a subdirectory

### Changed

- **Breaking.** The audit is now `/assay:claude`. `/assay:assay` is gone; there is one command per host, and each one names the host it audits
- The audit skill is shorter — six steps and one subagent call, with the instructions for applying a fix now inside the step that applies it

### Removed

- You no longer pass `--host` or `--startup` to a command yourself. Each audit command already knows its host and supplies both for you; `/assay:codex` still takes `--startup <path>` when the session begins in a subdirectory. `/assay:craft-rules` and `/assay:craft-skill` write for Claude Code only — authoring for Codex is no longer offered
- The Codex plugin manifest no longer advertises a skills directory. Those skills are written for Claude Code's tooling and could not run there; on Codex, assay is the engine CLI

### Fixed

- A path holding a space, `(`, `)`, `#`, `?` or `|` now produces a link that opens everywhere in the `--verbose` report; it used to render as plain text at several of those places
- Rule text in the HTML report and in the saved record no longer carries the backslashes that only a markdown table needs

## [1.6.0] — 2026-07-29

### Added

- Weak subagent descriptions now appear in the report beside weak skill descriptions
- Weak rules of your own, from files that load from outside the repository, are named rather than left out — the fix for those lives in your setup, so the report points at them instead of listing them for rewriting

### Changed

- `/assay:assay` now gives you a short report in plain English: what needs fixing, what a script could handle instead, and what's worth a look — each problem at its exact line with the fix beside it. Scores, letter grades, evidence labels and factor codes are gone from it
- Each rule is reported **once**, under its worst problem, instead of once per section with something to say about it
- `--verbose` prints the full report that used to be the default — coverage, evidence labels, grades, the enforcement ladder, and everything already wired in the project. Nothing was removed, and the JSON record is unchanged
- An empty section no longer prints. A report with nothing to fix says so in one line
- `remeasure` prints the full report

### Fixed

- A `|` in a rule, a path, or the reason a rule cannot load no longer breaks the report table, and a path containing `|`, `(`, `)`, a space or `]` still opens as a link
- A truncated list now says how many entries it withheld, counting all of them
- A subagent description over the listing cap is now flagged, and one with no `description:` line at all is named in plain words instead of by its field name

## [1.5.0] — 2026-07-28

### Added

- Two rules gated on the same condition that ban and command one action are reported as a conditional conflict — "when releasing, always X" against "when releasing, never X". A conditional rule facing an unconditional opposite stays silent on purpose: that shape is a rule and its exception. The pair joins the Conflicts section, the CI `conflicts` gate, and the relationship graph
- One missing path that several rules or hooks still point at is reported once as a stale shared target, naming every dependent — restoring the one file fixes the whole set. Mechanical, and part of the CI `stale-targets` gate
- Personal rules in `~/.claude/rules/` are discovered and graded under **User scope**, scoped `paths` frontmatter respected, without moving the project grade
- `CLAUDE.md` and `CLAUDE.local.md` files in directories above the project root are discovered and graded under a new **Above the project root** section — the host loads them in full at launch, outermost first. `--project-only` leaves them out, and they never move the project grade
- A live Codex host check starts real Codex sessions over a sentinel-token `AGENTS.md` chain and verifies the installed host loads it the way assay models it — chain order, delivery at session start, and `AGENTS.override.md` selection. Manual, like the doc-drift check, because each run spends two live sessions. It is a maintainer's script in this repository and is not part of the installed plugin

### Changed

- `@path` imports now stop at four hops, matching the host documentation's current recursion cap; the fifth hop is disclosed as beyond the cap instead of read

### Fixed

- The instruction chain table's `#` column now counts read order, matching the "chain position N of M" the Why column describes; a shadowed variant gets no number. It printed the precedence rank, which starts at 2
- Retiring a rolled-back change now refuses by naming the rollback and the missing validation, instead of a message about a missing retirement patch or an empty journal

## [1.4.0] — 2026-07-28

### Changed

- The audit skill is now `/assay:assay` — the plugin's name is its front door. The old `/assay:audit` slash command is gone, though asking for an audit in words still routes there; the flags are unchanged

## [1.3.0] — 2026-07-28

### Added

- Wired hooks are checked, not just counted: a hook whose script is missing from the project and a matcher that will not compile as a pattern are both findings, named on the enforcement ladder beside the level that counts them
- Subagent descriptions in `.claude/agents/` are graded on the same trigger recipe as skill descriptions, with weak ones listed in their own section — they were previously counted and never read
- Rules citing a backslash path with a file extension — `` `scripts\release.md` `` — are now checked for staleness like their forward-slash siblings

### Changed

- Block-quoted lines are treated as quoted content, never as rules. A pasted requirement or a retro line no longer grades as a live mandate
- Your own user-scope weak rules now render under **User scope** with `~/` paths, instead of inside the project's fix list with an absolute path the report should not carry
- The full hook command line is kept on the audit record, so secret masking and the new target checks read the real command; reports still show the short script name

### Fixed

- A `.claude/settings.json` that exists but will not parse is reported as a hole in the enforcement ladder. It was silently treated as absent, which also made assay propose hooks the project already had

## [1.2.0] — 2026-07-28

### Added

- `@path` imports in `CLAUDE.md` files are now followed. Every imported file is discovered, graded, and counted in coverage, recursively up to the host's documented 5-hop depth. An import pointing at a missing file is reported with the importing file and line; a cycle is read once; a file past the hop cap is disclosed instead of silently skipped. Imports inside code fences and inline code never fire, and a bare `@mention` or an email address is left alone
- A `CLAUDE.md` in a subdirectory is now discovered and its rules graded. The report marks it as loading only when Claude works in that directory, and its bytes never count toward the always-loaded total. `node_modules` and dot-directories are not walked
- The Coverage block counts imported and nested files separately, so "files parsed" is never read as "files sitting beside the root"

## [1.1.0] — 2026-07-28

### Added

- A `--startup <path>` flag on `scan`, `remeasure`, and `ci` audits the Codex instruction chain for a session started in a subdirectory of the project root. Only profiles that model a startup directory accept it — today, that is `codex`

### Changed

- The Codex profile is now an adapter preview: on Codex the supported surface is the engine CLI — `scan`, `report --json`, `ci`, and the transaction commands — and the packaged skills and workflows assume Claude Code's tooling
- When one change in a batch fails and is restored, the error now names the changes already applied and left in place

### Fixed

- Retiring a rule now requires the change's latest validation run to have passed in full. A failed validation blocks `retire`, and blocks `clean` from deleting the change journal
- Every write and restore refuses a path that resolves outside the project root, including through symlinks and junctions — even if a plan file was edited after approval
- A plan file whose content no longer matches its content-derived id is rejected when read
- A plan carrying two patches to the same file in one change is rejected
- `rollback` refuses when a file changed after assay wrote it, so later edits are never discarded silently; `--force` overrides and discards them
- `<tag>`-wrapped blocks other than `<example>` are disclosed in coverage as set-aside regions instead of being skipped without a mention
- Stale-reference checking no longer flags quoted tokens used as illustrative examples, or bare single-segment directory names like `hooks/`

## [1.0.0] — 2026-07-28

### Added

- A saved measurement result can now be attached to the exact rule, skill, finding, or planned change it measured, and the report shows it beside that anchor: verdict, lift, confidence interval, how many runs, what they cost, the tasks they covered, and the date. It is evidence next to the finding — it never moves a score, a state, or a grade
- Each link records the conditions the measurement ran under — host, host version, model, which measurement produced it, and when — read straight out of the saved result. Whatever the result doesn't state is named as missing instead of filled in
- Several results for the same rule are listed oldest first, so a behavior that moved over time reads as a history rather than a single number
- A result measured against wording you have since edited still appears, labelled as having measured the earlier text
- A link whose saved result has moved or gone unreadable is reported as unavailable evidence, along with what it once recorded — never silently dropped
- Links are attached by hand and only by hand: assay never decides on its own that a measurement was about a particular rule. Cleanup keeps them, because no rerun regenerates a measurement
- Rules and skill descriptions written in Spanish, Portuguese, French, Italian, or German are detected and set aside from the English wording checks instead of being scored as bad English. Each one names the language it reads as, and the report says plainly that the wording checks were skipped and which checks still ran
- A set-aside rule keeps every finding that doesn't depend on the language — stale references, duplicates, conflicts, what the host loads, the byte budgets — and no longer drags its file's grade or the corpus grade
- Coverage counts the set-aside rules and skill descriptions per language, so a report's numbers never quietly cover text the rubric couldn't read
- A new `assay.js ci` command for build pipelines: it scans, evaluates, prints a summary, and writes nothing at all — no records, no state, no temp files. Exit 0 when nothing gated fires, 2 when a gate fails, 1 on a usage error
- `--fail-on` picks which gates may fail a build from a closed set: availability, schema, stale-targets, conflicts, duplicates, malformed-config. Omitted, the first four apply. Anything else is refused with the list, and only findings computed from files, paths, and configuration can ever fail a build — heuristic and model-judged findings stay advisory with no way to opt in
- `assay.js ci --json` emits a stable, sorted, timestamp-free summary, so two runs over an unchanged project produce identical output
### Changed

- A rule in a script assay can't read carries no grade at all — the score is withheld and the reason is stated beside the rule
- A very large corpus no longer crashes the report. Past 500 rules the report says plainly that duplicate and conflict detection did not run, and every other check still applies. It is stated as coverage, so it never fails a build
- A change record damaged anywhere but its last line is now refused, naming the file and the line. A half-written final line is still treated as an interrupted write and resolved as before — but a record damaged further up holds the only copy of your files as they were, and it is no longer read past in silence

## [0.9.0-alpha] — 2026-07-28

### Added

- Fixes are now one reviewable transaction. Everything you approve becomes a written plan first — the exact before-and-after text, every file it touches, why that mechanism fits, and how the result would be checked — and you see the plan before anything is written
- Only the changes you name get applied. There is no apply-everything shortcut: an approval is a list of changes, and a change you didn't name stays unapplied even when the plan carries it
- A plan drawn up against a file that has since changed is refused outright, naming the file — assay never patches over an edit it didn't see
- Every write is recorded with the file exactly as it was beforehand, so any change can be put back with one command: after a failed check, after a run interrupted mid-write, or simply because you changed your mind
- A write that produces an unreadable file — broken skill frontmatter, invalid hook JSON — is undone automatically and reported, instead of being left on disk
- Applied changes get checked: the written file re-parses, the analysis re-runs and reports what moved, and a promoted skill or hook is confirmed to be somewhere the host will find it. Your own test suites and fresh-session checks are recorded as results you report, never run by assay
- Retiring a rule a new mechanism replaced is now its own command, and it refuses to run until the replacement has been checked and passed. It reminds you that keeping the prose as documentation is a legitimate outcome
- Parking a placement candidate now records it in the plan itself, with its promotion note and its limits, instead of a separate notes file
- `/assay:craft-rules` and `/assay:craft-skill` build for either host. Add `--host codex` and they write to that host's own instruction files and skill directories, ask about the scope that host actually has, and require the metadata that host actually documents
- A drafted rule is checked against the rules already active before it is offered. One that bans what an active rule commands is shown to you with both texts and their exact lines, and is not written until you say which policy you meant — assay never picks the winner. A draft that only restates an existing rule is named as the duplicate it is
- A crafted skill is checked after it lands: the file parses, its frontmatter carries what the host requires, every file it references exists, any metadata sidecar parses with its declared tool dependencies named in the preview, and the host profile is asked whether it actually finds the skill
- Where a host has no measured evidence for the trigger recipe, a crafted skill is no longer written to it or scored against it. It gets that host's own required metadata, its explicit-versus-implicit invocation setting, and its tool dependencies instead — and the skill says plainly that no recipe score exists there

### Changed

- Cleanup keeps the change record whenever an applied change hasn't been checked, rolled back, or retired yet, and says which ones — the record holds the only copy of your files as they were. It removes the record once everything is resolved, and never removes a parked plan
- Neither craft command writes a file directly any more. A rule, a skill, its metadata, a companion rule, a hook — each is planned first, shown to you as exact text, applied only for the changes you name, checked afterwards, and reversible with one command
- A skill metadata sidecar that isn't valid YAML is now undone automatically after the write, the way broken frontmatter already was, instead of being left on disk

## [0.8.0-alpha] — 2026-07-28

### Added

- assay can audit a second host. `--host codex` discovers the `AGENTS.md` instruction chain Codex reads — `AGENTS.override.md` over `AGENTS.md` over configured fallback names, in every directory from the project root down to where the session starts — and the report shows the resolved chain: read order, running byte total, and the host's documented combined byte cap applied where the host applies it
- A Codex report is findings-first and grade-free: shadowed files, files past the byte cap, stale references, conflicts, duplicates, and bare prohibitions all land as findings, and no structural-hygiene grade is printed for a Codex report
- `--host codex` now finds the skills Codex loads: every `.agents/skills` directory along the chain, plus the ones a plugin bundles. A skill missing the `name` or `description` the host requires is flagged, its `agents/openai.yaml` is read for whether it routes itself or waits to be named, and one name defined at two levels is reported as two skills rather than a merge
- The report models the character budget Codex holds its initial skill list to, and names the longest descriptions when the list overruns it — past that budget a skill can exist, read well, and never be offered
- Codex hooks are inventoried from every configured source at once — `hooks.json`, inline `[hooks]` config tables, enterprise-managed policy, and plugin bundles — with none of them collapsing another. Each says what it is: configured, with trust unconfirmed, because the trust record is a hash the host keeps and no file read reaches. An `allow_managed_hooks_only` policy shows the sources it switches off, and a hook it switches off no longer marks a rule already covered
- A hook configuration file that exists and cannot be parsed is reported as a hole in the enforcement ladder instead of counting as nothing configured
- assay ships Codex packaging: a `.codex-plugin/plugin.json` over the same skill directory the Claude packaging uses, so the audit workflow installs on either host
- Advice now names the host's own mechanisms — a Codex report suggests narrower `AGENTS.md` files where a Claude report suggests scoped `.claude/rules/` files

## [0.7.0-alpha] — 2026-07-28

### Added

- The audit flags the same rule stated twice — exact copies and near-copies — naming both places and which copy looks worth keeping. A duplicate never moves the grade
- Two rules that contradict each other are flagged as a pair, with both addresses. assay names the disagreement and neither winner; when the two sit at different levels it says which one the host reads last, and calls that load order, not a verdict
- A `CLAUDE.md` variant the host doesn't select — a `.claude/CLAUDE.md` sitting beside a root one — is reported as shadowed instead of graded as live policy. It stays out of the grade, because it never takes effect
- A rule whose moment a wired hook already fires on is named as already wired, so the prose can be checked instead of trusted
- Every report counts the bytes of instructions that load before a session starts, and flags real heft with the three files carrying it
- The report shows the project's enforcement ladder: what exists at each level from advisory prose to remote gates, each mechanism with its honest state chain — configured is not executed, and `--verbose` prints every state and coverage limit
- A skill defined in both user and project scope is flagged, because which one a session reaches for is host-defined
- With `--semantic`, the audit can also propose paraphrased duplicates and indirect conflicts — the ones token overlap can't see. Every proposal is labelled model-proposed, you accept or reject it in conversation, and none of them move a score or a grade

- The JSON assay writes is a versioned record: it names the analyzer and its version, the parser, the host profile, and the context the analysis ran in — project root, startup directory, and the time it ran. Everything in it but the timestamp is identical between two runs over an unchanged project
- assay reads your files with a real CommonMark parser and a real YAML parser, both bundled with the plugin — nothing to install. Setext headings, tables without leading pipes, indented code blocks, fences inside list items, and frontmatter arrays wrapped across lines are all read the way any other Markdown tool reads them
- Frontmatter that isn't valid YAML is reported with the reason and the lines it covers, instead of being half-read into guesses
- Every line of every instruction file is accounted for in the report's **Coverage** block: graded, set aside as content, explicitly ignored, excluded, or named as something assay could not read. An unclosed code fence or an unclosed HTML comment is counted there rather than silently swallowing the rest of the file
- The JSON record carries a per-file inventory — content hash, line count, and the span counts those lines fall into — and every rule carries its exact source range, line and column and character offset
- The audit now sees the whole documented Claude surface for a project: `CLAUDE.local.md`, your user-level `CLAUDE.md` — graded under its own section, never moving the project grade — and a count of the user skills and subagents that exist alongside them. `--project-only` keeps the audit inside the repo
- The report now leads with findings: **Hard gates** for rules the host cannot apply, **Operational findings** for the ones it loads but that carry a risk, and **Policy placement** for the ones another mechanism should own. Every finding names its exact source line and is labelled with the kind of evidence behind it — mechanical, heuristic, model-inferred, or measured
- The report opens with a count of what was found by kind, and `remeasure` shows those counts before and after your fixes
- The audit runs fully offline. With no model judgments present the report still lands — labelled `deterministic only`, with the model-judged checks named in **Coverage** as not run, and each score computed over the factors that were actually measured. `/assay:audit --deterministic` is the flag that asks for it
- Judgments now record their provenance — which model made them, under which rubric version, and when — and the report says so when the rubric has changed since they were made
- The HTML report now carries the whole audit: every finding, the ladder, coverage, hygiene, with search, state/severity/evidence filters, keyboard navigation, and a button that downloads the record as JSON
- Secrets in hook commands are masked in both report views. The finding itself stays visible — redaction hides the value, never the mechanism

### Changed

- The corpus grade is now a secondary **Structural hygiene** summary at the bottom of the report. It is a summary of how rules are written, scoped, and placed — never a compliance prediction — and it never overrides a hard gate
- A rule the host can't apply — a scoped file whose patterns match nothing, a rule requiring a path that doesn't exist — is reported as that state instead of as a letter grade
- Hedged wording is scored by its weakest hedge. "Always try to use functional components" no longer reads as an unconditional mandate because of the "always"
- An audit file written by an older assay is rejected with the version it found and a note to rerun `scan`, instead of being read as if its fields still meant the same thing. `remeasure` is the exception: it drops the stale comparison, says so, and re-scans anyway
- A rule written in a non-Latin script inside a table cell is graded like any other cell. Those cells used to drop out of the table before anything looked at them

## [0.6.0-alpha] — 2026-07-28

### Added

- Every report opens with a **Coverage** block: how many instruction files were parsed out of how many found, how many rules were graded, how much prose was set aside, and how many lines were excluded. A file assay could not read is named there with the reason instead of quietly missing from the numbers, and the count of entries the verification pass dropped now prints on every report — `--verbose` is what turns that count into the list

### Changed

- Exit codes are the same across every command: 0 on success, 1 on any failure — a missing or malformed judgments file, a missing audit, an unknown command. A mistyped flag is an error too, instead of being ignored and producing the default output
- The docs, the plugin description, and the report itself now say plainly what a grade measures: how a rule is written, scoped, and placed — structural hygiene, not a prediction that Claude will follow it
- Promoting or parking a placement candidate no longer removes the rule. A promotion shows you the hook, skill, or subagent before writing it, installs it only if you approve, and leaves the prose active; parking just records the plan. Retiring the now-duplicated rule is a separate decision you make once you've seen the new mechanism working

### Fixed

- Rules written inside a Markdown table are graded like any other rule. A directive in a table cell used to vanish from the audit entirely; header and separator rows still don't count as rules
- A rule file whose `paths:` frontmatter is written inline — `paths: ["src/**/*.ts", "test/**"]` — is now scoped by each pattern. It was read as one literal that matched nothing, which scored every rule in the file as a dead glob
- Two directives written as two sentences in one paragraph are graded as two rules, so a weak one can no longer hide behind a strong one. A prohibition and the sentence naming its replacement still count as one rule
- An unrelated instruction standing next to a prohibition no longer counts as its alternative. The replacement has to be about the thing being banned, or the prohibition is still bare
- A single generic word in backticks — `` `code` ``, `` `it` `` — no longer passes as concrete on its own. Paths, commands, flags, multi-word spans and real identifiers still do
- A rule that says "TypeScript files" inside a file scoped to `**/*.ts` is no longer scored as a scope mismatch. Common language names now match their file extensions
- A misspelled `<!-- category: … -->` annotation is named in the report with its file and line. It used to pass silently and take the rule out of the corpus grade with it

## [0.5.9-alpha] — 2026-07-24

### Added

- A new **Restructure candidates** section flags files whose grade is dragged down by their shape, not their wording — mostly narrative, most of their rules sitting past the midpoint, or simply too long — and names the restructure each one needs. A per-rule rewrite can't reach any of these, so the report points at the file itself: fence the narrative, move the load-bearing rules up, or split into scoped `.claude/rules/` files
- An optional `--artifact` view renders the audit as a sortable HTML table; expand a rule to see its full text, factor scores, flags, and suggested fixes

## [0.5.8-alpha] — 2026-07-24

### Added

- Fence off a block of prose that reads like rules but isn't — a motivating story, a pasted requirement, a glossary — with `<!-- assay-ignore-start -->` and `<!-- assay-ignore-end -->`. The block leaves the grade entirely, and a real rule below it is no longer counted as buried under prose that was never graded. `<context>` and `<example>` blocks are treated the same way

## [0.5.7-alpha] — 2026-07-24

### Added

- After rewriting weak rules, the audit now measures again and shows the movement — corpus grade before and after, and each file's grade before and after. Rewording a rule re-judges only that rule; every untouched rule keeps its earlier judgment. One rewrite drops most corpora only part of the way to a good grade, and now you can see how far it went instead of guessing

## [0.5.6-alpha] — 2026-07-24

### Changed

- The "is this a rule at all?" verification pass now runs by default. A file of notes or history no longer arrives graded as a page of mandates unless you ask for the check. Pass `--no-verify` to skip it — for a metered key or an offline run. It still only drops entries, never rescores or rewords, and `--verbose` lists every drop with its reason

## [0.5.5-alpha] — 2026-07-24

### Changed

- The `--verify` pass now asks its "is this a rule at all?" question of a more capable model. On instruction files that phrase real directives as advice or lessons learned, the weaker model it used before dropped a genuine rule roughly one time in four; the current model does not

## [0.5.4-alpha] — 2026-07-23

### Added

- `--verify` asks one more question of a small fast model before the report: is this entry a rule at all? A file of notes or history can otherwise arrive graded as a page of mandates. The answer can only drop an entry — nothing is rescored or reworded — and `--verbose` lists every drop with the reason. Off unless you ask for it

### Fixed

- A sentence joined by "and" is no longer cut in half and graded as two rules. The tail clause was being listed as a rule of its own, scored, and offered for rewrite. Rules that genuinely carry two directives still split on a semicolon
- The weak-rules table no longer repeats one identical suggested fix on every row. Each row now names the factors that are actually weakest for that rule, so the advice differs where the rules differ

## [0.5.3-alpha] — 2026-07-23

### Changed

- The report no longer prints the list of hooks already wired for the project. That list is what assay reads to mark a candidate "already enforced by" — once those marks are in place it has no reader, and on a project with several plugins installed it added dozens of lines nobody could act on

## [0.5.2-alpha] — 2026-07-23

### Fixed

- Under an output style that stays silent until the work is done, the fix menu no longer appears with no report behind it. The audit now checks whether it can put the report in front of the user before asking anything: when it can't, it skips the menu, ends on the full report, and tells you to rerun with `--fix` or name what to rewrite

## [0.5.1-alpha] — 2026-07-23

### Fixed

- The audit report is now delivered as the final message rather than as a preamble before the fix menu. Output styles that suppress text written ahead of a tool call were swallowing the whole report, leaving the fix menu with no tables behind it

### Changed

- All three skills carry their trigger phrasings inside the frontmatter `description` instead of a separate `when_to_use` field, which is what assay's own skill grading asks for

## [0.5.0-alpha] — 2026-07-23

### Changed

- A skill description is no longer marked down for having fewer than two quoted example phrasings. The "Use when…" trigger clause is still required; the number of quotes is not, so one quoted phrasing — or none — now passes
- Skill-description guidance now tells you to keep the base sentence terse and to stop enumerating a domain's whole surface, which costs a skill more firing than anything else in the description
- Skill-description guidance now warns that quoted phrasings which don't match what the skill is really asked for are worse than none at all, and should be rewritten or deleted rather than padded to a count

## [0.4.2-alpha] — 2026-07-23

### Changed

- The rule cell in the weak-rules and full-rules tables is now itself the clickable link that opens the rule at its line; the separate line-number column is gone, since a bare line number gave the reader nothing to act on

## [0.4.1-alpha] — 2026-07-23

### Fixed

- A "must not" prohibition that follows its subject ("tests must not X") is detected again — the clause-leading requirement introduced in 0.4.0-alpha had dropped it

## [0.4.0-alpha] — 2026-07-23

### Added

- Every rule location in the report is now a clickable `file:line` markdown link that opens the rule at its exact line
- The hook-candidates section now lists the hooks already wired for the project — from project and user settings plus installed plugins — so a candidate that is already enforced gets marked as covered instead of proposed again

### Fixed

- A factual negation mid-sentence ("those APIs don't exist") is no longer read as a prohibition, so informational notes stop landing in "Stall risks" with capped scores
- A prohibition that names its replacement with "cut" or "drop" now gets credit for the alternative

## [0.3.1-alpha] — 2026-07-23

### Fixed

- Backticked commands with arguments (like a build invocation) are no longer read as missing file paths, so command listings stop landing in "Stale references" with crushed scores
- A reference whose file merely moved elsewhere in the repo no longer crushes the rule's score — the report still lists it with the new location so the fix stays a one-line edit
- Worked examples wrapped in `<example>`-style tag blocks are no longer scored as rules

## [0.3.0-alpha] — 2026-07-23

### Added

- Stale-reference detection now reads markdown-link targets and root-relative paths, not just backticked paths, so a link like `[example](/example.md)` is checked too; when a cited file has only moved, the report names its new location so the fix is a one-line edit
- Rules written in a non-Latin script are now flagged at the top of the report, so their scores aren't mistaken for real grades
- The audit now grades project skill descriptions: every `.claude/skills/*/SKILL.md` description is checked against the trigger recipe, and the ones missing a trigger clause, a concrete artifact, or an exclusion land in a new "Weak skill descriptions" section and can be rewritten in place from the same fix menu as the rules
- `/assay:craft-skill` skill: builds a new skill with a description Claude reliably triggers on, or refits one that never fires; skills that must always run get a companion rule, with a hook offered as the only true guarantee
- `/assay:craft-rules` skill: interviews you about the behavior you want enforced, writes one recipe-shaped rule into `CLAUDE.md` or a scoped `.claude/rules/` file, verifies it with the audit engine before handing it back, and redirects asks that are really hooks or skills instead of writing them as prose

### Changed

- The report now names each rule's weakness in plain English — "no clear trigger", "too vague", "buried in the file" — instead of internal factor codes, so it reads without knowing how the scorer works
- Command listings and glossary bullets (a build command with its description, a labelled reference entry) are no longer mistaken for rules, so the report stops filling up with false weak-rule findings
- assay's own skill descriptions now follow the trigger recipe they preach, so its skills route more reliably themselves
- Promotion no longer installs companion plugins: promoted rules are now built directly from the live official docs, at project scope, so nothing new lands in your plugin config and formats are always current
- Skill promotions from the audit now write trigger-recipe descriptions instead of plain one-liners

## [0.2.0-alpha] — 2026-07-18

### Added

- Position grading: a rule in the bottom half of a long file now grades down, and the report lists it under "Buried rules" with the fix (move it up or split the file)
- Stall-risk detection: a prohibition that names no alternative is now capped at grade F and listed under "Stall risks", with the paired-alternative rewrite as the fix
- Keep-file-in-sync duties (changelog entries, doc sync) are now flagged as hook candidates
- Placement candidates can be promoted on the spot through the official companion plugins for hooks, skills, and subagents; a missing companion is installed automatically
- The report states its severity calibration: grades assume small-model, subagent, and headless readers, and read one notch softer for large-model-only interactive use

### Changed

- A prohibition that names its alternative ("Never X — use Y instead") now grades as the strongest framing instead of a penalized one
- Trigger-distance judging is stricter on standing duties for distant files: without a "when" clause they now score near the floor

## [0.1.0-alpha] — 2026-07-18

### Added

- `/assay:audit` skill: grades every rule in `CLAUDE.md` and `.claude/rules/` for how clearly Claude can follow it, reports the weakest rules each with a suggested fix, flags rules citing files that no longer exist, and surfaces rules that a hook, skill, or subagent would enforce better than prose
- Fix menu: optional in-place rewrites of weak rules, and parking of placement candidates into `.claude/assay-promotions.md` with promotion notes; `--fix` applies rewrites without the menu
- `--verbose` (per-rule score breakdown) and `--json` (machine-readable report) flags
- `<!-- assay-ignore -->` comment to exclude a rule from the audit, `<!-- category: preference|override -->` to relax its quality floor
- Grading is deterministic: rerunning the audit on unchanged files produces the same grades
