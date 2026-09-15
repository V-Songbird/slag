#!/usr/bin/env node
"use strict";

// Produce an isolated local marketplace. Never install into or rewrite a user's
// Codex configuration, and never reuse a destination with existing contents.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
// What the Codex host loads from this directory. The Claude Code skill tree is
// not Codex's, and internal notes never ship.
const COMPONENTS = [".codex-plugin", "hooks", "codex-skills", "scripts", "catalogues", "assets", "README.md", "CHANGELOG.md", "LICENSE"];

function packageCodex(destination) {
  if (typeof destination !== "string" || !destination.trim()) throw new Error("name an output directory with --out <directory>");
  const out = path.resolve(destination);
  if (fs.existsSync(out)) throw new Error("output already exists: " + out + "; choose a new directory");
  // Resolve existing parent links before writing. An output inside a copied
  // component would otherwise copy itself recursively while packaging.
  let ancestor = out;
  const tail = [];
  while (!fs.existsSync(ancestor)) {
    tail.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  const resolvedOut = path.join(fs.realpathSync(ancestor), ...tail);
  for (const component of COMPONENTS) {
    const source = path.join(ROOT, component);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) continue;
    const relative = path.relative(fs.realpathSync(source), resolvedOut);
    if (relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))) {
      throw new Error("output is inside a packaged source directory: " + component);
    }
  }
  const plugin = path.join(out, "plugins", "jig");
  // Refuse symlinked source entries rather than copying bytes from outside Jig.
  function copy(source, target) {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error("package source is a symbolic link: " + source);
    if (stat.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(source).sort()) copy(path.join(source, name), path.join(target, name));
    } else if (stat.isFile()) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      fs.chmodSync(target, stat.mode);
    } else throw new Error("package source is not a regular file: " + source);
  }
  for (const entry of COMPONENTS) {
    const source = path.join(ROOT, entry);
    if (fs.existsSync(source)) copy(source, path.join(plugin, entry));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
  const marketplacePath = path.join(out, ".agents", "plugins", "marketplace.json");
  fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
  fs.writeFileSync(marketplacePath, JSON.stringify({
    name: "jig-local",
    interface: { displayName: "Jig local" },
    plugins: [{
      name: manifest.name,
      source: { source: "local", path: "./plugins/jig" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  }, null, 2) + "\n");
  return { root: out, plugin, marketplacePath, version: manifest.version };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--out") throw new Error("usage: node scripts/package-codex.js --out <new-directory>");
    process.stdout.write(JSON.stringify(packageCodex(args[1]), null, 2) + "\n");
  } catch (error) {
    process.stderr.write("jig: " + error.message + "\n");
    process.exitCode = 1;
  }
}

module.exports = { packageCodex };
