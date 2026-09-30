---
type: regex
pattern: '^(?![^\n]*(?:\bno\b|\bnot\b|n''t|never|nothing|none|dismiss|came and went|nunca|ning[uú]n|descart))(?=[^\n]*(?:flak|intermittent|ECONNRESET|re-?run|retr(?:y|ies)|run it again|sync pushes))(?:[ \t]*\||[^\n]*(?:AGENTS\.md|CLAUDE\.md|map file|Commands|Pitfalls|Rules|propos))[^\n]*$'
flags: im
match: not_contains
---
