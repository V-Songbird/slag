---
type: knowledge
summary: "Which of razor, hush, foreman, collet and anneal owns which job, and where two of them meet; read before choosing plugins or deciding where a new behavior belongs."
related_files:
  - README.md
  - anneal/README.md
  - collet/README.md
  - collet/scripts/mount.mjs
  - collet/docs/knowledge/harness-workflow.md
---

# Which plugin owns which job

Five plugins cover different parts of a coding session. Each one owns a single job, so you can use
any of them alone or together without two plugins doing the same work.

anneal and collet live in this repository. razor, hush and foreman are separate plugins, published
in the [foundry](https://github.com/V-Songbird/foundry) marketplace, and are not part of Slag. This
page describes them from the README files of the versions it was checked against: foreman 3.2.0,
razor 1.7.0 and hush 1.12.1. Read each plugin's own README for current install steps and limits.

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

Foreman records work in `ROADMAP.jsonl` and `.foreman/`, ranks the candidates, and writes a handoff
prompt for the task you choose. Completed work returns to the plan with its evidence, and accepting
that work stays a separate decision.

It does not restrict which files a session may write, and it does not run an acceptance command for
you. It is for a solo developer rather than a team tracker.

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
speaks at most once, and the retry goes through. It also has an `unused` skill that reports declared
dependencies that no source file imports.

It is advisory, not a security boundary, and it never edits your code or manifests. It does not
decide which files a task may touch; it only questions additions.

### hush

hush shapes how the assistant reports. It quiets routine narration, shortens noisy tool output, and
keeps the full output of large results available by reference. You can choose or craft a voice.

It runs in Claude Code only and is not installable for Codex. It does not change what the assistant
does, only how much you read.

## Where two plugins meet

| Plugins | How they relate |
| --- | --- |
| foreman and collet | Alternatives in one project, not partners. collet's mount refuses a project that has `.foreman/` or a recognized planning record in `ROADMAP.jsonl` and writes nothing, so one project has one owner of its plan. Choose that owner first. A collet project never enforces a rule against `ROADMAP.jsonl` or `.foreman/`, because its scope check treats both as owned elsewhere. |
| collet and anneal | collet constrains one planned task; anneal inspects the repository around it. anneal's `session-review` can propose an instruction change after a session, and collet's `check-writer` skill turns a recurring mistake into a machine check. Use the instruction change for guidance, the check for a mistake a script can catch. |
| razor and collet | Both can push back on an edit, for different reasons. razor questions an addition that may be unnecessary, such as a new package or file. collet refuses a write outside the task's scope. Neither replaces the other. |
| razor and hush | razor acts before the code exists and hush acts on the message afterwards. Their hooks both run in a Claude Code session. Their combined behavior has not been measured here. |
| foreman and hush | foreman produces the handoff prompt and hush shapes how the session that runs it reports. Neither depends on the other. |
| foreman and anneal | foreman decides what to do; anneal reports navigation findings and documentation drift. Neither depends on the other. |

## Choosing

| If you want to | Use |
| --- | --- |
| Keep a plan and pick the next task | foreman |
| Stop a session writing outside one task, and require a passing command to close it | collet |
| Make a repository easier for an agent to navigate, or fix stale documentation | anneal |
| Keep a change small and avoid needless packages | razor |
| Read shorter, plainer results | hush |

## What this page does not cover

- How razor, hush and foreman behave when they run in the same session as anneal or collet. Slag has
  no test that installs them together.
- Install steps for razor, hush and foreman. Follow their own READMEs.
