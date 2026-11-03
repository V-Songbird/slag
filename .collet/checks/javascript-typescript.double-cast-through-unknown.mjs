// Matches adjacent `as unknown as` only. Laundering across two statements, such as `const tmp: unknown = x; const y = tmp as T`, and through helpers such as cast<T>(x), has none of those adjacent tokens and is missed. Test files are excluded; a double cast that builds a partial fixture there is not refused.
import { checkSource, liveSource } from '../source.mjs';

const spec = {
  "id": "javascript-typescript.double-cast-through-unknown",
  "title": "Type laundered through a double cast",
  "paths": [
    "**/*.{ts,mts,cts,tsx}"
  ],
  "exclude": [
    "**/*.{test,spec}.{ts,mts,cts,tsx}",
    "**/__tests__/**",
    "**/tests/**",
    "**/test/**"
  ],
  "patterns": [
    "\\bas\\s+unknown\\s+as\\b"
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
