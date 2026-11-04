---
type: regex
pattern: '^[ \t]*(`{3,}|~{3,})[ \t]*(?:bash|sh|shell|zsh|console|powershell|ps1)[ \t]*\n(?:(?![ \t]*[`~]{3,})[^\n]*\n)*?[ \t]*\$ '
flags: im
match: not_contains
target: { source: file, path: README.md }
---
