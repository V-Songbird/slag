---
name: cut-release
description: >-
  Developer tool for this marketplace repo. Walks through cutting a release for
  one plugin: adds the CHANGELOG entry in the plugin's own directory, bumps that
  plugin's "version" in the root .claude-plugin/marketplace.json, then commits
  and pushes both together. User-invocable only — never triggered automatically,
  since it commits and pushes.
disable-model-invocation: true
allowed-tools: Bash, Read, Edit
---

# cut-release

Cuts a release for one plugin in this marketplace. Plugins here live in-tree, so
a release is a single commit to this repo: the plugin's code, its `CHANGELOG.md`
entry, and its `version` in `.claude-plugin/marketplace.json` all move together.

This repo's rule: `.claude-plugin/marketplace.json` is the SINGLE owner of a
plugin's version (no `plugin.json` here ever sets `version` — Claude Code
resolves `plugin.json` first, so one there would silently mask the marketplace
entry and installers would never see the bump). See
`.claude/rules/plugin-layout.md` → "Versions" for the full rationale.

> These are experimental plugins with no support promise. A release here is a
> checkpoint, not a commitment — but the version still has to move, or
> `/plugin update` reports nothing changed.

## Step 0 — figure out which plugin, and confirm the code is ready

Ask which plugin to release if not stated: `verity`, `jetbrains-router`, `assay`,
`plumb`, or `gauge`.

```bash
git status --short -- "<plugin>"
git log origin/main..HEAD --oneline -- "<plugin>"
```

Report what's uncommitted and what's unpushed. Everything staged for this release
lands in one commit in Step 4, so uncommitted plugin source is fine here — but
say what's coming along rather than sweeping it in silently.

Run the plugin's suite before releasing, if it has one:

```bash
node --test "<plugin>"/tests/*.test.js
```

If it fails, stop and report. Do not release over a red suite without the user's
explicit go-ahead.

## Step 1 — pick the new version

Read the plugin's current version from `.claude-plugin/marketplace.json`. Ask the
user for the new version, or propose one via semver bump (patch for fixes, minor
for new user-facing behavior, major for breaking changes) based on the commits
found in Step 0. Keep the `-alpha` suffix if the current version has one, unless
the user says this release drops it.

## Step 2 — update the plugin's CHANGELOG.md

1. `Read` `<plugin>/CHANGELOG.md`.
2. Ask the user for a one-line, user-facing summary of what this release changes
   (or draft one from the Step 0 commit log and confirm it with the user — per
   `.claude/rules/public-docs.md`: effect-first, no methodology, no run tags, no
   history narration).
3. `Edit` the file: insert a new heading `## <version> — <YYYY-MM-DD>` directly
   below the intro paragraph (above the most recent existing version heading),
   followed by the summary paragraph. Do not add an `[Unreleased]` staging
   heading — this repo's actual practice adds the versioned heading directly at
   release time.

## Step 3 — bump the version in marketplace.json

1. `Read` `.claude-plugin/marketplace.json`.
2. `Edit` that plugin's entry: set `"version"` to the Step 1 value. Nothing else
   in the entry moves — the `source` is a relative path and needs no pin.

## Step 4 — commit and push

```bash
node scripts/check-plugin-sources.js
git add .claude-plugin/marketplace.json "<plugin>"
git commit -m "Release <plugin> <version>"
git push origin main
```

The `pre-commit` and `commit-msg` hooks scan for private reference-project names
(see `.claude/rules/public-docs.md`). If either blocks, reword generically — do
not bypass with `--no-verify`.

## Step 5 — confirm

Report the new version, the new commit SHA (short form), and the push result. If
the push failed (e.g. blocked by a permission gate), stop and surface that
clearly rather than retrying silently.

## What this skill does not do

- Write or edit plugin source code, skills, agents, or hooks.
- Decide the version bump size without asking — always confirm with the user
  unless they already stated it.
- Force-push, skip hooks, or bypass a failing test without explicit user
  confirmation.
