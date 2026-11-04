---
type: regex
pattern: '\[\s*(?:click here|here|this link|read more|more|link)\s*\]\('
flags: i
match: not_contains
target: { source: file, path: docs/remove-empty-rows.md }
---
