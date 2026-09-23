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
