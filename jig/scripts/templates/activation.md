<!-- jig:owned — generated from jig's activation template. Edit this file and
jig reports it as drifted rather than overwriting your edit. -->

# Catching mistakes at commit time

In short: jig's checks do not run when you commit on this machine yet. To turn
that on, say `wire the commit lane` to jig in your AI session. The rest of this
file explains what that does, and how to do it by hand.

Git can invoke jig's check driver on your machine at the moment you commit.
This file explains how to configure that invocation and which checks it can run.

Only check-driver detectors in the installed modules run through the driver.
Session-only detectors do not gain commit or CI coverage from this wiring.
Optional tool verification runs here only when its entry in `.jig/verify.json`
names the `commit` lane.

CI coverage requires a configured workflow and checks or verification entries
that the workflow runs. A workflow file alone does not prove a run succeeded
or that a merge is blocked. Ask jig's inventory for the configured lanes and
jig's review for recorded runs.

Git can run a script before every commit. jig wrote one for you at
`.jig/hooks/pre-commit`, and git will not use it until it is told to. jig can
do that for you, as a change you approve like any other.

## Let jig do it

Ask jig for it, in whichever agent session runs it here:

```
wire the commit lane
```

You approve it by name, and jig's own revert puts the setting back exactly as
it was. jig writes no file inside `.git/`; it sets one git setting, the same one
you would set by hand below.

If you already have a pre-commit hook of your own, this refuses rather than
hiding it, and offers to add jig's line to your hook instead.

## Or do it by hand

One command, run once in this repository:

```sh
git config core.hooksPath .jig/hooks
```

This tells git to look in `.jig/hooks` instead of its usual place. Two things
worth knowing before you run it:

- It moves **every** hook, not just `pre-commit`. If you already have scripts
  in `.git/hooks`, they stop running.
- It applies to your clone only. A teammate who wants the same thing runs the
  same command.

To undo it: `git config --unset core.hooksPath`.

## If you already have a pre-commit hook

Don't repoint git — that would switch your own hook off. Add jig's line to the
hook you already have instead.

**If it is a shell script:**

```sh
node .jig/checks/run.mjs || exit 1
```

**If it is a node script (`#!/usr/bin/env node`):**

```js
require("child_process").execFileSync(process.execPath, [".jig/checks/run.mjs"], { stdio: "inherit" });
```

**If you use husky**, the same shell line goes in `.husky/pre-commit`.

## One thing that can go wrong

A git hook does not read your shell's startup files. If node reaches your
terminal through fnm, nvm, volta, or asdf, the hook may not find node at all.

The hook jig wrote lets the commit through when it cannot find node and
reports that its checks were skipped. That commit has no coverage from this
hook. Restore node on the hook's PATH or give node an absolute path; inspect
CI separately before relying on it.

## Trying it first

You can run the checks by hand any time, wired or not:

```sh
node .jig/checks/run.mjs
```

It exits 0 when it finds nothing and 1 when it finds something. It writes no
files and changes nothing.
