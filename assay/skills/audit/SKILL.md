---
name: audit
description: >-
  Grades every rule in the project's CLAUDE.md and .claude/rules/ for structural
  clarity — verb strength, framing, trigger distance, loading scope, position in
  the file, concreteness — and detects rules that would work better as hooks,
  skills, or subagents. Also grades each project skill's frontmatter description
  in .claude/skills/ against the trigger recipe. Most of the scoring is a
  deterministic Node script; the model judges only two factors.
  Offers to rewrite weak rules and to park placement candidates for promotion.
  English-only scoring. Do NOT use to review code, PRs, or non-Claude config
  like eslint.
when_to_use: >-
  Trigger when the user wants feedback on existing rule files: "are my rules any
  good", "check my CLAUDE.md", "grade my instruction files", "which rules are
  weak or vague", "audit my rules", "which rules should be hooks", or invokes
  /assay:audit with any flags.
argument-hint: "[--fix] [--verbose] [--json]"
allowed-tools: Bash, Read, Write, Edit, Glob, AskUserQuestion, WebFetch
---

# assay:audit

The script measures everything mechanical; you judge two factors and present the
result. Never re-derive by hand what the script already computed. Flags in
`$ARGUMENTS`: `--fix` (apply rewrites without the menu), `--verbose` (full factor
table), `--json` (machine-readable report).

## 1. Scan

From the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" scan
```

If `node` is not on PATH (fnm/nvm setups), register it the way the project's
CLAUDE.md says to, then rerun. The output JSON has a `judge` list — every rule
needing your judgment — and writes full data to `.assay-tmp/scan.json`. The
scan also grades every `.claude/skills/*/SKILL.md` frontmatter description
against the trigger recipe; those need no judgment.

If `ruleCount` and `skillCount` are both 0, tell the user nothing was found and
stop. If only `ruleCount` is 0, write `{}` to `.assay-tmp/judgments.json`, skip
step 2, and continue.

## 2. Judge F3 and F8

Read [references/rubrics.md](references/rubrics.md), then score every rule in
the `judge` list on both factors:

- **F3 — trigger-action distance**: will Claude recognize the moment this rule
  fires? 0.95 immediate → 0.05 no trigger at all.
- **F8 — enforceability ceiling**: could a hook or linter enforce this better
  than prose? 0.90 judgment-only → 0.15 fully mechanical.

Score all rules in one continuous pass — do not interleave other tool calls, or
your scale drifts between batches. Where a rule has `needsF1: true`, add an `F1`
value too (verb strength per the rubric note).

Write the result with the `Write` tool to `.assay-tmp/judgments.json`:

```json
{ "R001": { "F3": 0.75, "F8": 0.9 }, "R002": { "F3": 0.45, "F8": 0.15, "F1": 0.7 } }
```

## 3. Report

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" report
```

Add `--verbose` or `--json` if the user asked. The command prints the finished
markdown report — corpus grade, per-file grades, weak rules with suggested
fixes, stall risks, buried rules, stale references, hook opportunities,
placement candidates, weak skill descriptions. Present it as-is, then add at
most 3 sentences of your
own: the single most valuable fix and anything project-specific the numbers
can't see. If the project visibly runs subagents or headless automation, one
of those sentences should say the grades apply at full severity there; if it
clearly does neither, say severity reads one notch softer. If it errors about
judgments, fix `.assay-tmp/judgments.json` and rerun.

## 4. Offer fixes

Skip this step entirely (go to 5) when the report has no weak rules and no
placement candidates. If `--fix` was passed, skip the question and apply
rewrites only. Weak skill descriptions are never menu items — the report
already names `/assay:craft <skill>` as their fix.

Otherwise ask ONE question with `AskUserQuestion` (`multiSelect: true`,
header `"Fix menu"`), including only options that have evidence:

- `Rewrite [N] weak rules` — only if weak rules exist. Description: "Rewrite the
  rules below their quality floor in place; you review via git diff."
- `Promote [N] candidates now` — only if placement candidates exist. Description:
  "Build each hook, skill, or subagent at project scope, straight from the
  live official docs."
- `Park [N] placement candidates` — only if placement candidates exist.
  Description: "Move them out of the rule files into .claude/assay-promotions.md
  with instructions to promote each into its hook/skill/subagent."

Apply what was checked, per [references/fixes.md](references/fixes.md). If both
promote and park are checked, promotion wins and parking covers the remainder.
Match rules by exact text, never by line number. After applying, remind the
user to review with `git diff`. Do not loop, re-audit, or offer follow-up
menus — one pass, then done. If the user wants to measure the improvement they
can run `/assay:audit` again.

## 5. Clean up

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" clean
```

Always run this last, whether or not fixes were applied.
