<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="brink" width="240" />
  </picture>
  <h1>brink</h1>
  <p><strong>Your context fills up and the autopilot throws away the wrong half. brink catches the edge and lets you compact on purpose.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — Long sessions run out of room, and when they do the automatic cleanup keeps whatever it feels like — often not the thing you were mid-fight with. brink watches how full the window is getting and, right at the edge, hands you a one-line command to compact on your terms. Keep the bug, drop the noise.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise — it can change shape or vanish without a migration path. If it breaks your session, that's the deal you took.

## What is this?

Every long Claude Code session eventually runs low on room. When it does, it compacts — throws away old conversation to make space — and the automatic version summarizes blind. It keeps what a generic summary keeps, which might be your old file listings and not the failing test you've been chasing for an hour.

brink watches how full the window is getting. Once you're near the edge it speaks up: here's the `/compact` command, and here's an instruction that keeps what actually matters right now.

## Why you'd want it

- **A heads-up before the cliff, not after.** It nudges while you can still choose — not once the good part is already gone.
- **Compaction with a plan.** It hands you a ready-made instruction, ranked: the task you're on now, the files in play, the decisions made, the errors still open. Recent work outranks old history.
- **Ignoring it doesn't make it go away.** Say nothing and it comes back a while later, with the new number.
- **Quiet the rest of the time.** Below the line it does nothing and costs you nothing.

## How it works

| Moment | What happens |
| --- | --- |
| Your context creeps toward full | brink is watching, and says nothing yet |
| You cross ~200k tokens | One message: run `/compact`, with an instruction worth pasting |
| Your client hides that message | Claude repeats it to you in its next reply, so it reaches you either way |
| You keep going instead | It speaks up again every 75k tokens you add |
| You compact and free up room | It resets — ready to warn again if you fill up again |

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/slag
/plugin install brink@slag
```

Takes effect next session. Nothing to configure — it starts watching on its own.

## Under the hood

One small hook that reads how full the session already is and speaks up at the edge — it's all in the plugin's files.

## Settings

Most people never touch these.

| Variable | What it does |
| --- | --- |
| `BRINK_THRESHOLD` | How much of the window gets used before brink first speaks up (default 200000) |
| `BRINK_REPEAT` | How many more tokens before it says it again (default 75000) |
| `BRINK_DISABLE` | Set to `1` and brink stays silent |

## Good to know

- brink reads the fill level from your session record, which updates each turn — so the nudge lands within a message of crossing the line, not to the exact word.
- The repeat is measured in tokens, not minutes — a quiet stretch that adds nothing to the window won't trigger another one.
- It only ever suggests. Whether and how you compact is entirely your call.
- The nudge goes out on two channels at once. On a client that renders both, you'll see it twice — better than a client that shows it nowhere.

## License

MIT — see [LICENSE](./LICENSE).
