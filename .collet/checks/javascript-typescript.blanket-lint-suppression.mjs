// Matches /* eslint-disable */ and eslint-disable-line or eslint-disable-next-line without a -- reason. Any reason passes, even if false or stale. Other directive spellings, including biome-ignore, are outside these patterns. This check cannot establish whether a disabled rule would have fired, and it does not install or configure a linter. Disabling a rule in the lint configuration instead of the source is outside this bundle.
import { checkSource, liveSource } from '../source.mjs';

const spec = {
  "id": "javascript-typescript.blanket-lint-suppression",
  "title": "Lint suppressed for a whole file or line without a reason",
  "paths": [
    "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"
  ],
  "patterns": [
    "/\\*\\s*eslint-disable\\s*(?![^*\\n]*--)[^*\\n]*\\*/",
    "//\\s*eslint-disable-(?:next-)?line(?![^\\n]*--)"
  ],
  "stripComments": false,
  "stripStrings": true,
  "perLine": false,
  "remedy": "If the suppression is deliberate, add the reason after the rule: // eslint-disable-next-line <rule> -- <why>.",
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
