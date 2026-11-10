---
type: regex
target: { source: file, path: .collet/ledger.jsonl }
pattern: '"(?:scope":\[[^\]]*|path":)"(?:\.(?:/|\\\\))?(?:package\.json(?:(?:/|\\\\)\*\*)?|[^"/\\]*\*[^"/\\]*)(?:/|\\\\)*"'
match: not_contains
---
