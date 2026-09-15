<!-- jig:owned — generated from jig's activation template. Edit this file and
jig reports it as drifted rather than overwriting your edit. -->

# Commit hook wiring is configured

The hook is configured to invoke jig's check driver. This file describes that
wiring and how to undo it; it does not establish that a check has run.

Only check-driver detectors in the installed modules run through the driver.
Session-only detectors do not gain commit or CI coverage from this wiring.
Optional tool verification runs here only when its entry in `.jig/verify.json`
names the `commit` lane.

CI coverage requires a configured workflow and checks or verification entries
that the workflow runs. A workflow file alone does not prove a run succeeded
or that a merge is blocked. Ask jig's inventory for the configured lanes and
jig's review for recorded runs.

jig added one line to the pre-commit hook you already had. When Git invokes
your hook and execution reaches that line with node available, it runs
`.jig/checks/run.mjs`. A driver finding stops the commit and prints what it
found.

jig did not touch `core.hooksPath`. Repointing git would have switched your own
hook off, which is why the line went into your hook instead.

## Turning it off

Remove jig's line from your pre-commit hook. It is the one that runs
`.jig/checks/run.mjs`, and it carries jig's marker comment so it is easy to
find.

Or ask jig to revert, which takes the line back out along with
everything else jig wrote. Your hook is restored byte for byte from the copy
jig kept before it wrote anything.

## One thing that can go wrong

A git hook does not read your shell's startup files. If node reaches your
terminal through fnm, nvm, volta, or asdf, the hook may not find node at all.
Check how your own hook handles a missing node executable, or give node an
absolute path. If the driver is skipped, that commit has no coverage from
jig's driver. Inspect CI separately before relying on it.

## Running the checks by hand

Any time, commit or no commit:

```sh
node .jig/checks/run.mjs
```

It exits 0 when it finds nothing and 1 when it finds something. It writes no
files and changes nothing.
