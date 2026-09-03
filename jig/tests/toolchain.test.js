"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const toolchain = require("../scripts/toolchain.js");

const CATALOGUES = path.join(__dirname, "..", "catalogues");

// Every edition the shelf declares, and nothing else that happens to be a JSON
// file in the same directory. `shared.json` and the README live there too.
function shippedEditions() {
  const index = JSON.parse(fs.readFileSync(path.join(CATALOGUES, "index.json"), "utf8"));
  return index.editions.map((row) => ({
    id: row.id,
    edition: JSON.parse(fs.readFileSync(path.join(CATALOGUES, row.id + ".json"), "utf8")),
  }));
}

function edition(name) {
  return JSON.parse(fs.readFileSync(path.join(CATALOGUES, name + ".json"), "utf8"));
}

function tmpProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jig-toolchain-"));
  for (const [rel, content] of Object.entries(files || {})) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function listing(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full, prefix + name + "/");
      else out.push(prefix + name);
    }
  };
  walk(root, "");
  return out;
}

// A tool entry shaped like a v3 edition's, but pointing at the node binary
// already running this suite — the only executable a test can be sure exists.
function nodeTool(over) {
  return { id: "nodeish", role: "linter", verify: { argv: [process.execPath, "--version"], expectedExit: 0 }, ...over };
}

// ---------------------------------------------------------------------------
// presence
// ---------------------------------------------------------------------------

test("presence probes the tool's own executable and reports its version", () => {
  const root = tmpProject({});
  const found = toolchain.presence(root, nodeTool());
  assert.equal(found.present, true);
  assert.equal(found.how, "probe");
  assert.equal(found.version, process.versions.node);
});

test("presence falls back to the manifest when the binary is absent", () => {
  const root = tmpProject({ "package.json": JSON.stringify({ devDependencies: { "jig-fake-linter": "^1.0.0" } }) });
  const found = toolchain.presence(root, nodeTool({ id: "jig-fake-linter", verify: { argv: ["jig-fake-linter-binary-absent"], expectedExit: 1 } }));
  assert.deepEqual(found, { present: true, version: null, how: "manifest" });
});

test("presence reads a config section as configuration, not as a dependency", () => {
  const root = tmpProject({ "pyproject.toml": "[tool.ruff]\nline-length = 100\n" });
  const found = toolchain.presence(root, { id: "ruff", verify: { argv: ["jig-absent-ruff-binary"], expectedExit: 1 } });
  assert.equal(found.present, false);
});

test("presence never throws on absence", () => {
  const root = tmpProject({});
  assert.deepEqual(
    toolchain.presence(root, nodeTool({ id: "nothing-here", verify: { argv: ["jig-absent-binary-xyz"], expectedExit: 1 } })),
    { present: false, version: null, how: "absent" },
  );
});

test("presence refuses a tool entry with no verify.argv", () => {
  const root = tmpProject({});
  assert.throws(() => toolchain.presence(root, { id: "broken" }), /verify\.argv/);
});

test("presence writes nothing", () => {
  const root = tmpProject({ "package.json": "{}" });
  const before = listing(root);
  toolchain.presence(root, nodeTool());
  toolchain.presence(root, nodeTool({ verify: { argv: ["jig-absent-binary-xyz"], expectedExit: 1 } }));
  assert.deepEqual(listing(root), before);
});

// ---------------------------------------------------------------------------
// pickPackageManager
// ---------------------------------------------------------------------------

test("a lockfile outranks what the manifest declares", () => {
  const root = tmpProject({
    "package.json": JSON.stringify({ packageManager: "npm@10.0.0" }),
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
  });
  assert.equal(toolchain.pickPackageManager(root, edition("javascript-typescript")), "pnpm");
});

test("two lockfiles are never guessed between", () => {
  const root = tmpProject({ "package-lock.json": "{}", "yarn.lock": "" });
  assert.equal(toolchain.pickPackageManager(root, edition("javascript-typescript")), null);
});

test("a lockfile from another ecosystem does not muddy this edition's answer", () => {
  const root = tmpProject({ "package-lock.json": "{}", "Cargo.lock": "version = 4\n" });
  assert.equal(toolchain.pickPackageManager(root, edition("rust")), "cargo");
});

test("the manifest decides when no lockfile has been written yet", () => {
  const root = tmpProject({ "pyproject.toml": "[tool.poetry]\nname = \"app\"\n" });
  assert.equal(toolchain.pickPackageManager(root, edition("python")), "poetry");
});

test("no signal at all means ask the owner", () => {
  const root = tmpProject({ "requirements.txt": "httpx==0.28.1\n" });
  assert.equal(toolchain.pickPackageManager(root, edition("python")), null);
});

test("two declarations in one manifest also mean ask the owner", () => {
  const root = tmpProject({ "pyproject.toml": "[tool.poetry]\nname = \"app\"\n\n[tool.pdm]\ndistribution = true\n" });
  assert.equal(toolchain.pickPackageManager(root, edition("python")), null);
});

// ---------------------------------------------------------------------------
// proposeInstalls
// ---------------------------------------------------------------------------

test("an item carries the command, the config, the wiring and the way back out", () => {
  const root = tmpProject({});
  const [item] = toolchain.proposeInstalls(root, edition("python"), ["ruff"], "pip");
  assert.equal(item.id, "ruff");
  assert.equal(item.installKind, "package");
  assert.equal(item.packageManager, "pip");
  assert.equal(item.command, "python -m pip install ruff");
  assert.deepEqual([...item.argv], ["python", "-m", "pip", "install", "ruff"]);
  assert.equal(item.configPath, "pyproject.toml");
  assert.match(item.configBody, /\[tool\.ruff\]/);
  assert.match(item.wiring, /ruff check/);
  assert.equal(item.uninstallCommand, "python -m pip uninstall -y ruff");
  assert.deepEqual([...item.uninstallArgv], ["python", "-m", "pip", "uninstall", "-y", "ruff"]);
});

