> **Codex port (2026-09-06).** This branch preserves Jig's behavioral contract
> and ports its delivery to Codex desktop and CLI. The historical Claude host
> measurements and roadmap decisions below are provenance, not evidence of
> Codex compatibility. Current host mappings, tested versions, and limitations
> are recorded in [docs/CODEX-COMPATIBILITY.md](docs/CODEX-COMPATIBILITY.md).
> Jig guards owner-selected mistakes; it does not add task-wide edit scope
> enforcement. Codex permission settings are never written, Stop remains
> advisory, and named approval, fixture proof, and reversible writes still apply.

# jig scope

- **Status:** shipped. **2.14.0 (2026-09-03)** is the post-derail correctness
  release: the harness jig installs was inert or red on real machines, and every
  arm of that was driven rather than reasoned about. On win32 the host's shell
  tool is `PowerShell`, which no matcher matched, so no command guard evaluated
  and no verification run was witnessed — `SHELL_TOOLS`/`HOST_SHELL_TOOL` in
  `scripts/vocab.js` is now the single source behind `hooks.json`, `EVENT_TOOLS`,
  `LEVER_TOOLS`, `isWitnessEvent`, `guardProbe` and `HOOK_SLOTS`, with the
  POSIX-idiom limit disclosed on the plan and in the SKILL. `selftest --live`
  deleted project files it had refused to overwrite, with no pre-image; removal
  is conditional on the run having planted the path. `apply --plan` skips changes
  already applied, so a mixed plan's batch tier is reachable. Starter bodies carry
  a version and a sha256, gated at load. Admission proves every pattern on its
  own rather than counting one hit per detector. And five red-lane defects across
  python, jvm, dotnet, rust and javascript were each reproduced on a greenfield
  install and re-driven after the fix, with gates G10 widened and G12, G13, G14
  added so none of them can return green. Nine rows below were amended or added.
  Suite 896 (869 pass, 0 fail, 27 named skips).
- **Status:** shipped. **2.13.0 (2026-09-02)** closes the derail pass: the one
  candidate the study deferred to "later", and the four claims the programme had
  shipped without proving. `params.extract` is a fourth detector kind — one
  capture-group regex over `paths`, every captured name required to appear in the
  union of `pairedWith`, admitted on a fenced doc/union pair and crossing only
  among extract kinds. A `--verify` run in any lane writes the witness row, so
  `lastGreen` answers for all three. A toolchain probe carries the tool's output.
  And two host questions were PROBED on a live Claude Code 2.1.257 rather than
  inferred: `PostToolUseFailure` fires, carries the command, replaces rather than
  accompanies `PostToolUse`, and delivers its exit code in `error` and not in a
  tool response — so `exitCodeOf` was looking in the wrong place; and a PreToolUse
  reply carrying only `additionalContext` reaches the model, which is what let
  teaching widen to both runners. A third question stays recorded as **not
  probed**. Record: `docs/research/jig/HOST-PROBE-2026-09-02.md`.
  Suite 783 (780 pass, 3 disclosed skips).
- **Status:** shipped. **2.12.0 (2026-09-02)** is the derail pass's sixth release
  and the last of the adopted programme: scaffold and catalogue. Every edition
  that writes a project file now writes the tree its own build and tests pass on,
  and release gate G7 scaffolds each one on every run and refuses on a red exit or
  a run that proved nothing; installs journal what the command created, and gate
  G8 refuses a tool whose install escapes the project root with no uninstall; the
  catalogue gains 18 classes including a `test-config-loosened` per edition; the
  interview carries four standing offers for the routes around the harness;
  forensics offers a stale pair from the owner's own history; the removal detector
  gets its commit lane; and the coverage matrix reads the installed state as well
  as the plan. Four rows below were amended or added for it.
  Suite 756 (753 pass, 3 disclosed skips).
- **Status:** shipped. **2.11.0 (2026-09-02)** is the derail pass's fifth release:
  prevent before the bytes land, and see the deleted assertion. A new `edit-guard`
  lever denies an Edit or Write at PreToolUse with its own admission proof and a
  `migrate` pass that re-records each moved guard's proof as one approved change;
  `params.removed` is a third detector kind admitted on a fenced before/after pair,
  with six `test-count-dropped` classes; jig's own config, checks, kill switch and
  workflow are guardable as authored checks; an observing guard teaches only where
  its owner set `teach` on it; `migrate` refuses before dropping a guard; and the
  hook library stopped loading the engine, cutting about 16ms from every hook spawn.
  Four rows below were added for it. Suite 706 (705 pass, 1 platform skip).
- **Status:** shipped. **2.10.0 (2026-09-02)** is the derail pass's fourth release:
  proof of verification. A Bash call that runs a `.jig/verify.json` entry leaves a
  row naming the entry and its outcome and no command text; `Stop`/`SubagentStop`
  emit one `additionalContext` line and never block, and stay silent and free where
  no lane entry exists; the commit lane's findings reach the ledger; `fired` gains a
  denominator, a denied/would-deny split and a last-fired stamp; `/jig:review` gains
  a since-install view mined from git. Two rows below were added for it — whether
  the Stop registration is item-tier, and whether the red signal is proven. It is
  not yet, and that is disclosed rather than assumed. Suite 652 (651 pass, 1 skip).
- **Status:** shipped. **2.9.0 (2026-09-02)** is the derail pass's third release:
  the lanes run the real work. The linter, type checker and test runner jig
  installs get a `.jig/verify.json` entry and a CI step, and a commit-lane step
  on request; the commit hook reads the staged bytes; the witnessed close runs
  `execVerify` over a planted seed and a clean baseline instead of describing
  it; npm, pnpm and yarn install on Windows through their JS entry, and Gradle
  on win32 is a disclosed refusal; a starter is green on line one. Two rows
  below were widened for it — the committed `.jig` set gains `verify.json`, and
  the composition families become four. Suite 610 (609 pass, 1 platform skip).
- **Status:** shipped. **2.8.0 (2026-09-02)** is the derail pass's second release:
  consent and admission cannot be fooled. Every lever a check can carry is proven
  by the code that runs it before the check is called coverage, a re-run carries
  the installed guards forward instead of proposing an empty list, `apply --plan`
  refuses the item tier, `disarm`/`retire`/`fp` pause for the same token as any
  other change, `fp --clear` exists, the owner approves the words a blocked agent
  reads, and `--quick` is computed with a recorded basis. Suite 537/537.
- **Status:** shipped. **2.7.2 (2026-09-02)** is the derail pass's first release:
  what jig says is true, and undo works. `revert --all` runs without `--force`,
  a guard respects the files it was scoped to, a refspec cannot dodge an armed
  guard, seven reports stop claiming a state jig can read, zero runnable checks
  is a refusal, and every printed command exists. Suite 499/499.
- **Status:** adopted, in flight. **The derail pass (2026-09-02)** answers eight
  owner questions in the Derail pass table below and puts the programme in
  `docs/research/jig/DERAIL-PASS-2026-09-01.md` on the roadmap as releases
  2.7.2 through 2.12.0. It supersedes the programme in `HARNESS-PASS-2026-09-01.md`.
- **Status:** ratified. **2.7.0 (2026-08-29)** stops `.jig/activation.md` telling
  the owner to do something jig already did. The wiring plan now rewrites the
  file in the same plan that makes it stale, the unwired text stops claiming jig
  cannot do the wiring, and `--refresh-activation` puts an older install back in
  step. The five new rows in the Activation table are that release's decisions,
  answered by the owner on 2026-08-29.
- **Status:** ratified. **2.6.0 (2026-08-29)** adds jig's third surface. `/jig:jig`
  installs and `/jig:review` reports what the guards have caught and acts on it;
  nothing answered what jig had put in the repository, why it was approved, or
  whether it was watching anything today. `/jig:inventory` is that answer, and
  the six new rows in the Reporting table are that release's decisions, answered
  by the owner on 2026-08-29.
- **Status:** ratified. **2.5.0 (2026-08-29)** adds the second detector kind.
  Every check jig could install was a regular expression over text, so a mistake
  that lives between two files — the doc that stopped describing the module —
  had no shape jig could carry. `pairedWith` gives it one, and the five new rows
  in the Authoring and admission table are that release's decisions, answered by
  the owner on 2026-08-29.
