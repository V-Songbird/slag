---
name: repo-docs
description: >-
  Writes and reviews pages people read (help pages, guides, how-tos, FAQs,
  troubleshooting, changelogs, contributing guides), so a non-expert
  can find the answer and finish the task; use it whenever you write or
  substantially edit one, even when nobody names writing rules. Also
  reconciles docs, agent instructions and host setup with current behavior,
  proposes drift and trim fixes, adopts a documentation policy, and handles
  one README. Use for a docs cleanup, audit or consistency check, to set
  up where docs go, or for README work not named as such, like "document
  this repo", "add a quick start" or "nobody can work out how to install
  this". Alone or with audit it only reports; fix applies fixes. Not for code layout (repo-layout) or
  session transcripts (session-review).
argument-hint: "[audit|fix|maintain|adopt|readme] [path or concern]"
license: MIT
compatibility: Portable instructions for Claude Code, Codex and Antigravity. The bundled layout audit and README checker require Node 22 or later. Git enables tracked and ignored file checks.
metadata:
  version: "3.0"
---

# Repo docs

Make the maintained documentation agree with what the project actually does, make its development instructions usable by each intended host, and give a project one documentation policy to follow.

Argument: `$ARGUMENTS`. If the host leaves it literal, read the request instead. `audit`, a review request, an explicit no-edit instruction, or the command alone with no argument and no request beside it means report only: nothing is written in the project, and a report is saved only as the reconciliation's step 4 allows. `fix`, or an explicit reconciliation or cleanup request in the owner's words, authorizes ordinary in-scope documentation fixes. Resolve an ambiguous request as an audit, and end an audit by naming `fix` as the way to apply its ordinary fixes. `maintain` runs the maintenance step first and edits nothing until the owner approves a group of its proposals. `adopt` edits nothing until the owner approves the files it shows. `readme`, or a request about one README, works on that README alone. A request to write one page for people authorizes writing that page and works on it alone; a request to review one reports on that page alone. A path narrows the pass to that area plus its incoming references; state that boundary.

On Claude Code invoke `/anneal:repo-docs`; on Codex use `$repo-docs`; on Antigravity use `/repo-docs`. Find the plugin files through `${CLAUDE_PLUGIN_ROOT}` on Claude Code, or resolve `../../` from this file on other hosts. Resolve target paths against the project root, never the installed plugin directory.

On Antigravity, give every command the project root the person named as its working directory, the `Cwd` of `run_command`. Without it, commands can run in Antigravity's own scratch directory instead of the project. When the person named no project root, ask for it before running anything.

## Modes

Every mode reads the Invariants section of [the documentation contract](references/policy.md) first, and treats the project's own applicable instructions as its documentation policy.

| Mode | What to read and run |
| --- | --- |
| none or `audit` (report only), and `fix` or a cleanup request (cleanup) | Read [the reconciliation](references/reconcile.md) and run it |
| `maintain` | Read [the reconciliation](references/reconcile.md) and run its Maintenance step first |
| `adopt` | Read [the documentation contract](references/policy.md) and run its Adopt section |
| A request to write, edit or review a page people read, other than a README, including one never named as documentation work | Read [the writing reference](references/writing.md) and follow it; it skips the inventory and the layout audit |
| `readme`, or a request to write, review, score, improve, edit or translate one README | Read [the README reference](references/readme.md) and follow its mode table; it skips the inventory and the layout audit |

Write each maintained record for the reader the contract's [Document kinds](references/policy.md#document-kinds) table names, in the style that section sets for that reader.

The layout audit's `instructionDrift` lists the bullets that only one host's global instruction file has, found as the audit finds those files or from each `--global <file>` the owner names. Report them as drift between hosts; never decide which copy is right or edit either file.

Read these only when the file above sends you to them: [the README templates](references/readme-templates.md) and [the review rubric](references/readme-review.md) from the README reference, and [the review checklist](references/review-checklist.md) from the reconciliation.
