---
type: knowledge
summary: "Explains Anneal's audit findings, migration and review workflows, interactive Claude Code setup, limitations, eval prerequisites and the paired navigation eval protocol; read before using a workflow beyond the quick start, testing one interactively or running the evals."
related_files:
  - anneal/README.md
  - anneal/skills/repo-layout/SKILL.md
  - anneal/skills/session-review/SKILL.md
  - anneal/skills/docs-align/SKILL.md
  - anneal/scripts/audit.js
  - anneal/scripts/audit-observations.js
  - anneal/scripts/session-evidence.js
  - anneal/scripts/session-evidence-claude.js
  - anneal/scripts/session-evidence-codex.js
  - anneal/scripts/session-evidence-navigation.js
  - anneal/scripts/session-evidence-records.js
  - anneal/scripts/session-evidence-redaction.js
  - anneal/scripts/session-evidence-shell.js
  - anneal/scripts/session-evidence-stall.js
  - anneal/tests/session-evidence.test.js
  - anneal/tests/session-evidence-claude.test.js
  - anneal/tests/session-evidence-codex.test.js
  - anneal/tests/session-evidence-codex-records.test.js
  - anneal/tests/session-evidence-navigation.test.js
  - anneal/tests/session-transcripts.js
  - anneal/hooks/safety-guard.js
  - anneal/evals/
  - anneal/evals/heldout-fixture.js
  - anneal/tests/eval-graders.test.js
  - anneal/tests/navigation-scenarios.test.js
  - anneal/tests/heldout-scenarios.test.js
---

# Anneal workflows

Install the plugin and run the first audit using the [README](../../README.md).

## What the audit looks for

Each rule removes steps an agent repeats every session. The reason behind each one is in [the target conventions](../../skills/repo-layout/references/conventions.md).

An `audit` run shows the findings, offers to save them and writes a findings, report or notes file only after you say yes, even when your own instructions ask to save findings. Otherwise it changes no file, and a run nobody can answer, such as a headless one, writes nothing. It saves no copy of the audit's output outside the project either: it reads the `--json` report from the command or through a pipe.

| Severity | Finding | What it means |
| --- | --- | --- |
| high | `map-file-missing` | No `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`, so every session starts by exploring |
| high | `check-command-missing` | No test or check command found |
| high | `build-output-not-ignored` | Build or dependency folders that git does not ignore, so they fill search results |
| high | `not-a-git-repo` | Search cannot use `.gitignore` to skip generated files |
| medium | `map-file-long` | A map file over 200 lines, loaded into every session |
| medium | `toolchain-version-missing` | No `.nvmrc`, `.python-version` or equivalent |
| medium | `env-template-missing` | Environment files with no `.env.example` naming the variables |
| medium | `duplicate-names` | One file name used more than once, so a search by name is ambiguous |
| medium | `generic-names` | `utils`, `helpers`, `common` and the rest, which say nothing about the contents |
| medium | `large-files` | Code files over 800 lines, expensive to read whole |
| medium | `build-output-tracked` | Generated files committed to git, outside the input folders that `required-inputs` reports |
| low | `index-files` | Three or more files named `index` |
| low | `deep-nesting` | Code six or more folders down |
| low | `runtime-names` | Names assembled at runtime, which search cannot follow |
| low | `default-exports` | Default exports, which can be imported under another name |
| low | `re-export-files` | Index files that only re-export, adding a hop to every lookup |
| low | `check-command-split` | Checks exist, but no single command runs them all |
| low | `instruction-hidden-characters` | Characters that a model reads and a person does not see in a file agents load as instructions |

### Hidden characters in instruction files

`instruction-hidden-characters` reads every `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` at any depth, and the `.md` and `.mdc` files under `.agents/`, `.claude/`, `.cursor/rules/` and `.gemini/`. It reports zero-width characters U+200B to U+200D, the word joiner U+2060, a byte order mark U+FEFF after the first character, bidi controls U+202A to U+202E and U+2066 to U+2069, and Unicode tags U+E0000 to U+E007F. Text in these characters can carry an instruction that an agent follows and a reviewer never sees.

Each evidence entry names the file, the line and each code point. Tags are only counted, because their code points spell out the hidden text. The joiner inside an emoji and the tags of a subdivision flag render on screen, so they are not reported. A zero-width non-joiner in a script that needs it is reported; the owner decides. The finding asks you to inspect the line; repo-layout never removes the characters, decodes them or copies them into a plan.

### Where the audit finds a check command

`check-command-missing` fires when there is code and nothing at the repository root runs a check. These count, and the summary's `checks` line lists them:

- a `package.json` script named `test`, `lint`, `typecheck`, `type-check`, `types`, `check`, `verify`, `validate` or `ci`, alone or with a `:suffix` that is not a `watch`, `fix`, `update` or `debug` variant, and a `Makefile` target or `justfile` recipe whose name starts with one of those words;
- a Node script (`.js`, `.cjs` or `.mjs`) in the root `scripts/` folder with one of those names, such as `scripts/check.js`, run as `node scripts/check.js`;
- the check runner a harness mounts: `node .collet/checks/run.mjs`, or `node .jig/checks/run.mjs` from jig, the retired plugin collet replaced;
- a build tool's own check: `cargo test`, `go test ./...`, `dotnet test`, `./gradlew check` or `gradle check` for a root `build.gradle` or `build.gradle.kts`, `./mvnw verify` or `mvn verify` for a root `pom.xml`, and `tox`, `nox` or `pytest` when a Python project keeps their configuration at the root;
- `node --test` when the root has neither a `package.json` nor a `.gitmodules` and Node's runner finds test files: `*.test.js`, `*-test.js`, `*_test.js`, `test-*.js`, `test.js` or any script under a `test/` folder, with the `.js`, `.cjs` or `.mjs` extension, outside `node_modules` and dot folders. A bare run would also enter submodule checkouts, and it would execute a test-named file kept in a `fixtures` or `__fixtures__` folder, so either one cancels it.

These do not count, and the finding still fires when nothing else does:

- A manifest, Makefile or runner configuration below the root. A package's script runs from its own folder with its own dependencies; the finding asks for one command at the root that runs them.
- Steps that only a CI workflow runs. A workflow depends on its runner's checkout, matrix and secrets, so it is no local entry point; a local check command that CI calls settles it.
- Unity Test Framework tests. They run inside the editor, or in batch mode through the editor's own executable, whose path differs by machine and which cannot open a project the editor already has open.
- A command that only a map file or a README names. The audit reads what the files define, not prose.

### Observations

After the findings, the audit prints observations. An observation has no severity, changes no finding and asks for no change on its own: it says what the audit saw and what that leaves alone. docs-align starts its task routes from them.

| Observation | What it reports |
| --- | --- |
| `map-routes` | Each map file's length, the files it imports, how many repository paths and documents it and its imports name, and whether it names one of the check commands the audit found, which it lists when the map names none of them. A path counts in prose, a table, a tree in a code block or a link. `CLAUDE.md` and `GEMINI.md` load a file they name as `@path`, up to five hops; Codex does not, so in `AGENTS.md` an `@path` is a mention. A map that names nothing is reported whatever its length |
| `package-routes` | Each package, a folder below the root with its own manifest: named by the map or its imports, named in a document the map names, reached only through a named parent folder, or not named. The entry comes from `package.json` (`exports`, `module`, `main`, `bin`) and is marked build output or not found when the file is absent; another manifest is shown by name. Direct routes are listed last and need nothing |
| `document-sections` | Each Markdown document of 20,000 characters or more, other than a map file: its headings, its longest part without one, the section links into it and any that match no heading. It is navigable when every part stays under 20,000 characters. A long `.rst` or `.adoc` document is listed with its structure unknown |
| `package-local-names` | `duplicate-names` groups with one copy in each package |
| `framework-paths` | `deep-nesting` and `index-files` evidence under a Java, Kotlin, Scala or Groovy source root, route files under `app/`, `pages/` or `routes/`, and an `index` file that a `package.json` declares as its entry |
| `source-dist` | Tracked `dist/` folders that no package script, bundler config, `tsconfig.json` `outDir`, Python build file, GoReleaser config or Makefile in their folder or the root builds. They may hold source |
| `required-inputs` | Committed files under `fixtures`, `__fixtures__`, `testdata`, `test-data`, `__snapshots__`, `snapshots`, `golden` or `data` that look generated, listed as `generated-looking` since `build-output-tracked` leaves them out, and `large-files` evidence under those folders |

