#!/usr/bin/env bash
set -euo pipefail

bash "$(dirname "$0")/../session-repeats-proposes-a-script/repeats-fixture.sh"
# The same repository and sessions, with a map file that already names the
# listing the sessions repeat.
cat > AGENTS.md <<'MD'
# shop

A small cart library. Node 22, no build step.

## Commands

| Command | What it does | Cost |
| --- | --- | --- |
| `npm test` | runs the suite | seconds |
| `git status --short --ignored` | lists every changed file, ignored ones included, before a commit | seconds |
MD
git add AGENTS.md
git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm "name the listing"
