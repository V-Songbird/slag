"use strict";

// Each test process keeps its temp files, and those of the scripts it runs, under its own root,
// <tmp>/anneal-tests/<pid>-XXXXXX, and removes the root when it exits. A run killed before then
// leaves its root behind; the next run removes every root whose process is gone.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Another test process may be removing the same root; the next run retries.
const discard = (dir) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
};

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const base = path.join(os.tmpdir(), "anneal-tests");
fs.mkdirSync(base, { recursive: true });
for (const name of fs.readdirSync(base)) {
  if (!alive(Number.parseInt(name, 10))) discard(path.join(base, name));
}
const root = fs.mkdtempSync(path.join(base, `${process.pid}-`));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = root;
process.on("exit", () => discard(root));
