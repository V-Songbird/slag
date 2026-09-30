---
type: regex
target: { source: file, path: .collet/guard-log.jsonl }
pattern: '"check":"scope"[^\n]*"reason":"package\.json is outside the open task'
arm: with-only
---
