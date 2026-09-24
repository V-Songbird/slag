---
type: knowledge
summary: "Records user-facing collet changes by release; read when upgrading or checking when behavior changed."
related_files:
  - collet/README.md
  - collet/.claude-plugin/plugin.json
  - collet/.codex-plugin/plugin.json
  - collet/plugin.json
---

# Changelog

All notable changes to collet are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The session start leaves out characters a model reads and a person does not see — zero-width
  characters, the word joiner, a byte order mark past the start, bidi embeddings and isolates, and
  Unicode tags — from the project line, the ask-first list, the conventions, the open task's title,
  scope and accept command, and the handoff note. A closing line names each field that held them
  and their code points, counting tags and never decoding them. The joiner inside an emoji and a
  subdivision flag stay, and text without such characters reads as before.
- The rules block states that when a missing input or a broken environment means the accept
  command cannot pass as the task stands, the work ends as a blocker named in the summary and the
  task stays open; finished still means the accept command exited zero. With an ask-first list, the
  rules block and the session start name that blocker as the other end of the keep-going line. A
  mounted project gets the new rules text by mounting again.
- A session start or handoff its host cut short leaves a trace: each hook marks itself running
  under `.collet/` and clears the mark when it ends, and the next session start says once that the
  handoff note may be missing or stale, or that the last session may have started without its
  context. A hook that finishes changes nothing.
- A guard call its host cut short leaves a trace: while a task is open the guard logs a start and a
  finish for every call, and the next guard call, `task.mjs status` and `task.mjs close` name a
  call that started and never finished. Nothing is refused because of it. A mounted project gets
  the status and close reports by mounting again.
- `mount.mjs --exclude <glob>` stores paths in `.collet/config.json` that no bundle check reads,
  such as a committed generated mirror of `src/`. A project without the list is checked as before.
- A bundle check you take out stays out: `mount.mjs --checks --remove <edition>.<class>` deletes it
  and records it in `.collet/config.json`, so a remount no longer brings it back.
  `--restore <edition>.<class>` returns it.
- Catalogue classes can carry a refusal `remedy`, an `exclude` list of paths they skip, and an
  `optional` flag that leaves them out of a mount unless `--with <edition>.<class>` names them.
  Classes without these fields check and mount as before.
- `task-harness` keeps the answer to "what must never happen here without asking":
  `mount.mjs --ask-first <thing>` stores it in `.collet/config.json`, and the rules block and the
  session start state it as a fact about the project, with a line that every other step goes ahead
  until the accept command exits zero. A project without the list reads as before. A mounted project gets the
  list and the rules text by mounting again with `--ask-first`.

### Changed

- `task-harness` asks a fifth question, which conventions a change here must respect, and takes
  the conventions it writes into `.collet/config.json` from the project's own files or from you.
  It asks when those files state none, leaves the list empty when nobody answers, and never reads
  outside the project root, sibling projects included, to answer a question.
- A successful `task.mjs close` prunes `.collet/guard-log.jsonl` to what is still read: the closed
  task's finished calls go, and refusals, unfinished calls and other tasks' records stay. A mounted
  project gets the pruning by mounting again.
- The JavaScript/TypeScript `type-widened-to-any` check is opt-in: a mount writes it only with
  `--with javascript-typescript.type-widened-to-any`, and keeps it where it is already installed.
- Python `skipped-test` refuses a `skipif` only when its condition is a literal `True` or `1`; a
  real platform or tool gate passes. `double-cast-through-unknown` no longer reads test files, and
  `blanket-lint-suppression` refusals say how a deliberate suppression passes: add `-- <why>`.
- `check-writer` looks for an open task before it writes anything. The guard refuses writes under
  `.collet/` while a task is open, so a check is added between tasks: close the open one, write
  and admit the check, then open the next.
- `task-harness` says the mount's files are left uncommitted and that the first task can close
  before you commit them.
- On Antigravity, `task-harness` and `check-writer` run every command from the project root you
  named, and ask for it when you named none.
- A bundle check that refuses a close names every file that introduces its pattern, up to ten,
  and counts the rest. A refusal for one file reads as before.
- Live checks share one read of the working tree: the bundle checks list the changes and read
  each file and `HEAD` baseline once per pass instead of once per check.

### Fixed

- The guard reads `rm`, `rmdir`, `cp`, `mv` and `tee` as the command of the shell that ran them:
  PowerShell's cmdlets under the PowerShell tool, the POSIX commands in a POSIX shell. So
  `cp -Dest .collet/off src/cli.mjs`, which PowerShell runs as a copy onto the kill switch, is refused
  while a task is open. Where the host does not name the shell, the call is refused when either
  reading writes under `.collet/`. A mounted project gets this by mounting again.
