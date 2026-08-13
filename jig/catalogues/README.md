# The error catalogues

Six machine-readable editions live beside this file, one per language ecosystem, plus
[`index.json`](index.json). This file explains what the data means and what it does not claim.

**Written 2026-08-13.** Every edition carries `"schemaVersion": 3`, and [`index.json`](index.json)
carries it too. Every edition uses the schema the same way: one field is conditional — `uninstall`,
which is present on exactly the entries that install a package — and no edition carries a key the
others do not.

v3 adds four fields to v2. `detect.commentSyntax` says how to read a comment in each extension the
edition claims. `toolchain[].installKind` says what an `install` command actually does, so a
scaffold command and a package install are never confused. `toolchain[].uninstall` is the way back
out of a package install. `toolchain[].seed` is a violation planted to prove one tool catches
something, which is not the same artifact as a class fixture. `verify` gained `expectedExit`
alongside its prose `expected` in the same bump, because a reader cannot act on prose.

## What an edition is

An edition is one language ecosystem's answer to the same four questions:

1. How do you recognise this ecosystem from a repository scan — `detect`.
2. What tools does a project in it install, and how are they wired to fail a build — `toolchain`.
3. What goes wrong in it — `classes`.
4. What is still not caught — `gapNotes`, on every class.

An edition holds data only. No detector logic lives here; pattern evaluation belongs to the check
driver and the runner. Nothing in an edition gates an install — catalogues inform.

## The file shape

```
{ schemaVersion: 3, edition, displayName, researchedOn,
  detect:    { files, extensions, commentSyntax, packageManagers },
  toolchain: [{ id, role, why, installKind, install, uninstall, configPath, configSample,
                wiring, ciStep, seed: { path, sample },
                verify: { argv, expected, expectedExit } }],
  classes:   [ … ] }
```

`detect.commentSyntax` maps every extension in `detect.extensions` to one comment style, and the
two lists match entry for entry in all six editions — 26 extensions, 26 styles. An extension no
edition claims has no style, and a reader that finds none blanks nothing.

`install` and `uninstall` are keyed by package manager, and by the same managers on both sides: a
tool installable under four managers states four ways out. `uninstall` is present on every
`package` entry — 20 of the 37 — and on none of the other 17, which install nothing to undo.

`seed` is one file: `path` is where it goes, `sample` is what it contains. It is a violation the
tool is expected to catch, so it belongs to the tool rather than to a class, and it is written
under a directory the caller names — several seeds are called `Cargo.toml` or `pyproject.toml` and
would otherwise land on a project's own manifest.

`verify.expectedExit` is the exit code that means the tool caught the seeded violation. Every entry
states a single integer, and it is not always 1: `101` wherever the Rust compiler refuses the
crate, `100` for the Rust test runner, `2` for the TypeScript compiler.

A class row:

```
{ id, title, axes, agentModes, severity,
  detectors: [{ actor, lever, confidence, params }],
  fixtures:  { violation, nearMiss },
  gapNotes,
  evidence:  { tier, source } }
```

`detectors` may be empty. It is empty only where the edition has argued in `gapNotes` that nothing
available to it catches the class, and the class is then recorded as a known blind spot rather than
dropped. Two classes across the six editions are in that state, both in `javascript-typescript`.

## The closed vocabularies

A reader never has to guess which values are legal.

| Field | Legal values |
| --- | --- |
| `axes` | `human`, `agent` — a class can carry both, written in that order |
| `severity` | `hygiene`, `safety` |
| `detectors[].actor` | `human-editor`, `human-ci`, `claude-session`, `codex-session` |
| `detectors[].lever` | `check-driver`, `tool-rule` |
| `detectors[].confidence` | `deterministic`, `heuristic` |
| `evidence.tier` | `experiment-supported`, `documented`, `inherited`, `reasoned` |
| `toolchain[].role` | `build`, `formatter`, `linter`, `security-scanner`, `test-runner`, `type-checker` |
| `toolchain[].installKind` | `package`, `scaffold`, `builtin`, `audit` |
| `detect.commentSyntax[…]` | `hash`, `slash`, `none` |

