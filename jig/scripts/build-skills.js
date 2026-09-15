#!/usr/bin/env node
"use strict";

// One source per skill file, two skill trees. Claude Code always loads
// `skills/`; Codex loads the `codex-skills/` its manifest names instead of its
// default. The procedure is written once under `skill-sources/`, and a
// whole-line marker keeps a passage to one host:
//
//   <!-- host: claude -->   only in skills/
//   <!-- host: codex -->    only in codex-skills/ (may directly follow a
//                           claude block, as its other half)
//   <!-- host: end -->      back to both
//
// Markers never nest. A source whose text for one host is empty writes no file
// for that host. Edit the source, never a generated file: `--check`, which the
// test suite runs, names every generated file that no longer matches.
//
//   node scripts/build-skills.js          write both trees
//   node scripts/build-skills.js --check  report drift and exit 1 on any

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SOURCES = path.join(ROOT, "skill-sources");
const TREES = { claude: path.join(ROOT, "skills"), codex: path.join(ROOT, "codex-skills") };
const MARKER = /^<!-- host: (claude|codex|end) -->$/;

function render(text, label = "source") {
  const out = { claude: [], codex: [] };
  let only = null;
  text.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
    const where = label + ":" + (i + 1);
    const marker = MARKER.exec(line);
    if (!marker) {
      if (line.startsWith("<!-- host:")) throw new Error(where + ": unknown host marker " + JSON.stringify(line));
      for (const host of only ? [only] : ["claude", "codex"]) out[host].push(line);
      return;
    }
    const next = marker[1];
    if (next === "end") {
      if (!only) throw new Error(where + ": `host: end` closes no block");
      only = null;
    } else if (next === "claude" && only) {
      throw new Error(where + ": `host: claude` inside an open " + only + " block");
    } else if (next === "codex" && only === "codex") {
      throw new Error(where + ": `host: codex` inside an open codex block");
    } else {
      only = next;
    }
  });
  if (only) throw new Error(label + ": the " + only + " block is never closed");
  return { claude: out.claude.join("\n"), codex: out.codex.join("\n") };
}

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  }).sort();
}

// Every file both trees should hold, keyed by host and tree-relative path.
function expected() {
  const files = { claude: new Map(), codex: new Map() };
  for (const rel of walk(SOURCES)) {
    const text = render(fs.readFileSync(path.join(SOURCES, rel), "utf8"), "skill-sources/" + rel);
    for (const host of Object.keys(files)) if (text[host]) files[host].set(rel, text[host]);
  }
  return files;
}

function drift() {
  const problems = [];
  const files = expected();
  for (const [host, want] of Object.entries(files)) {
    const tree = path.relative(ROOT, TREES[host]).split(path.sep).join("/");
    const have = new Set(walk(TREES[host]));
    for (const [rel, text] of want) {
      if (!have.has(rel)) problems.push(tree + "/" + rel + " is missing");
      else if (fs.readFileSync(path.join(TREES[host], rel), "utf8").replace(/\r\n/g, "\n") !== text) {
        problems.push(tree + "/" + rel + " differs from skill-sources/" + rel);
      }
    }
    for (const rel of have) if (!want.has(rel)) problems.push(tree + "/" + rel + " has no source");
  }
  return problems;
}

function build() {
  const files = expected();
  for (const [host, want] of Object.entries(files)) {
    for (const [rel, text] of want) {
      const target = path.join(TREES[host], rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
  }
  return drift();
}

if (require.main === module) {
  try {
    const problems = process.argv.includes("--check") ? drift() : build();
    for (const line of problems) process.stderr.write(line + "\n");
    process.exitCode = problems.length ? 1 : 0;
  } catch (err) {
    process.stderr.write("build-skills: " + err.message + "\n");
    process.exitCode = 1;
  }
}

module.exports = { render, expected, drift, build, SOURCES, TREES };
