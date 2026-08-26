"use strict";

// [Foreman: 160] The model-profile seam. Every scoring weight and threshold the
// engine reads comes from a resolved profile rather than a module-level
// constant, so a later slice can add a second column without touching a read
// site. Resolving with no argument is still the only call the engine makes, and
// there is no flag or CLI surface that changes it yet.

const haiku45 = require("./haiku45.js");
const sonnet5 = require("./sonnet5.js");
const opus5 = require("./opus5.js");
const fable5 = require("./fable5.js");

// [Foreman: 161] Four columns now. haiku45 is still the default and still the
// only measured one; the other three declare `profile-inferred` evidence on
// every constant they ship.
const PROFILES = Object.freeze({ haiku45, sonnet5, opus5, fable5 });
const DEFAULT_PROFILE = "haiku45";

function resolveProfile(id = DEFAULT_PROFILE) {
  const profile = PROFILES[id];
  if (!profile) throw new Error(`unknown model profile: ${id}`);
  return profile;
}

module.exports = { PROFILES, DEFAULT_PROFILE, resolveProfile };
