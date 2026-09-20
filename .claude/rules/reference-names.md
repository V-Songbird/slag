---
paths:
  - "**/README.md"
  - "**/CHANGELOG.md"
  - "**/.claude-plugin/*.json"
  - "**/.codex-plugin/*.json"
  - ".agents/plugins/*.json"
  - "*/plugin.json"
---

# Name another project only where it was measured

A public record is anything that leaves this machine: a README, a CHANGELOG, any manifest, a code
comment, a test name or fixture string, a branch name, PR text, and a commit message. In all of
them, one exception aside, never name another project — not a competitor, not a tool or repository
used as a reference, an inspiration, or a benchmark. Write the generic category instead: "a rival
tool", "a public reference", "another marketplace". Sell on this repository's own merits.

## The exception: a benchmark or a measurement

A named project is allowed where it is **the thing that was measured**, and nowhere else. That
means a README's `## Benchmarks` section, or a table or sentence reporting a result, and it carries
the conditions of the house rule on numbers:

- The comparison was actually run. Never name a project from reputation, from its documentation, or
  from what it probably does.
- Name the version and the date it was run. An unversioned comparison goes stale silently and reads
  as a standing claim.
- Give the counts a reader can reproduce, plus the one-line "how we tested". A number nobody can
  check is worse than no number, and it is worse still with someone else's name attached.
- Report the result whichever way it went, in the same plain voice. No mockery, no framing the
  other project as foolish, and no reaching past what was measured.

## Where the exception does not reach

The carve-out is the measurement, not permission to mention the project elsewhere in the same file.
Outside a result, the generic category still applies: the tagline, `## What is this?`, `## Why you'd
want it`, the install and usage prose, every manifest description, code comments, test names and
fixture strings, branch names, PR text, and commit messages.

A CHANGELOG never carries counts at all — it states the effect — so it never carries a name either.

The names that are not published live in `docs/research/`, which is gitignored and is not in a
standard clone.

## What enforces it

`scripts/git-hooks/check-reference-names.js`, armed once per clone with
`git config core.hooksPath scripts/git-hooks`, scans the staged change and the commit message
against the blocklist in `docs/research/reference-names.txt`.

**That gate fails open.** With no blocklist present it passes everything, on purpose, so a
standalone clone can still commit. A green commit is not proof the gate ran, and on most clones it
did not. This rule is what covers the file; nothing mechanical does.

**The gate does not know about the exception.** It scans added lines flat, with no idea which
section they are in, so a benchmark row naming a blocklisted project is blocked at commit time on
any clone that has the blocklist. That is the gate being blunt, not the rule changing its mind.
Resolve it deliberately: take the name off the private blocklist if the comparison is meant to be
published, and say so in the commit. Never reach for `--no-verify`.
