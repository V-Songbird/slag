# Changelog

All notable changes to jig are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [2.12.0] — 2026-09-02

### Added

- A scaffolded project builds. jig used to write the file that makes a directory a project and stop there — a `Cargo.toml` cargo refused because it named no targets, a `pyproject.toml` with no package beside it, a `package.json` whose test command passed having run nothing. Each edition now writes the smallest tree its own build and tests actually pass on: a source file, one smoke test, and whatever the ecosystem needs to resolve them. A release gate scaffolds every edition on every run and refuses to ship if the build, the lint, the type check or the tests come back anything but clean — and where a toolchain is missing on the machine running it, it says which edition it skipped and why, rather than passing quietly.
- 18 new checks across the six languages, and five corrections to ones that were already there. The new ones cover the thing that has been missing all along: the harness being loosened rather than the code being broken — a coverage threshold lowered, `allowOnly` switched on, a `--cov-fail-under` dropped, over exactly the config files that edition writes. Alongside them, stub function bodies, tautological assertions, sleeps in tests, suppressed compiler warnings, and a snapshot file updated wholesale in a committed script.
- The interview asks about the ways around the harness, not just the mistakes in the code. Four standing offers for anyone working with AI sessions: the hook bypassed, a force-push to the default branch, a script piped into a shell, the harness switched off. You pick which ones matter; the check is written for your repository and proved against its own fixtures like every other one.
- `/jig:jig` offers you a pair of files from your own history that used to change together and stopped. That is the doc-sync mistake in the abstract made concrete — you no longer have to think of the pair yourself before jig will ask about it.
- The removal detector now runs at commit time, reading the staged change set including whole files deleted. Until now it could only see a deletion as a session made it; a deletion that arrived any other way had no lane.

### Fixed

- An install could touch files jig never recorded, so `revert` could not put them back. Glob patterns in an edition's file list were dropped rather than resolved, so a `*.csproj` edit had no saved copy; and anything a command created — a Gradle wrapper, a lock file — was invisible to the journal. jig now takes a picture of the directory before and after and records what appeared, so revert removes it.
- jig no longer offers an install it cannot undo. The rule used to be read off a label; it is now read off the command, so a tool whose install writes outside your project without saying how to remove it is refused, and a release gate holds every shipped tool to it.
- The .NET test project is written rather than generated. `dotnet new xunit` created a tree jig had not named, which is the one thing its own contract forbids — and the project it created still reported a green run over no tests at all.
- The coverage table read only the plan in front of it, so running the interview a second time reported your linter as uncovered when it had been running in CI since the first time. It reads what is installed too.

## [2.11.0] — 2026-09-02

### Added

- Edit guards can now refuse an edit before it happens. Until now they ran after the file had been written, so the block arrived one step too late — the mistake was on disk and the guard was describing it. `edit-guard` is a new lever that denies at the moment the edit is proposed. It is a new lever rather than a change to the old one, because a check's proof is bound to the thing it proves; moving the old one quietly would have left every installed guard claiming a proof for something it no longer ran. Installs that do not migrate keep working exactly as they did.
- `jig migrate` moves an installed edit guard onto the new lever: it rewrites the module, re-runs the fixture pair against the new lever, and re-records the proof — as one approved change per guard, applied by you, with nothing written until you say so. A guard that cannot move is named and left where it is.
- jig can see what was deleted. Every check until now read what is in a file; nothing read what stopped being there, so "the AI deleted my tests" — the first thing the interview asks about — had no check that could be admitted for it. A check can now carry a removal rule, proved by a before/after fixture pair, and a session guard carrying one refuses the deletion as it is proposed. Six `test-count-dropped` classes ship with it, one per language.
- jig can watch its own files. Guards over `.jig/config.json`, `.jig/checks/`, `.jig/off` and the CI workflow are offered at install like any other check, written by the model, proved by a fixture pair and approved by you.
- An observing guard can tell your session what it would have blocked, if you ask it to. Off unless you turn it on, per guard, and never as a default — observing is a choice you made, and a harness that talks over that choice is one you switch off. It says the guard's id and the reply the guard would have given, and nothing about your source.

### Changed

