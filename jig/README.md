<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="jig" width="240" />
  </picture>
  <h1>jig</h1>
  <p><strong>Your repo keeps making the same mistakes. jig installs the guardrails that catch the next one.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — The test marked to run alone, the swallowed error, the AI session that deletes a failing test to go green. jig asks what to guard, sets up the tools and CI, and proves every check on a planted mistake first. Nothing lands unapproved; one command undoes it all.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise — it can change shape or vanish without a migration path.

## What is this?

Every repo has a greatest-hits album of mistakes, and AI sessions have learned to cover the old classics. jig reads your repo and its git history, asks which of those mistakes you want guarded, then sets up the linter, the tests, the CI and checks written for your codebase. It speaks JavaScript and TypeScript, Python, Go, Rust, the JVM and .NET, and on an empty folder it goes first, so the first line anybody writes is already checked.

## Why you'd want it

- **You talk to it like a person.** Ask what it checks, what it caught or to undo it, and if you're new to coding, setup shrinks to two or three questions with the safe choice recommended each time.
- **"Covered" means caught.** A check counts only after it's shown catching a planted mistake, and one that can't is thrown out instead of padding the numbers.
- **It watches the AI while it works.** The deleted test, the force-push to main and the downloaded script piped into a shell get stopped as the AI reaches for them, not found later in CI.
- **Leaving takes one command.** Revert puts back every file jig touched, down to the byte, and hands you the one uninstall command your package manager needs.

## How it works

| Moment | What happens |
| --- | --- |
| **Understand your needs** | jig reads the repo and its history, then asks only what's still yours to decide, including which checks: the essential bundle, the wider one, or one at a time. |
| **Review the changes** | The plan opens with a short summary in plain words, then lists every change by its title, grouped by what it's for, and you approve each one by name with nothing pre-ticked. |
| **Apply and check** | Only what you approved lands, each check is shown catching a planted mistake, and anything jig couldn't verify gets called unverified. |
| You said yes to checking your commits | The commit hook is connected in the same install, approved by name like everything else. |
| An AI session reaches for a risky move | The guard blocks it and says why, what to do instead and how to override, or only watches if you picked observe. |
| You come back a month later | Ask what it caught and the short answer comes first: what fired, where the checks run, what needs attention. |

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/slag
/plugin install jig@slag
```

Takes effect next session. Nothing to configure — the interview is the configuration. On Codex, install jig from this repository's Codex marketplace, `Slag · Codex`, and talk to it through `$jig`.

## What you can do

| You want to… | Command |
| --- | --- |
| Set up guardrails, in a repo or an empty folder | `/jig:jig` |
| Set up guardrails when you're new to coding | `/jig:jig`, then pick `New to coding, using AI` |
| Skip the questions and review one plan — jig picks the essential bundle, from your own history where it can, and labels every value it assumed | `/jig:jig --quick` |
| Know what jig checks here, and what needs attention | `/jig:jig what are you checking?` |
| Find out why a file is there | `/jig:jig why is .jig/activation.md here?` |
| See what the guards caught | `/jig:jig what did you catch?` |
| Call out a false alarm | `/jig:jig that alert was wrong`, naming the guard |
| Catch one more mistake in your own words, like a doc that stopped matching its code | `/jig:jig help me catch skipped tests` |
| Move an existing jig project between Claude Code and Codex | `/jig:jig migrate --host codex`, or `--host claude` |
| Take it all back out | `/jig:jig undo everything` |
| Go straight to the full report, or the guards' record | `/jig:inventory full`, `/jig:review` |
| Do any of this on Codex | `$jig` in the same words; `$inventory` and `$review` work directly |

A question only reads: it never installs, repairs or migrates on the way, and if a request could mean two things, jig asks which first.

## Benchmarks

Every check jig runs catches its own planted mistake, and none of them fires on the lookalike built to fool it.

| What | Score |
| --- | --- |
| Checks jig runs, each passing its own pair | **147 of 147** |
| Patterns those checks name, each proved on its own | **256 of 256** |
| Mistake classes across the six editions | 165 |
| Cross-sample hits, disclosed | 8 |

> [!NOTE]
> A cross-sample hit is one check firing on the lookalike written for a different check, which sometimes really does contain that other mistake. They're counted here, not hidden.

How we tested: the suite behind these numbers ships in the repo and reruns on every change.

## Under the hood

One engine that keeps the original bytes of every file it writes, a committed check script that owes jig nothing, an installer that won't touch a tool it can't remove again, and session guards that read the same checks — the exact mechanics are in the plugin's files.

## Good to know

- Commit what jig puts in `.jig/`, so a teammate who clones the repo gets the same checks and guards; the `.jig/.gitignore` jig writes already leaves out what's derived or belongs to your machine.
- jig doesn't overwrite what's already yours: an existing commit hook gets jig's line added, a shared config file you own gets a snippet to paste instead, and your own text in `AGENTS.md` stays untouched.
- Kill switch: create a file named `.jig/off` and every guard goes silent. It silences the session guards; the committed checks, the commit hook and the CI workflow never read it and go on running.

## License

MIT — see [LICENSE](./LICENSE).
