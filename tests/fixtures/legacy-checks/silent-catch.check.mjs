// jig:owned — generated from jig's silent-catch check template.
//
// A catch block with an empty body. The pattern below is the catalogue's, and
// jig's tests refuse to ship a copy that has drifted from it.
//
// What it does not see: a catch whose body only logs and carries on. That is
// the same defect and it needs a real parser, so it is out of scope here and
// said so out loud rather than counted as covered.

export const id = "silent-catch";
export const title = "A catch block that swallows the error";
export const severity = "safety";
export const confidence = "deterministic";

export const patterns = ["catch\\s*(\\([^)]*\\))?\\s*\\{\\s*\\}"];
export const paths = ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx"];

export function check(ctx) {
  return ctx.scan(id, paths, patterns, { strings: true });
}

export const selftest = {
  path: "src/silent-catch-seed.js",
  sample: "function seeded() {\n  try {\n    risky();\n  } catch (err) {\n  }\n}\n",
};
