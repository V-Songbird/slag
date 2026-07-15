# Changelog

All notable changes to jetbrains-router are documented here. jetbrains-router
is a monorepo-folder plugin — its version is owned by
`.claude-plugin/marketplace.json` at the repo root, not by
`jetbrains-router/.claude-plugin/plugin.json` (which carries no version field
by convention).

## 2.0.3-alpha — 2026-07-13

Doc-only: removed a redundant "Under the hood" section that repeated earlier parts of the README. No behavior change.

## 2.0.2-alpha — 2026-07-13

Doc-only: the README logo now adapts to dark mode (white silhouette instead of black). No behavior change.

## 2.0.1-alpha — 2026-07-08

Doc-only: plugin.json's description now matches the marketplace listing text. No behavior change.

## 2.0.0-alpha — 2026-07-05

Revival release. The plugin returns to the monorepo, rewritten from bash to Node.js and updated for the current IntelliJ Platform MCP server (2025.2+).

### Changed

- **Hooks ported from bash to Node.js.** No longer requires `jq` or git-bash — hooks now run natively on Windows.
- **Fixed inconsistent IDE detection.** IDE detection and tool routing previously relied on separate checks that could disagree, occasionally routing tools to the wrong IDE's prefix. Detection is now unified, so the same IDE is always used consistently, and it no longer needs to re-scan running processes on every tool call.
- **Updated tool routing for the current MCP server (2025.2+).** File search, file reading, and other redirected tools now match the current server's tool names and parameters, including support for absolute paths and jar/jrt URLs when reading files.
- **Fixed an issue where redirected replace-in-file edits could replace every occurrence of a string instead of just one**, matching native Edit's single-occurrence behavior unless a replace-all was explicitly requested.
- **Improved Grep/Glob scoping.** Searches scoped to a specific in-project directory are now properly scoped within the IDE instead of searching the whole project. Searches outside the project root now fail open instead of being redirected to a project-wide search that couldn't see the target.
- Router skill made loadable again — it was previously unreachable due to a configuration issue.

### Added

- **PowerShell routing.** A conservative subset for Windows-first sessions: `Get-Content`/`gc`/`cat`/`type`, `Get-ChildItem`/`gci`/`ls`/`dir`, `Select-String`/`sls`, and common npm/tsc/jest/vitest build-and-test commands. Anything with pipes, variables, subexpressions, redirection, or quoting stays native.
- A `node hooks/jb-lib.js --probe` CLI command for the status skill, reporting enforcement state, detected IDE, kill-switch, and bypass list.

### Kept from 1.x

Fail-open behavior everywhere (no IDE, malformed input, out-of-project paths, composed commands), the non-code passthrough scope (dotfiles, markdown, JSON/JSONL, `docs/`, config extensions, binaries), the subagent bypass, the linked-worktree guard, the `JETBRAINS_ROUTER_DISABLE` / `JETBRAINS_ROUTER_BYPASS` session controls, and the anti-bypass hard deny on `JETBRAINS_ROUTER_*=` command prefixes.

---

## 1.0.7-alpha and earlier — 2026-04-29 → 2026-05-08

Pre-revival history (bash implementation, standalone repo): PreToolUse routing for Read/Grep/Glob/Edit/Write/Bash with fail-open behavior, IDE auto-detection across Windows/macOS/Linux, non-code passthrough scope, worktree and subagent bypasses, anti-bypass env-prefix guard, and function-call-syntax redirect messages. Deprecated 2026-05; superseded by 2.0.0-alpha.
