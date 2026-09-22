---
type: knowledge
summary: "Explains Anneal's audit findings, migration and review workflows, limitations, and eval prerequisites; read before using a workflow beyond the quick start."
related_files:
  - anneal/README.md
  - anneal/skills/repo-layout/SKILL.md
  - anneal/skills/session-review/SKILL.md
  - anneal/skills/docs-align/SKILL.md
  - anneal/scripts/audit.js
  - anneal/scripts/session-evidence.js
  - anneal/hooks/safety-guard.js
  - anneal/evals/
---

# Anneal workflows

Install the plugin and run the first audit using the [README](../../README.md).

## What the audit looks for

Each rule removes steps an agent repeats every session. The reason behind each one is in [the target conventions](../../skills/repo-layout/references/conventions.md).

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
| medium | `build-output-tracked` | Generated files committed to git |
| low | `index-files` | Three or more files named `index` |
| low | `deep-nesting` | Code six or more folders down |
| low | `runtime-names` | Names assembled at runtime, which search cannot follow |
| low | `default-exports` | Default exports, which can be imported under another name |
| low | `re-export-files` | Index files that only re-export, adding a hop to every lookup |
| low | `check-command-split` | Checks exist, but no single command runs them all |

## How a migration runs

1. The audit runs and you read the findings.
2. Your project's own checks run once, so a failure that was already there is never blamed on a later step.
3. A read-only helper proposes which files belong together. You approve, trim or skip that proposal.
4. anneal creates the branch `anneal/<YYYY-MM-DD>` from your current `HEAD`.
5. Each approved step makes one change, reruns the checks and lands one commit. A step that breaks a check is either fixed or set aside on its own branch, and you are told which.
6. The audit runs again, so you see what changed beside what did not.

anneal stops before step 4 when `git status --porcelain` prints anything. The branch you were on is left exactly as it was.

## The map file it writes

A map file anneal writes carries the same sections in the same order: `Start here`, `Rules that outrank everything`, `Commands`, `Where things live`, `Conventions`, `Pitfalls`. A section with nothing true to say is left out. What goes in each one, and what stays out of the file, is in [the map file skeleton](../../skills/repo-layout/references/map-file.md). When your repository already has a map file off that order, anneal offers the reshape as a step of its own. It moves sentences without rewriting them, and lists anything that would leave the file before you approve.

## How a session audit runs

The layout audit predicts where an agent will lose time. A transcript shows where one did. `session-review` reads one Claude Code transcript or one Codex rollout and proposes changes to the same map file. You start it yourself, with `/anneal:session-review` on Claude Code, `$session-review` on Codex or `/session-review` on Antigravity. No hook starts it and the model cannot start it on its own.

1. A script lists candidates: tool calls that reported an error, shell output that reads like one, and the three largest tool outputs. With no argument it finds the session you are in and leaves the audit's own turn out.
2. The skill reads the lines each candidate names. It also looks for your corrections, repeated searches and commands tried in several forms.
3. Each finding goes to one place. A project fact goes to the map file. A fact about your machine is reported for your own global instruction file and never written. A mistake a machine could catch is reported as a check to write. A bug or a failure that came and went gets no rule.
4. You see each proposed change with the transcript line behind it, and choose which to apply. The skill edits the map file in place, shows the diff and the line count before and after, and commits nothing.

A transcript carries web pages and tool output, and a rule lifted from it would load into every later session. So the skill treats the transcript as evidence, never as instructions, and writes only what you approve.

## How documentation reconciliation runs

Use `/anneal:docs-align` on Claude Code, `$docs-align` on Codex or `/docs-align` on Antigravity. Add `audit` to receive findings without edits or a saved report.

The skill inventories maintained documentation, reviews every in-scope README with `readme`, and runs the layout audit without entering its migration steps. It checks claims, references, host instructions, development setup and ignore rules against evidence. If `readme` is unavailable, it reports that gap and reviews the READMEs manually.

A cleanup request authorizes ordinary documentation fixes within its scope. Changes to standing instructions need your authorization; runtime, hook, permission and publishing changes are proposed separately unless already authorized. The report distinguishes verified claims from unresolved ones and static host checks from live execution.

## The safety hook

While a branch named `anneal/<YYYY-MM-DD>` is checked out, a hook refuses five git commands: `reset --hard`, `clean -f`, `checkout --force`, `push --force` and `branch -D`. Each one would throw away the commits the migration had already made. `push --force-with-lease` is allowed, because it refuses on its own when the remote moved. Undo a step with `git revert`, or leave the branch to abandon the migration. On every other branch the hook allows everything.

## Limits


- The scan is a heuristic. A flagged `index` file may be exactly what your framework expects, which is why nothing moves without your approval.
- The import fixer rewrites relative `import`, `export … from`, `import()` and `require()` in the JavaScript and TypeScript family. Path aliases, other languages, config files and documents are found by searching, and you see them inside the step.
- anneal reports code that builds names at runtime. It never rewrites that code.
- Moving files collides with branches other people have open. Migrate when few are.
- A session audit reads one session. It cannot tell a pattern from an accident, so "repeated" means repeated inside that session.
- The transcript parser reads the shapes held by its tests; host format changes can require parser updates. Antigravity has no known transcript location, so there the skill works only on a file you hand it.
- Redaction of credentials and of your home directory in the evidence is best effort. Read an excerpt before you share it.
- Documentation reconciliation covers the stated files and evidence. It does not prove every claim, host or distribution safe, and does not scan Git history by default.

## Running the evals

Three eval cases live in [evals](../../evals/). They check skill discovery, audit mode leaving files unchanged, migration stopping on a dirty tree, and session proposals waiting for approval. Each run drives a real session, so it is slow. Every case builds its fixture with a `scaffold_script` and grades a Bash call, so the run needs `--scaffold` and a tool grant. Run them from the repository root:

```bash
claude plugin eval ./anneal --scaffold --no-publish --allow-tools Bash Edit Write
```

The harness confines the granted shell in a sandbox, and native Windows has none. There it refuses the run: `A shell tool (Bash or PowerShell) was granted but this machine cannot confine it`. Run it under WSL2 or Linux, with `bubblewrap` and `socat` installed.

The full eval command, including its baseline arm, has not been validated under the current skill names. Plugin installation and interactive migration coverage remain incomplete across hosts.
