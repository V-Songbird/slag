<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="jig" width="240" />
  </picture>
  <h1>jig</h1>
  <p><strong>Your repo keeps collecting the same mistakes. jig installs the guardrails that catch them — and shows each one working before it claims anything.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

> **TL;DR** — The focused test that mutes the suite, the swallowed error, the AI session that deletes a test to make CI green. jig interviews you, installs checks for the mistakes you actually hit, and proves each one live before calling anything covered. 4 of 4 planted mistakes caught, zero false alarms on the committed checks.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise — it can change shape or vanish without a migration path.

## What is this?

Every repo has a greatest-hits album of mistakes. Somebody pins the test suite to a single test and forgets to unpin it, so green runs stop meaning anything. An error gets caught and dropped on the floor. An AI session, cornered by a red test, deletes the test.

jig reads your repo and its git history, asks which of these you actually want guarded, and installs the guardrails — reviewed by you first, reversible to the byte, and demonstrated catching a planted violation before the word "covered" is used.

## Why you'd want it

- **It reads before it asks.** The scan and the history mining run first, so the interview never asks a question your repo already answers.
- **Checks that outlive the plugin.** The main guardrail is a small script committed to your repo. Any teammate, any CI, any machine with node runs it — no plugin, no account, no jig.
- **It watches the AI too.** Session guards see what an agent is about to do: the downloaded script piped into a shell, the force-push to main, the test file on its way out.
- **Blocking is earned, never assumed.** Every guard starts by observing — recording what it *would* have stopped. Only after ten clean sessions with zero false alarms can you arm one, and then it really blocks, with a reason, an alternative, and the way to override.
- **One command undoes everything.** Every write is journaled with the original bytes — arming included. Revert puts your repo back exactly as it was.

## How it works

| Moment | What happens |
| --- | --- |
| You run `/jig:jig` | It scans the repo, mines the git history, and shows what it found — then asks the two things it can't read |
| You pick what to guard | A plan lays out who is covered for each mistake — you, your CI, an agent session — and says honestly where nobody is |
| You approve | Files land under `.jig/` and one CI workflow, nowhere else, every write journaled |
| The install closes | Each guard is shown catching a planted violation, live — without the demonstration, jig won't claim you're covered |
| A session slips later | The guard writes down what it would have blocked and lets the call through |
| A guard earns its record | Ten clean sessions, no false alarms — `/jig:review` offers to arm it, and armed means blocked |
| A guard cries wolf | Mark the false alarm in review — the guard drops back to observing and its clock resets |
| You want out | One command reverts every byte |

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
| See what the guards caught, arm a proven one | `/jig:review` |
| Call out a false alarm | `/jig:review` — "that warning was wrong" |

## Benchmarks

Measured by installing jig into a seeded project: one planted violation and two engineered near-misses per check, every catcher run against every case.

| What | Score |
| --- | --- |
| Planted mistakes caught | **4 of 4** |
| False alarms, committed checks | **0 of 8** |
| False alarms, session guards | 1 of 8 |

> [!NOTE]
> The one false alarm is disclosed, not hidden: a download-and-run command quoted inside an `echo` — printed, never executed — fools the session guard that reads commands. That check is labeled a heuristic for exactly this reason, and a heuristic needs a much longer clean record before it may ever block.

The suite that produces these numbers ships in the repo and reruns on every change.

## Under the hood

One engine that journals every write, a committed check script that owes jig nothing, and two observe-only session guards — the exact mechanics are all in the plugin's files.

## Good to know

- Guards start observing and stay that way until you arm them in `/jig:review`. Arming is offered only once the evidence is in, a quick-start install can never arm, and a recorded false alarm pulls an armed guard straight back to observe.
- jig writes only under `.jig/` and `.github/workflows/`. The pre-commit hookup is printed as a proposal — and if your hook file is committed to the repo, jig can weave the one line in for you, item-approved, reversibly.
- If something else already watches the same events in your repo, jig says so and leaves that slot alone. The committed checks and the CI workflow cover you regardless.
- Kill switch: create a file named `.jig/off` and every guard goes silent.

## License

MIT — see [LICENSE](./LICENSE).
