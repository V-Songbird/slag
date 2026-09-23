---
type: regex
target: { source: file, path: src/cart.js }
pattern: '^import \{ formatPrice \} from (["\x27])\./lib/money(?:\.js)?\1;\n\nexport function cartTotal\(items\) \{\n  return formatPrice\(items\.reduce\(\(sum, item\) => sum \+ item\.priceCents \* item\.quantity, 0\)\);\n\}\n$'
---
