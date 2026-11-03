// Covers the existing Vitest/Jest call spellings and bare test/it/describe/suite calls with a literal name or no name, a shallow inline options object, and literal only: true. Other properties must use unquoted keys and scalar values or simple member references. Quoted keys, spreads, nested values, duplicate only keys, renamed imports, qualified calls, dynamic names/options and the Jasmine-era fit/fdescribe spellings are outside the added options pattern. Calls are recognized by spelling, without resolving their imports. Node only flags select tests only when the runner or context enables that behavior, such as --test-only; this check does not inspect that configuration. A focus selected dynamically or by a runner flag can remain invisible.
import { checkSource, liveSource } from '../source.mjs';

const spec = {
  "id": "javascript-typescript.focused-test",
  "title": "Focused test left in the suite",
  "paths": [
    "**/*.{test,spec}.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"
  ],
  "patterns": [
    "\\b(?:describe|it|test|suite|bench)\\s*\\.\\s*only\\s*[\\(`]",
    "\\b(?:describe|it|test)\\s*\\.\\s*(?:concurrent|sequential|each)\\s*\\.\\s*only\\b",
    "(?<![\\w$.])(?<!\\.\\s*)(?:test|it|describe|suite)\\s*\\(\\s*(?:(?:\"\\s*\"|'\\s*'|`\\s*`)\\s*,\\s*)?\\{\\s*(?:(?!only\\s*:)[A-Za-z_$][\\w$]*\\s*:\\s*(?:(?:\"\\s*\"|'\\s*'|`\\s*`)|-?\\d+(?:_\\d+)*(?:\\.\\d+)?|[A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*)\\s*,\\s*)*only\\s*:\\s*true\\s*(?:,\\s*(?!only\\s*:)[A-Za-z_$][\\w$]*\\s*:\\s*(?:(?:\"\\s*\"|'\\s*'|`\\s*`)|-?\\d+(?:_\\d+)*(?:\\.\\d+)?|[A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*)\\s*)*,?\\s*\\}\\s*(?=[,)])"
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
