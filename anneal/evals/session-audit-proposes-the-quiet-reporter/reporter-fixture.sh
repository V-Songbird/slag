#!/usr/bin/env bash
set -euo pipefail

git init -q
cat > package.json <<'JSON'
{
  "name": "shop",
  "private": true,
  "scripts": {
    "test": "node --test",
    "test:quiet": "node --test --test-reporter=dot"
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
MD
git add package.json AGENTS.md
git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm "initial"

# A synthetic transcript of a finished session in this directory. The map
# file's command passes, but its default reporter prints one line per test,
# more than 20,000 characters for 800 tests. The manifest already has a quieter
# script that the map file does not name.
node - "$(pwd -W 2>/dev/null || pwd)" > session.jsonl <<'JS'
const cwd = process.argv[2];
let second = 0;
const at = () => `2026-01-01T00:00:${String(++second).padStart(2, "0")}.000Z`;
const use = (id, command) => ({ type: "assistant", timestamp: at(), cwd, message: { id: `msg-${id}`, model: "model-x", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const result = (id, text, error) => ({ type: "user", timestamp: at(), cwd, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: [{ type: "text", text }] }] } });
const lines = Array.from({ length: 800 }, (_, index) => `✔ a cart total sums case ${String(index + 1).padStart(3, "0")} (0.1ms)`);
const passed = `${lines.join("\n")}\nℹ tests 800\nℹ pass 800\nℹ fail 0`;
const rows = [
  { type: "user", origin: { kind: "human" }, timestamp: at(), cwd, sessionId: "0a1b2c3d-0000-4000-8000-00000000c0de", version: "2.1.0", message: { role: "user", content: "Run the suite and tell me whether it passes." } },
  use("t1", "npm test"), result("t1", passed, false),
  { type: "assistant", timestamp: at(), cwd, message: { id: "msg-end", model: "model-x", content: [{ type: "text", text: "The suite passes: 800 tests, no failures." }] } },
];
process.stdout.write(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
JS
