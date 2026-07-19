<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="forge" width="240" />
  </picture>
  <h1>forge</h1>
  <p><strong>Stop discovering architectural problems in code review. Surface them before implementation starts.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — Big changes fail on the thing nobody checked first. forge studies your actual project, drafts a plan that cites real files and lines, then tries hard to break its own plan — all before a single line of code is written.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise; it can change shape or disappear without a migration path. If it breaks your session, that's the deal you took.

## What is this?

When you ask Claude to build something big, the risky part isn't the typing — it's what nobody checked first: a hidden connection between two parts of your project, an assumption that turns out wrong, a change that quietly breaks something three folders away. Those problems usually surface after the code is written, when they cost the most to fix.

forge flips the order. You describe what you want, forge studies your actual project and writes a plan, and then it tries hard to break its own plan — all before you approve a single edit.

## Why you'd want it

- **Problems surface in minutes, not after a week.** Missed connections and wrong assumptions get caught up front, while they're still cheap.
- **Nothing happens without your sign-off.** You see the plan and approve it before any code is written — redirect, scope down, or cancel first.
- **Every claim points at real code.** The plan cites exact files and lines from your project, not hand-waving.
- **It scales to the job.** Small change? `/forge lite` skips the heavy work. High-stakes change? `/forge deep` adds an extra layer of checking.

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/slag
/plugin install forge
```

It's active from your next session — nothing to configure. To use it, type `/forge`, describe the feature in plain words, and answer the approval question at the end. forge handles the rest.

## What you can do

| You want to… | Command |
| --- | --- |
| Plan a normal feature or change | `/forge` |
| Get a quick plan for a small, bounded change | `/forge lite` |
| Do an extra-thorough review for something high-stakes | `/forge deep` |

`/forge` is the only entry point you need — just describe what you want to build after running it.

## Under the hood

forge sends a small team of specialists at your plan from different angles, then lets a critic try to break it before you ever see it — all there to read in the plugin's files.

## License

MIT — see [LICENSE](./LICENSE).