- Under PowerShell the guard reads a quoted leading `~` as the home directory, as PowerShell does,
  so `Remove-Item -Recurse '~'` is refused while a task is open when the home directory is outside
  the task or holds the project. A POSIX shell's quoted `~` stays a literal name. A mounted project
  gets this by mounting again.
- The `.collet/.gitignore` the mount writes lists `*.running`, so a mark left by a session start or
  handoff its host cut short no longer shows in `git status`. A mounted project gets the line by
  mounting again, and its other lines stay as they were.
- The guard reads `$PWD`, `${PWD}`, `%CD%` and a leading `~` in every path it reads, not only in a
  removal: `echo x > $PWD/.collet/off` and `mv $PWD ../elsewhere` are refused while a task is open.
  The quoting rules stay as they were. A mounted project gets this by mounting again.
- The guard reads a PowerShell argument written `-Name:value` as `-Name value`, abbreviated or not,
  so `Set-Content -Path:.collet/off -Value x` and `Remove-Item -LiteralPath:.collet` are refused
  while a task is open. A switch written `-Recurse:$false` takes nothing further. A mounted project
  gets this by mounting again.
- The guard skips the value of every PowerShell parameter that takes one, the cmdlet's own such as
  `-Width` or `-Credential` and the common ones such as `-ErrorAction` or `-OutVariable`, so the
  value is never read as the path: `Out-File -Width 200 .collet/off` is refused while a task is open.
  A mounted project gets this by mounting again.
- While a task is open, the guard reads `$PWD`, `${PWD}`, `%CD%` and a leading `~` in a removal as
  the working directory or home directory they name, so `rm -rf "$PWD"` at the project root is
  refused as `rm -rf .` is. Single quotes keep them literal, and any other variable or substitution
  stays unread. A mounted project gets this by mounting again.
- While a task is open, PowerShell's built-in aliases such as `mi`, `del`, `copy`, `ac` and `ni`
  get the decision of the cmdlet they name for every path, not only under `.collet/`: `mi notes.txt
  src/cli.mjs` is refused under a narrow scope, as `Move-Item notes.txt src/cli.mjs` is. `rmdir`
  reads as a removal in a POSIX shell too. This replaces the `.collet/`-only reading of those
  aliases described below. A mounted project gets this by mounting again.
- A mount over a `.collet/config.json` whose `accept` is not a string stops before writing anything
  and names the file and the field, with or without `--accept`. It used to fail after writing
  collet's scripts when `--accept` was given.
- The guard reads a PowerShell flag abbreviated as PowerShell allows, such as `-Dest` for
  `-Destination` or `-Na` for `-Name`, and decides it as the full flag. A prefix that begins more
  than one parameter stays unread, as PowerShell refuses it. `Tee-Object` also counts the file it
  names with `-LiteralPath` or `-Path` as written. A mounted project gets this by mounting again.
- A new `AGENTS.md`, `CLAUDE.md` or `.cursor/rules/collet.md` that holds only the rules block no
  longer keeps the first task open once you stage it; it counted as a change outside the task after
  `git add` and not before. Your own text in a new rules file still keeps the task open.
- A `--checks` remount over an unedited older `.collet/source.mjs` proves the new checks against
  the runtime it installs, so it no longer refuses checks the refreshed runtime passes. An edited
  copy is still the runtime they are proven against.
- A mount over a `.collet/config.json` it cannot read stops before writing anything and names the
  file and the problem. It used to fail halfway, with collet's scripts refreshed and no rules
  block, and a config holding a JSON array was overwritten.
- The first task after a mount can close before the mount is committed. Closing no longer counts
  `.collet/` or the rules block between the collet markers; your own text in those files still
  keeps the task open.
- Closing reads changes relative to the mounted directory, so a project mounted below the Git root
  closes its in-scope work and no longer reads changes outside that directory. A file name Git
  would quote is compared as written.
- A staged move out of a file outside the task keeps the task open: closing checks both sides of
  a move.
- A refused write under `.collet/` advises closing the task instead of widening it, and
  `task.mjs add` and `task.mjs widen` refuse `.collet/` paths other than `.collet/unverified.md`.
- A project mounted before these fixes gets them by mounting again, because the mount copies
  `task.mjs` and the scope check into `.collet/`. Until then, a refused write under `.collet/`
  still advises widening the task.
