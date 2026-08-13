# jig scope

- **Status:** ratified — the three open forks answered by the owner on
  2026-08-13 and recorded under "Decisions", the four reversals in "What this
  reverses" signed off by the owner the same day, and cut as 2.0.0. Existing
  gaps between this contract and the implementation are migration work, not
  exceptions to the scope.
- **Product:** jig
- **Host:** Claude Code
- **Default mode:** scaffolding, per-item approval, journaled and reversible
- **Cut as 2.0.0 on 2026-08-13**, green at 390 tests. Every unit landed: the blanker fix with a
  drift test, six editions at schema v3, the three new modules (`scripts/editions.js`,
  `scripts/admission.js`, `scripts/toolchain.js`), the `scripts/jig.js` wiring with all four gates
  deleted, the arming rewrite in `hooks/jig-lib.js`, the rewritten skills, `scripts/migrate.js`, and
  the suite repair with gates G1 to G4. Measured over the shipped editions: 115 of 115 checks pass
  their own fixture pair, with 8 within-edition cross-sample hits disclosed in the README.

This document defines what jig is, what it owns, and what it must never
become. The gap between this contract and the 1.0.1 implementation is
migration work, not a set of exceptions.

## Product definition

jig is a project hardener.

> Point it at a repository or at a project idea. It reads what is there,
> interviews the owner until the picture is complete, and then installs the
> whole apparatus that catches bad work before it lands: the linter and its
> config, the type checker and its strictness, the test runner and its wiring,
> the CI that runs all of it, and a set of project-specific checks written for
> this codebase. Every file it writes is named and approved first, and every
> byte is reversible.

The measure of success is a repository where a drifting agent session cannot
call something done that is not done, and cannot quietly weaken the thing that
would have caught it.

## Why 1.0.1 does not meet this

Recorded so the rework is aimed at causes rather than symptoms. Each line is
observable in a real install.

| Symptom | Cause in the 1.0.1 design |
| --- | --- |
| 3 checks installed, 19 classes sent to a backlog | `installableAtV1` gates every class; only 4 of 22 pass it |
| Nothing catchable outside JavaScript | The shipped catalogue is a Node edition; every path glob is a JS, TS, shell, YAML or Dockerfile pattern |
| No linter, no type checker after an install | `jig never downloads a tool` — an absent tool is stamped as a gap and left there |
| Guards never blocked anything | Nothing installs armed; arming is a separate ceremony in `/jig:review` gated on ten clean sessions |
| The checks never ran locally | The pre-commit line is printed as a proposal the user pastes by hand |

The common root is one stance: 1.0.1 treats the model as untrusted and the
catalogue as the only authority it may act through. That stance bought
verifiability and paid for it with a ceiling of four mistake classes in one
language.

## The stance that replaces it

The catalogue informs. The model authors. The fixture proves. The owner
approves.

Verifiability moves from *where the check came from* to *whether the check
demonstrably works*. That is a stronger test than catalogue membership, and it
has no ceiling.

The catalogue keeps a job, and it is a different job. In 1.0.1 it was the gate:
a class outside it could not be installed at all, in any language. Here it is
reference material the model reads for shape, naming, severity and calibration
in the language at hand. It never bounds what may be installed.
`installableAtV1` and every gate computed from it are deleted.

## What this reverses

Four contracts in 1.0.1 are load-bearing in code, in the skill, and in the
release gates. Each is reversed deliberately, not relaxed.

| 1.0.1 contract | Replacement |
| --- | --- |
| jig writes only under `.jig/` and `.github/workflows/` | jig writes anywhere the owner approves by name, one path at a time, every write journaled with its pre-image |
| jig never downloads a tool; an absent tool is a gap | jig proposes the exact install command, shows it, and runs it on approval |
| Free text never becomes a pattern; the catalogue gates what may be installed | The model writes the check and its fixtures; the fixture pair is what admits it. The catalogue informs and never gates |
| One catalogue, Node edition, four installable classes | One catalogue per widely-used language, each researched before the release that ships it |
| Nothing installs armed; arming is earned over ten clean sessions | A check whose fixture pair passes is proven at install and blocks from install. Observe mode remains available as an explicit choice, never as required probation |