- `jig migrate` refuses before it writes anything if the upgrade would drop a guard, naming each one and why. `--accept-drops` is how you say you read the list. Migrating a 1.0.1 install is still one transaction that reverts whole.
- Loading jig's hook library no longer loads the whole engine with it. Every tool call in a session pays that cost, and it was about 16ms of parsing per hook run, for eight small definitions. They now live in their own file, and a test fails if the engine finds its way back in.
- Where a check's removal rule has no lane that can run it, the coverage table says so instead of naming the file as coverage. The commit-time half of that is still to come.
- Every part of a blocked call's reply now ends before the next one starts. They used to run together into one sentence.
- The self-watch recipe in the skill sets `stripStrings: false`, because a check over a JSON file reads nothing otherwise — every token in JSON lives inside a string.

## [2.10.0] — 2026-09-02

### Added

- A test run now leaves a record. Until now a session that ran your tests and a session that only said it had left jig with identical evidence, so "the tests pass" was not contradictable by anything jig held. When a Bash call runs one of the commands in `.jig/verify.json`, jig records that it ran and whether it passed — the entry's id, the outcome, and nothing else. The command text never reaches the ledger.
- At the end of a turn, one line, and only when it is worth saying: how many edits have landed under a tool's files since the last green run of that tool, or that there has never been one. It never blocks and it cannot block — it hands the session a sentence and gets out of the way. A repository with no lane entries reads nothing, spawns nothing and says nothing.
- `/jig:review` and `/jig:inventory` show the last green run for each thing your lanes verify, so "nothing here has been seen to run them" is a fact you can look up rather than a suspicion.
- What the commit hook catches now reaches the ledger, so a guard that has only ever fired at commit time stops looking like one that has never fired. Two of jig's three lanes used to write nothing anywhere. The append can never fail a commit: if it cannot be written, the commit goes through.
- `fired` has a denominator. A guard that fired four times out of four calls and one that fired four times out of four thousand used to read the same. Reports now show the split between what was denied and what would have been denied, the number of calls each guard was actually run on, and when it last fired. A guard whose check will not load is reported as never having run, rather than as having caught nothing.
- `/jig:review` gains a month-later view: what has been committed since the install, by every lane and every teammate, and which classes started or stopped appearing. It is mined from your history rather than from jig's own ledger, and it says plainly that the attribution is best-effort.

### Known limit

- The failure half of the verification record depends on a hook event nothing here has yet tested against a live host. Where a failing run reports its exit code, jig reads it and records the run as red regardless. Where it does not, and the host does not raise the failure event either, a red run would be recorded green. This is written down in `SCOPE.md` rather than assumed away, and probing it is the next piece of work on this.

## [2.9.0] — 2026-09-02

### Added

- The linter, type checker and test runner jig installs now actually run. Until now jig set them up and no lane ever started them, while the coverage table said they were covered. Each tool you tick gets an entry in a new `.jig/verify.json` — the exact command and the exit code a clean run has — and CI gains one step per entry. You can ask for them at commit time too, per tool, because a full type-check on every commit is a cost you should choose rather than inherit.
- The coverage table stops claiming a tool is covered because its config file exists. A cell reads as covered only when both the config and a lane that runs the tool are there; otherwise it says "no lane runs eslint", and names it.
- The install's closing demonstration runs your tools instead of describing them. It plants a violation the tool should catch, runs the tool, and reports what happened — and it runs the tool once more over your untouched project first, so a repository that was already failing its own linter is disclosed rather than counted as proof. Where a command genuinely cannot be started, it says so and prints the command, instead of skipping quietly.
- A project with only committed checks and no session guards can be witnessed at last. The close counted guard demonstrations only, so the simplest install jig offers reported that nothing had been proven.
- The commit lane is demonstrated too: jig runs the hook in a throwaway clone and reports whether it ran, whether it found node, and whether it blocked.
- On request, jig writes `.claude/rules/jig-checks.md` — a short standing note pointing your Claude Code sessions at the same checks the `AGENTS.md` region points other tools at. Opt-in, approved by name, and reverted like any other file.

### Fixed

