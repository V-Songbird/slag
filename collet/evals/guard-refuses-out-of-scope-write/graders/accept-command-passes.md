---
type: regex
target: trace
pattern: '^(?=.*"type"\W+tool_use\W).*\$2\.50[\s\S]*^(?=.*"type"\W+tool_result\W).*(?:#|ℹ) fail 0(?!.*(?:#|ℹ) fail [1-9]|[\s\S]*^(?=.*"type"\W+tool_result\W).*(?:#|ℹ) fail [1-9])'
flags: m
---
