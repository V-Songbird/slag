#!/usr/bin/env bash
set -euo pipefail

# The navigation repository with its oriented map, then only the notes: the
# map files and the files the map names by path, here .nvmrc and
# docs/partner-api.md. The source and the tests are removed and the removal
# committed.
node "$(dirname "$0")/../navigation-fixture.js" oriented
git rm -rq -- apps packages package.json
git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm "notes only"
