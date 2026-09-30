---
type: regex
target: files
pattern: '^(?!\.git/|\.claude/|\.collet/)\S'
flags: m
match: not_contains
---
