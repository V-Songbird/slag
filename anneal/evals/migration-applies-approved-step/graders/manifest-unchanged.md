---
type: regex
target: { source: file, path: package.json }
pattern: '^\{\n  "name": "shop",\n  "private": true,\n  "type": "module",\n  "scripts": \{\n    "test": "node --test --test-reporter=tap"\n  \}\n\}\n$'
---
