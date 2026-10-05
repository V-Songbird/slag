---
type: regex
target: trace
pattern: '(?:^|\n)(?=[^\n]*"type":"tool_result")[^\n]*?kind\W+missing-path\W(?:[\s\S]*?\n(?=[^\n]*"type":"tool_result"))?[^\n]*?candidateCause\W+wrong-location\W(?:[\s\S]*?\n(?=[^\n]*"type":"tool_result"))?[^\n]*?scope\W+map-file\W'
---
