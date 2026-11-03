// Covers the existing Vitest/Jest call spellings and bare test/it/describe/suite calls with a literal name or no name, a shallow inline options object, and literal skip: true. Other properties must use unquoted keys and scalar values or simple member references. Quoted keys, string skip reasons, spreads, nested values, duplicate skip keys, renamed imports, qualified calls, dynamic names/options and the xit/xtest/xdescribe spellings are outside the added options pattern. Calls are recognized by spelling, without resolving their imports. A documented quarantine has the same token as an abandoned skip. Narrowing the runner include paths or adding an exclude can suppress a file without any matched source token.
import { checkSource, liveSource } from '../source.mjs';

const spec = {
  "id": "javascript-typescript.skipped-test",
  "title": "Test skipped and left that way",
  "paths": [
    "**/*.{test,spec}.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"
  ],
  "patterns": [
    "\\b(?:describe|it|test|suite|bench)\\s*\\.\\s*(?:skip|todo|failing)\\s*[\\(`]",
    "\\b(?:describe|it|test)\\s*\\.\\s*skipIf\\s*\\(",
    "(?<![\\w$.])(?<!\\.\\s*)(?:test|it|describe|suite)\\s*\\(\\s*(?:(?:\"\\s*\"|'\\s*'|`\\s*`)\\s*,\\s*)?\\{\\s*(?:(?!skip\\s*:)[A-Za-z_$][\\w$]*\\s*:\\s*(?:(?:\"\\s*\"|'\\s*'|`\\s*`)|-?\\d+(?:_\\d+)*(?:\\.\\d+)?|[A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*)\\s*,\\s*)*skip\\s*:\\s*true\\s*(?:,\\s*(?!skip\\s*:)[A-Za-z_$][\\w$]*\\s*:\\s*(?:(?:\"\\s*\"|'\\s*'|`\\s*`)|-?\\d+(?:_\\d+)*(?:\\.\\d+)?|[A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*)\\s*)*,?\\s*\\}\\s*(?=[,)])"
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
