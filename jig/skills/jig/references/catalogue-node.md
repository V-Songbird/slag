# The error catalogue, Node edition

Companion to [`jig/scripts/catalogue.json`](../../../scripts/catalogue.json), which is the
machine-readable original. This file explains what the data means and what it does not claim.

**Verified on 2026-08-07.** Tool pins for everything asserted below:

| Tool | Pin | Used for |
| --- | --- | --- |
| Node | v22.22.2 | the check driver, the runner, `node --test` |
| `node:test` | bundled with Node 22 | the `.only(`/`.skip(`/`it.todo(` pattern set |
| git | any version with `--diff-filter` | the staged-deletion check |
| eslint | not installed in this repo | 0.3.0 levers only, declared and unexecuted |
| typescript | not installed in this repo | 0.3.0 levers only, declared and unexecuted |

Nothing in the eslint or typescript rows has been run. Those levers are recorded so the coverage
matrix can be honest about what a project *could* reach, and they are marked `availableAt`
`0.3.0-alpha` so no v1 code treats them as coverage.

## What a class row holds

```
{ id, title, axes, agentModes, severity, installableAtV1, enforcementGap,
  detectors: [{ actor, lever, runner, params, confidence }],
  fixtures, gapNotes, evidence: { tier, generation } }
```

The closed vocabularies live at the top of the file, so a reader never has to guess which values
are legal:

- **axes** — `human`, `agent`. A class can carry both. `agentModes` says how an agent produces it
  and is empty for human-only classes.
- **actors** — `human-editor`, `human-ci`, `claude-session`, `codex-session`. These are the matrix
  columns. No detector names `codex-session` yet, which is why the Codex column renders as gaps.
- **severity** — `hygiene` or `safety`.
- **confidence** — `deterministic` or `heuristic`, per detector, not per lever. A deterministic
  lever can carry a heuristic pattern, and several do.
- **levers** — a map, not a list, because each one declares `hostNeutral`, `probabilistic` and
  `availableAt`. The matrix and the plan floor read those three fields; nothing hardcodes a lever
  name.
- **evidence tiers** — `experiment-supported`, `documented`, `inherited`, `reasoned`.

## The floor, as data

The plan refuses any selected class that has no host-neutral deterministic lever unless the class
is explicitly stamped. `enforcementGap` is that stamp, and it is computed, not asserted: a class
is stamped `true` exactly when none of its detectors pairs a `hostNeutral` lever with
`deterministic` confidence. Fourteen of the twenty-two classes carry the stamp.

One installable class carries it too. `pipe-to-shell` is catchable only inside a Claude session at
v1 — nothing observes a human typing `curl … | sh` into their own terminal, and the check driver
sees only what was committed into a script or a workflow.

## The four installable classes

| Class | Deterministic catcher | What it still misses |
| --- | --- | --- |
| `focused-or-skipped-test` | check driver + CI, over `**/*.test.*` and `**/*.spec.*` | jest's `fdescribe`/`fit`, a `--grep` in a package script, a config-level `testNamePattern` |
| `silent-catch` | check driver + CI, empty catch body | a catch that logs and continues, which is the same defect and needs AST work |
| `pipe-to-shell` | none that is host-neutral | a human's own terminal; force-push detection needs the branch at evaluation time |
| `test-file-deletion` | check driver, `git diff --cached --diff-filter=D --name-only` | fires at commit time, never at deletion time, because PostToolUse never reports a deletion |

Each of the four ships one violation fixture and one near-miss fixture under
`jig/tests/fixtures/classes/<id>/`. The near-misses are the point: every line in them looks like
the defect and is not one. `--force-with-lease`, a `catch` inside a string literal, and a test
whose title contains the word "skips" are all in there because they are the false positives a
naive pattern produces on day one.

## Node-specific detection notes

- **Strip comments and strings before matching.** Every source-scanning detector sets
  `stripComments` and `stripStrings`. Without them the near-miss fixtures fail immediately.
  Regular-expression literals are not stripped, and no shipped pattern needs them to be.
- **Test-file globs are Node-flavoured.** `**/*.test.js`, `.mjs`, `.ts`, and `**/*.spec.js`,
  `.ts`, plus `**/tests/**` and `**/__tests__/**` for the deletion check. A project that names its
  tests differently needs the glob set widened during the interview.
- **Staged deletions are the only reliable deletion signal.** `git diff --cached
  --diff-filter=D --name-only` is exact. The `rm`/`git rm`/`Remove-Item` bash pattern beside it is
  labeled heuristic on purpose: it misses any deletion done another way, and it fires on a command
  that merely mentions a test path.
- **Every guard is clamped to observe for the whole 0.1.0 line.** A match produces a ledger line,
  never a block.

## Where these twenty-two classes came from

Fifteen carry a `human` axis and seven are agent-only. None is `experiment-supported`, and that is
the honest state of the evidence:

- **`inherited`** — the seven classes salvaged near-verbatim from iceberg's `anti-patterns.md`,
  the fifteen-shape junior-error catalogue that plugin left behind. Iceberg itself is gone; only
  the seven names recorded in the blindspot pass survived, and its catalogue had no evidence base
  either, so this tier means "carried forward", not "measured".
- **`reasoned`** — the rest, argued from `docs/research/jig-blindspot-pass.md` decision D9 and the
  implementation brief. No measurement stands behind any of them.

There is no data on *which* error classes matter most in real projects. The local research corpus
measured how to make a guardrail stick, never what to guard. The efficacy fixture at 0.1.0
measures whether the four installable detectors catch what they claim, which is a different
question and the only one currently answerable.

## Deliberately absent

No detector logic lives here — this entry is data only. Pattern evaluation belongs to the check
driver and the runner. No class installs a rule written in prose; there is no generated prose at
v1 at all.
