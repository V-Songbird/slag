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

Headless Antigravity CLI runs no shell command without a permission rule. Measured with agy 1.2.8
on Windows on 2026-09-22, using agy --sandbox --output-format stream-json -p: each run_command
needed the escalate_admin permission, which headless mode cannot prompt for. agy auto-denied it,
ended the turn without output and exited 0. Its message suggests an allow rule under
permissions.allow in settings.json, such as escalate_admin(<target>), or the
--dangerously-skip-permissions flag. Neither was measured. Without --sandbox, with command(*)
allowed and allowNonWorkspaceAccess set to true in settings.json, the same headless form ran every
skill's shell commands with agy 1.2.8 and 1.2.9 on Windows on 2026-09-23. Whether it needs those
settings was not measured.

Session scratch directories, for a skill that keeps a working file outside the project, as
docs-align's audit mode does. Each fact is marked measured, host-stated or not checked:

| Host | Session scratch directory | Writing there without a new approval |
| --- | --- | --- |
| Claude Code desktop app | Host-stated, app 2.2553.13.0 with Claude Code 2.1.280, 2026-09-23: the session's system prompt names a session-specific scratchpad directory under the user's temporary folder and says it can generally be used without permission prompts. | Measured in auto permission mode, same versions: files written there with the Write tool and from PowerShell needed no approval. Default permission mode not checked. |
| Claude Code CLI outside the app | Not checked. | Not checked. |
| Codex | Not checked. | Not checked. |
| Antigravity CLI | Measured, agy 1.2.9, 2026-09-23. Each conversation gets an artifact directory, ~/.gemini/antigravity-cli/brain/<conversation id>/. Asked before any tool call, the model gave that path as the artifact directory its instructions name. It also holds agy's own transcript under .system_generated/. An artifact is a user-facing file written with write_to_file and artifact metadata; agy stores a .metadata.json beside it. When no workspace is active, the model says its instructions make ~/.gemini/antigravity-cli/scratch the project root; agy 1.2.8 also ran commands there. That folder is shared: it held a file from an earlier session. Google's Antigravity CLI codelab describes artifacts but not where they are stored. | Measured headless, agy 1.2.9, 2026-09-23, with allowNonWorkspaceAccess set to true and the home folder listed in trustedWorkspaces: writes to both folders needed no approval, in default mode and in accept-edits mode. Plan mode, interactive runs and runs without those two settings not checked. Headless agy runs no shell command without a permission rule, as above. |

A Claude Code marketplace added from a local directory behaves as follows on CLI 2.1.278 and
desktop runtime 2.1.275, measured on 2026-09-22. claude plugin list reports the plugin's cache
copy as its install path. A new session's init event reports the marketplace's source directory
as the plugin path.

Skills are discovered from the plugin's skills directory. Each SKILL.md supplies name, description,
license, compatibility and metadata.version. A skill revision is independent of the plugin release.
Current invocation names and verified compatibility limits are in each plugin's README.

## Validation

Run npm run check from the repository root. The public scripts/plugin-integrity.test.js validates
Slag's current manifests, paths, identity and version placement. Host subprocess tests verify
payload handling; they do not establish installed-host trust or interactive behavior.
