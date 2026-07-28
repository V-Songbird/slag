# Changelog

All notable changes to assay are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [Unreleased]

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
