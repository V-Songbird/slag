// Comments must remain visible, so an @ts-ignore mentioned in explanatory prose can fire just like a directive. @ts-expect-error is deliberately not matched; this check does not validate its description. Excluding a file from tsconfig or deleting a compiler option leaves no directive to match. Explicit strictness values are covered separately by relaxed-tsconfig-strictness.
import { checkSource, liveSource } from '../source.mjs';

const spec = {
  "id": "javascript-typescript.blanket-type-suppression",
  "title": "Type error suppressed by comment",
  "paths": [
    "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"
  ],
  "patterns": [
    "@ts-nocheck\\b",
    "@ts-ignore\\b"
  ],
  "stripComments": false,
  "stripStrings": true,
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
