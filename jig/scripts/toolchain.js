"use strict";

// jig toolchain — the installer. This is the one module in the plugin that can
// run a package manager, so every function here is written to be readable by
// somebody deciding whether to trust it with their machine.
//
// The shape of that trust, in four rules the code enforces rather than states:
//
//   1. A command is never handed to a shell. The install strings in the
//      editions are human-readable prose-ish text; they are parsed into an argv
//      array and spawned with shell: false. A string carrying a metacharacter
//      jig did not put there is refused outright rather than quoted around: an
//      escape is a claim about which shell will read it, and the honest answer
//      is "run this yourself", not a subshell. No shipped edition carries such
//      a command, and a release gate holds that true.
//   2. presence() and proposeInstalls() change nothing. proposeInstalls spawns
//      nothing at all; presence spawns exactly one thing, a version query for
//      the tool itself, which is what SCOPE's "how is tool presence determined"
//      decision asks for and is the only invocation in this file that needs no
//      approval, because a version probe cannot write. A tool whose version
//      query WOULD write — `npx <pkg> --version` installs `<pkg>` — is not
//      probed at all rather than probed loosely.
//   3. Execution is gated on an approval record naming the item's id AND its
//      command verbatim. There is no force flag, no environment override and no
//      "assume yes" path: an approval that does not match the command about to
//      run is a refusal, because the plan the owner read is the only plan.
//   4. jig never leaves an install it cannot undo (SCOPE, "How is a global
//      install undone"). A package-kind tool whose uninstall is missing — or
//      is unrunnable without a shell — is refused at proposal time, before the
//      owner has been shown it as something they could tick.
//
// Every refusal is an Error carrying `expected = true`, the same marker the
// engine uses to tell a sentence the user should read from a bug with a stack.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// A package install can legitimately take minutes (a cold cargo build, a pip
// wheel compile), so the ceiling is generous — but it is a ceiling. A hung
// manager waiting on a credential prompt that nobody will ever type must end
// the run rather than the session.
const INSTALL_TIMEOUT_MS = 300000;

// A version probe that has not answered in ten seconds is not going to.
const PROBE_TIMEOUT_MS = 10000;

const VERIFY_TIMEOUT_MS = 300000;

// 8 MiB of captured output. The default 1 MiB is smaller than a verbose
// `cargo install`, and an overflow surfaces as a spawn error, which would read
// as "the install failed" when the install actually succeeded.
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

