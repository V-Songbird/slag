<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="gauge" width="240" />
  </picture>
  <h1>gauge</h1>
  <p><strong>Measures what your project really costs Claude Code every session — then hands you the fix list.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — Most advice about trimming Claude Code's context bill is guesswork. gauge measures instead: it reads your real session records, prices everything that loads automatically, and sorts the findings by what saves the most. The counting is a plain script — measuring costs you nothing.

---

> [!NOTE]
> Experimental, and staying that way — and not even published to the marketplace. No support, no stability promise; it can change shape or disappear without a migration path. If it breaks your session, that's the deal you took.

## What is this?

Every Claude Code session starts by loading things you never see — memory files, rules, the listing for every skill you've installed. You pay for all of it, every session, whether it helped or not. And when a skill's header file is subtly broken, the skill quietly stops triggering and nothing tells you.

gauge measures all of that. One command reads your actual past sessions for the true start-up cost, inventories everything that loads automatically, and turns the numbers into a prioritized fix list — each finding with its fix and the arithmetic behind it.

## Why you'd want it

- **Real numbers, not vibes.** The start-up cost comes from your own past sessions, not an estimate.
- **A fix list sorted by payoff.** Biggest savings first, each with the exact change to make.
- **A watchdog that knows when to shut up.** At session start it checks your budget and prints nothing when things are fine.
- **Broken skills get caught at the door.** A write that would silently stop a skill from triggering is blocked, with the reason.

## How it works

| Moment | What happens |
| --- | --- |
| You run the audit | Everything that auto-loads is sized, priced, and sorted into a fix list |
| A session starts | A silent health check — one line only if the budget is blown or a skill is broken |
| Something writes to a skill file | Writes that would break the skill get blocked, with the reason fed back |

The audit is read-only — fixes are offered, never applied on their own.

## Install

gauge isn't in the marketplace — it loads from a local clone of this repo, for the current session:

```
git clone https://github.com/V-Songbird/slag
claude --plugin-dir path/to/slag/gauge
```

The only requirement is Node.js on your PATH.

## What you can do

| You want to… | Command |
| --- | --- |
| Measure your context bill and get the fix list | `/gauge:audit` |

## Under the hood

One measuring script and two small hooks — all there to read in the plugin's files.

## Settings

Most people never touch this. In your project, `.claude/gauge.json`:

| Setting | What it does |
| --- | --- |
| `budgetChars` | The always-loaded size budget the session-start check enforces; `0` turns the check off |

## Good to know

- With no past sessions in a project, the measured start-up cost is skipped — the inventory and fix list still work.

## License

MIT — see [LICENSE](./LICENSE).
