---
name: proof
description: >-
  Runs a paired A/B measurement of an agent-config change — a rule, a skill,
  a CLAUDE.md edit — running the same tasks with and without the change, many
  times over, and reports whether behavior actually moved: a lift, a
  bootstrap confidence interval, and a four-way verdict (helped / hurt / no
  effect / not enough signal). Also monitors a saved behavior for drift over
  time: a fingerprint records the behavior as a distribution, and a re-check
  flags drift only when the fresh rate falls outside the saved interval. Do
  NOT use this to write a rule or judge how clearly it's worded — that's a
  different job; proof only measures whether a change moved behavior, never
  how well it's phrased.
when_to_use: >-
  Trigger when the user asks things like "did my CLAUDE.md change actually
  help", "measure whether this rule works", "A/B test my agent config", "is
  this skill worth its tokens", "did that edit change anything", "prove this
  rule change works", "is this config change worth keeping", "watch this
  skill for drift", "fingerprint this behavior", or "did the Claude update
  change how my config behaves".
argument-hint: "[spec file or repo path]"
allowed-tools: Bash, Read, Write, Edit, Glob
---

# proof

Every command is `node "${CLAUDE_PLUGIN_ROOT}/bin/proof.js" <harvest|lint|run|watch> ...`
— there is no other entry point and nothing is on PATH. For a measurement,
work through the verbs in order: `harvest` (optional) → `lint` (always,
before `run`) → `run`. For drift monitoring, see the watch section below.

## 1. Harvest — optional, when there's no task set yet

```
node "${CLAUDE_PLUGIN_ROOT}/bin/proof.js" harvest --repo <dir> [--out <spec.json>] [--limit N]
```

Mines the repo's own revert / bug-fix commits into candidate tasks. Harvested
tasks are candidates with provisional assertions only — before linting or
running, fill in the spec's `fixture`, the two `arms` (config absent vs.
present), and real assertions. If the user already has a spec file, skip this
step.

## 2. Lint — blocking, always before a spend

```
node "${CLAUDE_PLUGIN_ROOT}/bin/proof.js" lint --spec <file.json>
```

Exit 0 means the task set is runnable; exit 1 means it's too flimsy to
measure — fix the reported errors and re-lint before touching `run`. `run`
re-lints internally and refuses to spend on a failing set, but lint first so
a bad spec fails fast without going near the cost estimate.

## 3. Run — costs money; the estimate-and-confirm gate is not optional

```
node "${CLAUDE_PLUGIN_ROOT}/bin/proof.js" run --spec <file.json> [--reps N] [--seed N]
    [--model M] [--max-budget-usd N] [--out <dir>] [--resume] [--keep]
    [--concurrency N] [--limit N] [--rubric] [--json]
```

`run` lints, prints a tier note, then prints a cost estimate and blocks on a
`y/N` prompt on stdin before spending anything — never invoke it with `--yes`
on the first attempt. Preview the estimate without triggering a real spend by
answering "no" for the user:

```
echo n | node "${CLAUDE_PLUGIN_ROOT}/bin/proof.js" run --spec <file.json> [flags]
```

This prints the lint result, the tier note, and the cost estimate, then exits
having spent nothing. Relay that estimate to the user verbatim and wait for
their explicit go-ahead in chat. Only once they say yes, rerun the same
command with `--yes` added so it runs for real without waiting on stdin
(stdin isn't interactively available to you either way).

## 4. Report — relay disclosure and null explanations as printed

`run` finishes by printing the verdict table, a representativeness
disclosure line, and — for any non-positive verdict — a named explanation
(tier saturation, below the detection floor, or genuinely inert) with a
suggested next action. Show these to the user as printed, not paraphrased or
summarized — the wording is calibrated to avoid overclaiming what a screen
like this can support. `--json` is available if the user wants the raw
analysis object instead of the formatted report; the disclosure and
explanations are still on it as fields.

## 5. Watch — drift monitoring on a saved fingerprint

`watch` treats a behavior as a fingerprint: the same probe run M times gives
a firing/pass rate with a bootstrap CI, keyed to `(agent, model, probe)`. It
flags drift only when a fresh re-check falls outside that saved interval, so
run-to-run noise never cries wolf.

```
node "${CLAUDE_PLUGIN_ROOT}/bin/proof.js" watch save --spec <probe.json>
node "${CLAUDE_PLUGIN_ROOT}/bin/proof.js" watch check --spec <probe.json>
node "${CLAUDE_PLUGIN_ROOT}/bin/proof.js" watch calibrate --spec <probe.json> --rounds K
```

A probe spec is an ordinary spec with a single arm (the behavior to
fingerprint) and a deterministic assertion. `save` records the baseline;
`check` re-runs cheaply and reports drift plus the measured false-alarm rate
at that sample size, exiting 3 on drift so it can gate a pipeline;
`calibrate` re-checks an unchanged fingerprint repeatedly and reports how
often it falsely flags. `save` and `calibrate` spend API budget — the same
estimate-and-confirm discipline as `run` applies, including the `echo n |`
preview. A SessionStart hook nags once, silently otherwise, when a saved
fingerprint predates the current Claude Code version or model — the signal
to re-check.
