// It sees a flag written as false but not a flag quietly deleted — removing "noUncheckedIndexedAccess" entirely has the same effect and leaves no token, which is the most common way this actually happens. It also cannot judge the exclude list: a new path in "exclude" may be a legitimate build split or may be the file that would not compile. Detection is per-file, so a strict base config softened in an extending tsconfig.build.json is only caught if that file is in the paths glob, and strictness inherited from an "extends" package is never read at all. tsc contributes nothing: a tsconfig whose strictness has been turned down is exactly the state in which the type checker reports nothing, so it cannot detect its own relaxation.
import { checkSource, liveSource } from '../source.mjs';

const spec = {
  "id": "javascript-typescript.relaxed-tsconfig-strictness",
  "title": "Type-checker strictness turned down to make the build pass",
  "paths": [
    "**/tsconfig*.json",
    "**/jsconfig.json"
  ],
  "patterns": [
    "\"(?:strict|strictNullChecks|strictFunctionTypes|strictBindCallApply|strictPropertyInitialization|noImplicitAny|noImplicitThis|alwaysStrict|useUnknownInCatchVariables)\"\\s*:\\s*false",
    "\"(?:noUncheckedIndexedAccess|exactOptionalPropertyTypes|noImplicitOverride|noImplicitReturns|noFallthroughCasesInSwitch|noUnusedLocals|noUnusedParameters)\"\\s*:\\s*false",
    "\"suppressImplicitAnyIndexErrors\"\\s*:\\s*true",
    "\"allowJs\"\\s*:\\s*true[\\s\\S]{0,400}?\"checkJs\"\\s*:\\s*false"
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
