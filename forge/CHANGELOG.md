# Changelog

All notable changes to forge are documented here. As of 1.4.1-alpha, forge
is a monorepo-folder plugin — its version is owned by
`.claude-plugin/marketplace.json` at the repo root, not by
`forge/.claude-plugin/plugin.json` (which carries no version field by
convention).

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [Unreleased]

### Changed

- Full and deep runs no longer re-emit the analysis pipeline script on every invocation, making runs cheaper and immune to transcription drift.
- Failed analysis runs now resume from where they stopped instead of restarting the whole pipeline.
- In an ultracode session, forge now suggests itself for non-trivial feature requests instead of an ad-hoc workflow.

### Fixed

- Analysis runs now recover cleanly when a token budget runs out mid-pipeline.

## [1.4.3-alpha] — 2026-07-13

Doc-only: the README logo now adapts to dark mode (white silhouette instead of black). No behavior change.

## [1.4.2-alpha] — 2026-07-08

Doc-only: plugin.json's description now matches the marketplace listing text. No behavior change.

## [1.4.1-alpha] — 2026-07-05

### Changed

- Forge is now a plain folder in its marketplace repo instead of a separate linked repository. No functional change for users.
- Removed forge's own `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`.

## [1.4.0-alpha] — 2026-06-30

### Changed

- The full and deep analysis pipeline now runs more reliably end-to-end, with fewer handoff errors between steps.
- `deep` mode is simplified: it now runs the same pipeline as `full`, with one added verification pass on the critique.
- Approval gates still happen in the same place — you're prompted at the same points as before.

## [1.3.1-alpha] — 2026-06-30

### Changed

- Internal cleanup: removed duplicated expert-selection guidance and dead code. No user-facing behavior change.

## [1.3.0-alpha] — 2026-06-29

### Changed

- Forge now communicates more concisely while running: brief one-line status updates between steps, with full detail shown only when you need to make a decision (e.g., a refuted assumption, the approval gate, an escalated question).
- Internal model routing, retries, and subagent mechanics are no longer narrated in the output.
- The master plan is now shown to you once, in its final form, instead of twice.

## [1.2.0-alpha] — 2026-06-27

### Added

- Three explicit workflow levels: `/forge lite` (quick, in-session, no expert/critic dispatch), `/forge` (full pipeline), and `/forge deep` (adds an extra verification pass).
- Forge now skips its full pipeline automatically for trivial, localized changes.
- A routing guide that flags when forge is the wrong tool for the job and suggests the alternative (direct edit, `/code-review`, a project skill, or `/forge lite`).
- Progress metrics shown at each gate (domains reviewed, conflicts resolved, findings addressed) so you get a quick read without parsing the full output.
- Forge now recognizes prompts that describe a multi-area feature and suggests itself as an option; it also remembers which level is currently active.

### Changed

- Critic review and plan synthesis now focus on pre-flagged high-risk findings first, for faster, more focused review.

## [1.1.0-alpha] — 2026-06-11

### Added

- Optional deep mode: a more thorough run with schema-validated expert reports and an extra critic verification pass, available when explicitly requested.
- Experts can now ground claims about framework/library/platform behavior against external documentation, not just the project's own code.
- Follow-up questions and blocker resolution now resume the original analysis instead of starting over, preserving context.
- The approval step now shows a short plain-language summary before the full plan, making it easier to review and approve.

### Changed

- The final report's user-facing sections are now written for a developer reader — technical terms and concrete commands are fine, internal walkthroughs are not.
- Expert and critic analysis can now run longer before being cut off, reducing truncated reports on larger investigations.

## [1.0.5-alpha] — 2026-05-28

### Removed

- Internal cleanup; no user-facing change. (Entry backfilled — this release was originally published as a marketplace version bump without a changelog entry.)

## [1.0.6-alpha] — 2026-05-28

### Fixed

- Fixed implementer agents running out of turns partway through larger parallel changes; they now flag the issue instead of silently stopping.

## [1.0.4-alpha] — 2026-05-08

### Fixed

- Skills with side effects (merging code, spawning worktrees) no longer trigger automatically from conversation — only when explicitly invoked.
- The critic-review step now reliably uses its intended model instead of falling back to a default.

## [1.0.3-alpha] — 2026-05-02

### Fixed

- Fixed expert-analysis agents occasionally running out of turns before producing a report.

## [1.0.2-alpha] — 2026-05-01

### Added

- Forge now checks for project-specific skills covering the feature's domain before analysis begins, and treats their output as authoritative instead of re-deriving the same facts.

## [1.0.1-alpha] — 2026-04-30

- Removed tool usage from skills and agents to avoid blocking mcp tool dependencies.

## [1.0.0-alpha] — 2026-04-29

### Added

- `/forge:forge` orchestrator skill: a pre-code feature review pipeline — understand requirements → structural search → reality-check spike → parallel expert analysis → master plan → adversarial critic → plan revise → user approval → implementation → build + report.
- Entry guard: skips the full pipeline for trivial localized changes (typo fixes, single-method bugs); enters forge only when the feature crosses multiple architectural areas or touches a trust boundary.
- Reality-check spike: a small, targeted probe against the riskiest assumption before any planning begins, surfacing refutations to you rather than silently re-scoping.
- Parallel domain expert analysis (architecture, security, performance, testing, UX): each expert reads the actual code and returns a scoped report.
- Master plan synthesis: combines expert reports into a single implementation plan with steps, files touched, done-when criteria, risks, and open questions.
- Adversarial critic review: ground-truths the master plan against the codebase and flags blocking issues, gaps, and open questions.
- Plan revision: incorporates critic findings and your feedback into a revised plan before approval.
- User approval gate: the pipeline does not proceed to implementation without your explicit approval.
- Optional parallel implementation dispatch for plans with independent steps.
- Optional stack-specific build and verify step after implementation, deferring to your project's own build setup.
- Stack-agnostic design: no hardcoded build commands; all stack-specific behavior comes from your project's own configuration.