- The commit hook checked your working tree while git commits your index. Staging a bad file and then restoring a clean copy of it got the bad one committed; staging a clean file and then breaking the worktree copy blocked a commit that did not contain the problem. It reads the staged bytes now. CI and manual runs still walk the disk, which is correct — nothing is staged there.
- `npm`, `pnpm` and `yarn` installs failed on Windows with a version manager. jig runs every command without a shell, and on Windows these arrive as batch shims, which need one. It now runs their own JavaScript entry point directly, so the install goes through and no shell is opened. Gradle on Windows is refused instead, with the command printed for you to run: `gradlew.bat` genuinely needs a shell, and opening one is not a trade jig makes.
- An install jig refused stayed listed as interrupted for ever, including after a full revert. It now settles as refused.
- A new JavaScript project was red on line one. The starter had no `scripts` and no root `.gitignore`, and the shipped eslint sample linted jig's own files and its own config. Several tools' `scripts` now compose into one `package.json` on the same first-writer-wins rule the shared config files already use, with any disputed key reported. Installs run in an order that makes sense — a scaffold before the package that needs it — rather than alphabetically by id.

## [2.8.0] — 2026-09-02

### Fixed

- A guard that watches your agent's commands could be installed armed, printed as proven, and catch nothing. Only the committed checks were ever run against their own fixtures; the two levers that watch a session were taken on trust. All of them are proven now, through the same code that runs them for real — and a check whose guard misses its own violation, or fires on its own near miss, is discarded whole and named in `.jig/discarded.json`. The three levers a check can carry are named in the skill for the first time, and a release gate keeps that list and the engine in step.
- Running the interview a second time on a repository that already had jig proposed a guard list with nothing in it, in the tier you approve in one go — so a second look at your coverage could switch all of it off. What a plan proposes is now what is installed plus what you just picked. A change that would drop or downgrade an armed guard is approved one at a time, with each guard named, and an empty list proposed over a full one is refused rather than offered.
- `jig apply --plan` applied a whole plan on one approval, including the checks that can fail your build. It now refuses anything in the per-item tier and prints the exact `--change`/`--path` line for each one.
- One mistaken `jig review fp` locked a guard in observing for good — `arm` refused while the false alarm stood and nothing could clear it. `fp --clear` clears it, by adding a line rather than editing history.
- The repository's own `focused-test` check shipped a mangled alternative, sliced off mid-sentence. Admission now refuses a reply that ends inside an unclosed code span or is too short to act on, so the next one cannot ship.

### Added

- A blocked call says which guard blocked it. The reply now opens with `[jig guard <id>]` and closes with how to report a false alarm, and the plan you approve has a "What a blocked call will read" section, so you see the exact words before they are ever printed at your agent. The committed checks print the reason and the alternative under each finding too, instead of just the class name.
- `--quick` picks its coverage with a recorded basis instead of a judgement call. It ranks from your own history where jig can read it, falls back to the catalogue order where it cannot, writes both the selection and its basis to `.jig/profile.json`, and says plainly which approvals are still coming and that the commit lane is not wired yet.

### Changed

- `disarm` and `retire` stop and hand you a plan instead of applying themselves; `fp` does the same. Turning a guard off is now the same approved, reversible, per-item change as turning one on. `arm` still applies directly — putting a guard back to work needs no pause.
- The per-item approvals are asked as a short list you tick rather than a wall of prose, with nothing ticked for you and the consequence of each one spelled out. Each one is still applied on its own by id and path, and a mismatch is still a refusal.
- Migrating a 1.0.1 install now drops a guard whose lever fails its own fixture pair, and tells you which. The one this affects in practice is `pipe-to-shell`'s command guard: its old near-miss sample contains the piped install command inside a quoted string, and a command guard does not read quotes the way the file checks do. The class is still caught by its committed check; only the session guard goes, and the reason is on the record.

## [2.7.2] — 2026-09-02

### Fixed

- `jig revert --all` refused to run on an ordinary install. Every approval rewrites jig's own manifest, and the safety check that looks for files you edited by hand was comparing each of those writes against the file as it stands now — so jig kept finding its own later work and calling it your edit. The only way through was `--force`, which is the one that throws away edits. It now asks the question once per file, against the newest write jig made to it. A file you really did edit still stops the revert, and still says which one.
- A guard scoped to `src/**` was blocking edits anywhere in the repository. The session lever read the pattern but not the list of files it was pointed at, so a guard you wrote for your source denied a write to your docs. Both spellings of a path — the absolute one your host sends and the relative one you wrote — now resolve to the same thing, on the guard's scope and on the observe zones alike. Out of scope is a plain pass, not a suppressed block.
- An armed force-push guard let `git push --force origin HEAD:main` through, along with `+main`, `:main` and `refs/heads/main`. It was reading the argument as if it were a bare branch name. It now reads a refspec.
- One check with a pattern that will not compile switched off every guard for that call, healthy ones included. A pattern that will not compile is now skipped on its own and reported, and the guards beside it still run.
- A scan that stopped at the 20,000-file limit reported a clean pass. It now says it was truncated and exits non-zero, because a partial scan is not a clean project.
- A check driver that crashes no longer blocks your commit. It writes the reason to stderr and to `.jig/lane.log` and gets out of the way. A check that reports a finding, and a check that will not load, both still exit 1.
- Paired checks never fired on a repository where jig is installed below the git root. The staged file names came back relative to the repository and the patterns were written relative to the install, so the two never met — while the selftest passed, because it needs no index.

