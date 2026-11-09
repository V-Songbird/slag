---
type: knowledge
summary: "Records user-facing anneal changes by release; read when upgrading or checking when behavior changed."
related_files:
  - anneal/README.md
  - anneal/.claude-plugin/plugin.json
  - anneal/.codex-plugin/plugin.json
  - anneal/plugin.json
---

# Changelog

All notable changes to anneal are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [Unreleased]

### Added

- `docs-check.js --index` prints a record index for `docs/index.md`: the path and summary of every maintained record, grouped by type, listing only files Git does not ignore and leaving out private records when the project ignores them. `repo-docs adopt` offers to write it and point the map file's `Start here` at it, and `maintain` regenerates it and proposes the difference.
- On Claude Code, a `SessionEnd` hook shows one line when the session wrote under a `docs/` folder or the project's memory folder with a file tool: the number of documentation proposals, the stale memories and unread task notes among them, and the command `/anneal:repo-docs maintain` that lists them. It counts writes made by the session's subagents, read from their transcripts, as well as the main transcript's. It writes nothing and stays silent without proposals. Set `ANNEAL_SESSION_REPORT=off` to turn it off.

### Changed

- On Codex, the session evidence counts a `function_call` as a shell command only when it calls a shell tool: `exec_command`, `shell_command` or the legacy `shell`. A server's tool or any other tool whose arguments hold `cmd` or `command` no longer adds commands or paths to the operations.
- The session close-out reports a tracked file that is gone from disk with uncommitted changes as `tracked-missing`, at risk, so the turn that wrote it is `transcript-only`; it was reported as `tracked` and safe to delete. The `missing` location is described as a file Git no longer tracks, including one a commit removed, whose uncommitted edits only the transcript holds. Git commands inside a here-document body, a PowerShell here-string or a block comment no longer count toward the cleanup flag, and a here-document with an empty body no longer hides the commands after it.
- The audit's start context counts each file once, even when it is named twice or, on Windows, in another letter case. It skips an `@path` in an indented code block, and an `@word` that names no file and does not look like a path, such as a mention or a scoped package, is no longer reported missing. The `map-routes` observation reads imports the same way.
- The audit's start context adds a `hook text` table from the project's latest Claude Code transcript: the characters hooks added to the context, by hook script and by event, outside the total. A transcript line that is not JSON is skipped, and a transcript that cannot be read gets one line instead of stopping the audit.
- Session evidence keeps the path of a Claude Code file tool call, such as `Read` or `Edit`, whose path holds `$`, `%`, `*`, `?`, braces or a backtick, as in `routes/$id.tsx`; such a path was dropped as if a shell would expand it. Shell commands still drop those paths, and a path with a leading `~` stays unresolved in both.
- On Claude Code, the session evidence names a call a `PreToolUse` hook denied (`PreToolUse:<tool> hook error:`) as `blocked`, so it carries `retriesAfterRefusal`. The identical call sent again, with every input field alike, is no longer listed: the hook judges it again, and a hook that asks only once can let it through. `session-review` tells the reviewer to read the calls between the two when that identical call succeeded. A refused call of a tool that is neither a shell nor a file tool is retried by a call of the same tool with the same full input, in any key order; after a hook's denial, that identical input is no retry and any other input of the same tool is one. A call that differed in another field, or past the first 480 characters, was listed.
- `repo-docs` has a description under 800 characters, with the same scope, trigger phrases and exclusions; its argument hint lists the modes.
- On Claude Code, `subagentTranscripts` lists the `agent-*.jsonl` files at any depth of the session's `subagents` folder, including a workflow's folder there; it read only the folder's top level.
- The maintenance proposals count a read in a session's subagent transcripts, so a completed task note that only a subagent read is no longer proposed as unread.

