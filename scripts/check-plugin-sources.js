#!/usr/bin/env node
"use strict";

// CI check: every marketplace.json plugin entry must point at a real plugin
// directory in this repo, and that directory's plugin.json must agree on the
// name. Plugins here live in-tree (relative "./name" sources), so there are
// no submodule pointers or source.sha pins to verify -- a typo'd path or a
// renamed directory is the whole failure mode, and it fails silently at
// install time rather than at push time.
//
// The Codex marketplace gets the same treatment. One plugin directory serves
// both hosts: Claude Code reads .claude-plugin/, Codex reads .codex-plugin/ and
// the local sources listed in .agents/plugins/marketplace.json.

const fs = require("fs");
const path = require("path");

const MARKETPLACE_PATH = path.join(".claude-plugin", "marketplace.json");
const CODEX_MARKETPLACE_PATH = path.join(".agents", "plugins", "marketplace.json");

const IDENTIFIER = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const INSTALLATION = ["AVAILABLE", "NOT_AVAILABLE", "INSTALLED_BY_DEFAULT"];
const AUTHENTICATION = ["ON_INSTALL", "ON_USE"];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

// A path Codex honours is "./"-relative and stays inside the plugin. Anything
// else is ignored by Codex, and for `hooks` that means falling back to
// hooks/hooks.json, which in a dual-host plugin is Claude Code's wiring.
function codexPathProblems(label, dir, value) {
  const problems = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (typeof entry !== "string") continue;
    if (!entry.startsWith("./") || entry.split(/[\\/]/).includes("..")) {
      problems.push(label + " " + JSON.stringify(entry) + " must start with \"./\" and stay inside the plugin");
    } else if (!fs.existsSync(path.join(dir, entry))) {
      problems.push(label + " " + JSON.stringify(entry) + " names nothing on disk");
    }
  }
  return problems;
}

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
      manifest = readJson(manifestPath);
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

    // A Codex manifest carries its own required version field. It must match
    // the marketplace entry, or the Codex package announces a stale release.
    const codexPath = path.join(root, source, ".codex-plugin", "plugin.json");
    if (fs.existsSync(codexPath)) {
      let codex;
      try {
        codex = readJson(codexPath);
      } catch (err) {
        problems.push(`"${entry.name}": ${source}/.codex-plugin/plugin.json is not valid JSON -- ${err.message}`);
        continue;
      }
      if (codex.name !== entry.name) {
        problems.push(`"${entry.name}": ${source}/.codex-plugin/plugin.json declares name "${codex.name}"`);
      }
      if (codex.version !== entry.version) {
        problems.push(`"${entry.name}": ${source}/.codex-plugin/plugin.json version "${codex.version}" does not match marketplace version "${entry.version}"`);
      }
      for (const key of ["skills", "hooks"]) {
        if (codex[key] === undefined) continue;
        for (const p of codexPathProblems(key, path.join(root, source), codex[key])) {
          problems.push(`"${entry.name}": ${source}/.codex-plugin/plugin.json ${p}`);
        }
      }
    }
  }
  return problems;
}

// The Codex marketplace lists local sources only. Each must resolve to a plugin
// whose Codex manifest names it, and carry the policy fields Codex requires.
function verifyCodex(root, marketplace) {
  if (!marketplace || typeof marketplace.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(marketplace.name) ||
      !Array.isArray(marketplace.plugins)) {
    return ["the Codex marketplace needs a valid name and a plugins array"];
  }
  const problems = [];
  const names = new Set();
  for (const entry of marketplace.plugins) {
    if (!entry || typeof entry.name !== "string" || !IDENTIFIER.test(entry.name)) {
      problems.push("a Codex marketplace entry needs a valid name");
      continue;
    }
    const label = `"${entry.name}" (Codex)`;
    if (names.has(entry.name)) problems.push(`${label}: listed twice`);
    names.add(entry.name);
    const rel = entry.source && entry.source.path;
    if (!entry.source || entry.source.source !== "local" || typeof rel !== "string" ||
        !(rel === "." || rel.startsWith("./")) || rel.split(/[\\/]/).includes("..")) {
      problems.push(`${label}: source must be { "source": "local", "path": "./<dir>" } inside this repo`);
      continue;
    }
    if (!entry.policy || !INSTALLATION.includes(entry.policy.installation) || !AUTHENTICATION.includes(entry.policy.authentication) ||
        typeof entry.category !== "string" || !entry.category.trim()) {
      problems.push(`${label}: installation policy, authentication policy and category are required`);
    }
    const manifestPath = path.join(root, rel, ".codex-plugin", "plugin.json");
    if (!fs.existsSync(manifestPath)) {
      problems.push(`${label}: ${rel} has no .codex-plugin/plugin.json`);
      continue;
    }
    try {
      const manifest = readJson(manifestPath);
      if (manifest.name !== entry.name) problems.push(`${label}: ${rel}/.codex-plugin/plugin.json declares name "${manifest.name}"`);
    } catch (err) {
      problems.push(`${label}: ${rel}/.codex-plugin/plugin.json is not valid JSON -- ${err.message}`);
    }
  }
  return problems;
}

function main() {
  const root = process.cwd();
  const marketplace = readJson(path.join(root, MARKETPLACE_PATH));
  const problems = verify(root, marketplace);
  const codexFile = path.join(root, CODEX_MARKETPLACE_PATH);
  let codex = null;
  if (fs.existsSync(codexFile)) {
    try {
      codex = readJson(codexFile);
      problems.push(...verifyCodex(root, codex));
    } catch (err) {
      problems.push(`${CODEX_MARKETPLACE_PATH} is not valid JSON -- ${err.message}`);
    }
  }

  if (problems.length === 0) {
    process.stdout.write(`marketplace.json: ${(marketplace.plugins || []).length} plugin sources resolve.\n`);
    if (codex) process.stdout.write(`${codex.name}: ${codex.plugins.length} Codex plugin sources resolve.\n`);
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

module.exports = { main, verify, verifyCodex };
