// jig:authored — proved against the fixture pair inline at the foot of this
// file. Edit either half and the proof hash stops matching.

export const id = "assay-profile-evidence-tier";
export const title = "A model profile claims measured evidence nothing measured";
export const severity = "safety";

export const detectors = [
  {
    "lever": "check-driver",
    "runner": "checks",
    "actor": "human-editor",
    "confidence": "deterministic",
    "params": {
      "patterns": [
        "level:\\s*[\"'](?:mechanical|documented|experiment-supported)[\"']"
      ],
      "paths": [
        "assay/scripts/models/**/*.js"
      ],
      "stripComments": true,
      "stripStrings": false,
      "perLine": true
    }
  }
];

export const deny = {
  "reason": "A model profile constant may only claim the evidence it actually has. No Claude-5 tier has been measured, so mechanical, documented and experiment-supported are all false claims here.",
  "alternative": "Use level: \"profile-inferred\" and fill in basis and limits, saying what argued for the number and what it does not cover.",
  "override": "Delete this guard in .jig/config.json once rule-lab has measured the tier and the citation is real."
};

// The pair this check was admitted on, inline so it reverts with the check
// and the selftest stays re-runnable forever.
export const fixtures = {
  "violation": "export const profile = Object.freeze({\n  id: \"tier-b\",\n  weights: { F1: 0.3, F3: 1.0, F7: 2.2 },\n  evidence: {\n    level: \"experiment-supported\",\n    basis: \"read across from the 2026-07 wording studies\",\n  },\n});\n",
  "nearMiss": "// Never write level: \"documented\" or level: \"mechanical\" in this file.\n// Nothing has measured this tier, and saying otherwise is a false claim.\nexport const profile = Object.freeze({\n  id: \"tier-a\",\n  weights: { F1: 1.5, F3: 1.5, F7: 1.8 },\n  evidence: {\n    level: \"profile-inferred\",\n    basis: \"the 2026-07 wording studies, one tier only\",\n    limits: \"not measured on this tier; a ranking, never a compliance claim\",\n  },\n});\n"
};

export function check(ctx) {
  const det = detectors.find((d) => d.lever === "check-driver");
  return ctx.scan(id, det.params.paths, det.params.patterns, det.params);
}
