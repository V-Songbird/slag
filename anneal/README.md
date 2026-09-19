<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="anneal" width="240" />
  </picture>
  <h1>anneal</h1>
  <p><strong>Your agent learns your repo from scratch every session. anneal moves the furniture so it stops walking into the same walls.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code) [![Codex](https://img.shields.io/badge/Codex-000000)](https://developers.openai.com/codex) [![Antigravity](https://img.shields.io/badge/Antigravity-4285F4)](https://antigravity.google)

> **TL;DR** — Every session, your agent re-learns your project by searching it: which of the four `utils` files is the real one, where the test command lives, why three files share one name. anneal finds those snags, proposes a cleaner layout you approve, and moves things one checked commit at a time.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise — it can change shape or vanish without a migration path. If it breaks your session, that's the deal you took.

## What is this?

An agent doesn't browse your project the way you do. It searches, opens files and runs commands, and each session starts with no memory of the last one. A folder called `helpers`, a stack of files all named `index`, or a test command nobody wrote down means more searching, more reading and more guessing. Every single session.

anneal scans your repository for exactly those snags and fixes the ones you pick. Your project's own checks run before the first change and after every step, and each step lands as its own commit on its own branch.

## Why you'd want it

- **Fewer wrong turns.** Unique names, feature folders and a short map file give every search fewer places to be wrong.
- **You see the plan first.** The findings and the proposed layout arrive before a single file moves, and you choose the steps.
- **Nothing breaks quietly.** A step that breaks your checks gets fixed or set aside before the next one starts.
- **Easy to walk back.** One commit per step, on a branch of its own.

## How it works

| Moment | What happens |
| --- | --- |
| You ask for an audit | A script scans names, layout, the map file, version files and check commands, and changes nothing |
| Before any change | Your project's checks run once, so problems that were already there never get blamed on anneal |
| The layout question | A read-only helper proposes which files belong together; you approve, trim or skip it |
| Each approved step | One change, the checks again, one commit — or the step is set aside and you hear why |
| The end | The scan runs again, so you see what changed next to what didn't |

## Install

**Claude Code**

```
/plugin marketplace add V-Songbird/slag
/plugin install anneal@slag
```

Takes effect next session.

**Codex** — add this repository as a marketplace, then install `anneal` from it.

**Antigravity** — put the plugin directory at `~/.gemini/config/plugins/anneal/` for every project, or `.agents/plugins/anneal/` for one workspace.

Nothing happens until you ask for it.

## What you can do

| You want to… | Command |
| --- | --- |
| See what slows an agent down here, without changing anything | `/anneal:anneal audit`, or `$anneal audit` |
| Audit, plan and migrate, approving each step | `/anneal:anneal`, or `$anneal` |

> [!IMPORTANT]
> anneal won't start a migration on uncommitted changes, and it works on a new branch. The branch you were on stays exactly as it was.

## Under the hood

A scanning script that reads and never writes, a read-only helper that proposes the layout, a small fixer that re-points relative imports after a move, and the instructions that tie them together — it's all in the plugin's files. While a migration branch is checked out, a guard refuses `git reset --hard`, `git clean -f`, `git push --force` and `git branch -D`, so a stray command can't throw away the commits it just made; on every other branch it stays out of the way. Pairs naturally with [jig](https://github.com/V-Songbird/slag/tree/main/jig): once the repo is in shape, jig can set up checks for the mistakes you don't want back.

## Good to know

- The scan is a heuristic. A flagged `index` file may be exactly what your framework expects, which is why nothing moves without your say.
- The import fixer handles relative `import`, `export … from`, `import()` and `require()` in the JavaScript and TypeScript family. Path aliases, other languages, config files and docs are found by searching, and you see them in the step.
- Moving files collides with branches other people have open. Migrate when few are.
- anneal points out code that builds names at runtime, but never rewrites it. That call stays with you.

## License

MIT — see [LICENSE](./LICENSE).
