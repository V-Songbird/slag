# Changelog

All notable changes to jig are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

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