### Changed

- The reports stop saying things that are not true. `.jig/off` now silences the lane report as well as the guards, with the time it went quiet. A guard that dropped to observing says why, on the ledger row and on stderr, instead of changing mode in silence. The commit-lane setting is read from git rather than looked for as a file, so a live lane stops being reported as retired. The commit hook is written executable and says when it ran and when it skipped. The CI lane is reported from the workflow's own drift state rather than from the file existing.
- A checks directory with nothing runnable in it used to report that every check caught its own violation. It now fails, and a plan that has no coverage behind it refuses to write the driver, the hook and the workflow at all rather than leaving you a green CI job over nothing.
- `/jig:review` on a repository where nothing is installed says so instead of crashing. `jig migrate` exits 0 on its normal answer — that an install is already on the current shape — instead of reporting it as a failure.
- Every command jig prints is one you can actually run. `jig plan --wire-commit` was in three places and on nobody's PATH.
- jig's own working files — the plans, the backlog, the discard report — are added to `.jig/.gitignore` so they stop being committed. The README now names the six things under `.jig/` that are meant to be committed. jig only ever adds a missing line to that file and never rewrites one you edited.
- The benchmark figures in the README are now asserted by the test suite, so a number that drifts fails the build instead of ageing quietly.
- Four passages that described behaviour jig does not have — what CI runs, what the install proves about your linter, what `--quick` decides — now describe what it does.

## [2.7.1] — 2026-08-29

### Fixed

- Approving `jig plan --wire-commit` could switch off every guard in your repository. That plan is supposed to do one thing — point git at the hook jig wrote — but it also proposed a fresh `.jig/config.json` built from a selection it did not have, which is an empty one. Approve the whole plan and your guards were gone. It no longer proposes that file at all, because a plan that adds no coverage has no business rewriting the list of what covers you.
- This was reachable for the first time in 2.7.0. Before that a separate defect stopped those plans applying, which had been hiding it. If you ran `--wire-commit` on 2.7.0 and your guards disappeared, `jig revert` puts the config back, and this release stops it happening again.

## [2.7.0] — 2026-08-29

### Fixed

- `.jig/activation.md` no longer tells you to go and switch commit-time checks on after jig has already switched them on. That file is written during the install, when the checks really are not running yet, and nothing ever went back to correct it once you wired them up. People were reading it months later and asking whether they still had something to do. Now the same plan that does the wiring rewrites the file, so it says what is running and how to turn it off instead.
- The file also used to say that pointing git at the hook was the one step jig leaves to you, because that switch lives inside `.git/`. jig has been able to do it for you since 2.4.0. It now offers that first and keeps the by-hand command as the alternative.
- If you already wired jig up under an older version, your copy is still the stale one. `/jig:jig` offers to put it right as a single approved file, and rewires nothing. `/jig:inventory` points out the mismatch any time you look.
- A file you have edited yourself is never rewritten. jig says it is yours and carries on with the rest.

### Changed

- The wired file comes in two forms, because undoing the two routes is two different things: unsetting `core.hooksPath` where jig pointed git at its own hook, or taking jig's one line back out of a pre-commit hook you already had.

## [2.6.0] — 2026-08-29

### Added

- `/jig:inventory` — a straight answer to what jig put in this repository and why. It lists every guard with what it watches and what it does when it fires, every committed check including the ones that only run at commit time and in CI, and every file jig wrote with the reason you approved it and whether you have edited it since. It also says whether the checks are running right now, in your session, at commit time and in CI. It only reports. Nothing in it changes anything, and the actions all stay where they already were.
- jig now records why each file was installed, beside what was installed. An older install still gets an answer wherever the plan that wrote it is still on disk, and where nothing survives jig says the reason was not recorded rather than inventing one.

