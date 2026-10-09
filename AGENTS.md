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
- Before deciding which plugin a new behavior belongs in, read [plugin roles](docs/knowledge/plugin-roles.md).

## Commands

Run from the repository root unless a row names another directory.

| Command | Purpose | Cost |
| --- | --- | --- |
| `npm run check` | All plugin and repository tests | Local subprocesses and temporary fixtures; no paid services |
| `node --test scripts/plugin-integrity.test.js` | Manifest paths and cross-host metadata | Local |
| `node --test scripts/ignore-policy.test.js` | Documentation visibility contract | Local temporary Git fixtures |
| `node --test scripts/markdown-links.test.js` | Relative links and anchors in tracked public Markdown | Local temporary Git fixtures |
| `node --test` from `anneal/` or `collet/` | One plugin's suite, without the suite-failure reporter: a suite that fails outside its tests can still exit 0 | Local temporary fixtures |
| `node anneal/scripts/audit.js --root .` | Heuristic navigation audit | Read-only, local |

The live session evals have separate host, sandbox and service requirements;
see the eval prerequisites for [anneal](anneal/docs/knowledge/workflows.md#running-the-evals)
and [collet](collet/docs/knowledge/harness-workflow.md#running-the-evals).

## Where things live

| Path | Content |
| --- | --- |
| `anneal/` | Navigation and documentation skills, scripts, guard, tests and evals |
| `collet/` | Harness skills, runtime templates, language catalogues, hooks, tests and evals |
| `.claude-plugin/marketplace.json` | Claude marketplace and its plugin versions |
| `.agents/plugins/marketplace.json` | Codex marketplace with local plugin sources |
| `scripts/` | Repository integrity tests, the edit hook that reruns the test files reaching an edited plugin file, optional Git gates, and the suite-failure reporter that `npm run check` and the edit hook add |
| `docs/knowledge/` | Repository contracts and contributor documentation |
| `<plugin>/docs/knowledge/` | Plugin workflows, technical contracts and changelog |

## Conventions

Keep host discovery files and executable skill resources with their plugin. A directory
named `references`, `templates` or `evals` can contain resources consumed by the product.
Each plugin README links its workflow guide and changelog.

Public records never name another project except where it was measured; the full rule is
[reference names](.claude/rules/reference-names.md), which Claude Code loads on its own.

`CLAUDE.md` imports this file; keep shared project facts here.
The repository release entry points share the [release procedure](.claude/skills/cut-release/SKILL.md).

## Pitfalls

- **Default Node test discovery skips dot directories.** Repository hook tests live under `scripts/` so the root check finds them.
- **Navigation findings are heuristic.** The runtime-name examples in `anneal/tests/audit.test.js` exercise the detector intentionally.
- **Isolated Git config drops long paths on Windows.** A test helper that sets `GIT_CONFIG_NOSYSTEM` loses Git for Windows' `core.longpaths`; pass `-c core.longpaths=true` and write it into the isolated `GIT_CONFIG_GLOBAL`, as `anneal/tests/eval-graders.test.js` does.
- **Invisible characters fail the check.** `scripts/hidden-characters.test.js` rejects raw zero-width, bidi and tag characters in tracked text; write them as escapes.
- **Passing subprocess tests does not prove installed-host behavior.** Hook discovery, trust and interactive execution require host validation.
