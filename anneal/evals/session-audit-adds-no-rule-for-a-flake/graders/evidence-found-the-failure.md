---
type: regex
target: trace
pattern: '(?:^|\n)(?=[^\n]*"type":"tool_result")[^\n]*?category\W+nonzero-exit\W(?:[\s\S]*?\n(?=[^\n]*"type":"tool_result"))?[^\n]*?ECONNRESET(?:[\s\S]*?\n(?=[^\n]*"type":"tool_result"))?[^\n]*?laterSameToolSuccesses\W(?:[\s\S]*?\n(?=[^\n]*"type":"tool_result"))?[^\n]*?commandOrArguments\W+npm test\W'
---
