---
type: regex
target: trace
pattern: '(?:^|\n)(?=[^\n]*"type":"tool_result")[^\n]*?category\W+permission-refused\W(?:[\s\S]*?\n(?=[^\n]*"type":"tool_result"))?[^\n]*?retriesAfterRefusal\W(?:[\s\S]*?\n(?=[^\n]*"type":"tool_result"))?[^\n]*?--no-pager reset'
---
