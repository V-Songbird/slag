"use strict";

// [Foreman: 080] Levels 4 and 5 of the enforcement ladder, shared by every host
// adapter.
//
// 077 wrote this inside adapters/claude.js with a razor note: npm scripts,
// pre-commit config, a git hooksPath and CI workflow files are not a Claude Code
// concept, and the copy would be worth extracting once a second profile had real
// rungs to hang off it. 080 gave the Codex profile those rungs, so it lives here
// and both adapters call it. Discovery an adapter wants to add on top stays in
// that adapter — this file knows about repositories, not hosts.
//
// Conservative and mechanical throughout: a name in a manifest, a file that
// exists. Nothing here is opened to decide whether it would pass, and every read
// fails open — an unreadable file is skipped, an unreadable directory that exists
// is reported as inaccessible rather than counted as empty.

const fs = require("fs");
const path = require("path");

const REPO_SCRIPT_NAMES = ["check", "format", "lint", "test"];

function exists(abs) {
  try {
    return fs.existsSync(abs);
  } catch {
    return false;
  }
}

function discoverRepoChecks(root) {
  const checks = [];
  const inaccessible = [];

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
    for (const name of REPO_SCRIPT_NAMES) {
      if (typeof scripts[name] === "string" && scripts[name].trim()) {
        checks.push({ type: "repo-check", name: "npm script: " + name, path: "package.json" });
      }
    }
  } catch {
    // absent or malformed — no manifest checks
  }

  for (const name of [".pre-commit-config.yaml", ".pre-commit-config.yml"]) {
    if (exists(path.join(root, name))) checks.push({ type: "repo-check", name, path: name });
  }

  // Read textually, never through `git config`: no subprocess, and the same
  // answer on every platform.
  try {
    const cfg = fs.readFileSync(path.join(root, ".git", "config"), "utf-8");
    const m = cfg.match(/^\s*hooksPath\s*=\s*(.+?)\s*$/m);
    if (m) checks.push({ type: "repo-check", name: "git hooks: " + m[1], path: ".git/config" });
  } catch {
    // no repo, or no readable config
  }

  const workflowDir = path.join(root, ".github", "workflows");
  if (exists(workflowDir)) {
    try {
      for (const name of fs.readdirSync(workflowDir).sort()) {
        if (/\.ya?ml$/.test(name)) {
          checks.push({ type: "remote-gate", name, path: ".github/workflows/" + name });
        }
      }
    } catch (err) {
      inaccessible.push({ path: ".github/workflows", reason: err.code || err.message });
    }
  }

  return { checks, inaccessible };
}

module.exports = { discoverRepoChecks, REPO_SCRIPT_NAMES };
