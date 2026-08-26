---
name: opus5
description: >-
  Grades every rule in the project's CLAUDE.md and .claude/rules/ on how it is
  written, scoped and placed, and flags the ones a hook or a skill would enforce
  better than prose. Also grades each project skill's frontmatter description in
  .claude/skills/ against the trigger recipe, and offers to rewrite what it
  finds. Findings are written for Claude Opus 5. English-only scoring. Use when
  the user wants feedback on existing rule files — e.g. "are my rules any good",
  "check my CLAUDE.md", "grade my instruction files", "which rules are weak or
  vague", "audit my rules", "which rules should be hooks", "Claude keeps
  ignoring my instructions" — or invokes /assay:opus5 with any flags. Do NOT use
  to review code, PRs, non-Claude config like eslint, the AGENTS.md chain, which
  /assay:codex audits, or any request naming another model, which /assay:sonnet5,
  /assay:haiku45 and /assay:fable5 audit these same files for.
argument-hint: "[--dry-run] [--verbose] [--json] [--top <n>] [--no-verify] [--deterministic] [--semantic] [--project-only]"
allowed-tools: Bash, Read, Write, Edit, Glob, AskUserQuestion, WebFetch, Agent
---

# assay:opus5

**Model target: Claude Opus 5.**

Follow [../_shared/audit.md](../_shared/audit.md) start to finish. That file is
the whole procedure — the flags, the seven steps, the report and the fix menu —
and this one deliberately repeats none of it.

Carry the target above into your closing sentences, so the reader knows who the
advice was written for.
