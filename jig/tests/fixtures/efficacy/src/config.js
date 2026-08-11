"use strict";

// Fixture: the seeded silent-catch violation. Never executed.
//
// Three shapes, all of them the same defect: the error stops here and nothing
// downstream can tell that anything went wrong.

const fs = require("node:fs");

const DEFAULTS = { retries: 3, timeoutMs: 2000 };

// Shape 1 — a bound error, discarded.
function readOverrides(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
  }
  return { ...DEFAULTS };
}

// Shape 2 — a bare catch with nothing in it at all.
function readVersion(file) {
  let raw = null;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {}
  return raw;
}

// Shape 3 — a body that holds only a comment. This fixture scores it as a
// CATCH and not as a false positive, and README.md carries the reasoning: the
// comment runs no code, so the error is swallowed exactly as it is in shape 1.
function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    // the cache is optional
  }
  return null;
}

module.exports = { DEFAULTS, readOverrides, readVersion, readCache };
