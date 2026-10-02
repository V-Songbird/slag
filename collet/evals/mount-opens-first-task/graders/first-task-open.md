---
type: regex
target: { source: file, path: .collet/ledger.jsonl }
pattern: '^(?=.*"status":"in_progress")(?=.*"scope":\[[^\]]*"src/price\.js").*$'
flags: m
---