- `docs-check.js` and `repo-docs adopt` count a private directory as ignored only when a `.gitignore` in the repository ignores it. A rule in `core.excludesFile` or `.git/info/exclude` no longer sets the profile, hides `.private/` or stops adopt from writing the rule, since a clone does not carry it.
- `readme-check.js` counts an HTML `<h1>` and a setext title (`===` underline) as the H1 outside fences, and flags link text that repeats its URL when the label differs from it only by the scheme, a leading `www.` or a trailing slash.
- `readme-check.js` counts an `<h1>` on a line that opens with another tag, such as `<div align="center"><h1>`, and a setext title whose text starts with `#` but is no ATX heading, such as `#1 Tool`. A title inside an HTML comment, and an `===` under a list item, a quote, a heading, a thematic break or an `<h1>` line, no longer count.
- `readme-check.js` hides the lines below a `<!--` only when it begins the line after up to three spaces, and only until the first `-->`. A `<!--` in a sentence, in a code span or escaped as `\<!--` no longer hides the title after it.
- In the `writing` eval cases, `node-before-install` passes a page whose Node 22 line mentions installing first, such as "Before you install csv-tidy, you need Node 22 or later", or tells the reader to install Node.js 22, and passes a page with an `## Install` heading above that line. `names-unnumbered-steps` and `names-overwrite-order` no longer pass a reply that only lists findings by severity, mentions a missing row count, tells the reader to save a copy first, or says the file is overwritten after the command runs.
- A request to `repo-docs` to write one page for people authorizes writing that page and works on it alone; a request to review one page reports on that page alone.
- The layout audit and the maintenance proposals find their host inputs from `--root` alone. The audit counts the global `CLAUDE.md` and the project's Claude Code memory index, lists Codex's global `AGENTS.md` apart from the Claude Code total, and says when no `SessionStart` hook is declared. The maintenance proposals read the Claude Code transcripts folders of the project and its `.claude/worktrees/` sessions, and its memory folder. The memory folder follows `autoMemoryDirectory` in `.claude/settings.local.json` or the Claude Code home's `settings.json`. `--global`, `--memory` and `--transcripts` still replace them, and a missing default folder prints one line while the run goes on. The audit shows paths outside the repository with the home as `~`; a memory proposal's path stays one you can open.
- When you pass no `--memory` and no memory is in the project's memory folder, its own Claude Code folder or, for a linked worktree, the primary checkout's folder, the layout audit adds a `memory left behind` block: the other project folders with memory whose transcripts name this repository's remote or path, with each folder's memory file count. It moves nothing. The `repo-layout` map-file reference describes `autoMemoryDirectory` as the way to keep memory inside the repository.
- The layout audit shows a path outside the repository with the home as `~` and the account name kept, so the path still names the file. In a linked worktree it also reads the primary checkout's Claude Code transcripts folders. `autoMemoryDirectory` set to a bare `~`, or on Windows to `~\<dir>`, is read as the home. A derived memory index that does not exist is named as not found. The maintenance proposals read transcripts only when a completed task note was last written more than three days ago.
- The layout audit's start context adds one line when the global instruction files and their imports pass a quarter of the budget, pointing at the section on text that loads only when needed in the anneal workflows guide.
- Rename `docs-align` to `repo-docs`. `/anneal:repo-docs`, `$repo-docs` and `/repo-docs` replace the old invocations; the reconciliation procedure moved to the skill's `references/reconcile.md`, and `references/policy.md` holds the documentation contract: five invariants, the profiles `solo-public`, `private-repo` and `team`, and an `adopt` mode that, after approval, writes a project-local rule, a pointer in each map file and, for `solo-public`, ignore rules from a shipped template. Adopt never untracks a file and never ignores all of `docs/`, `docs/knowledge/` or `docs/apis/`.
- The memory pass of `maintain` no longer reports an `npm run` script or a flag that follows a `cd` in the same span, as in `cd sub && npm run build -- --watch` or `(cd sub && npm run build)`, or the flags of a script whose path starts with `../`.
- On Codex, `repo-docs`, `repo-layout` and `session-review` each show their own icon in the skill list.
- `session-review` shows a one-line menu description. It runs only when you invoke it, so the longer trigger text was never read.
- `repo-docs` has a shorter description that puts its trigger phrases first. It links every reference file from the skill itself, and its README reference opens with a contents list.
- `repo-layout` and `session-review` open with a checklist of their steps for the session to copy and tick.
- `repo-docs`' description now leads with writing pages people read, and no longer excludes API reference pages, tutorials, changelogs or CONTRIBUTING files. It still sends code layout to `repo-layout` and a session transcript to `session-review`.

### Added

