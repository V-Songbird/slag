---
type: regex
pattern: '^(?![^\n]*(?:safety|never|\bnot\b|n''t|\bno\b|around|bypass|circumvent|refus|denied|deny|seguridad|nunca|rechaz|deneg))(?=[^\n]*--no-pager)(?:[ \t]*\||[^\n]*(?:AGENTS\.md|CLAUDE\.md|map file|Commands|Pitfalls|Rules|propos|\buse\b|instead))[^\n]*$'
flags: im
match: not_contains
---
