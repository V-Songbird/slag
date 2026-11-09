---
type: regex
pattern: '^(?:(?!npm (?:install|i)\b|npx )[\s\S])*?\bnode(?:\.js)?\b[^\n]{0,20}\bv?22\b'
flags: i
target: { source: file, path: docs/remove-empty-rows.md }
---
