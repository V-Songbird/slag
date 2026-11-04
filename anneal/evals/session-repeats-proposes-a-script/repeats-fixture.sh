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

A small cart library. Node 22, no build step.

## Commands

| Command | What it does | Cost |
| --- | --- | --- |
| `npm test` | runs the suite | seconds |
MD
git add package.json AGENTS.md
git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm "initial"

# Three synthetic transcripts of finished sessions in this directory. Each
# session did other work, then ran the suite and listed every file, ignored
# ones included, the same way. The map file names the suite, not the listing.
node - "$(pwd -W 2>/dev/null || pwd)" <<'JS'
const fs = require("node:fs");
const cwd = process.argv[2];
const tasks = ["Round cart totals to cents.", "Add a currency option to the cart.", "Rename the order total helper."];
fs.mkdirSync("sessions", { recursive: true });
tasks.forEach((task, index) => {
  const sessionId = `0a1b2c3d-0000-4000-8000-00000000000${index + 1}`;
  let second = 0;
  const at = () => `2026-01-0${index + 1}T00:00:${String(++second).padStart(2, "0")}.000Z`;
  const use = (id, command) => ({ type: "assistant", timestamp: at(), cwd, sessionId, message: { id: `msg-${id}`, model: "model-x", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
  const result = (id, text) => ({ type: "user", timestamp: at(), cwd, sessionId, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: [{ type: "text", text }] }] } });
  const rows = [
    { type: "user", origin: { kind: "human" }, timestamp: at(), cwd, sessionId, version: "2.1.0", message: { role: "user", content: task } },
    use("t1", "npm test"), result("t1", "# tests 4\n# pass 4\n# fail 0"),
    use("t2", "git status --short --ignored"), result("t2", " M src/cart.js\n!! node_modules/"),
    { type: "assistant", timestamp: at(), cwd, sessionId, message: { id: "msg-end", model: "model-x", content: [{ type: "text", text: "Done. The suite passes." }] } },
  ];
  fs.writeFileSync(`sessions/${sessionId}.jsonl`, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
});
JS
