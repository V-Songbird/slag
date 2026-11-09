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
| `node scripts/plugin-parity.js <plugin directory> <installed plugin directory>` | [An installed plugin copy against its tracked source](docs/knowledge/host-plugin-formats.md#checking-an-installed-copy-against-the-source); exits 1 on any difference | Read-only, local |
| `node --test scripts/sdk-eval/lib.test.mjs` | The SDK eval runner's case reading and grader verdicts | Local |
| `node --env-file=<file> scripts/sdk-eval/run.mjs <plugin> --output-dir <dir>` | A plugin's eval cases through the Claude Agent SDK, with and without the plugin, or only with it under `--ablation none`; `--case`, `--tag`, `--runs`, `--max-cost-usd`. Needs `npm install` in `scripts/sdk-eval/` and `ANTHROPIC_API_KEY` in the env file; results go outside the repository | Paid API sessions; Bash runs unconfined in each workspace |

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
- **Navigation findings are heuristic.** The runtime-name examples in `anneal/tests/audit.test.js` exercise the detector intentionally; the audit also reports two matches in `anneal/scripts/session-evidence-navigation.js` (table dispatch).
- **Isolated Git config drops long paths on Windows.** A test helper that sets `GIT_CONFIG_NOSYSTEM` loses Git for Windows' `core.longpaths`; pass `-c core.longpaths=true` and write it into the isolated `GIT_CONFIG_GLOBAL`, as `anneal/tests/eval-graders.test.js` does.
- **Invisible characters fail the check.** `scripts/hidden-characters.test.js` rejects raw zero-width, bidi and tag characters, and variation selectors other than U+FE0E or U+FE0F right after an Extended_Pictographic character, U+FE0F in a keycap, or U+180B-U+180D and U+180F right after a Mongolian letter or one of its combining marks, and the Mongolian vowel separator U+180E except in that place or right after such a selector, in tracked text; write them as escapes. Some agent write tools turn a four-digit `\u` escape back into the raw character, so rerun that test after writing one.
- **Passing subprocess tests does not prove installed-host behavior.** Hook discovery, trust and interactive execution require host validation.

<!-- collet:begin — this block is written by the collet plugin; edit inside the markers, not around them -->
## How work happens here

`.collet/` holds this project's harness. The open task, the files it may touch and the command that
ends it are printed by `node .collet/task.mjs status`, and a new session is told them before it
reads anything.

In this project the person is asked before any of these: git push, Corridas SDK pagadas, Releases, Cambiar hooks o settings. Every other step goes ahead until the open task's accept command exits zero, or until a missing input or a broken environment means it cannot pass as the task stands: then the work ends as a blocker named in the summary.

1. **Change only the files the open task lists.** If the stated task needs another one, widen the
   list first — `node .collet/task.mjs widen --add <path> --why "<reason>"`. If the file goes beyond what the person asked for, ask them first; with
   nobody to ask, leave it and name it in your summary. Working around the list is not a widen.
2. **Finished means the accept command exited zero.** `node .collet/task.mjs close` checks the working tree against the task, then runs the accept command. Run it as you go, not only at the
   end. A task that was not closed did not finish, whatever the summary says. When a missing input
   or a broken environment means the accept command cannot pass as the task stands, the work ends
   as a blocker named in the summary and the task stays open.
3. **Facts come from this repository.** Quote the file a fact came from. If the repository does not
   answer a question, say so rather than choosing a plausible default and stating it as fact.
4. **Deliver what the task asks for, in full, and nothing beside it.** What it names is yours to do
   properly; what it does not name is off limits, and anything odd you notice gets reported in your
   summary instead of fixed.
5. **Say what you did not check.** The closing answer is a claim, not a formality.

`node .collet/checks/run.mjs` runs this repository's own checks, and needs nothing but node.
<!-- collet:end -->
