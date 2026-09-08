# Slag for Codex

`main` contains the Claude Code implementation. `Codex` contains only Codex
ports and new Codex plugins. Currently Jig is the only plugin in this branch.

- Keep native plugins in `plugins/<name>/` and register them in
  `.agents/plugins/marketplace.json` (`slag-codex`).
- Before finishing work, run `node scripts/check-codex-marketplace.js` and
  `node --test scripts/check-codex-marketplace.test.js`.
- For Jig changes, run `npm test` from `plugins/jig/`.
- Node and npm use fnm on the owner's Windows machine. Register them in each
  PowerShell session with `fnm env --use-on-cd | Out-String | Invoke-Expression`.
- Keep temporary test output out of commits and remove files created by a test
  once its results have been inspected.
