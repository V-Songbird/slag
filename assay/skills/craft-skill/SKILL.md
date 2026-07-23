---
name: craft-skill
description: >-
  Builds a new Claude Code skill — SKILL.md format fetched live from the
  official docs, description written to the measured trigger recipe: concrete
  base sentence, quoted trigger phrases, an exclusion clause — and, for
  must-run skills, a companion rule or hook on top. Also refits existing skill
  descriptions that never seem to fire. Use when the user wants a skill created
  or made to trigger reliably — e.g. "make me a skill", "create a skill for X",
  "my skill never fires", "Claude keeps ignoring my skill", "fix this skill
  description", "craft a skill" — or invokes /assay:craft-skill. Do NOT use for
  auditing CLAUDE.md rules — that is /assay:audit.
argument-hint: "[skill name or what it should do]"
allowed-tools: Read, Write, Edit, Glob, AskUserQuestion, WebFetch
---

# assay:craft-skill

You build one skill per run — new, or a refit of an existing one. The
description is the product: follow
[references/recipe.md](references/recipe.md) exactly; it encodes what
measurably makes a skill fire. `$ARGUMENTS`, if present, names the skill or
describes what it should do.

## 1. Scope

Decide new-vs-refit: if the user pointed at an existing
`.claude/skills/*/SKILL.md` (or one matches their words — check with `Glob`),
it's a refit. Otherwise it's new.

Collect, from the conversation or one `AskUserQuestion` round at most:

- What the skill does — enough to write the concrete base sentence.
- Three or four ways the user would actually phrase the ask, in their words.
- The nearest adjacent ask the skill should NOT fire on.
- Whether the skill is bound to a file type or path (candidates for a scoped
  companion rule).
- How critical firing is: nice-to-have, should-always-run, or
  must-never-be-skipped.

Don't ask for what the user already said; only fill real gaps.

## 2. Ground the format

Fetch `https://code.claude.com/docs/en/skills.md` with `WebFetch` and follow
the fetched format exactly — frontmatter keys, directory layout, naming. Never
build from a remembered format. If the fetch fails, stop and tell the user to
retry later; a stale-format skill is worse than no skill.

## 3. Build

**New skill** — create `.claude/skills/<name>/SKILL.md`:

- `description` per the recipe's three parts. Read the finished description
  once against the recipe's refit checklist before writing it.
- Body: the skill's actual instructions from step 1, structured per the
  fetched docs. Keep it as short as the task allows.

**Refit** — edit only the frontmatter description (and `when_to_use` if the
format uses it) per the recipe's refit checklist. Never touch the body's
instructions beyond what the user asked.

## 4. Climb the ladder if asked

Only when step 1 said should-always-run or must-never-be-skipped:

- **should-always-run** — add the companion rule from the recipe: scoped
  `.claude/rules/<name>-rule.md` with `paths:` frontmatter when file-bound
  (verify the glob hits at least one real file with `Glob` first), top of
  `CLAUDE.md` otherwise.
- **must-never-be-skipped** — say plainly that only a hook guarantees
  execution, and offer to build it per the live hooks docs
  (`https://code.claude.com/docs/en/hooks.md`). Build it only if accepted.

## 5. Close

Verify every artifact you wrote exists, then report in a few lines: what was
built, where, and — for a new skill — that it loads from the next session.
Remind the user to review with `git diff`. One pass, then done; no follow-up
menus.
