"use strict";

// [Foreman: 161] Claude Sonnet 5 — an extrapolation, not a measurement.
//
// Read `haiku45.js` first: it is the only profile whose numbers were tuned
// against a measured tier. This column moves away from it in the DIRECTION the
// two available sources argue for, and no further:
//
//   1. rule-lab 2026-07 (docs/research/rule-lab/FINDINGS.md) — wording severity
//      moves the needle on haiku 4.5 and had already saturated on sonnet 4.x.
//      Measured, but on another tier.
//   2. The mechanics report of 2026-08-25 — prohibitions are structurally
//      weaker than prescriptions, salience decays across a conversation,
//      unverifiable constraints have nothing to converge on, and raising
//      capability LOWERS format-constraint adherence because a more capable
//      model elaborates more. A mechanism account, self-described as
//      non-introspective. It orders factors; it never supplies a number.
//
// So every magnitude below is `profile-inferred`. It is a weighting of which
// structural findings lead the report, never a claim about what this model will
// obey. When rule-lab measures this tier, edit this file and bump
// RUBRIC_VERSION.
//
// Host facts stay out, exactly as in haiku45.js.

module.exports = Object.freeze({
  id: "sonnet5",
  displayName: "Claude Sonnet 5",

  weights: Object.freeze({
    // F1 hedged force: saturated at sonnet 4.x, so it earns far less here.
    F1: 0.6,
    // F2 prohibition with nothing named instead: structural. Unmoved.
    F2: 1.0,
    // F3 trigger-action distance: still the top wording lever below opus.
    F3: 1.3,
    // F4 wrong scope: a loading fact, not a wording one. Unmoved.
    F4: 1.0,
    // F5 buried in the file: salience decay is structural. Unmoved.
    F5: 1.5,
    // F7 vague where a path or number belongs: rises with capability.
    F7: 2.0,
  }),

  // Thresholds carry over from the measured column unchanged: nothing in either
  // source argues for moving them on this tier, and inventing a second set of
  // magnitudes would be a false claim on top of an inferred one.
  thresholds: Object.freeze({
    softFloor: 0.2,
    buriedF5: 0.6,
    f8Hook: 0.4,
    ambiguousF3: 0.35,
    advisoryF8: 0.9,
    placementCandidate: 0.6,
    placementCompound: 0.35,
    weakFactor: 0.6,
  }),

  evidence: Object.freeze({
    level: "profile-inferred",
    basis: "the rule-lab 2026-07 haiku 4.5 measurements, read across by the direction-of-effect argument in the 2026-08-25 mechanics report",
    limits: "not measured on this tier; a weighting of which structural findings matter most, never a claim about what this model will obey",
    // Every constant this profile ships, and the evidence it actually has.
    constants: Object.freeze({
      "weights.F1": "profile-inferred",
      "weights.F2": "profile-inferred",
      "weights.F3": "profile-inferred",
      "weights.F4": "profile-inferred",
      "weights.F5": "profile-inferred",
      "weights.F7": "profile-inferred",
      "thresholds.softFloor": "profile-inferred",
      "thresholds.buriedF5": "profile-inferred",
      "thresholds.f8Hook": "profile-inferred",
      "thresholds.ambiguousF3": "profile-inferred",
      "thresholds.advisoryF8": "profile-inferred",
      "thresholds.placementCandidate": "profile-inferred",
      "thresholds.placementCompound": "profile-inferred",
      "thresholds.weakFactor": "profile-inferred",
    }),
  }),
});
