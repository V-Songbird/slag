# Changelog

All notable changes to anneal are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [Unreleased]

### Changed

- The closing report suggests a harness you can install to keep the result from drifting, instead of one that is no longer here.
- On Codex, the plugin no longer carries an icon.

## [0.2.0-alpha] — 2026-09-19

### Added

- Runs on Codex and Antigravity as well as Claude Code, from the same plugin directory.
- The audit reports two more things: code buried six or more folders deep, and environment files with no `.env.example` naming the variables they set.
- Renames and moves re-point relative `import`, `export … from`, `import()` and `require()` themselves in JavaScript and TypeScript projects, instead of one search-and-edit per file.
- The migration plan can add a `.env.example`, built from the variable names the project's own code and docs read.
- While an `anneal/<date>` branch is checked out, `git reset --hard`, `git clean -f`, `git push --force` and `git branch -D` are refused. Every other branch is untouched.

### Changed

- `AGENTS.md` and `GEMINI.md` count as map files, not just `CLAUDE.md`, and every map file present is measured against the 200-line limit rather than only the first one found.

## [0.1.0-alpha] — 2026-09-15

### Added

- First cut. `/anneal:anneal audit` reports what makes an AI agent search, read or guess more than it needs to in your repository — no map file, no declared toolchain version, duplicate or generic file names, oversized files, build output in search results, names built at runtime — and changes nothing.
- `/anneal:anneal` goes further: it runs your project's checks first, proposes a layout for you to approve, and migrates one step at a time on its own branch, committing a step only when the checks still match.