No observation asks for a list of every folder, a particular heading, a split at some length, an ignore rule, a rename or untracking.

## How a migration runs

1. The audit runs and you read the findings.
2. Your project's own checks run once, so a failure that was already there is never blamed on a later step.
3. A read-only helper proposes which files belong together. You approve, trim or skip that proposal.
4. anneal creates the branch `anneal/<YYYY-MM-DD>` from your current `HEAD`.
5. Each approved step makes one change, reruns the checks and lands one commit. A step that breaks a check is either fixed or set aside on its own branch, and you are told which.
6. The audit runs again, so you see what changed beside what did not.

anneal stops before step 4 when `git status --porcelain` prints anything. The branch you were on is left exactly as it was.

### In an interactive Claude Code session

On Claude Code 2.1.278:

- Auto is the default permission mode, and in it a classifier answers most permission prompts. Start the session with `claude --permission-mode manual` to answer each one yourself.
- Answering No to a permission prompt ends the turn at once, and nothing more runs until you send a message. A denied compound command, such as `git checkout -b … && mkdir -p … && git mv …`, reaches the session without saying which part you refused, so name it in that message.
- The read-only helper of step 3, `anneal:mapper`, runs as a background agent. While it works, the main turn ends with `Waiting for 1 background agent to finish` and the input looks idle. The session goes on by itself when the agent finishes, which took 45 seconds on a nine-file repository.

A complete migration and the Git guard's refusal on its branch have been observed in interactive sessions on Claude Code 2.1.278, with a script rather than a person answering the prompts. On Codex and Antigravity a complete interactive migration remains unverified. The eval case [a migration on a clean tree](#a-migration-on-a-clean-tree) drives one through the eval harness, where the granted tools run without a prompt.

## The map file it writes

A map file anneal writes carries the same sections in the same order: `Start here`, `Rules that outrank everything`, `Commands`, `Where things live`, `Conventions`, `Pitfalls`. A section with nothing true to say is left out. What goes in each one, and what stays out of the file, is in [the map file skeleton](../../skills/repo-layout/references/map-file.md). When your repository already has a map file off that order, anneal offers the reshape as a step of its own. It moves sentences without rewriting them, and lists anything that would leave the file before you approve. Before the step is committed, its diff is read: a line that states an instruction no approved step holds is removed and reported.

## How a session audit runs

The layout audit predicts where an agent will lose time. A transcript shows where one did. `session-review` reads one Claude Code transcript or one Codex rollout and proposes changes to the same map file. You start it yourself, with `/anneal:session-review` on Claude Code, `$session-review` on Codex or `/session-review` on Antigravity. No hook starts it and the model cannot start it on its own.

1. A script lists candidates: tool calls that reported an error, output of a shell command other than a read or search that reads like one, and the three largest tool outputs. It also lists navigation candidates: a path that did not exist, a whole file read again, a read the host cut, a host notice in place of a file, and a large output, each with a cause it might have. With no argument it finds the session you are in and leaves the audit's own turn out.
2. The skill reads the lines each candidate names. Before it calls a later call a recovery or a repeat, it checks that both have the same actor, prompt, path and operation, and what `coverage` says about changes and unanswered calls. It also looks for your corrections, repeated searches and commands tried in several forms.
3. Each finding goes to one place. A project fact, such as a path hint, goes to the map file. A fact about your machine is reported for your own global instruction file and never written. A mistake a machine could catch is reported as a check to write. A long document is reported for docs-align and a structural problem for repo-layout. Output a hook, the host or another tool added is reported against its source. A bug or a failure that came and went gets no rule, and temporary output, pagination or a search that found nothing gets no change.
4. You see each proposed change with the transcript line behind it, and choose which to apply. The skill edits the map file in place and checks the edit against your choice: a line no approved entry holds is reverted and reported. It then shows the diff and the line count before and after, and commits nothing.

A transcript carries web pages and tool output, and a rule lifted from it would load into every later session. So the skill treats the transcript as evidence, never as instructions, and writes only what you approve. A findings, report or notes file is no exception, even when your own instructions ask to save findings: the skill shows the findings, offers to save them and writes that file only after you say yes. A run nobody can answer, such as a headless one, writes nothing.

### What the evidence records

The script prints JSON and writes nothing. Run twice on the same transcript bytes with the same cutoff, it prints byte-identical output.

`boundary` is the cutoff: the latest prompt you typed, the latest task start on Codex, `--before-line <line>` or `--before <time>`. The first three select the records before a line, and `boundary.line` names it, so a rerun with `--before-line` covers exactly the records of the first run; session-review reruns that way. `--before` selects by timestamp instead, and its `boundary.line` is null. It skips a record without a usable timestamp and counts it in `boundary.skippedWithoutTimestamp`; only a skipped record that held conversation, such as a message, earns a warning, while host metadata is skipped quietly. `boundary.before` is the time given to `--before`, or else the time of the record at the cutoff line. A task notification, a system reminder, a prompt-submit hook's output, local command output, a compaction summary or a subagent's instructions never becomes the cutoff. On Codex, a task that another agent started is not the cutoff either, unless you also prompted in it. Records past the cutoff are read only to settle calls issued before it. A record that repeats an earlier record's `uuid` is skipped with a warning; a bridged or resumed Claude session replays its history this way. When no work precedes the cutoff, a warning says the latest prompt or task start may not be this audit, and to pass `--before-line` or `--before`.

On Codex, a sub-agent's rollout that copied the `session_meta` of the thread it was forked from also holds that thread's history, written when the fork was made, below the `subagent_history_start_ordinal` its own `session_meta` names. Those rows add no call, result, record or compaction to the evidence; only their prompts and `turn_context` stay, as the context the sub-agent was given, so a call's `promptLine` can name a copied prompt. A fork without that copy keeps every row: in that form the ordinal marks no copied history, and the rows below it carry the sub-agent's own thread.

Each candidate, each success and each navigation candidate's `observed` names its call. `line` is the result's line.