test("an item carries the tool's CI step, so the route that only configures a tool keeps it", () => {
  const root = tmpProject({});
  const [item] = toolchain.proposeInstalls(root, edition("javascript-typescript"), ["eslint"], "npm");
  assert.equal(item.ciStep, "npm run lint");
  // Every shipped tool states one, so the field is never absent on an item —
  // a reader can tell "no CI step" from "this item does not carry them".
  for (const row of shippedEditions()) {
    for (const tool of row.edition.toolchain || []) {
      const manager = Object.keys(tool.install || {})[0];
      if (!manager || !(row.edition.detect.packageManagers || []).includes(manager)) continue;
      let proposed;
      try {
        proposed = toolchain.proposeInstalls(root, row.edition, [tool.id], manager)[0];
      } catch { continue; } // a tool jig refuses to offer has its own gate above
      assert.equal(typeof proposed.ciStep, "string", row.id + "/" + tool.id + " reached an item with no CI step");
    }
  }
});

test("an item is frozen, so nothing can edit the command between approval and run", () => {
  const root = tmpProject({});
  const [item] = toolchain.proposeInstalls(root, edition("python"), ["ruff"], "pip");
  assert.throws(() => { item.command = "curl evil"; }, TypeError);
  assert.throws(() => { item.argv[0] = "curl"; }, TypeError);
});

test("a tool with one door under a different manager takes that door", () => {
  const root = tmpProject({});
  const [item] = toolchain.proposeInstalls(root, edition("rust"), ["clippy"], "cargo");
  assert.equal(item.packageManager, "rustup");
  assert.equal(item.command, "rustup component add clippy");
});

test("a command carrying shell syntax is refused rather than quoted around", () => {
  const root = tmpProject({});
  // Synthetic on purpose: no shipped edition may carry one of these, and the
  // gate above proves it. This holds the refusal itself.
  const shelly = {
    edition: "synthetic",
    detect: { packageManagers: ["go"] },
    toolchain: [{
      id: "shelly", role: "linter", installKind: "package",
      install: { go: "go install example.com/shelly@latest" },
      uninstall: { go: 'rm -f "$(go env GOPATH)/bin/shelly"' },
      configPath: ".shellyrc", configSample: "{}\n",
      verify: { argv: ["shelly", "--version"], expected: "prints a version", expectedExit: 0 },
    }],
  };
  assert.throws(
    () => toolchain.proposeInstalls(root, shelly, ["shelly"], "go"),
    (err) => err.expected === true && /without a shell/.test(err.message) && /uninstall command/.test(err.message),
  );
});

test("a package install with no uninstall is refused before the owner ever sees it", () => {
  const root = tmpProject({});
  const synthetic = {
    edition: "synthetic",
    detect: { packageManagers: ["npm"] },
    toolchain: [{ id: "oneway", role: "linter", installKind: "package", install: { npm: "npm install --save-dev oneway" }, configPath: ".onewayrc", configSample: "{}\n" }],
  };
  assert.throws(
    () => toolchain.proposeInstalls(root, synthetic, ["oneway"], "npm"),
    (err) => err.expected === true && /never leaves an install it cannot undo/.test(err.message),
  );
});

// The refusal reads the install, not the label on it. A kind the engine does
// not recognise is a claim about where the bytes land that jig cannot check, so
// it gets the same answer a package does.
test("an install of an unrecognised kind with no uninstall is refused too", () => {
  const root = tmpProject({});
  const synthetic = {
    edition: "synthetic",
    detect: { packageManagers: ["npm"] },
    toolchain: [{ id: "mislabelled", role: "build", installKind: "bootstrap", install: { npm: "npm exec mislabelled" }, configPath: ".mislabelledrc", configSample: "{}\n" }],
  };
  assert.throws(
    () => toolchain.proposeInstalls(root, synthetic, ["mislabelled"], "npm"),
    (err) => err.expected === true && /never leaves an install it cannot undo/.test(err.message) &&
      /"bootstrap"/.test(err.message),
  );
});

// And the kinds whose whole effect lands inside the project root keep being
// offered without one: the journal is their way back out. The membership is
// pinned here rather than one sample kind, because `installKind === "package"`
// — the predicate this replaced — already let `scaffold` through, so a test
// that only asserted `scaffold` proved nothing about the change.
const oneTool = (installKind, command) => ({
  edition: "synthetic",
  detect: { packageManagers: ["npm"] },
  toolchain: [{ id: "wrapperish", role: "build", installKind, install: { npm: command },
    configPath: ".wrapperishrc", configSample: "{}\n" }],
});

test("exactly the journal-reversible kinds are offered without an uninstall", () => {
  const root = tmpProject({});
  assert.deepEqual([...toolchain.JOURNAL_REVERSIBLE_KINDS].sort(), ["audit", "builtin", "scaffold"]);
  for (const kind of toolchain.JOURNAL_REVERSIBLE_KINDS) {
    const [item] = toolchain.proposeInstalls(root, oneTool(kind, "npm exec wrapperish"), ["wrapperish"], "npm");
    assert.equal(item.uninstallCommand, null, kind + " was refused for want of an uninstall");
  }
  for (const kind of ["package", "bootstrap"]) {
    assert.throws(() => toolchain.proposeInstalls(root, oneTool(kind, "npm exec wrapperish"), ["wrapperish"], "npm"),
      (err) => err.expected === true && /never leaves an install it cannot undo/.test(err.message),
      kind + " was offered with no way back out");
  }
});

