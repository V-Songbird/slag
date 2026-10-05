---
type: regex
target: trace
pattern: '^(?=.*"type"\W+tool_use\W)(?=.*"id"\W+(toolu_\w+)\W(?:(?!"type"\W+tool_use\W).)*?"command"\s*:\s*"(?:(?:[^"\\''#<\n]|<(?!<)|\\[^"\\]|\\\\(?:\\.|[^"\\])|''(?:[^''"\\]|\\.)*''|\\"(?:[^"\\]|\\[^"\\]|\\\\(?:\\.|[^"\\]))*\\"|#(?:[^"\\]|\\[^n])*(?=\\n|"))*?(?:&&|\||;|\\n))?(?:\s|\\t)*(?:(?:[A-Za-z_]\w*=[^\s"\\;&|]*|timeout\s+\d[\w.]*|time)\s+)*(?:[^\s"\\;&|]*/)?node\s+(?:(?!-[cep]\b|-pe\b|--(?:check|eval|print)\b)-[^\s"\\;&|]+\s+(?:[^-\s"\\;&|][^\s"\\;&|]*\s+)?)*(?:\\")?[^\s"\\]*\.collet/checks/run\.mjs)[\s\S]*?^(?=.*"type"\W+tool_result\W)(?!.*FAIL [\w-]+ \S+ ).*"tool_use_id"\W+\1\W(?:(?!"tool_use_id"\W).)*?ok {3}(?!scope )[\w-]+ \S+ [1-9]\d* violation\(s\) caught, [1-9]\d* near miss\(es\) left alone(?![\s\S]*^(?=.*"type"\W+tool_result\W).*FAIL [\w-]+ \S+ )'
flags: m
---
