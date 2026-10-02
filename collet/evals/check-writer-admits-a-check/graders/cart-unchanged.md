---
type: regex
target: { source: file, path: src/cart.js }
pattern: '^import \{ formatPrice \} from ''\./price\.js'';\n\nexport function cartTotal\(items\) \{\n  return formatPrice\(items\.reduce\(\(sum, item\) => sum \+ item\.cents, 0\)\);\n\}\n$'
---
