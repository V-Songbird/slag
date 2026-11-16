---
type: regex
target: { source: file, path: test/price.test.js }
pattern: '^import \{ test \} from ''node:test'';\nimport assert from ''node:assert'';\nimport \{ formatPrice \} from ''\.\./src/price\.js'';\nimport \{ cartTotal \} from ''\.\./src/cart\.js'';\n\ntest\(''a price shows two decimals'', \(\) => \{\n  assert\.strictEqual\(formatPrice\(250\), ''2\.50''\);\n\}\);\n\ntest\(''a cart total sums its items'', \(\) => \{\n  assert\.strictEqual\(cartTotal\(\[\{ cents: 100 \}, \{ cents: 150 \}\]\), ''2\.50''\);\n\}\);\n$'
---
