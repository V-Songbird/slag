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
  - scripts/plugin-parity.js
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

The plugin-root plugin.json, Antigravity's manifest, deliberately omits the portable Agent Plugins
schema and com.openai extension. Codex uses the compatibility manifest, .codex-plugin/plugin.json,
so its hooks remain discoverable. Changing loader selection
requires actual host discovery and execution checks, not only valid JSON.

## Hook events and payloads

Claude Code and Codex use tool_name, tool_input and cwd. Denials use hookSpecificOutput with
hookEventName PreToolUse and permissionDecision deny. An empty response allows the call.
Collet also provides SessionStart and PreCompact. Anneal has two PreToolUse guards: one on shell
commands for migration branches, one on file-tool writes into instruction files. Anneal's shell
guard also answers permissionDecision ask, which Claude Code shows as a permission prompt; how
Codex handles ask is unverified.

Antigravity supports PreToolUse guards here. It supplies toolCall.name and toolCall.args,
with PascalCase path fields. It documents a bare decision allow or deny, with a reason for
refusal. Anneal's shell guard also sends decision ask; how Antigravity handles it is unverified.
Anneal's file guard is tested only as a subprocess with each host's payload; whether each host
shows its refusal in a live session is unverified.
Hooks run from the installed plugin directory. Collet locates the project from explicit context,
then absolute command Cwd or file TargetFile/AbsolutePath when workspace context is absent.
Relative arguments alone do not establish a project. The nearest mounted harness is used.

## Installation and trust

Install Claude Code plugins through its marketplace. Install Codex plugins from the slag
marketplace, then review and trust their exact hook definitions through Codex's /hooks command,
which lists each plugin's hooks by event name: PreToolUse for anneal; SessionStart, PreToolUse and
PreCompact for collet. New or changed definitions need review.
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
repo-docs's audit mode does. Each fact is marked measured, host-stated or not checked:

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

### Checking an installed copy against the source

The Claude Code cache keeps a full copy of the plugin directory under
`<cache>/<marketplace>/<plugin>/<version>/`, beside a host-owned `.in_use` folder that the source
does not have. A reinstall or an update replaces that copy, so the hook scripts and hook
definitions a host trusted can change underneath that trust. To see whether an installed copy still
matches the tracked source, run from the repository root:

```sh
node scripts/plugin-parity.js <plugin directory> <installed plugin directory>
```

For example, `node scripts/plugin-parity.js collet <cache>/slag/collet/<version>`. The check prints
one line per difference: each file whose bytes changed, each installed file the source does not
track, each tracked file the install lacks, and each hook event in `hooks/hooks.json`,
`hooks/codex-hooks.json` or the plugin-root `hooks.json` whose definition differs. The plugin-root
file is read under the plugin's name from the source's `.claude-plugin/plugin.json`. A hook file
that is not valid JSON on either side is reported as `unreadable`, unless both sides hold the same
bytes. A tracked file deleted from the work tree is skipped in the file comparison, so an installed
copy of it goes unreported; a deleted hook file counts as absent, so each of its installed events
is reported as `added` and the run exits 1. It
prints `parity: no differences` and exits 0 when the copy matches, exits 1 on any difference, and
exits 2 on a usage error, when Git cannot list the source's tracked files, or when a directory or
the source's plugin name cannot be read. It only reads: it never edits a cache, a configuration, a
trust record or a hook. A Codex plugin's installed directory can be passed the same way, but no
run against a Codex install has been measured. When a Codex hook definition changed, review and
trust it again through /hooks, as described above.

Skills are discovered from the plugin's skills directory. Each SKILL.md supplies name, description,
license, compatibility and metadata.version. A skill revision is independent of the plugin release.
Current invocation names and verified compatibility limits are in each plugin's README.

## Validation

Run npm run check from the repository root. The public scripts/plugin-integrity.test.js validates
Slag's current manifests, paths, identity and version placement, and scripts/plugin-parity.test.js
checks the installed-copy comparison against fixtures for a matching copy, a changed file, an added
file, changed events in each of the three hook files, an added or missing hook file, a hook file
that is not JSON, a hook file deleted in the work tree, and exit 2 on a usage error, an unreadable
installed directory, Git failing to start, a source outside a repository and a source without a
plugin name. Host subprocess tests verify
payload handling; they do not establish installed-host trust or interactive behavior.
