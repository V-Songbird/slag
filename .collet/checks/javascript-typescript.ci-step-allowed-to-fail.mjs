// A regex over YAML, not a parser: `continue-on-error: ${{ inputs.soft }}` and a step disabled through a reusable-workflow input evaluate to the same thing at run time and match nothing. It also cannot see the most effective neutering of all — deleting the step, or removing the workflow's required-check status in branch protection, neither of which leaves a token in the file. The `|| true` pattern is anchored per line, so a continuation written with a YAML block scalar over two lines escapes it.
import { checkSource, liveSource } from '../source.mjs';

const spec = {
  "id": "javascript-typescript.ci-step-allowed-to-fail",
  "title": "CI step neutered so the job stays green",
  "paths": [
    ".github/workflows/*.yml",
    ".github/workflows/*.yaml",
    ".gitlab-ci.yml"
  ],
  "patterns": [
    "continue-on-error\\s*:\\s*true",
    "\\|\\|\\s*true\\s*$",
    "if\\s*:\\s*false\\b"
  ],
  "stripComments": false,
  "stripStrings": false,
  "perLine": true,
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
