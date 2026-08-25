"use strict";

// [Foreman: 160] The model-profile seam. Every scoring weight and threshold the
// engine reads comes from a resolved profile rather than a module-level
// constant, so a later slice can add a second column without touching a read
// site. Today there is exactly one profile and it reproduces the shipped
// numbers exactly — resolving with no argument is the only call the engine
// makes, and there is no flag or CLI surface that changes it yet.

const haiku45 = require("./haiku45.js");

const PROFILES = Object.freeze({ haiku45 });
const DEFAULT_PROFILE = "haiku45";

function resolveProfile(id = DEFAULT_PROFILE) {
  const profile = PROFILES[id];
  if (!profile) throw new Error(`unknown model profile: ${id}`);
  return profile;
}

module.exports = { PROFILES, DEFAULT_PROFILE, resolveProfile };
