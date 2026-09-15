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
    for (const rel of ["hooks/codex-hooks.json", "hooks/runner.js", "hooks/codex.js", "scripts/jig.js", "catalogues/index.json",
      "codex-skills/jig/SKILL.md", "codex-skills/review/SKILL.md", "codex-skills/inventory/SKILL.md",
      "codex-skills/jig/references/codex-runtime.md"]) {
      assert.ok(fs.existsSync(path.join(result.plugin, rel)), rel);
    }
    for (const rel of [".git", ".claude-plugin", ".codex-test", "tests", "node_modules", "skills", "skill-sources", "SCOPE.md", "docs"]) {
      assert.equal(fs.existsSync(path.join(result.plugin, rel)), false, rel);
    }
    // Codex replaces its default skill and hook locations only with a `./` path.
    // An invalid hooks path falls back to hooks/hooks.json, Claude Code's wiring.
    for (const key of ["skills", "hooks"]) {
      assert.match(plugin[key], /^\.\//, key + " is not a ./ path Codex honors");
      assert.ok(!plugin[key].split("/").includes(".."), key + " escapes the plugin");
      assert.ok(fs.existsSync(path.join(result.plugin, plugin[key])), key + " names nothing in the package");
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
