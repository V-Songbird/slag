# Changelog

All notable changes to jig are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [1.0.0] — 2026-08-11

### Changed

- First stable release. Nothing new to learn: every file an earlier install wrote still reads, and future releases keep that promise — your config, ledger, and installed checks never need migrating.

## [0.5.0-alpha] — 2026-08-11

### Added

- Coming back is now one question. On a repository jig already guards, `/jig:jig` shows what drifted, what fired, what never did, and what waits in the backlog — then asks: arm the quiet, take the next thing, retire the dead, or refresh. Retiring a guard is journaled and reversible, and its history stays in the ledger.
- jig can now brief other AI tools. On request it writes one fenced, clearly-marked block into `AGENTS.md` pointing any session that reads it at the committed checks. It only ever rewrites its own block, never your text, and refuses to grow the file past the size where it stops being read at all.
- The scan now warns when a nested `AGENTS.md` shadows the root one for part of the tree.

### Changed

- The coverage matrix's fourth column is honest in both directions now: covered as "probably" where the block is installed — instructions are never a guarantee — and a plain gap where it is not.

## [0.4.0-alpha] — 2026-08-11

### Added

- jig can now write rules — carefully. On explicit request it emits a short, paths-scoped rule for a mistake no tool can watch, or one pointer rule naming the governance docs nothing references. Every rule lands as its own `jig-` file under `.claude/rules/`, is approved by name, carries its origin label, and reverts clean. One install may never add more than a small stated byte budget, because every session pays to carry prose.
- The scan now finds your ADRs, scopes, roadmaps and north stars, and tells you which ones no loaded surface references — documents every session is blind to. The interview turns each one into a decision.
- Permission rules still never land in your settings by themselves. jig writes them up as a proposal you apply yourself, and that stays true in every configuration it ships in.

### Changed

- A default install still adds zero always-loaded text, and the release gate that proves it still runs. Prose only ever arrives because you asked.

## [0.3.0-alpha] — 2026-08-11

### Added

- jig now drafts for your own toolchain, in any language it knows the tools for. A repo carrying eslint or tsc gets a ready side-config plus the one wiring line; a Kotlin build carrying detekt gets a detekt config the same way. Every side-file targets a tool the repository already has — jig never downloads one, and a missing tool is named as a gap instead.
- The install's closing proof now covers toolchain files too: the eslint config is proven live through your own eslint, and tools too expensive to spawn get the exact command to run and what to look for.
- The interview now opens by naming what you may not know you're deciding — the loudest problem in your history jig can't guard yet, a slot another plugin holds, a tool that would close a gap — and then asks in rounds, each question carrying a recommended answer. Two new questions: whether to add the CI workflow, and whether to weave the hook line into a committed pre-commit.

### Changed

- The coverage matrix now grades toolchain coverage per repository: the same class reads as covered where the tool exists and as a named gap where it does not.

## [0.2.0-alpha] — 2026-08-11

### Added

- `/jig:review` — see what every guard has done: fired, never fired, or waved off as a false alarm. It offers arming exactly when a guard has earned it, and records false alarms.
- Guards can now block. A guard becomes armable after ten clean observed sessions with zero recorded false alarms — twenty-five for a heuristic one — and only if its install came from a real answer, never from a quick-start default. A blocked call always shows the reason, an alternative, and how to override.
- A recorded false alarm pulls an armed guard straight back to observing and resets its clock.
- If your pre-commit hook is committed to the repo, jig can now weave the one activation line into it — asked first, approved by name, journaled, reversible. Machine-local hooks still get the printed proposal only.
- Installs now also drop `.jig/hooks/pre-commit`, a ready shim for `core.hooksPath`.

### Changed

- Every guard now has a stable name that survives catalogue updates, so its ledger history stays its own.

## [0.1.0-alpha] — 2026-08-11

### Added

- First cut. `/jig:jig` reads your repo and its git history, asks the two things it can't read, and installs guardrails against four mistakes: a focused or skipped test left in the suite, a swallowed error, a downloaded script piped straight into a shell or a force-push to your main branch, and a deleted test file.
- A committed check script under `.jig/checks/` that any teammate, any CI, any machine with node can run — no plugin needed. A ready-made CI workflow runs it on every push.
- Two session guards that watch what an agent session is about to do. This release they only record: a guard that matches writes down what it would have blocked and lets the call through.
- Every install is journaled and reversible — one command puts every file back, byte for byte. jig writes only under `.jig/` and `.github/workflows/`, and never into a settings file, an instruction file, or a git hook. The pre-commit line and the permission rules are printed as proposals for you to apply.
- The install closes with a live proof: each guard is shown catching a synthetic violation before jig calls anything covered.
- A quick start (`/jig:jig --quick`) that installs all four checks with one review and no interview.