// Anything that changes meaning inside a shell. The parser refuses a command
// containing one instead of escaping it: an escape is a claim about which
// shell will read it, and jig never lets one read anything.
const SHELL_META = /[|&;<>()$`\\"'*?[\]{}!#~\n\r]/;

// Lockfile to package manager. Lockfile presence is the first authority
// (SCOPE, "Which package manager wins") because it is a fact about what the
// project has actually been resolved with, not a preference somebody wrote
// down once.
const LOCKFILE_MANAGERS = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "uv.lock": "uv",
  "poetry.lock": "poetry",
  "pdm.lock": "pdm",
  "Cargo.lock": "cargo",
  "go.sum": "go",
  "gradle.lockfile": "gradle",
  "packages.lock.json": "nuget",
};

// The second authority: what the manifest declares. A regex per file rather
// than a parser, because the question asked is only "which manager owns this
// project" and a TOML or XML parser would be a dependency for one answer.
const MANIFEST_DECLARATIONS = [
  { file: "package.json", managers: [{ manager: "npm", re: /"packageManager"\s*:\s*"npm@/ }, { manager: "pnpm", re: /"packageManager"\s*:\s*"pnpm@/ }, { manager: "yarn", re: /"packageManager"\s*:\s*"yarn@/ }, { manager: "bun", re: /"packageManager"\s*:\s*"bun@/ }] },
  { file: "pyproject.toml", managers: [{ manager: "poetry", re: /^\s*\[tool\.poetry[.\]]/m }, { manager: "pdm", re: /^\s*\[tool\.pdm[.\]]/m }, { manager: "uv", re: /^\s*\[tool\.uv[.\]]/m }] },
  { file: "go.mod", managers: [{ manager: "go", re: /^\s*module\s+\S/m }] },
  { file: "Cargo.toml", managers: [{ manager: "cargo", re: /^\s*\[(?:package|workspace)\]/m }] },
  { file: "pom.xml", managers: [{ manager: "maven", re: /<project\b/ }] },
  { file: "build.gradle", managers: [{ manager: "gradle", re: /[\s\S]*/ }] },
  { file: "build.gradle.kts", managers: [{ manager: "gradle", re: /[\s\S]*/ }] },
  { file: "global.json", managers: [{ manager: "dotnet", re: /"sdk"\s*:/ }] },
];

// Where presence() looks when the binary did not answer. A tool can be a
// declared dependency that nobody has run `install` for yet — present in the
// project's intent, absent from the machine — and the two answers deserve
// different words, which is what `how` carries.
const MANIFEST_FILES = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "setup.cfg",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Directory.Packages.props",
  "Directory.Build.props",
];

// The .NET project file is the manifest, and it is neither at a fixed name nor
// necessarily at the root — jig's own starter writes `src/App.csproj` and
// `tests/App.Tests.csproj`. So the suffixes are listed and the search is the
// root plus its immediate children: `dotnet add package` writes a
// PackageReference into one of these and nowhere else, and an analyzer package
// has no other trace to read.
const MANIFEST_SUFFIXES = [".csproj", ".fsproj", ".vbproj"];

// Bounded on purpose: one readdir of the root and one per immediate child, with
// the directories every ecosystem fills skipped. A manifest search is on the
// read-only path and must not turn into a walk of somebody's node_modules.
const UNSEARCHED_DIRS = ["node_modules", "target", "build", "bin", "obj", "dist", "vendor"];

function manifestPaths(root) {
  const out = MANIFEST_FILES.map((f) => path.join(root, f));
  const dirs = [root];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && !UNSEARCHED_DIRS.includes(entry.name)) {
      dirs.push(path.join(root, entry.name));
    }
  }
  for (const dir of dirs) {
    let listing;
    try {
      listing = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of listing) {
      if (entry.isFile() && MANIFEST_SUFFIXES.some((ext) => entry.name.endsWith(ext))) out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Refusals and shape checks
// ---------------------------------------------------------------------------

function refuse(message) {
  const err = new Error(message);
  err.expected = true;
  return err;
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// The root is explicit on every entry point so that nothing in this file can
// be pointed at a directory by ambient state. It has to exist before a spawn,
// or the manager's own ENOENT arrives describing the wrong thing.
function requireRoot(projectRoot) {
  if (!nonEmptyString(projectRoot)) throw refuse("projectRoot must be a path, and jig was given " + JSON.stringify(projectRoot));
  let stat;
  try {
    stat = fs.statSync(projectRoot);
  } catch {
    throw refuse("projectRoot does not exist: " + projectRoot);
  }
  if (!stat.isDirectory()) throw refuse("projectRoot is not a directory: " + projectRoot);
  return path.resolve(projectRoot);
}

function requireTool(tool) {
  if (!isObject(tool)) throw refuse("a toolchain entry must be an object from a v3 edition, and jig was given " + JSON.stringify(tool));
  if (!nonEmptyString(tool.id)) throw refuse("a toolchain entry has no id, so nothing here could name it in a plan");
  return tool;
}

// argv[0] of the tool's own verify is the executable the edition believes in.
// Deriving the probe from it rather than from a second schema field is SCOPE's
// decision ("No schema field for it") and keeps one name from drifting from
// the other.
function verifyExecutable(tool) {
  const argv = tool.verify && tool.verify.argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(nonEmptyString)) {
    throw refuse(tool.id + " has no verify.argv, so jig cannot tell which executable proves it — a v3 edition must carry one");
  }
  return argv;
}

// The tool as ONE package manager runs it. `install` and `uninstall` are keyed
// by manager already; `verify` was not, so the javascript audit row installed
// `pnpm audit` and then wired a lane running `npm audit` over a tree npm never
// resolved — the same shape as the jvm defect 2.14.0 closed, the lane and the
// install disagreeing about which manager this project is.
//
// Where an edition keys `verify.byManager`, the manager picks; where it does
// not, the tool is itself, which is every row that runs the same program under
// every manager.
function toolFor(tool, manager) {
  const byManager = tool && tool.verify && tool.verify.byManager;
  if (!isObject(byManager) || !nonEmptyString(manager) || !isObject(byManager[manager])) return tool;
  const verify = { ...tool.verify, ...byManager[manager] };
  delete verify.byManager;
  return { ...tool, verify };
}

function readIfExists(full) {
  try {
    return fs.readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

// The editions write install commands the way a human would type them. Turning
// one into argv is therefore a trust boundary, and the boundary is drawn by
// refusal rather than by cleverness: no quoting, no substitution, no operators.
// Everything a shell would have interpreted is exactly the class of text that
// must not reach a child process from a data file.
function parseCommand(text, label) {
  if (!nonEmptyString(text)) throw refuse(label + " is not a command string (" + JSON.stringify(text) + ")");
  const found = text.match(SHELL_META);
  if (found) {
    throw refuse(label + " contains the shell character " + JSON.stringify(found[0]) + " and jig runs every command without a shell, so it cannot run this one:\n  " +
      text.trim() + "\nRun it yourself if you want it, or pick a tool whose commands are plain argv.");
  }
  const argv = text.trim().split(/\s+/).filter(Boolean);
  if (!argv.length) throw refuse(label + " is empty");
  return argv;
}

// ---------------------------------------------------------------------------
// presence
// ---------------------------------------------------------------------------

function firstVersion(text) {
  // No leading word boundary: `node --version` prints `v22.22.2`, and a
  // boundary would start the match after the `v` at the wrong digit run.
  const m = String(text || "").match(/(\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)/);
  return m ? m[1] : null;
}

// Whole-word, and deliberately unwilling to match through a dot: `[tool.ruff]`
// is a configuration section, not evidence that ruff is a dependency, and
// `eslint.config.js` is a filename. Over-reading either way turns "declared"
// into a claim the manifest never made.
function manifestMentions(root, names) {
  for (const file of manifestPaths(root)) {
    const text = readIfExists(file);
    if (text === null) continue;
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp("(?<![\\w.\\-/])" + escaped + "(?![\\w.\\-])").test(text)) return path.relative(root, file);
    }
  }
  return null;
}

// Runners that FETCH whatever they are asked to run. Measured on 2026-09-02:
// `npx eslint --version` on a machine with no eslint installs eslint and then
// answers. presence() writes nothing, so a tool behind one of these is not
// probed at all — the manifest is the only honest reading left, and where even
// that is silent the answer is "unprobeable", not "absent".
const FETCHING_RUNNERS = ["npx", "pnpx", "bunx", "uvx"];

// Hosts that dispatch a subcommand to a separately installed program of its
// own: `cargo nextest` runs the `cargo-nextest` binary, and cargo answers
// `--version` whether or not that binary was ever installed — which is how all
// six rust tools read present on a machine carrying four of them. Only a host
// whose subcommand is its own program belongs here: `ruff check` and `go vet`
// are verbs of one program, and asking `ruff check --version` asks ruff about
// an argument it does not take.
const SUBCOMMAND_HOSTS = ["cargo"];

// The programs an edition's install commands run through, one per manager.
// `dotnet add package X` and `npm install --save-dev X` both start with the
// host, never with the thing being installed.
function installHosts(tool) {
  return Object.values(isObject(tool.install) ? tool.install : {})
    .filter(nonEmptyString).map((cmd) => cmd.trim().split(/\s+/)[0]);
}

// The operand each install command names — its last argument that is not a
// flag. For a package with no executable that IS the tool's name on disk: the
// `PackageReference` `dotnet add package SonarAnalyzer.CSharp` writes into the
// project file is the only trace such a tool leaves anywhere.
function installOperands(tool) {
  const out = [];
  for (const cmd of Object.values(isObject(tool.install) ? tool.install : {})) {
    if (!nonEmptyString(cmd)) continue;
    const last = cmd.trim().split(/\s+/).filter((w) => !w.startsWith("-")).pop();
    if (nonEmptyString(last)) out.push(last);
  }
  return out;
}

// The version query that proves THIS tool, derived from the verify argv the
// edition already carries (SCOPE, "How is tool presence determined"). null
// where the query cannot be asked without installing something.
function probeArgv(tool, argv) {
  if (FETCHING_RUNNERS.includes(argv[0])) return null;
  // A builtin IS its host — `cargo check` and `go vet` ship inside the program
  // that answers for them — so the host's own answer is the tool's.
  if (tool.installKind === "builtin") return [argv[0], "--version"];
  // A module lives inside an interpreter the machine already has, so the
  // interpreter's version says nothing about it: `python --version` answered
  // for `python -m build` on a machine with no build module.
  if (argv[1] === "-m" && nonEmptyString(argv[2])) return [argv[0], "-m", argv[2], "--version"];
  if (SUBCOMMAND_HOSTS.includes(argv[0]) && argv[1] && !argv[1].startsWith("-")) return [argv[0], argv[1], "--version"];
  // A package whose verify runs through the very program its own install runs
  // through has no executable anywhere: `dotnet add package
  // SonarAnalyzer.CSharp` writes a PackageReference and puts nothing on PATH,
  // and the thing that then runs is the SDK's build. So there is nothing to
  // spawn and nothing is spawned — asking `dotnet --version` answered 10.0.303
  // for three analyzers that were not in the project, jig planned no install,
  // and the lane went green over a linter that was never there.
  if (tool.installKind === "package" && installHosts(tool).includes(argv[0])) return null;
  return [argv[0], "--version"];
}