- The documentation contract says who reads each record kind: task notes are for agents, with their summaries for the owner; decision records for people and agents; public knowledge and API pages for people first and agents too; private knowledge and private API research for agents; `.private/` for agents and scripts. A record read mainly by people follows the writing reference, a record for agents favors exactness and brevity, and `adopt` tells the owner which is which.
- The layout audit lists, in an `instruction drift` block, the list items that only one host's global instruction file has, from the Claude Code and Codex files it finds or each `--global` file you name. Items that name a host are left out. It only reports, and edits neither file. Each item shows the home as `~` and masks the account name.
- `session-repeats [sessions folder or transcript files]` finds the steps this project's past sessions repeated the same way, such as one command, a short chain of commands, one file looked up or one prompt you typed, and proposes for each a command or a short no-model script plus the map-file line that names it. It reads Claude Code and Codex sessions, skips the running one, and writes only the entries you approve. A repeated prompt, slash commands included, has its home path and an account name in a path redacted as in the session evidence before it is lower cased into its key.
- `session-review closeout <session id or transcript file>` reports whether deleting a finished Claude Code session would lose work: each file the session wrote, by where it lives now, and each turn whose closing text no tracked or ignored file holds. It reads the whole session, writes nothing and deletes nothing.
- The close-out adds a `cleanup` flag: background commands and preview servers the session started and never saw end, worktrees and branches it created and never removed, and whether it ran `git status --ignored` after its last change. It only reports and stops nothing; the delete verdict is unchanged.

- repo-docs handles README requests on its own, through its `readme` argument or a request that never says README, such as "add a quick start". Its `references/readme.md` writes, reviews, scores, improves, edits or translates one README, with tier templates in `references/readme-templates.md` and a scoring rubric and final checklist in `references/readme-review.md`. The reconciliation reviews every maintained README the same way, with no optional skill to install.

- `anneal/scripts/readme-check.js` checks one README and writes nothing: unclosed fences, the H1 count, badges above the description, fences with no language, a `$` prompt in a copyable block, no shown result, leftover placeholders, link text that names no destination or repeats its URL, filler words, long sentences and, with `--tier`, a prose budget. It needs only Node and exits 2 for an unknown tier.

- Eval cases tagged `readme` check a README review that changes nothing and a README repair asked for without the word README. They have not run in a live session yet.

- repo-docs writes and reviews pages people read, such as help pages, guides, how-tos, FAQs, troubleshooting, changelogs and contributing guides, through its `references/writing.md`, even when the request never names writing rules. The README reference links the same writing rules instead of repeating them.

- Eval cases tagged `writing` check a help page written without naming the skill and a page review that changes nothing. They have not run in a live session yet.

- repo-docs takes `maintain` for proposals that trim documentation: docs whose related files changed after them, completed task notes to fold and delete, oversized history to condense, per-roadmap-entry docs to merge, and records of an orphaned knowledge store to fold into the docs that own their paths. `anneal/scripts/docs-maintenance.js` finds them and changes nothing; the skill acts on a group only after you approve it. Uncommitted edits count toward drift, and `--transcripts` keeps a completed note that another Claude Code session read within three days of its last write.

- repo-docs's `maintain` takes `--memory <folder>` for a native memory folder and proposes trims without writing to it: index lines with no file, files with no index line, named project paths, `npm run` scripts and script flags that no longer exist, near-duplicate pairs, and memories older than 14 days that state a current condition. Script flags are those in `npm run <script> -- --flag` and in `<script> --flag` run by `node`, `bash`, `sh`, `py`, `python` or `pwsh`. The pass leaves MIME types, `../` paths, paths under a deleted top folder, git refs whose first segment is not a project folder, refs before any `--` in `git checkout`, `switch`, `push`, `branch`, `merge` and `rebase`, and every other command's flags alone. Each command of a span joined by `&&`, `||`, `|` or `;` is read on its own. A folder without `MEMORY.md` is refused.

- `anneal/scripts/docs-check.js` reports where a project's documentation breaks the documentation policy, without changing anything. High findings cover the public/private boundary: ignore rules, tracked files in private directories and public pages that link private ones. Medium findings cover oversized task notes and history-like documents and completed task notes. Low findings cover frontmatter, type versus folder, `related_files` and filenames. Whether private documentation is ignored or versioned comes from the project's ignore rules. The ignore probes, the tracked-file check and their tests moved here from a standalone gitignore skill's `check-ignore.mjs`.

- The audit reports what every Claude Code session loads before its first prompt: the project's instruction files with their `@path` imports, rule files without a `paths:` scope, a global instruction file and a memory index passed with `--global` and `--memory`, and declared `SessionStart` hooks. Each source shows its characters and its share of a 20,000-character budget. The audit proposes no edit and changes nothing.

