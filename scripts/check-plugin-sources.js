#!/usr/bin/env node
"use strict";

// CI check: every marketplace.json plugin entry must point at a real plugin
// directory in this repo, and that directory's plugin.json must agree on the
// name. Plugins here live in-tree (relative "./name" sources), so there are
// no submodule pointers or source.sha pins to verify -- a typo'd path or a
// renamed directory is the whole failure mode, and it fails silently at
// install time rather than at push time.

const fs = require("fs");
const path = require("path");

const MARKETPLACE_PATH = path.join(".claude-plugin", "marketplace.json");

function verify(root, marketplace) {
  const problems = [];
  for (const entry of marketplace.plugins || []) {
    const source = entry.source;
    if (typeof source !== "string") {
      problems.push(`"${entry.name}": source must be a relative "./path" string in this repo, got ${JSON.stringify(source)}`);
      continue;
    }
    if (!source.startsWith("./") || source.includes("..")) {
      problems.push(`"${entry.name}": source "${source}" must start with "./" and must not escape the repo root`);
      continue;
    }

    const manifestPath = path.join(root, source, ".claude-plugin", "plugin.json");
    if (!fs.existsSync(manifestPath)) {
      problems.push(`"${entry.name}": source "${source}" has no .claude-plugin/plugin.json`);
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch (err) {
      problems.push(`"${entry.name}": ${source}/.claude-plugin/plugin.json is not valid JSON -- ${err.message}`);
      continue;
    }

    if (manifest.name !== entry.name) {
      problems.push(`"${entry.name}": ${source}/.claude-plugin/plugin.json declares name "${manifest.name}"`);
    }
    // marketplace.json is the single owner of every version here; a version in
    // plugin.json silently wins over it and installers never see the bump.
    if (manifest.version !== undefined) {
      problems.push(`"${entry.name}": ${source}/.claude-plugin/plugin.json sets "version" -- marketplace.json owns versions`);
    }
  }
  return problems;
}

function main() {
  const root = process.cwd();
  const marketplace = JSON.parse(fs.readFileSync(path.join(root, MARKETPLACE_PATH), "utf-8"));
  const problems = verify(root, marketplace);

  if (problems.length === 0) {
    process.stdout.write(`marketplace.json: ${(marketplace.plugins || []).length} plugin sources resolve.\n`);
    return 0;
  }

  process.stderr.write("\nmarketplace.json / plugin source mismatch:\n\n");
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.stderr.write("\n");
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main, verify };
