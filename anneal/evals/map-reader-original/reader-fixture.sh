#!/usr/bin/env bash
set -euo pipefail

# The navigation repository with its original map, then only the notes: the
# map files and the files the map names by path. The source, the tests and
# any document the map does not name are removed and the removal committed.
node "$(dirname "$0")/../navigation-fixture.js" original
git rm -rq -- apps packages package.json docs
git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm "notes only"