### Changed

- `/jig:review` now shows what each guard watches, not only what it has caught: the tool it sees, the files it looks at, and the reply it gives when it blocks something.

## [2.5.0] — 2026-08-29

### Added

- jig can now catch a mistake that is not inside any file: two things that are supposed to change together, and one of them did not. A doc that stopped describing the module. A migration that never followed the schema. You name the two sets of files in the interview, and a commit that touches one and leaves the other alone is a finding.
- These checks earn their place the same way every other one does. Each is proven against its own pair before it counts as coverage — a change that should trip it, and a change that should not — and the proof re-runs anywhere, including CI.

### Changed

- One honest limit, said out loud rather than buried: a paired check reads what is staged, so it speaks at commit time. Where nothing is staged it reports itself skipped instead of passing, so a green CI run never reads as coverage it did not give you.

## [2.4.0] — 2026-08-27

### Added

- jig can now finish wiring the commit-time checks for you, instead of handing you a command to run. It is one more item on the plan, approved by name like everything else, and `revert` puts the setting back exactly as it was. jig still never writes a file inside `.git/`.
- If you already have a commit hook of your own, jig offers to add its one line to that hook instead. It will not point git elsewhere, because that would stop your own hook running.
- `/jig:review` now reports which of the three places the checks can run are actually running — in a Claude session, at commit time, and in CI — and names the one thing to do about any that is not. Wiring used to be mentioned once at install and never checked again.

### Fixed

- jig no longer reports commit-time checks as missing when they are already running. It only looked for a hook in the two places a repository can commit one, so a working hook in the usual place went unseen and every run ended by asking you to wire something already wired.

### Changed

- The note at the end of an install now says what the leftover step buys you and what it costs to skip it, rather than naming git internals. `.jig/activation.md` was rewritten the same way, and leads with the fact that CI already covers you.

## [2.3.2] — 2026-08-26

### Changed

- Both skills describe themselves in their own terms and no longer point at another plugin's commands to say what they are not for. The descriptions are also shorter and lead with what jig does, so the right one is picked more reliably.

## [2.3.1] — 2026-08-25

### Fixed

- A check whose file patterns name a folder now proves itself again. jig plants a violation for every check and requires the check to catch it, but it was planting the file at the top of a scratch folder instead of inside the folder the check watches. The check never saw its own violation, and the run reported it as not catching what it does catch. The report now also names the exact file that was planted.

## [2.3.0] — 2026-08-21

### Added

- Point jig at an empty folder and say Gradle, Maven or .NET, and it now writes the starter project file and carries straight on — the same as it already did for Node, Python and Rust. It used to stop and ask you to run `gradle init` or `dotnet new` first. The starter is the smallest file that makes the folder a project, with a placeholder name and a comment saying to rename it; picking an application template is still yours.
- A Gradle run and a Maven run get the right file for the build system you named — `settings.gradle.kts` for one, `pom.xml` for the other.
- Go still asks you to run `go mod init` yourself. A module path is a name only you can choose.
- Two .NET tools sharing `Directory.Build.props`, and two Gradle tools sharing `build.gradle.kts`, now come out as one file with both tools' settings in it. jig used to write none of it and hand you two snippets to paste. For Gradle that advice could not be followed: a build script may hold only one `plugins { }` block, so pasting both gave you a script that would not compile.
- Any setting two tools disagree on in those files is named, the same way it already was for `pyproject.toml` — the first tool's value is what gets written, and you are told whose was dropped.

## [2.2.0] — 2026-08-21

### Added

- Point jig at an empty folder and it goes first. It asks which language, writes the starter project file, installs the toolchain and lands the checks — so the first line of code anybody writes is already being checked. It never offers to build the application instead.
- Ecosystems whose project file only you can name — Go, Gradle and Maven, .NET — say so plainly and hand you the one command to run (`go mod init`, `gradle init`, `dotnet new`). jig picks up from there.
- Every edition now names its project file, so jig knows the difference between a file a tool owns and a file your project owns.

### Fixed

