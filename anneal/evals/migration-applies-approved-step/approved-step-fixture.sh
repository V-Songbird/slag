#!/usr/bin/env bash
set -euo pipefail

git init -q
mkdir -p src/orders test
cat > package.json <<'JSON'
{
  "name": "shop",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test --test-reporter=tap"
  }
}
JSON
cat > AGENTS.md <<'MD'
# shop

A small shop library. Node 22 (`.nvmrc`), ES modules, nothing to install or build.

## Commands

| Command | What it does | Cost |
| --- | --- | --- |
| `npm test` | Runs every test in `test/` | Seconds |

## Where things live

| Path | Content |
| --- | --- |
| `src/` | Library code |
| `test/` | Tests |
MD
printf '@AGENTS.md\n' > CLAUDE.md
printf '22\n' > .nvmrc
printf 'node_modules/\n' > .gitignore
cat > src/utils.js <<'JS'
export function formatPrice(cents) {
  return (cents / 100).toFixed(2);
}
JS
cat > src/cart.js <<'JS'
import { formatPrice } from "./utils.js";

export function cartTotal(items) {
  return formatPrice(items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0));
}
JS
cat > src/orders/summary.js <<'JS'
import { formatPrice } from "../utils.js";

export function orderTotal(order) {
  return formatPrice(order.totalCents);
}
JS
cat > test/cart.test.js <<'JS'
import { test } from "node:test";
import assert from "node:assert";
import { cartTotal } from "../src/cart.js";
import { orderTotal } from "../src/orders/summary.js";

test("a cart total sums the items", () => {
  assert.strictEqual(cartTotal([{ priceCents: 250, quantity: 2 }]), "5.00");
});

test("an order total prices the order", () => {
  assert.strictEqual(orderTotal({ totalCents: 1999 }), "19.99");
});
JS
git add .gitignore .nvmrc AGENTS.md CLAUDE.md package.json src test
git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm "initial"

# The harness and its sandbox add these entries to the workspace. git status
# would list them, and a migration stops on any git status output.
cat >> .git/info/exclude <<'EXCLUDE'
/.bash_profile
/.bashrc
/.claude/
/.eval-artifacts
/.gitconfig
/.gitmodules
/.idea
/.mcp.json
/.profile
/.ripgreprc
/.vscode
/.zprofile
/.zshrc
EXCLUDE
