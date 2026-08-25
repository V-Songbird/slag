"use strict";

// [Foreman: 160] The inherited default profile.
//
// Every number below is verbatim what `assay/scripts/assay.js` shipped as a
// module-level constant before this file existed. That is not a coincidental
// match: the composite weights and the thresholds around them were tuned
// against the rule-lab 2026-07 measurements, and those runs were haiku 4.5
// (n=20/arm) with sonnet 4.x spot checks only. So the shipped rubric has always
// BEEN the haiku 4.5 column — it simply had no name. Naming it here is the
// whole change; nothing is re-tuned, and no other tier is described.
//
// A later slice adds the other model columns. When rule-lab measures a
// Claude-5 tier, edit that tier's file, not this one, and bump RUBRIC_VERSION.
//
// Host facts stay out: MEMORY_INDEX_CAP, CONTEXT_PRESSURE_BYTES and the
// corpus-byte heuristics are properties of the host that loads the files, not
// of the model that reads them.

module.exports = Object.freeze({
  id: "haiku45",
  displayName: "Claude Haiku 4.5",

  // Composite weights and floors — the quality-heuristic contract.
  weights: Object.freeze({ F1: 1.5, F2: 1.0, F3: 1.3, F4: 1.0, F5: 1.5, F7: 2.0 }),

  thresholds: Object.freeze({
    // applied to F4 and F7
    softFloor: 0.2,
    // position only starts to bite in files long enough to bury their bottom rules
    buriedF5: 0.6,
    // F8 below this: a mechanism would enforce the rule better than prose
    f8Hook: 0.4,
    // F3 at or below this: the moment the rule fires has more than one reading
    ambiguousF3: 0.35,
    // F8 at or above this is the rubric's judgment-only ceiling — prose is the
    // right home for the policy, not a weaker place to have left it
    advisoryF8: 0.9,
    // placement detection: what counts as a candidate, and what counts as a
    // second signal firing alongside it
    placementCandidate: 0.6,
    placementCompound: 0.35,
    // a factor at or below this is named as a weakness in the per-rule table
    weakFactor: 0.6,
  }),
});
