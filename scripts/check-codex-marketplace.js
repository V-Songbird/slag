#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const MARKETPLACE = path.join(".agents", "plugins", "marketplace.json");
const identifier = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;

function verify(root, marketplace) {
  const problems = [];
  if (!marketplace || typeof marketplace.name !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(marketplace.name) || !Array.isArray(marketplace.plugins)) {
    return ["marketplace requires a valid name and a plugins array"];
  }
  const names = new Set();
  const realRoot = fs.realpathSync(root);
  for (const entry of marketplace.plugins) {
    if (!entry || typeof entry.name !== "string" || !identifier.test(entry.name)) {
      problems.push("plugin entry requires a valid name");
      continue;
    }
    if (names.has(entry.name)) problems.push(entry.name + ": duplicate plugin entry");
    names.add(entry.name);
    const expected = "./plugins/" + entry.name;
    if (!entry.source || entry.source.source !== "local" || entry.source.path !== expected) {
      problems.push(entry.name + ": source.path must be " + expected + " with source local");
      continue;
    }
    if (!entry.policy || !["AVAILABLE", "NOT_AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(entry.policy.installation) ||
        !["ON_INSTALL", "ON_USE"].includes(entry.policy.authentication) ||
        typeof entry.category !== "string" || !entry.category.trim()) {
      problems.push(entry.name + ": installation policy, authentication policy and category are required");
    }
    const file = path.join(root, expected, ".codex-plugin", "plugin.json");
    try {
      const relative = path.relative(realRoot, fs.realpathSync(file));
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
        problems.push(entry.name + ": native manifest resolves outside this repository");
        continue;
      }
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      if (manifest.name !== entry.name) problems.push(entry.name + ": native manifest name does not match");
      if (typeof manifest.version !== "string" || !manifest.version.trim()) {
        problems.push(entry.name + ": native manifest requires a version");
      }
    } catch (error) {
      problems.push(entry.name + ": native manifest cannot be read: " + error.message);
    }
  }
  return problems;
}

function main(root = process.cwd()) {
  try {
    const marketplace = JSON.parse(fs.readFileSync(path.join(root, MARKETPLACE), "utf8"));
    const problems = verify(root, marketplace);
    if (problems.length) {
      process.stderr.write(problems.join("\n") + "\n");
      return 1;
    }
    process.stdout.write(marketplace.name + ": " + marketplace.plugins.length + " native plugin sources resolve.\n");
    return 0;
  } catch (error) {
    process.stderr.write("Codex marketplace: " + error.message + "\n");
    return 1;
  }
}
if (require.main === module) process.exitCode = main();
module.exports = { verify, main };
