---
type: regex
target: files
pattern: '^\.collet/checks/([\w-]+)\.mjs$(?=[\s\S]*^\.collet/checks/\1\.nearmiss[\w.-]*\.json$)(?=[\s\S]*^\.collet/checks/\1\.violation[\w.-]*\.json$)'
flags: m
---