// The kind is a claim, and the command is the fact. A row saying `builtin` and
// then installing a toolchain into ~/.rustup was an install jig could not undo,
// offered under the kind that says it needs no undoing.
test("a journal-reversible kind whose command leaves the project root is refused anyway", () => {
  const root = tmpProject({});
  for (const command of ["rustup toolchain install stable --profile default",
    "dotnet nuget add source https://example.invalid/v3/index.json -n example",
    "npm install -g wrapperish"]) {
    assert.equal(toolchain.escapesRoot(command), true, command);
    assert.throws(() => toolchain.proposeInstalls(root, oneTool("builtin", command), ["wrapperish"], "npm"),
      (err) => err.expected === true && /writes outside the project root/.test(err.message),
      command + " was offered with no way back out");
  }
  // And with a way out stated it is offered, like any other install that has one.
  const withExit = oneTool("builtin", "rustup toolchain install stable");
  withExit.toolchain[0].uninstall = { npm: "rustup toolchain uninstall stable" };
  const [item] = toolchain.proposeInstalls(root, withExit, ["wrapperish"], "npm");
  assert.equal(item.uninstallCommand, "rustup toolchain uninstall stable");
  // A command that stays inside the root is not caught by the reading.
  assert.equal(toolchain.escapesRoot("dotnet new globaljson --sdk-version 9.0.100"), false);
  assert.equal(toolchain.escapesRoot("gradle wrapper --gradle-version 9.1.0"), false);
});

// Release gate G8. The catalogue is held to the same reading: a shipped row
// whose install reaches past the project root has to state the way back out,
// whatever kind it claims to be.
test("release gate G8: no shipped install leaves the project root with no way back", () => {
  for (const row of shippedEditions()) {
    for (const tool of row.edition.toolchain) {
      for (const [manager, command] of Object.entries(tool.install || {})) {
        if (!toolchain.escapesRoot(command)) continue;
        const exit = (tool.uninstall || {})[manager];
        assert.equal(typeof exit === "string" && exit !== "", true,
          row.id + "/" + tool.id + " installs under " + manager + " by running `" + command +
          "`, which writes outside the project root, and states no uninstall for it");
      }
    }
  }
});

test("an unknown tool id names what the edition actually has", () => {
  const root = tmpProject({});
  assert.throws(() => toolchain.proposeInstalls(root, edition("python"), ["blackish"], "pip"), /it has: ruff/);
});

test("a package manager the edition does not use is refused", () => {
  const root = tmpProject({});
  assert.throws(() => toolchain.proposeInstalls(root, edition("python"), ["ruff"], "npm"), /not a package manager of the python edition/);
});

test("no chosen package manager means the owner is asked, not defaulted for", () => {
  const root = tmpProject({});
  assert.throws(() => toolchain.proposeInstalls(root, edition("python"), ["ruff"], null), /the owner has to say which of pip, uv, poetry, pdm/);
});

// The engine proposes one tool at a time and collects a per-tool refusal, so a
// tool jig cannot offer costs the owner that tool and nothing else. What this
// gate holds is the pair of properties that makes that safe: every refusal is
// an `expected` error naming the tool and its reason, so nothing is ever
// dropped silently, and the set of tools jig cannot offer is exactly the set
// somebody wrote down.
//
// Go's three installed tools are that set. `go install` puts a binary in
// GOPATH/bin and Go ships no uninstall verb; removing it means expanding
// `go env GOPATH`, which needs a shell, and jig never uses one. `go clean -i`
// is not a substitute — it cleans packages of the current module, and a tool
// installed with `pkg@latest` is not one. So the honest answer is a refusal
// with that reason, and the three Go builtins are still offered.
const CANNOT_BE_OFFERED = ["go/gofumpt", "go/golangci-lint", "go/govulncheck"];

test("a tool jig cannot offer is refused by name, and never silently dropped", () => {
  const refused = [];
  const root = tmpProject({});
  for (const row of shippedEditions()) {
    const ed = row.edition;
    for (const manager of ed.detect.packageManagers) {
      for (const tool of ed.toolchain) {
        try {
          const [item] = toolchain.proposeInstalls(root, ed, [tool.id], manager);
          assert.ok(item.argv.length > 0);
          assert.equal(typeof item.configBody, "string");
        } catch (err) {
          assert.equal(err.expected, true, tool.id + " under " + manager + ": " + err.message);
          assert.ok(err.message.includes(tool.id), "a refusal that does not name its tool: " + err.message);
          refused.push(ed.edition + "/" + tool.id);
        }
      }
    }
  }
  assert.deepEqual([...new Set(refused)].sort(), CANNOT_BE_OFFERED);
});

// SCOPE, "May jig scaffold jvm and dotnet": by writing a starter itself, NOT by
// running a generator, because a generator creates a tree nobody listed. These
// are the project generators the shelf reached for; `dotnet new globaljson` and
// `dotnet new editorconfig` are not on the list because each writes one named
// file, not a project.
const PROJECT_GENERATORS = [/\bdotnet new (?!globaljson|editorconfig)/, /\bgradle init\b/, /\bcargo (new|init)\b/, /\bnpm init\b/];

test("no shipped install command generates a project tree", () => {
  for (const row of shippedEditions()) {
    for (const tool of row.edition.toolchain) {
      for (const [manager, command] of Object.entries(tool.install || {})) {
        for (const pattern of PROJECT_GENERATORS) {
          assert.equal(pattern.test(command), false,
            row.id + "/" + tool.id + " installs under " + manager + " by running a generator: " + command);
        }
      }
    }
  }
});

// The half that replaced it: the dotnet test project is bytes the plan names.
test("the dotnet edition writes its test project instead of generating one", () => {
  const dotnet = shippedEditions().find((row) => row.id === "dotnet").edition;
  const starter = dotnet.detect.manifest.starter.files.map((f) => f.path);
  assert.deepEqual(starter.sort(), ["App.sln", "tests/App.Tests.csproj", "tests/SmokeTests.cs"]);
  const csproj = dotnet.detect.manifest.starter.files.find((f) => f.path === "tests/App.Tests.csproj").body;
  assert.match(csproj, /PackageReference Include="xunit"/);
  // And the project file at the root must not compile them itself, or a
  // starter's first build fails on a library that never referenced xunit.
  assert.match(dotnet.detect.manifest.sample, /<Compile Remove="tests\/\*\*" \/>/);
  // The solution is what makes the test project reachable at all: `dotnet test`
  // beside a lone `App.csproj` resolves that one project, runs nothing and
  // exits 0 — with TreatNoTestsAsError set, on the tree jig just wrote.
  const sln = dotnet.detect.manifest.starter.files.find((f) => f.path === "App.sln").body;
  assert.match(sln, /"App\.csproj"/);
  assert.match(sln, /App\.Tests\.csproj/);
});

