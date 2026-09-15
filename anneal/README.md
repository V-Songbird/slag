<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="anneal" width="240" />
  </picture>
  <h1>anneal</h1>
  <p><strong>Claude learns your repo from scratch every session. anneal moves the furniture so it stops walking into the same walls.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — Every session, Claude re-learns your project by searching it: which of the four `utils` files is the real one, where the test command lives, why three files share one name. anneal finds those snags, proposes a cleaner layout you approve, and moves things one checked commit at a time.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise — it can change shape or vanish without a migration path. If it breaks your session, that's the deal you took.

## What is this?

Claude doesn't browse your project the way you do. It searches, opens files and runs commands, and each session starts with no memory of the last one. A folder called `helpers`, a stack of files all named `index`, or a test command nobody wrote down means more searching, more reading and more guessing. Every single session.

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

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/slag
/plugin install anneal@slag
```

Takes effect next session. Nothing happens until you ask for it.

## What you can do

| You want to… | Command |
| --- | --- |
| See what slows Claude down here, without changing anything | `/anneal:anneal audit` |
| Audit, plan and migrate, approving each step | `/anneal:anneal` |

> [!IMPORTANT]
> anneal won't start a migration on uncommitted changes, and it works on a new branch. The branch you were on stays exactly as it was.

## Under the hood

A scanning script that reads and never writes, a read-only helper that proposes the layout, and the instructions that tie them together — it's all in the plugin's files. Pairs naturally with [jig](https://github.com/V-Songbird/slag/tree/main/jig): once the repo is in shape, jig can set up checks for the mistakes you don't want back.

## Good to know

- The scan is a heuristic. A flagged `index` file may be exactly what your framework expects, which is why nothing moves without your say.
- Moving files collides with branches other people have open. Migrate when few are.
- anneal points out code that builds names at runtime, but never rewrites it. That call stays with you.

## License

MIT — see [LICENSE](./LICENSE).