- **Status:** ratified. **2.4.0 (2026-08-27)** narrows one refusal and closes
  the gap it was hiding: jig may now set `core.hooksPath` on the owner's
  approval, and it reads where git actually looks for hooks instead of assuming
  a repository with no committed hook has no hook at all. The three new rows in
  the Write boundary table are that release's decisions, answered by the owner
  on 2026-08-27.
- **Status:** ratified and shipped. **2.2.0 (2026-08-21)** made greenfield a
  first-class run and repaired the config-writing model it depends on; the four
  new rows in the Toolchain table below are that release's decisions.
- **Status (2.0.0):** ratified and shipped. The three open forks were answered by the
  owner on 2026-08-13 and are recorded under "Decisions"; the four reversals in
  "What this reverses" were signed off the same day; jig was cut as 2.0.0 with
  the suite green at 390 tests. **This document describes what jig is, not what
  it is going to be.** Anything still open against it is tracked outside it.
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
become. Where any other document disagrees with it, this one wins.

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

## Why the superseded design did not meet this

**A post-mortem of 1.0.1, kept so the reasoning behind the reversals below is
not lost. None of these symptoms describes jig today** — each one is the reason
for a change that shipped in 2.0.0. Every line was observable in a real 1.0.1
install.

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

`tests/release-gates.test.js` no longer asserts the first contract. That gate was
rewritten rather than deleted, and now asserts that every write outside `.jig/`
carries a recorded per-item approval and a journalled pre-image.

## What the rework kept

These parts predate the rework and were kept deliberately. They are why this is
one plugin with a history rather than two plugins with the same name.

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

## The install

1. **Scan.** Read the stack, the toolchain, the history, the hook slots, the
   governance docs.
2. **Interview.** Rounds continue until the frontier is empty. The class list is
   not a fixed multi-select drawn from the catalogue, and free text is a
   first-class input rather than a catalogue-selection device. On a project that
   does not exist yet, the interview is the only input, and it must ask enough
   to stand in for a scan.
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
   covers and for which actor. Consent in two tiers.
7. **Apply.** Journaled writes, per-item. Tool installs run here, each one
   already approved by name in step 6. A repository that commits its own
   pre-commit hook can have jig's one check line woven into it, item-approved
   and reversible like any other write; jig never touches `.git/hooks/`.
8. **Witnessed close.** As today, and now covering the installed toolchain as
   well: `selftest --live --toolchain <ids>` proves the linter config by running
   the project's own linter over a seeded violation, journaled in and journaled
   out, and ledgers `verified` or `unverified` per tool. Each named tool also
   runs with no seed at all, so a repository that was already failing its own
   linter is disclosed as `baseline: red` rather than counted as a catch. A tool
   jig cannot start — an `npx` argv on Windows is a batch shim, and jig opens no
   shell — reports `cannotRun` with the command, never a skip that reads as a
   pass. So does a tool whose seed path is a file the project already owns:
   five shipped seeds are named after a manifest (`Cargo.toml`,
   `package-lock.json`, `requirements.txt`, `pyproject.toml`), jig will not
   write over one and will not remove one, and the close says the tool is
   unproven here rather than planting or deleting anything. Nothing is
   journaled for a seed that was never planted, and only a seed THIS run
   planted is removed. The commit lane is executed too, over a violation staged in a throwaway
   clone. Where no guard is installed at all, the check driver's own catch is the
   witness: that is the whole surface a checks-only install has.

## Build decisions

A read-only mapping pass over the 1.0.1 engine produced 187 required changes and 49 questions the
map could not answer alone. They are answered here so the build has one spec. Each is a routine
call made to serve the contract above; none of them reopens it.

### Write boundary

| Question | Decision |
| --- | --- |
| What is the approval token | `--change <id> --path <rel>` together. A change id alone does not name a path, so an edited plan could point an approved id somewhere else. Mismatch is a refusal |
| May a batch approval skip a change already applied (2.14.0) | Yes, and it must name every one it skipped. `apply --plan` filters the changes the journal already records as applied before it reads the tiers, because without that the item-tier refusal fires for ever and the batch half of any real plan is unreachable by the route that refusal points at. Already applied is journal AND disk together: the journal says which of the change's writes actually produced a file — an install records an intent for every candidate lockfile the ecosystem might use and an outcome with no hash for the ones its command never wrote — and the disk is asked about those and only those. A row that never produced a file is evidence of neither presence nor removal, and counting it made the filter false for ever on any project with an install in it. Skipping is not silence: the skipped ids and paths come back on the result, since a batch approval that quietly dropped half its list would be the same coverage claim the item tier exists to stop |
| Is a target that is GONE the same as one that was edited (2.14.0) | No, and it never was. The staleness refusal exists so jig never writes over a change it did not see; a path that is absent holds no change to write over, so it is graded as its own case and the approved bytes are written, journalled with a null pre-image like any other create, and reported as `restored` rather than `applied`. Graded as drift it made the documented repair route unfollowable: `apply --plan` named the deleted item-tier file's `--change`/`--path` pair, and that exact pair came back refused as an edit nobody had made. For a file that IS there and reads differently the refusal is unchanged and stays unchanged — that one is somebody's edit |
| Does the approval record carry identity | No. Mechanism and timestamp only. jig has no notion of a user and must not start carrying one |
| Is a tool install its own change kind | Yes, `run-install`. It still emits per-path write rows for the manifest and the lockfile, so the journal replay is untouched |
| How is an install undone | Restore the manifest and lockfile pre-images, then run the ecosystem's reconcile command as its own approved item, shown verbatim. Never silently |
| Does `write-settings` keep its probe gate | Yes. Per-item approval is added to it, not substituted for it. Two gates on the riskiest path is correct |
| May a probe arm assert that it concluded (2.14.0) | No arm may state its own `inconclusive` as a constant. P1 shipped `inconclusive: false`, on the one arm P2 derives its whole verdict from, while the transcript it grades can be silent for three reasons that are not a refusal — a crash, a timeout, and a session offered no shell tool. It now reads the transcript for the same three-way P3 already used: the command's output means it ran, a visible refusal means it was refused, and neither means the arm measured nothing. `green` already required every arm to have passed AND concluded, so an arm that measured nothing leaves the `write-settings` kind gated instead of unlocking it on a silence. The workspace-trust trap `HOST-PROBE-2026-09-02` recorded — an untrusted root having its settings entries dropped under `-p` — is disclosed above `tmpProject` as an unprobed cause of a RED, not detected: nobody measured that stderr line's text, and a regex for it would be a fabricated probe result |
| Is `.git/` writable | No. An explicit refusal in `targetProblem`, not a side effect of a list |
| May jig change a git SETTING (2.4.0) | Yes, one: `core.hooksPath`, through the `set-git-config` change kind. The bar on `.git/` was never about the directory — it was about the journal, which cannot hold a repository's pre-image. A setting's pre-image is a value, present or absent, and `git config` puts it back, so the reason does not reach it. Every path under `.git/` stays refused for every kind, this one included, and `set-git-config` may name no other key |
| Why that setting and no other (2.4.0) | Because it is the one thing standing between an install and a working commit lane, and the owner cannot be expected to know it exists. jig writes a hook at `.jig/hooks/pre-commit` and then leaves git pointed somewhere else — a harness that installs itself and does not connect itself. `plan --wire-commit` connects it, item-approved and reversible |
| What jig still refuses to do (2.4.0) | Write `.git/hooks/pre-commit`, repoint git when that would hide a hook the owner wrote, or wire anything without a named approval. The first is a file the journal cannot own; the second silently disables somebody's own check, which is worse than not installing |
| Are jig's own `.jig/` writes journaled | No. They are jig's state, and `revert` removes them wholesale |

### Arming