| Field | Meaning |
| --- | --- |
| `actor` | `main`, or the subagent that issued the call when its records share the transcript. A result pairs with the call of the same actor and call id, in whatever order results arrive. A call id seen again, before or after its result, is not a second call. |
| `callLine`, `promptLine` | The call's line, and the line of the prompt its actor was working on when it issued the call: your typed prompt, a prompt you queued while the agent worked, or a subagent's task. On Codex it is the latest user message that the host did not inject; AGENTS.md instructions and tagged blocks such as `<environment_context>` are injected, but your tagged answer to the agent's question counts. A prompt that arrives later never claims earlier work. `null` means no prompt preceded the call. |
| `phase` | The actor's task phase when it issued the call: `orientation` while it had only read and searched since its prompt, `change` once it edited or wrote a file, and `unknown` after a command, a mixed command or a call to a subagent or an MCP server, or when no prompt preceded the call. The calls of one Claude Code assistant message ran together, so each has the phase of the first. |
| `operation` | `read`, `search`, `edit`, `write`, `command` for a shell command outside the recognized forms, `mixed` for a compound command that does more than read or search, or `other` for any other tool. A compound of reads and searches, with `cd` or `echo` between them, is still a read or search. A shell command that removes, moves, copies or creates files, such as `rm` or `Remove-Item`, is a write. On Codex, `exec_command` and `shell_command` are classified by their command, a code-mode `exec` script by the literal commands it passes to them, and `apply_patch` is an edit. A script that patches files and also runs a command is a write, as a compound command with a writer is, so a path one of its commands does not find is no failed edit. A write is never reported as a created file. |
| `path` | The absolute path that a file tool, or a single read, search or file-changing command, names. It is resolved against the working directory recorded with the call, with forward slashes and an upper-case drive letter. `null` for a compound command, an expansion, a glob, several paths or an unknown directory. |
| `commandOrArguments` | The input as the transcript stores it. Only `path` is normalized, so backslashes and escapes in commands, patterns and edits appear unchanged. |

A later success is a call issued after the failure's result, by the same actor with the same tool; on Codex, by any tool. A call that ran beside the failure never counts. On Claude Code that includes a call from the failure's own assistant message: the host writes each call of a message as a record of its own, often after another call's result. Successful output of a read or search is content, so error text it quotes is not a candidate; that includes a compound of reads. A reminder the host appends to a tool result is not counted as output. On Codex, the exit code comes from an `Exit code: N` or `Process exited with code N` line in the result's header, before its `Output:` line, or else from a JSON `exit_code`. The same line further down is output that a read quotes. Any value there that is not an integer counts as no exit code and no failure.

On Claude Code, a refused call is a candidate of category `user-declined` when you declined it, `permission-refused` when a permission rule or the permission mode refused it (`Permission to use … has been denied.`, `was blocked by a deny rule.` or `is denied by your permission settings`), or `blocked` when a policy or a hook blocked it. Such a candidate carries `retriesAfterRefusal`: up to two later calls, by the same actor for the same prompt and not from the refused call's own assistant message, that reached the same path by the same operation, or, when the refused call was a shell command with no path, a shell command that runs the same program with the same first argument that is no flag, whatever flags, wrapping or line breaks come between. Quoted text counts as one word, so a pattern or a message names no program. A program that only prints, reads or filters text, such as `echo`, `cat`, `grep` or `sed`, a shell keyword, a variable assignment and an interpreter given inline code, as in `node -e`, name no job, since two commands that share one say nothing about sharing a job. `git --no-pager reset \` then `--hard` on the next line retries `git reset --hard`, and `cat` of a path retries a refused Read of it. A call of another tool retries only with the same input. The list says only what came next: read each call to judge whether it worked around the refusal. Codex candidates carry no such list.

On Codex, a result without an exit code takes its outcome from what the host wrapped around it. Codex runs a code-mode script in a cell and throws a tool's failure into it, so the script ends as `Script failed`: a patch that does not apply, a hook's block, a command that cannot start and a `shell_command` that exits nonzero all end it. `exec_command` and `write_stdin` return a nonzero exit instead, and a script may leave it unprinted.

