---
type: regex
pattern: '\b(?:simply|just|easy|easily|obviously|of course)\b'
flags: i
match: not_contains
target: { source: file, path: docs/remove-empty-rows.md }
---
