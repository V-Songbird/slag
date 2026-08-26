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
// [Foreman: 172] rule-lab measured this tier on 2026-08-25 — exp-010-claude5,
// 440 cells, n=20 per arm, two intents per contrast, every intent anti-default
// at baseline 0.00. Three constants stop being inferred:
//
//   - POSITION IS NULL HERE. A rule at the bottom of an ~80-line CLAUDE.md was
//     followed exactly as often as the same rule at the top: 1.00 against 1.00,
//     in both intents. On haiku 4.5 the same contrast fell to 0.65 and 0.15.
//   - VERB FORCE IS NULL HERE. "Prefer to X" scored 1.00, identical to
//     "Always X", in both intents. On haiku 4.5 "prefer" halved compliance.
//   - THE BARE PROHIBITION STILL COSTS SOMETHING. Naming no alternative scored
//     0.60 where naming one scored 1.00 — but in one intent of two; the other
//     reached 1.00 either way. Weaker than on haiku 4.5 and not retired.
//
// Read those three as ceiling results, because that is what they are: once a
// rule was present at all, this tier followed it. They say the wording lever
// stops separating outcomes here, not that a badly placed rule became good.
// Everything else below is still `profile-inferred`.
//
// When rule-lab measures more of this tier, edit this file and bump
// RUBRIC_VERSION.
//
// Host facts stay out, exactly as in haiku45.js.

module.exports = Object.freeze({
  id: "sonnet5",
  displayName: "Claude Sonnet 5",

  weights: Object.freeze({
    // [Foreman: 172] F1 hedged force: measured NULL on this tier — "prefer to"
    // and "always" were indistinguishable at 1.00 in both intents. It keeps a
    // small weight because a hedge still tells a HUMAN reader the duty is
    // optional; it no longer leads a report here.
    F1: 0.3,
    // [Foreman: 172] F2 prohibition with nothing named instead: the one wording
    // lever that still separated outcomes on this tier (0.60 against 1.00),
    // though in one intent of two. Unmoved.
    F2: 1.0,
    // F3 trigger-action distance: still the top wording lever below opus.
    F3: 1.3,
    // F4 wrong scope: a loading fact, not a wording one. Unmoved.
    F4: 1.0,
    // [Foreman: 172] F5 buried in the file: measured NULL on this tier — top
    // and bottom of an ~80-line file both scored 1.00, in both intents. Kept
    // above zero because burial is still a fact about the file a reader should
    // hear, and because the cap is a loading fact rather than a wording one.
    F5: 0.5,
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
    basis: "the rule-lab 2026-07 haiku 4.5 measurements, read across by the direction-of-effect argument in the 2026-08-25 mechanics report; F1, F2 and F5 are measured on this tier by rule-lab exp-010-claude5, 2026-08-25, 440 cells at n=20 per arm",
    limits: "F1 and F5 are measured NULL here and F2 replicated in one intent of two, all three against a ceiling: once a rule was present this tier followed it. Every other magnitude is unmeasured on this tier and orders which structural findings lead the report, never what this model will obey",
    // Every constant this profile ships, and the evidence it actually has.
    constants: Object.freeze({
      // [Foreman: 172] exp-010-claude5, 2026-08-25: measured on this tier.
      "weights.F1": "experiment-supported",
      "weights.F2": "experiment-supported",
      "weights.F3": "profile-inferred",
      "weights.F4": "profile-inferred",
      "weights.F5": "experiment-supported",
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