| Result | Outcome |
| --- | --- |
| `Script completed`, from a script whose code calls neither `exec_command`, `write_stdin` nor a tool a server provides (`server__tool`, such as `mcp__docs__search`), reaches its tools only as `tools.name(...)`, not through a key in brackets such as `globalThis["tools"]`, and has no `catch`, `allSettled`, `Promise.any` or `Promise.race`. Its comments and string literals, such as a patch's text, are not code, so a tool, a `catch` or a `${` inside them does not count. A quote left unpaired, such as the backtick of a template with a substitution or the quote in the regex literal `/'/`, makes the whole script count as code. | `ok`: any failure would have ended the script. |
| `Script completed`, from any other script | `unknown`: a command's nonzero exit, a server tool's failure or a caught failure leaves the script complete. |
| `Script running with cell ID N` | `pending`: the script runs on. A later `wait` call on that cell returns what it prints next and how it ends, and that result is read like one from the script's own call, with that call's operation. |
| `Script failed`, or a result that starts with `Command blocked by … hook`, `aborted by user` or `collab … failed` | `failed`: `tool-script-failure`, `blocked`, `interrupted` or `tool-error`. |
| An empty result, `Script terminated`, or another tool's text, such as that of `send_message`, `wait_agent` or `sleep` | `unknown`: nothing in it tells a success from a failure. |

An `unknown` or `pending` result is never a success, and its output is still read for failure text. That includes what a running script printed so far, since the host does not print it again when the script ends. A `Script running` or `Script terminated` result stays `pending` or `unknown` even when it prints a finished command's exit code: an exit of 0 there is no success, while a nonzero one is still a failure. A `Script completed` result that prints fewer exit codes than its script makes `exec_command` and `write_stdin` calls is `unknown` as well, even when every exit it printed is 0, since a command whose exit it left out may have failed; a printed nonzero exit still fails it. The calls are counted in the script's code, and the exit codes a running script printed count with those of the result that completes it. The output of an `ok` script that ran no shell command is content, as a successful read's is; one that ran `shell_command` reads like a command that exited 0.

Codex also writes a record of its own for each command and each server tool call, beside the call's result: an `item_completed` event whose item is a `CommandExecution`, with its exit code, or an `McpToolCall`, with whether it reported an error.

- A record belongs to a call when it names that call, as the record of a `js` call does, or when that call was the only one open, no other cell was running to have started the command, and the run began at or after it, which is how a command inside a code-mode script is matched. A run began at the record's own `started_at_ms` where that differs by more than 1 ms, clock rounding, from the record's time less its duration, which can fall up to a minute later, and at that difference otherwise. A record that arrives while two calls are open belongs to neither and leaves both in doubt, and one that began before the open call belongs to an earlier run.
- A record that arrives while no call is open belongs to the only cell still running, when the run began at or after that cell's script was called and the script spells out what ran: a command it passes to `exec_command` as a literal, or the server tool it calls. A command it passes to `shell_command` does not count, since that tool leaves no record. Otherwise it belongs to nobody, as does one that arrives while two or more cells are running.
- Each record also names the thread that ran it, and one that names another thread than the rollout's own, the id of its first `session_meta`, is another agent's and decides nothing. That id is the report's `sessionId` and the one the rollout's file name carries: a sub-agent's rollout copies the `session_meta` of the thread it was forked from after its own. For a record that names no thread, the rollout's marks of other agents' work stand in: a `SubAgentActivity` item for a sub-agent thread that started or was spoken to and has not yet completed or been interrupted, and a `CollabAgentToolCall` item once the session has handed work to agents of its own. While either stands, such a record decides nothing unless the script spells out what it ran.
- Where records belong to a finished result beyond doubt, they settle it: a record that failed makes the result `failed`, with a candidate whose `evidenceBasis` is `host-record`, its `exitCode`, the `recordedCommand` the record names, a command or a server and tool, and the output the record kept, both redacted and cut like any excerpt; records that cover every `exec_command` and server tool call in the script's code, all of them clean, make an `unknown` result `ok`. A script that can drop a failure through `catch`, `allSettled`, `Promise.any` or `Promise.race` is never made `ok` that way when it also calls a tool that leaves no record, such as `apply_patch`, `view_image`, `write_stdin` or `shell_command`. A record never turns a failure into a success: a candidate that only the text found stays a candidate.
- That candidate gains a `hostRecord` note stating what the records show, such as `For this call the host recorded 1 command that exited 0.` A rollout without records reads as it did before, but for the `limits` text and the new `recordedOutcomes` count.

A tool output's size, in `largestToolTexts` and in navigation candidates, is its length. Claude Code saves a large result to a file and keeps only a 2 KB `<persisted-output>` preview in the transcript; such an output counts at the size the host states, in bytes, and `persisted` is `true`.

`coverage` counts the calls issued, those `answered` inside the interval, those `answeredAfterCutoff`, and those `unanswered` anywhere in the snapshot, whose last call lines are in `unansweredCallLines`. On Codex, `pending` counts the scripts still running at the end of the interval, `outcomeUnknown` the answered calls whose outcome is `unknown`, and `recordedOutcomes` the results a record settled; the first two are 0 on Claude Code, which has no `recordedOutcomes` at all. It also counts results that name no call, call ids seen again, and calls per operation. `readOnly` is `true` when every file tool and shell command only read or searched, and `false` once an edit or write was issued. It is `null` when no call was made, when a `command` or `mixed` call leaves the effect unknown, or when a call went to a subagent or an MCP server. Calls to other tools are counted but do not decide it.

`navigationCandidates` pair what the transcript shows with a cause it might have. Each holds `kind`, `observed`, `candidateCause`, `scope`, `intervention` and `verification`. `observed` holds facts only: the call's fields, the result's `line` and `timestamp`, and what the result showed. `candidateCause` is a hypothesis to confirm from those lines. `scope` names who would act if it holds, `intervention` the smallest change, and `verification` how to check it. `navigationCounts` counts each kind over the whole interval.

| Kind | Observed when | Candidate cause, then scope |
| --- | --- | --- |
| `missing-path` | A read, search or edit failed, and its result says the path does not exist: `File`, `Path` or `Directory does not exist`, `No such file or directory`, `Cannot find path`, `cannot find the file specified` or `ENOENT`. A success that quotes such text, a search that found nothing, a guard block and an interrupt are none. | `temporary-output`, `transient`, for a path in a `tmp` or `temp` directory outside the working directory. `not-yet-created`, `none`, when the actor then wrote that path. `wrong-location`, `map-file`, when a later successful call reached a file of the same name inside the working directory recorded with the call; `outside-project`, `machine`, when it reached one outside. Otherwise `unknown`, `none`. |
| `truncated-read` | The actor saw only part of a read. Claude Code's Read refused the file at its token or size limit (`exceeds maximum allowed tokens` or `size`), or a `read_truncation_notice` record after the Read's result says the host showed part of it; `noticeLine` is that record's line. A shell read's result is a `<persisted-output>` preview. Codex marked the output `…N tokens truncated…`. | `paged`, `none`, when the actor then read the same file by range, searched it, or read the output the host saved. `long-document`, `documentation`, for a `.md`, `.mdx`, `.markdown`, `.rst` or `.adoc` file. Otherwise `long-file`, `none`. |
| `repeated-read` | The same actor read a whole file inside the working directory again for the same prompt, with no edit or write of that path and no compaction between. A read by range is pagination, and a cut read is no whole read. An image or a PDF, a file outside the working directory, and a second read from the same assistant message never count. | `possible-change`, `none`, when a command, a mixed command, a delegated call or a change of unknown path came between; `unknownEffectsBetween` counts them. `long-document`, `documentation`, for a document of 20,000 characters or more. Otherwise `re-read`, `none`. |
| `host-notice` | Claude Code answered a Read with `Wasted call — file unchanged since your last Read` instead of the file. It counts as neither a content read nor a repeat. | `re-read`, `none`. `earlierLine` is the actor's last content read of that path. |
| `large-output` | A search, command, mixed command or other tool printed 20,000 characters or more, or the host appended that much text to any result. A read prints its file, so its size alone is no candidate, and an `ExitPlanMode` result is the agent's own plan. | `appended-text`, `source`, for appended text. `failure-output`, `none`, when the call failed. A `TaskOutput` result is the output of the background command whose start result names its task id, and `startedBy` is that call's line: it routes like that command, or is `background-output`, `none`, with no such call in the interval. `broad-search`, `layout`, for a search. `tool-output`, `source`, for another tool. `verbose-command`, `reporter`, when a project tool ran: a build, test or package tool such as `npm`, `cargo`, `go`, `make`, `dotnet` or `gradle`, or a script run by a relative path, such as `./gradlew` or `.\scripts\check.ps1`. A language tool such as `node` or `python` counts when its script lies in the session's working directory, or when it runs the project's tests (`node --test`) or a project tool as a module (`python -m pytest`). One running a script from elsewhere, such as a plugin's or one behind `$CLAUDE_PLUGIN_ROOT`, is `outside-script`, `source`; one running inline code, standard input or a script in a temporary directory counts as no tool. An assignment before a command, such as `CI=1` or `$out =`, is skipped; an assignment alone, a word holding a quote, an array or subexpression such as `@(...)`, and a relative path to a source file count as no program, and here-document bodies, PowerShell here-strings and block comments are data, not commands. Otherwise `command-output`, `none`: a read pipeline, a formatter, version control or a command a script computes has no project reporter. |

Scopes: `map-file` is a change session-review proposes for the map file. `documentation` goes to docs-align, and `layout` to repo-layout. `reporter` is the command's quieter form in the map file's `Commands`, or repo-layout's check step for the check script itself. `source` is reported against the tool, host, hook, output style or plugin that produced the text, and `machine` for your own global instruction file. `transient` and `none` mean no change.

A missing path and a cut read also carry `observed.next`: up to four calls the same actor made for the same prompt after the result, or after the notice of a cut Read, whatever their operation, mixed commands included. Each has an `outcome` of `ok`, `failed`, on Codex `unknown` or `pending` as above, or `null` when no result arrived in the interval. A call that ran beside the result never joins: one issued before it, or on Claude Code one from the same assistant message. Neither does another actor's call or a call for a later prompt. A later write of the path, a file found elsewhere and a read of the rest count only when a successful call among them made it.

`stallCandidates` are turns that stopped for a word the session did not need. The main session's turn ended on its own text, and your next typed prompt only says to go on, in English or Spanish, such as `continue`, `go ahead` or `sí, sigue`. The text's last paragraph offers to go on, asks a question, or names what is left: a list after a lead such as `Next steps:` or `Pendientes:`, or a closing `Next:` line. None arises from a prompt that adds anything, a bare `yes`, a prompt with an image, one queued while the session worked, a turn whose latest result failed or that ended on a call, or an ending that asks for a commit, a push, a merge, a deployment, a publication, a release, a pull request, a tag or spending, which you authorize on their own. Each holds `kind` `stall` and an `observed` with the text's `line` and `timestamp`, the `promptLine` that started the turn, the `ending` (`offer`, `question` or `next-steps`), an `endingExcerpt` of at most 240 characters, the `nextPromptLine`, `nextPromptTimestamp` and `nextPrompt`, and the `projectCommands` the ending names in code spans. `candidateCause`, `scope`, `intervention` and `verification` read as above. The scope is `machine`, a line for your own global instruction file, unless the ending names a project command, which makes it `map-file`. `stallCounts` counts each ending over the whole interval. The ending and the prompt are matched by their words alone, so whether the stop was needed is for the reviewer: an instruction, an approval or a permission can require one.

The output does not grow with the transcript. It holds at most `--limit` candidates (6 by default, 30 at most) with two later successes each, `--limit` navigation candidates with four later calls each, the last `--limit` stall candidates, `--limit` unanswered call lines, three largest outputs and 20 subagent transcripts. When more navigation candidates arise, one that has settled on scope `none` or `transient` leaves first, so it never pushes out one that may call for a change. A candidate has settled when later calls can no longer change its cause: it follows no later calls, it is a cut read of a file that is no document or one the actor already read on, the actor went on to create the missing file, the missing path is temporary, or its later calls are all answered and no more can come, because four are in or because its actor has moved on to a later prompt. An excerpt keeps at most 480 characters and says when it was cut.

Limits of the evidence:

- `sessionFile` and `subagentTranscripts[].file` are copied without redaction, so they can show your home directory and account name. `context.cwd` has only its home prefix shortened to `~` and keeps the account name; session-review expands the `~` again to compare it with the repository root.
- `path` is redacted like the other fields and cut at 480 characters, so two paths longer than that can look alike. It can also differ from `context.cwd`, which keeps the transcript's spelling apart from the `~`.
- Home redaction finds the home directory on path boundaries and, for a Windows home, in any case and in its MSYS `/c/Users/…`, WSL `/mnt/c/Users/…` and escaped JSON spellings. After it, the account name, the home directory's last segment and the OS user name when that differs, becomes `<user>` where it is a whole path segment after a slash or backslash, as in `D:/Projects/<user>/` or `../../Users/<user>`, part of a Claude project key such as `C--Users-<user>-shop` or `-home-<user>-shop`, part of a lowercase folder name built from a path such as `demo-app-c-users-<user>-codex` or `-mnt-d-projects-<user>-shop`, or the owner or group column of an `ls -l` line. In such a folder name a WSL mount (`mnt-d-`), a drive with two hyphens (`d--`), `home-` or `users-` comes before the name, and every part between them has two or more characters. It stays as a word in prose or code, inside a longer name such as `<name>2`, `<name>.old`, `V-<name>` or `v-<name>` in a folder name, and, on a POSIX home, in another case. Without a home directory, or with a root home, nothing is masked as either. Any other path segment that equals the account name is masked too, even when it names something else.
- After `Basic` or `Bearer`, a word shorter than twenty letters stays, even when it is a credential written as a word. File names, paths, dates and numbers stay too.
- Values named `password`, `secret` or `token` are redacted. Comparisons, type annotations and environment-variable references are left alone, but other code assigned to those names is still redacted.
- After redaction, every redacted field writes each character that `instruction-hidden-characters` reports as its code point, such as `<U+200B>`, and a run of Unicode tags as `<N Unicode tag characters>`. The joiner inside an emoji and the tags of a subdivision flag stay as they are. `sessionFile`, the session and model names and `context.cwd` are not redacted, so they keep such characters.
- Shell recognition is small. A pipeline through a program it does not know, such as `wc` or `sort`, is mixed, and so is anything with command substitution or a redirect into a file. On Codex, a command a script computes instead of writing it as a literal is a `command` of unknown effect. A project tool is known only by its program's name or a relative script path, so a script PowerShell runs through `&` with a quoted path, one a shell runs as an argument, as in `bash check.sh`, and a tool a wrapper such as a version manager runs as an argument count as no project tool. A script in the working directory counts as the project's even when the session wrote it there itself.
- Navigation candidates read the host records and texts that the table above names, as current Claude Code and Codex transcripts write them. A host that words them otherwise yields no candidate. Claude Code's marks count only in their own record or at the start of a result, so a file that quotes one is content; a Codex read of a file that holds `…N tokens truncated…` is taken for a cut read.
- A candidate cause rests on names, paths and order alone. A later file with the same name can be another file, and the working directory recorded with a call is the only project boundary the script knows. A whole read is a Read without a range, `cat`, or `Get-Content` without a count.
- On Codex, a read inside a script of several commands names no single path, so reading the rest after a cut read cannot be seen, and the cut read reports `long-file`, `none`.
- On Codex, the outcome of a result without an exit code rests on the wrappers above and on which tools throw their failures, as current rollouts show them. A script is read by pattern, not parsed. A call it builds at run time through `tools`, `globalThis` or `Reflect` makes it `unknown`. A call built through another name for the global object, such as `self`, or code a regex literal hides can still read as `ok`, and so can a failure dropped in another way than `catch`, `allSettled`, `Promise.any` or `Promise.race`, such as `.then(onOk, onErr)`, a tool call without `await` or a `finally` that ends in `continue`. Neither `.then(onOk, onErr)` nor a tool call without `await` occurs in the local Codex rollouts measured. A command call in a loop counts once, so a loop that prints the exit of one pass reads as printing them all, and records that cover that one call count as covering the loop.
- On Codex, a host record that no call bounds, or one that names no thread while another agent is at work, is matched to a script only by a command or server tool the script spells out. A script that computes its commands takes no such record, and another agent's run of a command the script also spells out, recorded without a thread, is taken for the script's.
- A plugin or hook that rewrites a tool's output, for example to cut or collapse lines, leaves its marker in text that the evidence cannot tell from the tool's own output. Such markers are not classified.

## How documentation reconciliation runs

Use `/anneal:docs-align` on Claude Code, `$docs-align` on Codex or `/docs-align` on Antigravity. Add `audit` to receive findings without edits. The audit offers to save its findings and writes that report in the project only after you say yes, even when your own instructions ask to save findings. A run nobody can answer, such as a headless one, writes nothing in the project. Outside the project, the audit writes only its coverage checklist, and only in a scratch directory the host names for the session; without one it writes no file anywhere and reads command output from the command or through a pipe.

The skill inventories maintained documentation, reviews every in-scope README with `readme`, and runs the layout audit without entering its migration steps. It checks claims, references, host instructions, development setup and ignore rules against evidence, and proposes routes that take each anticipated task to the one document holding its contract and to the check that proves it, starting from the audit's observations. If `readme` is unavailable, it reports that gap and reviews the READMEs manually.

A cleanup request authorizes ordinary documentation fixes within its scope. Changes to standing instructions need your authorization; runtime, hook, permission and publishing changes are proposed separately unless already authorized. The report distinguishes verified claims from unresolved ones and static host checks from live execution.

## The safety hook

While a branch named `anneal/<YYYY-MM-DD>` or one of its set-aside branches is checked out, a hook refuses the git commands that would throw away the commits the migration had already made, or the working tree they were checked against:

- `reset --hard`, `clean -f` or `--force`, `checkout --force`, `switch --discard-changes` or `--force`;
- `push --force` or a `+` refspec, `branch -D` or a delete with `--force`.

It also refuses the commands that rewrite those commits: `commit --amend`, `rebase` other than `--abort` and `--quit`, `update-ref -d` and `reflog expire` or `delete`.

It reads the subcommand past git's global flags, such as `--no-pager` or `-C <path>`, and reads a command split with a line continuation as one line. `push --force-with-lease` is allowed, because it refuses on its own when the remote moved. Undo a step with `git revert`, or leave the branch to abandon the migration. On every other branch the hook allows everything.

The hook matches command text, so it cannot see every rewrite, such as git run through a variable. Its denial says that the same command in another form would discard or rewrite the same work.

## Limits

- The scan is a heuristic. A flagged `index` file may be exactly what your framework expects, which is why nothing moves without your approval.
- Observations match the paths a map names, not what its sentences mean: a package mentioned without its path, as in "the pricing package", counts as not named. Headings are read in Markdown only, and a section link is checked against GitHub's heading anchors and explicit `id` or `name` anchors.
- The import fixer rewrites relative `import`, `export … from`, `import()` and `require()` in the JavaScript and TypeScript family. Path aliases, other languages, config files and documents are found by searching, and you see them inside the step.
- anneal reports code that builds names at runtime. It never rewrites that code.
- Moving files collides with branches other people have open. Migrate when few are.
- A session audit reads one session. It cannot tell a pattern from an accident, so "repeated" means repeated inside that session.
- The transcript parser reads the shapes held by its tests; host format changes can require parser updates. Antigravity has no known transcript location, so there the skill works only on a file you hand it.
- Redaction of credentials, your home directory and your account name in the evidence is best effort. Read an excerpt before you share it.
- Documentation reconciliation covers the stated files and evidence. It does not prove every claim, host or distribution safe, and does not scan Git history by default.

## Running the evals

Twenty-one eval cases live in [evals](../../evals/). Three check skill discovery, audit mode leaving files unchanged, migration stopping on a dirty tree, and session proposals waiting for approval; [two](#a-migration-on-a-clean-tree) apply an approved migration step on a clean tree, one of them into a new directory, [one](#a-plan-from-a-wrong-survey-row) shows a plan from a layout survey row whose importer count is wrong, [one](#an-unreadable-transcript) gives session review a transcript its evidence script refuses, [two](#reader-only-map-checks) ask a reader what the map alone answers, the six navigation cases have their own [paired protocol](#paired-navigation-runs), and six [held-out cases](#held-out-checks) repeat it on a second repository. Each run drives a real session, so it is slow. The three build their fixtures with a `scaffold_script` and grade Bash calls, so a run needs `--scaffold` and a tool grant. Run them from the repository root, and write the results outside it:

```bash
claude plugin eval ./anneal --tag smoke --tag safety --scaffold --no-publish \
  --allow-tools Bash Edit Write --output-dir <results>
