// Counts the listed source values against the baseline; it does not compare the meaning of numeric thresholds. Lowering a threshold from 80 to 55 matches nothing because only single-digit thresholds are covered. Deleting a thresholds block or coverage provider also leaves no value to match. Only vitest and vite config files are read, so settings in package.json or command-line arguments such as --coverage.thresholds.lines=0 are outside these paths.
import { checkSource, liveSource } from '../source.mjs';

const spec = {
  "id": "javascript-typescript.test-config-loosened",
  "title": "Test harness config relaxed instead of the failure fixed",
  "paths": [
    "**/vitest.config.{js,mjs,ts,mts}",
    "**/vite.config.{js,mjs,ts,mts}"
  ],
  "patterns": [
    "\\ballowOnly\\s*:\\s*true\\b",
    "\\bpassWithNoTests\\s*:\\s*true\\b",
    "\\b(?:lines|statements|functions|branches)\\s*:\\s*(?:0|[1-9])\\s*[,}]",
    "\\bcoverage\\s*:\\s*\\{[^}]*\\benabled\\s*:\\s*false\\b"
  ],
  "stripComments": true,
  "stripStrings": false,
  "perLine": false,
  "commentSyntax": {
    ".js": "slash",
    ".mjs": "slash",
    ".cjs": "slash",
    ".jsx": "slash",
    ".ts": "slash",
    ".mts": "slash",
    ".cts": "slash",
    ".tsx": "slash"
  }
};
export const id = spec.id;
export const what = spec.title;
export const check = (context) => checkSource(context, spec);
export const live = (context) => liveSource(context, spec);
