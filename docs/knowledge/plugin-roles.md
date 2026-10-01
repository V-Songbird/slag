---
type: knowledge
summary: "Which of razor, hush, foreman, collet and anneal owns which job, and where two of them meet; read before choosing plugins or deciding where a new behavior belongs."
related_files:
  - README.md
  - anneal/README.md
  - collet/README.md
  - collet/scripts/mount.mjs
  - collet/templates/checks/scope.mjs
  - collet/skills/task-harness/SKILL.md
  - collet/docs/knowledge/harness-workflow.md
---

# Which plugin owns which job

Five plugins cover different parts of a coding session. Each one owns a single job, and you can use
any of them alone. Together they overlap only where
[two plugins meet](#where-two-plugins-meet). foreman and collet run together in one project:
foreman owns the plan, and collet enforces the session boundary.

anneal and collet live in this repository. razor, hush and foreman are separate plugins, published
in the [foundry](https://github.com/V-Songbird/foundry) marketplace, and are not part of Slag. This
page was checked against each plugin's README and how-it-works guide, in these versions: foreman
3.2.0, razor 1.7.0 and hush 1.12.1. Read each plugin's own README for current install steps and
limits.

## Who owns what

| Plugin | Owns | In one sentence | Lives in |
| --- | --- | --- | --- |
| foreman | What to do and why | Keeps a roadmap beside your code and recommends the next task with its reason and a checked prompt | foundry |
| collet | The boundary of one task | Holds one open task to its writable files and the command that must pass before it closes | Slag |
| anneal | How an agent finds its way | Audits repository navigation, reconciles documentation, and proposes changes from one session | Slag |
| razor | The size of each change | Asks, before code is written, whether the project or the language already has what the task needs | foundry |
| hush | The shape of the final message | Quiets routine narration and shapes the answer around what changed, whether it worked and what comes next | foundry |

## What each plugin does and does not do

### foreman

Foreman records work in `ROADMAP.jsonl` and `.foreman/`, sorts the candidates, and writes a handoff
prompt for the task you choose. Completed work returns to the plan with its evidence, and accepting
that work stays a separate decision.

It guards only its own roadmap file, blocking direct edits to it from the assistant's file-editing
tools, and does not limit which other files a task may write. Passing tests count as evidence, not
acceptance. It is for a solo developer rather than a team tracker.

### collet

collet holds an already planned task to its writable files and its acceptance command. Hooks refuse
recognized out-of-scope writes. Closing a task requires the live checks and the acceptance command to
pass. A handoff is written before compaction, so the open task survives it where the host supports
that (see the [host coverage](../../collet/docs/knowledge/harness-workflow.md#host-coverage) for
what has been observed).

It does not plan work. With no open task it enforces nothing.

### anneal

anneal has three skills. `repo-layout` audits how easily an agent can search and read a repository,
and can plan an approved migration on its own branch. `docs-align` reconciles documentation with
current behavior. `session-review` reads one transcript and proposes changes to the repository's
map file, such as `AGENTS.md`, each one waiting for your approval.

It does not limit a task's scope or decide what to work on next. Its hook stays silent outside a
migration branch.

### razor

razor hands the assistant a short checklist before it writes code and adds targeted checks: an
install guard, an import guard, a manifest guard, a new-file check and a build check. Each check
speaks at most once, and the retry follows the host's normal permissions, because razor never grants
permissions. Once per session, it can also note that a later request has clearly left the task the
session started on; that note never blocks. Its `unused` skill reports declared dependencies that no
source file imports.

It is advisory, not a security boundary, and it never edits your code or manifests. It does not
decide which files a task may touch; it only questions additions.

### hush

hush shapes how the assistant reports. It quiets routine narration, shortens noisy tool output, and
parks the full output of large results in temporary files it refers to. The parked files live in a
per-session temporary folder that hush deletes when the session ends. It never removes a warning,
error or failure line from what the assistant reads. You can choose or craft a voice.

It runs in Claude Code only and is not installable for Codex. A short answer can omit a useful
detail, so ask for depth when you need it.

## Where two plugins meet

| Plugins | How they relate |
| --- | --- |
| foreman and collet | Partners with separate jobs in one project. foreman owns the plan: which work comes next, the files an entry expects to touch, and when the entry is done. collet owns the session boundary: the open task's writable files and the acceptance command that finishes it. collet mounts in a project that has `ROADMAP.jsonl` or `.foreman/`, leaves those files unchanged, and never reads the roadmap. It never enforces an entry's `planned_touches`; the collet task's scope comes from the code. Its scope check never refuses a write to `ROADMAP.jsonl` or `.foreman/`, so foreman keeps its records current while a task is open. |
| collet and anneal | collet constrains one planned task; anneal inspects the repository around it. anneal's `session-review` can propose an instruction change after a session, and collet's `check-writer` skill turns a recurring mistake into a machine check. Use the instruction change for guidance, the check for a mistake a script can catch. |
| razor and collet | Both can push back on an edit, for different reasons. razor questions an addition that may be unnecessary, such as a new package or file. collet refuses a write outside the task's scope. Neither replaces the other. |
| razor and hush | razor questions additions while the code is written and runs its build check at the end of a turn, once per session. hush shortens long tool output during the work and shapes the final message. Their hooks both run in a Claude Code session. Their combined behavior has not been measured here. |
| foreman and hush | foreman produces the handoff prompt and hush shapes how the session that runs it reports. Neither depends on the other. |
| foreman and anneal | foreman decides what to do; anneal reports navigation findings and documentation drift. Neither depends on the other. |

## Choosing

| If you want to | Use |
| --- | --- |
| Keep a plan and pick the next task | foreman |
| Stop a session writing outside one task, and require a passing command to close it | collet |
| Do both in one project | foreman for the plan, collet for each session |
| Make a repository easier for an agent to navigate, or fix stale documentation | anneal |
| Keep a change small and avoid needless packages | razor |
| Read shorter, plainer results | hush |

## What this page does not cover

- How razor, hush and foreman behave when they run in the same session as anneal or collet. collet's
  tests check that `ROADMAP.jsonl` and `.foreman/` stay writable while a task is open, but no Slag
  test installs razor, hush or foreman.
- Install steps for razor, hush and foreman. Follow their own READMEs.
