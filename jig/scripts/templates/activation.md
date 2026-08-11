<!-- jig:owned — generated from jig's activation template. Edit this file and
jig reports it as drifted rather than overwriting your edit. -->

# Run the jig checks at commit time

jig does not edit your git hooks, and it never will at this release. Your
`pre-commit` is yours. Below is the exact line to paste into it, once, by hand.

**If your `pre-commit` is a shell script:**

```sh
node .jig/checks/run.mjs || exit 1
```

**If your `pre-commit` is a node script (`#!/usr/bin/env node`):**

```js
require("child_process").execFileSync(process.execPath, [".jig/checks/run.mjs"], { stdio: "inherit" });
```

**If you use husky**, the same shell line goes in `.husky/pre-commit`.

## Before you paste it

A git hook does not run your shell's startup files. If node reaches your
terminal through fnm, nvm, volta, or asdf, the hook may not find node at all,
and the commit will fail with `node: command not found` rather than passing
quietly. Two ways out: give the line an absolute path to node, or skip the
hook entirely and rely on the CI workflow, which needs nothing installed
anywhere.

You can always check what the driver does before wiring it to anything:

```sh
node .jig/checks/run.mjs
```

It exits 0 when it finds nothing and 1 when it finds something. It writes no
files and changes nothing.
