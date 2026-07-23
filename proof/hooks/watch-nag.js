#!/usr/bin/env node
"use strict";

// SessionStart nag — silent unless a saved fingerprint predates the current
// claude version/model, in which case it prints one short line suggesting a
// drift re-check. No API calls; reads the local fingerprint store and the local
// `claude --version`. Never breaks a session start: any error is swallowed.

const { readStore, currentEnv, nagLines } = require("../lib/watch");

try {
  const lines = nagLines(readStore(), currentEnv());
  for (const l of lines) process.stderr.write(l + "\n");
} catch { /* a monitor must never block the thing it monitors */ }

process.exit(0);
