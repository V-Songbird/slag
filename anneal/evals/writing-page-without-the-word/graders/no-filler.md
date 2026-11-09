---
type: regex
pattern: '\b(?:simply|easily|obviously|of course)\b|\bjust\b(?! (?:before|after|now)\b)(?!(?<=\byou just) (?:downloaded|exported|saved|created|received|made)\b)|\beasy\b(?! to (?:miss|overlook)\b)'
flags: i
match: not_contains
target: { source: file, path: docs/remove-empty-rows.md }
---