- session-review suggests collet's `check-writer` skill for a mistake a machine could catch, when `.collet/` exists at the Git root. The suggestion appears in the report, beside any map-file change for the same finding, and nothing is written or run. Without `.collet/`, the report points to the project's own linter or tests.

- Eval cases tagged `session-failure` check what session-review proposes for one failure shape each: no rule for a one-off flaky failure, a machine path kept out of the map file, a refusal workaround reported as a safety finding, and `check-writer` named only when `.collet/` exists. They have not run in a live session yet.

### Fixed

- The session evidence script now spells out the variation selectors U+E0100 to U+E01EF as code points, such as `<U+E0100>`. Before, they were counted as Unicode tag characters, and next to real tags the runs merged.

- `instruction-hidden-characters` now reports variation selectors U+FE00 to U+FE0F and U+E0100 to U+E01EF, naming each code point. U+FE0E or U+FE0F right after an Extended_Pictographic character, and U+FE0F between 0-9, # or * and the keycap U+20E3, are still skipped, since they choose how an emoji shows. Before, every variation selector went unreported.

- `instruction-hidden-characters` now reports the Mongolian free variation selectors U+180B to U+180D and U+180F, except right after a Mongolian letter (U+1820 to U+1878 or U+1880 to U+18AA), where they choose the letter's form. The session evidence script spells them out as code points too, such as `<U+180B>`. Before, they went unreported.

- `instruction-hidden-characters` now reports the Mongolian vowel separator U+180E, except right after a Mongolian letter (U+1820 to U+1878 or U+1880 to U+18AA). The session evidence script spells it out as `<U+180E>`. Before, it went unreported.

- `instruction-hidden-characters` no longer reports the Mongolian vowel separator U+180E right after a free variation selector U+180B to U+180D or U+180F that follows a Mongolian letter, and the session evidence script keeps it there as it is. Before, it was reported and spelled out as `<U+180E>`.

- `instruction-hidden-characters` now reports Unicode tags after a black flag unless they form a subdivision flag: two lowercase letters or three digits, one to four more lowercase letters or digits, then the cancel tag. Before, any tags after a black flag were skipped, so text written as tags behind one went unreported. The session evidence now counts those tags too.

- In Claude Code and Codex sessions, the session evidence script now starts the excerpt of a failed Node import (`ERR_MODULE_NOT_FOUND`) at the error's own line. This also holds after progress text rewritten with a carriage return and in a Node test runner's TAP report. A line too long for the excerpt loses its middle instead of its end, so the excerpt keeps the importing file however long the workspace path is.

- The session evidence script no longer labels a command that ran and then failed on a missing Node module (`MODULE_NOT_FOUND` from CommonJS, `ERR_MODULE_NOT_FOUND` from ESM) as `command-not-found`. That failure now gets the same category as any other failed command, such as `nonzero-exit`. A module-not-found failure the host did not report as failed, such as one behind a pipe, is no longer a candidate unless its output names another known diagnostic. A shell's "command not found" and PowerShell's "is not recognized as the name" still get `command-not-found`.

- The session evidence script now labels a failed command that cmd.exe could not find ("is not recognized as an internal or external command") as `command-not-found`, in both Claude Code and Codex sessions. Before, that failure got `nonzero-exit`. The same message in output the host did not report as failed, such as `cmd /c foo` followed by another command that succeeds, is now a `command-not-found` candidate matched on the diagnostic text alone; before, it was no candidate.

## [0.5.1-alpha] — 2026-09-25

### Fixed

- A docs-align or repo-layout audit saves no copy of the audit's output outside the project. docs-align writes its coverage checklist only in a scratch directory the host names for the session; without one it writes no file anywhere.
- The audit keeps running when Git cannot read an ignore file, such as a global excludes file that a sandbox denies. It lists untracked files without that file's rules and names it in a `limitation:` line, `limitations` in the JSON; before, the script crashed when Git could open the file but not read it, and said nothing when Git skipped a file it could not access. docs-align and repo-layout report the limitation instead of skipping the audit.

## [0.5.0-alpha] — 2026-09-23

### Added

