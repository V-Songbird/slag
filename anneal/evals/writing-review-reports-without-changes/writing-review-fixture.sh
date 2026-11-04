#!/usr/bin/env bash
set -euo pipefail

# The package and README of readme-review-reports-without-changes, plus a help
# page that trips its reader: a vague title, filler words, unnumbered steps, the
# overwrite warning after the command that overwrites, a bare "should", "e.g.",
# a "click here" link, no word of Node 22 and no sign of success.
bash "$(dirname "$0")/../readme-review-reports-without-changes/readme-fixture.sh"
mkdir -p docs
cat > docs/remove-empty-rows.md <<'MD'
# Cleaning

csv-tidy makes cleaning an export easy. Simply follow these steps.

- Install it with `npm install -g csv-tidy`.
- Run `csv-tidy export.csv --output export.csv`.
- Note that this overwrites the file you name after --output, so you should keep a copy first.

For more options, e.g. other output names, [click here](https://example.com/docs).
MD
git add docs
git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm "help page"
