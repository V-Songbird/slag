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
  assert.deepEqual(result, { ran: true, code: 1, caught: true, expectedExit: 1 });
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
  assert.deepEqual(result, { ran: true, code: 1, caught: true, expectedExit: [1, 5] });
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