- The audit reports `instruction-hidden-characters`, low: characters invisible on screen, such as zero-width characters, bidi controls and Unicode tags, in a map file or a host rule file. Each entry names the file, the line and the code points, and counts tags without decoding them. Emoji joiners and subdivision flags are not reported.
- The session evidence spells out characters a reader cannot see in every excerpt: each as its code point, such as `<U+200B>`, and a run of Unicode tags as its count. session-review reports text hidden that way against its source and never decodes it.
- session-review checks its map-file edit against the entries you approved, repo-layout reads the diff of a step that wrote the map file, and docs-align reads the diff of each instruction file it changed. A line no approval or finding holds is reverted and reported.
- On Claude Code, the session evidence names a call a permission rule or the permission mode refused as `permission-refused`, and gives each refused call a `retriesAfterRefusal` list: later calls for the same prompt that reached the same path, or ran the same program with the same first argument, in another form. session-review reports one that worked around the refusal to you as a safety finding, never as a rule.
- Eval cases `map-reader-original` and `map-reader-oriented` reduce the navigation repository to its notes and ask four questions the map may or may not answer. A reply passes only with the answers the map supports and `not in the notes` for the rest.
- Eval case `session-audit-stops-on-unreadable-transcript` gives session-review a transcript with one record cut off, which the evidence script refuses. It passes only when the reply says the transcript could not be read and proposes nothing from the records around the cut. session-review now stops on that refusal instead of reading the transcript itself.
- Eval case `plan-flags-a-wrong-importer-count` asks repo-layout for a plan only and hands it a layout survey whose rename row claims one importer of a file that two files import. It passes only when the reply flags that row with what the search found and plans nothing from it as proposed.
- The session evidence names each call: the agent that made it, the prompt it served, its operation and its path. A `coverage` summary counts the calls issued, answered and left unanswered, and says whether the session only read files.
- The session evidence lists navigation candidates: a path that did not exist, a whole file read again, a read the host cut, a host notice in place of a file, and a large output. Each keeps what the transcript shows apart from a cause it might have, and names who would act, the smallest change and how to check it.
- `--before-line <line>` reruns the session evidence over exactly the records of an earlier run, and session-review reruns that way. `--before` now warns about a skipped record only when it held conversation.
- On Codex, a result without an exit code takes its outcome from its wrapper and its script: `ok` only when a completed script could not have hidden a failure, `unknown` when it could, and `pending` while the script runs. Neither of the last two counts as a success, and `coverage` counts the unknown results and the scripts still running when the interval ends.
- On Codex, the host's own records of commands and server tool calls decide a result where they belong to it beyond doubt. A failed record adds a candidate that names the command, clean records can turn `unknown` into `ok`, a record never turns a failure into a success, and `coverage.recordedOutcomes` counts the results records settled.
- The audit prints informational observations after its findings: what each map file routes to, which packages the map names, how long documents are reached, and which findings a package boundary, a framework path, a fixture or an unbuilt `dist/` explains. They have no severity and change no finding.
- The session evidence lists stall candidates: a turn that ended on an offer to go on, a question or the next steps, followed by a prompt that only says to continue, in English or Spanish. session-review reports each for your global instruction file, or proposes the map file when the ending names a project command.
- Eval cases: `migration-applies-approved-step` applies an approved migration step on a clean tree, and six navigation and six held-out cases compare a map without and with a `Start here` section on tasks whose answers are checked.
- Eval case `migration-moves-into-new-directory` approves a move into a folder that does not exist yet, and passes only when the branch, the new folder and the move each run in a Bash call of their own.
- Both migration eval cases fail a run that sends a check's output to a file or through `tee`.

### Changed

