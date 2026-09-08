<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="Slag" width="240" />
  </picture>
  <h1>Slag for Codex</h1>
  <p>Experimental plugins for Codex.</p>
</div>

This repository's **`Codex` branch** is the home for ports to Codex and new
Codex plugins. The Codex marketplace is `slag-codex`, defined in
[`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json).

## Install from this checkout

Use a checkout of the `Codex` branch. From its root:

```text
codex plugin marketplace add .
codex plugin add jig@slag-codex
```

Start a new Codex task to load the installed skills. Review the current hook
trust in the host you use before relying on session enforcement. A successful
plugin installation alone does not prove that hooks run.

## Available in Codex

| Plugin | What it does |
| --- | --- |
| [Jig](plugins/jig/README.md) | Proposes checks for recurring mistakes, applies the concrete changes you approve, reports what it checks or caught, and records how to undo installation changes. |

Ask `$jig` what is being checked or what needs attention. `$inventory` and
`$review` remain direct entries. The full workflow and coverage limits are in
[Jig's guide](plugins/jig/README.md).

`main` holds the Claude Code plugins. This `Codex` branch contains only Jig;
other plugins will be added when their ports are ready.

## Develop and validate

Place each Codex plugin in `plugins/<name>/`, with its native
`.codex-plugin/plugin.json`, and register it in the Codex marketplace above.
New Codex work and ports belong on branches based on `Codex` and return there.

```text
node scripts/check-codex-marketplace.js
node --test scripts/check-codex-marketplace.test.js
```

Run Jig's tests from `plugins/jig/`:

```text
npm test
```

The Codex CI workflow runs those checks and Jig's suite on Node 20, 22 and 24
across Windows, macOS and Linux. Its definition is not evidence that a remote
job has run. These plugins remain experimental; consult each plugin's stated
validation limits.

## Source history

Jig was relocated from the standalone `codex/jig` repository, retaining its Git
history and the working-tree UX improvements. Its native runtime, detectors,
consent rules and undo behavior are preserved. The earlier Slag host-migration commit is an ancestor of this branch, so its
implementation and history remain available after the auxiliary branch is retired.

## Author and identity

Created by **Victor Villegas** ([V-Songbird](https://github.com/V-Songbird)).
Contact: [victor.villegas@tuta.com](mailto:victor.villegas@tuta.com).
The marketplace uses Slag's existing logo; Jig retains its own light and dark
logos and supplies its composer icon in the native plugin metadata. Codex's
marketplace interface currently exposes a display name; author and icon fields
are provided by the plugin interface.

MIT — see [LICENSE](LICENSE).