// Absence is an answer, never an exception: the whole point of asking is that
// the tool is probably missing. A malformed edition entry still throws, because
// that is a bug in data jig shipped and silence would hide it.
function presence(projectRoot, tool) {
  const root = requireRoot(projectRoot);
  requireTool(tool);
  const argv = verifyExecutable(tool);
  const probeCmd = probeArgv(tool, argv);

  if (probeCmd) {
    // The single execution on the read-only path. It carries a fixed argv, no
    // shell, and a short leash — there is no input from the project in it beyond
    // the executable name the edition itself supplies.
    const probe = spawnSync(probeCmd[0], probeCmd.slice(1), {
      cwd: root, shell: false, windowsHide: true, encoding: "utf8", timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
    });
    // Where the probe is the executable itself, running at all is proof it is
    // installed, whatever it thought of `--version`: `go --version` exits
    // non-zero and go is still on the machine. Where the probe asks a host
    // about something else — a module, a dispatched subcommand — the host runs
    // either way, so only an answer counts: `cargo nextest --version` exits 101
    // saying `no such command`, and that is the tool being absent.
    const answered = probeCmd.length > 2 ? !probe.error && probe.status === 0 : !probe.error;
    if (answered) {
      return { present: true, version: firstVersion(probe.stdout) || firstVersion(probe.stderr), how: "probe" };
    }
  }

  // What a manifest would have to name is the tool's own program or package,
  // never the host it is dispatched through: `npx` in a scripts block is not
  // eslint, and a Cargo.toml saying `cargo` is not nextest. A package with no
  // executable is named by its own install operand, because a PackageReference
  // is the only place it exists at all.
  const names = probeCmd
    ? [tool.id, probeCmd[probeCmd.length - 2]]
    : FETCHING_RUNNERS.includes(argv[0])
      ? [tool.id, argv[1] || argv[0]]
      : [tool.id, ...installOperands(tool)];
  if (manifestMentions(root, [...new Set(names.filter(nonEmptyString))])) return { present: true, version: null, how: "manifest" };
  // Nothing could be asked and nothing was declared: jig does not know, and
  // says so rather than calling it absent. Either way it plans the install,
  // which is the direction the owner can decline.
  return { present: false, version: null, how: probeCmd ? "absent" : "unprobeable" };
}