| Question | Decision |
| --- | --- |
| Where does the deny triple come from | The model authors reason, alternative and override alongside the check. A missing part discards the check, exactly as a failing fixture does |
| What binds a proof to the check it proves | A hash of the check module and both fixtures, recorded in the manifest and re-checked before a guard is treated as armed. A hand-edited config cannot claim a proof it does not have |
| Is a check that will not load the same as one with no deny reply (2.14.0) | No, and the ladder asks the load question first. A module that is missing or unreadable yields a null deny, so `effectiveState` reported a DELETED check as "the check ships no complete deny reply, so it is not armable at all" — untrue of the check, whose complete triple the same review row prints under `watches.deny`, and a reason `/jig:review` instructs the agent to print verbatim. One is an authoring defect in the check; the other is a file that is gone, and the owner acts on them differently. The evidence carries `problem` and, where it is set, that string IS the reason the guard is observing — one string, read from `guardEvidence` once, so the row's `problem` and its `demoted` can never say different things about the same missing file |
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
| How is tool presence determined (2.14.0) | Probe the thing that has to EXIST, then read the language's manifest. No schema field for it: the query is derived from `verify.argv`, which the edition already carries. `verify.argv[0] --version` was the whole rule until 2.14.0, and it answered for the host rather than for the tool wherever a host was in the way — all six rust tools read present on a machine carrying four, at cargo's own version, and `python -m build` read present at python's, so jig planned no install for a tool the owner had ticked and wired a lane entry that exits 101. So: a `builtin` IS its host and the host's answer is its own (`cargo check` ships inside cargo, and several such hosts reject `--version` while being perfectly present); a module is asked through its interpreter (`python -m build --version`); a subcommand a host dispatches to a separate program is asked as itself (`cargo nextest --version`); and a tool behind a runner that FETCHES what it is asked to run is not probed at all, because `npx eslint --version` installs eslint (measured 2026-09-02) and presence writes nothing. Where the query goes through a host, only an answer counts — the host runs either way — and where the probe IS the executable, running at all still counts, because `go --version` exits non-zero and go is still installed. An unprobeable tool is a disclosed unknown (`how: "unprobeable"`), never an absence, and jig plans an install the owner can decline, which is the safe direction where presence is unknown. Widened again inside 2.14.0 for a shape the first pass had no name for: a package with no executable ANYWHERE. `dotnet add package SonarAnalyzer.CSharp` writes a `PackageReference` and puts nothing on PATH; what then runs is `dotnet build`. `dotnet` is not a dispatching host, so all three .NET analyzer packages read present at the SDK's own 10.0.303, jig planned zero installs, told the owner "already here, config only", wrote three inert Sonar severities into `.editorconfig` and reported the lane GREEN over a linter that was not in the project. The rule that catches it is not "which hosts dispatch" but the row's own two commands: a `package` whose verify runs through the very program its install runs through has nothing to spawn, so nothing is spawned. What CAN be read is the manifest — the `PackageReference` is the only trace such a tool leaves — so the search now reaches the project files that carry one (`*.csproj` and friends, root and one level down, bounded) and the name it looks for is the install command's own operand rather than a subcommand of the host. Release gate G13 holds both: no probe may answer with the version of the tool's host, and the host of a package is now the program its install runs through |
| What about `install` rows that are not installs | The schema gains `installKind`, so a scaffold command and a package install are never confused |
| Does the row an owner ticks a tool from carry the config bytes (2.14.0) | Yes, and the edition's `why` with them. `toolchain.js` refuses a tool that ships no `configSample` on the stated grounds that otherwise "the owner would be approving an install with no config to read" — and `toolchainRow`, the row `jig.js toolchain` returns and the skill puts to the owner as a multi-select, dropped both fields. The owner was shown a config PATH and asked to approve the bytes at it sight unseen, which is the first thing this contract forbids. Both are on the row now, and the authoring skill's step 3 documents the key set the engine actually emits rather than the catalogue schema behind it |
| Is install, config and wiring one item or three | One item per tool. Revert undoes the tool whole |
| How is a global install undone (widened 2.12.0, split 2.14.0) | The schema gains `uninstall` per package manager. A tool with no uninstall path is refused, because jig never leaves an install it cannot undo. Since 2.12.0 there is one exemption and it is narrow: an install whose whole effect lands INSIDE the project root needs no command, because the journal's created-path rows put it back. The `installKind` says which — `scaffold`, `builtin`, `audit` — but the kind is a claim and the COMMAND is the fact, so a row is exempt only when its command also stays inside the root. A `builtin` that runs `rustup toolchain install`, or a `scaffold` that runs `dotnet nuget add source`, is refused exactly like a package: those write outside the root, the journal never sees them, and the kind on the row does not change that. Release gate G8 holds every shipped row to it. Split in 2.14.0, because one refusal was answering two questions. jig spawns no uninstall on ANY route — the command is journalled as `reconcile` and printed on the plan for the owner to run — so "is there a way back out" and "could jig spawn it" are different questions, and asking them as one cost the `go` edition its linter, its formatter and its scanner on every machine: `rm -f "$(go env GOPATH)/bin/gofumpt$(go env GOEXE)"` is the only correct undo Go has (there is no `go uninstall`, and `go clean -i` cleans packages of the current module, which a `pkg@latest` tool is not), it needs a shell to say GOPATH, and the parse refused it — so three of six go tools were structurally unofferable and the owner had nothing to act on. So: an install with no stated undo is refused exactly as before; an undo only a shell can run is DISCLOSED, carried verbatim with `uninstallManual` set and printed as the owner's own step. jig still opens no shell; the owner has one |
| What counts as caught for a non-zero exit | The schema gains `expectedExit`. Prose in `verify.expected` is not machine-readable and must stop being treated as if it were |
| Where does a tool's seeded violation come from | The schema gains a per-tool `seed`. A class fixture is not a tool fixture |
| Which package manager wins | Lockfile presence first, then what the manifest declares, then ask |
| Does the toolchain appear in the reviewed plan | Yes. `renderReviewMd` gains a toolchain section, because an install must be approved from a surface the owner actually read |
| Several tools name one config file (2.2.0) | One composed write, not one per tool. `scripts/sections.js` merges section files by block header and key, first writer wins, and every disputed key is reported on `configConflicts`. A shared file with a real grammar — `go.mod` — is written by NOBODY and each tool's snippet is handed back on `configNotes` |
| Which shared files compose (2.3.0, widened 2.9.0) | Four declarative families, one reader each in `scripts/sections.js`: section files, MSBuild property files (`<PropertyGroup>` is a block, each child element a key), and Gradle build scripts (`plugins { … }` is a block, assignments keyed and every other statement deduplicated by its text). All four obey the same first-writer-wins rule and report to `configConflicts`. The fourth, added in 2.9.0, is JSON manifests: a top-level object member is a block and its members are keys, which is what lets several tools' `scripts` entries land in one `package.json`. `go.mod` stays out: its samples are pictures of a module file, not fragments. Composition never sees a file the project already owns — those are handed back before it is reached — so every body merged is one jig shipped, and release gate G5 composes every shipped combination and proves no line is lost |
| Why compose `build.gradle.kts` rather than report it (2.3.0) | Because reporting it is wrong, not merely unhelpful. Gradle allows exactly one `plugins { }` block and it must come first, so handing the owner `gradle`'s snippet and `errorprone`'s snippet hands them a script that cannot compile |
| Where does a tool's wiring go when its own config file is not enough (2.15.0) | Into a second file the same composer merges, stated on the row as `scriptPath` and `scriptSample`. Four jvm tools write a config under `config/` that gradle reads only once a `plugins { }` block applies them: checkstyle, pmd, spotbugs and detekt. Those blocks were prose in `wiring`, which nothing composes, so jig wrote four config files, offered `./gradlew spotbugsMain` and `./gradlew detekt`, and both came back BUILD FAILED — no such task. Worse in the other direction: `checkstyle` and `pmd` were applied by the `gradle` row's own plugins block whether or not they were ticked, so a plan that installed gradle alone wrote a build script that turned both on with no config for either, and `gradle check` was red on the tree jig had just written. So a row states its OWN section and nothing else's, exactly as `configSample` is its own part of a shared config. The pair is stated together or not at all, it is a SECOND contribution rather than a replacement — the tool's config still lands under its own name — and a section is a passenger, never the driver: with nothing else in the plan writing that path it is handed back on `configNotes`, because a `plugins { }` block on its own is not a build file. That last rule is why the jvm starter carries a `build.gradle.kts` of its own now; a Gradle root with no build script has no `java` plugin and so no `check` task, which is what G7's jvm arm found the moment it stopped being skipped. Release gate G21 holds every shipped section to both halves: the path must be one `sections.mergeable` composes, and something in the edition must write it |
| A verify flag the MACHINE decides, not the project (2.15.0) | Asked once, dropped by name, never guessed. `go-test` verified with `go test -race -shuffle=on -count=1 ./...` and `-race` is built on cgo, so it needs a C compiler: `go env CGO_ENABLED` reads 0 wherever none is installed, which is the default state of a Windows box, and the commit lane jig had just written came back `FAILED go-test — exited 2` with `go: -race requires cgo`. A lane jig writes must not be red on the tree jig wrote. Dropping the flag from the shelf is not the answer either: the go edition's own `toothless-test-command` class lists "drops -race" among the agent modes it exists to catch, so jig would be shipping the softening it teaches owners to look for. So the row states `verify.dropUnless` — the flag, the probe argv that settles it, the stdout that keeps it, and the why — and the lane composer asks once. Two rules make it safe. The flag is KEPT when the probe cannot answer, because a probe that failed is not proof the flag would; and the narrowing is stated on the plan beside the refusals, because the owner approves the command that will run and a shorter one is a different command. `ciStep` keeps the flag either way — a CI runner has the toolchain. Release gate G22 holds every rule to four things: the flag is in the row's own argv, its value is attached rather than a separate token that dropping would strand, the probe runs the tool's own executable so it needs nothing extra installed, and `ciStep` still carries it. Driven here: `go env CGO_ENABLED` is 0, the unnarrowed command exits 2, and the lane jig writes exits 0 |
| Does an existing config file still cost the tool (2.2.0) | No. It used to: `toolchainProposal` refused any tool whose `configPath` was occupied, so a repository with its own `pyproject.toml` — every Python repository — was offered no toolchain at all. The tool is proposed, the install runs, and only the config becomes a note |
| Where does an ecosystem's project file live (2.2.0, widened 2.12.0) | `detect.manifest` on the edition, at schemaVersion 4. Exactly one of `sample` and `hint` is filled: a starter jig writes, or the sentence naming what only the owner can run. 2.12.0 adds a third key, `starter.files`, and it stays at schemaVersion 4 for the reason the analogous question was answered that way before: an edition that omits it loads and behaves exactly as it did, so nothing already on disk is made invalid by the addition and a version bump would only force every edition to be rewritten to say nothing new |
| May jig scaffold jvm and dotnet (2.3.0) | Yes, by writing a starter itself — NOT by running a generator. jig's contract is that every path is named before it is written, and `gradle init` creates a tree nobody listed, so revert could not undo what it did not know about. A hand-written starter is named on the plan like every other change. `go` keeps its hint: a module path is an identity, not a default |
| One edition, two build systems (2.3.0, answered for the toolchain 2.14.0) | `detect.manifest`'s `path`, `sample` and `hint` may each be a map keyed by package manager, the shape `install` already uses. `jvm` under gradle writes `settings.gradle.kts` and lets the build script compose from the tools; under maven it writes `pom.xml`. `validateManifest` checks every manager the edition claims, so a manager with no answer fails at load. What the row did not answer until 2.14.0 is what the TOOLCHAIN offers under each, and the default filled it in wrongly: `managerForTool` fell through to a tool's only install command whenever the chosen manager had none, so a `--edition jvm --package-manager maven` install took every row's gradle command — seven `.jig/verify.json` entries all reading `./gradlew`, which `mvn -N wrapper:wrapper` never creates, a `build.gradle.kts` written beside the pom, and both lanes exiting 1 on every machine. The fall-through is right for `rustup component add clippy` in a cargo tree and wrong here, and the edition already says which is which: a manager that needs its OWN project file is a different build system, one that shares the project file is a second door. So the fall-through is allowed only across a shared `detect.manifest.path`, and anything else is refused BY NAME onto `refused`. That leaves jvm's toolchain as Gradle's, which is what it has always actually been — every row's verify is a `./gradlew` task and its config a `build.gradle.kts` block or a file that script points at, and the `mvn checkstyle:check` style commands were plugin invocations against a pom jig writes no plugins into. They are gone rather than left as a claim: jig claims no coverage it has not demonstrated, and a Maven install now gets the pom starter, the guards, the checks and seven refusal lines saying why. Release gate G10 scaffolds one arm per distinct project file and holds it |
| What shape is a starter (2.3.0, widened 2.12.0) | The smallest file that makes the directory a project, with a placeholder name and a comment saying to rename it. The PROJECT FILE must build with no source files beside it — the dotnet starter is a library, not an executable — because jig runs the checks against it immediately, and a starter that fails its own first check is a harness that cries wolf. Choosing an application template stays the owner's. 2.12.0 says the rest out loud: on four ecosystems the project file alone does not build, so `starter.files` carries the smallest tree that does — one module and one smoke test — and release gate G7 scaffolds each one and runs that ecosystem's own build and test commands over it. Exit 0 is not the assertion; every one of those runners exits 0 having discovered nothing, so each arm also names the line a run that found the starter's test prints |
| May a starter file belong to one tool (2.12.0) | Yes, through an optional `tool` on the file, and only because two runners cannot read one file. `node --test` and vitest discover different names and neither can run the other's, so JavaScript ships one smoke test each and the vitest one is written only where vitest is in the plan — otherwise a project that ticked no test runner is scaffolded with an import nothing resolves, and the lint and the typecheck jig wired fail on the tree jig just wrote. The tool must be one the edition offers, checked at load, so an unreachable name is refused rather than silently never written |
| What version and hash does a starter body carry (2.14.0) | Its own, recorded in the edition file rather than in `templates.json`. Each `starter.files` entry carries a `version` and the `sha256` of its `body`, checked at load the way `templateBody` checks a template, so a body edited without restamping its `sha256` is refused before a plan exists. The `version` is NOT gated against the bytes and nothing here claims it is: a version is an assertion about history and only a hash is an assertion about a file, so bumping it when a body changes is the maintainer's discipline, exactly as it is for `templates.json`. The edition file rather than the template index because the body lives in the catalogue, and a hash two files away from the bytes it covers goes stale silently; `templates.json` keeps covering the files under `scripts/templates/`, which is what it is an index of. The write-side row is derived, never invented: `starter-<edition>-<path>` at the catalogue's version, so a manifest says which starter an install received and the hash it records at write time is the hash the catalogue published. A release gate hashes every shipped body against the `sha256` beside it, and checks the `version` for shape |
| Does requiring `version` and `sha256` bump the edition schemaVersion (2.14.0) | No, and the earlier answer's test does not reach it. `starter.files` stayed at schemaVersion 4 in 2.12.0 on the ground that an edition omitting it loads and behaves exactly as it did — a test about an OPTIONAL key. These two are required on an entry that exists, so the only file they can invalidate is one that already carries `starter.files`, and `loadEdition` is called with `PLUGIN_ROOT` and nothing else: every such file ships inside the plugin, in the same commit as the loader that reads it. There is no third-party edition file and no edition file on a user's disk, so a bump would version a compatibility surface that does not exist and would force all six catalogues rewritten to say nothing new. If `loadEdition` is ever pointed outside the plugin, this answer is void and the bump is owed |
| Who may cause a starter project file to be written (2.2.0) | Only `--edition`. Detection is a heuristic over file names and a `pyproject.toml` matches the rust edition too; creating a project file is a stated intent, never an inference |
| Must a config sample agree with every other tool in its edition (2.14.0) | Yes, over the starter, or the harness's first act is a red build. Three shipped configs did not, and each one turned the lane jig also writes red on a tree jig had just written: prettier's `printWidth: 100` against the 110-character `globalIgnores` line in the `eslint.config.mjs` jig writes one file over, `cargo`'s `members = ["crates/*"]` against a starter with no `crates/` directory (six of six lane entries red, `refused` and `configConflicts` both empty), and ruff's `PT` family against the `self.assertTrue` in jig's own starter test. No role is exempt, because a build tool's config is read by the linter that runs after it: a workspace with no members is not a shape jig can write and check immediately, so the `[workspace]` table keeps only what the one crate jig writes actually uses. Release gate G10 ticks EVERY tool an edition offers, so every config lands whether or not the tool is on the machine, and runs every tool it can run over the result. Widened twice more inside 2.14.0. The `security-scanner` role was excluded on the grounds that a scanner reports the state of the world rather than of this tree, and that exclusion is what shipped python's `pip-audit --strict` with no `-r`: a lane auditing whatever interpreter is on PATH, 48 vulnerabilities in 6 packages on a greenfield install, exit 1 on every machine including a clean venv, and beside it a `requirements.txt` jig wrote and never read, pinned by the tool's own `ciStep`. Every other edition's scanner is project-scoped by construction, and running them is what makes that checkable, so scanners run here now and pay the advisory query. And the gate scaffolds one arm per distinct project file rather than one per edition, so the other build system's half is built too — it never was, which is how a Maven install writing a `build.gradle.kts` went out |
| May a config sample set a floor jig's own starter cannot reach (2.14.0) | No, and the fix is the starter rather than the floor. pytest's `addopts` carries `--cov-fail-under=85` and the python starter's only test read the tree instead of importing it, so `pytest -q` exited 1 at 0% coverage on a greenfield install. Every other edition's starter test already exercises its own module; python's now does too, through a `pythonpath = ["src"]` in the pytest block jig writes and a second starter file tagged `tool: "pytest"`, named `*_test.py` so pytest discovers it and `python -m unittest` — which is what runs when no test runner was ticked — never sees the import. Lowering the floor would have retired a claim two classes cite (`emptied-test-body` names `--cov-fail-under` as its CI-side backstop) in order to fix a starter, which is the wrong direction |

