# Slag

A marketplace of experimental agent plugins, in-tree. Two are shipped: `anneal/` and `collet/`.
Plain directories, one git history, no submodules. Experiments here get rewritten and deleted
freely; that is the point of the repository.

## Commands

No dependencies to install. Node 18 or later, no package manager, no build step.

```bash
node --test collet/tests/*.test.js     # 68 tests, the only suite in the repo
node anneal/scripts/audit.js --root .  # anneal's own audit, run against this repo
```

There is no single check command yet, and no CI. Both are open in
[docs/documentation-cleanup.md](docs/documentation-cleanup.md).

## Where things live

```
slag/
├── .agents/plugins/marketplace.json   Codex marketplace index
├── .claude-plugin/marketplace.json    Claude Code marketplace index
├── .claude/settings.json              committed; no hooks, deny-reads only
├── anneal/                            repository layout auditor and migrator
├── collet/                            session task harness
└── docs/                              two documents, see below
```

Inside a plugin: `skills/<name>/SKILL.md` for what the host loads, `scripts/` for standalone CLIs,
`hooks/` for event wiring, `tests/` for a `node:test` suite, plus `README.md`, `LICENSE` and
`CHANGELOG.md`.

| Document | Read it when |
| --- | --- |
| [docs/collet-design.md](docs/collet-design.md) | changing collet's guard, scope check or task CLI |
| [docs/documentation-cleanup.md](docs/documentation-cleanup.md) | restoring a deleted file, or adding a document |

## Each plugin ships three manifests, one per host

| Host | File | Notes |
| --- | --- | --- |
| Claude Code | `<plugin>/.claude-plugin/plugin.json` | carries **no** `version` field |
| Codex | `<plugin>/.codex-plugin/plugin.json` | carries the `interface` block |
| Antigravity | `<plugin>/plugin.json` | anneal only |

They are hand-maintained copies of the same description and drift easily. Change one, check the
others.

Hooks split the same way: `<plugin>/hooks/hooks.json` for Claude Code,
`<plugin>/hooks/codex-hooks.json` for Codex, and `<plugin>/hooks.json` at the plugin root for
Antigravity.

## Conventions that constrain a change

**The marketplace owns every version.** Claude Code resolves a version from `plugin.json` first and
the marketplace entry second, so a `version` in a Claude `plugin.json` would silently mask the
marketplace entry and installers would never see the bump. Keep versions in
`.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`.

**A marketplace entry's source is a relative path**, `"./plugin-name"`. Plugins are in-tree, so the
manifest and the code it points at move in the same commit. A retired plugin's entry becomes
`null` under `renames`, so an installed copy is told the plugin is gone.

**A plugin carries only `README.md`, `CHANGELOG.md` and `LICENSE`.** No `CONTRIBUTING.md`, no
`SECURITY.md`, no `.github/`, no `.gitignore` of its own — the root file covers every plugin.

**No logos, no images, no badges.** These are experiments. A README earns its place on text alone,
and artwork is one more thing to keep in step with a manifest.

**A README describes current behaviour, for a user.** No benchmark methodology, no investigation
narrative, no history of what the plugin used to do. A plugin states once, near the top, that it is
experimental with no support promise, then gets on with describing itself. Counts a reader can
reproduce are allowed in a Benchmarks section with a one-line "how we tested"; a number nobody can
check is worse than no number.

**Every claim in a README is one that was run.** Output blocks come from real runs. Where a fact is
missing, say it is missing rather than filling it in.

**A plugin with scripted behaviour carries a `node:test` suite** under `tests/`. anneal currently
does not, and that is a debt, not a precedent.

**Documents under `docs/` follow the documentation schema**: YAML frontmatter with `type`, `summary`
and `related_files`, plus `status` for a `task_summary`. One current document per topic, updated in
place, with a stable kebab-case name and no date in the filename. Git holds history, not archive
copies. Keep useful rejected approaches in a `Rejected Alternatives` section.

**Disposable work goes in the session scratchpad.** Benchmark arms, throwaway fixtures, headless
probe workspaces and scratch git repositories are created under the scratchpad path given at
session start — use it verbatim, never `/tmp`, never `os.tmpdir()`, and never a directory inside
this repository. Nothing is copied back except a number or a line a document cites.

## Known pitfalls

- **`core.hooksPath` points at `scripts/git-hooks`, which does not exist.** It was deleted in
  `5278887`. Commits work, because git finds no hooks there. Unset it or restore the directory
  before relying on a commit gate.
- **`anneal/plugin.json` and `anneal/.claude-plugin/plugin.json` already disagree** on `version` and
  on one keyword. Nothing checks them; the validator that used to was deleted in `5278887`.
- **The scope of a collet task is derived by reading the code, not from the task title.** A scope
  one file too narrow does not block work — it pushes the change into the wrong file.
- **anneal's audit is a heuristic.** A flagged `index` file may be exactly what a framework expects,
  which is why it moves nothing without approval.
- **`.idea/` is gitignored and present.** Leave it alone.
