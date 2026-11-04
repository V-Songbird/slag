#!/usr/bin/env bash
set -euo pipefail

# A small command-line package whose README trips a newcomer: a badge above the
# title, filler words, a `$` prompt in a copyable block, a fence with no
# language, no shown result, a "click here" link, and no word of the Node 22
# requirement that package.json declares.
git init -q
mkdir -p bin
cat > package.json <<'JSON'
{
  "name": "csv-tidy",
  "version": "1.0.0",
  "bin": {
    "csv-tidy": "bin/csv-tidy.js"
  },
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "test": "node --test"
  }
}
JSON
cat > bin/csv-tidy.js <<'JS'
#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const [input, flag, output = "clean.csv"] = process.argv.slice(2);
if (!input || (flag !== undefined && flag !== "--output")) {
  console.error("usage: csv-tidy <input.csv> [--output <file>]");
  process.exit(2);
}
const rows = fs.readFileSync(input, "utf8").split(/\r?\n/);
if (rows.at(-1) === "") rows.pop();
const kept = rows.filter((row) => row.replaceAll(",", "").trim() !== "");
fs.writeFileSync(output, `${kept.join("\n")}\n`);
console.log(`Removed ${rows.length - kept.length} empty rows`);
console.log(`Wrote ${output}`);
JS
cat > README.md <<'MD'
[![License](https://example.com/badges/license-MIT.svg)](LICENSE)

# csv-tidy

csv-tidy is a powerful command-line tool that simply removes empty rows from CSV files.

## Install

```bash
$ npm install -g csv-tidy
```

## Usage

```
csv-tidy input.csv
```

For every option, [click here](https://example.com/docs).
MD
git add package.json bin README.md
git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm initial
