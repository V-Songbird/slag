---
type: regex
pattern: '^\{\n  "name": "csv-tidy",\n  "version": "1\.0\.0",\n  "bin": \{\n    "csv-tidy": "bin/csv-tidy\.js"\n  \},\n  "engines": \{\n    "node": ">=22"\n  \},\n  "scripts": \{\n    "test": "node --test"\n  \}\n\}\n$'
target: { source: file, path: package.json }
---
