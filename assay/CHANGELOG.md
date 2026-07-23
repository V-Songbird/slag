# Changelog

All notable changes to assay are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

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
