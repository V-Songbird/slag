#!/usr/bin/env node
"use strict";

// Expand the test list ourselves: Windows shells and older supported Node
// releases do not consistently expand tests/*.test.js.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const codexOnly = args.includes("--codex");
const toolchains = args.includes("--toolchains");
const files = fs.readdirSync(path.join(root, "tests"))
  .filter((name) => name.endsWith(".test.js") && (!codexOnly || name.startsWith("codex-")))
  .sort().map((name) => path.join(root, "tests", name));
if (!files.length) throw new Error("no Jig tests found");
const result = spawnSync(process.execPath, ["--test", ...args.filter((arg) => arg !== "--codex" && arg !== "--toolchains"), ...files],
  { cwd: root, stdio: "inherit", windowsHide: true,
    env: { ...process.env, ...(toolchains ? { JIG_TOOLCHAIN_SMOKE: "1" } : {}) } });
if (result.error) process.stderr.write(result.error.message + "\n");
process.exitCode = result.status === null ? 1 : result.status;
