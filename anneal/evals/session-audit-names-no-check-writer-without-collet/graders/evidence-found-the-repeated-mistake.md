---
type: regex
target: trace
pattern: '(?:^|\n)(?=[^\n]*"type":"tool_result")[^\n]*?ERR_MODULE_NOT_FOUND\W[^"]*?imported from [^"]*?/src/cart\.js\W(?:[\s\S]*?\n(?=[^\n]*"type":"tool_result"))?[^\n]*?laterSameToolSuccesses\W(?:[\s\S]*?\n(?=[^\n]*"type":"tool_result"))?[^\n]*?ERR_MODULE_NOT_FOUND\W[^"]*?imported from [^"]*?/src/orders\.js\W'
---
