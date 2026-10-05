---
type: regex
target: trace
pattern: '(?:^|\n)(?=[^\n]*"type":"tool_result")[^\n]*?kind\W+large-output\W(?:[\s\S]*?\n(?=[^\n]*"type":"tool_result"))?[^\n]*?candidateCause\W+verbose-command\W(?:[\s\S]*?\n(?=[^\n]*"type":"tool_result"))?[^\n]*?scope\W+reporter\W'
---
