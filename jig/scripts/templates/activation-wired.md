<!-- jig:owned — generated from jig's activation template. Edit this file and
jig reports it as drifted rather than overwriting your edit. -->

# Commit hook wiring is configured

In short: git is set to run jig's checks before every commit in this clone, and a
finding stops the commit, as long as the hook can find node ("One thing that can
go wrong" below). To stop it, see "Turning it off".

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

Git is pointed at the hook jig wrote:

```
core.hooksPath = .jig/hooks
```

When Git invokes the hook and node is available, it runs
`.jig/checks/run.mjs` first. A driver finding stops the commit and prints what
it found.

## What this cost you

`core.hooksPath` moves **every** hook, not just `pre-commit`. Anything that was
sitting in `.git/hooks` no longer runs.

It applies to your clone only. A teammate who wants the same thing asks
jig to wire the commit lane in theirs.

## Turning it off

```sh
git config --unset core.hooksPath
```

Or ask jig to revert, which puts the setting back exactly as it was
along with everything else jig wrote.

## One thing that can go wrong

A git hook does not read your shell's startup files. If node reaches your
terminal through fnm, nvm, volta, or asdf, the hook may not find node at all.

The hook jig wrote lets the commit through when it cannot find node and
reports that its checks were skipped. That commit has no coverage from this
hook. Restore node on the hook's PATH or give node an absolute path; inspect
CI separately before relying on it.

## Running the checks by hand

Any time, commit or no commit:

```sh
node .jig/checks/run.mjs
```

It exits 0 when it finds nothing and 1 when it finds something. It writes no
files and changes nothing.
