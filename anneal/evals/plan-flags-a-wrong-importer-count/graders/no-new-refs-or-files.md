---
type: regex
target: files
pattern: '^(?:\.git/(?:refs/(?:heads|tags)/|refs/stash$|objects/)|(?!\.git/|\.claude/)\S)'
flags: m
match: not_contains
---