- Several tools sharing one config file no longer overwrite each other. Five Python tools configure `pyproject.toml`, four .NET tools configure `.editorconfig`, and two Rust tools configure `Cargo.toml`; each was written as its own whole-file change, so the last one applied was the only configuration left. jig now writes one file holding every tool's settings, and names any setting two tools disagreed about.
- A shared config file jig cannot safely compose — `go.mod`, `build.gradle.kts`, `Directory.Build.props` — is now written by nobody. You get each tool's snippet and where it goes, instead of one tool's sample landing on top of your build file.
- A config file your project already owns no longer costs you the tool. A repo with its own `pyproject.toml` was offered no linter, no type checker and no test runner at all; the tools install now, and their configuration comes back as a snippet jig will not place for you.
- On Windows, an install that cannot start because the package manager is a `.cmd` shim now says exactly that, and what to do about it. It used to tell you to install a tool you already had.

## [2.1.0] — 2026-08-18

### Added

- Upgrading an install made by an older jig now happens on its own. Run `/jig:jig` on a repo it already guards and it rewrites every installed check into the shape this release reads, keeps each guard's history, and reverts like any other change.
- jig can weave its check line into a pre-commit hook your repository commits, approved by name and reversible. It still never touches `.git/hooks/`, and it still prints the line for you when there is nothing to weave into.
- Answers the interview already collects now reach the install: guards that watch instead of block, the pointer rule for governance documents nothing references, and the `AGENTS.md` block for another AI tool. All three were being asked about and then dropped.

### Changed

- Seven more mistakes are caught. Checks that had been written around a bug in how jig reads comments and strings are back, including two about switching your linter off — the mistake jig exists to catch.
- The history mining reads your project's own language. It was ranking every repository in one language's names, and looking at eight file types instead of twenty-eight.
- Guard reports say when a guard is broken rather than just quiet, so a check that will not load stops reading as a check that never fired.

### Fixed

- Checks that read comments in Python, Ruby, PowerShell and .NET no longer describe a limitation that was fixed a release ago. Nineteen of them said your comments were read as live code; they are not.
- Revert is described honestly: it puts every file back and hands you the one command that takes an installed package off disk. It never runs your package manager for you.
- The Go toolchain no longer offers three tools with a removal command that does not remove anything. They are named, with the reason, and the rest of the Go tooling is still offered.

### Removed

- Three hand-written rule templates and the flag that emitted them. No selection could reach them, so nothing that worked has gone.

## [2.0.0] — 2026-08-13

### Added

- jig now sets up your toolchain instead of only writing configs for tools you already had. It shows the exact install command and the exact config it would write, and runs it once you approve that item. A tool it cannot uninstall again is a tool it refuses to install.
- Six language editions ship: JavaScript and TypeScript, Python, Go, Rust, the JVM, and .NET. Each carries its own tools, install commands, config samples and mistake catalogue.
- Describe a mistake in your own words and jig writes a check for it, together with the violation and near-miss samples that prove the check works. A check that fails either half is discarded and written to `.jig/discarded.json` rather than counted as coverage.
- An existing install upgrades in place. jig reads what is there, carries each guard's history forward, and does it as one reversible transaction.

### Changed

- A check that passed its fixture pair now blocks from the moment it installs. Observe mode is still there whenever you want a guard to only watch, but it is no longer a probation every guard has to serve first.
- jig writes wherever you approve, one named path at a time, instead of only under `.jig/` and `.github/workflows/`. Every write still records the bytes that were there before, so `revert` puts them back — including your manifest and lockfile after an install.

### Fixed

- Checks now read each language's own comment syntax. Previously only six file extensions were recognised, so a `#` comment in a Python or Ruby file was read as code.
- A `//` inside a URL or a `/*` inside a glob no longer blanks the rest of the line or file, which had been silently hiding real findings.
- Path patterns with brace alternation, such as `**/*.{ts,tsx}`, now match.

## [1.0.1] — 2026-08-11

### Fixed

- `review`, `arm`, `disarm`, `fp`, `rerun` and `retire` failed when run from the command line — while working perfectly from tests and hooks, which is exactly why it slipped through. Caught on a real project run.

## [1.0.0] — 2026-08-11

### Changed

- First stable release. Nothing new to learn: every file an earlier install wrote still reads, and future releases keep that promise — your config, ledger, and installed checks never need migrating.

## [0.5.0-alpha] — 2026-08-11

### Added

