# Changelog

All notable changes to anneal are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [Unreleased]

### Added

- `learn-from-session` reads one Claude Code or Codex session and proposes map file changes for the detours it shows. You start it yourself and approve each change before it is written. A fact about your machine is reported and never written.
- `reconcile-project-docs` reviews maintained documentation and non-code development files against project behavior and applicable instructions. It combines README review, the layout audit, host consistency and public-repository hygiene, with a report-only `audit` mode and authorized cleanup.
- `scripts/session-evidence.js` lists where a transcript shows a tool call failing, and runs with no host at all.
- A map file the migration writes follows one fixed sequence of sections, so every repository it touches reads the same way. A map file that is already there can be moved onto that sequence as a step you approve on its own.

### Changed

- Rename the `anneal` skill to `improve-agent-navigation` and `anneal-session` to `learn-from-session`, including invocation names, links and eval discovery checks. The plugin remains named `anneal`.
- The skill now starts on a plain question about how easy a repository is to navigate, even when you ask for a list of problems and no changes. Before, such a question was often answered without it.
- The closing report suggests a harness you can install to keep the result from drifting, instead of one that is no longer here.
- On Codex, the plugin no longer carries an icon.
- Antigravity invocation examples use `/improve-agent-navigation`; Codex uses `$improve-agent-navigation`.
- The requirement is Node 22 or later. It said Node 18, which was never run.

### Fixed

- Codex discovers the migration guard for review by using its compatibility manifest instead of the portable loader.
- On Codex on Windows the migration guard runs. It named a Windows-only command that broke under
  the shell that host uses, so the hook failed and the call went ahead. The override is gone and
  the plain command is the only one; `node` has to be on the path the host gives a hook.

## [0.2.0-alpha] — 2026-09-19

### Added

- Runs on Codex and Antigravity as well as Claude Code, from the same plugin directory.
- The audit reports two more things: code buried six or more folders deep, and environment files with no `.env.example` naming the variables they set.
- Renames and moves re-point relative `import`, `export … from`, `import()` and `require()` themselves in JavaScript and TypeScript projects, instead of one search-and-edit per file.
- The migration plan can add a `.env.example`, built from the variable names the project's own code and docs read.
- While an `anneal/<date>` branch is checked out, `git reset --hard`, `git clean -f`, `git checkout --force`, `git push --force` and `git branch -D` are refused. Every other branch is untouched.

### Changed

- `AGENTS.md` and `GEMINI.md` count as map files, not just `CLAUDE.md`, and every map file present is measured against the 200-line limit rather than only the first one found.

## [0.1.0-alpha] — 2026-09-15

### Added

- First cut. `/anneal:anneal audit` reports what makes an AI agent search, read or guess more than it needs to in your repository — no map file, no declared toolchain version, duplicate or generic file names, oversized files, build output in search results, names built at runtime — and changes nothing.
- `/anneal:anneal` goes further: it runs your project's checks first, proposes a layout for you to approve, and migrates one step at a time on its own branch, committing a step only when the checks still match.
