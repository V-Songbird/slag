# Slag

A marketplace of experimental agent plugins, in-tree. Two are shipped: `anneal/` and `collet/`.
Plain directories, one git history, no submodules. Experiments here get rewritten and deleted
freely; that is the point of the repository.

No dependencies to install, no build step. Node 22, as `.nvmrc` declares and `package.json`
requires. The suite last passed on 20.11.1 on 2026-09-21, the day the floor moved from 20.

## Start here

- Before touching a manifest, a hooks file or a host adapter:
  [docs/knowledge/host-plugin-formats.md](docs/knowledge/host-plugin-formats.md).
- Before writing or restructuring a plugin README:
  [docs/knowledge/plugin-readme-template.md](docs/knowledge/plugin-readme-template.md).
- Before changing collet's guard, scope check or task CLI:
  [docs/knowledge/collet-design.md](docs/knowledge/collet-design.md).
- Before restoring a deleted file or adding a document:
  [docs/knowledge/plugin-trim.md](docs/knowledge/plugin-trim.md).
- A release happens only when the owner asks for one, and follows
  [.claude/skills/cut-release/SKILL.md](.claude/skills/cut-release/SKILL.md) on every host. Claude
  Code loads it as `/cut-release`. Codex and Antigravity do not load `.claude/`, so a session there
  reads that file and follows it.

Each document under `docs/` opens with a `summary` line that says when to read it. There is no
index to keep in step.

## Rules that outrank everything

**Author fields read `Victor Villegas` and `victor.villegas@tuta.com`,** in every manifest, both
marketplace entries that carry one, and each `LICENSE`. No other address, and no path from a
developer's machine, goes into a tracked file.

**A version lives in exactly one file per host, and the same number in all of them.** Claude Code
resolves a version from `plugin.json` first and the marketplace entry second, so a `version` in a
Claude `plugin.json` would silently mask the marketplace entry and installers would never see the
bump. Every other host has no marketplace entry carrying one, so its manifest keeps its own.

| Host | The version lives in |
| --- | --- |
| Claude Code | `.claude-plugin/marketplace.json`, never `<plugin>/.claude-plugin/plugin.json` |
| Codex | `<plugin>/.codex-plugin/plugin.json` — `.agents/plugins/marketplace.json` carries none |
| Antigravity | `<plugin>/plugin.json`, the only manifest that host reads |

A bump touches every row. They are hand-maintained and nothing checks them.

## Commands

| Command | What it does | Cost |
| --- | --- | --- |
| `npm run check` | `node --test` over every suite: anneal, collet, the edit hook | seconds |
| `node --test <plugin>/tests/<name>.test.js` | one test file, named in full | seconds |
| `node anneal/scripts/audit.js --root .` | anneal's own audit, run against this repo | instant |
| `claude plugin eval ./anneal --scaffold --no-publish --allow-tools Bash Edit Write` | 3 eval cases; each builds a fixture and needs a shell grant | slow, drives real sessions; refused on native Windows, run it under WSL2 |
| `git config core.hooksPath scripts/git-hooks` | arms the commit gate | once after cloning |

There is no CI. The one gap the seven-plugin trim left open is in
[docs/knowledge/plugin-trim.md](docs/knowledge/plugin-trim.md).

## Where things live

```
slag/
├── .agents/plugins/marketplace.json   Codex marketplace index
├── .claude-plugin/marketplace.json    Claude Code marketplace index
├── .claude/                           committed; settings, one scoped rule, the cut-release skill
├── anneal/                            repository layout auditor and migrator
├── collet/                            session task harness
├── docs/knowledge/                    why things are built the way they are
├── docs/decisions/                    decision records
├── scripts/claude-hooks/              reruns a plugin's suite after an edit inside it
└── scripts/git-hooks/                 the commit gate, armed by hand after a clone
```

