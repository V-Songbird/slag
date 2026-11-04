---
type: regex
target: trace
pattern: '(?:^|\n)(?=[^\n]*"type":"tool_result")[^\n]*?step\W+(?:npm test -> )?git status --short --ignored\W+(?:n\W*)?sessions\W+3\b'
---
