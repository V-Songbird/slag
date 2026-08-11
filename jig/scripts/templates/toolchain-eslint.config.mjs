// jig:owned — generated from jig's eslint side-file template. Edit this file
// and jig reports it as drifted rather than overwriting your edit.
//
// A flat config that stands alone: core rules only, no plugin to install, no
// config lookup. Run it with the repository's OWN eslint —
//
//   eslint --no-config-lookup --config .jig/eslint.jig.config.mjs .
//
// — or wire that line into your package.json scripts and CI. jig never runs
// or downloads eslint itself; if the repo does not carry it, this file is an
// ENFORCEMENT GAP until it does.
export default [
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx"],
    rules: {
      "no-empty": ["error", { "allowEmptyCatch": false }],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='only'][callee.object.name=/^(describe|it|test)$/]",
          "message": "A focused test quietly stops the rest of the suite from running."
        },
        {
          "selector": "CallExpression[callee.property.name='skip'][callee.object.name=/^(describe|it|test)$/]",
          "message": "A skipped test hides a failure instead of fixing it."
        }
      ]
    }
  }
];