test("an edition whose install jig cannot offer still offers everything else it has", () => {
  const root = tmpProject({});
  const go = shippedEditions().find((row) => row.id === "go").edition;
  const offered = [];
  for (const tool of go.toolchain) {
    try {
      offered.push(toolchain.proposeInstalls(root, go, [tool.id], "go")[0].id);
    } catch (err) {
      assert.equal(err.expected, true);
    }
  }
  assert.deepEqual(offered.sort(), ["go-build", "go-test", "go-vet"],
    "one unusable row took the whole edition's proposal down with it");
});

test("proposeInstalls writes nothing and runs nothing", () => {
  const root = tmpProject({ "pyproject.toml": "[project]\nname = \"app\"\n" });
  const before = listing(root);
  toolchain.proposeInstalls(root, edition("python"), ["ruff", "mypy", "pytest"], "uv");
  assert.deepEqual(listing(root), before);
});

// ---------------------------------------------------------------------------
// runInstall
// ---------------------------------------------------------------------------

const SCRIPTS = {
  "ok.js": "process.stdout.write('installed\\n');\n",
  "fail.js": "require('fs').appendFileSync('runs.log', 'ran\\n');\nprocess.stderr.write('E404 no such package\\n');\nprocess.exit(3);\n",
  "sleep.js": "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);\n",
};

function runnableItem(over) {
  return {
    id: "faketool",
    command: "node ok.js",
    argv: [process.execPath, "ok.js"],
    uninstallCommand: "node fail.js",
    uninstallArgv: [process.execPath, "fail.js"],
    timeoutMs: 20000,
    ...over,
  };
}

test("runInstall refuses without an approval record", () => {
  const root = tmpProject(SCRIPTS);
  const item = runnableItem();
  assert.throws(() => toolchain.runInstall(root, item, undefined), /no approval record/);
  assert.throws(() => toolchain.runInstall(root, item, {}), /the approval names undefined instead/);
  assert.deepEqual(listing(root), Object.keys(SCRIPTS).sort());
});

test("runInstall refuses an approval naming another item", () => {
  const root = tmpProject(SCRIPTS);
  assert.throws(
    () => toolchain.runInstall(root, runnableItem(), { id: "othertool", command: "node ok.js" }),
    /the approval names "othertool" instead/,
  );
});

test("runInstall refuses an approval whose command differs by one character", () => {
  const root = tmpProject(SCRIPTS);
  assert.throws(
    () => toolchain.runInstall(root, runnableItem(), { id: "faketool", command: "node ok.js " }),
    /the approval names a different command/,
  );
});

test("there is no force flag", () => {
  const root = tmpProject(SCRIPTS);
  assert.throws(
    () => toolchain.runInstall(root, runnableItem(), { id: "faketool", command: "node other.js", force: true, approved: true }),
    /a different command/,
  );
});

test("runInstall runs the approved command and reports its exit code", () => {
  const root = tmpProject(SCRIPTS);
  const item = runnableItem();
  const result = toolchain.runInstall(root, item, { id: item.id, command: item.command });
  assert.deepEqual({ ran: result.ran, code: result.code, timedOut: result.timedOut }, { ran: true, code: 0, timedOut: false });
  assert.match(result.stdout, /installed/);
});

test("a non-zero exit is reported once, never retried", () => {
  const root = tmpProject(SCRIPTS);
  const item = runnableItem({ command: "node fail.js", argv: [process.execPath, "fail.js"] });
  const result = toolchain.runInstall(root, item, { id: item.id, command: item.command });
  assert.equal(result.code, 3);
  assert.equal(result.ran, true);
  assert.match(result.stderr, /E404/);
  assert.equal(fs.readFileSync(path.join(root, "runs.log"), "utf8"), "ran\n");
});

test("a command that will not end is cut off and says so", () => {
  const root = tmpProject(SCRIPTS);
  const item = runnableItem({ command: "node sleep.js", argv: [process.execPath, "sleep.js"], timeoutMs: 300 });
  const result = toolchain.runInstall(root, item, { id: item.id, command: item.command });
  assert.equal(result.timedOut, true);
  assert.equal(result.ran, true);
});

test("a package manager that is not on the machine is an error a human can act on", () => {
  const root = tmpProject(SCRIPTS);
  const item = runnableItem({ command: "jig-absent-manager install x", argv: ["jig-absent-manager", "install", "x"] });
  assert.throws(
    () => toolchain.runInstall(root, item, { id: item.id, command: item.command }),
    /could not run "jig-absent-manager".*Install jig-absent-manager and re-run/s,
  );
});

// ---------------------------------------------------------------------------
// DERAIL-PASS defect 16 — the shim on the owner's own platform
// ---------------------------------------------------------------------------
//
// Windows + fnm: every JS install exited 1 because `npm` is a `.cmd` and jig
// opens no shell. The managers are Node programs, so jig can be the node the
// shim would have found — and nothing else is rewritten, because a batch file
// with no JS behind it still needs cmd.exe (SCOPE, the derail pass).

// A shim directory laid out the way npm, pnpm and yarn lay theirs out: the
// `.cmd` beside the `node_modules` copy it would have handed to node.
function shimDir(name, entryRel) {
  const dir = tmpProject({});
  fs.writeFileSync(path.join(dir, name + ".cmd"), "@echo off\r\n");
  const entry = path.join(dir, ...entryRel.split("/"));
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "process.stdout.write('cli\\n');\n");
  return { dir, entry };
}