### Authoring and admission

| Question | Decision |
| --- | --- |
| Which consent tier is an authored check | Item. It can fail a build |
| Do fixtures live inline or as files | Inline in the module. They revert with the check and the selftest stays re-runnable forever |
| Is any near-miss hit a discard | Yes, strictly. A heuristic check may declare `expectedNearMissHits` up front, and that declaration is disclosed |
| Where are discarded checks recorded | `.jig/discarded.json`. A report that lives only in a transcript is hidden by morning |
| Does the driver keep reading the legacy selftest shape | No. Migration rewrites every installed check to the pair shape in one journaled transaction, rather than carrying a second contract forever |
| What does a selftest over no check module mean (2.14.0) | Nothing is proven, and nothing failed. The report says so — "No check ran its own fixture pair, so nothing here is proven" — and the exit code stays 0. It exited 1 until 2.14.0, on the reasoning that an empty checks directory proves no coverage; the reasoning is right and the exit code was the wrong place to say it. A `--select` plan and a toolchain-only plan both land a `.jig/checks/` holding nothing but the driver, and the shipped workflow runs `--selftest` as its second step, so every such install pushed a red CI lane on a tree jig had just written — a harness whose first act is a red build, which this contract forbids in the same words as the starter row. The exit code answers "did a check fail here" and only the report answers "what is proven"; a check that claims the driver and carries no runnable pair still exits 1, because that one IS a failure. Release gate G12 runs every step of the workflow jig writes, in both shapes, over the tree jig just wrote |
| Is the admission test only a check against its own pair | No. Every admitted check also runs against every other admitted check's near-miss. That is what catches a check that fires on everything |
| What proves a detector that names several patterns (2.14.0, 235) | Each pattern, on its own — the rule that replaces "one hit per detector". Three of the four kinds evaluated a whole detector at once: the removal rule `.some()`d its spellings, the extract rule collected every capture before asking whether any was missing, and a session lever was handed to the runner with all its patterns on. So a second pattern added beside one the fixture already fires was admitted on that first pattern's hit and never proved. Two shipped rules were in exactly that state — jvm `deleted-test`'s `class \w*Tests?` and jvm `test-count-dropped`'s `@ParameterizedTest`, neither of which any fixture ever dropped — and both violation fixtures now drop what the rule names. The check-driver `patterns` kind was already per-pattern and needed nothing; the 185 the review counted is what a deletion sweep reports for ANY per-pattern rule, because deleting a pattern deletes its obligation with it, so that figure never bore on this. The alternative on the table was a per-detector declaration of which patterns share a fixture. It is refused: it buys a schema key, a disclosure column and a second way to read a detector against an authoring cost the catalogue does not pay — a detector's patterns are alternative spellings and one fixture carries them all. What the strict rule does cost is said where it lands instead: a detector whose spellings cannot coexist in one fixture, two languages under one glob set, is two checks and not one. The paired kind names two glob sets and no patterns, so its unit stays the DETECTOR — the same rule at the smallest thing that kind has to prove. Release gate G9 counts the patterns straight out of the catalogue and holds `ownPair` to that number, because a gate that asks admission how many proofs it owes cannot catch admission owing too few, and the README publishes the result beside the pair score: 256 of 256 |
| Where does an authored id come from | A slug rule over the mistake's title, with a collision refusal |
| Is a paired-change detector a new lever | No. It is a second kind under `check-driver`: `pairedWith` in place of `patterns`. A new lever would need its own artifact, its own consent tier and its own coverage column for a check that installs to the same file and runs in the same driver |
| What admits one, given it has no source to match | The same fixture pair, read as change sets — one path per line. The violation set touches `paths` and nothing in `pairedWith`; the near miss touches both. Inline and inline only, like every other pair |
| Does it cross against the pattern checks | No. The two kinds cross only within themselves. A source pattern over a list of paths, or a path rule over somebody's Python, compares two different kinds of thing and would discard checks at random. A paired check that fires on everything is still caught — by every other paired check's near miss |
| Which change set does it read | The staged one, and only that. A base ref would have to be guessed, and a guessed base makes one check say different things on a branch, on a merge and on a shallow CI clone. Three answers is worse than one disclosed limit |
| What does it do where nothing is staged | Reports itself skipped, never passed. CI is that case, and a green run that quietly skipped a class would be the coverage claim SCOPE forbids. The selftest still proves it there, because a change-set fixture needs no index |

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

