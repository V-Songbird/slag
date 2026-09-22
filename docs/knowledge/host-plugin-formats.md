---
type: knowledge
summary: "Current manifest, hook and version contracts for Slag's three hosts; read before changing a host adapter or release metadata."
related_files:
  - .claude-plugin/marketplace.json
  - .agents/plugins/marketplace.json
  - anneal/plugin.json
  - anneal/.codex-plugin/plugin.json
  - collet/plugin.json
  - collet/.codex-plugin/plugin.json
  - anneal/hooks/
  - collet/hooks/
---

# Host plugin contracts

Each plugin is an in-tree directory with three host manifests. Sources in both marketplaces
resolve relative to this repository; keep source paths local and do not add absolute machine paths.

| Host | Manifest | Version source | Hook definition |
| --- | --- | --- | --- |
| Claude Code | .claude-plugin/plugin.json inside each plugin | Root .claude-plugin/marketplace.json entry | hooks/hooks.json |
| Codex | .codex-plugin/plugin.json inside each plugin | That manifest | hooks/codex-hooks.json |
| Antigravity | plugin.json inside each plugin | That manifest | hooks.json at the plugin root |

Claude plugin manifests contain no version. Codex marketplace entries contain no version.
All three effective versions agree. Descriptions and author identity also agree; the repository
integrity test checks these contracts and declared local resources.

Root plugin.json deliberately omits the portable Agent Plugins schema and com.openai extension.
Codex uses the compatibility manifest so its hooks remain discoverable. Changing loader selection
requires actual host discovery and execution checks, not only valid JSON.

## Hook events and payloads

Claude Code and Codex use tool_name, tool_input and cwd. Denials use hookSpecificOutput with
hookEventName PreToolUse and permissionDecision deny. An empty response allows the call.
Collet also provides SessionStart and PreCompact; Anneal guards migration shell commands.

Antigravity supports the PreToolUse guard here. It supplies toolCall.name and toolCall.args,
with PascalCase path fields. It expects a bare decision allow or deny, with a reason for refusal.
Hooks run from the installed plugin directory. Collet locates the project from explicit context,
then absolute command Cwd or file TargetFile/AbsolutePath when workspace context is absent.
Relative arguments alone do not establish a project. The nearest mounted harness is used.

## Installation and trust

Install Claude Code plugins through its marketplace. Install Codex plugins from Slag, then review
and trust their exact hook definitions through /hooks. New or changed definitions need review.
For Antigravity CLI, use agy plugin install and confirm registration with agy plugin list.

Skills are discovered from the plugin's skills directory. Each SKILL.md supplies name, description,
license, compatibility and metadata.version. A skill revision is independent of the plugin release.
Current invocation names and verified compatibility limits are in each plugin's README.

## Validation

Run npm run check from the repository root. The public scripts/plugin-integrity.test.js validates
Slag's current manifests, paths, identity and version placement. Host subprocess tests verify
payload handling; they do not establish installed-host trust or interactive behavior.
