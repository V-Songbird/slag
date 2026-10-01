---
type: regex
target: trace
pattern: '^(?=.*"type"\W+tool_use\W)(?:(?=.*"name"\W+(?:Write|Edit|MultiEdit)\W)(?=.*"file_path"\s*:\s*"[^"]*\.collet/checks/(?!run\.mjs"|scope\.mjs")[\w.-]+\.mjs")(?=.*"(?:content|new_string)"\s*:\s*"(?:[^"\\]|\\.)*?(?:export (?:async )?function live\b|export const live\s*=))|(?=.*"name"\W+Bash\W)(?=.*"command"\s*:\s*"(?=(?:[^"\\]|\\.)*?(?:>|\btee\s+(?:-a\s+)?)\s*(?:\\"|'')?[^\s"''\\]*\.collet/checks/(?!run\.mjs|scope\.mjs)[\w.-]+\.mjs)(?:[^"\\]|\\.)*?(?:export (?:async )?function live\b|export const live\s*=))).*$'
flags: m
---
