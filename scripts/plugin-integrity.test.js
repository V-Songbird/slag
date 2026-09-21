"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CLAUDE_INDEX = ".claude-plugin/marketplace.json";
const CODEX_INDEX = ".agents/plugins/marketplace.json";
const AUTHOR = { name: "Victor Villegas", email: "victor.villegas@tuta.com" };
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
const hasKind = (file, kind) => {
  try {
    const stat = fs.statSync(path.join(ROOT, file));
    return kind === "directory" ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
};

// This is Slag's three-host contract, not a validator for arbitrary plugins.
// Reader overrides let negative cases remove a path or change metadata in memory.
function verifyIntegrity({ json = readJson, exists = hasKind } = {}) {
  function localPath(base, reference, label, kind = "file") {
    assert.ok(typeof reference === "string" && reference.startsWith("./"),
      `${label} must be a local relative path`);
    assert.ok(!reference.includes("\\"), `${label} must use forward slashes`);
    const target = path.posix.normalize(path.posix.join(base, reference));
    const relative = path.posix.relative(base || ".", target);
    assert.ok(relative !== ".." && !relative.startsWith("../"), `${label} escapes its root`);
    assert.ok(exists(target, kind), `${label} points to missing ${kind}: ${target}`);
    return target;
  }

  function author(value, label) {
    assert.deepEqual({ name: value?.name, email: value?.email }, AUTHOR, `${label} author differs`);
  }

  function hooks(root, file, host, name) {
    const config = json(file);
    const events = host === "antigravity" ? config[name] : config.hooks;
    assert.ok(events && Object.keys(events).length, `${file} has no hook events`);
    for (const groups of Object.values(events)) {
      assert.ok(Array.isArray(groups) && groups.length, `${file} has no hook groups`);
      for (const group of groups) {
        assert.ok(Array.isArray(group.hooks) && group.hooks.length, `${file} has no hook commands`);
        for (const hook of group.hooks) {
          // All shipped hooks launch a Node script. Keep the host's three forms
          // explicit so a malformed command cannot pass without checking its target.
          let script;
          if (host === "claude") {
            assert.equal(hook.command, "node", `${file} must launch node`);
            script = hook.args?.[0]?.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, "./");
          } else if (host === "codex") {
            script = /^node "\$\{PLUGIN_ROOT\}\/([^"]+)"(?:\s|$)/.exec(hook.command)?.[1];
            if (script) script = `./${script}`;
          } else {
            script = /^node (\.\/\S+)(?:\s|$)/.exec(hook.command)?.[1];
          }
          localPath(root, script, `${file} hook script`);
        }
      }
    }
  }

  function skills(root, reference, label) {
    const directory = localPath(root, reference, label, "directory");
    const entries = fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    assert.ok(entries.length, `${label} has no skills`);
    for (const entry of entries) {
      localPath(directory, `./${entry.name}/SKILL.md`, `${label}/${entry.name}`);
    }
  }

  const claude = json(CLAUDE_INDEX);
  const codex = json(CODEX_INDEX);
  author(claude.owner, CLAUDE_INDEX);
  assert.equal(Object.hasOwn(codex, "version"), false, `${CODEX_INDEX} must not carry version`);
  const names = (index, label) => {
    assert.ok(Array.isArray(index.plugins) && index.plugins.length, `${label} has no plugins`);
    const values = index.plugins.map((plugin) => plugin.name);
    assert.equal(new Set(values).size, values.length, `${label} has duplicate plugins`);
    return values.sort();
  };
  assert.deepEqual(names(claude, CLAUDE_INDEX), names(codex, CODEX_INDEX), "marketplace plugin sets differ");

  for (const entry of claude.plugins) {
    const indexed = codex.plugins.find((plugin) => plugin.name === entry.name);
    assert.equal(entry.source, `./${entry.name}`, `${entry.name} source must name its in-tree directory`);
    const root = localPath("", entry.source, `${entry.name} Claude source`, "directory");
    assert.equal(indexed.source?.source, "local", `${entry.name} Codex source must be local`);
    assert.equal(localPath("", indexed.source.path, `${entry.name} Codex source`, "directory"), root,
      `${entry.name} marketplace sources differ`);
    assert.equal(Object.hasOwn(indexed, "version"), false, `${entry.name} Codex index must not carry version`);

    const manifestFiles = ["./.claude-plugin/plugin.json", "./.codex-plugin/plugin.json", "./plugin.json"]
      .map((file) => localPath(root, file, `${entry.name} manifest`));
    const [claudeManifest, codexManifest, antigravityManifest] = manifestFiles.map(json);
    assert.equal(Object.hasOwn(claudeManifest, "version"), false, `${entry.name} Claude manifest must not carry version`);
    assert.equal(Object.hasOwn(antigravityManifest, "$schema"), false,
      `${entry.name} root manifest must not select the portable loader`);
    assert.equal(Object.hasOwn(antigravityManifest.extensions ?? {}, "com.openai"), false,
      `${entry.name} root manifest must not carry a portable Codex extension`);
    assert.ok(codexManifest.interface && typeof codexManifest.interface === "object",
      `${entry.name} Codex interface is missing`);
    assert.equal(codexManifest.interface.developerName, AUTHOR.name,
      `${entry.name} Codex developer name differs`);
    assert.ok(typeof entry.version === "string" && entry.version.length, `${entry.name} version is missing`);
    assert.ok(typeof entry.description === "string" && entry.description.length, `${entry.name} description is missing`);
    author(entry.author, `${entry.name} marketplace`);
    for (const [index, manifest] of [claudeManifest, codexManifest, antigravityManifest].entries()) {
      const label = manifestFiles[index];
      assert.equal(manifest.name, entry.name, `${label} name differs`);
      assert.equal(manifest.description, entry.description, `${label} description differs`);
      author(manifest.author, label);
      if (index > 0) assert.equal(manifest.version, entry.version, `${label} version differs`);
      // These optional local component fields are paths when present in Slag.
      for (const field of ["agents", "commands"]) {
        if (manifest[field] !== undefined) localPath(root, manifest[field], `${label} ${field}`, "directory");
      }
      // These were the dangling references left when assets/ was removed.
      for (const field of ["composerIcon", "logo", "logoDark"]) {
        if (manifest.interface?.[field] !== undefined) {
          localPath(root, manifest.interface[field], `${label} interface.${field}`);
        }
      }
    }
    skills(root, claudeManifest.skills ?? "./skills/", `${manifestFiles[0]} skills`);
    skills(root, codexManifest.skills, `${manifestFiles[1]} skills`);
    skills(root, antigravityManifest.skills ?? "./skills/", `${manifestFiles[2]} skills`);
    hooks(root, localPath(root, claudeManifest.hooks ?? "./hooks/hooks.json", `${entry.name} Claude hooks`), "claude", entry.name);
    hooks(root, localPath(root, codexManifest.hooks, `${entry.name} Codex hooks`), "codex", entry.name);
    hooks(root, localPath(root, "./hooks.json", `${entry.name} Antigravity hooks`), "antigravity", entry.name);
  }
}

