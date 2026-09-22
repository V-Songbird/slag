---
type: regex
target: { source: file, path: test/cart.test.js }
pattern: '^import \{ test \} from "node:test";\nimport assert from "node:assert";\nimport \{ cartTotal \} from "\.\./src/cart\.js";\nimport \{ orderTotal \} from "\.\./src/orders/summary\.js";\n\ntest\("a cart total sums the items", \(\) => \{\n  assert\.strictEqual\(cartTotal\(\[\{ priceCents: 250, quantity: 2 \}\]\), "5\.00"\);\n\}\);\n\ntest\("an order total prices the order", \(\) => \{\n  assert\.strictEqual\(orderTotal\(\{ totalCents: 1999 \}\), "19\.99"\);\n\}\);\n$'
---