Inside a plugin: `skills/<name>/SKILL.md` for what the host loads, `scripts/` for standalone CLIs,
`hooks/` for event wiring, `agents/` for a subagent a skill delegates to, `tests/` for a
`node:test` suite, `evals/` for cases `claude plugin eval` runs, plus `README.md`, `LICENSE` and `CHANGELOG.md`.

### Each plugin ships three manifests, one per host

| Host | File | Notes |
| --- | --- | --- |
| Claude Code | `<plugin>/.claude-plugin/plugin.json` | carries **no** `version` field |
| Codex | `<plugin>/.codex-plugin/plugin.json` | carries the `interface` block and the `hooks` path |
| Antigravity | `<plugin>/plugin.json` | deliberately omits the portable Agent Plugins `$schema` |

They are hand-maintained copies of the same description and drift easily. Change one, check the
others.

The root `plugin.json` serves Antigravity. Keep the Agent Plugins `$schema` out of it:
Codex CLI 0.155.1 and desktop runtime 0.155.0-alpha.9.2 omit hooks when that schema
selects their portable loader. Without it, Codex reads `.codex-plugin/plugin.json`
and discovers the hooks. Do not add `extensions.com.openai` or restore portable
recognition without repeating the host discovery and execution checks in
[host-plugin-formats.md](docs/knowledge/host-plugin-formats.md).

Hooks split the same way: `<plugin>/hooks/hooks.json` for Claude Code,
`<plugin>/hooks/codex-hooks.json` for Codex, and `<plugin>/hooks.json` at the plugin root for
Antigravity. One script serves all three; the host is an argument, and it decides how the call is
read off the event and what a denial looks like on the wire.

## Conventions

**A marketplace entry's source is a relative path**, `"./plugin-name"`. Plugins are in-tree, so the
manifest and the code it points at move in the same commit. A retired plugin's entry becomes
`null` under `renames`, so an installed copy is told the plugin is gone.

**A plugin carries only `README.md`, `CHANGELOG.md` and `LICENSE`.** No `CONTRIBUTING.md`, no
`SECURITY.md`, no `.github/`, no `.gitignore` of its own — the root file covers every plugin.
`collet/package.json` is the one exception, and it exists only to declare the module type.

**No logos, no images, no badges.** These are experiments. A README earns its place on text alone,
and artwork is one more thing to keep in step with a manifest.

**Both plugin READMEs follow one skeleton:** the same H2 headings in the same order, recorded in
[docs/knowledge/plugin-readme-template.md](docs/knowledge/plugin-readme-template.md). A section a
plugin needs and the skeleton lacks goes under `How it works`, not beside it.

**A README describes current behaviour, for a user.** No benchmark methodology, no investigation
narrative, no history of what the plugin used to do. A plugin states once, near the top, that it is
experimental with no support promise, then gets on with describing itself. Counts a reader can
reproduce are allowed in a Benchmarks section with a one-line "how we tested"; a number nobody can
check is worse than no number.

**Every claim in a README is one that was run.** Output blocks come from real runs. Where a fact is
missing, say it is missing rather than filling it in.

**A skill's frontmatter carries `name`, `description`, `license`, `compatibility` and
`metadata.version`.** The description is a `>-` block with no colon followed by a space in it.
`metadata.version` is the skill's own revision, not the plugin's version: a release leaves it
alone, and a change to the skill's scope or mode moves it. Why is in
[docs/knowledge/host-plugin-formats.md](docs/knowledge/host-plugin-formats.md).

**A plugin with scripted behaviour carries a `node:test` suite** under `tests/`. Both do.

**`docs/` has one folder per document `type`:** `docs/knowledge/` and `docs/decisions/` today. A new
document copies its frontmatter from a sibling. `docs/research/` is gitignored, holds the commit
gate's blocklist, and is not a place for documents.

**Disposable work goes in the session scratchpad.** Benchmark arms, throwaway fixtures, headless
probe workspaces and scratch git repositories are created under the scratchpad path given at
session start — use it verbatim, never `/tmp`, never `os.tmpdir()`, and never a directory inside
this repository. Nothing is copied back except a number or a line a document cites.