- Coming back is now one question. On a repository jig already guards, `/jig:jig` shows what drifted, what fired, what never did, and what waits in the backlog — then asks: arm the quiet, take the next thing, retire the dead, or refresh. Retiring a guard is journaled and reversible, and its history stays in the ledger.
- jig can now brief other AI tools. On request it writes one fenced, clearly-marked block into `AGENTS.md` pointing any session that reads it at the committed checks. It only ever rewrites its own block, never your text, and refuses to grow the file past the size where it stops being read at all.
- The scan now warns when a nested `AGENTS.md` shadows the root one for part of the tree.

### Changed

- The coverage matrix's fourth column is honest in both directions now: covered as "probably" where the block is installed — instructions are never a guarantee — and a plain gap where it is not.

## [0.4.0-alpha] — 2026-08-11

### Added

- jig can now write rules — carefully. On explicit request it emits a short, paths-scoped rule for a mistake no tool can watch, or one pointer rule naming the governance docs nothing references. Every rule lands as its own `jig-` file under `.claude/rules/`, is approved by name, carries its origin label, and reverts clean. One install may never add more than a small stated byte budget, because every session pays to carry prose.
- The scan now finds your ADRs, scopes, roadmaps and north stars, and tells you which ones no loaded surface references — documents every session is blind to. The interview turns each one into a decision.
- Permission rules still never land in your settings by themselves. jig writes them up as a proposal you apply yourself, and that stays true in every configuration it ships in.

### Changed

- A default install still adds zero always-loaded text, and the release gate that proves it still runs. Prose only ever arrives because you asked.

## [0.3.0-alpha] — 2026-08-11

### Added

- jig now drafts for your own toolchain, in any language it knows the tools for. A repo carrying eslint or tsc gets a ready side-config plus the one wiring line; a Kotlin build carrying detekt gets a detekt config the same way. Every side-file targets a tool the repository already has — jig never downloads one, and a missing tool is named as a gap instead.
- The install's closing proof now covers toolchain files too: the eslint config is proven live through your own eslint, and tools too expensive to spawn get the exact command to run and what to look for.
- The interview now opens by naming what you may not know you're deciding — the loudest problem in your history jig can't guard yet, a slot another plugin holds, a tool that would close a gap — and then asks in rounds, each question carrying a recommended answer. Two new questions: whether to add the CI workflow, and whether to weave the hook line into a committed pre-commit.

### Changed

- The coverage matrix now grades toolchain coverage per repository: the same class reads as covered where the tool exists and as a named gap where it does not.

## [0.2.0-alpha] — 2026-08-11

### Added

- `/jig:review` — see what every guard has done: fired, never fired, or waved off as a false alarm. It offers arming exactly when a guard has earned it, and records false alarms.
- Guards can now block. A guard becomes armable after ten clean observed sessions with zero recorded false alarms — twenty-five for a heuristic one — and only if its install came from a real answer, never from a quick-start default. A blocked call always shows the reason, an alternative, and how to override.
- A recorded false alarm pulls an armed guard straight back to observing and resets its clock.
- If your pre-commit hook is committed to the repo, jig can now weave the one activation line into it — asked first, approved by name, journaled, reversible. Machine-local hooks still get the printed proposal only.
- Installs now also drop `.jig/hooks/pre-commit`, a ready shim for `core.hooksPath`.

### Changed

- Every guard now has a stable name that survives catalogue updates, so its ledger history stays its own.

## [0.1.0-alpha] — 2026-08-11

### Added

- First cut. `/jig:jig` reads your repo and its git history, asks the two things it can't read, and installs guardrails against four mistakes: a focused or skipped test left in the suite, a swallowed error, a downloaded script piped straight into a shell or a force-push to your main branch, and a deleted test file.
- A committed check script under `.jig/checks/` that any teammate, any CI, any machine with node can run — no plugin needed. A ready-made CI workflow runs it on every push.
- Two session guards that watch what an agent session is about to do. This release they only record: a guard that matches writes down what it would have blocked and lets the call through.
- Every install is journaled and reversible — one command puts every file back, byte for byte. jig writes only under `.jig/` and `.github/workflows/`, and never into a settings file, an instruction file, or a git hook. The pre-commit line and the permission rules are printed as proposals for you to apply.
- The install closes with a live proof: each guard is shown catching a synthetic violation before jig calls anything covered.
- A quick start (`/jig:jig --quick`) that installs all four checks with one review and no interview.
