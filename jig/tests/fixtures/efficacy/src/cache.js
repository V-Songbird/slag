"use strict";

// Fixture: near-miss negative A for silent-catch. Never executed.
//
// Every catch below has a body that does something with the error. None of
// them is the defect, and none of them may be reported.

const fs = require("node:fs");

// Rethrows with the cause attached, so the error leaves the function.
function load(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error("cache at " + file + " is not valid JSON", { cause: err });
  }
}

// Logs and carries on. The catalogue says out loud that this shape is the same
// defect and that an empty-body pattern cannot see it, so it is a negative for
// the detector and a ceiling named in README.md rather than a claim of safety.
function warm(build, logger) {
  try {
    build();
  } catch (err) {
    logger.warn("cache warm failed", err);
  }
  return true;
}

// Handles by returning a fallback the caller can see is degraded.
function loadOr(file, fallback) {
  try {
    return load(file);
  } catch (err) {
    return { ...fallback, degraded: String(err.message) };
  }
}

module.exports = { load, warm, loadOr };
