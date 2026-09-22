---
type: regex
target: files
pattern: '^(?!\.git/|\.claude/|src/money\.js$)\S'
flags: m
match: not_contains
---
