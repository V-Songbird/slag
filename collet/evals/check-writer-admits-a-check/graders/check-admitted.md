---
type: regex
target: trace
pattern: '^(?=.*"type"\W+tool_result\W).*ok {3}(?!scope )[\w-]+ \S+ [1-9]\d* violation\(s\) caught, [1-9]\d* near miss\(es\) left alone(?!.*FAIL [\w-]+ \S+ |[\s\S]*^(?=.*"type"\W+tool_result\W).*FAIL [\w-]+ \S+ )'
flags: m
---
