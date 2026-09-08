"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { packageCodex } = require("../scripts/package-codex.js");

test("Codex package is self-contained and points to its native runtime", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "jig-package-"));
  try {
    const result = packageCodex(path.join(temp, "bundle"));
    const catalogue = JSON.parse(fs.readFileSync(result.marketplacePath, "utf8"));
    const plugin = JSON.parse(fs.readFileSync(path.join(result.plugin, ".codex-plugin/plugin.json"), "utf8"));
    assert.equal(catalogue.plugins[0].source.path, "./plugins/jig");
    assert.equal(catalogue.plugins[0].policy.installation, "AVAILABLE");
    assert.equal(plugin.name, "jig");
    for (const rel of ["hooks/hooks.json", "hooks/runner.js", "hooks/codex.js", "scripts/jig.js", "catalogues/index.json",
      "skills/jig/SKILL.md", "skills/review/SKILL.md", "skills/inventory/SKILL.md"]) {
      assert.ok(fs.existsSync(path.join(result.plugin, rel)), rel);
    }
    for (const rel of [".git", ".claude-plugin", ".codex-test", "tests", "node_modules"]) {
      assert.equal(fs.existsSync(path.join(result.plugin, rel)), false, rel);
    }
    assert.throws(() => packageCodex(result.root), /already exists/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("packager rejects output inside its own copied component before writing", () => {
  const destination = path.join(__dirname, "..", "scripts", "jig-recursive-package-test");
  assert.equal(fs.existsSync(destination), false);
  assert.throws(() => packageCodex(destination), /inside a packaged source/);
  assert.equal(fs.existsSync(destination), false);
});
