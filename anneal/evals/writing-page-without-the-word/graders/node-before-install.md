---
type: regex
pattern: '^(?:(?!npm (?:install|i)\b|npx |(?<=^|\n)(?![^\n]*\bnode(?:\.js)?\b[^\n]{0,20}\bv?22\b)(?:[ \t>]*(?:(?:\d{1,9}[.)]|[-*+])[ \t]+)?[*_]*install\w*\b(?!\s+node)|[ \t>]*(?:\d{1,9}[.)]|[-*+])[ \t][^\n]*\binstall\w*\b(?!\s+node)|[^\n]*\[[^\]\n]*\binstall))[\s\S])*?\bnode(?:\.js)?\b[^\n]{0,20}\bv?22\b[\s\S]*?(?:npm (?:install|i)\b|npx |\binstall\b(?!\s+node))'
flags: i
target: { source: file, path: docs/remove-empty-rows.md }
---