### Reporting

Six questions answered by the owner on 2026-08-29, when `/jig:inventory` was
added as jig's third surface. `/jig:jig` installs, `/jig:review` reports what
the guards have **caught** and acts on it, and `/jig:inventory` reports what is
**here** — what jig put in the repository, why, and whether it is watching
anything today. A seventh row was added on 2026-09-02, when `fired` gained the
denominator it never had and the derail pass left the ledger's growth to the
implementation to settle.

| Question | Decision |
| --- | --- |
| Does the page the owner approved from survive the next plan (2.14.0) | Yes, under the plan's own id. `.jig/plan.md` and `.jig/plan.json` are fixed paths every later `plan` overwrites, and the skill orders a wiring plan straight after the install — so the coverage matrix an owner read and approved was destroyed by the next documented command, and `plan-<id>.json` carried only the changes, which cannot rebuild it. The record now carries the review payload beside its changes, and the rendered page is copied to `.jig/plan-<id>.md` at the same moment `plan.md` is written. The fixed names stay as the latest plan's, because that is what the skill reads at step 5; the id-stamped copies are what an approval refers back to. Both are derived, per-machine and in the generated ignore list, like `plan-<id>.json` already was |
| Is the plan.md armed header a claim about the checks below it (2.14.0) | No, and it stopped being written as one. `mode` is what was ASKED for, and asking is not proving: a `--select` run writes no check at all, every cell in its matrix reads GAP, and the header still said "every check below fired on its own violation and stayed silent on its near miss, so it blocks from install" — a coverage claim over an empty table, on the page whose second sentence is "Nothing here is hand-written prose about coverage." The header now says what armed mode ASKS for and points at the cell annotation that says what was proven; `[proven by its fixture pair]` is the only thing on the page that claims a fixture pair passed. And it no longer credits the owner with an answer: `armed` is the DEFAULT — `--observe` is the only one of the two a run asks for — so "you asked for blocking" was itself a claim about a question nobody put |
| Does a coverage cell answer for the plan's MODE (2.14.0) | Yes, and it reads the mode off the guard row this plan writes, never off a page-level word for it. `cellBlocks` answered for the lever and the lanes alone, so a `--observe` plan printed `[proven by its fixture pair — refuses the call in session]` four lines under a header saying every guard here records and refuses nothing, over a `config.json` this same plan writes as `mode: observe`. That is the fifth correction to this one cell: the string it replaced, a bare `[proven by its fixture pair]`, was mode-neutral and TRUE in both modes, and the correction that named the refusal made it false in one. A proven guard now says it refuses the call in session when its row is armed and that it records the call and refuses nothing when its row is observing — per row, because a mode belongs to a guard and to nothing else (row 278). Release gate G14 drives an observing shape beside the four armed ones and holds every cell's marker to the mode of the guard the plan installs |
| May a coverage cell say a tool is unrun on a plan that runs it (2.14.0) | No, in either direction: understating coverage is a computed statement the plan's own artifacts contradict, and the cell rebuilt in 2.12.0 exists to stop exactly that. `detectorArtifact` looked a tool's config up by template name — `toolchain-<tool>` or `install-<tool>` — and a config that composes into a shared manifest is named after its PATH, `toolchain-config-pyproject.toml`. So every tool sharing a file resolved to no config and its cell degraded to GAP, "no lane runs ruff": 21 such cells on a greenfield python plan against one DET, and 2 on dotnet's, while the same plan's `.jig/verify.json` ran all of them and the hook really did. A composed change now carries the ids of the tools it configures, the plan file and the manifest row carry that list too, and the cell asks the change rather than its name. Measured: python 1 DET / 21 GAP to 22 DET / 0 GAP, dotnet 13/2 to 15/0, rust 17/1 to 18/0, javascript-typescript and jvm unchanged. G14's second half drives a greenfield plan per edition and fails on any "no lane runs X" the plan's own verify.json contradicts |
| May the "No session guard" paragraph read the class's levers (2.14.0) | No. It reads the CELLS, like everything else on the page. Generated from the levers a class declares, it told the owner the selected mistakes are "caught by the check driver at commit time and in CI" six lines under a matrix grading them GAP for writing no check-driver artifact at all — the catalogue class does carry a real driver detector, so the reader had no way to see that selecting it bought nothing. Classes are now split by whether a cell on their row actually grades a `check-driver` artifact: the ones that have one keep the sentence, the ones that do not are told in bold that the driver gets no module for them and that their row is all the coverage they have |
| Is a GAP driver cell the same fact as "no check module" (2.14.0) | No, and the paragraph above had to learn the difference. `detectorArtifact` returns null — forcing GAP — for a removal-only detector while no commit lane is wired, BEFORE it looks for a written module, so a class GAPs because a lane is missing on a plan that writes both the class's check module and the pre-commit shim. Reading the cell alone, the page told that owner "the check driver gets no module for these, so neither the commit hook nor CI runs their patterns" — both halves false, with the module on the change list two sections up. The row carries `checkModule`, which is what this plan WRITES, and the three groups are now: a graded driver cell (caught at commit and in CI), a written module no cell grades yet (said as such, pointing at the row's own GAP reason for what is missing), and no module at all (the original sentence, where it is true) |
| Does `revert --all` take the review surfaces with it (2.14.0) | Yes, the fixed-name ones, and it names them on `removedSurfaces` and in the notes. `.jig/plan.md` and `.jig/plan.json` mean "the plan for this repository as it stands"; once the whole install is out there is no such plan, and an armed-mode coverage matrix left on disk for a harness that is gone is the claim this contract forbids. `plan-<id>.md` and `plan-<id>.json` are kept — those are the record an approval refers back to, and undoing an install is not a reason to lose the audit trail. Only `--all` does this: `--change` and `--tx` take out one change and leave the page alone |
| Is the inventory a new skill or a mode on `/jig:review` | A new skill. Review is activity-first and owns every action; inventory is read-only and owns none. Two jobs, two surfaces |
| Does the inventory cover guards or everything jig installed | Everything jig can manage: session guards, the check modules, every written artifact, and the three lanes |
| Where does the detector detail come from | `cmdReview`'s own rows gain it, so both surfaces read one truth. A second reader over the same config could disagree with the first |
| Are the matchers printed or counted | Counted. The config is a trust boundary a teammate edits, and a matcher rendered into a report is a matcher somebody can paste back in without anybody reviewing it |
| Where does "why was this installed" come from | The plan item's `rationale`, persisted onto the manifest artifact row. Rows written before the field existed fall back to the plan file they were applied from, and each answer is labelled with its source. Where neither survives, jig says so rather than inventing one |
| Does the new manifest field bump `SCHEMA_VERSION` | No. It is additive and optional, so an older jig ignores it. A bump would make an older jig refuse the whole manifest over one unknown field |
| Does the ledger get compacted so the denominator stays cheap (2.10.0) | No. The denominator is counted in the pass `ledgerStats` already makes, so it adds no reader and no scan; compaction would delete rows a wave-off is undone from and coverage is proven from, and jig deletes no evidence. The cost that stays — one linear pass over a file that grows for the life of the repository — is stated in `ledgerStats`, and `ledger.lines` on every review is the growth signal |

