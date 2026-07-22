<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="slag" width="240" />
  </picture>
  <h1>slag</h1>
  <p><strong>Experimental Claude Code plugins</strong> — the stuff that didn't make it out of the workshop, kept where it can't hurt anyone.</p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — A sandbox marketplace of plugin experiments. Four are installable from here; two more live in the tree, local-only, until they earn their keep. Nothing has a support promise, and nothing is guaranteed to still exist tomorrow.

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

### [assay](./assay) — Find out which of your rules Claude can actually follow

You wrote rules for Claude; it keeps ignoring some. assay grades every rule in your `CLAUDE.md` and `.claude/rules/` on whether Claude can tell when it fires and what to do, offers to rewrite the weak ones, and flags the rules that were never meant to be prose — the ones a hook, skill, or subagent would enforce better. Almost all of the grading is a deterministic script, so a re-run gives the same numbers.

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

### [proof](./proof) — Find out if your config change actually did anything

You tweaked a rule, a skill, a whole `CLAUDE.md`, and it *feels* better — but the model is different every run, so "seems better" is a vibe, not evidence. proof runs your tasks with and without the change, many times over, and hands you a verdict: it helped, it hurt, it did nothing, or there isn't enough signal yet — with the cost shown before anything runs.

```
/plugin install proof@slag
```

### Which one first?

| You want to… | Install |
| --- | --- |
| Know which of your rules actually work | **assay** |
| Get trustworthy answers about Claude Code | **verity** |
| Use your JetBrains IDE's brains | **jetbrains-router** |
| Measure whether a config change moved anything | **proof** |

### Also in the tree, not in the marketplace

Two experiments live here without a marketplace entry — even more experimental than the rest. Each loads from a local clone (`claude --plugin-dir path/to/slag/<name>`); their READMEs have the details.

- [plumb](./plumb) — won't let Claude call it done until it's actually run the code.
- [gauge](./gauge) — measures what your project really costs Claude Code every session, then hands you the fix list.

---

## Repository layout

```
slag/
├── assay/
├── gauge/
├── jetbrains-router/
├── plumb/
├── proof/
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