Three of those vocabularies are only partly used, and the unused half is the honest part:

- No detector in any edition names `claude-session` or `codex-session`. Every detector is either a
  `check-driver` pattern run for `human-editor` or a `tool-rule` run for `human-ci`. Actor and
  lever are paired in all 287 detectors; nothing mixes them.
- No class is `experiment-supported` or `inherited`. 122 are `documented`, 19 are `reasoned`.
- `agentModes` is free text, not a vocabulary. It is required when the class carries the `agent`
  axis and empty otherwise.

`installKind` says what the `install` command does, which is not always an install:

- `package` — adds a dependency or a binary. 20 entries, each with an `uninstall`.
- `scaffold` — writes project files the tool then reads. 5 entries.
- `builtin` — ships with the language toolchain; the command only runs it. 5 entries.
- `audit` — the command runs the tool rather than installing it, because the project's own build
  configuration is what brings it in. 7 entries, 6 of them in `jvm`.

`params` is shaped by the lever, not by the class:

- `check-driver` — `paths`, `patterns`, `perLine`, `stripComments`, `stripStrings`. Every pattern
  compiles as a regular expression.
- `tool-rule` — `tool`, `rule`, `options`. `tool` is always an id declared in the same edition's
  `toolchain`; no detector names a tool the edition does not install.

## How a class id is shared

A class id names the mistake, not the syntax. The same underlying mistake carries the same id in
every edition that records it, so a caller can name a class once and have it mean the same thing in
six languages. Everything language-specific stays in the row around the id:
`title`, `agentModes`, `detectors` and `fixtures` are written in the local idiom and are expected
to differ.

So `swallowed-exception` is an empty `catch` block in three editions, `_ = f()` in Go and a
discarded `Result` in Rust. `type-widened-to-any` is `any`, `Any`, `interface{}`/`any`, `Object`,
`dyn Any` and `dynamic`. The id is the same because the mistake is: the checker was silenced
instead of satisfied.

Twenty-six of the seventy-seven distinct ids are shared:

| Shared id | Editions |
| --- | --- |
| `blanket-lint-suppression` | all six |
| `hardcoded-secret` | all six |
| `skipped-test` | all six |
| `softened-assertion` | all six |
| `swallowed-exception` | all six |
| `type-widened-to-any` | all six |
| `debug-artifact-left-behind` | go, javascript-typescript, jvm, python, rust |
| `hardcoded-config-value` | dotnet, javascript-typescript, jvm, python, rust |
| `invented-import-or-api` | dotnet, go, javascript-typescript, python, rust |
| `emptied-test-body` | go, javascript-typescript, python, rust |
| `catch-all-exception` | dotnet, jvm, python |
| `non-null-assertion` | dotnet, javascript-typescript, jvm |
| `test-without-assertion` | dotnet, javascript-typescript, jvm |
| `blanket-type-suppression` | javascript-typescript, python |
| `blocking-call-in-async` | dotnet, rust |
| `build-check-disabled` | dotnet, jvm |
| `commented-out-test` | dotnet, javascript-typescript |
| `lint-rule-turned-off` | dotnet, javascript-typescript |
| `process-exit-in-library` | go, rust |
| `sql-string-concatenation` | dotnet, go |
| `test-run-narrowed` | dotnet, python |
| `toothless-test-command` | go, javascript-typescript |
| `unawaited-async-call` | dotnet, javascript-typescript |
| `unchecked-index-access` | javascript-typescript, rust |
| `unclosed-resource` | go, jvm |
| `zero-tests-treated-as-pass` | dotnet, jvm |

The other fifty-one ids appear in one edition each, and they stay that way on purpose. A mistake
that only exists because of a language's rules gets its own id: `undocumented-unsafe`,
`redundant-clone-to-appease-borrowck`, `equals-without-hashcode`, `mutable-default-argument`,
`bare-recover-swallows-panic`, `async-void-method`, `phantom-dependency`,
`local-replace-directive-left-in-gomod`. Forcing those under a shared id would make the id mean
less, not more.