`tests/release-gates.test.js` currently asserts the first contract as a release
gate. That gate is rewritten, not deleted: the new gate asserts that every
write outside `.jig/` carries a recorded per-item approval and a journalled
pre-image.

## What survives unchanged

These are the parts of 1.0.1 worth keeping, and they are the reason this is a
rework rather than a new plugin.

- **The journal.** `journalledWrite`, `loadPreImage`, `restoreWrite` and
  `replayJournal` already record every write with its original bytes and put
  them back byte for byte. Widening the write boundary makes this machinery
  more important, not less.
- **`revert --all`.** One command undoes an install. It must keep working when
  the install now includes `package.json` edits and an added dependency.
- **The witnessed catch.** `selftest --live` refuses to describe anything as
  covered until a guard has been seen catching a planted violation and the
  ledger has grown a line proving it. This becomes the central admission test
  rather than a closing formality.
- **Two-tier consent.** Report-only artifacts approved in a batch; anything
  that can refuse a call or fail a build approved one at a time by id.
- **The scan.** `profile.json` already reads the stack, the toolchain, the
  version manager, the occupied hook slots and the orphaned governance docs.
  Every one of those facts is an input the new flow needs.
- **The ledger.** Per-guard history, false-positive recording, and the drift
  report on a re-run.

## The install, after the rework

1. **Scan.** Unchanged in kind. Read the stack, the toolchain, the history,
   the hook slots, the governance docs.
2. **Interview.** Rounds continue until the frontier is empty, as today. Two
   things change: the class list is no longer a fixed multi-select drawn from
   the catalogue, and free text is a first-class input rather than a
   catalogue-selection device. On a project that does not exist yet, the
   interview is the only input, and it must ask enough to stand in for a scan.
3. **Toolchain proposal.** For the language the scan found, jig proposes the
   standard apparatus: linter, formatter, type checker, test runner, CI. Each
   one is a named item carrying the exact install command and the exact config
   it would write. Nothing is installed that the owner did not tick.
4. **Check authoring.** For each mistake the interview surfaced, the model
   writes a check module, a violation fixture, and a near-miss fixture.
5. **The admission test.** Every authored check runs against its own pair. It
   must fire on the violation and stay silent on the near-miss. A check that
   fails either half is discarded before the owner is ever shown it as
   coverage. Discarded checks are reported, never hidden.
6. **Plan and consent.** The coverage matrix reports what each surviving check
   covers and for which actor. Consent in the same two tiers as today.
7. **Apply.** Journaled writes, per-item. Tool installs run here, each one
   already approved by name in step 6.
8. **Witnessed close.** As today, but now covering the installed toolchain as
   well: the linter config is proven by running the project's own linter over
   a seeded violation.

## Build decisions

A read-only mapping pass over the 1.0.1 engine produced 187 required changes and 49 questions the
map could not answer alone. They are answered here so the build has one spec. Each is a routine
call made to serve the contract above; none of them reopens it.

### Write boundary

| Question | Decision |
| --- | --- |
| What is the approval token | `--change <id> --path <rel>` together. A change id alone does not name a path, so an edited plan could point an approved id somewhere else. Mismatch is a refusal |
| Does the approval record carry identity | No. Mechanism and timestamp only. jig has no notion of a user and must not start carrying one |
| Is a tool install its own change kind | Yes, `run-install`. It still emits per-path write rows for the manifest and the lockfile, so the journal replay is untouched |
| How is an install undone | Restore the manifest and lockfile pre-images, then run the ecosystem's reconcile command as its own approved item, shown verbatim. Never silently |
| Does `write-settings` keep its probe gate | Yes. Per-item approval is added to it, not substituted for it. Two gates on the riskiest path is correct |
| Is `.git/` writable | No. An explicit refusal in `targetProblem`, not a side effect of a list |
| Are jig's own `.jig/` writes journaled | No. They are jig's state, and `revert` removes them wholesale |

### Arming

