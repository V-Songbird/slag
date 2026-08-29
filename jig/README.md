<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="jig" width="240" />
  </picture>
  <h1>jig</h1>
  <p><strong>Your repo keeps collecting the same mistakes. jig installs the guardrails that catch them — and shows each one working before it claims anything. Point it at an empty folder and it goes first, so the code written next lands into a harness that already works.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — The focused test that mutes the suite, the swallowed error, the AI session that deletes a test to make CI green. jig interviews you, sets up your linter, type checker, test runner and CI, writes checks for the mistakes you actually hit, and proves every one of them against a planted violation before calling anything covered. It works on a project that does not exist yet as readily as on one that does. Nothing is written or installed that you did not approve by name, and one command undoes all of it.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise — it can change shape or vanish without a migration path.

## What is this?

Every repo has a greatest-hits album of mistakes. Somebody pins the test suite to a single test and forgets to unpin it, so green runs stop meaning anything. An error gets caught and dropped on the floor. An AI session, cornered by a red test, deletes the test.

jig reads your repo and its git history, asks which of these you actually want guarded, and then sets the whole thing up — the tools, their configs, the CI, and checks written for your codebase. Reviewed by you first, reversible to the byte, and demonstrated catching a planted violation before the word "covered" is used.

Starting something new? Run it on the empty folder. jig writes the project file, installs the toolchain and lands the checks before there is a single line to guard — which is the cheapest moment to get all of it right, and the one where an AI session has the most to gain from a harness that already works.

## Why you'd want it

- **It reads before it asks.** The scan and the history mining run first, so the interview never asks a question your repo already answers.
- **It goes first on a new project.** No code yet is the normal case, not an edge case. jig writes the starter project file, sets up the toolchain and installs the checks, so the first thing anybody writes is already being checked. That covers Node, Python, Rust, Gradle, Maven and .NET. Go is the one exception — a module path is an identity only you can pick, so jig hands you the one command and picks up from there.
- **It sets up your real tooling.** Linter, formatter, type checker, test runner, CI. jig shows you the exact install command and the exact config it would write, then runs it once you say yes. A tool it cannot uninstall is a tool it refuses to install.
- **It speaks your language.** Editions ship for JavaScript and TypeScript, Python, Go, Rust, the JVM and .NET, each researched against that ecosystem's own tools and conventions.
- **Checks that outlive the plugin.** The main guardrail is a small script committed to your repo. Any teammate, any CI, any machine with node runs it — no plugin, no account, no jig.
- **Every check proves itself first.** A check ships with a violation sample and a near-miss sample. It has to fire on the first and stay silent on the second, and on every other check's near miss too. One that fails is discarded and reported, never quietly counted as coverage.
- **It finds the documents your sessions never read.** ADRs, scopes, roadmaps — jig checks whether anything actually points Claude at them, and can wire in one small pointer rule when nothing does.
- **It catches the two files that drifted apart.** The doc that stopped describing the module, the migration that never followed the schema. Name the two sets, and a commit that touches one and leaves the other alone is a finding. These read what you have staged, so they speak at commit time and report themselves skipped in CI rather than pretending to have looked.
- **It tells you what it put there, and why.** Ask any time and jig lists every guard, every committed check and every file it wrote — what each one watches, what it does when it fires, and the reason you approved it in the first place. It also says whether the checks are really running right now.
- **It watches the AI too.** Session guards see what an agent is about to do: the downloaded script piped into a shell, the force-push to main, the test file on its way out. A blocked call always shows the reason, an alternative, and the way to override.
- **One command undoes everything.** Every write is journaled with the original bytes, your manifest and lockfile included. Revert restores every file it touched, then hands you the one command your package manager needs to take the tool off disk.

## How it works

