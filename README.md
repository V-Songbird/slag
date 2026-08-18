<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="slag" width="240" />
  </picture>
  <h1>slag</h1>
  <p><strong>Experimental Claude Code plugins</strong> — the stuff that didn't make it out of the workshop, kept where it can't hurt anyone.</p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — A sandbox marketplace of plugin experiments. Six are installable from here. Nothing has a support promise, and nothing is guaranteed to still exist tomorrow.

---

> [!IMPORTANT]
> Nothing here is a product. These plugins are experiments: half-finished ideas, things being tried out, things kept around to see if they earn their keep. They get rewritten, renamed, and deleted without notice or a migration path. There is no support, no stability promise, and no release schedule.
>
> You are welcome to install any of them. If one breaks your session, that's the deal you took.

## What this is

Slag is the byproduct that comes off the good metal. This repo is where plugin ideas live before they're worth anyone's trust — and where they stay if they never get there.

Every plugin here works on its own, does one job, and stays out of the others' way. Some are genuinely useful. Some are load-bearing on assumptions that will turn out to be wrong. Nothing tells you which is which except reading the code, which is the honest answer for an experiment.

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/slag
/plugin install <plugin-name>@slag
```

The first command registers this collection (once); the second installs whichever plugin you want. Uninstalling is just as easy: `/plugin uninstall <plugin-name>@slag`.

---

## The plugins

### [assay](./assay) — Find the rules that can't work as written: vague, never loaded, or better as a hook

You wrote rules for your agent; it keeps ignoring some. assay grades every rule in the files that agent actually loads — `CLAUDE.md`, `.claude/rules/`, the ones in the folders above and below, and the notes Claude keeps about the project — on whether it can tell when a rule fires and what to do. It offers to rewrite the weak ones, and flags the rules that were never meant to be prose: the ones a hook, skill, or subagent would enforce better. Codex gets the same audit against its own `AGENTS.md` chain, from either side — `/assay:codex` here, or `$assay` with the plugin installed on Codex itself. Almost all of the grading is a deterministic script, so a re-run gives the same numbers.

```
/plugin install assay@slag
```

### [verity](./verity) — Real documentation instead of guesses

When you ask Claude how Claude Code itself works, it may answer from training memory — which ages badly. Verity makes Claude fetch the current official documentation live and answer from the source, citing the exact page it read. Install and forget; it kicks in whenever a Claude Code question comes up.

```
/plugin install verity@slag
```

### [jetbrains-router](./jetbrains-router) — Claude works through your JetBrains IDE

If you code in WebStorm, IntelliJ IDEA, Rider, PyCharm, or another JetBrains IDE, your editor already knows things Claude's native tools don't: which files have errors right now (no build needed), what you've typed but not saved, and which paths are worth searching. jetbrains-router redirects Claude's file reads, searches, and edits through the IDE's MCP server whenever the IDE is running — and steps aside completely when it isn't.

```
/plugin install jetbrains-router@slag
```

### [jig](./jig) — Guardrails for the mistakes your repo keeps making

Every repo has a greatest-hits album: the test somebody pinned to one case and never unpinned, the error caught and dropped on the floor, the AI session that deleted a failing test to get CI green. jig reads your repo and its git history, asks which of those you actually want stopped, then sets the whole thing up — your linter, type checker, test runner, CI, and checks written for your codebase. Every check has to catch a planted violation before jig will call anything covered, nothing gets written or installed that you didn't approve by name, and one command puts it all back.

```
/plugin install jig@slag
```

### [scribe](./scribe) — Makes Claude ask what you meant before it builds what you didn't

You say "improve this" and Claude picks one of five possible meanings and sprints. scribe makes it stop and ask first — short rounds of numbered options with its best guess marked — and it keeps asking until nothing important is left to guess at. A clear request goes straight through, untouched. Every question and every silent pass lands in a local log, so "does it ask too much?" is a question your own evidence answers.

```
/plugin install scribe@slag
```

### [brink](./brink) — A better summary when the context runs out

Long sessions end in an automatic summary that forgets the thing you cared about. brink watches how full the context window is getting and, near the edge, surfaces a one-time nudge to run `/compact` with a ready-made instruction — so the summary keeps the task, the decisions, and the errors instead of an automatic guess.

```
/plugin install brink@slag
```

### Which one first?

| You want to… | Install |
| --- | --- |
| Know which of your rules actually work | **assay** |
| Get trustworthy answers about Claude Code | **verity** |
| Use your JetBrains IDE's brains | **jetbrains-router** |
| Stop the same mistake landing over and over | **jig** |
| Stop Claude guessing what you meant | **scribe** |
| Keep a long session's summary from losing the plot | **brink** |

---

## Repository layout

```
slag/
├── assay/
├── brink/
├── jetbrains-router/
├── jig/
├── scribe/
└── verity/
```

Plugins live in-tree — plain directories, one history, no submodules. Each ships its metadata in `.claude-plugin/plugin.json` and carries its own `README.md`, `CHANGELOG.md`, and `LICENSE`. The marketplace index is [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) — it is also the single owner of every plugin's version number (plugin.json files carry no version field). The conventions a plugin here follows are in [`.claude/rules/plugin-layout.md`](.claude/rules/plugin-layout.md).

---

## Development

Run this once after cloning, to enable the commit gates:

```
git config core.hooksPath scripts/git-hooks
```

`.claude/settings.json` (committed) registers two repo-wide dev hooks, both dev-only — neither fires for anyone who has merely *installed* a plugin from this repo, only for edits made inside the source tree itself:

- `.claude/hooks/run-tests-on-edit.js` reruns whichever plugin's own test suite after an `Edit`/`Write` lands in that plugin's `scripts/` or `hooks/` dir — detected by walking up to the nearest `.claude-plugin/plugin.json` marker, so it works for any plugin in this repo, not just one. Silent when green; surfaces a failure via `additionalContext` when red.
- `.claude/hooks/nudge-manifest-curator.js` nudges a follow-up `manifest-curator` audit after an `Edit`/`Write` lands in `.claude-plugin/marketplace.json` or any plugin's `.claude-plugin/plugin.json` — manifest edits are easy to get subtly wrong (stale author info, version drift, schema violations), so a check only helps if something actually reminds you to run it.

Tests, for a plugin that has them:

```
node --test <plugin>/tests/*.test.js
```

---

## License

MIT — see [LICENSE](./LICENSE).
