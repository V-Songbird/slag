---
type: regex
target: trace
pattern: '(?:^|\n)(?=[^\n]*"type":"tool_use")[^\n]*?\bmv(?:\s+-\S+)*\s+\S*src/utils\.js\S*\s+\S*src/money\.js[\s\S]*?\n(?=[^\n]*"type":"tool_result")[^\n]*?(?:#|ℹ) fail 0(?![^\n]*(?:#|ℹ) fail [1-9]|[\s\S]*?\n(?=[^\n]*"type":"tool_result")[^\n]*?(?:#|ℹ) fail [1-9])'
---
