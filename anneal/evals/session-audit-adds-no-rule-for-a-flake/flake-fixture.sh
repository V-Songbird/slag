#!/usr/bin/env bash
set -euo pipefail

git init -q
cat > package.json <<'JSON'
{
  "name": "shop",
  "private": true,
  "scripts": {
    "test": "node --test"
  }
}
JSON
cat > AGENTS.md <<'MD'
# shop

A small cart library that syncs carts to a server. Node 22, no build step.

## Commands

| Command | What it does | Cost |
| --- | --- | --- |
| `npm test` | runs the suite | seconds |
MD
git add package.json AGENTS.md
git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm "initial"

# A synthetic transcript of a finished session in this directory. The map
# file's command runs; one test fails once on a reset connection, and the same
# command passes on the next run with no change in between.
node - "$(pwd -W 2>/dev/null || pwd)" > session.jsonl <<'JS'
const cwd = process.argv[2];
let second = 0;
const at = () => `2026-01-01T00:00:${String(++second).padStart(2, "0")}.000Z`;
const use = (id, command) => ({ type: "assistant", timestamp: at(), cwd, message: { id: `msg-${id}`, model: "model-x", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const result = (id, text, error) => ({ type: "user", timestamp: at(), cwd, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: [{ type: "text", text }] }] } });
const failed = "Exit code 1\nnot ok 3 - sync pushes the cart\n  ---\n  error: 'read ECONNRESET'\n  code: 'ECONNRESET'\n  ...\n# tests 4\n# pass 3\n# fail 1";
const rows = [
  { type: "user", origin: { kind: "human" }, timestamp: at(), cwd, sessionId: "0a1b2c3d-0000-4000-8000-00000000f1a4", version: "2.1.0", message: { role: "user", content: "Run the suite and tell me whether it passes." } },
  use("t1", "npm test"), result("t1", failed, true),
  use("t2", "npm test"), result("t2", "# tests 4\n# pass 4\n# fail 0", false),
  { type: "assistant", timestamp: at(), cwd, message: { id: "msg-end", model: "model-x", content: [{ type: "text", text: "The suite passes: 4 tests, no failures. The first run hit a reset connection in the sync test." }] } },
];
process.stdout.write(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
JS
