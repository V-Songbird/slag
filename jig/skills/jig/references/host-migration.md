# Migrate an existing Jig installation between hosts

Use this workflow only for an explicit request to adopt an existing Jig project
in Codex or Claude Code. Either plugin build supports both destinations. If the
destination is unspecified, ask which host the owner intends to use before
planning. Host migration does not run the ordinary setup interview or the legacy
format migration.

## Inspect and plan

Confirm the intended project checkout and current branch with read-only Git
commands. Follow the owner's branch instructions and retain existing local work.
Use that checkout's absolute path as `<PROJECT_ROOT>`. Resolve `<JIG_ROOT>` from
the actual loaded `skills/jig/SKILL.md` location, two directories above the skill
directory, and verify `scripts/jig.js` exists there. Substitute absolute paths in
these commands; the angle-bracket names are placeholders, not shell variables.

Run the command for the requested destination:

```text
node "<JIG_ROOT>/scripts/jig.js" migrate --host codex --root "<PROJECT_ROOT>"
node "<JIG_ROOT>/scripts/jig.js" migrate --host claude --root "<PROJECT_ROOT>"
```

This reads the existing `.jig/config.json`, manifest, local history, instruction
sources and Git wiring. It does not execute check modules, install tools or
register hooks. When it can propose a change, it writes only a review plan at
the returned `planPath`. It has not applied the bridge.

For Codex adoption, discovery considers root and nested `CLAUDE.md`,
`CLAUDE.local.md`, `.claude/CLAUDE.md` and `.claude/rules/**/*.md`. For Claude
adoption, it considers root and nested `AGENTS.md` and `AGENTS.override.md`.
These are source pointers, not permission to apply every policy globally.

Read `why` and the full report before presenting the proposed change:

- `instructions` names the source files, directory scopes and any `paths`
  conditions. Open those sources and the destination file. Follow their local
  governance references relative to the source file and check for conflicting
  policies or commands that name the other host.
- `unresolved`, `excludedDirectories` and `nestedRepositories` define discovery
  limits. Unsupported rule scopes and unresolved instruction links prevent a
  plan; report the exact paths rather than broadening their scope.
- `drift`, `guards` and `controls` describe existing installed artifacts, guard
  IDs, modes and `.jig/off`. Preserve those decisions. Report missing or drifted
  files; host migration does not repair them.
- `history` names missing journals, ledgers or pre-images. An ordinary clone or
  worktree may lack this ignored local history. Migration cannot reconstruct it
  or make earlier installations reversible; it records its own applied change.
- `wiring`, `session` and `reviewRequired` list remaining checks. File presence
  is inventory, not evidence that a lane executed.

If `legacyUpgradeRequired` is true, explain the separate format upgrade needed.
Do not run `migrate` without `--host`, add `--accept-drops`, or retire a guard on
the authority of a host-only request. Get separate authorization for that work.
If no plan is returned, report the reason: an already-current bridge, no
discovered source instructions, or a prerequisite does not certify enforcement.

## Review the instruction bridge

Codex's target is root `AGENTS.override.md` when that file is nonempty, otherwise
root `AGENTS.md`. Codex selects the first nonempty instruction file per directory
and combines the applicable directory chain. See the
[Codex instruction contract](https://developers.openai.com/codex/guides/agents-md/).

Claude Code's target is root `CLAUDE.md`. Its native project memory and
`.claude/rules` have directory and optional path scopes. See the
[Claude Code memory contract](https://code.claude.com/docs/en/memory).

The proposed target text contains a separate owned fence:
`jig:host-migration:codex` or `jig:host-migration:claude`. It adds conditional
pointers to source instructions; it does not copy or rewrite their bodies.
Nested policies stay conditional on work in their subtree, and supported Claude
rule `paths` stay conditional on matching files within that rule's scope.
Existing nonempty Codex overrides take precedence over same-directory
`AGENTS.md` sources when moving to Claude.

Review the complete `changes[].content`, including the owner's existing target
text. Keep all source files: the bridge still requires them. Do not rename
historical `claude-session` actors or regenerate proofs for host adoption.
Check modules, IDs, modes, configuration, driver and existing history remain in
place; applying the bridge adds its own manifest and journal records.

Discovery is limited to the reported repository scope. It does not follow
symlinks or enter nested repositories, and it excludes dependency, build and
Jig state directories. User and managed instructions, ancestor instructions
outside this checkout, external imports, Codex fallback filenames, Claude
exclusion settings and destination context-size limits need separate review.
Imported or referenced governance target bytes are **not fingerprinted** by
this plan; inspect them again before relying on them. The bridge does not
translate settings, permissions, custom hooks, skills or arbitrary host commands.
Resolve a policy conflict with the owner before the affected action.

## Approve, apply and undo

Present the exact change `id`, target `path`, full proposed text, rationale and
undo command. Ask for explicit approval of that named id/path pair through the
host's supported question UI or a concise textual reply. Reuse existing explicit
session authorization only when that same named change, path and consequence
remain unchanged. `--quick`, a migration request alone, or displaying the plan
does not approve the instruction write.

Apply each approved change by its named pair, never a batch plan approval:

```text
node "<JIG_ROOT>/scripts/jig.js" apply --change <id> --path <path> --root "<PROJECT_ROOT>"
```

The engine rechecks discovered source bytes and scope, installed state and the
active target before applying. A source edit, newly discovered scoped source,
changed active override, or changed or deleted target invalidates a stale plan.
Re-plan and obtain approval for the revised change instead of forcing it through.
An identical reapply leaves the instruction-file bytes unchanged when the
reviewed state still matches; it may still append audit records.

Record the transaction id returned by `apply`. To undo this migration transaction:

```text
node "<JIG_ROOT>/scripts/jig.js" revert --tx <tx> --root "<PROJECT_ROOT>"
```

The change also supports `revert --change <id>` for its instruction-file write.
Use the transaction when undoing all records from this migration. Do not use
`revert --all` to undo host adoption; that targets the existing Jig installation
as well. Standard drift checks still apply to reversal.

## Verify the destination

Use the destination host's Jig plugin and review its actual hook registration
and trust controls. In Codex, inspect `/hooks` in the active host. Prove a real
denied call and an allowed near miss in a disposable fixture or copy, preserving
the owner's repository. A synthetic `selftest --live` is detector evidence,
not proof that the host delivered or denied a real call.

Verify the existing driver, staged commit hook, configured verification commands
and CI in the intended checkout and branch. Confirm Node and required tools are
available where those lanes run. Driver execution alone is not proof a Git
commit or CI job occurred. Desktop and CLI, and different operating systems,
need their own host evidence.

Close with the applied target and transaction, preserved installation state,
reported drift or missing history, and the lanes actually witnessed. State any
remaining verification explicitly. Do not claim the migration verified every
host, repaired governance conflicts, or recovered missing history.