function withPath(dir, fn) {
  const had = process.env.PATH;
  process.env.PATH = dir;
  try { return fn(); } finally { process.env.PATH = had; }
}

test("a manager behind a batch shim is run through its own JS entry, never through a shell", { skip: process.platform !== "win32" }, () => {
  for (const [name, rel] of Object.entries({
    npm: "node_modules/npm/bin/npm-cli.js",
    npx: "node_modules/npm/bin/npx-cli.js",
    pnpm: "node_modules/pnpm/bin/pnpm.cjs",
    yarn: "node_modules/yarn/bin/yarn.js",
  })) {
    const { dir, entry } = shimDir(name, rel);
    const argv = withPath(dir, () => toolchain.shellFreeArgv([name, "install", "--save-dev", "x"]));
    assert.deepEqual(argv, [process.execPath, entry, "install", "--save-dev", "x"],
      name + " still routes through its batch shim");
  }
});

test("only the managers with a JS entry are rewritten — nothing else gets a route", { skip: process.platform !== "win32" }, () => {
  // A shim with no JS beside it is still a shim, and the refusal stands.
  const bare = tmpProject({});
  fs.writeFileSync(path.join(bare, "npm.cmd"), "@echo off\r\n");
  assert.equal(withPath(bare, () => toolchain.shellFreeArgv(["npm", "install"])), null);
  // And a manager that is not one of the three is never guessed at.
  const { dir } = shimDir("gradle", "node_modules/npm/bin/npm-cli.js");
  assert.equal(withPath(dir, () => toolchain.shellFreeArgv(["gradle", "wrapper"])), null);
});

test("nothing is rewritten off Windows: npm there is a script node already runs", { skip: process.platform === "win32" }, () => {
  assert.equal(toolchain.shellFreeArgv(["npm", "install", "x"]), null);
});

