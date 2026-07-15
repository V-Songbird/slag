"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { verify } = require("./check-plugin-sources.js");

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
  const root = repoWith("forge", { name: "forge" });
  const problems = verify(root, { plugins: [{ name: "forge", source: "./forge" }] });
  assert.deepStrictEqual(problems, []);
});

test("flags a source directory that does not exist", () => {
  const root = repoWith("forge", { name: "forge" });
  const problems = verify(root, { plugins: [{ name: "verity", source: "./verity" }] });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /no \.claude-plugin\/plugin\.json/);
});

test("flags a plugin.json whose name disagrees with the entry", () => {
  const root = repoWith("forge", { name: "forgery" });
  const problems = verify(root, { plugins: [{ name: "forge", source: "./forge" }] });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /declares name "forgery"/);
});

test("flags a version in plugin.json, which would mask marketplace.json's", () => {
  const root = repoWith("forge", { name: "forge", version: "1.0.0" });
  const problems = verify(root, { plugins: [{ name: "forge", source: "./forge" }] });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /marketplace\.json owns versions/);
});

test("flags a non-relative source", () => {
  const root = repoWith("forge", { name: "forge" });
  const problems = verify(root, {
    plugins: [{ name: "forge", source: { source: "url", url: "https://example.invalid/forge.git" } }],
  });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /must be a relative/);
});

test("flags a source that escapes the repo root", () => {
  const root = repoWith("forge", { name: "forge" });
  const problems = verify(root, { plugins: [{ name: "forge", source: "./../forge" }] });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /must not escape the repo root/);
});
