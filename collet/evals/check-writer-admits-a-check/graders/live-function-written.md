---
type: regex
target: trace
pattern: '^(?=.*"type"\W+tool_use\W)(?=.*"name"\W+(?:Write|Edit|MultiEdit|Bash)\W)(?=.*\.collet/checks/(?!run\.mjs|scope\.mjs)[\w.-]+\.mjs\W)(?=.*export (?:async )?function live\b|.*export const live\s*=).*$'
flags: m
---