Two near-merges were left apart deliberately. Rust's `unwrap-on-fallible` and Go's
`type-assertion-without-comma-ok` sit next to the shared `non-null-assertion` and are not folded
into it: `!`, `!!` and `!` are one operator concept, while `unwrap` also stands in for error
handling and a comma-ok assertion is about type, not absence. Rust's
`numeric-cast-to-silence-checker` is kept apart from the JavaScript/TypeScript
`double-cast-through-unknown` for the same reason — an `as` cast between numeric types really
converts and can truncate; a double cast only lies about the type.

## The editions

| Edition | Classes | Toolchain |
| --- | --- | --- |
| `dotnet` — C# / .NET (dotnet CLI, csproj, NuGet) | 24 | csc, dotnet-analyzers, dotnet-format, xunit-analyzers, dotnet-test, nuget-audit, sonaranalyzer-csharp |
| `go` — Go (go modules, go toolchain) | 23 | golangci-lint, gofumpt, go-vet, go-test, go-build, govulncheck |
| `javascript-typescript` — JavaScript & TypeScript | 25 | eslint, typescript, vitest, prettier, audit |
| `jvm` — Java & Kotlin (Gradle / Maven) | 21 | gradle, checkstyle, pmd, errorprone, detekt, spotbugs, junit5 |
| `python` — Python | 25 | ruff, ruff-format, mypy, pytest, pip-audit, build |
| `rust` — Rust (cargo / Cargo.toml / workspaces) | 23 | clippy, rustfmt, cargo-check, cargo-nextest, cargo-deny, cargo |

141 classes, 287 detectors, 77 distinct ids.

## index.json

`index.json` exists so a loader can pick an edition from a repository scan without parsing half a
megabyte of class rows:

```
{ schemaVersion: 3,
  editions: [{ id, displayName, file, classCount, detect }] }
```

`detect` is copied verbatim from the edition it names — `commentSyntax` included, since v3 — so
the scan and the file agree by construction, and a reader can pick a comment style for an
extension without opening half a megabyte of class rows. Nothing else is duplicated —
`classCount` is the only derived number in it, and it is the count of rows in that edition's
`classes`.

## What this data does not claim

- **No class is measured.** 122 rows are `documented`, meaning a tool's own reference confirms the
  rule id, the flag or the syntax the row asserts. 19 are `reasoned`, meaning nothing but the
  argument in `evidence.source` stands behind them. Nothing here says which of these classes
  actually costs projects the most, because that has not been measured.
- **Coverage is uneven across editions.** A shared id does not mean equal detection. The same class
  can carry two tool rules and a pattern in one edition and a single heuristic pattern in another.
- **53 of 287 detectors are heuristic**, per detector rather than per lever. A deterministic lever
  carries heuristic patterns in several places, which is why `confidence` sits on the detector.
- **`dotnet` is the thinnest edition.** It has the fewest detectors per class (1.54 against 2.52
  for `rust`), the highest heuristic share (12 of 37), eleven classes whose only detection is a
  check-driver regular expression with no tool rule behind it, and three declared tools that no
  detector references. `go` is second thinnest on the same measures.
- **`verify` blocks are declared, not executed.** Every tool in every edition carries an `argv`, an
  `expected` string and an `expectedExit`. None of the 37 has been run, and neither has any `seed`
  been planted: the exit code a seed is expected to produce is an assertion about the tool, not a
  measurement of it.
- **`uninstall` commands are declared, not executed either.** They are written to be runnable as
  plain argv, with one exception: all three of `go`'s package tools state a removal that only a
  shell could expand, so a reader that refuses shells has to hand those three back to the owner.

## Deliberately absent

There is no schema file. The vocabularies above are the schema, and the six editions are the only
consumers. There is no severity ordering, no scoring and no ranking between classes — `hygiene` and
`safety` are labels, not weights. There is no per-class prose for a human to read at install time;
`title` and `gapNotes` are all the prose an edition carries.