- repo-layout's audit, docs-align's audit and session-review treat a findings, report or notes file in the project as a change they do not make on their own, even when your own instructions ask to save findings. They show the findings, offer to save them and write that file only after an explicit yes; a run nobody can answer, such as a headless one, writes nothing. The session eval case now also fails a run that creates any file.
- session-review checks the actor, prompt, path and operation before it calls a later call a recovery or a repeat, and weighs `unknown`, `pending` and host-record outcomes as evidence, not verdicts. Each finding goes to the map file, docs-align, repo-layout, your global instruction file or the source that printed it.
- repo-layout and its layout survey propose a path hint before a rename or a move, and keep a name or path that an observation explains, including tracked folders that `source-dist` or `required-inputs` explains.
- docs-align proposes routes that take each task to the one document holding its contract and to the check that proves it, and keeps a long reference whole when headings reach its parts.
- repo-layout takes each check's exit code and printed line count from the run itself, with one form for POSIX shells and one for PowerShell, and never writes the output to a temporary file or through `tee`. Later reruns use the same form.
- repo-layout's migration creates the branch, the new target folder and each `git mv` as separate commands, and names the command you refused.
- When `anneal/<YYYY-MM-DD>` already exists, repo-layout switches to it only if it points at the current commit. Otherwise it stops, names that branch and its commits, and leaves merging, renaming or deleting it to you.
- repo-layout commits a set-aside step with the subject `anneal: <step>` on the next free `anneal/<YYYY-MM-DD>-set-aside-<n>` branch, and its report names each set-aside branch with the step it holds.
- repo-layout checks each rename or move the layout survey proposes: its file must exist and its importer count must match a search. A row that fails is listed as flagged after the plan, never planned.
- docs-align checks the evidence each reviewer cites before a finding enters its ledger, and its report opens with the decisions, approvals and blockers you owe.
- On a migration branch, the safety hook also refuses `clean --force`, `switch --discard-changes`, a `+` refspec push, a branch delete with `--force`, and the history rewrites `commit --amend`, `rebase`, `update-ref -d` and `reflog expire`. It reads the subcommand past any global flag, such as `--no-pager`, and reads a command split across lines as one line. Its denial says a rewritten form would discard the same work.
- On Antigravity, repo-layout, docs-align and session-review run every command from the project root you named, and ask for it when you named none.
- In audit mode docs-align keeps its coverage checklist in a scratch file outside the repository when the host names a session scratch directory it can write without a new approval, names that file while it exists and deletes it before the final report. Elsewhere the checklist stays in the reply. Audit mode still writes nothing in the project.
- The map file guidance accepts routes written in prose, tables, trees, links or `@path` imports, and offers reshaping an existing map as an option, not a fix.
- The map file guidance and the docs-align checklist require each `Start here` line to name only what its destination holds, checked against that destination's imports, exports or headings, and never a decoy or a folder to avoid.
- The eval graders catch a plain `mv`, a bare `git stash`, any new branch, tag, stash or file, and any edit to the session case's map file, and the session case passes only with the evidence script's report. The documented eval command runs the three original cases by tag and writes its results outside the repository.
- The session evidence writes your account name as `<user>` where it is a whole path segment, part of a Claude project key or an `ls -l` owner or group column. It stays as a word in prose or code and in `context.cwd`.
- The session evidence also writes your account name as `<user>` inside a lowercase folder name built from a path, such as `demo-app-c-users-<user>-codex` or `-mnt-d-projects-<user>-shop`. A longer name such as `<user>2` or `v-<user>` keeps the word.

### Fixed

- `check-command-missing` no longer fires when the checks live in a `scripts/` check script, a harness's check runner, a root Gradle or Maven build, or Node test files that `node --test` runs where there is no `package.json`.
- `build-output-tracked` no longer lists committed files under the input folders that `required-inputs` reports, such as a minified file under `test/fixtures/`, so it no longer suggests untracking what a test reads.
- Evidence redaction keeps prose after `Basic` or `Bearer`, finds the home directory in any case and in Git Bash, WSL and escaped JSON spellings, and shortens it in `context.cwd` too. Copied fields are cut to a fixed size, and a machine with no home directory no longer stops the script.
- A call that ran beside a failure, including one from the same assistant message, is no longer its later success. A notification or a subagent's instructions no longer becomes the cutoff, and a successful read that quotes an error is no longer a candidate.
- A failed read, search or edit of a missing file is `missing-path` for every wording the navigation candidates recognize, and a Read over its size limit is `output-too-large`.
- On Codex, the exit code is read from the result's header, where `Exit code: N` now counts too, and an exit line that a read quotes further down is output. A hook block, an interrupt or a failed agent call is a failure, and a task another agent started is no longer the cutoff unless you also prompted in it.
- On Codex, a result adds at most one nearby success, and none when its script printed fewer exit codes than the commands it runs. `sessionId` names the rollout's own thread, and a forked rollout's copy of its parent's history adds no calls.

## [0.4.0-alpha] — 2026-09-21

### Changed

- Rename `improve-agent-navigation` to `repo-layout`, `learn-from-session` to
  `session-review`, and `reconcile-project-docs` to `docs-align`. Invocation examples,
  UI names, references and eval selectors follow the new names; the workflows are unchanged.

### Fixed

- Preserve imports of other files with the same basename when moving a source file; explicit extensions retain their identity.
- Explain Codex hook trust and its activation check before the first guarded workflow.

## [0.3.0-alpha] — 2026-09-21

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