| Moment | What happens |
| --- | --- |
| You run `/jig:jig` | It scans the repo, mines the git history, and shows what it found — then asks the things it can't read |
| The folder is empty | It asks which language, writes the starter project file, and carries on. Nothing about the run changes |
| You pick what to guard | Describe a mistake in your own words. jig writes a check for it, plus the two samples that prove the check works |
| The mistake is two files drifting apart | Name both sets. The samples become a commit that should trip it and one that should not, and the proof runs the same way |
| jig proposes your toolchain | Each tool is one item carrying the exact install command, the config it would write, and the command that removes it again |
| You approve, item by item | Every path is named before it is written, and every write is journaled with the bytes that were there before |
| The install closes | Each check is shown catching a planted violation, live — without the demonstration, jig won't claim you're covered |
| The checks need connecting | jig offers to finish it. Say no and CI still catches everything; say yes and the same checks run the moment you commit |
| A check turns out unprovable | It is discarded and written to `.jig/discarded.json`, never counted as coverage |
| A proven guard sees a slip | It blocks, with a reason, an alternative and the override. Put it in observe instead if you'd rather it only watched |
| A guard cries wolf | Mark the false alarm in review — the guard drops back to observing |
| You come back a month later | One question: take the next thing, retire the dead, or refresh |
| You want out | One command puts every byte back, and hands you the command that removes anything it installed |

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/slag
/plugin install jig@slag
```

Takes effect next session. Nothing to configure — the interview is the configuration.

## What you can do

| You want to… | Command |
| --- | --- |
| Set up guardrails, interview included | `/jig:jig` |
| Set them up with one review and no questions | `/jig:jig --quick` |
| Scaffold a new project and guard it from line one | `/jig:jig` in the empty folder |
| See what the guards caught, and which checks are actually running | `/jig:review` |
| Put a noisy guard back to watching | `/jig:review` |
| Call out a false alarm | `/jig:review` — "that warning was wrong" |
| See everything jig installed, and what each thing watches | `/jig:inventory` |
| Find out why a check is there at all | `/jig:inventory` |

## Benchmarks

Every check jig runs is measured the same way it is admitted: it must fire on its own planted violation and stay silent on a near miss built to look like one.

| What | Score |
| --- | --- |
| Checks jig runs, each passing its own pair | **122 of 122** |
| Mistake classes across the six editions | 141 |
| Cross-sample hits, disclosed | 8 |

> [!NOTE]
> The eight are disclosed, not hidden. Each is one check firing on a different check's near-miss sample — realistic code written to trap a different pattern, which sometimes contains a genuine instance of another. A check may declare an expected hit up front; what it may never do is fire on its own near miss, and none of them does.

The suite that produces these numbers ships in the repo and reruns on every change, and a check that cannot pass is discarded rather than shipped.

## Under the hood

One engine that journals every write, a committed check script that owes jig nothing, an installer that will not touch a tool it cannot remove again, and session guards that read the same checks — the exact mechanics are all in the plugin's files.

## Good to know

- A check that passed its pair blocks from the moment it installs, and says why, what to do instead, and how to override. Ask for observe instead and it only records. A recorded false alarm pulls a blocking guard back to observe.
- jig names every path before it writes it, and journals the bytes that were there first. That includes your manifest and lockfile when it installs a tool. Revert puts both back and shows you the uninstall command — it never runs a package manager behind your back.
- jig can finish the commit-time wiring for you, as one more approved item, and one revert puts it back. If you already have a commit hook, jig adds its line to yours rather than pointing git away from it. It never writes a file inside `.git/`, and it never reports the wiring as missing when it is already there. The note it leaves in `.jig/activation.md` is rewritten the moment the wiring lands, so nothing in your repo goes on asking you for something already done.
- If something else already watches the same events in your repo, jig says so and leaves that slot alone. The committed checks and the CI workflow cover you regardless.
- Several tools often share one config file — `pyproject.toml`, `.editorconfig`, `Cargo.toml`, `Directory.Build.props`, `build.gradle.kts`. jig writes that file once with every tool's settings in it, and tells you about any setting two tools disagreed on. Where the shared file is one it can't safely compose, or one you already own, it writes none of it and hands you the exact snippet instead.
- Rules are the exception, not the habit. The one jig writes points your sessions at the governance docs nothing referenced, under its own `jig-` name and a small hard byte cap — because every session pays to carry prose.
- Working with another AI tool too? On request jig keeps one clearly-fenced block in `AGENTS.md` pointing it at the same checks. Your own text in that file is never touched.
- Kill switch: create a file named `.jig/off` and every guard goes silent.

## License

MIT — see [LICENSE](./LICENSE).
