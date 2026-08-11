# The efficacy fixture

A miniature Node project carrying **one seeded violation and two near-miss
negatives** for each of jig's four installable classes — twelve cases in all.
`jig/tests/efficacy.test.js` copies this directory into a throwaway git
repository, installs jig over the top, and runs every catcher against every
case. The number it prints is jig's benchmark.

Nothing in here is ever executed. `jig/tests/*.test.js` is a non-recursive
glob, so the `.test.js` files below are three directories out of its reach.

## The cases

| Class | Medium | Violation | Negatives |
| --- | --- | --- | --- |
| `silent-catch` | source files | `src/config.js` | `src/cache.js`, `src/render.js` |
| `focused-or-skipped-test` | source files | `test/config.test.js` | `test/cache.test.js`, `test/render.test.js` |
| `pipe-to-shell` | command lines | `commands/violation.txt` | `commands/near-miss-echoed-string.txt`, `commands/near-miss-scratch-branch.txt` |
| `test-file-deletion` | staged paths | `test/legacy.test.js` | `docs/testing.md`, `tests-archive/README.md` |

Each class is scored through the medium the catalogue declares for it. A class
whose fixtures are command lines is measured by the guard that sees commands,
never by planting a shell script the class would never appear in.

## The comment-only catch, decided

A catch whose body holds nothing but a comment **counts as a catch**, not as a
false positive. `src/config.js` carries one on purpose:

```js
} catch (err) {
  // the cache is optional
}
```

The comment runs no code. The error stops there and nothing downstream can tell
that anything went wrong — which is the whole of what the class names. That an
author left a note saying they meant it makes the swallow *documented*, not
*handled*.

This is a real decision with a real cost. jig's own check driver reports 47 of
these against slag's source, every one deliberate. The answer to that is the v1
clamp: the class ships observe-only, so a report is a line in the ledger and
never a refusal. The alternative — treating a comment as a handler — would let
any swallowed error be waved through by typing a sentence above it, and the
detector would stop meaning anything.

## What the fixture measures that is not the score

`src/render.js` and `test/cache.test.js` hold the violating shapes only inside
comments, strings and regular expressions. The check driver and the PostToolUse
edit guard both blank all three before matching and report nothing — the
fixture is what holds the two implementations to the same reading, and
`efficacy.test.js` fails the moment they drift apart.

`commands/near-miss-echoed-string.txt` is the remaining disclosed limit: a
`curl … | sh` inside an `echo`, printed and never run. It fires the bash
guard. The same miss is already pinned for the check driver in
`jig/tests/checks.test.js`, and the catalogue labels the detector heuristic
because of it. It is here, rather than swapped for an easier negative, because
a benchmark that routes around its own known limit is not a benchmark.
