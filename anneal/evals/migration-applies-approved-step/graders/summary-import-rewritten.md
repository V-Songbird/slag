---
type: regex
target: { source: file, path: src/orders/summary.js }
pattern: '^import \{ formatPrice \} from (["\x27])\.\./money(?:\.js)?\1;\n\nexport function orderTotal\(order\) \{\n  return formatPrice\(order\.totalCents\);\n\}\n$'
---
