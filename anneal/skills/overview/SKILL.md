---
name: overview
description: Shows what anneal finds in this repository and which of its skills to run next, from one read-only script with no model. Use when the user asks what anneal does or can do here, where to start with it, which anneal skill fits a job, or for a quick health summary of navigation, documentation and past sessions. Reports only; it never edits. Not for the audits themselves (repo-layout, repo-docs) or for session transcripts (session-review).
argument-hint: "[no-sessions]"
license: MIT
compatibility: Requires Node 22 or later. Git enables the documentation and session lines. Finds past sessions on Claude Code and Codex only.
metadata:
  version: "1.0"
---

# Overview

Tell the owner, in one screen, what each part of anneal finds in this repository and which skill to run next. This skill reports and stops. It changes no file, runs no other skill and proposes no fix of its own.

Argument: `$ARGUMENTS`. A host that does not fill that in leaves it as written; read the argument from the request instead. With `no-sessions`, add `--no-sessions` to the command, so no past session is read.

Find the plugin's own files through `${CLAUDE_PLUGIN_ROOT}` on Claude Code, or resolve `../../` from this file on other hosts. On Antigravity, give the command the project root the person named as its working directory, the `Cwd` of `run_command`; when they named none, ask for it first.

## 1. Run the script

```
node "<plugin root>/scripts/overview.js" --root "<repository root>"
```

The repository root is `git rev-parse --show-toplevel`, or the working directory outside Git. The script runs anneal's audit, documentation check, maintenance script and repeated-step search as they are and prints what each counted. It writes nothing and uses no model. It needs Node 22 or later; without Node, say so and stop. It can take half a minute on a project with many past sessions.

## 2. Show its lines

Show the script's output as it is: one part per line, with what its script found and the skill to run next. Then add only this:

- the command for each `next` on this host: `/anneal:<name>` on Claude Code, `$<name>` on Codex, `/<name>` on Antigravity, with the argument the line gives;
- for a part that says `not available`, its reason in the script's words;
- that the counts are heuristic findings, proposals and candidates, and that none is verified until its own skill reads the evidence.

| Part | Its skill | What that skill does |
| --- | --- | --- |
| Navigation | `repo-layout` | audits what makes an agent search, read or guess more than it needs to, and migrates with approval at each step |
| Documentation | `repo-docs` | reconciles documentation and agent instructions with current behavior, trims what is stale, and writes or reviews one page or README |
| Past sessions | `session-review all` | finds what many sessions repeat and proposes a script or a map-file line for it |
| This session | `session-review` | finds where one session lost time and proposes map-file changes; `session-review closeout` checks whether a finished session is safe to delete |

`session-review` starts only when the owner types it: a transcript is private, so no skill starts it for them. Name its command and stop.

Do not interpret a count beyond the script's words, rank the parts, or start the next skill. The owner chooses.
