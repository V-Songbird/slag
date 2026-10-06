---
type: regex
target: trace
pattern: '(?:^|\n)(?=[^\n]*"type":"tool_use")[^\n]*?"name":"Bash","input":\{[^\n]*?"command":"(?:[^"\\]|\\.)*?\bmv(?:\s+-\S+)*\s+(?:[^\s"\\]|\\.)*src/utils\.js(?:[^\s"\\]|\\.)*\s+(?:[^\s"\\]|\\.)*src/lib/money\.js[\s\S]*?\n(?=[^\n]*"type":"tool_result")[^\n]*?(?:#|ℹ) fail 0(?![^\n]*(?:#|ℹ) fail [1-9]|[\s\S]*?\n(?=[^\n]*"type":"tool_result")[^\n]*?(?:#|ℹ) fail [1-9])'
---
