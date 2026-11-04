---
type: regex
pattern: '^(?:(?!npm (?:install|i)\b|npx )[\s\S])*?\bnode(?:\.js)?\b[^\n]{0,20}\b22\b[\s\S]*?(?:npm (?:install|i)\b|npx )'
flags: i
target: { source: file, path: README.md }
---
