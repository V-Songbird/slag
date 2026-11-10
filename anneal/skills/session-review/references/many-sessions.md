# Many sessions

Find what this project's sessions do the same way again and again, and propose for each the smallest change that stops the next session paying for it. Two things repeat. A deterministic step, such as the same command, the same chain of commands or the same file looked up, gets a command the project already has, or a short script that needs no model, plus the map-file line that points to it. A navigation candidate that several sessions share, such as the same path looked for in the wrong place or the same check that prints a lot while it passes, gets the change session review would propose for it in one session. **No change is a valid result.**

The rules for the whole run in [the skill](../SKILL.md#rules-for-the-whole-run) hold here too, with these differences:

- This mode reads many sessions, and only through the script below. Past sessions are private. State once which sessions were read: how many, and the range of their dates. Quote no prompt or command beyond the `step` the script prints, and nothing that still shows a credential, an address, the account name or a path on one machine.
- An approved entry can add a short script in the project's own scripts folder beside its map-file line. Nothing else is written.
- Read only the lines each finding's `examples` name. Never read a transcript whole, and never one the script did not list.
- Pass `--also-root` only after the owner names the other repository and agrees. Its prompts are reported to the owner, never written into this repository.

The argument after `all` is optional: a folder is a sessions folder, and a `.jsonl` path is one transcript. With neither, the script finds this project's own sessions.

Copy this checklist into your reply and tick it as you go.

- [ ] 1. Findings collected
- [ ] 2. Each finding verified against its example lines
- [ ] 3. Each finding routed
- [ ] 4. Approved entries applied, diff shown
- [ ] 5. Report written

## 1. Collect the findings

```
node "<plugin root>/scripts/session-repeats.js" --root "<git rev-parse --show-toplevel>"
```

Add `--sessions-dir "<folder>"` for a folder the argument names, and `--session-file "<file>"` for each transcript it names. The script reads transcripts and prints JSON. It writes nothing. It needs Node 22 or later; without Node, say so and stop.

- With no folder or file, it reads the Claude Code sessions of the repository and of each of its worktrees, and the Codex sessions that started in one of them. It skips the running session. On Antigravity, and on any other host, there is no known location: ask the owner for files or a folder.
- `--min-sessions` sets how many sessions a finding must appear in, 3 by default, and `--limit` how many findings each kind keeps, 10 by default.
- When the script exits 2, it found no session to read, or the root is not a Git work tree. Report its message and ask the owner for transcript files or a folder. Never guess a location.
- `skipped` lists each transcript the script did not count, with its reason: `running-session`, or `unreadable` and the error. Report them; the other sessions still count.

Then state the sessions read: the counts in `sessionsRead`, and `dates`, the earliest and the latest typed prompt among them.

## 2. Verify each finding

The script prints five kinds of finding in `findings`, each seen in at least `--min-sessions` sessions:

| Kind | What repeats |
| --- | --- |
| `commands` | one shell command |
| `sequences` | two or three commands one actor ran in a row for one prompt |
| `lookups` | one file read, or one search pattern |
| `prompts` | one prompt the owner typed |
| `navigation` | one navigation candidate of the session evidence: the same path or command, with the same cause and scope |

Each finding has its `step`, the `sessions` it appears in, its `occurrences`, how many of those came from subagent transcripts or forked Codex rollouts (`inSubagents`), and up to three `examples`, each a transcript and a line there, from different sessions. A command, a sequence or a lookup also says whether the map file already names it (`namedInMap`), and a command or a sequence names the root `package.json` script that already runs it (`projectScript`). A prompt finding says how many repositories it came from (`repositories`). A navigation finding carries `navigationKind`, `candidateCause` and `scope`, which read as in [the skill's step 2](../SKILL.md#2-verify-each-candidate), and its example line is the result's line. `navigationCounts` counts every navigation candidate by kind, including the ones whose scope asks for no change, which are never listed.

Read each example line in its transcript. An example's `sessionFile` is relative to the root, or starts with `~` for the home directory: expand a leading `~` to the home directory before reading it. Check that the call did the same job in each session: the same command for the same purpose, not one that only shares its text. A step that only matched after normalization, such as two paths that collapsed to `<temp>/<name>`, is one job only when the lines show it. A navigation finding's cause is a hypothesis: confirm it from the lines before it supports anything.

## 3. Decide where each finding goes

The first row that holds decides.

| Finding | Goes to |
| --- | --- |
| The step needed judgement each time: an edit, a review, a step whose input changed with the task | nothing |
| The map file already names it (`namedInMap: true`) | nothing |
| A project script already runs it (`projectScript` is set) | a line naming that script in the map file's `Commands`, after approval |
| No script runs it | the plain command, or a short script that needs no model, plus its `Commands` line, after approval. The script uses no network and no model, only tools the project already has, and lives in the project's own scripts folder, in the project's language |
| A file or pattern looked up again and again | a path hint in the map file's `Where things live`, or a pointer in `Start here`, per the skeleton, after approval |
| A navigation finding | where [the skill's step 3](../SKILL.md#3-decide-where-each-finding-goes) sends its `scope`: `map-file` to a path hint, `reporter` to the quieter form in `Commands`, `documentation` to repo-docs, `layout` to repo-layout, `source` against the tool that printed the text, `machine` for the owner's global instruction file |
| A prompt the owner typed again and again here that only runs steps | the command or script that runs them, plus its map line, after approval |
| A prompt the owner typed in more than one repository | reported for the owner's global instructions or a personal command, never written |
| A mistake repeated in several sessions that a machine could catch | reported as a check to write: collet's `check-writer` skill when the directory `.collet/` exists at the root, otherwise the project's own linter or tests |
| A step that belongs to CI, a hook or a schedule | reported, never written |

A prompt that only says to go on, or only answers a question, is no step: it is a stall, which the one-session audit reads, and nothing here. Never invoke check-writer or write a check here; a suggestion is a recommendation in the report.

## 4. Approve, then edit in place

Show a short prioritized list, most sessions saved first. Each entry carries its example lines, the exact command or script text, the map file's section and the line as it would be, and what the next session gains. Ask the owner which entries to apply.

Apply only those. Then check the change against the approved entries: every line it adds or removes must belong to one of them. Revert a line that belongs to none and report it. Then show `git diff` for each changed file, and the map file's line count before and after.

A saved map file is not loaded into a session that is already running. Say so.

## 5. Report

- the entries applied, and the map file's line count before and after;
- what was reported and not written: each prompt for the global instructions, each check worth writing, each step for CI, a hook or a schedule, and each navigation finding for another skill or a source;
- what was dismissed, and why;
- `skipped`, and the script's `limits`: matches are text equality after normalization, a step is listed and not judged, a navigation finding's cause is a hypothesis and each transcript gives at most 30 candidates, Antigravity sessions come only from files handed in, redaction is best effort, subagent transcripts and forked Codex rollouts count toward their parent session, and a Claude Code record another transcript copied counts once.
