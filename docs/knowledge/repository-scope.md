---
type: knowledge
summary: "Current repository scope and public validation boundaries; read before adding files or repository documentation."
related_files:
  - AGENTS.md
  - .gitignore
  - package.json
  - scripts/suite-failure-reporter.js
  - scripts/quiet-reporter.js
  - scripts/claude-hooks/run-tests-on-edit.js
  - scripts/plugin-parity.js
  - scripts/ignore-policy.test.js
  - scripts/hidden-characters.test.js
  - scripts/markdown-links.test.js
  - scripts/git-hooks/release-gate.js
  - scripts/sdk-eval/run.mjs
---

# Repository scope and validation

Slag was the workshop where the anneal and collet plugins were developed, as plain in-tree
directories with one Git history. Both now live in their own repositories,
[anneal](https://github.com/V-Songbird/anneal) and [collet](https://github.com/V-Songbird/collet),
and are installed from the [Foundry](https://github.com/V-Songbird/foundry) marketplace; Slag has
no plugin, no marketplace catalog and no release procedure. There are no submodules,
dependency-install step at the root, CI workflow, artwork or support promise. What stays is the SDK
eval runner in scripts/sdk-eval, the mounted .collet harness, the research records under
docs/knowledge and the repository checks. Root source stays CommonJS.

## Public product surface

Ship generic fixtures, tests and the technical documentation needed to use and modify what is
here. The public checks must run without private working records. Do not add generated caches,
local host settings or test-run artifacts.

Repository contracts live under docs/knowledge. A plugin's workflow guide and changelog live in its
own repository.

The repository's own ignore boundary is checked by
[scripts/ignore-policy.test.js](../../scripts/ignore-policy.test.js). Public source and checks
remain independent of personal skills or private working records.

## Checks

npm run check runs the repository tests using Node 22 or later. Manifest, catalog and version
checks moved with the plugins: each plugin's own tests/manifests.test.js, and the Foundry
marketplace's CI, which validates its catalogs. scripts/plugin-parity.js compares an installed
copy of a plugin with its tracked source, and scripts/plugin-parity.test.js checks it against
fixtures; see
[checking an installed copy](host-plugin-formats.md#checking-an-installed-copy-against-the-source).
scripts/sdk-eval/lib.test.mjs checks the SDK eval runner's model-free parts against
scripts/sdk-eval/fixtures, a snapshot of three of collet's eval cases and its eval harness; the
runner loads the harness of the plugin directory it is given.
scripts/hidden-characters.test.js fails on raw zero-width, bidi-control, tag, misplaced
byte-order-mark, variation-selector and Mongolian vowel separator characters in tracked text
files, naming file, line and code point. U+FE0E and U+FE0F are allowed right after an
Extended_Pictographic character, and U+FE0F between 0-9, # or * and the keycap U+20E3. The
Mongolian variation selectors U+180B-U+180D and U+180F are allowed right after a Mongolian letter
or one of its combining marks U+1885, U+1886 or U+18A9, all in U+1820-U+1878 or U+1880-U+18AA.
The vowel separator U+180E is allowed in the same place or right after such a selector. Both
fail anywhere else. It walks the tree
instead when there is no Git work tree. The pattern is the one exported by the mounted
.collet/state.mjs; that the two plugins' copies of it agree is no longer checked here, because
each plugin keeps its own copy in its own repository. Write such characters as escapes (\u200B, \u{E0041}).
scripts/markdown-links.test.js fails on a relative link or #anchor in a tracked public Markdown
file whose target is not a tracked file or directory, or whose anchor names no heading or `<a>` id
or name in the target. Heading anchors follow GitHub's slugs; files under the private directories are
skipped at any depth. Its header comment lists its known limits.

The check script writes [scripts/quiet-reporter.js](../../scripts/quiet-reporter.js) to stdout in
place of the spec reporter. A test that passed prints nothing; a failed test prints its name, its
file and line and its error, a test file's stderr passes through, and the runner's closing counts
end the run. The spec reporter printed about 126,000 characters on a clean run of 1,285 tests, and an
agent host that keeps only a preview of a long output then cut off the counts that say the run
passed. `npm run check:verbose` is the same run with the spec reporter, for a line per test.

On Node 22 the test runner reports a failed suite without counting a failed test, so a describe
callback that throws or rejects before it registers a test, or a suite's after hook that throws,
prints the error yet exits 0. An error at the top level of a test file or in a before hook already
exits 1. The check script therefore adds
[scripts/suite-failure-reporter.js](../../scripts/suite-failure-reporter.js) as a second reporter:
it sets exit code 1 for every failure the runner reports and writes one stderr line for each suite
that failed outside its tests. scripts/suite-failure-reporter.test.js runs the fixtures in
scripts/fixtures, whose names keep them out of test discovery, with the check script's own
arguments. The edit hook passes the same reporter, with tap on stdout, and quotes those
lines in its feedback. A plain node --test run, including one inside a plugin, has no such guard,
so keep file reads, processes and fixture setup in before hooks or tests rather than in describe
callbacks.

The configured commit gate can use an optional private name blocklist. Its name scan passes when no
list is available, so a successful commit is not proof that this optional filter checked any names.
The commit-msg gate also runs scripts/git-hooks/release-gate.js on a commit whose subject is
`Release <plugin> <version>`, reading the staged files. It judges only a subject whose `<plugin>`
is an entry in the staged `.claude-plugin/marketplace.json`. That catalog and the plugins' release
procedure moved to the plugins' repositories and the Foundry marketplace, so with no such file
the gate passes every subject unjudged; its tests still exercise it on in-memory trees. It does
not run the test suites.

## Contributor setup

Use the Node major selected by .nvmrc and run from a Git checkout. No dependency installation
is needed at the root. Run npm run check from the root. The suites create disposable
Git fixtures and use Node's built-in test runner.

The repository edit hook is configured in .claude/settings.json and .codex/hooks.json.
It was written to rerun the tests of the plugin an edit lands in: after an edit to a .js or .mjs
file under `<plugin>/scripts`, `hooks` or `templates`, where `<plugin>` is a top-level folder that
holds `.claude-plugin/plugin.json`, it ran the test files that reach the edited file. No such
folder exists in Slag now, so the hook prints nothing and exits 0 after every edit; its
registrations stay as they are until the owner decides to change them, and scripts/claude-hooks
keeps its tests, which run on temporary plugin folders. The runs shared a 110-second budget,
TEST_TIMEOUT_MS, under the 120-second timeout at which the host stops the hook.
Those adapters are repository development configuration, separate from shipped plugin hooks.

The optional Git gates can be enabled for a clone with git config core.hooksPath scripts/git-hooks.
Their name scans read HOUSE_REFERENCE_BLOCKLIST first, then a nonempty .private/reference-names.txt
in the current directory, then the parent directory. With no readable nonempty list, the name scans
pass; the release gate needs no list.
This optional input is not required by public tests or plugin installation.
