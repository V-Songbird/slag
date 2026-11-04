---
type: regex
pattern: '^# Cleaning\n\ncsv-tidy makes cleaning an export easy\. Simply follow these steps\.\n\n- Install it with `npm install -g csv-tidy`\.\n- Run `csv-tidy export\.csv --output export\.csv`\.\n- Note that this overwrites the file you name after --output, so you should keep a copy first\.\n\nFor more options, e\.g\. other output names, \[click here\]\(https://example\.com/docs\)\.\n$'
target: { source: file, path: docs/remove-empty-rows.md }
---
