---
type: regex
target: { source: file, path: .collet/guard-log.jsonl }
pattern: '^(?=.*"check":"scope")(?=.*"reason":"package\.json is outside the open task\W).*$'
flags: m
arm: with-only
---
