---
type: regex
target: { source: file, path: src/price.js }
pattern: '^export function formatPrice\(cents\) \{\n  return \(cents / 100\)\.toFixed\(2\);\n\}\n$'
---
