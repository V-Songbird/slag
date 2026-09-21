#!/usr/bin/env bash
set -euo pipefail

git init -q
cat > package.json <<'JSON'
{
  "name": "shop",
  "private": true,
  "scripts": {
    "check": "node --test"
  }
}
JSON
cat > AGENTS.md <<'MD'
# shop

A small cart library. Node 20, no build step.

## Commands

| Command | What it does | Cost |
| --- | --- | --- |
| `npm test` | runs the suite | seconds |
MD
git add package.json AGENTS.md
git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm "initial"

# A synthetic transcript of a finished session in this directory. The command
# the map file names fails twice, and the one that works is written down nowhere.
node - "$(pwd -W 2>/dev/null || pwd)" > session.jsonl <<'JS'
const cwd = process.argv[2];
let second = 0;
const at = () => `2026-01-01T00:00:${String(++second).padStart(2, "0")}.000Z`;
const use = (id, command) => ({ type: "assistant", timestamp: at(), cwd, message: { id: `msg-${id}`, model: "model-x", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const result = (id, text, error) => ({ type: "user", timestamp: at(), cwd, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: [{ type: "text", text }] }] } });
const missing = 'Exit code 1\nnpm error Missing script: "test"\nnpm error To see a list of scripts, run:\nnpm error   npm run';
const rows = [
  { type: "user", origin: { kind: "human" }, timestamp: at(), cwd, sessionId: "0a1b2c3d-0000-4000-8000-00000000abcd", version: "2.1.0", message: { role: "user", content: "Fix the cart total and run the suite." } },
  use("t1", "npm test"), result("t1", missing, true),
  use("t2", "npm test -- --watch=false"), result("t2", missing, true),
  use("t3", "npm run"), result("t3", "Scripts available in shop via `npm run`:\n  check\n    node --test", false),
  use("t4", "npm run check"), result("t4", "# tests 4\n# pass 4\n# fail 0", false),
  { type: "assistant", timestamp: at(), cwd, message: { id: "msg-end", model: "model-x", content: [{ type: "text", text: "The cart total is fixed and the suite passes." }] } },
];
process.stdout.write(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
JS
