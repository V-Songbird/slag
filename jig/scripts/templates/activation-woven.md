<!-- jig:owned — generated from jig's activation template. Edit this file and
jig reports it as drifted rather than overwriting your edit. -->

# Commit-time checks are running

**Nothing here is a task.** The checks run on this machine every time you
commit, and they run in CI too. This file says what is running and how to turn
it off again.

jig added one line to the pre-commit hook you already had. Your hook still
runs, and it now runs `.jig/checks/run.mjs` as well. A finding stops the commit
and prints what it found.

jig did not touch `core.hooksPath`. Repointing git would have switched your own
hook off, which is why the line went into your hook instead.

## Turning it off

Remove jig's line from your pre-commit hook. It is the one that runs
`.jig/checks/run.mjs`, and it carries jig's marker comment so it is easy to
find.

Or `jig revert`, which takes the line back out along with everything else jig
wrote. Your hook is restored byte for byte from the copy jig kept before it
wrote anything.

## One thing that can go wrong

A git hook does not read your shell's startup files. If node reaches your
terminal through fnm, nvm, volta, or asdf, the hook may not find node at all.
Your hook is yours, so this one is worth checking: give node an absolute path,
or let the commit through when node cannot be found. CI still catches the
problem either way.

## Running the checks by hand

Any time, commit or no commit:

```sh
node .jig/checks/run.mjs
```

It exits 0 when it finds nothing and 1 when it finds something. It writes no
files and changes nothing.
