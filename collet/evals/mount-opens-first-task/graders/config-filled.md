---
type: regex
target: { source: file, path: .collet/config.json }
pattern: '^(?![\s\S]*REPLACE ME)(?=[\s\S]*"project":\s*"[^"]*price)[\s\S]*"accept":\s*"npm test"'
flags: i
---
