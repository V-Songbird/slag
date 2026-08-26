---
name: sonnet5
description: >-
  Grades every rule in the project's CLAUDE.md and .claude/rules/, and every
  project skill description in .claude/skills/, exactly as /assay:opus5 does —
  the same files, the same report, the same offer to rewrite what is weak. The
  one difference is that the findings are written for Claude Sonnet 5. Use when the
  user wants their instruction files audited for Sonnet — e.g. "grade my rules for Sonnet", "audit my CLAUDE.md for Sonnet 5", "will Sonnet follow these instructions" — or
  invokes /assay:sonnet5 with any flags. Do NOT use for the AGENTS.md chain, which
  /assay:codex audits, or for a request naming no model or another one, which
  /assay:opus5 and its siblings audit for.
argument-hint: "[--dry-run] [--verbose] [--json] [--top <n>] [--no-verify] [--deterministic] [--semantic] [--project-only]"
allowed-tools: Bash, Read, Write, Edit, Glob, AskUserQuestion, WebFetch, Agent
---

# assay:sonnet5

**Model target: Claude Sonnet 5.**

Follow [../_shared/audit.md](../_shared/audit.md) start to finish. That file is
the whole procedure — the flags, the seven steps, the report and the fix menu —
and this one deliberately repeats none of it.

Carry the target above into your closing sentences, so the reader knows who the
advice was written for.
