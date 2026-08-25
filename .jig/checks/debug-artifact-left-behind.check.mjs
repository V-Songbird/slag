// jig:authored — proved against the fixture pair inline at the foot of this
// file. Edit either half and the proof hash stops matching.

export const id = "debug-artifact-left-behind";
export const title = "Debug output or breakpoint left in the code";
export const severity = "hygiene";

export const detectors = [
  {
    "lever": "check-driver",
    "runner": "checks",
    "actor": "human-editor",
    "confidence": "deterministic",
    "params": {
      "patterns": [
        "\\bconsole\\s*\\.\\s*(?:log|debug|dir|trace|table|count|time|timeEnd)\\s*\\(",
        "\\bdebugger\\s*;"
      ],
      "paths": [
        "*/scripts/**/*.js",
        "*/hooks/**/*.js",
        "*/scripts/*.js",
        "*/hooks/*.js"
      ],
      "stripComments": true,
      "stripStrings": true,
      "perLine": false
    }
  }
];

export const deny = {
  "reason": "Debug output or breakpoint left in the code. Adds console.log tracing while diagnosing and ships it with the fix.",
  "alternative": "A CLI whose entire job is printing to stdout will match constantly, so tool entry points need excluding by path or the class becomes noise. Fix the occurrence, or narrow this guard's paths in .jig/config.json if it is wrong about this file.",
  "override": "Change the paths on this check, or retire it in /jig:review, if it turns out to be wrong here more often than right."
};

// The pair this check was admitted on, inline so it reverts with the check
// and the selftest stays re-runnable forever.
export const fixtures = {
  "violation": "export function reconcile(local, remote) {\n  console.log('reconcile called', { local, remote });\n  const merged = { ...remote, ...local };\n  if (merged.version !== remote.version) {\n    debugger;\n    console.table(merged);\n  }\n  return merged;\n}\n",
  "nearMiss": "import { createLogger } from './logger.js';\n\nconst logger = createLogger('reconcile');\nlet debuggerAttached = false;\n\nexport function reconcile(local, remote) {\n  logger.debug({ local, remote }, 'reconcile called');\n  const merged = { ...remote, ...local };\n  if (merged.version !== remote.version) {\n    console.warn('version drift detected');\n    debuggerAttached = true;\n  }\n  return { ...merged, debuggerAttached };\n}\n"
};

export function check(ctx) {
  const det = detectors.find((d) => d.lever === "check-driver");
  return ctx.scan(id, det.params.paths, det.params.patterns, det.params);
}