A report is not an enforcement surface. `/jig:inventory` never throws over an
absent or invalid guard config: it reports the refusal as `guardsProblem` and
still lists the artifacts, the checks and the lanes, because all three remain
readable and a refused config is the single most important thing the owner
could be told.

### Activation

Five questions answered by the owner on 2026-08-29, after using jig on real
projects and finding `.jig/activation.md` telling them to do something jig had
already done. `--wire-commit` runs as its own plan AFTER the install, because
git cannot be pointed at a hook that does not exist yet, so the unwired file is
written while the lane genuinely is dead — and nothing ever went back to
correct it. A file that hands the owner a task they no longer have is the same
failure jig exists to prevent, one level up.

| Question | Decision |
| --- | --- |
| What happens to the file when the lane goes live | The wiring plan rewrites it, as a second approved change in the same plan. Journaled and reverted with the wiring itself. Not deleted, and not one text hedged to be true in both states |
| Is the unwired text corrected too | Yes. It claimed pointing git at the hook was the one step jig leaves to you because the switch lives inside `.git/`, and both halves stopped being true in 2.4.0. `jig plan --wire-commit` is the route now, and the manual `git config` is the alternative |
| One wired text or two | Two. Undoing the wire route is unsetting `core.hooksPath`; undoing the weave route is taking one line back out of a hook the owner wrote. A single text could name neither |
| What does the wired text keep | What runs, how to undo it, the version-manager hazard, and the by-hand command. Every instruction to go wire something is cut, and it opens by saying nothing here is a task |
| What about repositories wired under an older jig | `plan --refresh-activation` puts the file in step without rewiring anything, offered by `/jig:jig` when the scan sees a live lane behind an unwired file. `/jig:inventory` reports the mismatch between runs |

Three defects surfaced under this and were fixed rather than worked around. A
plan with no coverage behind it no longer re-emits the driver, the shim and the
workflow: identical bytes mint a change id two plans define, and `apply`
refuses that by design, so every wiring plan had exactly one usable item in it.
And the manifest is keyed by path as well as by id, because a change id carries
the content hash — so rewriting an artifact used to leave the old row sitting
beside the new one, both claiming the same file.

The third is the one that mattered most, and it was found by running the new
flag against slag itself rather than by reading the code. A plan carries the
guard config computed FROM ITS SELECTION, and a wiring plan has no selection —
so `--wire-commit` proposed a `.jig/config.json` with zero guards in it, and
approving that plan disarmed every guard in the repository. It had been
unreachable only because the duplicate-id defect above stopped those plans
applying at all, so fixing that one exposed this one. A plan that proposes no
coverage now proposes no config, and `tests/checks.test.js` holds the
regression: install guards, approve a whole wiring plan, assert the count is
unchanged.

### The derail pass

Eight questions answered by the owner on 2026-09-02, when the programme in
[`docs/research/jig/DERAIL-PASS-2026-09-01.md`](../docs/research/jig/DERAIL-PASS-2026-09-01.md)
was adopted. That pass ran jig end to end in a scratch repository and found jig
saying things that were not true — a revert that refuses on the flow the skill
drives, a session guard admitted under a proof nothing ran, a re-run that
disarms what is installed, lanes reported live behind the kill switch. These
eight are the calls the study left to the owner; the rest of the programme is
routine work against the contract already ratified above.

