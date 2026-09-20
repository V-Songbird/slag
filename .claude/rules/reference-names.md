---
paths:
  - "**/README.md"
  - "**/CHANGELOG.md"
  - "**/.claude-plugin/*.json"
  - "**/.codex-plugin/*.json"
  - ".agents/plugins/*.json"
  - "*/plugin.json"
---

# Never name another project in a public record

A public record is anything that leaves this machine: a README, a CHANGELOG, any manifest, a code
comment, a test name or fixture string, a branch name, PR text, and a commit message. In all of
them, never name another project — not a competitor, not a tool or repository used as a reference,
an inspiration, or a benchmark.

Write the generic category instead: "a rival tool", "a public reference", "another marketplace".
Sell on this repository's own merits, with numbers a reader can reproduce.

The names themselves live only in `docs/research/`, which is gitignored and is not in a standard
clone.

## What enforces it

`scripts/git-hooks/check-reference-names.js`, armed once per clone with
`git config core.hooksPath scripts/git-hooks`, scans the staged change and the commit message
against the blocklist in `docs/research/reference-names.txt`.

**That gate fails open.** With no blocklist present it passes everything, on purpose, so a
standalone clone can still commit. A green commit is not proof the gate ran, and on most clones it
did not. This rule is what covers the file; nothing mechanical does.
