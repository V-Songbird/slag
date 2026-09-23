---
type: regex
target: last_message
pattern: '^[ \t]*(?:\d+[.)]|[-*]|\|)(?![^\n]*(?:flag|mismatch|stale|does(?:n''t| not) (?:match|agree)|disagree|miscount|wrong|found|search|cart\.js|summary\.js|⚠|no coincide|marcad|encontr))[^\n]*src/utils\.js[^\n]*src/money\.js'
flags: im
match: not_contains
---
