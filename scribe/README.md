<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="scribe" width="240" />
  </picture>
  <h1>scribe</h1>
  <p><strong>Makes Claude ask what you meant before it builds what you didn't.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — You say "improve the function." Claude picks one of five possible meanings and sprints. scribe makes it stop and ask first — short rounds of options with its best guess marked, and it keeps asking until the task is defined well enough to cut once.

---

> [!NOTE]
> Every plugin in this marketplace is an experiment — it works, it's tested, and there's no support promise. Use what's useful, uninstall what isn't.

## What is this?

Every vague request forces a coin flip. "Improve this", "clean it up", "make it better" — Claude has to guess what you meant, and a wrong guess costs you a rework plus the archaeology of undoing it. The old carpenter's rule applies: measure twice, cut once.

scribe is the measuring. When your request could honestly go several ways, Claude asks — numbered, focused questions, each with options and its recommended answer first. You pick, it asks whatever is still open, and only when nothing material is left does it get to work. A precise request skips all of this and goes straight through.

## Why you'd want it

- **The wrong guess is the expensive part.** A ten-second answer beats a ten-minute rework, every time.
- **Recommended answers keep it fast.** Every question leads with scribe's best guess — agreeing is one click.
- **"Just do it" always works.** Say so and scribe stands down, that turn, no lecture.
- **It keeps receipts.** Every judged prompt, every question round, and every wave-off lands in a local log — so "does it ask too much?" gets answered from your own evidence, not vibes.
- **It grades its own questions.** If you keep ignoring the options and typing your own answer, scribe notices and says the options were the problem.

## How it works

| Moment | What happens |
| --- | --- |
| You ask for something clear | Nothing. It goes straight through. |
| You ask for something that could go several ways | A numbered question round, options with a recommendation first |
| More is open than one round can hold | The rest comes in the next round, nothing quietly dropped |
| Your answer opens a new fork | The follow-up gets asked — until nothing material is left |
| You say "just do it" | scribe stands down for the turn, no argument |
| You answer the same question the same way twice | It offers to remember; from then on it's a stated assumption you can veto, not a question |
| You're running Claude unattended | scribe stands down rather than stall your run on a question |

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/slag
/plugin install scribe@slag
```

Works immediately — nothing to configure, nothing to initialize.

## What you can do

| You want to… | Say |
| --- | --- |
| See what scribe has asked, passed, been waved off on, and remembers | `/scribe:review` |
| Change how eagerly it asks | `/scribe:review` — it suggests the change and applies it if you agree |
| Find out whether its questions were any good | `/scribe:review` — it flags when the options keep missing |
| Make it forget something it remembered | `/scribe:review`, then "forget that" |
| Run a clarify round on demand | `/scribe:clarify` |

## Benchmarks

Does it actually work, or is this vibes? Same tasks, same model, with and without scribe:

| What we measured | With scribe | Without |
| --- | --- | --- |
| Asked before acting on a genuinely forkable request | **7 of 8** | 0 of 8 |
| Precise requests interrupted | 0 of 6 | 0 of 6 |
| Runs stalled waiting for an answer | 0 of 12 | — |

The middle row is the contract: clarity costs you nothing. The last row is the promise that scribe knows when nobody's there to answer and stays out of the way.

> [!NOTE]
> Small runs on a fixed set of tasks, not a benchmark suite. Numbers like these move a few percent between runs.

## Under the hood

Two small hooks and a local ledger: one hook judges your prompt on the way in, the other watches how the questions landed. It's all in the plugin's files.

## Settings

Most people never touch these. An optional `.scribe/config.json` in your project:

| Key | What it does |
| --- | --- |
| `bar` | `"standard"` (default) asks the moment a word has to be interpreted; `"conservative"` asks only when a wrong guess would cost real rework |
| `fatigueCap` | Question rounds per session before scribe stops asking (default `0`, no cap) |
| `off` | `true` silences scribe in this project |

Prefer a switch? `SCRIBE_OFF=1` in the environment or an empty `.scribe/off` file does the same as `off`.

## Good to know

- scribe influences; it never blocks. The judgment call is Claude's, which is exactly why every judged prompt, every question round, and every wave-off is logged to `.scribe/ledger.jsonl` where you can audit it.
- The nudge that rides your prompts is small, fixed text with a hard size cap, enforced by a test — scribe never assembles it from your repository's content.
- The log stays in your project and never leaves your machine. It keeps the first 200 characters of each judged prompt, the questions scribe asked with the options it offered, and the answers you picked or typed. It sits in one place — the folder you started Claude Code in — and git ignores it, so it never turns up in a diff. Your `config.json` stays visible, since that one is a choice worth sharing.

## License

MIT — see [LICENSE](./LICENSE).
