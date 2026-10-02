#!/usr/bin/env bash
set -euo pipefail

bash "$(dirname "$0")/../session-audit-names-no-check-writer-without-collet/import-fixture.sh"

# The same repository with collet mounted: a .collet/ directory at the root.
mkdir -p .collet/checks
cat > .collet/config.json <<'JSON'
{
  "project": "A small cart library in ES modules, on Node 22.",
  "conventions": [],
  "accept": "npm test"
}
JSON
git add .collet
git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm "mount collet"