// ---------------------------------------------------------------------------
// pickPackageManager
// ---------------------------------------------------------------------------

function editionManagers(edition) {
  const managers = edition && edition.detect && edition.detect.packageManagers;
  if (!Array.isArray(managers) || !managers.length || !managers.every(nonEmptyString)) {
    throw refuse("this edition declares no detect.packageManagers, so jig cannot tell which managers are even possible here");
  }
  return managers;
}

// Lockfile, then declaration, then null — and null means "ask the owner", which
// is why two lockfiles produce it too. Two managers have both resolved this
// project at some point; picking one of them is exactly the guess that installs
// a dependency into the file nobody reads.
function pickPackageManager(projectRoot, edition) {
  const root = requireRoot(projectRoot);
  const allowed = editionManagers(edition);

  const locked = new Set();
  for (const [file, manager] of Object.entries(LOCKFILE_MANAGERS)) {
    if (!allowed.includes(manager)) continue;
    if (fs.existsSync(path.join(root, file))) locked.add(manager);
  }
  if (locked.size === 1) return [...locked][0];
  if (locked.size > 1) return null;

  const declared = new Set();
  for (const entry of MANIFEST_DECLARATIONS) {
    const text = readIfExists(path.join(root, entry.file));
    if (text === null) continue;
    for (const candidate of entry.managers) {
      if (allowed.includes(candidate.manager) && candidate.re.test(text)) declared.add(candidate.manager);
    }
  }
  if (declared.size === 1) return [...declared][0];
  return null;
}

// ---------------------------------------------------------------------------
// proposeInstalls
// ---------------------------------------------------------------------------

// The installKinds whose whole effect lands inside the project root, where the
// journal's own pre-images and its created-path rows are the way back out.
// Everything else needs the ecosystem to be told.
//
// The kind is a CLAIM, and `catalogueEscapesRoot` below is what checks it: a
// row that says `builtin` and then installs a rust toolchain into ~/.rustup is
// an install jig could not undo, offered under the kind that says it needs no
// undoing. Release gate G8 holds every shipped row to it.
const JOURNAL_REVERSIBLE_KINDS = ["scaffold", "builtin", "audit"];

// The install shapes that reach past the project root: a global binary, a
// toolchain, a machine-level package feed. Listed rather than inferred, because
// an argv is the only thing jig has to read and a command that writes outside
// the root does not announce itself.
const ESCAPES_ROOT = [
  /\brustup\s/, /\bgo\s+install\b/, /\bcargo\s+install\b/, /\bnuget\s+add\s+source\b/,
  /\btool\s+install\b/, /(?:^|\s)(?:-g|--global)(?:\s|$)/,
];

// Whether a command installs something the journal will never see. Exported so
// the release gate can hold the catalogue to it as well as this refusal.
function escapesRoot(command) {
  return typeof command === "string" && ESCAPES_ROOT.some((re) => re.test(command));
}

function findTool(edition, id) {
  const list = (edition && edition.toolchain) || [];
  if (!Array.isArray(list) || !list.length) throw refuse("this edition carries no toolchain, so there is nothing to propose");
  const tool = list.find((t) => isObject(t) && t.id === id);
  if (!tool) throw refuse("no tool " + JSON.stringify(id) + " in the " + (edition.edition || "given") + " edition — it has: " + list.map((t) => t.id).join(", "));
  return tool;
}

// Whether two of an edition's managers are two doors into ONE project or two
// different projects, read off the thing the edition already says: a manager
// that needs its own project file is a different build system, and a manager
// that shares one is a second door. `rustup component add clippy` in a cargo
// project is a second door — one Cargo.toml, two managers — which is why
// falling through to it is not a guess. `detect.manifest.path` being a map is
// the edition's own statement that its managers are alternatives (SCOPE, "One
// edition, two build systems").
function twoDoorsOneProject(edition, a, b) {
  const held = edition && edition.detect && edition.detect.manifest && edition.detect.manifest.path;
  return typeof held === "string" || (isObject(held) && held[a] === held[b]);
}

