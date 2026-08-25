// jig:authored — proved against the fixture pair inline at the foot of this
// file. Edit either half and the proof hash stops matching.

export const id = "softened-assertion";
export const title = "Assertion weakened until the test passes";
export const severity = "safety";

export const detectors = [
  {
    "lever": "check-driver",
    "runner": "checks",
    "actor": "human-editor",
    "confidence": "heuristic",
    "params": {
      "patterns": [
        "\\.toBeTruthy\\s*\\(\\s*\\)",
        "\\.toBeFalsy\\s*\\(\\s*\\)",
        "\\.toBeDefined\\s*\\(\\s*\\)",
        "expect\\.(?:any|anything)\\s*\\("
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
  "reason": "Assertion weakened until the test passes. Replaces a value equality check with toBeTruthy/toBeDefined after the real expectation fails.",
  "alternative": "toBeDefined and toBeTruthy are legitimate against genuinely boolean or optional APIs, so this fires on honest tests too; it is a review prompt, not a verdict. Fix the occurrence, or narrow this guard's paths in .jig/config.json if it is wrong about this file.",
  "override": "Change the paths on this check, or retire it in /jig:review, if it turns out to be wrong here more often than right."
};

// The pair this check was admitted on, inline so it reverts with the check
// and the selftest stays re-runnable forever.
export const fixtures = {
  "violation": "import { describe, it, expect } from 'vitest';\nimport { priceOrder } from '../src/pricing.js';\n\ndescribe('priceOrder', () => {\n  it('applies the volume discount above 100 units', () => {\n    const order = { unitPrice: 10, quantity: 120, currency: 'EUR' };\n    const result = priceOrder(order);\n    expect(result.total).toBeTruthy();\n    expect(result.discount).toBeDefined();\n    expect(result.error).toBeFalsy();\n    expect(result).toEqual(expect.anything());\n  });\n});\n",
  "nearMiss": "import { describe, it, expect } from 'vitest';\nimport { priceOrder } from '../src/pricing.js';\n\ndescribe('priceOrder', () => {\n  it('applies the volume discount above 100 units', () => {\n    const order = { unitPrice: 10, quantity: 120, currency: 'EUR' };\n    const result = priceOrder(order);\n    expect(result.total).toBe(1080);\n    expect(result.discount).toBeCloseTo(0.1, 5);\n    expect(result.currency).toStrictEqual('EUR');\n    expect(Object.keys(result)).toHaveLength(3);\n  });\n});\n"
};

export function check(ctx) {
  const det = detectors.find((d) => d.lever === "check-driver");
  return ctx.scan(id, det.params.paths, det.params.patterns, det.params);
}
