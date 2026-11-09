---
type: regex
pattern: '^#!/usr/bin/env node\n"use strict";\n\nconst fs = require\("node:fs"\);\n\nconst \[input, flag, output = "clean\.csv"\] = process\.argv\.slice\(2\);\nif \(!input \|\| \(flag !== undefined && flag !== "--output"\)\) \{\n  console\.error\("usage: csv-tidy <input\.csv> \[--output <file>\]"\);\n  process\.exit\(2\);\n\}\nconst rows = fs\.readFileSync\(input, "utf8"\)\.split\(/\\r\?\\n/\);\nif \(rows\.at\(-1\) === ""\) rows\.pop\(\);\nconst kept = rows\.filter\(\(row\) => row\.replaceAll\(",", ""\)\.trim\(\) !== ""\);\nfs\.writeFileSync\(output, `\$\{kept\.join\("\\n"\)\}\\n`\);\nconsole\.log\(`Removed \$\{rows\.length - kept\.length\} empty rows`\);\nconsole\.log\(`Wrote \$\{output\}`\);\n$'
target: { source: file, path: bin/csv-tidy.js }
---