// A tool usually installs through the project's manager. Some do not exist
// under it at all — clippy is a rustup component in a cargo project — so when
// the chosen manager offers no command and the tool offers exactly one that
// the edition recognises, that one is not a guess, it is the only door. Two
// doors and no match is a refusal, because then it would be.
//
// So is one door into a DIFFERENT project. Until 2.14.0 the single-door rule
// took no notice of which build system it was falling into, and a jvm install
// under maven took every tool's gradle command: seven lane entries all reading
// `./gradlew`, which `mvn -N wrapper:wrapper` never creates, plus a
// `build.gradle.kts` written beside the pom. Both lanes exited 1 on every
// machine. Substituting the other build system is exactly the silent default
// this contract forbids, so it is a refusal that names the two by name.
function managerForTool(edition, tool, packageManager, allowed) {
  const install = tool.install;
  if (!isObject(install) || !Object.keys(install).length) throw refuse(tool.id + " carries no install commands, so jig has nothing to propose for it");
  if (nonEmptyString(install[packageManager])) return packageManager;
  const offered = Object.keys(install).filter((m) => allowed.includes(m));
  if (offered.length === 1 && twoDoorsOneProject(edition, packageManager, offered[0])) return offered[0];
  throw refuse(tool.id + " has no install command for " + packageManager + " (it offers: " + Object.keys(install).join(", ") + ")." +
    (offered.length === 1
      ? " " + offered[0] + " and " + packageManager + " are different build systems here — each writes its own project file — so jig will not run " +
        offered[0] + "'s command in a " + packageManager + " project."
      : "") +
    " Pick a package manager it supports, or install it yourself and re-run.");
}

// One item per tool, and the item is the whole tool: install, config, wiring
// and the way back out (SCOPE, "Is install, config and wiring one item or
// three"). Nothing is spawned here — a proposal the owner has not read yet
// must not have touched anything.
function proposeInstalls(projectRoot, edition, toolIds, packageManager) {
  requireRoot(projectRoot);
  const allowed = editionManagers(edition);
  if (!Array.isArray(toolIds) || !toolIds.length || !toolIds.every(nonEmptyString)) {
    throw refuse("proposeInstalls needs at least one tool id, and jig was given " + JSON.stringify(toolIds));
  }
  if (!nonEmptyString(packageManager)) {
    throw refuse("no package manager was chosen. pickPackageManager returned nothing conclusive, which means the owner has to say which of " +
      allowed.join(", ") + " this project uses.");
  }
  if (!allowed.includes(packageManager)) {
    throw refuse(packageManager + " is not a package manager of the " + (edition.edition || "given") + " edition, which uses: " + allowed.join(", "));
  }

  const items = [];
  for (const id of toolIds) {
    const tool = findTool(edition, id);
    const manager = managerForTool(edition, tool, packageManager, allowed);
    const command = tool.install[manager];
    const argv = parseCommand(command, id + "'s " + manager + " install command");

    // The refusal that gives this module its shape, stated over every
    // installKind rather than over one. There are two ways back out of an
    // install: the ecosystem's own reconcile command, or the journal — and the
    // journal only reaches bytes inside the project root. `scaffold` writes
    // exactly those, `builtin` and `audit` write none, and since 2.12.0 an
    // install's created paths are snapshotted into the journal, so those three
    // are undone without a command. Every other kind — `package`, and any kind
    // this engine does not recognise, because an unrecognised kind is a claim
    // jig cannot check — leaves bytes the journal never sees, and is not
    // proposed at all without a stated way out.
    //
    // The exemption is the kind AND the command: a row may say `builtin` and
    // still run `rustup toolchain install`, and the journal never sees a byte
    // of that. The command decides, so a mislabelled row is refused rather
    // than trusted.
    let uninstallCommand = null;
    let uninstallArgv = null;
    // Set where the way out is a line the OWNER runs in their own shell rather
    // than an argv. jig runs no uninstall on any route — the command is written
    // into the journal as `reconcile` and printed on the plan — so "jig cannot
    // spawn this" is not the same question as "is there a way back out". Until
    // 2.14.0 the two were one refusal, and it cost the go edition its linter,
    // its formatter and its scanner on every machine: `rm -f "$(go env
    // GOPATH)/bin/gofumpt$(go env GOEXE)"` is the only correct undo Go has —
    // there is no `go uninstall` — and it needs a shell to say GOPATH. Three of
    // six go tools were structurally unofferable and the owner could act on
    // none of it. A shell-only undo is now disclosed as a manual step; an
    // install with no stated undo at all is still refused.
    let uninstallManual = false;
    const uninstall = isObject(tool.uninstall) ? tool.uninstall[manager] : null;
    if (!JOURNAL_REVERSIBLE_KINDS.includes(tool.installKind) || escapesRoot(command)) {
      if (!nonEmptyString(uninstall)) {
        throw refuse(id + " installs as " + JSON.stringify(tool.installKind || null) + " under " + manager +
          (escapesRoot(command) ? " by running `" + command + "`, which writes outside the project root," : "") +
          " and the edition states no uninstall for it, so nothing outside the project root could be put back." +
          " jig never leaves an install it cannot undo, so it will not offer this one.");
      }
    }
    if (nonEmptyString(uninstall)) {
      uninstallCommand = uninstall;
      try {
        uninstallArgv = parseCommand(uninstall, id + "'s " + manager + " uninstall command");
      } catch (err) {
        if (!err.expected) throw err;
        uninstallManual = true;
      }
    }

    if (!nonEmptyString(tool.configPath) || typeof tool.configSample !== "string") {
      throw refuse(id + " carries no configPath and configSample, so the owner would be approving an install with no config to read");
    }

    // An ignore file is optional, but half of one is a path with nothing to put
    // in it or a body with nowhere to go — either way an owner would approve a
    // write jig could not perform.
    if (nonEmptyString(tool.ignorePath) !== (typeof tool.ignoreSample === "string")) {
      throw refuse(id + " states one half of an ignore file: ignorePath and ignoreSample are written together or not at all");
    }

    // Frozen because an item is shown, approved, and only then run. Anything
    // that could edit `command` between those steps would make the approval
    // describe a command that is no longer the one about to execute.
    items.push(Object.freeze({
      id,
      role: tool.role || null,
      // The edition's own case for the tool. Carried onto the item because the
      // owner is asked to tick it, and a role alone ("linter") is a category,
      // not a reason to install anything.
      why: nonEmptyString(tool.why) ? tool.why : null,
      edition: edition.edition || null,
      installKind: tool.installKind || null,
      packageManager: manager,
      command,
      argv: Object.freeze(argv),
      configPath: tool.configPath,
      configBody: tool.configSample,
      // Where the tool is told what NOT to read. Only a tool that walks by path
      // rather than by extension needs one, which is why it is optional: prettier
      // reports every file under `.jig/`, ruff and gofumpt never see them.
      ignorePath: nonEmptyString(tool.ignorePath) ? tool.ignorePath : null,
      ignoreBody: typeof tool.ignoreSample === "string" ? tool.ignoreSample : null,
      wiring: nonEmptyString(tool.wiring) ? tool.wiring : null,
      // The item is the whole tool, and CI is part of it. Carried here so the
      // route that installs a tool and the route that only configures one hand
      // back the same thing — a tool the owner installed by hand still has a
      // step somebody has to run.
      ciStep: nonEmptyString(tool.ciStep) ? tool.ciStep : null,
      uninstallCommand,
      uninstallArgv: uninstallArgv ? Object.freeze(uninstallArgv) : null,
      // True when `uninstallCommand` is a shell line, not an argv. The plan says
      // so rather than printing it as though jig would run it.
      uninstallManual,
      timeoutMs: INSTALL_TIMEOUT_MS,
    }));
  }
  return items;
}

