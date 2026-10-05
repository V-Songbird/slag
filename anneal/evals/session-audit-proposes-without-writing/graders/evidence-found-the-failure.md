---
type: regex
target: trace
pattern: '(?:^|\n)(?=[^\n]*"type":"tool_result")[^\n]*?commandOrArguments\W+npm test\W(?:[\s\S]*?\n(?=[^\n]*"type":"tool_result"))?[^\n]*?commandOrArguments\W+npm run check\W'
---
