#!/usr/bin/env bash
set -euo pipefail

git init -q
mkdir -p src
cat > package.json <<'JSON'
{
  "name": "shop",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
JSON
cat > AGENTS.md <<'MD'
# shop

A small cart library in ES modules. Node 22, no build step.

## Commands

| Command | What it does | Cost |
| --- | --- | --- |
| `npm test` | runs the suite | seconds |
MD
cat > src/round.js <<'JS'
export function round(cents) {
  return Math.round(cents);
}
JS
cat > src/cart.js <<'JS'
import { round } from "./round.js";

export function cartTotal(items) {
  return round(items.reduce((sum, item) => sum + item.cents, 0));
}
JS
cat > src/orders.js <<'JS'
import { round } from "./round.js";

export function orderTotal(order) {
  return round(order.cents + order.shippingCents);
}
JS
git add package.json AGENTS.md src
git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm "initial"

# A synthetic transcript of a finished session in this directory. The session
# makes the same mistake twice: a relative import without its .js extension,
# which Node refuses in an ES module package. Each time the suite fails, the
# session adds the extension and the suite passes.
node - "$(pwd -W 2>/dev/null || pwd)" > session.jsonl <<'JS'
const cwd = process.argv[2];
let second = 0;
const at = () => `2026-01-01T00:00:${String(++second).padStart(2, "0")}.000Z`;
const use = (id, name, input) => ({ type: "assistant", timestamp: at(), cwd, message: { id: `msg-${id}`, model: "model-x", content: [{ type: "tool_use", id, name, input }] } });
const result = (id, text, error) => ({ type: "user", timestamp: at(), cwd, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: [{ type: "text", text }] }] } });
const missing = (from) => `Exit code 1\nnode:internal/modules/esm/resolve:275\n    throw new ERR_MODULE_NOT_FOUND(\n          ^\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find module '${cwd}/src/round' imported from ${cwd}/src/${from}\nDid you mean to import "./round.js"?\n# tests 2\n# pass 0\n# fail 2`;
const passed = "# tests 2\n# pass 2\n# fail 0";
const edited = (file) => `The file ${cwd}/src/${file} has been updated successfully.`;
const rows = [
  { type: "user", origin: { kind: "human" }, timestamp: at(), cwd, sessionId: "0a1b2c3d-0000-4000-8000-00000000c0e7", version: "2.1.0", message: { role: "user", content: "Add a rounding helper and use it for the cart and order totals." } },
  use("t1", "Write", { file_path: `${cwd}/src/round.js`, content: "export function round(cents) {\n  return Math.round(cents);\n}\n" }), result("t1", `File created successfully at: ${cwd}/src/round.js`, false),
  use("t2", "Edit", { file_path: `${cwd}/src/cart.js`, old_string: "export function cartTotal", new_string: 'import { round } from "./round";\n\nexport function cartTotal' }), result("t2", edited("cart.js"), false),
  use("t3", "Bash", { command: "npm test" }), result("t3", missing("cart.js"), true),
  use("t4", "Edit", { file_path: `${cwd}/src/cart.js`, old_string: 'from "./round";', new_string: 'from "./round.js";' }), result("t4", edited("cart.js"), false),
  use("t5", "Bash", { command: "npm test" }), result("t5", passed, false),
  use("t6", "Edit", { file_path: `${cwd}/src/orders.js`, old_string: "export function orderTotal", new_string: 'import { round } from "./round";\n\nexport function orderTotal' }), result("t6", edited("orders.js"), false),
  use("t7", "Bash", { command: "npm test" }), result("t7", missing("orders.js"), true),
  use("t8", "Edit", { file_path: `${cwd}/src/orders.js`, old_string: 'from "./round";', new_string: 'from "./round.js";' }), result("t8", edited("orders.js"), false),
  use("t9", "Bash", { command: "npm test" }), result("t9", passed, false),
  { type: "assistant", timestamp: at(), cwd, message: { id: "msg-end", model: "model-x", content: [{ type: "text", text: "Both totals now round through src/round.js, and the suite passes." }] } },
];
process.stdout.write(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
JS
