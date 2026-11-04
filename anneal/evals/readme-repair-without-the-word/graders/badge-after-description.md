---
type: regex
pattern: '^\s*# [^\n]*\n\s*(?!\[?!\[)(?!#)\S'
target: { source: file, path: README.md }
---