```

`--tag smoke --tag safety` selects the three. Without it the clean-tree migrations, the plan from a wrong survey row, the unreadable transcript, the reader-only map checks, the navigation cases and the held-out cases run too, the last two in both arms, which their protocol does not use. Without `--output-dir` the harness writes `aggregate-result.json` and the HTML report under `anneal/evals/results/`, which git does not ignore. Each run's trace stays in its temporary directory as `out/trace.jsonl`. `--keep-temp` keeps that directory; in 2.1.278 it also seals the run's home and workspace under `sealed/` at mode 000 and asks that no git command run in the kept copy.

With `--scaffold`, the harness runs each case's `scaffold_script` with bash from that case's folder in the target, as you and outside the sandbox, in the run's new workspace and with the `PATH` the harness started with. A script can therefore reach other files of the target through its own path: each navigation scaffold runs `../navigation-fixture.js`, which reads its contract from `navigation-partner-api.md` beside it, so a copy of `anneal/` used as the target has to keep both files in `evals/`. In the same way, `migration-moves-into-new-directory` and `plan-flags-a-wrong-importer-count` run the fixture script of `migration-applies-approved-step`. A scaffold that fails ends its run before the session starts, at no cost, and the run's error quotes the end of the script's error output. The harness keeps a failed run's temporary directory even without `--keep-temp`, unless `--json` is passed.

The harness confines the granted shell in a sandbox, and native Windows has none. There it refuses the run: `A shell tool (Bash or PowerShell) was granted but this machine cannot confine it`. Run it under WSL2 or Linux, with `bubblewrap` and `socat` installed. With no terminal, add `--trust-plugin`, or the harness refuses an untrusted plugin directory. Inside the sandbox:

- The workspace holds 13 untracked entries the harness and its sandbox put there: `.bash_profile`, `.bashrc`, `.claude/`, `.eval-artifacts`, `.gitconfig`, `.gitmodules`, `.idea`, `.mcp.json`, `.profile`, `.ripgreprc`, `.vscode`, `.zprofile` and `.zshrc`. `git status` lists them and the audit counts them as files, so a skill that stops on any `git status` output, as a migration does, never sees a clean tree there. A case that needs one has to exclude them in its fixture, as `migration-applies-approved-step` does in `.git/info/exclude`, and its list has to follow the harness. Every run also leaves an empty `.git/config.worktree` the fixture did not create.
- The shell cannot read the `.bashrc` placeholder, so every command prints `Permission denied` for it and nothing a startup file adds to `PATH` applies. `node` was not found through fnm's alias directory either, although it was on `PATH`: in the WSL2 run measured below, the first `node` call of every session with the plugin failed with `command not found`, and each session went on through the versioned binary, a turn or two later. Putting the versioned directory itself on `PATH` before starting the harness, for fnm `~/.local/share/fnm/node-versions/<version>/installation/bin`, gives the runs the path that worked.
- `npm`, `npx` and `corepack` are links into fnm's `../lib/node_modules`, and the sandbox hides the home directory and opens again only the directories on `PATH`. With only the `bin` directory on `PATH` they fail with `command not found`. Put fnm's `installation` directory itself on `PATH` as well, `~/.local/share/fnm/node-versions/<version>/installation`, and the sandbox opens `lib/` too, so `npm` works. The request `npm` makes to its registry is denied and changes nothing: the tests still run.

No harness option loads a workspace's map at session start: in 2.1.278 every eval session starts with `--setting-sources user`, so a fixture's `CLAUDE.md` and `AGENTS.md` do not load. The navigation cases therefore ask for the map in the first line of their prompt.

By default each case runs three times with the plugin and three times without it, 18 sessions for the three. One recorded run, on Claude Code 2.1.278 with its default model `claude-opus-5`, took about 13 minutes at a list-price estimate near $5. Under the current graders it scores:

| Case | With the plugin | Without |
| --- | --- | --- |
| `audit-reports-without-changes` | 1.00 | 0.93 |
| `migration-stops-on-uncommitted-work` | 1.00 | 0.83 |
| `session-audit-proposes-without-writing` | 1.00 | 0.75 |

Read the comparison with these limits:

- `skill-fired`, `audit-ran` and `evidence-ran` depend on the plugin. In a two-arm run the harness reports them as indicators and leaves them out of the score. Each passed in every run with the plugin. The session case's difference comes from `evidence-found-the-failure`, which passed in all three runs with the plugin and in none without.
- The graders on the final reply passed 17 of 18 times without the plugin. `stops-on-uncommitted` passed on a run without the plugin that renamed two files before it stopped; `no-branch-commit-or-move` and `no-new-refs-or-files` caught the renames.
- Three runs per arm is a small sample.

[eval-graders.test.js](../../tests/eval-graders.test.js) checks these graders against that run's commands, created paths and evidence, against real git changes to the migration fixture, against the evidence script's output for the session transcript, and against edited copies of the session case's map file:

- `evidence-found-the-failure` is scored and passes only when the trace holds the evidence script's report of `npm test` failing and `npm run check` working afterwards, which a run without the plugin cannot produce.
- `no-branch-commit-or-move` catches a `git mv` or a plain `mv`, a `git stash` other than `list` or `show`, a commit, including `git -c … commit`, and a new branch, including `git switch --create`. It reads the commands of Bash calls, so a change made another way, such as inside a script, passes it.
- `no-new-refs-or-files` fails when the workspace gains a branch, tag, stash, git object or file, whatever made it, and `uncommitted-change-kept` when the uncommitted line in `src/utils.js` is stashed, discarded or moved. Neither sees an edit to another file.
- `map-file-left-alone` fails on any change to `AGENTS.md`, since the session case approves none. In the audit and session cases, `no-files-created` fails when a run creates any file outside `.git/` and `.claude/`, such as a findings or notes file; it sees created paths, not edits, so the audit case checks less than its prompt forbids. It cannot see outside the workspace either, so the audit case's `audit-output-not-saved` reads the Bash commands instead: it fails when the audit's output goes to a file, through a redirect other than to `/dev/null` or through `tee`, wherever that file lands. A copy saved another way, such as inside a script, passes it.
- A grader's frontmatter ends at the first `---` in its file, even inside a quoted pattern, so a pattern that matches a Markdown table rule spells it `-{3}`. [eval-harness.js](../../tests/eval-harness.js), which both eval tests use to read and grade the cases, splits frontmatter the same way.

Plugin installation and interactive migration coverage remain incomplete across hosts.

### A migration on a clean tree

`migration-applies-approved-step` drives the whole migration: its prompt runs `/anneal:repo-layout` and approves one step, renaming the generic `src/utils.js` to `src/money.js`. Its fixture commits a small ES-module project whose only finding is that name, and lists the 13 entries above in `.git/info/exclude`, so `git status` is clean when the session starts and the migration's own dirty-tree rule lets it go on. Its graders require:

- the move: `src/money.js` holding the old content, the index tracking it instead of `src/utils.js`, a new branch `anneal/<YYYY-MM-DD>`, and a last commit whose subject starts `anneal:`;
- both imports of the old file rewritten, with nothing else in those files changed;
- `AGENTS.md`, `package.json` and the test byte-identical, and no file created besides `src/money.js`;
- a passing check after the move: in the trace, a test summary with no failures after the `mv`, and no failing one later;
- no Bash call that sends a check's output into a file or through `tee`: `checks-run-without-a-file` fails `npm test > /tmp/x.out` and `npm test 2>&1 | tee …`, also from inside a `{ … }` group, and passes the skill's own baseline forms, `2>&1`, `/dev/null` and a redirect of any other command.

[eval-graders.test.js](../../tests/eval-graders.test.js) replays the scaffold without bash and applies the approved step the way the skill does, which passes every grader. A copy instead of a move, an unapproved name, a move without its imports, a step left uncommitted or committed on the current branch, an extra step, an edited map file, manifest or test, a check that fails or never runs after the move, and check output saved to a file each fail the grader meant for it. Without the plugin a run has no reason to name the branch and the commit the migration's way, so `migration-branch-created` and `step-committed` measure its procedure.

`skill-fired`, an indicator that runs only with the plugin, looks for the read of the skill's `references/conventions.md`, which the skill requires before it plans. The prompt's slash command expands the skill without a Skill tool call, so a grader on that call never passes here. Against the paired run's two traces of this case, the indicator passes with the plugin and fails without it.

Run the case on its own, in both arms:

```bash
claude plugin eval ./anneal --case migration-applies-approved-step --scaffold --no-publish \
  --allow-tools Bash Edit Write --output-dir <results>
