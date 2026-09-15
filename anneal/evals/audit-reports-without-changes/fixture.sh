#!/usr/bin/env bash
set -euo pipefail

git init -q
mkdir -p src/cart src/orders dist
cat > package.json <<'JSON'
{
  "name": "shop",
  "private": true,
  "scripts": {
    "test": "node --test",
    "lint": "eslint ."
  }
}
JSON
printf 'export function formatPrice(cents) {\n  return (cents / 100).toFixed(2);\n}\n' > src/utils.js
printf 'export function formatCart(items) {\n  return items.length;\n}\n' > src/cart/format.js
printf 'export function formatOrder(order) {\n  return order.id;\n}\n' > src/orders/format.js
printf 'export const built = true;\n' > dist/bundle.js
git add package.json src
git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm "initial"
