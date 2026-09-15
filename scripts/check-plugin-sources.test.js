"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { verify, verifyCodex } = require("./check-plugin-sources.js");

// Builds a throwaway repo root with one plugin dir, so verify() runs against
// real files rather than a mocked fs.
function repoWith(pluginName, manifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slag-sources-"));
  if (manifest !== null) {
    const dir = path.join(root, pluginName, ".claude-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  }
  return root;
}

test("passes when the source resolves and names agree", () => {
  const root = repoWith("widget", { name: "widget" });
  const problems = verify(root, { plugins: [{ name: "widget", source: "./widget" }] });
  assert.deepStrictEqual(problems, []);
});

test("flags a source directory that does not exist", () => {
  const root = repoWith("widget", { name: "widget" });
  const problems = verify(root, { plugins: [{ name: "verity", source: "./verity" }] });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /no \.claude-plugin\/plugin\.json/);
});

test("flags a plugin.json whose name disagrees with the entry", () => {
  const root = repoWith("widget", { name: "widgets" });
  const problems = verify(root, { plugins: [{ name: "widget", source: "./widget" }] });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /declares name "widgets"/);
});

test("flags a version in plugin.json, which would mask marketplace.json's", () => {
  const root = repoWith("widget", { name: "widget", version: "1.0.0" });
  const problems = verify(root, { plugins: [{ name: "widget", source: "./widget" }] });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /marketplace\.json owns versions/);
});

test("flags a codex manifest whose version drifts from the marketplace entry", () => {
  const root = repoWith("widget", { name: "widget" });
  const codexDir = path.join(root, "widget", ".codex-plugin");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "plugin.json"), JSON.stringify({ name: "widget", version: "0.9.0" }));
  const problems = verify(root, { plugins: [{ name: "widget", source: "./widget", version: "1.0.0" }] });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /does not match marketplace version "1\.0\.0"/);
});

test("passes when the codex manifest version matches the marketplace entry", () => {
  const root = repoWith("widget", { name: "widget" });
  const codexDir = path.join(root, "widget", ".codex-plugin");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "plugin.json"), JSON.stringify({ name: "widget", version: "1.0.0" }));
  const problems = verify(root, { plugins: [{ name: "widget", source: "./widget", version: "1.0.0" }] });
  assert.deepStrictEqual(problems, []);
});

test("flags a codex skills or hooks path Codex would not honor", () => {
  const root = repoWith("widget", { name: "widget" });
  const codexDir = path.join(root, "widget", ".codex-plugin");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(path.join(root, "widget", "codex-skills"));
  const write = (fields) => fs.writeFileSync(path.join(codexDir, "plugin.json"), JSON.stringify({ name: "widget", version: "1.0.0", ...fields }));
  const entry = { plugins: [{ name: "widget", source: "./widget", version: "1.0.0" }] };

  write({ skills: "./codex-skills/", hooks: "hooks/codex-hooks.json" });
  let problems = verify(root, entry);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /hooks "hooks\/codex-hooks\.json" must start with "\.\/"/);

  write({ skills: "./codex-skills/", hooks: "./hooks/codex-hooks.json" });
  problems = verify(root, entry);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /names nothing on disk/);

  fs.mkdirSync(path.join(root, "widget", "hooks"));
  fs.writeFileSync(path.join(root, "widget", "hooks", "codex-hooks.json"), "{}");
  assert.deepStrictEqual(verify(root, entry), []);
});

test("passes a Codex marketplace whose local sources resolve to their Codex manifests", () => {
  const root = repoWith("widget", { name: "widget" });
  const codexDir = path.join(root, "widget", ".codex-plugin");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "plugin.json"), JSON.stringify({ name: "widget", version: "1.0.0" }));
  const entry = { name: "widget", source: { source: "local", path: "./widget" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" };
  assert.deepStrictEqual(verifyCodex(root, { name: "slag-codex", plugins: [entry] }), []);
});

test("flags a Codex marketplace entry that escapes, misses its manifest, or lacks its policy", () => {
  const root = repoWith("widget", { name: "widget" });
  const base = { name: "widget", policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" };
  let problems = verifyCodex(root, { name: "slag-codex", plugins: [{ ...base, source: { source: "local", path: "../widget" } }] });
  assert.match(problems.join("\n"), /inside this repo/);
  problems = verifyCodex(root, { name: "slag-codex", plugins: [{ ...base, source: { source: "local", path: "./widget" } }] });
  assert.match(problems.join("\n"), /has no \.codex-plugin\/plugin\.json/);
  problems = verifyCodex(root, { name: "slag-codex", plugins: [{ name: "widget", source: { source: "local", path: "./widget" } }] });
  assert.match(problems.join("\n"), /policy/);
  assert.match(verifyCodex(root, { plugins: [] }).join("\n"), /valid name/);
});

test("flags a non-relative source", () => {
  const root = repoWith("widget", { name: "widget" });
  const problems = verify(root, {
    plugins: [{ name: "widget", source: { source: "url", url: "https://example.invalid/widget.git" } }],
  });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /must be a relative/);
});

test("flags a source that escapes the repo root", () => {
  const root = repoWith("widget", { name: "widget" });
  const problems = verify(root, { plugins: [{ name: "widget", source: "./../widget" }] });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /must not escape the repo root/);
});