// ---------------------------------------------------------------------------
// runInstall
// ---------------------------------------------------------------------------

// The gate, in one place so both directions cannot drift apart. The record has
// to name this item and repeat the command character for character: an
// approval that merely says "yes" would still say yes after the plan was
// edited underneath it.
function requireApproval(item, approval, command, phase) {
  if (!isObject(item) || !nonEmptyString(item.id)) throw refuse("run" + phase + " needs an item from proposeInstalls");
  if (!nonEmptyString(command)) throw refuse(item.id + " has no " + phase.toLowerCase() + " command to run");
  if (!isObject(approval)) {
    throw refuse("refusing to run " + item.id + ": no approval record. jig runs a command only when it is handed { id, command } naming exactly what is about to run.");
  }
  if (approval.id !== item.id) {
    throw refuse("refusing to run " + item.id + ": the approval names " + JSON.stringify(approval.id) + " instead.");
  }
  if (approval.command !== command) {
    throw refuse("refusing to run " + item.id + ": the approval names a different command.\n  approved: " + String(approval.command) + "\n  would run: " + command);
  }
}

// Where an executable name resolves to a `.cmd` or `.bat` on this machine.
// Returns the resolved path, or null on any platform and for any name where
// that is not the story — including when the tool is genuinely absent.
function windowsShim(name) {
  if (process.platform !== "win32") return null;
  if (/\.(cmd|bat)$/i.test(name)) return name;
  for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of [".cmd", ".bat"]) {
      const full = path.join(dir, name + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch { /* a PATH entry that is not there is not this function's problem */ }
    }
  }
  return null;
}

// The JS the `.cmd` shim would have handed to node, per manager, resolved
// beside the shim itself. A machine with fnm or nvm has one of these per node
// version; the one that answers to `npm` on this PATH is the one whose shim was
// just found, so the neighbour is the right copy and a PATH search is not.
const NODE_CLI_ENTRIES = {
  npm: "node_modules/npm/bin/npm-cli.js",
  npx: "node_modules/npm/bin/npx-cli.js",
  pnpm: "node_modules/pnpm/bin/pnpm.cjs",
  yarn: "node_modules/yarn/bin/yarn.js",
};