- While a task is open, the guard also refuses the shell writes it can read when they would create
  a file under `.collet/`, such as a new check or the `.collet/off` kill switch.
  `.collet/unverified.md` and new scratch files elsewhere stay allowed. A mounted project gets this
  by mounting again, which refreshes its copy of the scope check.
- While a task is open, the guard also refuses `touch`, `ni` and `mkdir` under `.collet/`, a
  `.collet` path in another letter case, such as `.Collet/off`, and removing or moving `.collet`
  itself. Paths outside `.collet/` keep their decisions. A mounted project gets this by mounting
  again.
- While a task is open, the guard also refuses `Rename-Item`, `New-Item -Name` and PowerShell's
  built-in aliases such as `ren`, `move`, `del`, `rd`, `copy`, `ac` and `md` when they reach
  `.collet/`. Elsewhere those commands keep their decisions. A mounted project gets this by
  mounting again.
- While a task is open, the guard refuses removing or moving the repository itself, or a
  directory that holds it, such as `rm -rf ../<project>`: that takes `.collet/` with it. A sibling
  directory and anything outside the project keep their decisions. A mounted project gets this by
  mounting again.
- `task.mjs add` and `task.mjs widen` refuse `.collet` paths in any letter case, such as
  `.Collet/off`, as the guard does, instead of recording a scope entry the guard never allows. A
  name that only starts with `.collet`, such as `.colletrc`, is still accepted. A mounted project
  gets this by mounting again.
- Closing no longer counts a bundle match as new when it only moved: removed from one changed file
  and added with the same text to another, as when a file is split. Any other added match still
  keeps the task open. A project mounted earlier gets the new comparison by mounting again.
- Mounting again refreshes `.collet/source.mjs`, the runtime the bundle checks share, when it still
  holds what collet wrote, and then proves the checks against their examples. A copy with edits of
  its own is kept, and the mount says so.
- The mount's next steps, the README and the skill say that only the `project` line and the
  `accept` command block `task.mjs add`. A leftover `conventions` placeholder never blocked it and
  is dropped before a session is told the config, and an empty list is valid.

## [0.4.0-alpha] — 2026-09-21

### Fixed

- Check every literal deletion operand and both sides of a move against the open task, including patch move destinations.
- Keep PowerShell reads and copy sources outside write checks while checking the actual write destinations.
- Explain Codex hook trust and its activation check before the first guarded workflow.
- Resolve the Antigravity project from absolute tool paths when its event omits workspace context, so the guard reaches the mounted task.

### Changed

- Rename the `collet` skill to `task-harness` and `collet-check` to
  `check-writer`, with descriptive display names and updated invocation examples.
  The plugin remains named `collet`; both workflows keep their existing behavior.

## [0.3.0-alpha] — 2026-09-21

### Added

- Optional language bundles for patterns that weaken tests, type checks, lint checks or
  verification settings in JavaScript/TypeScript, Python, Go, Rust, JVM and .NET. Mount with
  `--checks` to detect root marker files, or repeat `--edition <id>` for nested packages or a
  deliberate subset. The mount proves each generated check
  against its planted mistake and lookalike, and preserves existing generated files on a rerun.
- The bundle reads `Write`, `Edit` and `MultiEdit` text during a task. Its working-tree checks
  compare match counts per detector with `HEAD`, so an unchanged legacy match does not fail a
  task. Shell writes and file tools whose text is not read are checked at close time.
- JavaScript test checks also recognize simple native `node:test` inline skip and focus options.
  Each added syntax has its own planted mistake and lookalike in the mounted project.

### Changed

- The requirement is Node 22 or later. It was Node 20.

### Fixed

- Closing a task reports a failed live check without assuming the change was outside the task's
  scope or suggesting a scope change. The task stays open and its accept command does not run.
- Closing also refuses checks that could not run, including an unavailable Git baseline or a
  custom check with no working-tree implementation. A skipped verification no longer permits
  the accept command or a claim that the task passed.
- Live checks with a missing, invalid or asynchronous result fail verification instead of
  reporting a pass without a result.
- A remount keeps a valid older check revision even when the catalogue now includes more example
  pairs. Custom fixture suffixes are preserved instead of mistaken for missing files.
- Rust success assertions such as `assert!(result.is_ok())` are permitted; they can enforce a
  real operation or invariant. Literal tautologies are still refused.
- Python configuration comments and ordinary multiline strings in C#, Java and Kotlin no longer
  expose their example text as executable violations. Dedicated fixture pairs check these forms
  before a preserved runtime is trusted with new catalogue checks.

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
