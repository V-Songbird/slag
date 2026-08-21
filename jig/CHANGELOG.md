# Changelog

All notable changes to jig are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [2.2.0] — 2026-08-21

### Added

- Point jig at an empty folder and it goes first. It asks which language, writes the starter project file, installs the toolchain and lands the checks — so the first line of code anybody writes is already being checked. It never offers to build the application instead.
- Ecosystems whose project file only you can name — Go, Gradle and Maven, .NET — say so plainly and hand you the one command to run (`go mod init`, `gradle init`, `dotnet new`). jig picks up from there.
- Every edition now names its project file, so jig knows the difference between a file a tool owns and a file your project owns.

### Fixed

- Several tools sharing one config file no longer overwrite each other. Five Python tools configure `pyproject.toml`, four .NET tools configure `.editorconfig`, and two Rust tools configure `Cargo.toml`; each was written as its own whole-file change, so the last one applied was the only configuration left. jig now writes one file holding every tool's settings, and names any setting two tools disagreed about.
- A shared config file jig cannot safely compose — `go.mod`, `build.gradle.kts`, `Directory.Build.props` — is now written by nobody. You get each tool's snippet and where it goes, instead of one tool's sample landing on top of your build file.
- A config file your project already owns no longer costs you the tool. A repo with its own `pyproject.toml` was offered no linter, no type checker and no test runner at all; the tools install now, and their configuration comes back as a snippet jig will not place for you.
- On Windows, an install that cannot start because the package manager is a `.cmd` shim now says exactly that, and what to do about it. It used to tell you to install a tool you already had.

## [2.1.0] — 2026-08-18

### Added

- Upgrading an install made by an older jig now happens on its own. Run `/jig:jig` on a repo it already guards and it rewrites every installed check into the shape this release reads, keeps each guard's history, and reverts like any other change.
- jig can weave its check line into a pre-commit hook your repository commits, approved by name and reversible. It still never touches `.git/hooks/`, and it still prints the line for you when there is nothing to weave into.
- Answers the interview already collects now reach the install: guards that watch instead of block, the pointer rule for governance documents nothing references, and the `AGENTS.md` block for another AI tool. All three were being asked about and then dropped.

### Changed

- Seven more mistakes are caught. Checks that had been written around a bug in how jig reads comments and strings are back, including two about switching your linter off — the mistake jig exists to catch.
- The history mining reads your project's own language. It was ranking every repository in one language's names, and looking at eight file types instead of twenty-eight.
- Guard reports say when a guard is broken rather than just quiet, so a check that will not load stops reading as a check that never fired.

### Fixed

- Checks that read comments in Python, Ruby, PowerShell and .NET no longer describe a limitation that was fixed a release ago. Nineteen of them said your comments were read as live code; they are not.
- Revert is described honestly: it puts every file back and hands you the one command that takes an installed package off disk. It never runs your package manager for you.
- The Go toolchain no longer offers three tools with a removal command that does not remove anything. They are named, with the reason, and the rest of the Go tooling is still offered.

### Removed

- Three hand-written rule templates and the flag that emitted them. No selection could reach them, so nothing that worked has gone.

## [2.0.0] — 2026-08-13

### Added

- jig now sets up your toolchain instead of only writing configs for tools you already had. It shows the exact install command and the exact config it would write, and runs it once you approve that item. A tool it cannot uninstall again is a tool it refuses to install.
- Six language editions ship: JavaScript and TypeScript, Python, Go, Rust, the JVM, and .NET. Each carries its own tools, install commands, config samples and mistake catalogue.
- Describe a mistake in your own words and jig writes a check for it, together with the violation and near-miss samples that prove the check works. A check that fails either half is discarded and written to `.jig/discarded.json` rather than counted as coverage.
- An existing install upgrades in place. jig reads what is there, carries each guard's history forward, and does it as one reversible transaction.

### Changed

- A check that passed its fixture pair now blocks from the moment it installs. Observe mode is still there whenever you want a guard to only watch, but it is no longer a probation every guard has to serve first.
- jig writes wherever you approve, one named path at a time, instead of only under `.jig/` and `.github/workflows/`. Every write still records the bytes that were there before, so `revert` puts them back — including your manifest and lockfile after an install.

### Fixed

- Checks now read each language's own comment syntax. Previously only six file extensions were recognised, so a `#` comment in a Python or Ruby file was read as code.
- A `//` inside a URL or a `/*` inside a glob no longer blanks the rest of the line or file, which had been silently hiding real findings.
- Path patterns with brace alternation, such as `**/*.{ts,tsx}`, now match.

## [1.0.1] — 2026-08-11

### Fixed

- `review`, `arm`, `disarm`, `fp`, `rerun` and `retire` failed when run from the command line — while working perfectly from tests and hooks, which is exactly why it slipped through. Caught on a real project run.

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
