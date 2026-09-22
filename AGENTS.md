# Slag

Slag contains the experimental anneal and collet plugins. Node 22 or later is required;
`.nvmrc` selects Node 22. There is no dependency installation or build step.
Root JavaScript uses CommonJS; `collet/package.json` selects ESM inside collet.

## Start here

- For installation and plugin selection, read [README.md](README.md).
- Before changing manifests, hooks or release metadata, read [host contracts](docs/knowledge/host-plugin-formats.md).
- Before changing collet's mount, scope or closure, read [runtime contracts](collet/docs/knowledge/runtime-contracts.md).
- Before editing a plugin README, read [the README structure](docs/knowledge/plugin-readme-template.md).
- For repository setup and checks, read [repository scope](docs/knowledge/repository-scope.md).

## Commands

Run from the repository root unless a row names another directory.

| Command | Purpose | Cost |
| --- | --- | --- |
| `npm run check` | All plugin and repository tests | Local subprocesses and temporary fixtures; no paid services |
| `node --test scripts/plugin-integrity.test.js` | Manifest paths and cross-host metadata | Local |
| `node --test scripts/ignore-policy.test.js` | Documentation visibility contract | Local temporary Git fixtures |
| `node --test` from `anneal/` or `collet/` | One plugin's suite, without the suite-failure reporter: a suite that fails outside its tests can still exit 0 | Local temporary fixtures |
| `node anneal/scripts/audit.js --root .` | Heuristic navigation audit | Read-only, local |

The live session evals have separate host, sandbox and service requirements;
see [eval prerequisites](anneal/docs/knowledge/workflows.md#running-the-evals).

## Where things live

| Path | Content |
| --- | --- |
| `anneal/` | Navigation and documentation skills, scripts, guard, tests and evals |
| `collet/` | Harness skills, runtime templates, language catalogues, hooks and tests |
| `.claude-plugin/marketplace.json` | Claude marketplace and its plugin versions |
| `.agents/plugins/marketplace.json` | Codex marketplace with local plugin sources |
| `scripts/` | Repository integrity tests, edit-triggered test hook, optional Git gates, and the suite-failure reporter that `npm run check` and the edit hook add |
| `docs/knowledge/` | Repository contracts and contributor documentation |
| `<plugin>/docs/knowledge/` | Plugin workflows, technical contracts and changelog |

## Conventions

Keep host discovery files and executable skill resources with their plugin. A directory
named `references`, `templates` or `evals` can contain resources consumed by the product.
Each plugin README links its workflow guide and changelog.

`CLAUDE.md` imports this file; keep shared project facts here.
The repository release entry points share the [release procedure](.claude/skills/cut-release/SKILL.md).

## Pitfalls

- **Default Node test discovery skips dot directories.** Repository hook tests live under `scripts/` so the root check finds them.
- **Navigation findings are heuristic.** The runtime-name examples in `anneal/tests/audit.test.js` exercise the detector intentionally.
- **Passing subprocess tests does not prove installed-host behavior.** Hook discovery, trust and interactive execution require host validation.
