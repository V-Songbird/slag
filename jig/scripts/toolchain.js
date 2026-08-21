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
//      nothing at all; presence spawns exactly one thing, `<tool> --version`,
//      which is what SCOPE's "how is tool presence determined" decision asks
//      for and is the only invocation in this file that needs no approval,
//      because a version probe cannot write.
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
];

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
  for (const file of MANIFEST_FILES) {
    const text = readIfExists(path.join(root, file));
    if (text === null) continue;
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp("(?<![\\w.\\-/])" + escaped + "(?![\\w.\\-])").test(text)) return file;
    }
  }
  return null;
}

// Absence is an answer, never an exception: the whole point of asking is that
// the tool is probably missing. A malformed edition entry still throws, because
// that is a bug in data jig shipped and silence would hide it.
function presence(projectRoot, tool) {
  const root = requireRoot(projectRoot);
  requireTool(tool);
  const exe = verifyExecutable(tool)[0];

  // The single execution on the read-only path. It carries a fixed argv, no
  // shell, and a short leash — there is no input from the project in it beyond
  // the executable name the edition itself supplies.
  const probe = spawnSync(exe, ["--version"], {
    cwd: root, shell: false, windowsHide: true, encoding: "utf8", timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
  });
  // A tool that ran at all is installed, whatever it thought of `--version`:
  // `go --version` exits non-zero and is still proof that go is on the machine.
  if (!probe.error) {
    return { present: true, version: firstVersion(probe.stdout) || firstVersion(probe.stderr), how: "probe" };
  }

  const names = [...new Set([tool.id, exe])];
  if (manifestMentions(root, names)) return { present: true, version: null, how: "manifest" };
  return { present: false, version: null, how: "absent" };
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

function findTool(edition, id) {
  const list = (edition && edition.toolchain) || [];
  if (!Array.isArray(list) || !list.length) throw refuse("this edition carries no toolchain, so there is nothing to propose");
  const tool = list.find((t) => isObject(t) && t.id === id);
  if (!tool) throw refuse("no tool " + JSON.stringify(id) + " in the " + (edition.edition || "given") + " edition — it has: " + list.map((t) => t.id).join(", "));
  return tool;
}

// A tool usually installs through the project's manager. Some do not exist
// under it at all — clippy is a rustup component in a cargo project — so when
// the chosen manager offers no command and the tool offers exactly one that
// the edition recognises, that one is not a guess, it is the only door. Two
// doors and no match is a refusal, because then it would be.
function managerForTool(edition, tool, packageManager, allowed) {
  const install = tool.install;
  if (!isObject(install) || !Object.keys(install).length) throw refuse(tool.id + " carries no install commands, so jig has nothing to propose for it");
  if (nonEmptyString(install[packageManager])) return packageManager;
  const offered = Object.keys(install).filter((m) => allowed.includes(m));
  if (offered.length === 1) return offered[0];
  throw refuse(tool.id + " has no install command for " + packageManager + " (it offers: " + Object.keys(install).join(", ") +
    "). Pick a package manager it supports, or install it yourself and re-run.");
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

    // The refusal that gives this module its shape. A package install that has
    // no stated way out is not proposed at all, so `revert --all` can never
    // meet an install it has no answer for.
    let uninstallCommand = null;
    let uninstallArgv = null;
    const uninstall = isObject(tool.uninstall) ? tool.uninstall[manager] : null;
    if (tool.installKind === "package") {
      if (!nonEmptyString(uninstall)) {
        throw refuse(id + " installs as a package under " + manager + " but the edition states no uninstall for it. jig never leaves an install it cannot undo, so it will not offer this one.");
      }
      uninstallArgv = parseCommand(uninstall, id + "'s " + manager + " uninstall command");
      uninstallCommand = uninstall;
    } else if (nonEmptyString(uninstall)) {
      uninstallArgv = parseCommand(uninstall, id + "'s " + manager + " uninstall command");
      uninstallCommand = uninstall;
    }

    if (!nonEmptyString(tool.configPath) || typeof tool.configSample !== "string") {
      throw refuse(id + " carries no configPath and configSample, so the owner would be approving an install with no config to read");
    }

    // Frozen because an item is shown, approved, and only then run. Anything
    // that could edit `command` between those steps would make the approval
    // describe a command that is no longer the one about to execute.
    items.push(Object.freeze({
      id,
      role: tool.role || null,
      edition: edition.edition || null,
      installKind: tool.installKind || null,
      packageManager: manager,
      command,
      argv: Object.freeze(argv),
      configPath: tool.configPath,
      configBody: tool.configSample,
      wiring: nonEmptyString(tool.wiring) ? tool.wiring : null,
      uninstallCommand,
      uninstallArgv: uninstallArgv ? Object.freeze(uninstallArgv) : null,
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

function runArgv(root, item, argv, command, timeoutMs) {
  const run = spawnSync(argv[0], argv.slice(1), {
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
    const shim = windowsShim(argv[0]);
    if (shim) {
      // The Windows case, and the old message got it wrong: it told somebody to
      // install a tool that is already installed. `npm`, `pnpm` and `yarn` are
      // `.cmd` batch shims there, and since the 2024 argument-injection fix
      // Node refuses to start one without a shell. jig does not open a shell,
      // so this is a real limit — stated as one rather than dressed up as a
      // missing tool.
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
  const run = spawnSync(argv[0], argv.slice(1), {
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
  };
}

module.exports = {
  presence,
  pickPackageManager,
  proposeInstalls,
  runInstall,
  execVerify,
};
