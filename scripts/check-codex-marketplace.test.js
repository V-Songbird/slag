"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { verify } = require("./check-codex-marketplace.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slag-codex-marketplace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "plugins/jig/.codex-plugin/plugin.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ name: "jig", version: "2.16.0-codex.1" }));
  const marketplace = { name: "slag-codex", plugins: [{ name: "jig",
    source: { source: "local", path: "./plugins/jig" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] };
  return { root, file, marketplace };
}

test("accepts the native plugin layout and required marketplace policy", (t) => {
  const f = fixture(t);
  assert.deepEqual(verify(f.root, f.marketplace), []);
});

test("rejects an escaped source before inspecting a manifest", (t) => {
  const f = fixture(t);
  f.marketplace.plugins[0].source.path = "../outside";
  assert.ok(verify(f.root, f.marketplace).some((p) => p.includes("source.path")));
});

test("requires the native manifest even when a Claude manifest exists", (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.file);
  const legacy = path.join(f.root, "plugins/jig/.claude-plugin/plugin.json");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ name: "jig" }));
  assert.ok(verify(f.root, f.marketplace).some((p) => p.includes("native manifest cannot be read")));
});

test("rejects mismatched identity and a missing native version", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, JSON.stringify({ name: "other" }));
  const problems = verify(f.root, f.marketplace);
  assert.ok(problems.some((p) => p.includes("name does not match")));
  assert.ok(problems.some((p) => p.includes("requires a version")));
});

test("rejects duplicate entries and incomplete installation policy", (t) => {
  const f = fixture(t);
  delete f.marketplace.plugins[0].policy.authentication;
  f.marketplace.plugins.push(f.marketplace.plugins[0]);
  const problems = verify(f.root, f.marketplace);
  assert.ok(problems.some((p) => p.includes("duplicate")));
  assert.ok(problems.some((p) => p.includes("authentication policy")));
});