| Question | Decision |
| --- | --- |
| Where does the deny triple come from | The model authors reason, alternative and override alongside the check. A missing part discards the check, exactly as a failing fixture does |
| What binds a proof to the check it proves | A hash of the check module and both fixtures, recorded in the manifest and re-checked before a guard is treated as armed. A hand-edited config cannot claim a proof it does not have |
| Does top-level `config.mode` survive | No. Per-guard modes only. One word that silently arms twenty checks is too much blast radius |
| Is provenance per-plan or per-guard | Per-guard |
| What mode does a migrated 1.0.1 guard take | Whatever the old config recorded, until the owner says otherwise |
| Do the observe zones survive | Yes |
| Does the ten-clean-session ladder survive | No. Observe is a choice the owner makes, never a probation a guard serves |

### Catalogue

| Question | Decision |
| --- | --- |
| Are session guards catalogue-derived or authored | Authored, on the same path as the checks. One authoring story, not two |
| How do 1.0.1 class ids migrate | An explicit old-to-new map. `silent-catch` becomes `swallowed-exception`, `focused-or-skipped-test` becomes `skipped-test`. `pipe-to-shell` and `test-file-deletion` have no edition equivalent and carry forward as authored checks |
| What happens on a polyglot repository | Every matching edition loads. Class ids are namespaced by edition, so a shared id is never ambiguous |
| Does `hostNeutralFloor` stay a release gate | No. It becomes a report. A class nothing catches is a disclosed gap, not a refusal |
| Which editions ship | All six |
| What replaces the template hash on a tool config | The journal pre-image. Said plainly rather than implied |

### Toolchain

| Question | Decision |
| --- | --- |
| How is tool presence determined | Probe the tool's own `verify.argv[0] --version`, then read the language's manifest. No schema field for it |
| What about `install` rows that are not installs | The schema gains `installKind`, so a scaffold command and a package install are never confused |
| Is install, config and wiring one item or three | One item per tool. Revert undoes the tool whole |
| How is a global install undone | The schema gains `uninstall` per package manager. A tool with no uninstall path is refused, because jig never leaves an install it cannot undo |
| What counts as caught for a non-zero exit | The schema gains `expectedExit`. Prose in `verify.expected` is not machine-readable and must stop being treated as if it were |
| Where does a tool's seeded violation come from | The schema gains a per-tool `seed`. A class fixture is not a tool fixture |
| Which package manager wins | Lockfile presence first, then what the manifest declares, then ask |
| Does the toolchain appear in the reviewed plan | Yes. `renderReviewMd` gains a toolchain section, because an install must be approved from a surface the owner actually read |

### Authoring and admission

| Question | Decision |
| --- | --- |
| Which consent tier is an authored check | Item. It can fail a build |
| Do fixtures live inline or as files | Inline in the module. They revert with the check and the selftest stays re-runnable forever |
| Is any near-miss hit a discard | Yes, strictly. A heuristic check may declare `expectedNearMissHits` up front, and that declaration is disclosed |
| Where are discarded checks recorded | `.jig/discarded.json`. A report that lives only in a transcript is hidden by morning |
| Does the driver keep reading the legacy selftest shape | No. Migration rewrites every installed check to the pair shape in one journaled transaction, rather than carrying a second contract forever |
| Is the admission test only a check against its own pair | No. Every admitted check also runs against every other admitted check's near-miss. That is what catches a check that fires on everything |
| Where does an authored id come from | A slug rule over the mistake's title, with a collision refusal |

### Tests and gates

| Question | Decision |
| --- | --- |
| Does "zero bytes into a file the user owns" survive | No. It becomes "nothing unapproved". The skill description says so too |
| Where does stable guard identity come from | The authored check supplies its own id; the proof hash binds it |
| Does `assumed` provenance survive | Yes, for quick start |
| How is a tool config proven | By running the tool's own `verify.argv`. `verifyBy` gains `exec`, and a passing exec is not an enforcement gap |
| What replaces the single efficacy headline | Per-edition pair results over all 141 pairs, plus the cross-class false-positive count |

### Driver