function withJsonChange(file, change) {
  return { json: (current) => {
    const value = readJson(current);
    if (current === file) change(value);
    return value;
  } };
}

test("marketplace sources, host manifests and referenced files agree", () => verifyIntegrity());

test("rejects a missing marketplace source", () => {
  assert.throws(() => verifyIntegrity({ exists: (file, kind) => file !== "anneal" && hasKind(file, kind) }),
    /Claude source points to missing directory: anneal/);
});

test("rejects a Codex source that points outside the repository", () => {
  assert.throws(() => verifyIntegrity(withJsonChange(CODEX_INDEX, (value) => {
    value.plugins[0].source.path = "./../outside";
  })), /Codex source escapes its root/);
});

test("rejects a missing hook script and a missing skill entrypoint", () => {
  for (const suffix of ["hooks/safety-guard.js", "SKILL.md"]) {
    assert.throws(() => verifyIntegrity({ exists: (file, kind) => !file.endsWith(suffix) && hasKind(file, kind) }),
      /points to missing file/);
  }
});

test("rejects a dangling asset reference", () => {
  assert.throws(() => verifyIntegrity(withJsonChange("anneal/.codex-plugin/plugin.json", (value) => {
    value.interface.logo = "./assets/deleted-logo.svg";
  })), /interface.logo points to missing file/);
});

test("rejects Windows separators that escape a plugin root", () => {
  assert.throws(() => verifyIntegrity(withJsonChange("anneal/.codex-plugin/plugin.json", (value) => {
    value.interface.logo = "./..\\collet\\README.md";
  })), /interface.logo must use forward slashes/);
});

test("rejects a version mismatch between hosts", () => {
  assert.throws(() => verifyIntegrity(withJsonChange("collet/plugin.json", (value) => {
    value.version = `${value.version}-different`;
  })), /collet\/plugin.json version differs/);
});

test("rejects metadata drift and forbidden version placements", () => {
  for (const [file, change, message] of [
    ["anneal/plugin.json", (value) => { value.description += " changed"; }, /description differs/],
    ["collet/.codex-plugin/plugin.json", (value) => { value.author.name = "Changed Author"; }, /author differs/],
    ["anneal/.claude-plugin/plugin.json", (value) => { value.version = "1.0.0"; }, /Claude manifest must not carry version/],
    [CODEX_INDEX, (value) => { value.plugins[0].version = "1.0.0"; }, /Codex index must not carry version/],
  ]) {
    assert.throws(() => verifyIntegrity(withJsonChange(file, change)), message);
  }
});

test("rejects restoring portable loader selection", () => {
  assert.throws(() => verifyIntegrity(withJsonChange("anneal/plugin.json", (value) => {
    value.$schema = "https://agent-plugins.org/plugin.schema.json";
  })), /root manifest must not select the portable loader/);
  assert.throws(() => verifyIntegrity(withJsonChange("anneal/plugin.json", (value) => {
    value.extensions = { "com.openai": {} };
  })), /root manifest must not carry a portable Codex extension/);
});
