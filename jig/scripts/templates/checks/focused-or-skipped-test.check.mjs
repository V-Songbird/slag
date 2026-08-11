// jig:owned — generated from jig's focused-or-skipped-test check template.
//
// A focused or skipped test left behind in a committed test file. `.only(`
// silently stops every other test in the file from running, which is the
// failure that reads as a green suite.
//
// The patterns below are the catalogue's, and jig's tests refuse to ship a
// copy that has drifted from them.

export const id = "focused-or-skipped-test";
export const title = "A focused or skipped test committed to the suite";
export const severity = "safety";
export const confidence = "deterministic";

export const patterns = [
  "\\b(describe|it|test)\\.only\\s*\\(",
  "\\b(describe|it|test)\\.skip\\s*\\(",
  "\\bit\\.todo\\s*\\(",
];
export const paths = ["**/*.test.js", "**/*.test.mjs", "**/*.test.ts", "**/*.spec.js", "**/*.spec.ts"];

export function check(ctx) {
  return ctx.scan(id, paths, patterns, { strings: true });
}

export const selftest = {
  path: "seeded.test.js",
  sample: 'describe("seeded", () => {\n  it.only("runs alone", () => {});\n});\n',
};
