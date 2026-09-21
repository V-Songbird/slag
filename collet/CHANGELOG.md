# Changelog

All notable changes to collet are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0-alpha] — 2026-09-21

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

- The mount writes the rules block into `CLAUDE.md` only when the project already has one, and no
  longer creates that file. `AGENTS.md` still always gets the block. Claude Code reads `AGENTS.md`
  only while no `CLAUDE.md` exists, so on a project that kept `AGENTS.md` alone the created file
  held nothing but the block and hid the project's own instructions from that host.

### Removed

- The roadmap-backed mode: no roadmap is parsed, no entry is read as the open task, and no write is
  refused against the files such an entry declares. Those files are a forecast the owning tool
  re-reads and rewrites, so enforcing them turned a prediction into a permission boundary and
  pushed sessions into editing that prediction mid-task. `ROADMAP.jsonl` and `.foreman/` remain on
  the scope check's never-refuse list, for a project that adopts one after collet is installed.

### Fixed

- Codex discovers the session, guard and handoff hooks for review by using its compatibility manifest instead of the portable loader.
- On Codex on Windows the three hooks run. Each named a Windows-only command that broke under the
  shell that host uses, so the hook failed and the call went ahead. The override is gone and the
  plain command is the only one; `node` has to be on the path the host gives a hook.
- A session opened in a subdirectory of the project is held to the open task. The hooks took the
  directory the session started in as the project, found no harness there, and stood down.
- A relative path is read from the directory the call ran in. From a subdirectory, an edit to
  `../README.md` was allowed and one to the task's own file was refused. A project mounted before
  this fix gets it by mounting again.
- A file edit made with a patch on Codex is checked against the open task. That host hands the
  patch over under a key the scope check did not read, so every such edit was allowed. A project
  mounted before this fix gets it by mounting again.
- The `collet` skill's frontmatter is valid YAML now, so a host that parses it strictly can load
  the skill.
- The guard runs every check the project has, not only the scope check. A check added with the
  `collet-check` skill was admitted, and ran at commit time and in CI, but stayed silent while a
  session was editing, which is the one place it was meant to catch the mistake first.
- A refusal now names the check that fired and carries the remedy that fits it. Widening the
  task is the answer to a write outside its files and to nothing else.

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
