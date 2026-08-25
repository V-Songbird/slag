// jig:authored — proved against the fixture pair inline at the foot of this
// file. Edit either half and the proof hash stops matching.

export const id = "blanket-lint-suppression";
export const title = "Lint suppressed for a whole file or line without a reason";
export const severity = "safety";

export const detectors = [
  {
    "lever": "check-driver",
    "runner": "checks",
    "actor": "human-editor",
    "confidence": "deterministic",
    "params": {
      "patterns": [
        "/\\*\\s*eslint-disable\\s*(?![^*\\n]*--)[^*\\n]*\\*/",
        "//\\s*eslint-disable-(?:next-)?line(?![^\\n]*--)"
      ],
      "paths": [
        "*/scripts/**/*.js",
        "*/hooks/**/*.js",
        "*/scripts/*.js",
        "*/hooks/*.js"
      ],
      "stripComments": false,
      "stripStrings": true,
      "perLine": false
    }
  }
];

export const deny = {
  "reason": "Lint suppressed for a whole file or line without a reason. Puts /* eslint-disable */ at the top of a file to clear every remaining error at once.",
  "alternative": "The check matches a file-wide `/* eslint-disable */` and an inline `eslint-disable-line` or `eslint-disable-next-line` written without a `--` reason. Fix the occurrence, or narrow this guard's paths in .jig/config.json if it is wrong about this file.",
  "override": "Change the paths on this check, or retire it in /jig:review, if it turns out to be wrong here more often than right."
};

// The pair this check was admitted on, inline so it reverts with the check
// and the selftest stays re-runnable forever.
export const fixtures = {
  "violation": "/* eslint-disable */\nimport { spawnSync } from 'node:child_process';\n\nexport function build(target) {\n  // eslint-disable-next-line n/no-sync\n  const out = spawnSync('npm', ['run', target], { encoding: 'utf8' });\n  console.log(out.stdout);\n  return out.status;\n}\n",
  "nearMiss": "import { spawn } from 'node:child_process';\n\nexport function build(target: string): Promise<number> {\n  // eslint-disable-next-line security/detect-child-process -- target is validated against a fixed allowlist above\n  const child = spawn('npm', ['run', target], { stdio: 'inherit' });\n  return new Promise((resolve) => child.on('close', (code) => resolve(code ?? 1)));\n}\n"
};

export function check(ctx) {
  const det = detectors.find((d) => d.lever === "check-driver");
  return ctx.scan(id, det.params.paths, det.params.patterns, det.params);
}
