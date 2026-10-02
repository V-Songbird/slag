---
type: regex
pattern: '^\{\n  "name": "shop",\n  "private": true,\n  "scripts": \{\n    "test": "node --test",\n    "test:quiet": "node --test --test-reporter=dot"\n  \}\n\}\n$'
target: { source: file, path: package.json }
---
