---
name: cut-release
description: >-
  Release one Slag plugin when explicitly invoked. Discover the current plugins,
  select an owner-approved version, update the changelog and host manifests,
  verify checks, then commit and push within the owner's authorization.
license: MIT
compatibility: Codex in the Slag checkout. Requires git and Node 22 or later.
metadata:
  version: "1.0"
---

# cut-release

This is the Codex entrypoint for this repository's release procedure. Use it only
when explicitly invoked as `$cut-release`; take the plugin and requested version
from the user's message. The invocation policy lives in `agents/openai.yaml`.

Before taking release actions, read and follow the complete
[canonical release procedure](../../../.claude/skills/cut-release/SKILL.md), then
read the repository's `AGENTS.md` and the host-format document it references.
The procedure is shared with the other hosts; do not duplicate its steps here.

## Codex execution notes

- Resolve the canonical link relative to this skill directory. If it is missing,
  stop and report the missing procedure rather than inventing a release workflow.
- The canonical file's Claude-only frontmatter describes its discovery on that
  host; its release steps apply here. Interpret `Read` and `Edit` as the available
  file-reading and patch tools, not required tool names. No `$ARGUMENTS`
  substitution is needed.
- Run commands from the repository root. On Windows, use PowerShell `Test-Path`
  to enumerate the optional manifests and `rg` instead of the Bash `ls`/`grep`
  examples. Compare versions only in the host version files listed by the
  procedure; a skill's `metadata.version` is its own revision, not the plugin's.
- Preserve existing authorization. The procedure's permission-prompt wording is
  not a guarantee that Codex prompts for each shell command. Before committing or
  pushing, verify the user's release request authorizes that action and its scope.
  Review the staged diff and the branch to be pushed so unrelated staged work or
  commits cannot be silently included. Ask only for missing material decisions or
  authorization; preparing or porting this skill does not authorize a release.
