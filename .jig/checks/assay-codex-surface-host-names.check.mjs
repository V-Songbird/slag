// jig:authored — proved against the fixture pair inline at the foot of this
// file. Edit either half and the proof hash stops matching.

export const id = "assay-codex-surface-host-names";
export const title = "The Codex surface names the other host or a model";
export const severity = "safety";

export const detectors = [
  {
    "lever": "check-driver",
    "runner": "checks",
    "actor": "human-editor",
    "confidence": "deterministic",
    "params": {
      "patterns": [
        "\\b(?:[Cc]laude|CLAUDE|[Oo]pus|OPUS|[Ss]onnet|[Hh]aiku|[Ff]able)\\b"
      ],
      "paths": [
        "assay/codex-skills/**/*.md",
        "assay/references/**/*.md",
        "assay/.codex-plugin/**/*.json"
      ],
      "stripComments": false,
      "stripStrings": false,
      "perLine": true
    }
  }
];

export const deny = {
  "reason": "One plugin directory installs on both hosts, and on each it must work with zero awareness of the other. A session on the other host that reads a vendor or model name here has learned about a host it cannot use.",
  "alternative": "Say 'this host' or name the capability instead. Host-specific wording belongs under assay/skills/, which the other host never loads.",
  "override": "None. This is a ratified packaging decision, not a preference."
};

// The pair this check was admitted on, inline so it reverts with the check
// and the selftest stays re-runnable forever.
export const fixtures = {
  "violation": "# Audit the loaded instruction files\n\nGrade every rule the way the Claude Code host would load it, and write the\nrewrites for Opus 5.\n",
  "nearMiss": "# Audit the loaded instruction files\n\nGrade every rule the way this host loads it. Name no vendor and no model:\nthe host reading this page must never learn a sibling command exists.\n\nThese near words are ordinary prose and must not trip the guard:\nclaudication, opuscule, sonnetize, haikuesque, fabled.\n"
};

export function check(ctx) {
  const det = detectors.find((d) => d.lever === "check-driver");
  return ctx.scan(id, det.params.paths, det.params.patterns, det.params);
}