| Question | Decision |
| --- | --- |
| What do `stripComments` and `stripStrings` default to | True. Blanking more is the fewer-false-positives direction |
| Does the brace-glob fix ship here | Yes. Without it the largest edition's path sets match nothing and the blanker fix is unobservable |
| Where does comment syntax live | The edition declares it per extension. A filename table in the driver is the wrong home for language data |
| Is the corrected blanker a release gate | Yes. It runs over all 141 shipped pairs, and a single failure blocks the release |

## What jig must never become

- It never writes a byte it did not name and get approved first. Widening the
  write boundary raises this bar; it does not lower it.
- It never claims coverage it has not demonstrated. An authored check with a
  failing fixture pair is a discarded check, reported as discarded.
- It never leaves an install it cannot undo. A tool it installed is a tool
  `revert` removes.
- It never edits a file it did not write without recording the pre-image.
- It never silently substitutes a default for an answer the owner did not
  give. Provenance stays load-bearing.

## Decisions

Answered by the owner on 2026-08-13. Each supersedes the open fork it replaces.

1. **Standards source — pre-built per-language catalogues, not a live fetch.**
   Rather than a network round trip per tool at install time, jig ships a
   catalogue per widely-used language, researched before the release that
   carries it. Installs stay offline and fast. Staleness becomes a release
   cadence problem, answered by re-running the research, rather than a cost
   every user pays on every install.
2. **Upgrade path — migrate in place.** jig migrates a 1.0.1 install itself.
   It reads the existing manifest, ledger and checks, carries the ledger
   history forward under each guard's stable name, replaces the catalogue
   checks with their authored equivalents, and removes what the new shape no
   longer uses. The owner never runs `revert --all` first and never hand-edits
   anything under `.jig/`. The migration is one journaled transaction and
   reverts like any other.
3. **The catalogue's role — kept and widened.** The same programme as decision
   1. Nothing is deleted; the Node edition becomes one edition among several,
   and stops being a gate.

## Driver defects the catalogue work surfaced

Building the editions ran every authored pattern against its own fixture pair, which is the
admission test this document proposes. It immediately found three faults in the 1.0.1 comment and
string blanker, all confirmed at source. They are migration work, not catalogue work, and they sit
in both copies of the blanker — `jig/scripts/templates/run.mjs` and `jig/hooks/jig-lib.js` — so the
committed check driver and the session guards share them.

1. **`stripComments` is inert.** `blankRegions` reads only `opts.strings`. Comments are always
   blanked, whatever a catalogue asks for. Any class relying on reading comment text silently
   cannot work.
2. **Only six extensions get hash comments.** `HASH_COMMENT_EXT` holds `.sh`, `.bash`, `.zsh`,
   `.yml`, `.yaml` and `.toml`. Every other file gets JavaScript comment rules, so a `.py`, `.rb`
   or `.ps1` file has its `#` comments left intact and read as code. Commented-out lines trip
   checks.
3. **String bodies blank the file when `stripStrings` is off.** A `//` inside a URL literal blanks
   the rest of the line, and a `/*` inside a glob literal blanks the rest of the file. Both are
   ordinary content in configuration source.

Fault 2 alone means the 1.0.1 driver could not have served any non-JavaScript edition correctly,
whatever the catalogue said.

## The catalogue programme

Turning one Node edition into one per language is the largest single piece of
work in this rework, and it is research rather than engineering.

One agent per language, each answering the same brief for its own ecosystem:

- Which mistakes in this language actually cost teams work, and which of those
  an agent session produces on its own.
- The idiomatic tool that catches each one, named exactly: the linter and its
  specific rule, the type-system flag, the test-runner convention, the CI step.
- A violation sample and a near-miss sample per mistake, written in that
  language's own idiom rather than translated from another's.
- The install command and the config path each tool expects, per package
  manager that language uses.

Every edition ships in the shape the Node edition already has, so one loader
reads all of them and nothing in the engine hardcodes a language name.

First wave, owner to confirm: TypeScript and JavaScript, Python, Go, Rust,
Java and Kotlin, C#.

A language with no edition is not a refusal. The model authors from scratch and
the fixture pair remains the only admission test. An edition makes that work
better calibrated — never possible versus impossible.
