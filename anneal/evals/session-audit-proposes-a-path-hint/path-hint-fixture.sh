#!/usr/bin/env bash
set -euo pipefail

git init -q
mkdir -p packages/core/config packages/core/src
cat > package.json <<'JSON'
{
  "name": "shop",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "node --test"
  }
}
JSON
cat > AGENTS.md <<'MD'
# shop

A small cart library. Node 22, no build step.

## Commands

| Command | What it does | Cost |
| --- | --- | --- |
| `npm test` | runs the suite | seconds |

## Where things live

| Path | Content |
| --- | --- |
| `packages/core/src/` | Cart and order code |
MD
cat > packages/core/config/defaults.js <<'JS'
export const defaults = { pageSize: 50, currency: "EUR" };
JS
cat > packages/core/src/cart.js <<'JS'
import { defaults } from "../config/defaults.js";

export function currency() {
  return defaults.currency;
}
JS
git add package.json AGENTS.md packages
git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm "initial"

# A synthetic transcript of a finished session in this directory. The session
# looks for the defaults file in two places the map file does not name before a
# search finds it under packages/core/config/, which the map file does not name
# either.
node - "$(pwd -W 2>/dev/null || pwd)" > session.jsonl <<'JS'
const cwd = process.argv[2];
let second = 0;
const at = () => `2026-01-01T00:00:${String(++second).padStart(2, "0")}.000Z`;
const use = (id, name, input) => ({ type: "assistant", timestamp: at(), cwd, message: { id: `msg-${id}`, model: "model-x", content: [{ type: "tool_use", id, name, input }] } });
const result = (id, text, error) => ({ type: "user", timestamp: at(), cwd, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: [{ type: "text", text }] }] } });
const missing = `File does not exist. Current working directory: ${cwd}`;
const rows = [
  { type: "user", origin: { kind: "human" }, timestamp: at(), cwd, sessionId: "0a1b2c3d-0000-4000-8000-00000000a1b2", version: "2.1.0", message: { role: "user", content: "Change the default page size to 50." } },
  use("t1", "Read", { file_path: `${cwd}/config/defaults.js` }), result("t1", missing, true),
  use("t2", "Read", { file_path: `${cwd}/src/config/defaults.js` }), result("t2", missing, true),
  use("t3", "Glob", { pattern: "**/defaults.js" }), result("t3", `${cwd}/packages/core/config/defaults.js`, false),
  use("t4", "Read", { file_path: `${cwd}/packages/core/config/defaults.js` }), result("t4", '1\texport const defaults = { pageSize: 20, currency: "EUR" };', false),
  use("t5", "Edit", { file_path: `${cwd}/packages/core/config/defaults.js`, old_string: "pageSize: 20", new_string: "pageSize: 50" }), result("t5", `The file ${cwd}/packages/core/config/defaults.js has been updated successfully.`, false),
  { type: "assistant", timestamp: at(), cwd, message: { id: "msg-end", model: "model-x", content: [{ type: "text", text: "The default page size is now 50." }] } },
];
process.stdout.write(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
JS
