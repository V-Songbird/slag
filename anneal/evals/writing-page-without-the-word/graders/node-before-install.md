---
type: regex
pattern: '^(?:(?!npm (?:install|i)\b|npx |(?<=^|\n)(?![^\n]*\bnode\b)[ \t]*(?:(?:\d{1,9}[.)]|[-*+])[ \t]+)?(?:install\b|[^\n]*\[[^\]\n]*\binstall\b))[\s\S])*?\bnode(?:\.js)?\b[^\n]{0,20}\bv?22\b[\s\S]*?(?:npm (?:install|i)\b|npx |\binstall\b(?!\s+node))'
flags: i
target: { source: file, path: docs/remove-empty-rows.md }
---
