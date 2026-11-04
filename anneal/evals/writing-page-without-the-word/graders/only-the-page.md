---
type: regex
target: files
pattern: '^(?!\.git/|\.claude/|docs/remove-empty-rows\.md$)\S'
flags: m
match: not_contains
---