// The same command with no shim in it, or null when there is no such route.
// npm, pnpm and yarn are Node programs wearing a `.cmd` hat: the shim's whole
// job is to find node and hand it the script named here, and jig already IS a
// node that can do that. So the batch shim is never the route (SCOPE, the
// derail pass) and no shell is needed for the managers the owner's own platform
// installs everything through. Nothing else is rewritten — a batch file with no
// JS behind it needs cmd.exe, and jig opens no shell.
function shellFreeArgv(argv) {
  const rel = NODE_CLI_ENTRIES[String(argv[0]).replace(/\.(cmd|bat)$/i, "").toLowerCase()];
  if (!rel) return null;
  // Absolute only: `windowsShim` hands a bare `.cmd` name straight back, and
  // resolving the entry beside that would read a `node_modules` in whatever
  // directory jig happens to be run from rather than the manager's own.
  const shim = windowsShim(argv[0]);
  if (!shim || !path.isAbsolute(shim)) return null;
  const entry = path.join(path.dirname(shim), ...rel.split("/"));
  if (!fs.existsSync(entry)) return null;
  return [process.execPath, entry, ...argv.slice(1)];
}

// The Windows half of a wrapper script, spelled out. `./gradlew` is a shell
// script and what Windows has beside it is `gradlew.bat`, which only cmd.exe
// can start — a shell, so the answer is no (SCOPE, the derail pass). The
// refusal names the exact line to run by hand rather than routing around the
// stance, on the same footing as the batch-shim refusal above.
function wrapperTwin(argv) {
  if (process.platform !== "win32") return null;
  const m = /^\.[\\/](.+)$/.exec(String(argv[0]));
  if (!m || /\.(cmd|bat)$/i.test(m[1])) return null;
  return [m[1] + ".bat", ...argv.slice(1)].join(" ");
}

function runArgv(root, item, argv, command, timeoutMs) {
  const spawnable = shellFreeArgv(argv) || argv;
  const run = spawnSync(spawnable[0], spawnable.slice(1), {
    cwd: root, shell: false, windowsHide: true, encoding: "utf8", timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES,
  });

  const stdout = run.stdout || "";
  const stderr = run.stderr || "";
  if (run.error && run.error.code === "ETIMEDOUT") {
    return { ran: true, code: run.status === undefined ? null : run.status, stdout, stderr, timedOut: true };
  }
  if (run.error) {
    // No error channel exists in the return shape, and a silent { ran: false }
    // would leave the caller guessing at a failure it has to act on.
    const byHand = wrapperTwin(argv);
    if (byHand) {
      throw refuse(argv[0] + " is a shell script, and the Windows half of that wrapper is a batch file only" +
        " cmd.exe can start. jig runs every command without a shell and will not open one:\n  " + byHand +
        "\nRun that line yourself in this folder and re-run jig. Every other change in the plan applies normally.");
    }
    const shim = windowsShim(argv[0]);
    if (shim) {
      // A batch shim with no JS entry beside it — `shellFreeArgv` already took
      // every route there was. The old message got this wrong: it told somebody
      // to install a tool that is already installed. Node has refused to start
      // a `.cmd` without a shell since the 2024 argument-injection fix, jig does
      // not open one, so this is a real limit — stated as one rather than
      // dressed up as a missing tool.
      throw refuse(argv[0] + " is a Windows batch shim (" + shim + ") and jig runs every command without a" +
        " shell, so it cannot start this one:\n  " + command +
        "\nRun that line yourself in this folder and re-run jig: it probes for the tool and will find it" +
        " installed. Every other change in the plan applies normally.");
    }
    throw refuse("could not run " + JSON.stringify(argv[0]) + " for " + item.id + " (" + run.error.code + ": " + run.error.message + ").\n  command: " + command +
      "\nInstall " + argv[0] + " and re-run, or run the command yourself.");
  }
  // A non-zero exit is data, not a problem to route around: it is returned as
  // it stands, never retried, never followed by a second command that would
  // have "worked".
  return { ran: true, code: run.status, stdout, stderr, timedOut: false };
}

function runInstall(projectRoot, item, approval) {
  const root = requireRoot(projectRoot);
  requireApproval(item, approval, item && item.command, "Install");
  if (!Array.isArray(item.argv) || !item.argv.length) throw refuse(item.id + " has no parsed argv — it did not come from proposeInstalls");
  return runArgv(root, item, item.argv, item.command, item.timeoutMs > 0 ? item.timeoutMs : INSTALL_TIMEOUT_MS);
}


// ---------------------------------------------------------------------------
// execVerify
// ---------------------------------------------------------------------------

function expectedExits(tool) {
  const raw = tool.verify && tool.verify.expectedExit;
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length || !list.every((n) => Number.isInteger(n))) {
    throw refuse(tool.id + " has no verify.expectedExit. Prose in verify.expected is not machine-readable, and jig will not treat it as if it were.");
  }
  return list;
}

function containedPath(base, rel, what) {
  const full = path.resolve(base, rel);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (full !== base && !full.startsWith(prefix)) throw refuse(what + " escapes its directory: " + rel);
  return full;
}