| Question | Decision |
| --- | --- |
| Does a driver crash block a commit (C13d) | No. The crash handler is aligned to its own comment: a top-level failure in `run.mjs` exits 0 with a stderr line and a `.jig/lane.log` row. A driver that cannot run is a disclosed coverage gap, never a reason to stop somebody committing. `run.mjs`'s exit 1 for a *check* that reports a finding is untouched, and so is the exit 1 for a check module that fails to load — that one is a broken check, which the owner installed and can revert |
| May jig run `gradlew.bat` through `cmd.exe` on win32 (N7) | No. The no-shell stance is load-bearing: jig runs every command through `execFile` with an argv, so no owner-supplied string is ever parsed by a shell. Gradle installs on win32 are refused with a disclosed line naming the exact command to run by hand, on the same footing as the existing `npm.cmd` refusal. The npm/pnpm/yarn family is fixed instead — those have a JS CLI entry `process.execPath` can run directly, and a batch shim is not the only route to them |
| Does an enumerated multi-select satisfy "approved one at a time by id" (N19) | Yes, with two conditions. The token is unchanged — `apply` still takes one `--change <id> --path <rel>` pair per call and still refuses a mismatch — and nothing is ever pre-ticked, so no answer is substituted for one the owner did not give. A multi-select is how the question is *asked*; it does not widen what is *applied*. The thing SCOPE:131-132 forbids is one approval that lands many writes, and that is `apply --plan`, which N17 removes |
| What happens to a `--select` id that matches nothing (2.15.0) | It is disclosed on the plan, by name and counted, and it is not a refusal — the catalogue never gates, and an id jig does not recognise is not evidence the owner is wrong. But silence was not the alternative on offer: an unmatched id became a class row like any other, GAP in every column, and a live run of thirty BARE ids drew a thirty-row all-GAP matrix and an ENFORCEMENT GAP list calling all thirty "the classes no host-neutral deterministic lever catches" — on a repository whose `eslint.config.mjs` and `vitest.config.ts`, written by that same plan, caught a planted `test.only` twice over. That is the shape "never silently substitutes a default" exists to forbid, one level down: nothing was substituted, but a question the owner got wrong was answered as though they had got it right. The row is marked `unmatched`, the page names every one of them above the matrix with the namespaced id they probably meant, and neither the gap list nor the "No session guard" paragraph counts them as classes |
| Does `fp` need the same pause as disarm (N17) | Yes. `fp` pulls an armed guard back to observe, which is what `disarm` does; the surfaces differ, the effect does not. It writes a pending row and the same `--change/--path` token settles it. The cost is one question in a flow that was one command, and the flow it protects is the one where a guard stops blocking |
| May the Stop hook exit 2 (N9) | No, and not later either without a new decision here. Stop-time output is `additionalContext` only. A block at Stop has no fixture pair behind it — there is nothing to plant and nothing to catch — so arming one would be the coverage claim this document forbids, on jig's own most visible surface. If a fixture-admissible shape is ever found, it is a SCOPE question, not an implementation call |
| Is the Stop registration itself item-tier (2.10.0) | No, and it needs no opt-out beyond `.jig/off`. C8's SessionStart line was dropped because it was always-loaded prose in every session of every repository; this one speaks only where `.jig/verify.json` holds an entry, which means only where the owner approved a lane at item tier. A repository that installed no lane reads the file, finds nothing, and returns before it spawns anything or writes anything. The approval that gates the lane gates the line |
| Is the red signal for a verification run proven (2.10.0, probed 2.13.0) | Yes, measured. Roadmap 230 drove a real headless session on Claude Code 2.1.257 and watched a failing shell call fire `PostToolUseFailure` and **no** `PostToolUse` — so the split on which event fired, per N9's approved shape, is the host's behaviour and not just its documentation. The event carries `tool_input.command` verbatim, and it carries the exit code too, in `error` as the string `"Exit code 3"`; it carries no `tool_response` at all, which is why `exitCodeOf` reads that shape after the structured fields. An error the host phrases any other way still records no code and still falls back to the event, because a number nobody measured is the one thing this row was written to forbid. Record: [`docs/research/jig/HOST-PROBE-2026-09-02.md`](../docs/research/jig/HOST-PROBE-2026-09-02.md). The probe also found the win32 shell tool is named `PowerShell`, which no jig matcher matched — a separate and larger question, answered in the row below (2.14.0) |
| Does an observing guard teach by default (C6) | No. Opt-in per guard, recorded on the guard. Observe is a mode the owner chose; turning every observing guard into a line in the transcript changes what that choice meant after the fact, and a harness that nags is one the owner switches off |
| Which `.jig` files are meant to be committed (N22) | `config.json`, `manifest.json`, `checks/`, `hooks/`, `activation.md`, `proposed-permissions.json` and — from 2.9.0 — `verify.json`, because CI reads it and a lane that is not in the clone is a lane that does not run. Those are the install — a teammate cloning the repository gets the checks and the guards. Everything else under `.jig/` is derived or per-machine (`plan*.json`, `plan.md`, `plan-<id>.md`, `authored.json`, `backlog.json`, `discarded.json`, `journal.jsonl`, `ledger.jsonl`, `profile.json`, `preimages/`, `off`, `lane.log`) and belongs in the generated ignore list. jig extends that list; it never narrows one the owner wrote |
| May `migrate` remove a guard without asking (227) | No, and it stays one transaction. Decision 2 says the migration is one journaled transaction that reverts like any other, so the pause is a pre-flight refusal rather than a per-item plan: before a byte is written, `migrate` names every guard it cannot carry forward — id, mode and reason — and stops. `--accept-drops` is the owner saying they read that list. A dropped row is not a repairable state; the pair test decided it, and what needed fixing was that an armed guard could vanish under an owner who only asked for an upgrade. The 2.11.0 edit-lever pass is unaffected — it drops nothing and hands back a plan approved change by change |
| Does the third session lever clear SCOPE:287's bar (2.11.0) | Yes, on all three counts, which is why it is a NEW lever and not a re-pointed one. `edit-guard` denies an Edit or a Write at PreToolUse, before the bytes land. Its artifact is the check module's own detector, carrying `lever: "edit-guard"`; its consent tier is item, like every other check that can refuse a call; its coverage column is the agent-editor cell the old lever filled after the fact. The old `edit-observe-guard` keeps running for every install that does not migrate, because the proof hash binds a lever to the check it proves — silently moving the event would leave an installed guard claiming a proof for something it no longer runs |
| What is the third detector kind (2.11.0) | `params.removed`, admitted on a fenced `{before, after}` pair. The ownPair rule is that the blanked before-count exceeds the after-count on the violation and does not on the near miss. It crosses only among removal kinds, for the reason `pairedWith` crosses only among paired ones: a removal rule over somebody's source pattern compares two different kinds of thing. Its session half lives on the edit levers and cannot fire on a Write payload, which carries no `old_string` — a disclosed limit, not a defect. Its check-driver half is the commit lane and only the commit lane (2.12.0, roadmap 226): `--staged` counts the index against HEAD with `--diff-filter=D` in the read, so a file the commit deletes outright counts as the removal it is. A pathless run holds one version of the file, reports the class skipped and grades nothing off it. Which means the coverage cell reads BOTH halves, the way a tool rule reads its config AND a lane that runs it: the module is coverage only where a pre-commit hook actually runs the driver, because the shipped workflow runs `run.mjs` pathless and a pathless run counts no removals. In a repository with no hook the cell is a GAP naming `plan --wire-commit`, and the host-neutral floor is not cleared by it |
| What is the fourth detector kind (2.13.0) | `params.extract` beside `pairedWith`, admitted on a fenced `{doc, union}` pair. It is N15a, the candidate the derail pass deferred to "later" and sequenced after C11, and it exists because `pairedWith` cannot reach the doc-sync mistake that actually happens: the flag was renamed, the README was edited in the same commit, and the README named the old spelling. Nothing is missing from that commit. Each `extract` pattern is one capture-group regex over the files in `paths`, and every name it captures has to appear literally somewhere in the union of the `pairedWith` files; a name that appears nowhere is a finding at the capture's own line. The ownPair rule is that some capture in the violation's doc half is absent from its union half and none in the near miss's is, fenced by `--- paired` — a second label on the removal kind's fence and nothing more. It crosses only among extract kinds, for the reason `pairedWith` and `removed` cross only among their own: a capture regex over a change set, or a source pattern over a doc fenced against its union, compares two different kinds of thing. Its `pairedWith` means where the names must APPEAR, never what had to change alongside, so a paired-change rule is never read out of an extract detector — the same detector reported as both would report a doc for moving alone as well. Unlike `removed` it is not one lane: the doc and the union both exist in the tree as readily as in the index, so every run evaluates it and the coverage cell is the ordinary check-driver one. What the commit lane changes is which bytes it reads — the index on both sides, which is the only reading that describes the commit being made — and the union is read WHOLE there, `git ls-files` and not `diff --cached`, because a union narrowed to what this commit touched reports every name missing the moment a doc moves without the code beside it. Nothing is blanked on either side: a name the code carries only in a comment is still a name the code carries, and counting it present is the direction that adds no finding |
| May an observing guard teach, and where (2.11.0, probed 2.13.0) | Only where the owner set `teach: true` on that guard, and now on either runner. `teach` stays a per-guard key, never a default and never a top-level switch — the same reason `config.mode` was refused. What changed is the *where*: 2.11.0 restricted it to PostToolUse because the non-blocking PreToolUse channel was unmeasured, and roadmap 233 measured it. **Probed: YES.** On Claude Code 2.1.257 a `PreToolUse` reply carrying `hookSpecificOutput.additionalContext` and no `permissionDecision` reached the model — it repeated the token back — and refused nothing. So teaching is a property of the guard the owner opted in, not of the event it runs on; `validateConfig` allows it on both runners, `migrate` carries the key across instead of dropping it, and a fresh install whose only edit lever is `edit-guard` can opt a guard into teaching at all, which it could not before. Where an armed guard denies on the same PreToolUse call, the teaching line merges into that reply and never replaces it — a lost `permissionDecision` would turn a refusal the owner armed into a pass. That merge is a claim about what jig EMITS and is tested as one. Whether the host then surfaces `additionalContext` on a reply that also denies is **not probed**: the run measured the `additionalContext`-alone shape and nothing else, so jig emits both keys because dropping the decision is the unsafe direction either way, not because the combined delivery was observed. Record: [`docs/research/jig/HOST-PROBE-2026-09-02.md`](../docs/research/jig/HOST-PROBE-2026-09-02.md) |
| Does `bash-guard` keep its name now that it matches every shell tool (2.14.0, 237) | Yes, and the widening is disclosed rather than renamed away. The measured fact is that a headless session on win32 was offered a `PowerShell` tool and no `Bash` at all, so jig's matchers, its witness gate and its command lever all named a tool that session does not have, and there no command guard ever evaluated and no verification run was ever witnessed while `/jig:inventory` reported the session lane live. That is the false coverage report this contract forbids, so the tools come off one shared list in `scripts/vocab.js` (`SHELL_TOOLS`), pinned by a release gate that reads `hooks/hooks.json` back against it. The lever keeps the name because the name is a stable key: it is written into every installed `.jig/config.json` and bound into every recorded proof hash, and renaming it would either invalidate proofs the owner already approved or need a migration that buys nothing a word could not. What the widening honestly costs is stated where the claim is made instead: a guard whose patterns are POSIX shell idiom now EVALUATES on a PowerShell line and passes, where before it never ran. Evaluating and passing is not catching, so `lanes.session.shell` discloses the tools, the coverage matrix says the same on the page the claim is made, and the SKILL tells an author to write the patterns for every shell an agent may reach for. A lever that never runs while the lane reports live is the worse failure of the two |
| How does a surface say which shell tool this host sends (2.14.0, 237) | It does not say it; it reports the two things it can honestly know, under names that say which is which. The first attempt was `HOST_SHELL_TOOL = process.platform === "win32" ? "PowerShell" : "Bash"`, printed on `lanes.session.shell` and in the coverage matrix as "This host's shell tool is …". That is an inference wearing the word measured, and it is wrong on the very machine it was written for: the headless run behind the row above was offered `PowerShell` alone, while an interactive session on that same OS is offered `Bash` and `PowerShell` at once (`docs/research/jig/HOST-PROBE-2026-09-02.md`, sections 3 and 4). The set is per session, not per platform, and a CLI invocation cannot read it at all — nothing hands `jig.js` the host's tool list. A hook payload can: `tool_name` arrives on every call and every ledger row records it. So there are exactly two truthful surfaces and both are named for what they are — `shell.watched`, the static set of names jig's hooks match, and `shell.seen`, the names jig's own rows have actually recorded, empty until a guard has run and reported as not yet observed rather than filled in with a guess (SCOPE: it never silently substitutes a default). The coverage matrix is rendered before any guard has run, so it names no host tool at all and carries the syntax warning on every platform instead — where before, the warning sat behind a `!== "Bash"` branch that is dead code on the runner CI grades the release on. A number nobody measured is what this table exists to forbid, and the platform was the number |
| Is a foreign hook on one shell tool a full occupancy (2.14.0, 237) | Yes, refused whole, and the reason is printed rather than left implied. Widening `HOOK_SLOTS[0]` to `Bash\|PowerShell` means a repository whose own `PreToolUse` hook is registered for `PowerShell` alone now takes the command-guard slot, and on a session offered only `Bash` that hook could never have collided with jig's. Three things decide it against sharing. The session's tool list is not knowable from a CLI — the same fact the row above is built on — so "cannot conflict" is never demonstrable, only assumed, and assuming it is how a guard gets registered beside one that silently never fires: a lever reporting live where it cannot run, which the row above calls the worse failure of the two. Taking the free half is not available either: jig's matcher is one registration in the plugin's own static `hooks/hooks.json`, not a per-repository write, so there is no narrower matcher to take, and inventing one would be a settings write the contract does not authorise. What changes instead is what the owner is shown — the slot row carries `overlap`, the tools the foreign hook actually contends for, and `scan` discloses in words that the hold is on one name only and that a session sending neither would see no collision. A refusal an owner can read the reason for is a disclosed gap; a flat "taken" naming two tools when one is contested is the report claiming more than jig knows |
| Is the manifest journaled, given SCOPE:187 (N1) | Yes, and it is the one exception. `.jig/` writes are jig's own state and `revert` removes them wholesale — except `.jig/manifest.json`, whose journaled rows are what release gate G3 reads and what `revert` replays. The rule is: jig's state is not journaled, the manifest is, and the drift check must therefore compare a path against the newest journaled write for it rather than the first. That is defect 1, and it is why a plain per-change install could not be reverted |

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

