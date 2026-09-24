---
type: knowledge
summary: "Collet's task, scope and check contracts; read before changing mounting, root resolution, the guard or task closure."
related_files:
  - collet/scripts/mount.mjs
  - collet/hooks/lib.js
  - collet/hooks/guard.js
  - collet/templates/
  - collet/tests/
---

# Collet runtime contracts

Collet holds one open task with an explicit writable scope and an acceptance command. It mounts
only where no other roadmap owns planning. Mounting never installs a Git hook or CI workflow.
The delivered project runtime uses .mjs files independently of the target package's module type.

An optional `ask_first` list in `.collet/config.json`, written by `mount.mjs --ask-first`, names
what must not happen without asking the person. The rules block and the session start state it as
a fact about the project, never as an order, with a line that every other step goes ahead until
the accept command exits zero, or until a missing input or a broken environment means it cannot
pass as the task stands, which ends the work as a blocker named in the summary. The session start
reads the config each time; the rules block states the list from the last mount. Without a list,
the config, the block and the session start read exactly as before. With or without one, the rules
block states that such a blocker ends the work with the task still open; only an accept command
that exits zero finishes it.

The session start leaves out of what it states every character a model reads and a person does
not see: U+200B-U+200D, U+2060, U+FEFF past the start, U+202A-U+202E, U+2066-U+2069 and the
Unicode tags U+E0000-U+E007F. That covers the project line, the `ask_first` list, the conventions,
the open task's title, scope and accept command, and `.collet/handoff.md`. The joiner inside an
emoji and the tags of a subdivision flag render, so they stay. A closing line names each field
that held such characters and their code points, counting tags and never decoding them. Text
without them reads exactly as before.

## Project state and scope

The task CLI owns its ledger. Opening a task requires filled configuration and resolves supported
JavaScript/TypeScript imports to include the directly related files. Widening records a reason and
only expands from the added entries. Other language scopes must be derived from their source.

Scope accepts literal files, folders and supported globs. Reads are allowed outside writable
scope. Literal shell deletion checks every operand; moving checks source and destination, while
copy sources remain reads. Patches include every file operation and the Move to destination.
Dynamic shell expressions are outside this bounded parser, apart from four tokens at the start of
any path it reads: `$PWD` and `${PWD}` (in any letter case under PowerShell) and cmd's `%CD%` read
as the call's working directory, and `~` as the home directory, unquoted in a POSIX shell and quoted
or not under PowerShell, whose FileSystem provider resolves it. Single quotes keep `$PWD` and `%CD%`
literal, and a call whose working directory the host does not name leaves them unread. Existing
policy permits paths outside the repository and new shell scratch paths outside `.collet/`; live
working-tree checks cover
repository changes. While a task is open, a shell write target under `.collet/` is refused
whether or not it exists, except `.collet/unverified.md`: the live check skips that directory,
and a new `.collet/off` would switch the hooks off. `touch` and `mkdir` operands are write targets
only under `.collet/`, and so are Rename-Item's source and new name and New-Item's `-Name` under
its `-Path`. PowerShell's built-in aliases of the parsed cmdlets (`ac`, `clc`, `copy`, `cpi`,
`move`, `mi`, `del`, `erase`, `rd`, `ri`, `rmdir`, `ren`, `rni`, `md`, `ni`) get the decision of
the cmdlet they name for every path, so `rmdir` reads as a removal in a POSIX shell too. Removing or
moving the repository root, or a directory that holds it, counts as a write under `.collet/`,
although the root itself reads as outside the repository. For every tool, the `.collet` prefix
matches in any letter case, because a case-insensitive filesystem resolves `.Collet/off` to the
kill switch, and `.collet` itself is never writable. A PowerShell flag may be abbreviated as
PowerShell allows: it reads as the one parameter of that cmdlet it names or begins, so `-Dest` is
`-Destination`, and a prefix that begins several stays unread, since PowerShell refuses it. `rm`,
`rmdir`, `cp`, `mv` and `tee` read as the command of the shell that ran them: PowerShell's cmdlets,
with its flags, under the PowerShell tool, and the POSIX commands, with their own flags, in a POSIX
shell. Claude Code and Codex name a Bash tool's shell as POSIX only off Windows, and Antigravity
names none; with the shell unknown the POSIX reading decides, and the PowerShell reading adds what
it would write under `.collet/`. `mkdir` keeps its POSIX flags.

