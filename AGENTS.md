# Slag

Slag is the workshop where the anneal and collet plugins were developed. Both now live in their
own repositories ([anneal](https://github.com/V-Songbird/anneal),
[collet](https://github.com/V-Songbird/collet)) and are installed from the
[Foundry](https://github.com/V-Songbird/foundry) marketplace; this repository holds no plugin.
It keeps the SDK eval runner in `scripts/sdk-eval/`, its own collet harness in `.collet/`,
research records on host plugin formats and plugin roles, and the repository checks. Node 22 or
later is required; `.nvmrc` selects Node 22. There is no dependency installation or build step at
the root. Root JavaScript uses CommonJS; the `.mjs` files in `scripts/sdk-eval/` and `.collet/` are ESM.

## Start here

- Documentation rules: .claude/rules/documentation.md (anneal repo-docs contract, profile solo-public)
- Before changing hooks or the edit hook, read [host contracts](docs/knowledge/host-plugin-formats.md).
- Before running or changing the SDK eval runner, read its header in `scripts/sdk-eval/run.mjs`; a live run bills the API key.
- Record index: docs/index.md (one summary line per maintained record; search it before guessing a docs path)

## Commands

Run from the repository root unless a row names another directory.

| Command | Purpose | Cost |
| --- | --- | --- |
| `npm run check` | All repository tests; prints each failed test and the closing counts, and nothing for a test that passed | Local subprocesses and temporary fixtures; no paid services |
| `npm run check:verbose` | The same run with a line for every test | The same |
| `node .collet/checks/run.mjs` | The mounted harness's own checks | Local, needs only node |
| `node --test scripts/ignore-policy.test.js` | Documentation visibility contract | Local temporary Git fixtures |
| `node --test scripts/markdown-links.test.js` | Relative links and anchors in tracked public Markdown | Local temporary Git fixtures |
| `node scripts/plugin-parity.js <plugin directory> <installed plugin directory>` | [An installed plugin copy against its tracked source](docs/knowledge/host-plugin-formats.md#checking-an-installed-copy-against-the-source), the source being a Git checkout of a plugin such as a clone of anneal or collet; exits 1 on any difference | Read-only, local |
| `node --test scripts/sdk-eval/lib.test.mjs` | The SDK eval runner's case reading and grader verdicts, against the snapshot of collet's cases in `scripts/sdk-eval/fixtures/` | Local |
| `node --env-file=<file> scripts/sdk-eval/run.mjs <plugin directory> --output-dir <dir>` | The eval cases under `<plugin directory>/evals/`, graded by that plugin's `tests/eval-harness.js` or `.cjs`, through the Claude Agent SDK, with and without the plugin, or only with it under `--ablation none`; `--case`, `--tag`, `--runs`, `--max-cost-usd`. `<plugin directory>` is a path, such as a clone of anneal or collet. Needs `npm install` in `scripts/sdk-eval/` and `ANTHROPIC_API_KEY` in the env file; results go outside the repository | Paid API sessions; Bash runs unconfined in each workspace |

A plugin's own suite and the live session evals are documented in that plugin's repository,
[anneal](https://github.com/V-Songbird/anneal#readme) and [collet](https://github.com/V-Songbird/collet#readme).

## Where things live

| Path | Content |
| --- | --- |
| `.collet/` | This repository's own collet harness, mounted from the collet plugin; the open task and its checks |
| `scripts/` | Repository tests, `sdk-eval/` (the SDK eval runner), `plugin-parity.js`, the edit hook (a no-op now, see the pitfall below), optional Git gates, and the suite-failure reporter that `npm run check` adds |
| `docs/knowledge/` | Repository contracts and research records on host plugin formats and plugin roles, written for people first and read by agents too |

The anneal and collet plugins, their catalogs and their release procedure are not here; see
the Foundry marketplace.

## Conventions

Public records never name another project except where it was measured; the full rule is
[reference names](.claude/rules/reference-names.md), which Claude Code loads on its own.

`CLAUDE.md` imports this file; keep shared project facts here.

## Pitfalls

- **Default Node test discovery skips dot directories.** Repository hook tests live under `scripts/` so the root check finds them.
- **The edit hook is a no-op until a plugin returns.** `scripts/claude-hooks/run-tests-on-edit.js` still runs after every Edit or Write, but it acts only on a file under `<folder>/scripts|hooks|templates/` of a top-level folder that holds `.claude-plugin/plugin.json`, and no such folder exists here, so it prints nothing and exits 0. Its registrations in `.claude/settings.json` and `.codex/hooks.json` are unchanged on purpose: changing a hook or a setting is on the ask-first list.
- **The release gate has nothing to judge.** `scripts/git-hooks/release-gate.js` acts only on a `Release <plugin> <version>` subject whose plugin is in the staged `.claude-plugin/marketplace.json`; that file no longer exists, so the commit-msg hook passes such a subject unjudged.
- **The mounted harness is not compared with a template.** `.collet/state.mjs` and its siblings are the copy mounted when collet was developed here; collet's repository holds the current templates, and nothing here fails when the two differ.
- **The SDK eval fixtures are a snapshot.** `scripts/sdk-eval/fixtures/` holds three of collet's eval cases and its eval harness only so `lib.test.mjs` has a plugin directory to read; nothing compares them with collet's repository.
- **Invisible characters fail the check.** `scripts/hidden-characters.test.js` rejects raw zero-width, bidi and tag characters, and variation selectors other than U+FE0E or U+FE0F right after an Extended_Pictographic character, U+FE0F in a keycap, or U+180B-U+180D and U+180F right after a Mongolian letter or one of its combining marks, and the Mongolian vowel separator U+180E except in that place or right after such a selector, in tracked text; write them as escapes. Some agent write tools turn a four-digit `\u` escape back into the raw character, so rerun that test after writing one.
- **Passing subprocess tests does not prove installed-host behavior.** Hook discovery, trust and interactive execution require host validation.

<!-- collet:begin — this block is written by the collet plugin; edit inside the markers, not around them -->
## How work happens here

`.collet/` holds this project's harness. The open task, the files it may touch and the command that
ends it are printed by `node .collet/task.mjs status`, and a new session is told them before it
reads anything.

In this project the person is asked before any of these: git push, Corridas SDK pagadas, Releases, Cambiar hooks o settings. Every other step goes ahead until the open task's accept command exits zero, or until a missing input or a broken environment means it cannot pass as the task stands: then the work ends as a blocker named in the summary.

1. **Change only the files the open task lists.** If the stated task needs another one, widen the
   list first — `node .collet/task.mjs widen --add <path> --why "<reason>"`. A file the open task does not need stays out, even when the person asks
   for it: leave it and name it in your summary as left out. If a needed file goes beyond what the
   person asked for, ask them first; with nobody to ask, leave it and name it in your summary.
   Working around the list is not a widen.
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
