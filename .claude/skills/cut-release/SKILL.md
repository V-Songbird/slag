---
name: cut-release
description: >-
  Developer tool for this repository. Walks through cutting a release for one
  plugin: promotes its CHANGELOG's Unreleased section to a dated version
  heading, bumps that version in every manifest the plugin's hosts read, then
  commits and pushes the lot as one commit. User-invocable only — never
  triggered automatically, since it commits and pushes.
disable-model-invocation: true
allowed-tools: Read, Edit
---

# cut-release

Cuts a release for `anneal` or `collet`. Plugins here live in-tree, so a release is a single commit
to this repository: the plugin's code, its `CHANGELOG.md` entry, and its version in every manifest
that a host reads, all moving together.

> These are experiments with no support promise. A release is a checkpoint, not a commitment. The
> version still has to move, or `/plugin update` reports nothing changed.

## The version lives in a different file per host

| Host | File | Applies to |
| --- | --- | --- |
| Claude Code | `.claude-plugin/marketplace.json`, the plugin's entry | both |
| Codex | `<plugin>/.codex-plugin/plugin.json` | both |
| Antigravity | `<plugin>/plugin.json` | anneal only |

Two files never carry a version, and a bump must not add one:

- `<plugin>/.claude-plugin/plugin.json` — Claude Code resolves `plugin.json` before the marketplace
  entry, so a version here would mask the bump and installers would never see it.
- `.agents/plugins/marketplace.json` — the Codex index; that host reads its version from
  `.codex-plugin/plugin.json`.

Nothing checks any of this. See `AGENTS.md` → "Conventions that constrain a change".

## Step 0 — which plugin, and is it ready

Ask which plugin if the user did not say: `anneal` or `collet`.

```bash
git status --short -- "<plugin>"
git log origin/main..HEAD --oneline -- "<plugin>"
npm run check
```

Report what is uncommitted and what is unpushed. Everything lands in one commit in Step 4, so
uncommitted plugin source is fine — say what is coming along rather than sweeping it in silently.

`npm run check` is `node --test` from the root: 117 tests, 49 in anneal and 68 in collet. If it
fails, stop and report. Do not release over a red suite without the user's explicit go-ahead. To run
one plugin alone, `cd <plugin>` and run `node --test` there — passing `<plugin>/tests/*.test.js` as
an argument fails on node 20, which is this repository's floor.

## Step 1 — pick the new version

Read the plugin's current version from `.claude-plugin/marketplace.json`. Ask the user for the new
one, or propose a semver bump from the Step 0 commit log: patch for fixes, minor for new
user-facing behaviour, major for breaking changes. Keep the `-alpha` suffix unless the user says
this release drops it.

## Step 2 — turn Unreleased into the release

Both CHANGELOGs follow Keep a Changelog: `## [Unreleased]` at the top, then `## [<version>] —
<YYYY-MM-DD>` entries under `### Added` / `### Changed` / `### Fixed`.

1. `Read` `<plugin>/CHANGELOG.md`.
2. If `[Unreleased]` has no entries, ask the user what this release changes for a user, or draft it
   from the Step 0 commit log and confirm it.
3. `Edit` the file: rename the `## [Unreleased]` heading to `## [<version>] — <YYYY-MM-DD>`, keeping
   its subsections, and insert a fresh empty `## [Unreleased]` above it.

Entries are short, user-facing and effect-first. State the effect, not the journey: no methodology,
no run tags, no counts, no design rationale.

## Step 3 — bump every manifest for that plugin

`Edit` the `version` in each file the table above lists for that plugin. Three files for anneal, two
for collet. Nothing else in an entry moves — `source` is a relative path and needs no pin.

Then confirm they agree:

```bash
grep -rn '"version"' .claude-plugin/marketplace.json "<plugin>"/.codex-plugin/plugin.json
grep -rn '"version"' anneal/plugin.json   # anneal only
```

Every hit for that plugin reads the same string, or the release is half-applied.

## Step 4 — commit and push

```bash
npm run check
node anneal/scripts/audit.js --root .
git add .claude-plugin/marketplace.json "<plugin>"
git commit -m "Release <plugin> <version>"
git push origin main
```

The audit should report only `runtime-names` three times, in anneal's own test fixtures. Anything
else is new and worth reading before pushing.

The `pre-commit` and `commit-msg` gates scan for private reference names. If either blocks, reword
generically, or — when the name is in a benchmark the release means to publish — take it off the
private blocklist deliberately and say so. Do not bypass with `--no-verify`. The gate fails open
when the blocklist is absent, so a clean pass is not proof it ran. See
`.claude/rules/reference-names.md`.

Nothing here is pre-approved beyond reading and editing: every command in this skill goes through
the usual permission prompt, and the push is the one you should read before allowing.

## Step 5 — confirm

Report the new version, the short commit SHA, and the push result. If the push failed, surface that
rather than retrying silently.

## What this skill does not do

- Write or edit plugin source code, skills, agents or hooks.
- Decide the bump size without asking, unless the user already stated it.
- Add a `version` to `<plugin>/.claude-plugin/plugin.json` or to `.agents/plugins/marketplace.json`.
- Force-push, skip hooks, or release over a red suite without explicit confirmation.
