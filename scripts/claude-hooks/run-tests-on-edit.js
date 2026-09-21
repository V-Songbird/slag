#!/usr/bin/env node
"use strict";

// Repo-wide dev hook (not shipped with any plugin): reruns whichever
// plugin's own test suite after an Edit/Write lands in that plugin's
// scripts/, hooks/ or templates/ dir, so a regression surfaces immediately
// instead of sitting silent until someone runs the suite by hand. There is no
// CI here, so this is the only thing that reruns a suite unasked. Registered
// in .claude/settings.json and .codex/hooks.json, not shipped with a plugin.
// Patch events can touch multiple plugins; each affected suite runs once.
//
// It lives under scripts/ rather than .claude/ so that `npm run check` finds
// its test file. Node 22's default discovery skips dot-directories, and every
// portable way of naming one back in double-counted or failed on node 20, the
// floor at the time --
// a suite nobody runs is the false comfort this repo refuses.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const WATCHED_TOOLS = new Set(["Edit", "Write", "apply_patch"]);
// templates/ is collet's: the .mjs files it mounts into a project, held by
// collet/tests/scope.test.js and mount.test.js. Editing one is a code change
// like any other, so it belongs here beside scripts/ and hooks/.
const WATCHED_SUBDIRS = new Set(["scripts", "hooks", "templates"]);

// Must stay under this hook's own `timeout` in .claude/settings.json -- Claude
// Code kills the whole hook at that mark. anneal's suite is the long pole here
// at ~10s, collet's at ~6s, both measured on v22.22.2, so the cap is headroom
// rather than a target. A suite slower than this reports "did not complete",
// not a verdict -- raise both numbers together if one gets that slow.
const TEST_TIMEOUT_MS = 110000;

function readInput() {
  let raw;
  try {
    raw = fs.readFileSync(0, "utf-8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function repoRoot(data = {}) {
  if (data.tool_name === "apply_patch") {
    const cwd = path.resolve(data.cwd || process.cwd());
    let dir = cwd;
    while (!fs.existsSync(path.join(dir, ".git"))) {
      const parent = path.dirname(dir);
      if (parent === dir) return cwd;
      dir = parent;
    }
    return dir; // .git can be a directory or a worktree pointer file.
  }
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

function editedPaths(data) {
  if (data.tool_name !== "apply_patch") return [data.tool_input?.file_path].filter(Boolean);
  const patch = data.tool_input?.command;
  if (typeof patch !== "string") return [];
  return [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)]
    .map((match) => match[1].trimEnd())
    .filter(Boolean)
    .map((file) => path.resolve(data.cwd || process.cwd(), file));
}

// The edited file's first path segment (relative to repo root) is the
// plugin folder, but only if the edit landed under THAT folder's own
// watched dir and the folder is confirmed to actually be a plugin
// (.claude-plugin/plugin.json present) -- not just any top-level repo
// directory that happens to contain a dir by one of those names.
//
// Both module flavours count: anneal is CommonJS .js, collet is ESM .js, and
// what collet mounts into a project is .mjs. A rule that only read .js would
// be blind to every template.
function findPluginRoot(root, filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(String(filePath));
  if (!/\.m?js$/i.test(resolved)) return null;
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length < 3) return null; // need <plugin>/<watched>/<file...>
  const [pluginDir, subDir] = parts;
  if (!WATCHED_SUBDIRS.has(subDir.toLowerCase())) return null;
  const pluginRoot = path.join(root, pluginDir);
  if (!fs.existsSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"))) return null;
  return pluginRoot;
}

// Discovery runs from inside the plugin, never from a path argument.
// `node --test <glob>` only expands on node 22+; on node 20, this repo's floor
// until 2026-09-21, it exits with "Could not find" and this hook would report
// a failed suite after every single edit. A bare
// `node --test` recurses from cwd and finds all 49 in anneal and 59 in collet
// on both v20.11.1 and v22.22.2.

// Strip node's own test-runner IPC markers before spawning the nested
// `node --test` -- inheriting NODE_TEST_CONTEXT (set when this hook's own
// test runs as an isolated child under `node --test`) makes the nested
// process misbehave and exit silently instead of reporting real results.
function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  return env;
}

function runTests(pluginRoot, timeout = TEST_TIMEOUT_MS) {
  if (timeout <= 0) return { passed: false, output: "Hook test budget exhausted before this suite started." };
  try {
    execSync("node --test", { cwd: pluginRoot, stdio: "pipe", timeout, env: cleanEnv() });
    return { passed: true };
  } catch (err) {
    const output = `${err.stdout || ""}${err.stderr || ""}` || err.message || "";
    return { passed: false, output: String(output) };
  }
}

function main() {
  const data = readInput();
  if (!WATCHED_TOOLS.has(data.tool_name)) return;

  const root = repoRoot(data);
  const plugins = new Map();
  for (const file of editedPaths(data)) {
    const pluginRoot = findPluginRoot(root, file);
    if (pluginRoot && fs.existsSync(path.join(pluginRoot, "tests"))) {
      if (!plugins.has(pluginRoot)) plugins.set(pluginRoot, new Set());
      plugins.get(pluginRoot).add(path.basename(file));
    }
  }
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  const feedback = [];
  for (const [pluginRoot, files] of plugins) {
    const result = runTests(pluginRoot, deadline - Date.now());
    if (result.passed) continue; // silent on green
    feedback.push(failureContext(pluginRoot, [...files].join(", "), result));
  }
  if (!feedback.length) return;
  const payload = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: feedback.join("\n"),
    },
  };
  process.stdout.write(Buffer.from(JSON.stringify(payload), "utf-8"));
}

function failureContext(pluginRoot, edited, result) {
  const stats = (result.output.match(/^# (?:tests|pass|fail) .+$/gm) || []).join("; ");
  const pluginName = path.basename(pluginRoot);

  // No TAP summary means the run never reached a verdict -- killed by the
  // timeout, or node bailed before the first test. Say so rather than blame a
  // test that never ran.
  const verdict = stats ? "failed" : "did not complete";
  const detail = stats || result.output.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300);

  return `[slag] node --test ${pluginName}/ ${verdict} after this edit to ${edited}. ` +
    `${detail} Run \`node --test\` from ${pluginName}/ for the full trace before moving on.`;
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.exit(0);
  }
}

module.exports = { main, findPluginRoot, runTests, repoRoot, editedPaths };
