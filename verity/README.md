<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="verity" width="240" />
  </picture>
  <h1>verity</h1>
  <p><strong>Stops Claude from guessing about Claude Code. Makes it look up the real documentation instead.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — Ask Claude how Claude Code works and it may answer from memory that's months out of date. verity makes it fetch the current official docs and answer from what they say today — with a link to the exact page it read.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise; it can change shape or disappear without a migration path. If it breaks your session, that's the deal you took.

## What is this?

Claude is trained on a snapshot of the internet, and that snapshot ages — while Claude Code keeps shipping new features. So when you ask "does Claude Code support X?" or "what does this setting do?", Claude might answer from memory that's months out of date.

verity fixes that. When a question about Claude Code comes up, Claude fetches the **current official docs** on demand, reads them, and answers from what they actually say today — with a link to the exact page, so you can check for yourself.

## Why you'd want it

- **Answers you can trust.** Every answer ends with a link to the page it came from.
- **Always current.** The docs are fetched live, the moment you ask — never a stale copy.
- **Covers the hidden stuff too.** Some of what runs inside a Claude Code session isn't in the public docs at all. verity bundles its own reference for those corners, so even the undocumented parts get real answers.
- **Zero setup.** No configuration, no accounts, nothing to maintain.

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/slag
/plugin install verity@slag
```

That's it — nothing to configure.

## What you can do

Mostly, you don't do anything — Claude reaches for the docs on its own whenever a Claude Code question comes up, from "what are the valid hook events?" to "does Claude Code support scheduled tasks?".

| You want to… | Command |
| --- | --- |
| Force a doc-grounded answer right now | `/verity:ground-truth` |

## Under the hood

One skill that fetches the live docs, plus the bundled reference for the undocumented corners — all there to read in the plugin's files.

## Good to know

- Live doc lookups need an internet connection — no connection, no fresh fetch.
- The bundled reference for hidden tools is a snapshot. If a newer Claude Code version adds tools it doesn't list, Claude tells you so instead of guessing.

## License

MIT — see [LICENSE](./LICENSE).