```

That is 6 sessions, three with the plugin and three without, each capped at 40 turns and 900 seconds. One run of the case in each arm, on Claude Code 2.1.278 with `claude-opus-5[1m]`, cost $0.58 with the plugin (20 turns, 66 seconds) and $0.27 without (17 turns, 22 seconds), as the harness estimates list price.

`migration-moves-into-new-directory` scaffolds the same repository and approves one move, `src/utils.js` to `src/lib/money.js`, into a directory the repository does not have yet. Its graders are the ones above, for the new path, plus `branch-directory-and-move-alone`. That grader fails a Bash call that joins the branch, the new directory or the move to another command with `&&`, `||`, `;` or a line break, which the skill forbids, and passes each of them run alone. [eval-graders.test.js](../../tests/eval-graders.test.js) replays the step as the skill applies it, which passes every grader, and chained forms of it, which fail only that grader. The case has not run in a session yet. To run it, pass `--case migration-moves-into-new-directory` to the command above.

### A plan from a wrong survey row

`plan-flags-a-wrong-importer-count` scaffolds the repository of `migration-applies-approved-step`, where `src/cart.js` and `src/orders/summary.js` import `src/utils.js`. Its prompt runs `/anneal:repo-layout` for the plan only and hands over a finished layout survey in the mapper's reply format. The survey's one row renames `src/utils.js` to `src/money.js` and claims 1 importer. The case allows Read, Glob, Grep, Skill and Bash, 30 turns and 600 seconds. Its graders on the final reply require, in English or Spanish:

- `stale-row-flagged`: `src/utils.js` within 300 characters of a word that marks the row, such as flagged, mismatch, stale, wrong or does not match;
- `search-result-shown`: what the search found, as two importers or both `cart.js` and `summary.js`;
- `stale-row-not-planned`: no numbered, bulleted or table line that plans `src/utils.js` to `src/money.js` unless the same line flags it or names what the search found.

`no-new-refs-or-files` fails when the workspace gains a branch, tag, stash, git object or file, and `skill-fired` is the indicator described above. [eval-graders.test.js](../../tests/eval-graders.test.js) checks that the fixture has two importers where the row claims one, and runs the reply graders against plans that flag the row in a list, a table or Spanish, which pass, and plans that keep the row as proposed, correct it without a flag or drop it, which fail. A plan-only run passes the workspace grader, and a run that renames the file fails it. The case has not run in a session yet. To run it, pass `--case plan-flags-a-wrong-importer-count` to the command above.

### An unreadable transcript

`session-audit-stops-on-unreadable-transcript` scaffolds the repository and transcript of `session-audit-proposes-without-writing`, then cuts the transcript's fourth record to its first 60 characters. The evidence script refuses the whole file and exits 1 with `Invalid JSON record at line 4`, while the records around the cut still show `npm test` failing and `npm run check` working to anyone who opens the file. Its prompt is the session case's own, and its graders require:

- `names-the-unreadable-transcript`: a reply that says the transcript could not be read, such as `line 4`, invalid JSON, malformed or could not parse;
- `no-finding-from-the-raw-file`: no `npm run check` anywhere in the reply, since that command is only in the records the script refused.

`evidence-ran`, `map-file-left-alone` and `no-files-created` are the session case's own. [eval-graders.test.js](../../tests/eval-graders.test.js) replays the scaffold without bash, checks the script's refusal and the readable records around the cut, and runs the reply graders against replies that report the refusal, which pass, and a reply that reads the file itself and proposes the working command, which fails. One recorded run, on Claude Code 2.1.278 in WSL2 on 2026-09-23, three runs per arm, scored 1.00 with the plugin and 0.75 without, at a list-price estimate of $1.53. Every run named the refusal. With the plugin, each run stopped after the script's message; without it, each run read `session.jsonl` itself, noted the cut record and still proposed `npm run check`, which `no-finding-from-the-raw-file` failed. Its tag is `tool-failure`, so the command above leaves it out; pass `--tag tool-failure` instead to run it.

### Reader-only map checks

`map-reader-original` and `map-reader-oriented` measure a map without a session that works in the code. Each scaffold writes the navigation repository with one of its two maps, then removes and commits away everything but the notes: `AGENTS.md`, `CLAUDE.md` and the files the map names by path, `.nvmrc` in both and `docs/partner-api.md` in the oriented one. The session may only Read, Glob and Grep, for 15 turns and 300 seconds, and answers four questions in four lines: the package that computes member discounts and tax, the command for one test file, the file and section that hold an endpoint's page size, and the Node version, or `not in the notes` where the notes do not say.

| Grader | Oriented map | Original map |
| --- | --- | --- |
| A1 | `packages/price-engine` | `not in the notes` at the start of the line |
| A2 | `node --test` | the same |
| A3 | `partner-api.md` and section 8 or Endpoint reference, in either order | `not in the notes` at the start of the line |
| A4 | 22 | the same |

`four-answer-lines` requires exactly four answer lines, and `no-files-created` is the audit case's. The original map supports two answers; an answer it does not support fails, so the pair measures both what a map tells a reader and whether the reader invents the rest. [eval-graders.test.js](../../tests/eval-graders.test.js) replays both scaffolds, checks that only the notes stay and that each map holds the answers its graders expect, and runs supported, guessed and incomplete replies through the graders. The removed files stay in the repository's history, compressed, where Read, Glob and Grep cannot read them. One recorded run, on Claude Code 2.1.278 in WSL2 on 2026-09-23, with no baseline arm and three runs per case, scored 1.00 on both, at a list-price estimate of $1.16 for the oriented case and $0.38 for the original. Every oriented reader quoted the two `Start here` lines, and every original reader answered `not in the notes` for the package and the section. Their tag is `map-reader`; pass `--tag map-reader` to the command above.

### Paired navigation runs

Six more cases, tagged `navigation`, test whether orientation in the map file helps an agent finish a task correctly. Their scaffold scripts run [navigation-fixture.js](../../evals/navigation-fixture.js), which writes and commits a small monorepo: a storefront, a v1 API, four packages and a long partner API contract. Its output depends only on the snapshot named by the case's last word, so the commit of this repository fixes both snapshots:

- `original` has a map file with commands and a top-level table of paths.
- `oriented` adds one `Start here` section with two pointers: the package that holds member discounts and tax, and the contract entry that holds an endpoint's batch or page size. Each line names only what its destination holds and names no decoy.

Code, tests, contract, prompts and graders are identical in both. Every prompt starts with the same line, "Before anything else, read `AGENTS.md`.", because no harness option loads the map at session start. Every case allows 30 turns, 600 seconds and the tools Read, Glob, Grep, Bash, Edit and Write.

| Scenario | Task | The graders require |
| --- | --- | --- |
| `navigation-package-lookup` | Name the function that computes the storefront checkout's loyalty discount; three packages have one | One `ANSWER:` line naming `packages/price-engine/src/member-discounts.js` and `memberDiscount`, which the checkout imports and its tests exercise |
| `navigation-contract-section` | Make the shipment page sizes in a named file match the contract | Default 20 and maximum 100 in `limits.js`, from the shipments entry past line 2,000 rather than the general rule of 50 and 200 near the top, with the other limits unchanged |
| `navigation-explicit-path` | Add Norway to the nordic zone in a named file | `NO` in the nordic zone of `shipping.js`, with every other zone and rate unchanged. The task needs no orientation, so its oriented runs show what the extra lines cost |

[navigation-scenarios.test.js](../../tests/navigation-scenarios.test.js) runs every grader against known-good, wrong and partial solutions without a session, checks that the verdicts on changed code agree with the code's behaviour, checks that the snapshots differ only in the map file, and pins both `Start here` lines to the package's exports and the contract's endpoint section. `npm run check` runs it.

The two arms are the snapshots, not the plugin: no case allows a Skill call, and the runs use `--ablation none`. The command for the other three cases leaves these out by tag. The comparison takes twelve runs, three scenarios by two snapshots by two fresh sessions:

1. Before the first run, record the commit of this repository, with no local changes under `anneal/evals/`, the output of `claude --version`, the model id and the host: WSL2 or Linux with the sandbox packages above. Keep all four for the twelve runs.
2. Start each run with its own command, and write its results outside the repository. `--keep-temp` keeps the run's directory, to check a failed grader against the files:

   ```bash
   claude plugin eval ./anneal --case navigation-package-lookup-original --runs 1 --ablation none \
     --scaffold --no-publish --allow-tools Bash Edit Write --model <model-id> --keep-temp \
     --output-dir <results>/01
   ```

3. Runs 1 to 6 are `package-lookup` original, then oriented; `contract-section` oriented, then original; `explicit-path` original, then oriented. Runs 7 to 12 are the same six in reverse order, so each snapshot goes first once per scenario.
4. Keep every run. A failed grader, a harness error or a timeout is a result, not a reason to run again. A run is correct when every grader of its case passes.
5. From each result and trace, record the turns, `duration_seconds` and `cost_usd`; the read and search calls and the characters they returned; and the wrong-path attempts. Those are a read, search or edit under `packages/pricing/`, `packages/quotes/` or `apps/api-v1/` in the package lookup, a page size other than 20 or 100 written in the contract task, and a read or edit of a file other than `AGENTS.md`, `shipping.js` and its test in the control. Mark what a trace does not show as unavailable. Fewer reads or an earlier edit are not success on their own.
6. Record whether each session's first tool call read `AGENTS.md`, as its prompt asks, and whether that read returned the `Start here` lines in each oriented session. That read is the only way the lines reach a session: the fixture's `CLAUDE.md` imports `AGENTS.md`, but eval sessions load neither file.

Two runs per arm cannot tell a small effect from noise, so report counts rather than rates.

One paired run with these lines is recorded, on Claude Code 2.1.278 under WSL2 with `claude-opus-5[1m]`. All twelve runs were correct, so the arms did not differ in correctness. All twelve sessions read `AGENTS.md` first, and all six oriented sessions received the `Start here` lines.

- Package lookup: the original runs opened three decoy files before answering: two in one run and one in the other. One oriented run opened `packages/pricing/src/loyalty.js` after it had found the answer; the other opened no decoy file.
- Contract task: both original runs read the whole contract before paging to the shipments entry. The oriented runs listed its headings and read ranges. Over the two runs that was about 31,000 contract characters against 123,000, at a list-price estimate of $0.68 against $1.10, although they took 58 seconds against 45.
- Control: the extra lines cost 244 characters in the map read. Neither oriented run touched a `Start here` target, and they used 8 tool calls against 11.

The contract's example requests carry the placeholder key `<api-key>`.

### Held-out checks

Six more cases, tagged `heldout`, repeat the two route lines on a second repository. [heldout-fixture.js](../../evals/heldout-fixture.js) writes a booking platform whose layout, domain, map format and contract differ from the navigation fixture: services, libraries, integrations and a 3,000-line carrier contract, with a map that lists paths in a tree. `oriented` adds the same kind of `Start here` section. One line routes returning-customer discounts to `lib/fare-rules/`, and the other routes an endpoint's batch or page size to that endpoint's entry in the contract. Each line names only what its destination holds and names no decoy, so the control task has no reason to follow either.

| Scenario | Task | The graders require |
| --- | --- | --- |
| `heldout-package-lookup` | Name the function that computes a returning customer's discount in the booking service; three libraries have one | One `ANSWER:` line naming `lib/fare-rules/src/returning-customer.js` and `returningCustomerDiscount` |
| `heldout-contract-section` | Make the manifest batch sizes in a named file match the contract | Default 25 and maximum 60 in `limits.js`, from the manifests entry past line 2,000 rather than the general rule of 100 and 500 near the top, with the other limits unchanged |
| `heldout-explicit-path` | Add Portugal to the EU fee region in a named file | `PT` in the EU region of `fees.js`, with every other region and fee unchanged |

The cases share the navigation protocol: the same first prompt line, `--ablation none`, twelve runs in the same order, and the same measures. [heldout-scenarios.test.js](../../tests/heldout-scenarios.test.js) grades known-good, wrong and partial solutions without a session. It also checks the code's behaviour, that the two repositories share no top-level folder, and that each `Start here` line names only what its destination exports or states.

One held-out run with these lines is recorded, on Claude Code 2.1.278 under WSL2 with `claude-opus-5[1m]`. All twelve runs were correct, and all six oriented sessions received the `Start here` lines.

- Package lookup: one original run opened two decoy files, in `lib/fares-v1/` and `services/legacy-gateway/`, before answering; the other found the right library through a search. Neither oriented run opened a decoy file.
- Contract task: both original runs read the whole contract. Over the two runs, the oriented ones read about 17,000 contract characters against 123,000, with no whole-contract read, at a list-price estimate of $0.57 against $1.18, and took about as long: 45 seconds in each arm.
- Control: the extra lines cost 238 characters in the map read. Both oriented runs went straight to `fees.js`, with 8 tool calls against 10.
