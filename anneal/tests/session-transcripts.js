"use strict";

// Synthetic transcripts for the session-evidence tests, written to temp directories that are removed after the
// run: the record shapes each host writes, and the CLI's path. No real transcript is a fixture; one holds machine
// paths and secrets.

const { after } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "scripts", "session-evidence.js");
const SESSION = "0a1b2c3d-0000-4000-8000-00000000abcd";

const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anneal-session-"));
  created.push(dir);
  return dir;
}

// Rows become one JSON line each; `tail` is appended raw, for a half-written record.
function transcript(rows, { tail = "", name = `${SESSION}.jsonl`, dir = tempDir() } = {}) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join("") + tail);
  return file;
}

const at = (second) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
// A copied field longer than its bound, as the evidence shows it.
const truncated = (value, size) => `${value.slice(0, size)} [excerpt truncated]`;

// Claude Code record shapes.
const human = (text, second) => ({
  type: "user", origin: { kind: "human" }, timestamp: at(second), sessionId: SESSION, cwd: "/work/shop", version: "2.1.0",
  message: { role: "user", content: text },
});
const use = (id, name, input, second, extra = {}) => ({
  type: "assistant", timestamp: at(second),
  message: { id: `msg-${id}`, model: "model-x", content: [{ type: "tool_use", id, name, input }] }, ...extra,
});
const result = (id, text, second, error = false, extra = {}) => ({
  type: "user", timestamp: at(second),
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: [{ type: "text", text }] }] }, ...extra,
});
// An older transcript tags no origin: any user text not marked isMeta reads as a prompt.
const typed = (text, second, extra = {}) => ({
  type: "user", timestamp: at(second), cwd: "/work/shop", message: { role: "user", content: text }, ...extra,
});

// Codex record shapes.
const meta = { timestamp: at(0), type: "session_meta", payload: { id: "thread-1", cwd: "/work/shop" } };
const started = (second) => ({ timestamp: at(second), type: "event_msg", payload: { type: "task_started" } });
const turn = (second) => ({ timestamp: at(second), type: "turn_context", payload: { cwd: "/work/shop", model: "model-y", effort: "medium" } });
const item = (second, payload) => ({ timestamp: at(second), type: "response_item", payload });
// A user message; the host also injects context, such as AGENTS.md or <environment_context>, this way.
const message = (text, second) => item(second, { type: "message", role: "user", content: [{ type: "input_text", text }] });
// A code-mode exec script that runs one shell command.
const call = (id, command, second) => item(second, {
  type: "custom_tool_call", call_id: id, name: "exec", input: `text(await tools.exec_command({cmd: ${JSON.stringify(command)}}))`,
});
const output = (id, texts, second) => item(second, {
  type: "custom_tool_call_output", call_id: id, output: texts.map((text) => ({ type: "input_text", text })),
});
// A code-mode exec script with any code, a direct tool call, and that call's result, text blocks or a plain string.
const script = (id, input, second) => item(second, { type: "custom_tool_call", call_id: id, name: "exec", input });
const fn = (id, name, args, second) => item(second, { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
const returned = (id, texts, second) => item(second, {
  type: "function_call_output", call_id: id, output: Array.isArray(texts) ? texts.map((text) => ({ type: "input_text", text })) : texts,
});

module.exports = {
  CLI, SESSION, tempDir, transcript, at, truncated, human, use, result, typed, meta, started, turn, item, message, call, output,
  script, fn, returned,
};
