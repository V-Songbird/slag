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
beside a planning tool's `ROADMAP.jsonl` or `.foreman/`: that tool owns the plan, collet enforces
the session boundary and never reads the roadmap. Mounting never installs a Git hook or CI workflow.
The delivered project runtime uses .mjs files independently of the target package's module type.
The mount writes a rules block, the text between collet markers in the project's `AGENTS.md`, and
in an existing `CLAUDE.md` unless that file has an `@AGENTS.md` import line; in such a
`CLAUDE.md` it empties a block an earlier mount left there down to its markers, leaving the text
around them as it was. The plugin's session start hook prints the open task when a session begins.

An optional `ask_first` list in `.collet/config.json`, written by `mount.mjs --ask-first`, names
what must not happen without asking the person. The rules block and the session start state it as
a fact about the project, never as an order. The rules block always adds a line, and the session
start adds it only while a task is open, that every other step goes ahead until
the accept command exits zero, or until a missing input or a broken environment means it cannot
pass as the task stands, which ends the work as a blocker named in the summary. The session start
reads the config each time; the rules block states the list from the last mount. Without a list,
the config, the block and the session start read exactly as before. With or without one, the rules
block states that such a blocker ends the work with the task still open; only an accept command
that exits zero finishes it.

`mount.mjs --ask-rule <rule>`, repeated per rule the person confirmed, adds Claude Code permission
rules such as `Bash(npm publish *)` and `PowerShell(npm publish *)` to `permissions.ask` in the
project's `.claude/settings.json`. A rule guards only the shell tool it names, so task-harness
offers one rule per shell tool for each command and the mount passes each confirmed rule through
unchanged, never adding the other. It needs an `ask_first` list, from `--ask-first` or the config,
and a rule shaped as a tool name with an optional parenthesized specifier. The file is created when
missing; every existing key and rule stays, and a rule already there is not added again. A settings
file that is not a JSON object, or whose `permissions` is not an object or `permissions.ask` not a
list, stops the mount before anything is written. The mount writes no other settings file: not the
user's, not `.claude/settings.local.json`, and nothing for Codex or Antigravity. Without
`--ask-rule` it touches no settings file. A headless run cannot answer the prompt such a rule
raises, so the host refuses the matching command there.

The session start leaves out of what it states every character a model reads and a person does
not see: U+200B-U+200D, U+2060, U+FEFF past the start, U+202A-U+202E, U+2066-U+2069, the
variation selectors U+FE00-U+FE0F and U+E0100-U+E01EF, the Mongolian free variation selectors
U+180B-U+180D and U+180F, the Mongolian vowel separator U+180E, and the Unicode tags
U+E0000-U+E007F. U+FE0E or U+FE0F right after an Extended_Pictographic character, and U+FE0F
between 0-9, # or * and the keycap U+20E3, choose how an emoji shows, so they stay. U+180B-U+180F
right after a Mongolian letter, U+1820-U+1878 or U+1880-U+18AA, shape that letter, so they stay
too, and so does U+180E right after such a letter's selector U+180B-U+180D or U+180F. That covers the project line, the
`ask_first` list, the conventions, the open task's id, title, scope, accept command and Foreman id,
and `.collet/handoff.md`. The joiner inside an
emoji and the tags of a subdivision flag render, so they stay: U+1F3F4, two lowercase letter tags
or three digit tags, one to four lowercase letter or digit tags, then the cancel tag U+E007F. Tags
behind U+1F3F4 in any other shape are left out. A closing line names each field
that held such characters and their code points, counting tags and never decoding them. Text
without them reads exactly as before. The handoff hook writes the open task's id, title, scope, accept
command and Foreman id into `.collet/handoff.md` without them, and ends the note with the same
closing line for the fields that held them. The session start leaves that closing line out of the
note it carries over and states only its own, since both name fields of the same ledger task.

