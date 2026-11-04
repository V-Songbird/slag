---
name: repo-docs
description: >-
  Keeps a project's documentation in line with its code: reconciles the
  maintained docs and non-code development files with current behavior and
  the project's documentation policy, proposes drift and trim maintenance,
  and adopts the documentation contract into a project. Use for a complete
  documentation cleanup, repository housekeeping or consistency audit across
  Claude Code, Codex and Antigravity, or to set up where docs go. Pass audit
  to report without edits, maintain for drift and trim proposals that wait
  for approval, or adopt to write the project-local rule, map pointer and
  ignore rules after approval. Formerly docs-align. For a single README use
  readme; for code layout use repo-layout; for a session transcript use
  session-review.
argument-hint: "[audit|maintain|adopt] [path or concern]"
license: MIT
compatibility: Portable instructions for Claude Code, Codex and Antigravity. The bundled layout audit requires Node 22 or later. Git enables tracked and ignored file checks. Uses the readme skill when available and reports missing dependencies.
metadata:
  version: "2.0"
---

# Repo docs

Make the maintained documentation agree with what the project actually does, make its development instructions usable by each intended host, and give a project one documentation policy to follow.

Argument: `$ARGUMENTS`. If the host leaves it literal, read the request instead. `audit`, a review request or an explicit no-edit instruction means report only: nothing is written in the project, and a report is saved only as the reconciliation's step 4 allows. Otherwise an explicit reconciliation or cleanup request authorizes ordinary in-scope documentation fixes. Resolve an ambiguous request as an audit. `maintain` runs the maintenance step first and edits nothing until the owner approves a group of its proposals. `adopt` edits nothing until the owner approves the files it shows. A path narrows the pass to that area plus its incoming references; state that boundary.

On Claude Code invoke `/anneal:repo-docs`; on Codex use `$repo-docs`; on Antigravity use `/repo-docs`. Find the plugin files through `${CLAUDE_PLUGIN_ROOT}` on Claude Code, or resolve `../../` from this file on other hosts. Resolve target paths against the project root, never the installed plugin directory.

On Antigravity, give every command the project root the person named as its working directory, the `Cwd` of `run_command`. Without it, commands can run in Antigravity's own scratch directory instead of the project. When the person named no project root, ask for it before running anything.

## Modes

Every mode reads the Invariants section of [the documentation contract](references/policy.md) first, and treats the project's own applicable instructions as its documentation policy.

| Mode | What to read and run |
| --- | --- |
| default (cleanup) and `audit` | Read [the reconciliation](references/reconcile.md) and run it |
| `maintain` | Read [the reconciliation](references/reconcile.md) and run its Maintenance step first |
| `adopt` | Read [the documentation contract](references/policy.md) and run its Adopt section |
