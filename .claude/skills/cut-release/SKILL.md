---
name: cut-release
description: Bump a plugin's version, date its CHANGELOG, then commit and push the release.
argument-hint: "[plugin]"
disable-model-invocation: true
license: MIT
compatibility: Claude Code only. Requires git and Node 22 or later.
metadata:
  version: "1.0"
---

# cut-release

Cuts a release for one plugin in this repository. Plugins here live in-tree, so a release is a
single commit: the plugin's code, its `CHANGELOG.md` entry, and its version in every manifest that a
host reads, all moving together.

Which plugins exist is not written down here. Plugins get added and retired, so this skill reads the
current set from `.claude-plugin/marketplace.json` and the manifest files from the plugin's own
directory. Never assume a plugin name — list them.

> These are experiments with no support promise. A release is a checkpoint, not a commitment. The
> version still has to move, or `/plugin update` reports nothing changed.

## The version lives in a different file per host

| Host | File | Present when |
| --- | --- | --- |
| Claude Code | `.claude-plugin/marketplace.json`, the plugin's entry | always |
| Codex | `<plugin>/.codex-plugin/plugin.json` | the plugin ships for Codex |
| Antigravity | `<plugin>/plugin.json` | the plugin ships for Antigravity |

Two files never carry a version, and a bump must not add one:

- `<plugin>/.claude-plugin/plugin.json` — Claude Code resolves `plugin.json` before the marketplace
  entry, so a version here would mask the bump and installers would never see it.
- `.agents/plugins/marketplace.json` — the Codex index; that host reads its version from
  `.codex-plugin/plugin.json`.

Nothing checks any of this. See `AGENTS.md` → "Rules that outrank everything".

## Step 0 — which plugin, its manifests, and is it ready

List what the repository currently ships, and ask which one if the user did not say:

```bash
node -e "for (const p of require('./.claude-plugin/marketplace.json').plugins) console.log(p.name, p.version, p.source)"
```

Then find the files that carry that plugin's version. Whichever of these exist is the set to bump,
alongside the marketplace entry:

```bash
ls "<plugin>"/plugin.json "<plugin>"/.codex-plugin/plugin.json 2>/dev/null
```

Then check the plugin's state:

```bash
git status --short -- "<plugin>"
git log origin/main..HEAD --oneline -- "<plugin>"
npm run check
```

Report what is uncommitted and what is unpushed. Everything lands in one commit in Step 4, so
uncommitted plugin source is fine — say what is coming along rather than sweeping it in silently.

`npm run check` is `node --test` from the root, covering every plugin's suite plus the repository's
own. If it fails, stop and report. Do not release over a red suite without the user's explicit
go-ahead. To run one plugin alone, `cd <plugin>` and run `node --test` there.

## Step 1 — pick the new version

Read the plugin's current version from the Step 0 listing. Ask the user for the new one, or propose
a semver bump from the Step 0 commit log: patch for fixes, minor for new user-facing behaviour,
major for breaking changes. Keep a pre-release suffix such as `-alpha` unless the user says this
release drops it.

## Step 2 — turn Unreleased into the release

A plugin's CHANGELOG follows Keep a Changelog: `## [Unreleased]` at the top, then `## [<version>] —
<YYYY-MM-DD>` entries under `### Added` / `### Changed` / `### Fixed`.

1. `Read` `<plugin>/CHANGELOG.md`.
2. If `[Unreleased]` has no entries, ask the user what this release changes for a user, or draft it
   from the Step 0 commit log and confirm it.
3. `Edit` the file: rename the `## [Unreleased]` heading to `## [<version>] — <YYYY-MM-DD>`, keeping
   its subsections, and insert a fresh empty `## [Unreleased]` above it.

Entries are short, user-facing and effect-first. State the effect, not the journey: no methodology,
no run tags, no counts, no design rationale.

## Step 3 — bump every manifest for that plugin

`Edit` the `version` in the plugin's marketplace entry and in each manifest the Step 0 listing
found. Nothing else in an entry moves — `source` is a relative path and needs no pin.

Then confirm they agree:

```bash
grep -rn '"version"' .claude-plugin/marketplace.json "<plugin>"
```

Every hit for that plugin reads the same string, or the release is half-applied. A hit inside
`<plugin>/.claude-plugin/plugin.json` is a mistake — remove it rather than matching it.

## Step 4 — commit and push

```bash
npm run check
git add .claude-plugin/marketplace.json "<plugin>"
git commit -m "Release <plugin> <version>"
git push origin main
```

`AGENTS.md` → "Commands" lists any repository-wide check beyond `npm run check`, such as the layout
audit. Run what is listed there and read its output before pushing; treat anything unfamiliar in it
as new.

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
- Assume which plugins exist, or which manifests one carries, instead of listing them.
- Decide the bump size without asking, unless the user already stated it.
- Add a `version` to `<plugin>/.claude-plugin/plugin.json` or to `.agents/plugins/marketplace.json`.
- Force-push, skip hooks, or release over a red suite without explicit confirmation.
