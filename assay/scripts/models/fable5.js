"use strict";

// [Foreman: 161] Claude Fable 5 — an extrapolation, not a measurement.
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
  id: "fable5",
  displayName: "Claude Fable 5",

  weights: Object.freeze({
    // F1 hedged force: saturated well below this tier. Near-zero here.
    F1: 0.3,
    // F2 prohibition with nothing named instead: structural, and the one factor
    // this tier raises — a prohibition with no alternative leaves the most room
    // where the model elaborates the most.
    F2: 1.2,
    // F3 trigger-action distance: the wording lever loses ground up here.
    F3: 1.0,
    // F4 wrong scope: a loading fact, not a wording one. Unmoved.
    F4: 1.0,
    // F5 buried in the file: salience decay is structural. Unmoved.
    F5: 1.5,
    // F7 vague where a path or number belongs: an elaborating model needs a
    // verifiable constraint most, so this is the leading factor on this tier.
    F7: 2.4,
  }),

  thresholds: Object.freeze({
    softFloor: 0.2,
    buriedF5: 0.6,
    // F8 raised: on a capable model the leftover failures are exactly the ones
    // only a mechanism fixes, so more rules should be named as hook candidates.
    f8Hook: 0.5,
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
