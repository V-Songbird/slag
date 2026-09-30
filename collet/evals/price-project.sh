#!/usr/bin/env bash
# Writes and commits a small price-formatting library in the current directory.
#   plain    the library alone, with one commit
#   mounted  collet mounted with its config filled in, committed, and no task open
#   task     mounted, plus an open task whose scope is src/price.js and test/**
set -euo pipefail

stage="${1:?usage: price-project.sh plain|mounted|task}"
plugin="$(cd "$(dirname "$0")/.." && pwd)"
commit() {
  git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm "$1"
}

git init -q
mkdir -p src test
cat > package.json <<'JSON'
{
  "name": "prices",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
JSON
cat > AGENTS.md <<'MD'
# prices

A small price-formatting library. Node 22, ES modules, nothing to install or build.

Run `npm test` to check a change.
MD
printf 'export function formatPrice(cents) {\n  return (cents / 100).toFixed(2);\n}\n' > src/price.js
printf "import { formatPrice } from './price.js';\n\nexport function cartTotal(items) {\n  return formatPrice(items.reduce((sum, item) => sum + item.cents, 0));\n}\n" > src/cart.js
cat > test/price.test.js <<'JS'
import { test } from 'node:test';
import assert from 'node:assert';
import { formatPrice } from '../src/price.js';
import { cartTotal } from '../src/cart.js';

test('a price shows two decimals', () => {
  assert.strictEqual(formatPrice(250), '2.50');
});

test('a cart total sums its items', () => {
  assert.strictEqual(cartTotal([{ cents: 100 }, { cents: 150 }]), '2.50');
});
JS
git add package.json AGENTS.md src test
commit initial
[ "$stage" = plain ] && exit 0

node "$plugin/scripts/mount.mjs" . --accept "npm test" > /dev/null
cat > .collet/config.json <<'JSON'
{
  "project": "A small price-formatting library. Node 22, ES modules, no dependencies.",
  "conventions": [],
  "accept": "npm test"
}
JSON
git add AGENTS.md .collet
commit "mount collet"
[ "$stage" = mounted ] && exit 0

node .collet/task.mjs add --title "Show prices with a dollar sign" \
  --why "Prices are shown without their currency." --scope "src/price.js,test/**" > /dev/null