The same characters, with the same exceptions, are refused where that text is written, and a
refusal writes nothing. `task.mjs add` refuses a title, `--why` reason, scope entry, accept
command or `--foreman` id holding one, an accept command taken from the config included; `task.mjs widen` refuses an
added path or its reason; `task.mjs close` refuses `--left-out` or `--unverified` text before the
live checks or the accept command run, so the task stays open. `mount.mjs` refuses an
`--ask-first` value, `--accept` and an `--ask-rule` value, and an `ask_first` entry in
`.collet/config.json` that it would render into the rules block, such as one edited in by hand. The
message names each field, a path, mount value or `ask_first` entry by the part of it that shows,
and the code points, counting tags and never decoding them. The pattern is defined once, in
`templates/state.mjs`: the hooks and the mount read the plugin's copy, and the task CLI reads the
copy mounted beside it, which a project refreshes by mounting again. Text stored before, or edited
into the config or ledger by hand, still reaches the session start, which leaves those characters
out as above.

## Project state and scope

The task CLI owns its ledger. Opening a task requires filled configuration and resolves supported
JavaScript/TypeScript imports to include the directly related files. Widening records a reason and
only expands from the added entries. Other language scopes must be derived from their source.

`task.mjs add --foreman <id>` records a planning tool's entry id as `foreman` on the task, and
`status` and `list` show it. The id is a label: collet never looks it up, so it must be 1 to 64
letters, digits, `.`, `_` or `-`, starting with a letter or digit, and is refused otherwise. The
scope and accept command are the same as for the task opened without it. A task opened without
the option has no `foreman` field and reads as before.

When a task with a `foreman` id closes with its live checks and accept command passing, `close`
prints one more line after its closing message: the Foreman `update-status` step that moves the
entry to `awaiting_acceptance`, with `<commit sha>` standing for the commit that lands the work,
for the session to run once it has committed. collet never runs that step and never writes
`ROADMAP.jsonl` or `.foreman/`. A failing close and a close of a task without the id print no such
line.

A task with a `foreman` id keeps what nobody checked in that entry's `unverified:` note lines. Its
passing close prints the `--unverified` text after the step, saying it belongs there and not in
`.collet/unverified.md`, then the `--left-out` text, saying it belongs in the entry's notes too because
otherwise only the ledger keeps it. It leaves `.collet/unverified.md` unchanged; the ledger still records both texts. While such a
task is open, the session start and the handoff note name the entry's notes for its claims. The
session start also names `.collet/unverified.md` when that file holds a list item (a line starting
with `- ` or `* `), the form an earlier close of a task without the id writes. A task without the id appends both texts to
`.collet/unverified.md` on close, and the hooks name that file.

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

A write to a path under `docs/tasks/`, `docs/decisions/`, `docs/knowledge/private/` or
`docs/apis/private/`, at any depth, that Git ignores and that holds no tracked file is a private
record, not a task change. The live check never lists one, so the scope check lets it through for
every session in the checkout, the task's own and any other. Any other ignored path outside the
scope stays refused, including dependencies and build output. A location whose path above its
`docs/` folder lies inside a directory Git ignores, such as a dependency's own `docs/tasks/`, holds
no private records.

Some names stay refused whether ignored or not, in any directory or file name of the path, above
the location as well as inside it:

- any path with a file or directory name that starts with a dot, where host settings live;
- any `AGENTS*.md` or `CLAUDE*.md`, in any letter case, which a host loads into later sessions;
- any name that holds a colon or ends in a dot or space, which Windows can resolve to one of the
  names above.

The harness's own `.collet/` files stay refused everywhere. A link can point an ignored path at a
tracked one, so the path the write lands on, resolved from its nearest existing parent, must pass
the same tests and stay inside the repository. Where Git or the filesystem cannot answer, the path
is checked against the scope as before.

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
between the collet markers in `AGENTS.md`, `CLAUDE.md` or `.cursor/rules/collet.md`, nor a
planning tool's `ROADMAP.jsonl` and `.foreman/`. A rules file
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
