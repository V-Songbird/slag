<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="jetbrains-router" width="240" />
  </picture>
  <h1>jetbrains-router</h1>
  <p><strong>Makes Claude work through your JetBrains IDE — live error detection, reads that see unsaved changes, searches that skip the junk.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — Your JetBrains IDE already knows where the errors are and what you haven't saved. jetbrains-router routes Claude's reads, searches, and edits through the IDE while it's running — and steps aside completely when it isn't.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise; it can change shape or disappear without a migration path. If it breaks your session, that's the deal you took.

## What is this?

Your JetBrains IDE already knows more about your project than Claude does — the changes you haven't saved yet, where the errors are, and which files are just build clutter. jetbrains-router lets Claude tap into all of that. Ask "does this file have errors?" and you get the IDE's answer instantly, instead of waiting on a full build.

## Why you'd want it

- **Instant error checks.** Claude sees the same red squiggles you do — no slow build just to find out what's broken.
- **No stale reads.** Claude looks at what's in your editor right now, including edits you haven't saved.
- **Cleaner searches.** Searches skip `node_modules`, build output, and ignored files — less noise, lower cost.
- **Nothing to set up.** It figures out which IDE you're running and just uses it. When no IDE is open, everything works exactly as before.

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/slag
/plugin install jetbrains-router
```

One requirement it can't handle for you: a JetBrains IDE — WebStorm, IntelliJ IDEA, Rider, PyCharm, and the rest all work — running version 2025.2 or newer, with its MCP Server switched on (Settings → Tools → MCP Server) and connected to Claude Code. With that in place, it starts working the moment the IDE is open.

## What you can do

| You want to… | Command |
| --- | --- |
| See whether it's active and which IDE it's talking to | `/jetbrains-router:status` |
| Read the behind-the-scenes routing reference Claude follows | `/jetbrains-router:router` |

## Under the hood

A routing reference Claude follows and a quiet check that finds your running IDE — all there to read in the plugin's files.

## Good to know

- It works best in the IDE's home language — Kotlin and Java shine in IntelliJ IDEA, C# in Rider. In other IDEs, error checks for those files may come up empty, and Claude simply falls back to a plain text search.
- If your IDE was launched in an unusual way, it might not be detected — in that case routing just stays off and nothing breaks.

## License

MIT — see [LICENSE](./LICENSE).