test("the Gradle wrapper on win32 is refused with the batch line to run by hand", { skip: process.platform !== "win32" }, () => {
  const root = tmpProject(SCRIPTS);
  const item = runnableItem({ command: "./gradlew --no-daemon check", argv: ["./gradlew", "--no-daemon", "check"] });
  assert.throws(
    () => toolchain.runInstall(root, item, { id: item.id, command: item.command }),
    (err) => {
      assert.equal(err.expected, true);
      assert.match(err.message, /only\s+cmd\.exe can start/);
      assert.match(err.message, /gradlew\.bat --no-daemon check/);
      assert.doesNotMatch(err.message, /Install \.\/gradlew and re-run/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// execVerify
// ---------------------------------------------------------------------------

const VERIFY_SCRIPT = "const fs = require('fs');\n" +
  "process.stdout.write('Found 1 error. caught the seeded violation\\n');\n" +
  "process.exit(fs.existsSync('proof/pkg/seed.txt') ? 1 : 0);\n";

function seededTool(over) {
  return {
    id: "seeded",
    verify: { argv: [process.execPath, "verify.js"], expectedExit: 1 },
    seed: { path: "pkg/seed.txt", sample: "boom\n" },
    ...over,
  };
}

test("execVerify plants the seed under the caller's directory and matches on the exit code", () => {
  const root = tmpProject({ "verify.js": VERIFY_SCRIPT });
  const result = toolchain.execVerify(root, seededTool(), "proof");
  assert.deepEqual(result, { ran: true, code: 1, caught: true, expectedExit: 1,
    output: "Found 1 error. caught the seeded violation" });
  assert.equal(fs.readFileSync(path.join(root, "proof", "pkg", "seed.txt"), "utf8"), "boom\n");
});

test("a matching stdout is not a proof — only the exit code is", () => {
  const root = tmpProject({ "verify.js": VERIFY_SCRIPT });
  const result = toolchain.execVerify(root, seededTool({ verify: { argv: [process.execPath, "verify.js"], expectedExit: 101 } }), "proof");
  assert.equal(result.code, 1);
  assert.equal(result.caught, false);
  assert.match(fs.readFileSync(path.join(root, "proof", "pkg", "seed.txt"), "utf8"), /boom/);
});

test("expectedExit may name several codes", () => {
  const root = tmpProject({ "verify.js": VERIFY_SCRIPT });
  const result = toolchain.execVerify(root, seededTool({ verify: { argv: [process.execPath, "verify.js"], expectedExit: [1, 5] } }), "proof");
  assert.deepEqual(result, { ran: true, code: 1, caught: true, expectedExit: [1, 5],
    output: "Found 1 error. caught the seeded violation" });
});

test("execVerify never writes over a file that is already there", () => {
  const root = tmpProject({ "verify.js": VERIFY_SCRIPT, "proof/pkg/seed.txt": "the owner's file\n" });
  assert.throws(() => toolchain.execVerify(root, seededTool(), "proof"), /will not write over it/);
  assert.equal(fs.readFileSync(path.join(root, "proof", "pkg", "seed.txt"), "utf8"), "the owner's file\n");
});

test("a seed directory outside the project is refused", () => {
  const root = tmpProject({ "verify.js": VERIFY_SCRIPT });
  assert.throws(() => toolchain.execVerify(root, seededTool(), "../escaped"), /escapes its directory/);
});

test("a seed path that climbs out of the seed directory is refused", () => {
  const root = tmpProject({ "verify.js": VERIFY_SCRIPT });
  assert.throws(() => toolchain.execVerify(root, seededTool({ seed: { path: "../../outside.txt", sample: "x" } }), "proof"), /escapes its directory/);
});

test("execVerify refuses a tool with prose instead of a machine-readable exit code", () => {
  const root = tmpProject({ "verify.js": VERIFY_SCRIPT });
  assert.throws(
    () => toolchain.execVerify(root, seededTool({ verify: { argv: [process.execPath, "verify.js"], expected: "exit code 1, probably" } }), "proof"),
    /not machine-readable/,
  );
});

test("execVerify refuses a tool with no seed to plant", () => {
  const root = tmpProject({ "verify.js": VERIFY_SCRIPT });
  assert.throws(() => toolchain.execVerify(root, seededTool({ seed: undefined }), "proof"), /has no seed to plant/);
});

test("every shipped edition carries a seed and an exit code execVerify can read", () => {
  const root = tmpProject({});
  for (const row of shippedEditions()) {
    const ed = row.edition;
    for (const tool of ed.toolchain) {
      // The executable is absent in a temp project, so the run itself must be
      // the only thing that fails — never the shape checks ahead of it.
      assert.throws(
        () => toolchain.execVerify(root, { ...tool, verify: { ...tool.verify, argv: ["jig-absent-" + tool.id] } }, "proof-" + ed.edition + "-" + tool.id),
        /could not run/,
        ed.edition + "/" + tool.id,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// execBaseline, and the probe that puts it in front of the seeded run
// ---------------------------------------------------------------------------

test("execBaseline runs the same argv with nothing planted and reports a clean tree", () => {
  const root = tmpProject({ "verify.js": VERIFY_SCRIPT });
  assert.deepEqual(toolchain.execBaseline(root, seededTool()),
    { ran: true, code: 0, timedOut: false, baseline: "clean" });
  // Nothing planted means nothing planted: a baseline that seeded the tree
  // would be the seeded run under another name.
  assert.deepEqual(listing(root), ["verify.js"]);
});

test("a repository already failing its own linter is disclosed as red, not counted as a catch", () => {
  const root = tmpProject({ "verify.js": VERIFY_SCRIPT, "proof/pkg/seed.txt": "already broken\n" });
  const baseline = toolchain.execBaseline(root, seededTool());
  assert.equal(baseline.baseline, "red");
  assert.equal(baseline.code, 1);
});

test("execBaseline refuses rather than reporting a clean tree it never saw", () => {
  const root = tmpProject({});
  assert.throws(() => toolchain.execBaseline(root, seededTool({ verify: { argv: ["jig-absent-tool"], expectedExit: 1 } })),
    /could not run "jig-absent-tool" to take seeded's baseline/);
});

// The probe plants at the path the edition states, at the project root, so the
// stand-in tool looks there — the same place a real linter looks when it walks
// the tree its own config points it at. Nested under `.jig/` it was outside
// every shipped config's reach and no tool ever saw a seed.
const PROBE_SCRIPT = "const fs = require('fs');\n" +
  "process.exit(fs.existsSync('pkg/seed.txt') ? 1 : 0);\n";

// The whole point of roadmap 207: the close spawns the tool instead of telling
// the owner to.
test("a toolchain probe runs the tool over a journaled seed and comes back verified", () => {
  const root = tmpProject({ "verify.js": PROBE_SCRIPT });
  const probe = engine.execToolchainProbe(root, seededTool(), { probe: "toolchain-seeded", kind: "toolchain" });
  assert.equal(probe.ran, true);
  assert.equal(probe.caught, true);
  assert.equal(probe.verdict, "verified");
  assert.equal(probe.code, 1);
  assert.equal(probe.baseline, "clean");
  assert.equal(probe.baselineExit, 0);

  // The seed is gone — the file and the directory the planting made for it —
  // and the journal holds both halves of its life.
  assert.deepEqual(listing(root).filter((f) => !f.startsWith(".jig/")), ["verify.js"]);
  const rows = fs.readFileSync(path.join(root, ".jig", "journal.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.event), ["seed", "seed-removed"]);
  for (const row of rows) {
    assert.equal(row.tool, "seeded");
    assert.equal(row.path, "pkg/seed.txt");
  }
  // A seed row names no change, so the transaction replay never sees it as a
  // write anybody has to undo.
  assert.equal(rows.some((r) => r.change), false);
});

// SCOPE step 8: a repository that was already failing its own linter is
// disclosed as `baseline: red` rather than counted as a catch. The seeded run
// exits non-zero there for the reason the baseline did, and the seed proved
// nothing at all.
test("a catch over a red baseline is not a verified tool", () => {
  // The stand-in fails on anything under `pkg/` at all, so this tree is red
  // before jig plants a thing and stays red for the same reason afterwards.
  const root = tmpProject({
    "verify.js": "const fs = require('fs');\nprocess.exit(fs.existsSync('pkg') ? 1 : 0);\n",
    "pkg/already.txt": "",
  });
  const probe = engine.execToolchainProbe(root, seededTool(), { probe: "toolchain-seeded", kind: "toolchain" });
  assert.equal(probe.baseline, "red");
  assert.equal(probe.caught, true, "the exit code is still the fact it always was");
  assert.equal(probe.verdict, "unverified",
    "a tool ledgered `verified` off a tree that was red before the seed landed");
});

test("a tool that misses its own seed comes back unverified, never silently passed", () => {
  const root = tmpProject({ "verify.js": "process.exit(0);\n" });
  const probe = engine.execToolchainProbe(root, seededTool(), { probe: "toolchain-seeded", kind: "toolchain" });
  assert.equal(probe.ran, true);
  assert.equal(probe.caught, false);
  assert.equal(probe.verdict, "unverified");
  assert.equal(fs.existsSync(path.join(root, ".jig", "selftest")), false);
});

// Roadmap 228: an `unverified` verdict told the owner their config failed its
// demonstration and handed them nothing to read. The guard probes print their
// runner's stdout verbatim; a toolchain probe owes the same transcript.
test("a probe carries the tool's own output, on both streams", () => {
  const root = tmpProject({
    "verify.js": "process.stderr.write('seed.txt:1 no-boom\\n');\nprocess.stdout.write('1 problem\\n');\nprocess.exit(0);\n",
  });
  const probe = engine.execToolchainProbe(root, seededTool(), { probe: "toolchain-seeded", kind: "toolchain" });
  assert.equal(probe.verdict, "unverified");
  assert.match(probe.output, /seed\.txt:1 no-boom/, "the owner was told the config failed with nothing to read");
  assert.match(probe.output, /1 problem/);
});

// The close report reads this out loud, so a tool that spilled a whole tree's
// diagnostics into it would bury the rest of the close.
test("a probe's output is capped, and says that it was", () => {
  const root = tmpProject({
    "verify.js": "process.stdout.write('x'.repeat(9000));\nprocess.exit(1);\n",
  });
  const probe = engine.execToolchainProbe(root, seededTool(), { probe: "toolchain-seeded", kind: "toolchain" });
  assert.equal(probe.output.length < 9000, true, "a linter's whole transcript went into the close report uncapped");
  assert.match(probe.output, /truncated at 4000 characters$/);
});

// DERAIL-PASS defect 13, the Windows half: `npx` is a batch shim there and jig
// opens no shell, so it cannot be started at all. A close that skipped it would
// be reporting a pass for a proof nobody ran.
test("a batch-shim argv is `cannot run` with the command printed, never skipped as a pass", () => {
  const root = tmpProject({});
  const probe = engine.execToolchainProbe(root, seededTool({ verify: { argv: ["jig-absent-tool.cmd"], expectedExit: 1 } }),
    { probe: "toolchain-seeded", kind: "toolchain", command: "jig-absent-tool.cmd" });
  assert.equal(probe.ran, false);
  assert.equal(probe.cannotRun, true);
  assert.equal(probe.caught, undefined, "a tool that never started was reported as having caught something");
  assert.equal(probe.command, "jig-absent-tool.cmd", "the probe dropped the command the owner has to run by hand");
  if (process.platform === "win32") assert.match(probe.why, /Windows batch shim/);
});

test("a tool jig cannot start is `cannot run`, and no seed is left behind for it", () => {
  const root = tmpProject({});
  const probe = engine.execToolchainProbe(root, seededTool({ verify: { argv: ["jig-absent-tool"], expectedExit: 1 } }),
    { probe: "toolchain-seeded", kind: "toolchain", command: "jig-absent-tool" });
  assert.equal(probe.ran, false);
  assert.equal(probe.cannotRun, true);
  assert.equal(probe.caught, undefined, "a tool that never ran was reported as having caught something");
  assert.match(probe.why, /could not run/);
  assert.equal(fs.existsSync(path.join(root, ".jig", "selftest")), false);
});

// `execVerify` decides a catch on the exit code alone: `caught` is true when the
// run's status is one of `expectedExit`. A tool that declares 0 therefore
// "catches" its planted seed on every run, including the runs where it saw
// nothing — a proof that cannot fail, which is the one thing jig may never
// ship. One tool cannot do better, and it is named here with its reason so that
// a seventh cannot join it quietly.
const CANNOT_WITNESS = {
  "go/gofumpt": "gofumpt has no check mode. `gofumpt -l .` reports unformatted files on stdout and " +
    "exits 0 either way, and the idiomatic CI form wraps it in `test -z \"$(…)\"`, which needs a " +
    "shell jig will not use. The formatting catch is witnessed by golangci-lint's `fmt` instead.",
};

test("no shipped tool declares a catch it would report as success", () => {
  const vacuous = [];
  for (const row of shippedEditions()) {
    for (const tool of row.edition.toolchain) {
      const expected = tool.verify.expectedExit;
      const codes = Array.isArray(expected) ? expected : [expected];
      assert.ok(codes.length > 0, row.id + "/" + tool.id + " declares no expectedExit");
      if (codes.includes(0)) vacuous.push(row.id + "/" + tool.id);
    }
  }
  assert.deepEqual(vacuous.sort(), Object.keys(CANNOT_WITNESS).sort(),
    "a tool whose catch is exit 0 proves nothing — fix it, or name it in CANNOT_WITNESS with why");
});

// ---------------------------------------------------------------------------
// The lane entries
// ---------------------------------------------------------------------------
//
// DERAIL-PASS defect 15: `ciStep` was carried by all 37 tools and read by
// nothing, so a ticked linter ran in no lane at all. The entries below are what
// a lane runs, and every claim about them is mechanical: the argv is the tool's
// own, the expected exit is the one a CLEAN run has rather than the one a catch
// has, and the parser is the installer's — no shell, either side.

const engine = require("../scripts/jig.js");

function tickedRow(id, role, ed) {
  return { item: { id, role, edition: ed || "javascript-typescript" } };
}

test("parseCommand is exported, so an install and a lane entry meet one parser", () => {
  assert.deepEqual(toolchain.parseCommand("npx eslint .", "x"), ["npx", "eslint", "."]);
  assert.throws(() => toolchain.parseCommand("eslint . && tsc", "the lane entry"),
    /contains the shell character/);
});

test("a lane entry carries the tool's own argv and the exit code a clean run has", () => {
  const js = edition("javascript-typescript");
  const { entries } = engine.verifyEntriesFor([js], [tickedRow("eslint", "linter")], ["ci"], null);
  assert.deepEqual(entries.length, 1);
  const row = entries[0];
  assert.equal(row.id, "eslint");
  const tool = js.toolchain.find((t) => t.id === "eslint");
  assert.deepEqual(row.argv, tool.verify.argv);
  // The tool's own expectedExit is the code that means CAUGHT over a planted
  // violation. A lane wants the tool clean, which is 0 — the two are different
  // questions and this is the one the lane asks.
  assert.equal(tool.verify.expectedExit, 1);
  assert.equal(row.expectedExit, 0);
  assert.deepEqual(row.lanes, ["ci"]);
  assert.ok(row.paths.includes("**/*.ts"), "the entry does not say which files the tool speaks for");
});

test("every shipped tool's verify argv survives the no-shell parser", () => {
  // The lane can only run what `parseCommand` accepts, so a tool whose verify
  // command needs a shell would be a tool the matrix must never call covered.
  for (const row of shippedEditions()) {
    const items = row.edition.toolchain.map((t) => tickedRow(t.id, t.role, row.edition.edition));
    const { entries, refused } = engine.verifyEntriesFor([row.edition], items, ["ci"], null);
    assert.deepEqual(refused, [], row.id + " carries a verify command no lane can run");
    assert.equal(entries.length, row.edition.toolchain.length, row.id);
  }
});

test("a verify command that needs a shell is refused onto the page, never run", () => {
  const ed = { edition: "made-up", detect: { extensions: [".x"] },
    toolchain: [{ id: "shelly", role: "linter", verify: { argv: ["lint", "&&", "test"], expectedExit: 1 } }] };
  const { entries, refused } = engine.verifyEntriesFor([ed], [tickedRow("shelly", "linter", "made-up")], ["ci"], null);
  assert.deepEqual(entries, []);
  assert.equal(refused.length, 1);
  assert.match(refused[0], /shelly's verify command contains the shell character/);
});

test("the project's own test script is the test-runner entry when no test runner was ticked", () => {
  const js = edition("javascript-typescript");
  const { entries } = engine.verifyEntriesFor([js], [tickedRow("eslint", "linter")], ["ci", "commit"], "node --test");
  const mine = entries.find((e) => e.id === "test-script");
  assert.deepEqual(mine.argv, ["node", "--test"]);
  assert.equal(mine.expectedExit, 0);
  assert.deepEqual(mine.lanes, ["ci", "commit"]);
});

test("a ticked test runner is the test-runner entry, and the script does not double it", () => {
  const js = edition("javascript-typescript");
  const { entries } = engine.verifyEntriesFor([js], [tickedRow("vitest", "test-runner")], ["ci"], "npm test");
  assert.deepEqual(entries.map((e) => e.id), ["vitest"]);
});

test("a test script that needs a shell is refused rather than half-run", () => {
  const js = edition("javascript-typescript");
  const { entries, refused } = engine.verifyEntriesFor([js], [], ["ci"], "jest && eslint .");
  assert.deepEqual(entries, []);
  assert.match(refused[0], /the project's own test script contains the shell character/);
});

// ---------------------------------------------------------------------------
// DERAIL-PASS defect 16, the other two halves
// ---------------------------------------------------------------------------
//
// The owner installs by hand — which on Windows was the only route there was —
// and re-runs. The tool comes back config-only, and the wiring line and the CI
// step the plan printed have to survive that route or the tool is configured
// and nothing ever runs it. Then: a change the engine refused before it wrote a
// byte has to be finished, not `interrupted` for ever in `status`.

test("a tool already on the machine keeps its wiring and its CI step through the config-only route", () => {
  const root = tmpProject({
    "package.json": "{\n  \"private\": true,\n  \"devDependencies\": { \"eslint\": \"^9.0.0\" }\n}\n",
    "package-lock.json": "{ \"lockfileVersion\": 3 }\n",
  });
  const plan = engine.cmdPlan(root, {
    _: [], change: [], provenance: "elicited", "no-ci": true,
    edition: "javascript-typescript", select: "javascript-typescript/focused-test", tools: "eslint",
  });
  const row = plan.toolchain.items.find((t) => t.id === "eslint");
  assert.equal(row.present, true, "eslint is declared in the manifest and did not read as present");
  assert.equal(row.ciStep, "npm run lint");

  const payload = engine.planFiles(root).map(engine.readPlan).find((p) => p.planId === plan.planId);
  const change = payload.changes.find((c) => c.path === "eslint.config.mjs");
  assert.equal(change.kind, "write-side-file", "a tool already here was proposed as an install");
  assert.equal(change.tool, "eslint");
  assert.match(change.wiring, /"lint":/);
  assert.equal(change.ciStep, "npm run lint");

  const md = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
  assert.ok(md.includes("- CI step: `npm run lint`"), "the CI step is not on the page the owner approves from");
});

test("an install refused at apply time is finished, not `interrupted` for ever", () => {
  const root = tmpProject({ "package.json": "{\n  \"private\": true\n}\n" });
  const item = {
    id: "absentlint",
    role: "linter",
    edition: "javascript-typescript",
    installKind: "package",
    packageManager: "npm",
    command: "jig-absent-manager install absentlint",
    argv: ["jig-absent-manager", "install", "absentlint"],
    configPath: "absentlint.config.json",
    configBody: "{}\n",
    wiring: null,
    ciStep: null,
    uninstallCommand: "jig-absent-manager uninstall absentlint",
    uninstallArgv: ["jig-absent-manager", "uninstall", "absentlint"],
    timeoutMs: 20000,
  };
  fs.writeFileSync(path.join(root, "draft.json"), JSON.stringify({
    changes: [{ id: "install-absentlint", kind: "run-install", path: item.configPath, install: item }],
  }));
  const plan = engine.cmdPlan(root, { _: [], change: [], from: "draft.json" });
  assert.throws(
    () => engine.cmdApply(root, { _: [], change: [plan.changes[0].id], path: [item.configPath] }),
    /could not run "jig-absent-manager"/,
  );

  const status = engine.cmdStatus(root);
  const change = status.changes.find((c) => c.id === plan.changes[0].id);
  assert.equal(change.state, "refused");
  assert.deepEqual(status.open, [], "a change that never ran is still listed as open work");

  // And a full revert has nothing to say about it, rather than leaving it
  // behind: there is no write to restore, because there was no write.
  assert.deepEqual(engine.cmdRevert(root, { _: [], change: [], all: true }).reverted, []);
  assert.equal(engine.cmdStatus(root).changes.find((c) => c.id === plan.changes[0].id).state, "refused");
});