Explicit host project context takes precedence. With missing Antigravity workspace context,
absolute tool paths may identify the nearest mounted harness. Relative paths do not anchor a
project from the plugin's working directory.

## Checks and closure

A check is admitted only when it catches each shipped violation and leaves its near misses alone.
The session guard loads project checks with the scope fallback from the plugin. Hook errors fail
open; the explicit .collet/off file disables hooks, not committed standalone checks.

A host cuts a hook short at its timeout, 10 s in collet's hook files, and discards its answer.
Claude Code documents that the tool call then goes ahead; Codex and Antigravity are not checked.
So while a task is open the guard logs a start in `.collet/guard-log.jsonl` before its checks and
a finish after them, and a log it cannot read or write changes no answer. A start with no finish
that is older than the timeout is a call cut short. The next guard call of the same task reports it
once, at the end of a refusal or as context on an allowed call for hosts that take it, and
`task.mjs status` and `close` list the last three. None of this refuses anything. After a
successful close, `task.mjs` removes the closed task's finished calls from the log: their starts,
their plain finishes and the markers that reported its calls cut short. Every refusal, every start
with no finish, every other task's record and every line that does not parse stay in order, and a
record the guard appends during the rewrite survives. A refused or failed close leaves the log as
it was.

The session-start and handoff hooks have the same timeout. Each writes a mark,
`.collet/session-start.running` or `.collet/handoff.running`, before it loads the project's state
and clears it when it ends, so a mark older than the timeout is a run the host cut short. The next
session start reports each such mark once, in its context: a cut-short handoff means
`.collet/handoff.md` may be missing or stale, and a cut-short session start means that session may
have started without its context. A mark still inside the timeout is left to the run that owns it,
and a mark that cannot be written, read or removed changes no output. The `.collet/.gitignore` the
mount writes lists `*.running`, so a leftover mark stays out of `git status`.

Closing a task first requires strict live checks against the Git baseline, including untracked
files, then runs the acceptance command. The scope check reads those changes relative to the
mounted directory, so a mount below the Git root covers only its own directory. It lists them
itself, apart from the one listing the bundle checks share in a pass: it must work without the
bundle's `.collet/source.mjs`, and it needs both sides of every move, so a `--live` pass lists
the changes twice. It does not count the harness's own writes: `.collet/` and the rules block
between the collet markers in `AGENTS.md`, `CLAUDE.md` or `.cursor/rules/collet.md`. A rules file
that `HEAD` does not have is compared with an empty file, whether it is untracked or staged. The
project's text around that block still counts. Missing scope, unavailable Git, skipped required
checks or invalid results cannot prove completion. A failing stage leaves the task open. A
successful close records what was left out and unverified and clears obsolete handoff state.

The optional language catalogue is a source-pattern policy, not a judgment of intent. Code text
unavailable at write time is evaluated later against the working tree. Custom checks must provide
real live coverage to support strict closure. Existing custom/generated checks are preserved
according to the mount preflight; collet-owned runtime files are refreshed on remount. The bundle
checks' shared `.collet/source.mjs` is refreshed only while it holds what collet wrote: its first
line records the hash of the rest, or its content matches a version collet shipped. An edited copy
is kept, and the mount says so. A refresh is followed by the same proof as a mount with checks. The
catalogue preflight proves new catalogue checks against the runtime the mount leaves in place: the
template when the project's copy is missing or unedited, and an edited copy itself.

A catalogue class may carry three optional fields. `remedy` is text appended to its refusal.
`exclude` lists globs taken back out of its `paths`, at write time and at close. `optional: true`
makes it opt-in: the mount writes it only when `--with <edition>.<class>` names it, and keeps it
once installed. A class without them behaves as before; mount refuses a malformed one.

An optional `exclude` list in `.collet/config.json`, written by `mount.mjs --exclude <glob>`, takes
paths out of every bundle check next to each class's own `exclude`, at write time and at close. A
config without it, or one the checks cannot read, excludes nothing extra.

`mount.mjs --checks --remove <edition>.<class>` deletes that class's check and examples and records
it in `removed_checks` in `.collet/config.json`; every later mount keeps it out.
`--restore <edition>.<class>` drops it from the list and writes it again. A project that removed
nothing has no such field, and its config and mount output are unchanged.

## Verification

Run npm run check for the repository, which also fails when a suite fails outside its tests, or
node --test from collet/. Fixtures are self-contained and require no private notes or owner
profile. See the [plugin README](../../README.md) for commands and current limits, and the
[harness workflow](harness-workflow.md) for configuration and usage.
