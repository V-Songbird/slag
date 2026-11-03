// --passWithNoTests may be intentional where packages ship no tests; the generated project check must be adjusted for that policy. Only package.json scripts are read, including nested package files; commands inside a Makefile, task configuration or wrapper script are outside its paths. Piping into true, swallowing an exit code in a helper, and running under set +e can neutralize failures without these tokens. No source match proves the suite actually ran or passed.
import { checkSource, liveSource } from '../source.mjs';

const spec = {
  "id": "javascript-typescript.toothless-test-command",
  "title": "Test or CI step that cannot fail",
  "paths": [
    "**/package.json"
  ],
  "patterns": [
    "\"(?:test|lint|typecheck|check|ci)[^\"]*\"\\s*:\\s*\"[^\"]*(?:\\|\\|\\s*true|\\bexit\\s+0|;\\s*true\\b)",
    "\"[^\"]*\"\\s*:\\s*\"[^\"]*--passWithNoTests"
  ],
  "stripComments": false,
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
