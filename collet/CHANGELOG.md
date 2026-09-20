# Changelog

All notable changes to collet are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Runs on Antigravity, from the same plugin directory. The guard refuses a write outside the open
  task there too; the session start and handoff notes stay on Claude Code and Codex, which are the
  hosts with those events.
- On Codex, the session is told the open task when it starts and a handoff is written before
  compaction, as on Claude Code, and the guard now also reads the `Write` and `Edit` tools.

### Changed

- The hooks take the project from the event when the host does not name it in the environment, so
  they work from whatever directory a host runs them in.
- A project that already keeps a `ROADMAP.jsonl` or a `.foreman/` directory is now left alone
  entirely. `mount.mjs` writes nothing there and exits 2, instead of writing the harness in a
  second shape that read that roadmap and enforced the files its open entry named.

### Removed

- The roadmap-backed mode: no roadmap is parsed, no entry is read as the open task, and no write is
  refused against the files such an entry declares. Those files are a forecast the owning tool
  re-reads and rewrites, so enforcing them turned a prediction into a permission boundary and
  pushed sessions into editing that prediction mid-task. `ROADMAP.jsonl` and `.foreman/` remain on
  the scope check's never-refuse list, for a project that adopts one after collet is installed.

## [0.1.0-alpha] — 2026-09-19

First release.

### Added

- One open task at a time, with the files it may write and the command that ends it. A session is
  told all three before it reads anything.
- A guard that refuses a write outside those files as it happens, and prints the one command that
  widens the list with a recorded reason. It reads write tools, patches and the shell forms it can
  read with certainty, including removing a whole directory.
- `close` checks the working tree against the task before it runs the accept command. A change that
  landed outside the list, or a command that exits non-zero, leaves the task open.
- A declared list of files is closed over what those files import, one level deep, with the reason
  printed for each one that comes along. Naming a module is enough; its imports come with it.
- Checks that each ship with planted mistakes and the lookalikes written to fool them. One that
  cannot catch its own violation is discarded and named instead of counted.
- `node .collet/checks/run.mjs --live` checks the working tree against the open task, for a commit
  hook or CI. A check that could not look reports itself skipped; `--strict` makes that a failure.
- On a project that already keeps a `ROADMAP.jsonl`, collet writes no ledger of its own and
  enforces the files that roadmap declares. Every command that would write a second ledger refuses.
- A handoff written before compaction, carrying the id of the task it describes, so a note left
  over from finished work is dropped instead of read back.
- `.collet/off` silences every session guard on purpose. The committed checks never read it.
- The rules block is written into `AGENTS.md`, `CLAUDE.md` and `.cursor/rules/`, between markers,
  so a re-run replaces the block and leaves your own text untouched.
