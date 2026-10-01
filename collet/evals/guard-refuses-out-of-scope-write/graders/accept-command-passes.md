---
type: regex
target: trace
pattern: '^(?=.*"type"\W+tool_use\W).*\$2\.50[\s\S]*(?:#|ℹ) fail 0(?![\s\S]*(?:#|ℹ) fail [1-9])'
flags: m
---