**This file carries only what is specific to Slag.** A rule the host's own instruction file already
loads is not copied in here. Two sources of truth for one rule drift, and the copy is the one that
goes stale.

## Pitfalls

- **`CLAUDE.md` is one line, `@AGENTS.md`, and never gains content.** All three hosts read this
  file; Claude Code reaches it through that import, because some of its sessions cannot read
  `AGENTS.md` on their own. The import is what makes it safe: a `CLAUDE.md` without it, even one
  that points here in words, hides this file from that host. The rule is in
  [docs/knowledge/host-plugin-formats.md](docs/knowledge/host-plugin-formats.md).
- **collet is ESM, anneal is CommonJS.** Every `.js` under `collet/` uses `import`, and
  `collet/package.json` declares `"type": "module"` so it does not depend on Node's syntax
  detection. Every `.js` under `anneal/` uses `require` and relies on the root `package.json`
  having no `type`. Never add one there, and never move collet's declaration up to the root.
- **What a project receives from collet is all `.mjs`.** No `.js` file is ever written into a
  mounted project, so that project's own `package.json` and its `type` never come into it. Keep new
  templates on `.mjs`.
- **The commit gate is silent until a blocklist exists.** `scripts/git-hooks/` scans the staged
  change and the commit message for names in `docs/research/reference-names.txt`, which is
  gitignored and not in your clone. With no blocklist it passes everything, on purpose, so a
  standalone clone can still commit. A green commit is not proof the gate ran. The rule it was
  built to enforce holds regardless, and commit messages are in scope:
  [.claude/rules/reference-names.md](.claude/rules/reference-names.md).
- **`node --test` does not take a directory.** On 22 a bare directory argument is read as a test
  file and fails with `Cannot find module`. Name a file, pass a glob such as
  `<plugin>/tests/*.test.js`, or run `node --test` with no argument from the directory you want
  walked. The hook and the release skill use the last form, kept from the Node 20 floor. Node 22 also
  skips dot-directories when it walks, which is why the hook that reruns suites lives under `scripts/`.
- **`<plugin>/plugin.json` carries a `version` and `<plugin>/.claude-plugin/plugin.json` does not.**
  That is the rule above working, not drift. Do not "fix" it by deleting one. anneal's two differ on
  one keyword, and nothing checks them: the validator was deleted in `5278887`.
- **Antigravity runs a plugin hook from the plugin directory, not the project.** `process.cwd()`
  is `<plugin>/` there, which is why the root `hooks.json` can say `./hooks/guard.js` and why the
  hooks take the project from the event — `CLAUDE_PROJECT_DIR` on Claude Code, `cwd` on Codex,
  `workspacePaths[0]` on Antigravity — and fall back to `process.cwd()` last. The event itself is
  nested there, `toolCall.name` and `toolCall.args` in PascalCase, and the answer is a bare
  `{ "decision": "allow" | "deny" }` with the allow said out loud.
- **Antigravity has no marketplace file and no `SessionStart` or `PreCompact`.** A user copies the
  plugin directory or runs `agy plugin install <path>`; `.agents/plugins/` here is Codex's index,
  and Antigravity finding no plugin directory under it is expected. Only the guard is wired on that
  host; the rules block in `AGENTS.md` carries the rest.
- **The scope of a collet task is derived by reading the code, not from the task title.** A scope
  one file too narrow does not block work — it pushes the change into the wrong file.
- **anneal's audit is a heuristic.** A flagged `index` file may be exactly what a framework expects,
  which is why it moves nothing without approval. Run against this repository it reports
  `runtime-names` three times in `anneal/tests/audit.test.js`. Those are the fixture strings that
  prove the rule fires. Leave them.
- **`.idea/` is gitignored and present.** Leave it alone.
