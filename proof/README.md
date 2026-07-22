<div align="center">
  <h1>proof</h1>
  <p><strong>You changed your CLAUDE.md. Did it change anything? proof runs the before and the after and tells you.</strong></p>
</div>

<p align="center">
    <a href="https://github.com/V-Songbird/slag/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT"/></a>
    <a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Claude_Code-E5582B" alt="Works with Claude Code"/></a>
</p>

> **TL;DR** — You tweaked a rule, a skill, a whole CLAUDE.md, and you *feel* like it helped. proof runs the same tasks with and without the change and measures the difference — a lift, a confidence interval, a verdict. On changes with a genuinely large effect it called the direction right 10 out of 10 times, never flipped a confirmed sign, at a small fraction of what a full evaluation costs.

---

> [!NOTE]
> Experimental, and staying that way. No support, no stability promise; it can change shape or disappear without a migration path. If it breaks your session, that's the deal you took.

## What is this?

You edit your config to make Claude behave better. Then you have no idea if it worked — the model is different every run, so "it seems better now" is a vibe, not evidence. proof turns the vibe into a number. It runs your tasks twice — once with your change, once without — enough times to tell a real difference from run-to-run noise, and hands you a verdict: it helped, it hurt, it did nothing, or there isn't enough signal to say yet.

It is a screen, not a scoreboard. proof is good at one thing — telling you the *direction* of a change that has a real, sizeable effect — and it is honest about the changes it can't resolve instead of guessing.

## Why you'd want it

- **"Should work" becomes "did work."** A change either moved behavior across your tasks or it didn't, and proof shows you which, with the uncertainty attached.
- **Noise doesn't fool you.** It runs each side many times on identical setups, so a lucky run can't masquerade as an improvement.
- **A dead rule gets caught.** A config that changes nothing is context you're paying for every session; proof flags it so you can cut it.
- **No surprise bills.** Every run shows a cost estimate first and waits for your yes. The default is coffee money.

## How it works

| Moment | What happens |
| --- | --- |
| `harvest` | Mines your repo's own past fixes into candidate tasks — real failures beat invented ones |
| `lint` | Refuses a task set that's too flimsy to measure before a cent is spent |
| `run` | Shows the cost, waits for your yes, then runs both sides many times over |
| The verdict | One table: lift, a confidence interval, and a plain-English call |

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/slag
/plugin install proof@slag
```

Running [assay](../assay) too? Good instinct — assay grades whether a rule is *written* clearly; proof measures whether it actually *changed* anything.

## What you can do

The whole loop, from a repo to a verdict:

| You want to… | Command |
| --- | --- |
| Mine tasks from your repo's own fix history | `proof harvest --repo . --out my-change.json` |
| Check whether a task set is worth measuring | `proof lint --spec my-change.json` |
| Run both arms and get a verdict | `proof run --spec my-change.json` |

Fill in your two arms (the config present vs. absent) and real assertions in the spec, then `run`. It prints the cost estimate, waits for `y`, runs, and reports.

Each arm comes back as one of four calls: **CONFIRMED+** (behavior moved up; the interval clears zero), **CONFIRMED−** (behavior moved down), **NULL** (a tight interval around zero — a real "no effect," not a shrug), or **INCONCLUSIVE** (the interval's too wide to call — underpowered, not a null; add runs before you conclude anything).

## Under the hood

A paired runner over headless Claude Code on isolated checkouts, a bootstrap confidence interval, and a four-way verdict — all in the plugin's `lib/`, zero dependencies, read it if you want the mechanics. Pairs naturally with [assay](../assay): grade the rule's wording, then measure whether it earned its place.

## Good to know

- Any non-positive verdict gets diagnosed into a named cause instead of an unexplained "no effect": **tier saturation** (the baseline already succeeds every time, so there's no room to lift — common when asking about a rule on a big model, where the effect is real but invisible here; re-run on a smaller model), **below the detection floor** (a small effect this many runs can't separate from zero — add paired runs before deciding), or **genuinely inert** (the baseline had room to improve, the runs were enough, and the change did nothing — a delete candidate).
- proof ships on exactly one measured claim, from internal validation against held-out reference evaluations. On changes with a genuinely large effect, it agreed with the reference direction on **10 of 10** cells (100%), never once inverted a confirmed sign across all 17 cells, and produced **zero false positives** on the 6 true-null cells — at roughly **1/22 to 1/60** of the cost of a full evaluation. That's the whole of what it claims to do well: call a large, real effect the right direction, cheaply, without ever flipping a sign.
- It is not a general accuracy instrument — it's a sign-safe screen for *large* directional effects, and nothing more was measured. A small change reading as NULL or INCONCLUSIVE isn't evidence it's worthless; that's a measured detection floor, not a verdict on the lever itself.
- A verdict covers only the tasks it ran — directional evidence about *those* behaviors, not a grade for your config overall. It isn't a leaderboard either: it answers "did this specific change move these specific tasks," and stops there.

## License

MIT — see [LICENSE](./LICENSE).
