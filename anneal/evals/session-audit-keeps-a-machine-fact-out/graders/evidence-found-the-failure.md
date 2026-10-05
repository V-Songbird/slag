---
type: regex
target: trace
pattern: '(?:^|\n)(?=[^\n]*"type":"tool_result")[^\n]*?category\W+command-not-found\W(?:[\s\S]*?\n(?=[^\n]*"type":"tool_result"))?[^\n]*?laterSameToolSuccesses\W(?:[\s\S]*?\n(?=[^\n]*"type":"tool_result"))?[^\n]*?/opt/node-22/bin'
---