## Driver defects the catalogue work surfaced — all three fixed

> **Closed before 2.0.0 was cut.** All three faults below were fixed in both copies of the blanker,
> and `jig/tests/blanker-drift.test.js` now fails if the two copies drift apart again. They are
> recorded here because they are why the blanker looks the way it does, not because anything is
> still broken.

Building the editions ran every authored pattern against its own fixture pair, which is the
admission test this document defines. It immediately found three faults in the 1.0.1 comment and
string blanker, all confirmed at source. Both copies of the blanker shared them —
`jig/scripts/templates/run.mjs` and `jig/hooks/jig-lib.js` — so the committed check driver and the
session guards were affected alike.

1. **`stripComments` was inert.** `blankRegions` read only `opts.strings`. Comments were always
   blanked, whatever a catalogue asked for, so any class relying on reading comment text silently
   could not work. It now reads `opts.stripComments`.
2. **Only six extensions got hash comments.** `HASH_COMMENT_EXT` held `.sh`, `.bash`, `.zsh`,
   `.yml`, `.yaml` and `.toml`. Every other file got JavaScript comment rules, so a `.py`, `.rb`
   or `.ps1` file had its `#` comments left intact and read as code, and commented-out lines
   tripped checks. The table is gone; every v3 edition declares `detect.commentSyntax` per
   extension instead.
3. **String bodies blanked the file when `stripStrings` was off.** A `//` inside a URL literal
   blanked the rest of the line, and a `/*` inside a glob literal blanked the rest of the file.
   Both are ordinary content in configuration source. An unclosed literal is no longer read as a
   literal.

Fault 2 alone meant the 1.0.1 driver could not have served any non-JavaScript edition correctly,
whatever the catalogue said, which is why the fix was a precondition of shipping the editions.

## The catalogue programme

One edition per widely-used language, each researched before the release that
ships it. This is research rather than engineering, and every edition answers
the same brief for its own ecosystem:

- Which mistakes in this language actually cost teams work, and which of those
  an agent session produces on its own.
- The idiomatic tool that catches each one, named exactly: the linter and its
  specific rule, the type-system flag, the test-runner convention, the CI step.
- A violation sample and a near-miss sample per mistake, written in that
  language's own idiom rather than translated from another's.
- The install command and the config path each tool expects, per package
  manager that language uses.

Every edition ships in one shape, so a single loader reads all of them and
nothing in the engine hardcodes a language name.

First wave, confirmed and shipped in 2.0.0: TypeScript and JavaScript, Python,
Go, Rust, Java and Kotlin, C#.

A language with no edition is not a refusal. The model authors from scratch and
the fixture pair remains the only admission test. An edition makes that work
better calibrated — never possible versus impossible.
