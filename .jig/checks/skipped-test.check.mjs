// jig:authored — proved against the fixture pair inline at the foot of this
// file. Edit either half and the proof hash stops matching.

export const id = "skipped-test";
export const title = "Test skipped and left that way";
export const severity = "safety";

export const detectors = [
  {
    "lever": "check-driver",
    "runner": "checks",
    "actor": "human-editor",
    "confidence": "deterministic",
    "params": {
      "patterns": [
        "\\b(?:describe|it|test|suite|bench)\\s*\\.\\s*(?:skip|todo|failing)\\s*[\\(`]",
        "\\b(?:describe|it|test)\\s*\\.\\s*skipIf\\s*\\("
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
  "reason": "Test skipped and left that way. Marks a failing test .skip or .todo rather than diagnosing it, then reports the work complete.",
  "alternative": "The Jest/Jasmine spellings xit, xtest and xdescribe are not matched by regex — they are ordinary identifiers in a Vitest repo — so a Jest project must lean on jest/no-disabled-tests for those. Fix the occurrence, or narrow this guard's paths in .jig/config.json if it is wrong about this file.",
  "override": "Change the paths on this check, or retire it in /jig:review, if it turns out to be wrong here more often than right."
};

// The pair this check was admitted on, inline so it reverts with the check
// and the selftest stays re-runnable forever.
export const fixtures = {
  "violation": "import { describe, it, expect } from 'vitest';\nimport { retry } from '../src/retry.js';\n\ndescribe('retry', () => {\n  it.skip('gives up after the configured attempt budget', async () => {\n    await expect(retry(() => Promise.reject(new Error('nope')), 3)).rejects.toThrow();\n  });\n\n  it.todo('applies jitter to the backoff window');\n\n  it.skipIf(process.env.CI)('honours the abort signal', async () => {\n    await expect(retry(async () => 1, 1, AbortSignal.timeout(1))).rejects.toThrow();\n  });\n\n  it('resolves on the first success', async () => {\n    await expect(retry(async () => 7, 3)).resolves.toBe(7);\n  });\n});\n",
  "nearMiss": "import { describe, it, expect } from 'vitest';\nimport { paginate } from '../src/paginate.js';\n\ndescribe('paginate', () => {\n  it('honours the skip and take arguments', () => {\n    const page = paginate({ skip: 20, take: 10 });\n    expect(page.skip).toBe(20);\n    expect(page.cursor.skip).toBe(20);\n  });\n\n  it('treats a todo list as ordinary data', () => {\n    expect(paginate({ skip: 0, take: 1 }).items).toHaveLength(1);\n  });\n});\n"
};

export function check(ctx) {
  const det = detectors.find((d) => d.lever === "check-driver");
  return ctx.scan(id, det.params.paths, det.params.patterns, det.params);
}
