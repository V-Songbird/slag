// jig:authored — proved against the fixture pair inline at the foot of this
// file. Edit either half and the proof hash stops matching.

export const id = "focused-test";
export const title = "Focused test left in the suite";
export const severity = "safety";

export const detectors = [
  {
    "lever": "check-driver",
    "runner": "checks",
    "actor": "human-editor",
    "confidence": "deterministic",
    "params": {
      "patterns": [
        "\\b(?:describe|it|test|suite|bench)\\s*\\.\\s*only\\s*[\\(`]",
        "\\b(?:describe|it|test)\\s*\\.\\s*(?:concurrent|sequential|each)\\s*\\.\\s*only\\b"
      ],
      "paths": [
        "*/tests/*.test.js",
        "*/tests/*.test.mjs"
      ],
      "stripComments": true,
      "stripStrings": true,
      "perLine": false
    }
  }
];

export const deny = {
  "reason": "Focused test left in the suite. Adds .only to iterate on one failure and never removes it, so CI silently runs one test.",
  "alternative": "Run the one case locally with the runner's own filter flag, then drop the .only before you commit. If this guard is wrong about this file, narrow its paths in .jig/config.json.",
  "override": "Change the paths on this check, or retire it in /jig:review, if it turns out to be wrong here more often than right."
};

// The pair this check was admitted on, inline so it reverts with the check
// and the selftest stays re-runnable forever.
export const fixtures = {
  "violation": "import { describe, it, expect } from 'vitest';\nimport { normalise } from '../src/text.js';\n\ndescribe('normalise', () => {\n  it.only('collapses runs of whitespace', () => {\n    expect(normalise('a   b')).toBe('a b');\n  });\n\n  it.concurrent.only('trims the ends', () => {\n    expect(normalise('  a  ')).toBe('a');\n  });\n\n  it('strips zero-width joiners', () => {\n    expect(normalise('a\\u200db')).toBe('ab');\n  });\n});\n",
  "nearMiss": "import { describe, it, expect } from 'vitest';\nimport { normalise } from '../src/text.js';\n\nconst only = (xs) => xs.filter(Boolean);\nconst matcher = { only: true };\n\ndescribe('normalise', () => {\n  it('collapses runs of whitespace', () => {\n    expect(normalise('a   b')).toBe('a b');\n    expect(only([null, 'a'])).toStrictEqual(['a']);\n    expect(matcher.only).toBe(true);\n  });\n});\n"
};

export function check(ctx) {
  const det = detectors.find((d) => d.lever === "check-driver");
  return ctx.scan(id, det.params.paths, det.params.patterns, det.params);
}
