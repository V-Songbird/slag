---
type: regex
pattern: '\[\s*(?:click here|here|this link|read more|learn more|read this|more|link)\s*\]\s*(?:[(\[]|:)'
flags: i
match: not_contains
target: { source: file, path: docs/remove-empty-rows.md }
---
