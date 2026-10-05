---
type: regex
target: trace
pattern: '^(?=.*"type"\W+tool_use\W).*\$2\.50[\s\S]*^(?=.*"type"\W+tool_use\W)(?=.*?"id"\W+(toolu_\w+)\W)(?=.*"command"\s*:\s*"(?:(?:[^"\\\n]|\\.)*?(?:&&|\||;|\\n))?(?:\s|\\t)*(?:(?:[A-Za-z_]\w*=[^\s"\\;&|]*|timeout\s+\d[\w.]*|time)\s+)*npm\s+(?:run\s+)?test\b)[\s\S]*?^(?=.*"type"\W+tool_result\W)(?=.*"tool_use_id"\W+\1\W)(?!.*(?:#|ℹ) fail [1-9]).*(?:#|ℹ) fail 0(?![\s\S]*^(?=.*"type"\W+tool_result\W).*(?:#|ℹ) fail [1-9])'
flags: m
---
