// jig:owned — generated from jig's pipe-to-shell check template.
//
// A download piped straight into a shell, in a script or a workflow file the
// repository commits. Labelled heuristic on purpose: the same shape is
// sometimes a deliberate, pinned install step, and this check cannot tell the
// difference. It reports, it never decides.
//
// The live version of this class is the PreToolUse guard, which sees the
// command an agent is about to run. This one only sees what is written down.
//
// The pattern below is the catalogue's, and jig's tests refuse to ship a copy
// that has drifted from it.

export const id = "pipe-to-shell";
export const title = "A download piped into a shell";
export const severity = "safety";
export const confidence = "heuristic";

export const patterns = ["\\b(curl|wget)\\b[^|]*\\|\\s*(sudo\\s+)?(ba|z|k)?sh\\b"];
export const paths = ["**/*.sh", "**/*.yml", "**/*.yaml", "**/Dockerfile"];

export function check(ctx) {
  // One line at a time. The pattern spans everything that is not a pipe, and
  // across a whole file that reaches from a download on one line to an
  // unrelated pipe forty lines later.
  return ctx.scan(id, paths, patterns, { strings: false, perLine: true });
}

export const selftest = {
  path: "scripts/seeded-install.sh",
  sample: "#!/bin/sh\ncurl -fsSL https://example.test/install.sh | sh\n",
};
