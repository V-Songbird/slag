---
name: audit
description: Measures a project's real Claude Code context bill — session-start tokens read from actual transcripts, always-loaded file inventory (CLAUDE.md chain, rules, skill listings, memory), broken skill frontmatter, oversized state files, and search-exposed vendored trees — then produces a prioritized fix list with estimated per-session savings. Measurement is fully mechanical (a Node script); no tokens are spent counting.
when_to_use: Trigger when the user asks why sessions are expensive, wants a token or context audit, says "audit my tokens", "context bill", "what is loaded every session", "token efficiency check", or invokes /gauge:audit.
argument-hint: "[--json]"
allowed-tools: Bash, PowerShell, Read
---

# gauge:audit

Runs the mechanical measurement pass, then turns its output into a prioritized report.
The script measures; you interpret and recommend. Never spend tokens re-measuring what
the script already counted.

## 1. Run the measurement

From the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/audit.js"
```

Pass `--json` too if you need the raw numbers for anything beyond the report.
If `node` is not on PATH (e.g. fnm/nvm setups), register it first the way the
project's CLAUDE.md says to, then run the script.

## 2. Interpret — the paging hierarchy

Every finding maps to one rule: **put each fact at the deepest level that still gets it
loaded when needed.** Standing cost drops ~100× per level down:

1. `CLAUDE.md` / unscoped `.claude/rules/` — every session, in full. Only standing
   behavioral directives and the build/test commands belong here.
2. Skill description + `when_to_use` — every session. A trigger contract, nothing more.
3. Skill body — on trigger. Methodology, commands, patterns.
4. Skill `references/` — on demand. Bulk schemas and catalogues.
5. Plain repo docs — only when explicitly read. History, motivation, depth.

Standard fixes, by finding:

| Finding | Fix |
| --- | --- |
| 🔴 Broken skill frontmatter | Remove the BOM / repair the YAML — the skill cannot self-trigger until fixed. This is a correctness bug, not a size bug; fix it first. |
| 🟠 Unscoped rule > 5k chars | If it only matters for certain files: add `paths:` globs to its frontmatter (stays automatic, drops to zero until matched). If it's reference material: convert to a skill with a tight description. If it's genuinely a standing directive: compress the prose — one line of motivation, keep tables and directives. |
| 🟠 Large root state file | Archive completed entries to a sibling `*.archive.*` file; keep the live file to the active tail. |
| 🟠 Vendored trees | Scope searches by path, prefer index-aware tools (IDE MCP search) that respect project excludes, or add a PreToolUse hook rejecting unscoped Grep/Glob. Do NOT use `.rgignore` if intentional searches into those trees are ever needed — the Grep tool cannot override ignore files. |
| Oversized CLAUDE.md | Directives and commands stay; documentation moves down the hierarchy. `@imports` do NOT save tokens — they expand at launch. |
| Many MCP servers / plugins | Verify schemas stay deferred with `/context`; prune `enabledPlugins` the project never uses. |

## 3. Report

Deliver: the measured session-start median (if transcripts existed), the always-loaded
total, then findings ordered by estimated tokens saved per session, each with its
concrete fix and the arithmetic (`chars / 4 ≈ tokens`). Keep it short — the numbers are
the report.

## 4. Offer, don't apply

End by offering to apply specific fixes. Apply only what the user approves, one finding
at a time. Never edit CLAUDE.md, rules, or skills unprompted — the audit is read-only.
