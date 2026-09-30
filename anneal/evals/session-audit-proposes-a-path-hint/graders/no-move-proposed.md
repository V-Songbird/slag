---
type: regex
pattern: '^(?![^\n]*(?:\bno\b|\bnot\b|n''t|never|nothing|repo-layout|rather than|instead of|nunca|ning[uú]n))(?=[^\n]*(?:\bmov(?:e|ing)\b|renam|relocat|\bmv\b|mover|renombr))(?=[^\n]*(?:defaults\.js|config/))[^\n]*$'
flags: im
match: not_contains
---
