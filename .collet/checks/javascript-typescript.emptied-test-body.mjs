// Only catches an empty test shell. A test deleted outright leaves no source to match, and a body reduced to a trivially true assertion such as expect(true).toBe(true) remains nonempty. Empty beforeEach/afterEach hooks are deliberately not matched, so a suite gutted by moving its work into an empty hook slips through. These deletion and assertion cases are outside this bundle.
import { checkSource, liveSource } from '../source.mjs';

const spec = {
  "id": "javascript-typescript.emptied-test-body",
  "title": "Test body emptied instead of fixed",
  "paths": [
    "**/*.{test,spec}.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"
  ],
  "patterns": [
    "\\b(?:it|test)\\s*\\([\\s\\S]{0,120}?(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{\\s*\\}\\s*\\)",
    "\\b(?:it|test)\\s*\\([\\s\\S]{0,120}?(?:async\\s*)?function\\s*\\([^)]*\\)\\s*\\{\\s*\\}\\s*\\)"
  ],
  "stripComments": true,
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
