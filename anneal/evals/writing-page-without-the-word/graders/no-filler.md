---
type: regex
pattern: '\b(?:simply|easily|obviously|of course)\b|(?<!\byou )\bjust\b(?! (?:before|after|as|now)\b)|\beasy\b(?! to (?:miss|overlook)\b)'
flags: i
match: not_contains
target: { source: file, path: docs/remove-empty-rows.md }
---
