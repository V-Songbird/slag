# Changelog

All notable changes to assay are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [Unreleased]

## [0.2.0-alpha] — 2026-07-18

### Added

- Position grading: a rule in the bottom half of a long file now grades down, and the report lists it under "Buried rules" with the fix (move it up or split the file)
- Stall-risk detection: a prohibition that names no alternative is now capped at grade F and listed under "Stall risks", with the paired-alternative rewrite as the fix
- Keep-file-in-sync duties (changelog entries, doc sync) are now flagged as hook candidates
- Placement candidates can be promoted on the spot through the official companion plugins — hookify for hooks, skill-creator for skills, plugin-dev for subagents; a missing companion is installed automatically
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
