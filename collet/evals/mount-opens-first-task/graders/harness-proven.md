---
type: tool_used
tool: Bash
input_match: '(?:"command"\s*:\s*"|&&|\||;|\\n)(?:\s|\\t)*(?:(?:[A-Za-z_]\w*=[^\s"\\;&|]*|timeout\s+\d[\w.]*|time)\s+)*(?:[^\s"\\;&|]*/)?node\s+(?:(?!-[cep]\b|-pe\b|--(?:check|eval|print)\b)-[^\s"\\;&|]+\s+(?:[^-\s"\\;&|][^\s"\\;&|]*\s+)?)*(?:\\")?[^\s"\\]*\.collet/checks/run\.mjs'
---