// The seed goes under a caller-named directory rather than at the path the
// edition states, because several v3 seeds are named `Cargo.toml` or
// `pyproject.toml` — written where the edition says, a proof would overwrite
// the project's own manifest. seedDir is a parameter so the caller owns that
// directory's lifecycle, journalling and removal included.
//
// `caught` is exit-code equality and nothing else. Matching a substring of
// stdout is how a tool's unrelated deprecation warning becomes proof that a
// guard works.
function execVerify(projectRoot, tool, seedDir) {
  const root = requireRoot(projectRoot);
  requireTool(tool);
  const argv = verifyExecutable(tool);
  const expected = expectedExits(tool);
  const seed = tool.seed;
  if (!isObject(seed) || !nonEmptyString(seed.path) || typeof seed.sample !== "string") {
    throw refuse(tool.id + " has no seed to plant. A class fixture is not a tool fixture, and a v3 edition must carry a per-tool seed.");
  }
  if (!nonEmptyString(seedDir)) throw refuse("execVerify needs a seed directory to write into, and jig was given " + JSON.stringify(seedDir));

  const dir = containedPath(root, seedDir, "the seed directory");
  const target = containedPath(dir, seed.path, tool.id + "'s seed path");
  if (fs.existsSync(target)) {
    throw refuse("the seed target already exists and jig will not write over it: " + path.relative(root, target));
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, seed.sample, "utf8");

  // cwd is the project root, not the seed directory: the proof is worth
  // something only if the tool reads the project's own configuration while it
  // looks at the planted violation.
  const spawnable = shellFreeArgv(argv) || argv;
  const run = spawnSync(spawnable[0], spawnable.slice(1), {
    cwd: root, shell: false, windowsHide: true, encoding: "utf8", timeout: VERIFY_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (run.error && run.error.code !== "ETIMEDOUT") {
    throw refuse("could not run " + JSON.stringify(argv[0]) + " to verify " + tool.id + " (" + run.error.code + ": " + run.error.message + "). Install it before asking jig to prove it.");
  }
  const code = run.status === undefined ? null : run.status;
  return {
    ran: true,
    code,
    caught: code !== null && expected.includes(code),
    expectedExit: tool.verify.expectedExit,
    // What the tool actually said. An exit code alone tells an owner their
    // config failed its demonstration and gives them nothing to read; both
    // streams, because linters split their diagnostics between them.
    output: ((run.stdout || "") + (run.stderr || "")).trim(),
  };
}

// The same argv with nothing planted. A repository that was already failing its
// own linter reads every seeded proof as a catch, and the owner would be told
// the config works when what they have is a red tree. Baseline and proof are
// two runs because one exit code cannot tell them apart.
function execBaseline(projectRoot, tool) {
  const root = requireRoot(projectRoot);
  requireTool(tool);
  const argv = verifyExecutable(tool);
  const spawnable = shellFreeArgv(argv) || argv;
  const run = spawnSync(spawnable[0], spawnable.slice(1), {
    cwd: root, shell: false, windowsHide: true, encoding: "utf8", timeout: VERIFY_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
  });
  const timedOut = !!(run.error && run.error.code === "ETIMEDOUT");
  if (run.error && !timedOut) {
    throw refuse("could not run " + JSON.stringify(argv[0]) + " to take " + tool.id + "'s baseline (" +
      run.error.code + ": " + run.error.message + "). Install it before asking jig to prove it.");
  }
  const code = run.status === undefined ? null : run.status;
  // A run that hung has not shown the tree clean, so it is red like any other
  // non-zero answer — with `timedOut` beside it, because the two deserve
  // different words from whoever reads this.
  return { ran: true, code, timedOut, baseline: code === 0 ? "clean" : "red" };
}

module.exports = {
  // Exported for the lane entries in `.jig/verify.json`: a command a lane runs
  // goes through the same trust boundary as a command an install runs, so there
  // is one parser and one refusal for both.
  parseCommand,
  presence,
  // Exported so the caller that already knows which manager this project is —
  // the install proposal, the lane composer, the toolchain probe — reads the
  // verify that manager runs rather than the row's default.
  toolFor,
  // Exported for release gate G10, which asked its own version of this question
  // and got a different answer: it skipped ruff on a machine carrying ruff and
  // would have run nextest on one carrying none. One reading, one export.
  probeArgv,
  pickPackageManager,
  proposeInstalls,
  // Exported for release gate G8: the catalogue is held to the same reading of
  // an install command that the refusal above uses, so a new row cannot claim a
  // journal-reversible kind for something the journal never sees.
  JOURNAL_REVERSIBLE_KINDS,
  escapesRoot,
  runInstall,
  execVerify,
  execBaseline,
  // Exported for the witnessed close: a batch shim jig cannot start is a
  // "cannot run", and the close has to say so before it plants a seed for a
  // proof that could never happen.
  windowsShim,
  // Exported beside it, because the close has to ask both questions in that
  // order: a shim jig can run through node is not a "cannot run" at all.
  shellFreeArgv,
};
