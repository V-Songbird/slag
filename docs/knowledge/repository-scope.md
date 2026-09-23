---
type: knowledge
summary: "Current repository scope and public validation boundaries; read before adding plugin files or repository documentation."
related_files:
  - AGENTS.md
  - .gitignore
  - package.json
  - scripts/suite-failure-reporter.js
  - scripts/claude-hooks/run-tests-on-edit.js
  - scripts/plugin-integrity.test.js
  - scripts/ignore-policy.test.js
  - anneal/
  - collet/
---

# Repository scope and validation

Slag ships anneal and collet as plain in-tree directories with one Git history. There are no
submodules, dependency-install step, CI workflow, artwork or support promise. A plugin carries
its README, LICENSE and docs/knowledge/changelog.md plus its runtime, skills and tests; collet/package.json declares
its ESM module type. Root source stays CommonJS.

## Public product surface

Ship complete runtime source, skill prompts, host manifests, generic fixtures, tests and the
technical documentation needed to use and modify them. The public checks must run without private
working records. Do not add generated caches, local host settings or test-run artifacts to releases.

Repository contracts live under docs/knowledge. Each plugin keeps its workflow guide and
changelog under its own docs/knowledge so installed plugin documentation stays self-contained.

The repository's own ignore boundary is checked by
[scripts/ignore-policy.test.js](../../scripts/ignore-policy.test.js). Public source and checks
remain independent of personal skills or private working records.

## Checks

npm run check runs the plugin suites and repository tests using Node 22 or later. The integrity
suite validates marketplace sources, local resource paths, host metadata and version ownership.
The navigation audit is heuristic; its three runtime-name matches in audit.test.js are intentional
fixture strings and must retain their detector coverage.

On Node 22 the test runner reports a failed suite without counting a failed test, so a describe
callback that throws or rejects before it registers a test, or a suite's after hook that throws,
prints the error yet exits 0. An error at the top level of a test file or in a before hook already
exits 1. The check script therefore adds
[scripts/suite-failure-reporter.js](../../scripts/suite-failure-reporter.js) as a second reporter:
it sets exit code 1 for every failure the runner reports and writes one stderr line for each suite
that failed outside its tests. scripts/suite-failure-reporter.test.js runs the fixtures in
scripts/fixtures, whose names keep them out of test discovery, with the check script's own
arguments. The edit hook passes the same reporter, with tap in place of spec, and quotes those
lines in its feedback. A plain node --test run, including one inside a plugin, has no such guard,
so keep file reads, processes and fixture setup in before hooks or tests rather than in describe
callbacks.

The configured commit gate can use an optional private name blocklist. It passes when no list is
available, so a successful commit is not proof that this optional filter checked any names.
Release changes are reviewed and tested independently of that filter. Use the repository's
cut-release procedure when publishing and keep release scope explicit.

## Contributor setup

Use the Node major selected by .nvmrc and run from a Git checkout. No dependency installation
is needed. Run npm run check from the root, or node --test inside one plugin to run its suite. The suites create disposable
Git fixtures and use Node's built-in test runner.

The repository edit hook is configured in .claude/settings.json and .codex/hooks.json.
After an edit to a .js or .mjs file under a plugin's scripts, hooks or templates directory, it runs
that plugin's test files that reach the edited file. A file reaches it by quoting the file's name,
with or without its extension, as a relative require, import or joined path does, or, for a
template, by quoting a folder on the template's path; a plugin file reached that way passes the
reach on. When no test file reaches the edit, the plugin's whole suite runs. The runs share a
110-second budget, TEST_TIMEOUT_MS, under the 120-second timeout at which the host stops the hook.
Every collet test file reaches collet/scripts/mount.mjs, so an edit to a collet script or template
runs every one of them. With other suites running on the same machine that can take several minutes,
past the budget, and the hook then reports that it did not complete instead of a verdict. A test
that reaches a file only through a name built at run time is not selected, so npm run check
remains the full gate.
Those adapters are repository development configuration, separate from shipped plugin hooks.

The optional Git gates can be enabled for a clone with git config core.hooksPath scripts/git-hooks.
They read HOUSE_REFERENCE_BLOCKLIST first, then a nonempty .private/reference-names.txt in the
current directory, then the parent directory. With no readable nonempty list, the gates pass.
This optional input is not required by public tests or plugin installation.
