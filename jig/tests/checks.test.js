"use strict";

// Two halves of one entry: what jig installs and the driver it installs them
// as. They share a suite because neither claim means anything alone — an
// installed check that is not what admission proved, and a driver that does not
// catch what the check promised, are the same failure seen from two ends.
//
// SCOPE moved where a check comes from: the model authors it and the fixture
// pair admits it, so there is no per-class template any more and no catalogue
// gating what may be installed. What survives is the template machinery for the
// four artifacts jig still copies verbatim — the driver, the activation note,
// the hook shim and the CI workflow.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const engine = require("../scripts/jig.js");
const lib = require("../hooks/jig-lib.js");
const admission = require("../scripts/admission.js");
const A = require("./authored.js");

const TEMPLATE_DIR = path.join(__dirname, "..", "scripts", "templates");
const INDEX = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, "templates.json"), "utf-8"));

// One reader for both sides of a template comparison: the writer applies the
// project's own line endings, so a CRLF checkout would otherwise fail every one.
function templateOf(file) {
  // Dropping every CR normalises CRLF to LF without a single escape in the
  // source, which is what this file kept getting wrong.
  return fs.readFileSync(file, "utf-8").split(String.fromCharCode(13)).join("");
}

const CHECKS = [A.PIPED_INSTALLER, A.EMPTY_CATCH];

const roots = [];

function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jig-" + tag + "-"));
  roots.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function project(files) {
  const root = tmpDir("checks");
  for (const [rel, content] of Object.entries(files || {})) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function nodeProject(files) {
  return project({ "package.json": "{ \"private\": true }\n", "src/a.ts": "export const a = 1;\n", ...(files || {}) });
}

function install(root, opts, checks) {
  return A.installChecks(engine, root, checks || CHECKS, { provenance: "elicited", ...(opts || {}) });
}

function listFiles(root, dir) {
  const out = [];
  const stack = [dir || "."];
  while (stack.length) {
    const rel = stack.pop();
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel === "." ? entry.name : rel + "/" + entry.name;
      if (entry.isDirectory()) stack.push(child);
      else out.push(child);
    }
  }
  return out.sort();
}

function snapshot(root) {
  return listFiles(root).map((rel) =>
    rel + " " + crypto.createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex"));
}

function driver(root, args) {
  return spawnSync(process.execPath, [path.join(root, ".jig", "checks", "run.mjs"), ...(args || [])], {
    cwd: root, encoding: "utf-8", windowsHide: true,
  });
}

function driverJson(root, args) {
  const run = driver(root, [...(args || []), "--json"]);
  return { status: run.status, out: JSON.parse(run.stdout) };
}

// The two seeded violations every driver test below is scored against, and the
// two near misses they must leave alone. Both pairs are the fixtures admission
// already proved these checks on.
function seedViolations(root) {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "bad.js"), A.EMPTY_CATCH.fixtures.violation);
  fs.writeFileSync(path.join(root, "scripts", "bad.sh"), A.PIPED_INSTALLER.fixtures.violation);
}

function seedNearMisses(root) {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "ok.js"), A.EMPTY_CATCH.fixtures.nearMiss);
  fs.writeFileSync(path.join(root, "scripts", "ok.sh"), A.PIPED_INSTALLER.fixtures.nearMiss);
}

// ---------------------------------------------------------------------------
// The templates
// ---------------------------------------------------------------------------

test("every template exists and hashes to what the index recorded", () => {
  for (const entry of INDEX.templates) {
    const full = path.join(TEMPLATE_DIR, entry.file);
    assert.ok(fs.existsSync(full), entry.name + ": " + entry.file + " is missing");
    const text = fs.readFileSync(full, "utf-8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
    const found = crypto.createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex");
    assert.equal(found, entry.sha256,
      entry.name + " changed. Set its sha256 in templates.json to " + found);
  }
});

test("a template that changed underneath the index is refused before anything is planned", () => {
  const entry = INDEX.templates.find((t) => t.name === "check-driver");
  assert.throws(
    () => engine.templateBody({ ...entry, sha256: "0".repeat(64) }),
    /does not match the hash jig recorded for it/,
  );
});

test("a template jig cannot find is a refusal, not an empty file", () => {
  assert.throws(() => engine.templateBody({ name: "ghost", file: "ghost.mjs" }), /is missing from jig/);
});

test("the engine and the runner agree on which runners are hooks", () => {
  assert.deepEqual(engine.HOOK_RUNNERS, lib.HOOK_RUNNERS);
});

test("the engine, the runner and admission name the same session levers", () => {
  // Four tables, one fact. A lever added to the engine and forgotten in
  // `LEVER_TOOLS` reads no tool at runtime, so the check admits and then guards
  // nothing — which is the silent hole this one line closes.
  const sessionOf = (table) => Object.entries(table)
    .filter(([, runner]) => lib.HOOK_RUNNERS.includes(runner))
    .map(([lever]) => lever).sort();
  const levers = sessionOf(engine.AUTHORED_RUNNERS);
  assert.ok(levers.length > 1);
  assert.deepEqual(Object.keys(lib.LEVER_TOOLS).sort(), levers, "jig-lib reads a different set of session levers");
  assert.deepEqual(Object.keys(admission.SESSION_KINDS).sort(), levers, "admission proves a different set");
  assert.deepEqual(sessionOf(A.RUNNER_BY_LEVER), levers, "the test mirror in authored.js drifted from the engine");
});

test("the engine and the driver agree on which directories the walk skips", () => {
  // The driver is a standalone template and cannot import the engine, so the
  // list exists twice. This is what keeps the second copy honest: a cell that
  // graded a check-driver detector against a stale list would be back to
  // claiming a lane the driver never reaches.
  const body = templateOf(path.join(TEMPLATE_DIR, "run.mjs"))
    .match(/const SKIP_DIRS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(body, "run.mjs no longer declares SKIP_DIRS as a literal set");
  assert.deepEqual(engine.DRIVER_SKIPS, body[1].match(/"[^"]+"/g).map((s) => JSON.parse(s)));
});

test("the file names the engine writes are the ones the index and the runner use", () => {
  assert.equal(INDEX.templates.find((t) => t.name === "activation").target,
    engine.STATE_DIR + "/" + engine.ACTIVATION_FILE);
  assert.equal(engine.CONFIG_FILE, lib.CONFIG_FILE);
  assert.equal(engine.LEDGER_FILE, lib.LEDGER_FILE);
});

test("every template lands somewhere the engine's own allowlist permits", () => {
  const root = project({});
  for (const entry of INDEX.templates) {
    assert.equal(engine.targetProblem(root, entry.kind, entry.target), null,
      entry.name + " targets " + entry.target);
  }
});

test("a plan installs no shipped check template — every check module is an admitted one", () => {
  // SCOPE: "there is no per-class check template any more". The only modules
  // under .jig/checks/ besides the driver are the ones the fixture pair let in,
  // and each one is named after its own slug.
  const root = nodeProject();
  const { plan } = install(root, { "no-ci": true });
  const modules = plan.changes
    .filter((c) => c.path.startsWith(".jig/checks/") && c.path.endsWith(".check.mjs"))
    .map((c) => c.path).sort();
  assert.deepEqual(modules, [".jig/checks/empty-catch.check.mjs", ".jig/checks/piped-installer.check.mjs"]);
  for (const c of plan.changes) {
    assert.equal(/^check-(?:silent-catch|focused-or-skipped-test|pipe-to-shell|test-file-deletion)-/.test(c.id), false,
      c.id + " came from a shipped per-class template");
  }
  assert.deepEqual(fs.readdirSync(path.join(root, ".jig", "checks")).sort(),
    ["empty-catch.check.mjs", "piped-installer.check.mjs", "run.mjs"]);
});

test("nothing is interpolated into a template on the way out", () => {
  const root = nodeProject();
  install(root);
  // More than one template can own a target — the activation doc has an
  // unwired face and two wired ones — so the installed file has to match the
  // source of the template that actually wrote it, not of every template that
  // could have.
  for (const entry of INDEX.templates) {
    if (!fs.existsSync(path.join(root, entry.target))) continue;
    const installed = templateOf(path.join(root, entry.target));
    const sources = INDEX.templates.filter((t) => t.target === entry.target)
      .map((t) => templateOf(path.join(TEMPLATE_DIR, t.file)));
    assert.ok(sources.includes(installed), entry.target + " was not copied out verbatim from any of its templates");
  }
});

test("every generated artifact carries the ownership marker a reader can see", () => {
  const root = nodeProject();
  install(root);
  for (const entry of INDEX.templates) {
    if (!fs.existsSync(path.join(root, entry.target))) continue;
    const text = fs.readFileSync(path.join(root, entry.target), "utf-8");
    assert.match(text, /jig:owned/, entry.target + " does not say who owns it");
  }
});

// ---------------------------------------------------------------------------
// The selection
// ---------------------------------------------------------------------------

test("an id no edition carries is a disclosed gap, not a refusal", () => {
  // REVERSED by SCOPE: the catalogue informs and never gates. A selected id
  // nothing answers is a class with nothing behind it, and the matrix says so.
  const root = nodeProject();
  const plan = engine.cmdPlan(root, {
    _: [], change: [], select: "make-me-a-guard", provenance: "elicited", "no-ci": true,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.selection, ["make-me-a-guard"]);
  const row = JSON.parse(fs.readFileSync(path.join(root, ".jig", "plan.json"), "utf-8")).rows[0];
  assert.equal(row.classId, "make-me-a-guard");
  assert.equal(row.edition, null);
  assert.equal(row.authored, false);
  for (const cell of Object.values(row.cells)) assert.equal(cell.grade, "GAP");
  assert.equal(fs.existsSync(path.join(root, ".jig", "config.json")), false, "a class with nothing behind it wired a guard");
});

// ---------------------------------------------------------------------------
// jig's own apparatus
// ---------------------------------------------------------------------------
//
// The four files nothing used to watch: the guard config, the check modules,
// the kill switch and the CI workflow. They are guarded the way everything else
// is — the model authors a check, the fixture pair admits it, the owner approves
// it by name — so what these hold is that the authoring story really carries
// them, and that the one lane which cannot is reported as a gap rather than
// printed as coverage.

const DISARM_PATTERN = "\"mode\"\\s*:\\s*\"observe\"";

const CONFIG_PAIR = {
  violation: "{\n  \"guards\": [\n    { \"id\": \"a\", \"mode\": \"observe\" }\n  ]\n}\n",
  nearMiss: "{\n  \"guards\": [\n    { \"id\": \"a\", \"mode\": \"armed\" }\n  ]\n}\n",
};

const DENY_DISARM = {
  reason: "This rewrites .jig/config.json, the file that says which of jig's guards are armed.",
  alternative: "step the guard down in /jig:review, so the change is named, approved and recorded",
  override: "say which guard is wrong here and mark its report a false alarm first",
};

// The shape SKILL.md step 4 hands out: the session lever, scoped to the one file.
function disarmCheck(extra) {
  return A.authored({
    id: "jig-config-disarmed",
    title: "jig's own guard config rewritten to disarm a guard",
    detectors: [
      { lever: "edit-guard", actor: "claude-session", confidence: "deterministic",
        params: { paths: [".jig/config.json"], patterns: [DISARM_PATTERN],
          stripComments: false, stripStrings: false } },
      ...(extra || []),
    ],
    fixtures: CONFIG_PAIR,
    deny: DENY_DISARM,
  });
}

// The same check with the driver twin an author reaches for first, which is the
// one that cannot work.
const BLIND_DRIVER = { lever: "check-driver", actor: "human-editor", confidence: "deterministic",
  params: { paths: [".jig/config.json"], patterns: [DISARM_PATTERN],
    stripComments: false, stripStrings: false } };

test("an edit guard over jig's own config denies the write that disarms it", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [disarmCheck()]);
  const out = lib.runEvent(root, "PreToolUse", {
    session_id: "s", tool_name: "Write",
    tool_input: { file_path: path.join(root, ".jig", "config.json"), content: CONFIG_PAIR.violation },
  }, () => {});
  assert.equal(out.jig.decision, "deny");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /which of jig's guards are armed/);
});

test("the same guard leaves a config that keeps the guard armed alone", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [disarmCheck()]);
  const out = lib.runEvent(root, "PreToolUse", {
    session_id: "s", tool_name: "Write",
    tool_input: { file_path: path.join(root, ".jig", "config.json"), content: CONFIG_PAIR.nearMiss },
  }, () => {});
  assert.equal(out.jig.decision, "pass");
});

test("a check-driver detector inside a directory the walk skips is a gap, not a DET cell", () => {
  // Found live: the pair passes, the plan printed DET and named the installed
  // module, and `run.mjs` reported "No findings." over a `.jig/config.json`
  // holding the very fixture it was admitted on.
  const root = nodeProject();
  const { plan } = install(root, { "no-ci": true }, [disarmCheck([BLIND_DRIVER])]);
  const row = JSON.parse(fs.readFileSync(path.join(root, ".jig", "plan.json"), "utf-8")).rows[0];
  assert.equal(row.cells["human-editor"].grade, "GAP");
  assert.equal(row.cells["human-editor"].artifact, null);
  assert.equal(row.cells["human-editor"].why, "the check driver never walks .jig/");
  // The session lever over the same path is untouched — this is about the lane,
  // not about the check.
  assert.equal(row.cells["claude-session"].grade, "DET");
  // And the module is still installed: a blind detector is a disclosed gap, not
  // a discard, because the same check carries a lever that does work.
  assert.ok(plan.changes.some((c) => c.path === ".jig/checks/jig-config-disarmed.check.mjs"));
  assert.equal(driverJson(root, []).out.findings.length, 0);
});

test("a driver detector the walk never reaches does not clear the host-neutral floor", () => {
  const cls = { id: "x", detectors: [BLIND_DRIVER] };
  assert.equal(engine.hostNeutralFloor(cls), false);
  assert.match(engine.floorNote(cls), /no host-neutral deterministic lever/);
  // The same detector one directory over is a floor, so this reads the path and
  // not the lever.
  const walked = { ...BLIND_DRIVER, params: { ...BLIND_DRIVER.params, paths: ["config/*.json"] } };
  assert.equal(engine.hostNeutralFloor({ id: "x", detectors: [walked] }), true);
});

test("only a skipped directory blinds a driver detector, never a file that shares its name", () => {
  const params = (paths) => ({ lever: "check-driver", params: { paths } });
  assert.equal(engine.driverBlindDir(params([".jig/config.json"])), ".jig");
  assert.equal(engine.driverBlindDir(params(["src/vendor/**/*.js"])), "vendor");
  // A file called `build` at the root is a file the walk reads.
  assert.equal(engine.driverBlindDir(params(["build"])), null);
  // A wildcard segment never resolves to a skipped name — the walk removed
  // those directories before the glob was ever asked.
  assert.equal(engine.driverBlindDir(params(["**/*.js"])), null);
  // One reachable glob is enough to give the detector somewhere to look.
  assert.equal(engine.driverBlindDir(params([".jig/config.json", "src/**/*.ts"])), null);
  assert.equal(engine.driverBlindDir({ lever: "bash-guard", params: { patterns: ["x"] } }), null);
});

test("a removal on the check driver is a gap, not a lane, and never the floor", () => {
  // The driver reads the tree as it is and reports a removal detector skipped on
  // every run, so a cell naming the installed module would claim a lane nothing
  // reaches — the same shape `driverBlindDir` names, for the same reason.
  const removal = (params) => ({ lever: "check-driver", confidence: "deterministic",
    params: { paths: ["**/*.test.js"], ...params } });
  assert.equal(engine.driverBlindRemoval(removal({ removed: [A.TEST_COUNT_PATTERN] })), true);
  // Not when the driver has something else on the same detector to evaluate.
  assert.equal(engine.driverBlindRemoval(removal({ removed: [A.TEST_COUNT_PATTERN], patterns: ["x"] })), false);
  assert.equal(engine.driverBlindRemoval({ lever: "edit-guard", params: { removed: ["x"] } }), false);

  const cls = { id: "tests-deleted", detectors: [removal({ removed: [A.TEST_COUNT_PATTERN] })] };
  assert.equal(engine.hostNeutralFloor(cls), false, "a class nothing evaluates cleared the floor");
  assert.match(engine.floorNote(cls), /no host-neutral deterministic lever/);

  const root = nodeProject();
  install(root, { "no-ci": true }, [A.TESTS_DELETED]);
  const row = JSON.parse(fs.readFileSync(path.join(root, ".jig", "plan.json"), "utf-8"))
    .rows.find((r) => r.classId === "tests-deleted");
  assert.equal(row.cells["human-editor"].grade, "GAP");
  assert.equal(row.cells["human-editor"].artifact, null);
  assert.match(row.cells["human-editor"].why, /no earlier version to count against/);
});

test("a plan with neither a selection nor an authored check is a refusal", () => {
  const root = nodeProject();
  assert.throws(() => engine.cmdPlan(root, { _: [], change: [], select: "  ,  " }),
    /needs --select <classId,…>|--from <file>/);
  assert.equal(fs.existsSync(path.join(root, ".jig")), false, "asking created state");
});

test("the generated config passes the runner's own validator, guard for guard", () => {
  const root = nodeProject();
  install(root);
  const config = JSON.parse(fs.readFileSync(path.join(root, ".jig", "config.json"), "utf-8"));
  const checked = lib.validateConfig(config);
  assert.deepEqual(checked.problems, []);
  assert.deepEqual(checked.warnings, []);
  assert.ok(checked.guards.length > 0);
  for (const guard of checked.guards) {
    assert.ok(lib.HOOK_RUNNERS.includes(guard.runner));
    assert.ok(fs.existsSync(path.join(root, ".jig", "checks", guard.check + ".check.mjs")),
      guard.id + " names a check that is not installed");
  }
});

// 2.11.0 / C6. Teaching is opt-in per guard, and the authored detector is the
// only place an owner can say so — the key shipped read-only, so the sole route
// in was hand-editing the file this release's own guards exist to deny.
const TEACHING_CATCH = A.authored({
  id: "teaching-catch",
  title: "A swallowed error, said out loud rather than blocked",
  detectors: [
    { lever: "edit-observe-guard", actor: "claude-session", confidence: "deterministic",
      teach: true, params: { patterns: [A.CATCH_PATTERN] } },
  ],
  fixtures: A.EMPTY_CATCH.fixtures,
  deny: A.DENY_CATCH,
});

test("a detector authored to teach installs a guard that does, and one that was not does not", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [TEACHING_CATCH, A.EMPTY_CATCH]);
  const guards = JSON.parse(fs.readFileSync(path.join(root, ".jig", "config.json"), "utf-8")).guards;
  const row = (id) => guards.find((g) => g.id.startsWith(id));
  assert.equal(row("teaching-catch").teach, true);
  assert.equal("teach" in row("empty-catch"), false,
    "a guard nobody asked to teach was given the key anyway");
  assert.deepEqual(lib.validateConfig({ schemaVersion: 1, guards }).problems, []);
});

test("the generated config carries no key that could become a matcher", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const config = JSON.parse(fs.readFileSync(path.join(root, ".jig", "config.json"), "utf-8"));
  const text = JSON.stringify(config);
  for (const key of lib.MATCHER_KEYS) {
    assert.equal(text.includes('"' + key + '"'), false, "the config names " + key);
  }
  for (const guard of config.guards) {
    assert.deepEqual(Object.keys(guard).sort(),
      ["check", "classId", "id", "mode", "proof", "provenance", "runner"]);
    assert.match(guard.proof, /^[0-9a-f]{64}$/);
  }
  // No top-level mode: one word that silently arms twenty checks is too much
  // blast radius (SCOPE).
  assert.deepEqual(Object.keys(config).sort(), ["guards", "schemaVersion"]);
  assert.equal(config.schemaVersion, engine.SCHEMA_VERSION);
});

test("a check with no hook detector installs a module and wires no guard", () => {
  const driverOnly = A.authored({
    id: "driver-only",
    title: "Caught by the committed driver and nothing else",
    detectors: [
      { lever: "check-driver", actor: "human-editor", confidence: "deterministic",
        params: { patterns: [A.CATCH_PATTERN], paths: ["**/*.js"] } },
    ],
    fixtures: A.EMPTY_CATCH.fixtures,
    deny: A.DENY_CATCH,
  });
  const root = nodeProject();
  const { plan } = install(root, { "no-ci": true }, [driverOnly]);
  assert.ok(plan.changes.some((c) => c.path === ".jig/checks/driver-only.check.mjs"));
  const config = JSON.parse(fs.readFileSync(path.join(root, ".jig", "config.json"), "utf-8"));
  assert.deepEqual(config.guards, []);
});

test("the permissions proposal names no host rule and says why it cannot", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const proposal = JSON.parse(fs.readFileSync(path.join(root, ".jig", "proposed-permissions.json"), "utf-8"));
  assert.ok(proposal.proposals.length > 0);
  for (const row of proposal.proposals) {
    assert.equal(row.hostRule, null);
    assert.match(row.gap, /prefix/);
  }
  assert.match(proposal.note, /never edits your settings/);
});

test("a selection with nothing an agent runs proposes no permissions at all", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  assert.equal(fs.existsSync(path.join(root, ".jig", "proposed-permissions.json")), false);
});

// ---------------------------------------------------------------------------
// Occupied slots and drift
// ---------------------------------------------------------------------------

test("a file jig did not write is refused, and the rest of the plan still goes ahead", () => {
  const root = nodeProject({ ".github/workflows/jig.yml": "name: somebody else\n" });
  const { plan } = install(root);
  assert.equal(plan.refused.length, 1);
  assert.match(plan.refused[0], /already exists and jig did not write it/);
  assert.equal(fs.readFileSync(path.join(root, ".github/workflows/jig.yml"), "utf-8"), "name: somebody else\n");
  assert.ok(fs.existsSync(path.join(root, ".jig", "checks", "run.mjs")));
});

test("an artifact edited after jig wrote it is refused rather than overwritten", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const rel = path.join(root, ".jig", "checks", "empty-catch.check.mjs");
  fs.appendFileSync(rel, "\n// a teammate changed this\n");
  const after = fs.readFileSync(rel, "utf-8");
  const { plan } = install(root, { "no-ci": true });
  assert.ok(plan.refused.some((r) => /was edited after jig wrote it/.test(r)));
  assert.equal(fs.readFileSync(rel, "utf-8"), after);
});

test("the config is the user's to edit — changing it is not drift", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const rel = path.join(root, ".jig", "config.json");
  const config = JSON.parse(fs.readFileSync(rel, "utf-8"));
  config.guards = config.guards.filter((g) => g.classId !== "piped-installer");
  fs.writeFileSync(rel, JSON.stringify(config, null, 2) + "\n");
  const states = engine.manifestStates(root, engine.readManifest(root));
  const row = states.find((s) => s.path === ".jig/config.json");
  assert.equal(row.ownership, "schema");
  assert.equal(row.state, "active");
});

test("a removed artifact reads as retired, not as missing", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  fs.rmSync(path.join(root, ".jig", "activation.md"));
  const states = engine.manifestStates(root, engine.readManifest(root));
  assert.equal(states.find((s) => s.path === ".jig/activation.md").state, "retired");
});

test("every slot taken means nothing is planned, and the reasons are all named", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  for (const rel of [".jig/checks/run.mjs", ".jig/checks/empty-catch.check.mjs", ".jig/activation.md",
    ".jig/config.json"]) {
    fs.appendFileSync(path.join(root, rel), "\n");
  }
  // config.json is schema-owned and stays writable, so the frozen set is what
  // proves the refusal.
  const states = engine.manifestStates(root, engine.readManifest(root));
  const frozen = states.filter((s) => s.state === "drifted").map((s) => s.path).sort();
  assert.deepEqual(frozen, [".jig/activation.md", ".jig/checks/empty-catch.check.mjs", ".jig/checks/run.mjs"]);
});

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

test("apply records every generated artifact with the whole row shape", () => {
  const root = nodeProject();
  const { applied } = install(root);
  assert.equal(applied.manifest, ".jig/manifest.json");
  const manifest = engine.readManifest(root);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.artifacts.length, 8);
  for (const row of manifest.artifacts) {
    assert.deepEqual(Object.keys(row).sort(), [
      "classIds", "hash", "id", "install", "installedAt", "kind", "ownership", "path",
      "proof", "provenance", "rationale", "state", "template", "txId",
    ]);
    assert.equal(row.txId, applied.tx);
    // Why the owner approved it, recorded beside what was written. Without it
    // the manifest says a file is jig's and cannot say what it is for.
    assert.ok(row.rationale, row.path + " landed with no recorded reason");
    assert.equal(row.provenance, "elicited");
    assert.equal(row.hash, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, row.path))).digest("hex"));
    assert.ok(engine.OWNERSHIPS.includes(row.ownership));
  }
  // The proof rides the manifest for exactly the rows that carry a check, which
  // is what a config claiming a proof gets checked against.
  const proven = manifest.artifacts.filter((a) => a.proof !== null).map((a) => a.path).sort();
  assert.deepEqual(proven, [".jig/checks/empty-catch.check.mjs", ".jig/checks/piped-installer.check.mjs"]);
});

test("provenance defaults to assumed, which is what quick-start installs as", () => {
  const root = nodeProject();
  A.installChecks(engine, root, CHECKS, { "no-ci": true });
  assert.ok(engine.readManifest(root).artifacts.every((a) => a.provenance === "assumed"));
});

test("a hand-written draft writes no manifest — the manifest records what jig generated", () => {
  const root = nodeProject();
  fs.writeFileSync(path.join(root, "draft.json"), JSON.stringify({
    changes: [{ id: "hand", kind: "write-side-file", path: ".jig/hand.json", content: "{}\n" }],
  }));
  const plan = engine.cmdPlan(root, { _: [], change: [], from: "draft.json" });
  const applied = engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  assert.equal(applied.manifest, null);
  assert.equal(fs.existsSync(path.join(root, ".jig", "manifest.json")), false);
});

test("a manifest written by a newer jig is refused, not guessed at", () => {
  const root = project({});
  fs.mkdirSync(path.join(root, ".jig"), { recursive: true });
  fs.writeFileSync(path.join(root, ".jig", "manifest.json"),
    JSON.stringify({ schemaVersion: 2, artifacts: [] }));
  assert.throws(() => engine.readManifest(root), /schemaVersion 2 and this engine reads 1/);
});

test("installing a second check keeps the first one's rows", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.PIPED_INSTALLER]);
  const first = engine.readManifest(root).artifacts.map((a) => a.path);
  install(root, { "no-ci": true }, CHECKS);
  const second = engine.readManifest(root).artifacts.map((a) => a.path);
  assert.ok(first.every((p) => second.includes(p)));
  assert.ok(second.includes(".jig/checks/empty-catch.check.mjs"));
});

test("re-applying the same plan changes nothing and says so", () => {
  const root = nodeProject();
  const { plan } = install(root);
  const again = A.applyPlan(engine, root, plan);
  assert.ok(again.applied.every((r) => r.outcome === "already-applied"));
});

test("revert takes every generated artifact back out, manifest included", () => {
  const root = nodeProject();
  const before = snapshot(root);
  install(root);
  engine.cmdRevert(root, { _: [], change: [], all: true });
  const after = snapshot(root).filter((line) => !line.startsWith(".jig/") && !line.startsWith("authored.json "));
  assert.deepEqual(after, before);
  assert.equal(fs.existsSync(path.join(root, ".jig", "manifest.json")), false);
  assert.equal(fs.existsSync(path.join(root, ".github")), false);
});

test("an install writes only where the plan named, and every name was approved", () => {
  const root = nodeProject({ "src/index.js": "module.exports = 1;\n" });
  const { plan } = install(root);
  const approved = new Set(plan.changes.map((c) => c.path));
  const touched = listFiles(root)
    .filter((rel) => !rel.startsWith(".jig/") && rel !== "package.json" && rel !== "src/index.js" &&
      rel !== "src/a.ts" && rel !== "authored.json");
  for (const rel of touched) assert.ok(approved.has(rel), "jig wrote " + rel + ", which no change named");
  assert.deepEqual(touched, [".github/workflows/jig.yml"]);
});

test("the run is journalled, so what apply wrote is replayable from the record", () => {
  const root = nodeProject();
  const { applied } = install(root);
  const status = engine.cmdStatus(root);
  const paths = status.changes.flatMap((c) => c.files).sort();
  assert.ok(paths.includes(".jig/manifest.json"));
  for (const row of applied.applied) assert.ok(paths.includes(row.path));
  assert.ok(status.changes.every((c) => c.state === "applied"));
});

// ---------------------------------------------------------------------------
// The check driver
// ---------------------------------------------------------------------------
//
// The driver reads the checks the engine installs — which since SCOPE are
// authored modules carrying `detectors` and an inline fixture pair, not the
// 1.0.1 `check(ctx)` plus `selftest` shape. SCOPE, "Does the driver keep
// reading the legacy selftest shape": no; migration rewrites every installed
// check to the pair shape rather than carrying a second contract forever.
//
// These tests assert that contract. They are red against the shipped
// `scripts/templates/run.mjs`, which still selects modules by
// `typeof mod.check === "function"` and therefore loads none of the checks
// `plan` installs today.

test("the driver runs every installed check and reports each violation with its own line", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  seedViolations(root);
  const { status, out } = driverJson(root);
  assert.deepEqual(out.broken, []);
  const caught = [...new Set(out.findings.map((f) => f.classId))].sort();
  assert.deepEqual(caught, ["empty-catch", "piped-installer"]);
  assert.equal(status, 1);
  const emptyCatch = out.findings.find((f) => f.classId === "empty-catch");
  assert.equal(emptyCatch.path, "src/bad.js");
  assert.equal(emptyCatch.line, 4, "the finding names the file's first line instead of the violation's");
});

test("every installed check leaves its own near miss alone", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  seedNearMisses(root);
  const { status, out } = driverJson(root);
  assert.deepEqual(out.findings, []);
  assert.equal(status, 0);
});

test("a finding names the file, the line and the pattern, and never the text that matched", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "secret.js"), "function f() {\n  try { OWNED_BY_THE_REPO(); } catch {}\n}\n");
  const run = driver(root, ["--json"]);
  assert.equal(run.stdout.includes("OWNED_BY_THE_REPO"), false);
  const finding = JSON.parse(run.stdout).findings[0];
  assert.ok(finding, "the driver reported nothing for a seeded violation");
  assert.deepEqual(Object.keys(finding).sort(), ["classId", "line", "note", "path", "pattern"]);
});

// Defect 23: a finding said what matched and where, and nothing about why it is
// a mistake or what to do instead. The check's author wrote both for exactly
// this moment; printing the row without them throws that away.
test("a finding prints the reason and the alternative the check's author wrote", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "swallow.js"), "try { risky(); } catch {}\n");
  const out = driver(root).stdout;
  assert.ok(out.includes("  " + A.EMPTY_CATCH.deny.reason), out);
  assert.ok(out.includes("  Instead: " + A.EMPTY_CATCH.deny.alternative), out);
});

test("a violation inside a comment or a string literal is not a violation", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "quoted.js"), [
    "// try { x() } catch (err) { }",
    "/* catch {} */",
    'const sample = "catch (err) { }";',
    "const other = `catch {}`;",
    "const re = /catch\\s*\\{\\s*\\}/;",
    "module.exports = { sample, other, re };",
  ].join("\n") + "\n");
  fs.mkdirSync(path.join(root, "src", "real"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "real", "live.js"), "try { x(); } catch {}\n");
  const { out } = driverJson(root);
  assert.deepEqual(out.findings.map((f) => f.path), ["src/real/live.js"],
    "the driver read a shape living only in a comment, a string or a regex as code");
});

test("named paths are the only ones checked when paths are named", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.js"), "try { x(); } catch {}\n");
  fs.writeFileSync(path.join(root, "src", "b.js"), "try { y(); } catch {}\n");
  const { out } = driverJson(root, ["src/a.js"]);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].path, "src/a.js");
});

test("the driver's selftest runs each check against the fixture pair that admitted it", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const run = driver(root, ["--selftest", "--json"]);
  assert.equal(run.status, 0);
  const results = JSON.parse(run.stdout).selftest;
  assert.deepEqual(results.map((r) => r.id).sort(), ["empty-catch", "piped-installer"],
    "the selftest reported on a different set of checks than the plan installed");
  for (const r of results) assert.equal(r.caught, true, r.id + " did not catch its own violation fixture");
});

// A check whose globs are directory-scoped — the normal way to keep a guard off
// a deliberate violation fixture or an ignored tree. The selftest seeds the
// fixture on disk and then filters it through those same globs, so a fixture
// dropped at the root of the throwaway directory is filtered straight back out
// and every precise check reports a miss it never had.
test("the selftest witnesses a check whose globs carry a directory prefix", () => {
  const scoped = A.authored({
    id: "scoped-empty-catch",
    title: "A swallowed error under src/lib only",
    detectors: [
      { lever: "check-driver", actor: "human-editor", confidence: "deterministic",
        params: { patterns: [A.CATCH_PATTERN], paths: ["*/lib/*.test.js", "src/**/*.js"] } },
    ],
    fixtures: A.EMPTY_CATCH.fixtures,
    deny: A.DENY_CATCH,
  });
  const root = nodeProject();
  install(root, { "no-ci": true }, [scoped]);
  const run = driver(root, ["--selftest", "--json"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const result = JSON.parse(run.stdout).selftest.find((r) => r.id === "scoped-empty-catch");
  assert.equal(result.caught, true, result && result.why);
  assert.equal(result.seeded, "fx/lib/fixture.test.js",
    "the fixture was not seeded at a path the check's own first glob matches");
});

// ---------------------------------------------------------------------------
// The paired-change kind, end to end through the installed driver
// ---------------------------------------------------------------------------

function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf-8", windowsHide: true });
}

// A real index, because the whole claim of a paired-change detector is that it
// reads one. Identity is set on the repository so the suite never depends on
// whoever is running it having a global git config.
function stage(root, files) {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "suite@example.test"]);
  git(root, ["config", "user.name", "suite"]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    git(root, ["add", "--", rel]);
  }
}

test("a staged change that touches the engine and leaves the docs alone is a finding", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.DOC_LEFT_BEHIND]);
  stage(root, { "src/engine/solver.ts": "export const solve = () => 1;\n" });
  const { status, out } = driverJson(root);
  assert.equal(status, 1);
  assert.deepEqual(out.findings.map((f) => [f.classId, f.path, f.line]),
    [["doc-left-behind", "src/engine/solver.ts", 1]]);
  assert.match(out.findings[0].note, /changed with nothing matching docs/);
});

test("the same change with the doc staged beside it is silent", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.DOC_LEFT_BEHIND]);
  stage(root, {
    "src/engine/solver.ts": "export const solve = () => 1;\n",
    "docs/engine.md": "# engine\n\nIt solves.\n",
  });
  const { status, out } = driverJson(root);
  assert.deepEqual(out.findings, []);
  assert.equal(status, 0);
});

// The namespace defect: git names staged files from the repository root, a
// check's globs are written against the jig root. Below the root the two differ,
// and before `--relative` this run came back clean while reporting coverage.
test("a paired check fires for an install below the git root", () => {
  const repo = tmpDir("nested");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "suite@example.test"]);
  git(repo, ["config", "user.name", "suite"]);
  const root = path.join(repo, "app");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{ \"private\": true }\n");
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  install(root, { "no-ci": true }, [A.DOC_LEFT_BEHIND]);
  const violation = path.join(root, "src", "engine", "solver.ts");
  fs.mkdirSync(path.dirname(violation), { recursive: true });
  fs.writeFileSync(violation, "export const solve = () => 1;\n");
  git(repo, ["add", "--", "app/src/engine/solver.ts"]);
  const { status, out } = driverJson(root);
  assert.equal(status, 1);
  assert.deepEqual(out.findings.map((f) => [f.classId, f.path]),
    [["doc-left-behind", "src/engine/solver.ts"]]);
});

test("a change that touches neither side is silent", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.DOC_LEFT_BEHIND]);
  stage(root, { "src/ui/button.ts": "export const Button = 1;\n" });
  assert.deepEqual(driverJson(root).out.findings, []);
});

// The honest limit, asserted rather than left to a comment in the workflow: a
// run with no index to read reports the class as skipped. Passing would claim
// coverage nothing demonstrated, which is the one thing SCOPE forbids outright.
test("with no change set to read the class is skipped, not passed", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.DOC_LEFT_BEHIND]);
  fs.mkdirSync(path.join(root, "src", "engine"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "engine", "solver.ts"), "export const solve = () => 1;\n");
  const { status, out } = driverJson(root);
  assert.deepEqual(out.findings, []);
  assert.equal(status, 0);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].id, "doc-left-behind");
  assert.match(out.skipped[0].why, /nothing is staged/);
});

// And the reason that limit is affordable: the selftest needs no index at all,
// so the check is still proven everywhere the driver runs, CI included.
test("the selftest proves a paired-change check from its change-set fixtures alone", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.DOC_LEFT_BEHIND]);
  const run = driver(root, ["--selftest", "--json"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const result = JSON.parse(run.stdout).selftest.find((r) => r.id === "doc-left-behind");
  assert.equal(result.caught, true, result && result.why);
  // One finding per file left behind, and the violation fixture lists two —
  // the report names every file whose pair is missing, not just the first.
  assert.equal(result.hits, 2);
  assert.equal(result.nearMissHits, 0);
});

// ---------------------------------------------------------------------------
// The removal kind, through the installed driver
// ---------------------------------------------------------------------------
//
// This driver reads the tree as it is and has no earlier version to compare, so
// a removal class is a disclosed skip here and is proven from its own fixture
// pair — which carries the file before an edit and the file after it.

test("a removal class is skipped by a run that has only the tree as it is", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.TESTS_DELETED]);
  fs.writeFileSync(path.join(root, "src", "a.test.js"), "it('a', () => {});\n");
  const { status, out } = driverJson(root);
  assert.deepEqual(out.findings, []);
  assert.equal(status, 0);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].id, "tests-deleted");
  assert.match(out.skipped[0].why, /only visible between two versions of a file/);
  // And it does not send the owner to a lane this check does not reach: the
  // session lane watches a removal through an edit guard, and this module has
  // none, so nothing anywhere watches it.
  assert.match(out.skipped[0].why, /carries no session guard either, so nothing watches it/);
});

test("a removal the session lane does watch is skipped here and says where it is caught", () => {
  const twinned = A.authored({
    id: "tests-deleted-twinned",
    title: "Fewer test cases after the edit than before it",
    detectors: [
      { lever: "check-driver", actor: "human-editor", confidence: "heuristic",
        params: { paths: ["**/*.test.js"], removed: [A.TEST_COUNT_PATTERN] } },
      { lever: "edit-guard", actor: "claude-session", confidence: "heuristic",
        params: { paths: ["**/*.test.js"], removed: [A.TEST_COUNT_PATTERN] } },
    ],
    fixtures: A.TESTS_DELETED.fixtures,
    deny: A.TESTS_DELETED.deny,
  });
  const root = nodeProject();
  install(root, { "no-ci": true }, [twinned]);
  const { out } = driverJson(root);
  assert.equal(out.skipped[0].id, "tests-deleted-twinned");
  assert.match(out.skipped[0].why, /this class is watched where the edit happens/);
});

// A module carrying a removal detector AND something this run evaluates is NOT
// skipped: `skipped` means the class was not evaluated, and a class reported in
// both lists at once makes the word mean two things in one run.
const MIXED_KIND = A.authored({
  id: "mixed-kind",
  title: "A focused test, and a case count that went down",
  detectors: [
    { lever: "check-driver", actor: "human-editor", confidence: "deterministic",
      params: { paths: ["**/*.test.js"], patterns: ["\\bit\\.only\\s*\\("] } },
    { lever: "check-driver", actor: "human-editor", confidence: "heuristic",
      params: { paths: ["**/*.test.js"], removed: [A.TEST_COUNT_PATTERN] } },
  ],
  fixtures: {
    violation: "it('a', () => {});\nit.only('b', () => {});\n--- after\nit.only('b', () => {});\n",
    nearMiss: "it('a', () => {});\n--- after\nit('a', () => { expect(1).toBe(1); });\n",
  },
  deny: A.TESTS_DELETED.deny,
});

test("a module the run does evaluate is not also reported skipped for its removal detector", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [MIXED_KIND]);
  fs.writeFileSync(path.join(root, "src", "a.test.js"), "it.only('a', () => {});\n");
  const { out } = driverJson(root);
  assert.deepEqual(out.findings.map((f) => f.classId), ["mixed-kind"]);
  assert.deepEqual(out.skipped, [], "the class was reported found and skipped in the same run");
});

test("the selftest proves a removal check from the two halves of its own fixture", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.TESTS_DELETED]);
  const run = driver(root, ["--selftest", "--json"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const result = JSON.parse(run.stdout).selftest.find((r) => r.id === "tests-deleted");
  assert.equal(result.caught, true, result && result.why);
  assert.equal(result.hits, 1);
  assert.equal(result.nearMissHits, 0);
  assert.equal(result.seeded, "fixture.test.js");
});

// ---------------------------------------------------------------------------
// `--staged`: the lane that gates the repository reads what enters it
// ---------------------------------------------------------------------------
//
// A commit carries the index. The pathless walk reads the working tree, and at
// commit time those are two different projects — both directions were
// reproduced live before this was written. A violation staged and then edited
// back out of the file landed in HEAD under "No findings.", and a violation
// left in the file but never staged blocked a commit that did not contain it.

// The divergence every test below is about: what git will commit, and what is
// on disk at the moment the hook runs.
function stagedThenEdited(root, rel, staged, onDisk) {
  stage(root, { [rel]: staged });
  fs.writeFileSync(path.join(root, rel), onDisk);
}

test("a violation staged behind a clean working copy is a finding", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  stagedThenEdited(root, "src/bad.js", A.EMPTY_CATCH.fixtures.violation, A.EMPTY_CATCH.fixtures.nearMiss);
  const { status, out } = driverJson(root, ["--staged"]);
  assert.equal(status, 1);
  assert.deepEqual(out.findings.map((f) => [f.classId, f.path, f.line]), [["empty-catch", "src/bad.js", 4]]);
});

test("a violation the commit does not carry blocks nothing", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  stagedThenEdited(root, "src/ok.js", A.EMPTY_CATCH.fixtures.nearMiss, A.EMPTY_CATCH.fixtures.violation);
  const { status, out } = driverJson(root, ["--staged"]);
  assert.deepEqual(out.findings, []);
  assert.equal(status, 0);
});

// The other half of the same decision: CI and a manual run have nothing staged,
// so the walk is the only reading that means anything there and stays untouched.
test("without --staged the driver still reads the working tree, index or no index", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  stagedThenEdited(root, "src/ok.js", A.EMPTY_CATCH.fixtures.nearMiss, A.EMPTY_CATCH.fixtures.violation);
  const { status, out } = driverJson(root);
  assert.equal(status, 1);
  assert.deepEqual(out.findings.map((f) => f.path), ["src/ok.js"]);
});

// The same namespace defect the paired kind hit: git names staged paths from
// the repository root, the driver's globs are written against ROOT. `--relative`
// on the list and `:./path` on the read keep both in the one namespace.
test("the staged read finds a violation for an install below the git root", () => {
  const repo = tmpDir("staged-nested");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "suite@example.test"]);
  git(repo, ["config", "user.name", "suite"]);
  const root = path.join(repo, "app");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{ \"private\": true }\n");
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  fs.writeFileSync(path.join(root, "src", "bad.js"), A.EMPTY_CATCH.fixtures.violation);
  git(repo, ["add", "--", "app/src/bad.js"]);
  fs.writeFileSync(path.join(root, "src", "bad.js"), A.EMPTY_CATCH.fixtures.nearMiss);
  const { status, out } = driverJson(root, ["--staged"]);
  assert.equal(status, 1);
  assert.deepEqual(out.findings.map((f) => [f.classId, f.path]), [["empty-catch", "src/bad.js"]]);
});

// `.jig/checks/` is committed on purpose, so a normal commit stages files the
// walk has always refused to read. The staged reading refuses them too — a
// check pointed at the fixture inside its own module reports itself.
test("the staged read skips the directories the walk skips", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  fs.writeFileSync(path.join(root, ".jig", "sample.js"), A.EMPTY_CATCH.fixtures.violation);
  stage(root, { "src/ok.js": A.EMPTY_CATCH.fixtures.nearMiss });
  git(root, ["add", "-f", "--", ".jig/sample.js"]);
  const { status, out } = driverJson(root, ["--staged"]);
  assert.deepEqual(out.findings, []);
  assert.equal(status, 0);
});

// A git that will not answer reads nothing, and reading nothing is not a pass.
// `--staged` used to turn every such environment — no git on the hook's PATH, a
// cwd outside the work tree, a GIT_INDEX_FILE nobody expected — into "No
// findings." and exit 0, which is the commit lane rubber-stamping the commit it
// was installed to gate.
test("a --staged run whose git cannot answer is a partial scan, not a pass", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  fs.writeFileSync(path.join(root, "src", "bad.js"), A.EMPTY_CATCH.fixtures.violation);
  // No `git init` here, so `git diff --cached` exits non-zero in this tree.
  const walked = driver(root, []);
  assert.equal(walked.status, 1, "the fixture is not a violation the walk finds");
  const { status, out } = driverJson(root, ["--staged"]);
  assert.equal(status, 1, "a --staged run that read nothing reported itself clean");
  assert.equal(out.truncated, true);
  assert.match(out.partial, /git could not list the staged files/);
  assert.equal(/\nNo findings\.\n/.test(driver(root, ["--staged"]).stdout), false,
    "a --staged run that read nothing printed a clean bill of health");
});

test("the commit shim runs the driver over the staged bytes", () => {
  const shim = templateOf(path.join(TEMPLATE_DIR, "hook-pre-commit.sh"));
  assert.match(shim, /node \.jig\/checks\/run\.mjs --staged --ledger commit \|\| exit 1/);
});

// ---------------------------------------------------------------------------
// `--ledger`: the lane that catches something leaves a record of it
// ---------------------------------------------------------------------------
//
// The session lane ledgers every call. The commit lane used to catch a
// violation, stop the commit and write nothing anywhere, so `/jig:review` read
// one lane out of three and a class that had only ever fired at commit time was
// indistinguishable from one that had never fired.

function ledgerRows(root) {
  const file = path.join(root, ".jig", "ledger.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("a commit-lane run records the class, the file and the line it caught", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  stagedThenEdited(root, "src/bad.js", A.EMPTY_CATCH.fixtures.violation, A.EMPTY_CATCH.fixtures.nearMiss);
  assert.equal(driver(root, ["--staged", "--ledger", "commit"]).status, 1);
  const rows = ledgerRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lane, "commit");
  assert.equal(rows[0].classId, "empty-catch");
  assert.equal(rows[0].path, "src/bad.js");
  assert.equal(rows[0].line, 4);
  // The commit lane has one mode: the driver exits 1 and the shim stops the
  // commit. A row that read `would-deny` would describe a lane that does not
  // exist here.
  assert.equal(rows[0].decision, "deny");
  assert.equal(rows[0].mode, "armed");
  assert.match(rows[0].ts, /^\d{4}-\d\d-\d\dT/);
  // No guard row named this class, so the row carries the one identity it has.
  // Inventing a guard id would put a line in review's guard table for something
  // the config never named.
  assert.equal(rows[0].guardId, null);
});

test("a ledgered row carries no pattern and no line of the source it read", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  seedViolations(root);
  driver(root, ["--ledger", "commit"]);
  const text = fs.readFileSync(path.join(root, ".jig", "ledger.jsonl"), "utf-8");
  assert.ok(text.trim(), "the run recorded nothing at all");
  // Both halves of what SCOPE keeps out of the ledger: the matcher and the
  // source. Either one, rendered into a report somebody reads back, is text
  // that gets pasted into a file without review.
  const pattern = A.EMPTY_CATCH.detectors.find((d) => d.lever === "check-driver").params.patterns[0];
  assert.equal(text.includes(pattern), false, "the ledger carries the pattern that fired");
  for (const word of ["seeded", "risky"]) {
    assert.equal(text.includes(word), false, "the ledger carries a line of the source it read");
  }
  for (const row of ledgerRows(root)) assert.equal(row.matched, null);
});

test("the lane name is not read as a path to check", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  seedViolations(root);
  // Without the flag's value being taken out of the path list, this run scopes
  // itself to a file called `commit`, finds nothing and exits 0 — a lane that
  // checked nothing and reported a clean bill of health.
  const { status, out } = driverJson(root, ["--ledger", "commit"]);
  assert.equal(status, 1);
  assert.deepEqual(out.findings.map((f) => f.path), ["src/bad.js"]);
});

test("a run that names no lane writes nothing", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  seedViolations(root);
  // The positive control first: a ledger that can never be written is also a
  // ledger no hand run wrote to, and this test would pass for that reason.
  assert.equal(driver(root, ["--ledger", "commit"]).status, 1);
  const written = ledgerRows(root).length;
  assert.ok(written > 0, "the lane run recorded nothing, so the silence below proves nothing");
  assert.equal(driver(root, []).status, 1);
  // The activation note promises a hand run "writes no files and changes
  // nothing", and only the shim passes the flag.
  assert.equal(ledgerRows(root).length, written);
});

// The rows are only worth writing if something reads them back. Before the
// review surface keyed them by class, a class the commit lane caught every day
// was reported as one that had never fired — and offered for retirement on that
// count. Driven end to end, so the driver's row shape and the reader's are
// pinned to each other rather than to a comment.
test("a class the commit lane caught is not a guard that never fired", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  const quiet = engine.cmdReview(root);
  assert.equal(quiet.guards.length, 1);
  assert.equal(quiet.guards[0].otherLanes, 0);
  assert.deepEqual(engine.cmdRerun(root).neverFired, [quiet.guards[0].guardId]);

  stagedThenEdited(root, "src/bad.js", A.EMPTY_CATCH.fixtures.violation, A.EMPTY_CATCH.fixtures.nearMiss);
  assert.equal(driver(root, ["--staged", "--ledger", "commit"]).status, 1);

  const after = engine.cmdReview(root);
  assert.equal(after.guards[0].otherLanes, 1, "the commit-lane catch reached no reporting surface");
  // The session lane's own numbers are untouched: that lane has a denominator
  // and the commit lane has none, so the two never merge.
  assert.equal(after.guards[0].fired, 0);
  assert.equal(after.guards[0].evaluated, 0);
  assert.deepEqual(engine.cmdRerun(root).neverFired, []);
});

test("a ledger that cannot be appended to does not fail the commit", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  seedViolations(root);
  // Any append error would do; a directory where the file goes is the one that
  // reproduces on every platform.
  fs.mkdirSync(path.join(root, ".jig", "ledger.jsonl"));
  const run = driver(root, ["--ledger", "commit"]);
  assert.equal(run.status, 1, "the run died instead of reporting its finding: " + run.stderr);
  assert.match(run.stdout, /src\/bad\.js:\d+ {2}empty-catch/);
  assert.doesNotMatch(run.stderr, /failed to run/);
});

test("the driver writes the ledger the runner reads", () => {
  assert.match(templateOf(path.join(TEMPLATE_DIR, "run.mjs")),
    new RegExp("\"\\.\\.\", \"" + lib.LEDGER_FILE.replace(".", "\\.") + "\""),
    "the driver and the runner name different ledger files");
});

test("a check module that will not load is reported and the others still run", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "bad.js"), "try { x(); } catch {}\n");
  fs.writeFileSync(path.join(root, ".jig", "checks", "broken.check.mjs"), "export const id = ; // not javascript\n");
  const { status, out } = driverJson(root);
  assert.equal(out.broken.length, 1);
  assert.equal(out.findings.length, 1);
  assert.equal(status, 1);
});

test("the driver reads and never writes", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  seedViolations(root);
  const before = snapshot(root);
  driver(root);
  driver(root, ["--selftest"]);
  assert.deepEqual(snapshot(root), before);
});

test("the driver skips its own state directory and node_modules", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.EMPTY_CATCH]);
  fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "try { x(); } catch {}\n");
  const { out } = driverJson(root);
  assert.deepEqual(out.findings, []);
});

// ---------------------------------------------------------------------------
// The lanes run the real work
// ---------------------------------------------------------------------------
//
// DERAIL-PASS defect 15: jig installed a linter, a type checker and a test
// runner and no lane spawned any of them. `.jig/verify.json` is the lane, and
// these are the claims it has to hold: it runs what it names, it is an argv and
// never a shell command line, a tool it cannot start is a gap rather than a
// pass, and a lane nobody put an entry in fails nothing.

function writeVerify(root, entries) {
  fs.mkdirSync(path.join(root, ".jig"), { recursive: true });
  fs.writeFileSync(path.join(root, ".jig", "verify.json"),
    JSON.stringify({ schemaVersion: 1, entries }, null, 2) + "\n");
}

test("the driver runs what a lane names and passes on the exit code it expected", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  writeVerify(root, [
    { id: "clean", argv: [process.execPath, "--version"], expectedExit: 0, paths: [], lanes: ["ci"] },
  ]);
  const run = driver(root, ["--verify", "--lane", "ci"]);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /ok {7}clean/);
  assert.match(run.stdout, /Every command the ci lane names passed/);
});

test("a lane command that exits on anything else fails the lane and shows its output", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  writeVerify(root, [
    { id: "linter", argv: [process.execPath, "-e", "console.log('3 problems'); process.exit(3)"],
      expectedExit: 0, paths: [], lanes: ["ci"] },
  ]);
  const run = driver(root, ["--verify", "--lane", "ci"]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /FAILED {3}linter/);
  assert.match(run.stdout, /exited 3, expected 0/);
  assert.match(run.stdout, /3 problems/);
});

test("a tool the lane cannot start is a gap, never a pass", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  writeVerify(root, [
    { id: "ghosted", argv: ["jig-no-such-tool-9x71"], expectedExit: 0, paths: [], lanes: ["ci"] },
  ]);
  const run = driver(root, ["--verify", "--lane", "ci"]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /NOT RUN {2}ghosted/);
  assert.match(run.stdout, /could not run jig-no-such-tool-9x71/);
});

test("a lane entry is an argv, and no shell ever reads it", () => {
  // SCOPE's derail pass keeps the no-shell stance: the redirection below is an
  // argument to node, not an instruction to a shell, so nothing is written.
  const root = nodeProject();
  install(root, { "no-ci": true });
  writeVerify(root, [
    { id: "redirect", argv: [process.execPath, "-e", "process.exit(0)", ">", "owned.txt"],
      expectedExit: 0, paths: [], lanes: ["ci"] },
  ]);
  const out = driverJson(root, ["--verify", "--lane", "ci"]).out.verify.results[0];
  // Ran, and ran with the redirection still an argument: an entry that never
  // started would leave `owned.txt` absent too, and prove nothing about shells.
  assert.equal(out.ran, true, "the entry never started, so nothing here is about a shell");
  assert.equal(out.passed, true);
  assert.equal(fs.existsSync(path.join(root, "owned.txt")), false, "a lane entry reached a shell");
});

// DERAIL-PASS N7, the lane half. Every shipped JS lane argv starts with `npx`,
// which on Windows is a batch shim Node will not start without a shell — and
// this driver opens none. The engine learned to run the shim's own JS entry;
// until the driver did too, every `--verify-commit` install blocked every commit
// on Windows with three NOT RUN lines nobody could act on.
test("a lane entry behind a batch shim is run through its own JS entry", { skip: process.platform !== "win32" }, () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const shims = path.join(root, "shims");
  const entry = path.join(shims, "node_modules", "npm", "bin", "npx-cli.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(shims, "npx.cmd"), "@echo off\r\n");
  fs.writeFileSync(entry, "process.exit(process.argv[2] === 'ran' ? 0 : 3);\n");
  writeVerify(root, [
    { id: "shimmed", argv: ["npx", "ran"], expectedExit: 0, paths: [], lanes: ["commit"] },
  ]);
  const run = spawnSync(process.execPath, [path.join(root, ".jig", "checks", "run.mjs"), "--verify", "--lane", "commit", "--json"],
    { cwd: root, encoding: "utf-8", windowsHide: true, env: { ...process.env, PATH: shims } });
  const result = JSON.parse(run.stdout).verify.results[0];
  assert.equal(result.ran, true, "the driver could not start npx, so the commit lane blocks every commit: " + result.why);
  assert.equal(result.passed, true);
  assert.equal(run.status, 0);
});

test("only the entries naming this lane run in it", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  writeVerify(root, [
    { id: "ci-only", argv: [process.execPath, "--version"], expectedExit: 0, paths: [], lanes: ["ci"] },
    { id: "both", argv: [process.execPath, "--version"], expectedExit: 0, paths: [], lanes: ["ci", "commit"] },
  ]);
  const commit = driverJson(root, ["--verify", "--lane", "commit"]);
  assert.deepEqual(commit.out.verify.results.map((r) => r.id), ["both"]);
  assert.equal(commit.status, 0);
  const ci = driverJson(root, ["--verify", "--lane", "ci"]);
  assert.deepEqual(ci.out.verify.results.map((r) => r.id), ["ci-only", "both"]);
});

test("a lane nobody put an entry in runs nothing and fails nothing", () => {
  // The commit lane is opt-in: the shim asks for it on every commit, and until
  // an entry names it the answer is that nothing was verified.
  const root = nodeProject();
  install(root, { "no-ci": true });
  assert.equal(fs.existsSync(path.join(root, ".jig", "verify.json")), false);
  const run = driver(root, ["--verify", "--lane", "commit"]);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /No entry names the commit lane/);
});

test("a CI step whose entry has gone from the file proves nothing, and says so", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  writeVerify(root, [
    { id: "kept", argv: [process.execPath, "--version"], expectedExit: 0, paths: [], lanes: ["ci"] },
  ]);
  const run = driver(root, ["--verify", "--lane", "ci", "--entry", "dropped"]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Nothing named dropped runs in the ci lane/);
});

// Planned but not applied where a tool install is in it: applying one runs a
// package manager, and a suite that installs eslint to prove a workflow step
// would be testing npm.
function planWithTools(root, tools, opts) {
  engine.cmdPlan(root, {
    _: [], change: [], authored: A.writeChecks(root, CHECKS), provenance: "elicited",
    edition: "javascript-typescript", "package-manager": "npm", tools, ...(opts || {}),
  });
  return engine.readPlan(engine.planFiles(root)[0]);
}

test("the commit shim asks for the commit lane, and the workflow asks for the CI one", () => {
  const root = nodeProject();
  const payload = planWithTools(root, "eslint");
  const shim = payload.changes.find((c) => c.path === ".jig/hooks/pre-commit");
  assert.match(shim.content, /run\.mjs --verify --lane commit/);
  const yml = payload.changes.find((c) => c.path === ".github/workflows/jig.yml").content;
  assert.match(yml, /- name: run eslint, the way \.jig\/verify\.json names it/);
  assert.match(yml, /run: node \.jig\/checks\/run\.mjs --verify --lane ci --entry eslint/);
});

test("the lane list is written, approved by name, and taken back out by revert", () => {
  const root = nodeProject();
  const payload = planWithTools(root, "eslint");
  const entry = payload.changes.find((c) => c.path === ".jig/verify.json");
  assert.equal(JSON.parse(entry.content).entries[0].id, "eslint");
  // Everything but the install, which would spawn npm.
  const keep = payload.changes.filter((c) => c.kind !== "run-install");
  engine.cmdApply(root, { _: [], change: keep.map((c) => c.id), path: keep.map((c) => c.path) });
  const rel = path.join(root, ".jig", "verify.json");
  assert.equal(JSON.parse(fs.readFileSync(rel, "utf-8")).entries[0].id, "eslint");
  assert.equal(engine.readManifest(root).artifacts.find((a) => a.path === ".jig/verify.json").template.name, "verify");
  engine.cmdRevert(root, { _: [], change: [], all: true });
  assert.equal(fs.existsSync(rel), false, "revert left the lane list behind");
});

// ---------------------------------------------------------------------------
// The witnessed catch
// ---------------------------------------------------------------------------


test("selftest --live watches every installed guard catch its own violation fixture", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  assert.equal(result.witnessed, true);
  const guards = result.probes.filter((p) => p.kind === "guard");
  assert.deepEqual(guards.map((p) => p.probe).sort(),
    ["empty-catch-edit-observe-guard-0", "piped-installer-bash-guard-0"]);
  for (const probe of guards) {
    assert.equal(probe.ran, true, probe.probe + " did not run");
    assert.equal(probe.caught, true, probe.probe + " did not catch its own violation");
    assert.equal(probe.decision, "deny");
    assert.equal(probe.mode, "armed");
    assert.match(probe.what, /violation fixture/);
    assert.match(probe.output, /"decision":"deny"/);
  }
});

// The guard side of the same hazard the driver's own selftest already handles:
// a guard scoped to a directory is not witnessed by a fixture dropped at the
// root, and a close that reports `caught: false` for a guard working exactly as
// installed is the coverage claim inverted.
test("a guard scoped to a directory is witnessed at a path its own globs match", () => {
  const scoped = A.authored({
    id: "scoped-catch",
    title: "A swallowed error under src only",
    detectors: [
      { lever: "edit-observe-guard", actor: "claude-session", confidence: "deterministic",
        params: { patterns: [A.CATCH_PATTERN], paths: ["src/**/*.js"] } },
      { lever: "check-driver", actor: "human-editor", confidence: "deterministic",
        params: { patterns: [A.CATCH_PATTERN], paths: ["src/**/*.js"] } },
    ],
    fixtures: A.EMPTY_CATCH.fixtures,
    deny: A.DENY_CATCH,
  });
  const root = nodeProject();
  install(root, { "no-ci": true }, [scoped]);
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  const probe = result.probes.find((p) => p.probe === "scoped-catch-edit-observe-guard-0");
  assert.equal(probe.caught, true, probe && (probe.why || probe.output));
  assert.equal(result.witnessed, true);
});

// 2.11.0 / C2: an `edit-guard` runs at PreToolUse, and so does a `bash-guard`.
// A probe built from the EVENT hands the edit lever a Bash payload carrying its
// violation as a command, and the close then reports `caught: false` for a guard
// that works. What to send is the detector's lever's answer.
test("an edit guard that denies at PreToolUse is witnessed with the edit it refuses", () => {
  const prevented = A.authored({
    id: "prevented-catch",
    title: "A swallowed error, refused before it is written",
    detectors: [
      { lever: "edit-guard", actor: "claude-session", confidence: "deterministic",
        params: { patterns: [A.CATCH_PATTERN], paths: ["src/**/*.js"] } },
      { lever: "check-driver", actor: "human-editor", confidence: "deterministic",
        params: { patterns: [A.CATCH_PATTERN], paths: ["src/**/*.js"] } },
    ],
    fixtures: A.EMPTY_CATCH.fixtures,
    deny: A.DENY_CATCH,
  });
  const root = nodeProject();
  install(root, { "no-ci": true }, [prevented]);
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  const probe = result.probes.find((p) => p.probe === "prevented-catch-edit-guard-0");
  assert.equal(probe.event, "PreToolUse");
  assert.match(probe.command, /"tool_name":"Write"/);
  assert.equal(probe.caught, true, probe && (probe.why || probe.output));
  assert.equal(result.witnessed, true);
});

// DERAIL-PASS defect 14: the "Me — solo" persona, and slag itself. A check with
// no session detector installs no guard, so a close that only counted guard
// probes reported `witnessed: false` for a correct install — jig calling its own
// coverage unproven, which is the coverage claim inverted.
const DRIVER_ONLY = A.authored({
  id: "driver-only",
  title: "A swallowed error, watched by the checks lane alone",
  detectors: [
    { lever: "check-driver", actor: "human-editor", confidence: "deterministic",
      params: { patterns: [A.CATCH_PATTERN], paths: ["src/**/*.js"] } },
  ],
  fixtures: A.EMPTY_CATCH.fixtures,
  deny: A.DENY_CATCH,
});

test("a checks-only install is witnessed by its own check driver", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [DRIVER_ONLY]);
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  assert.deepEqual(result.probes.filter((p) => p.kind === "guard"), [],
    "the fixture installed a guard, so this test is no longer about a checks-only install");
  assert.equal(result.probes.find((p) => p.kind === "checks").caught, true);
  assert.equal(result.witnessed, true, JSON.stringify(result.notes));
  // Witnessed still means a ledger line, not a decision on screen.
  assert.ok(result.ledger.linesAfter > result.ledger.linesBefore);
  const rows = fs.readFileSync(path.join(root, ".jig", "ledger.jsonl"), "utf-8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.tool, r.decision]), [["check-driver", "verified"]]);
});

test("a repository that has guards still has to see one of them fire", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  assert.ok(result.probes.some((p) => p.kind === "guard"));
  const rows = fs.readFileSync(path.join(root, ".jig", "ledger.jsonl"), "utf-8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.equal(rows.some((r) => r.tool === "check-driver"), false,
    "the driver ledgered a witness in a repository whose guards are the coverage");
});

test("a witnessed catch means a ledger line exists, not just a decision on screen", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  assert.equal(result.ledger.linesBefore, 0);
  assert.ok(result.ledger.linesAfter > 0);
  const rows = fs.readFileSync(path.join(root, ".jig", "ledger.jsonl"), "utf-8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.decision === "deny"));
  assert.ok(rows.every((r) => r.mode === "armed"));
});

test("an observing install is witnessed the same way, and refuses nothing while doing it", () => {
  const root = nodeProject();
  install(root, { "no-ci": true, observe: true });
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  assert.equal(result.witnessed, true);
  for (const probe of result.probes.filter((p) => p.kind === "guard")) {
    assert.equal(probe.caught, true);
    assert.equal(probe.decision, "would-deny");
    assert.equal(probe.mode, "observe");
  }
});

test("without --live nothing runs, and every probe prints the command to run by hand", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const before = snapshot(root);
  const result = engine.cmdSelftest(root, { _: [], change: [] });
  assert.equal(result.witnessed, false);
  assert.deepEqual(snapshot(root), before);
  for (const probe of result.probes) {
    assert.equal(probe.ran, false);
    assert.ok(probe.command.length > 0, probe.probe + " named no command");
    assert.ok(probe.expected.length > 0, probe.probe + " said nothing to look for");
  }
});

test("selftest on a project with no guards says so and does not fail", () => {
  const root = project({});
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  assert.equal(result.ok, true);
  assert.equal(result.witnessed, false);
  assert.ok(result.notes.some((n) => /No guards are installed/.test(n)));
});

test("a missing check driver degrades to the exact command, and the guards still run", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const config = fs.readFileSync(path.join(root, ".jig", "config.json"));
  const checks = fs.readdirSync(path.join(root, ".jig", "checks"))
    .map((f) => [f, fs.readFileSync(path.join(root, ".jig", "checks", f))]);
  fs.rmSync(path.join(root, ".jig", "checks"), { recursive: true, force: true });
  // The guards need their modules; it is the driver that is gone.
  fs.mkdirSync(path.join(root, ".jig", "checks"), { recursive: true });
  for (const [name, bytes] of checks) {
    if (name !== "run.mjs") fs.writeFileSync(path.join(root, ".jig", "checks", name), bytes);
  }
  fs.writeFileSync(path.join(root, ".jig", "config.json"), config);

  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  const driverProbe = result.probes.find((p) => p.kind === "checks");
  assert.equal(driverProbe.ran, false);
  assert.match(driverProbe.why, /is not installed here/);
  assert.equal(driverProbe.command, "node .jig/checks/run.mjs --selftest");
  assert.equal(result.witnessed, true);
  assert.ok(result.notes.some((n) => n.includes("node .jig/checks/run.mjs --selftest")));
});

// The commit lane, executed rather than described. The shim is started the way
// git starts it, over a violation staged in a throwaway clone, so `hookRan`,
// `nodeFound` and `blocked` are three facts rather than three hopes.
test("the commit-lane probe execs the shim in a throwaway clone and reports what it saw", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  const probe = result.probes.find((p) => p.kind === "commit-lane");
  assert.ok(probe, "no commit-lane probe ran for the installed shim");
  if (probe.ran !== true) {
    // Degrade, never stall: a machine with no git, or one whose git predates
    // `hook run`, still gets the command and the thing to look for. Those are
    // the only two excuses — anything else and the probe never executed at all,
    // which is the whole thing this test exists to catch.
    assert.match(probe.why, /git could not be spawned|git init|no `hook run` subcommand/,
      "the commit-lane probe reported ran: false for a reason it never disclosed: " + probe.why);
    assert.ok(probe.command.includes("hook run pre-commit"));
    return;
  }
  assert.equal(probe.hookRan, true);
  assert.equal(probe.nodeFound, true);
  assert.equal(probe.blocked, true, "the shim let a staged violation through: " + probe.output);
  assert.equal(probe.exitCode, 1);
  assert.match(probe.staged, /own violation fixture/);
  // The clone is where the staging happened: the violation never lands in the
  // project, and neither does the lane row the shim writes.
  assert.equal(fs.existsSync(path.join(root, probe.staged.split(" — ")[0])), false);
  assert.equal(fs.existsSync(path.join(root, ".jig", "lane.log")), false);
});

test("only the guards actually installed are probed", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.PIPED_INSTALLER]);
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  assert.deepEqual(result.probes.filter((p) => p.kind === "guard").map((p) => p.probe),
    ["piped-installer-bash-guard-0"]);
});

test("a guard whose check carries no violation fixture is reported unprobed, never skipped", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.PIPED_INSTALLER]);
  // Strip the fixtures out of the installed module: the guard is still there,
  // and a guard nobody watched must not look like a guard that passed.
  const rel = path.join(root, ".jig", "checks", "piped-installer.check.mjs");
  fs.writeFileSync(rel, fs.readFileSync(rel, "utf-8").replace(/^export const fixtures[\s\S]*?^\];?$/m, "export const fixtures = {};"));
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  const probe = result.probes.find((p) => p.kind === "guard");
  assert.equal(probe.ran, false);
  assert.ok(result.notes.some((n) => n.includes(probe.probe)));
});

// ---------------------------------------------------------------------------
// What jig refuses to do for you
// ---------------------------------------------------------------------------

test("apply says out loud that commit-time checks and the permissions are still open", () => {
  const root = nodeProject();
  const { applied } = install(root);
  assert.equal(applied.proposals.length, 2);
  const lane = applied.proposals.find((n) => /activation\.md/.test(n));
  assert.ok(lane, "the commit-lane note is missing");
  // The note leads with what it buys, names the one command, and says plainly
  // that skipping it does not leave the project uncovered.
  assert.match(lane, /at the moment you commit/);
  assert.match(lane, /git config core\.hooksPath \.jig\/hooks/);
  assert.match(lane, /CI still stops the merge/);
  assert.ok(applied.proposals.some((n) => /proposed-permissions\.json/.test(n) && /never edits your settings/.test(n)));
});

test("a repository whose hook already runs the checks gets no commit-lane note", () => {
  const root = nodeProject();
  fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "hooks", "pre-commit"),
    "#!/bin/sh\nnode .jig/checks/run.mjs || exit 1\n");
  const { applied } = install(root);
  assert.equal(applied.proposals.some((n) => /activation\.md/.test(n)), false,
    "jig reported a wiring gap that is not there");
});

test("plan --wire-commit proposes the setting as a named, item-tier change", () => {
  const root = nodeProject();
  spawnSync("git", ["init", "-q"], { cwd: root });
  install(root);

  const plan = engine.cmdPlan(root, { _: [], change: [], "wire-commit": true });
  const wire = plan.changes.find((c) => c.kind === "set-git-config");
  assert.ok(wire, "--wire-commit planned no setting");
  assert.equal(wire.path, engine.GIT_SETTING_PATH);
  assert.equal(wire.value, ".jig/hooks");
  assert.equal(engine.consentFor(wire, []).tier, "item");

  engine.cmdApply(root, { _: [], change: [wire.id], path: [wire.path] });
  const read = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf-8" });
  assert.equal(read.stdout.trim(), ".jig/hooks");
  assert.equal(engine.commitLane(root).state, "live");
});

test("--wire-commit refuses rather than hiding a hook the owner already wrote", () => {
  const root = nodeProject();
  spawnSync("git", ["init", "-q"], { cwd: root });
  install(root);
  fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nnpm run lint\n");

  assert.throws(() => engine.cmdPlan(root, { _: [], change: [], "wire-commit": true }),
    /pointing git elsewhere would stop it running/);

  // And it refuses the no-op too, rather than proposing work already done.
  fs.appendFileSync(path.join(root, ".git", "hooks", "pre-commit"), "node .jig/checks/run.mjs || exit 1\n");
  assert.throws(() => engine.cmdPlan(root, { _: [], change: [], "wire-commit": true }),
    /already run here/);
});

test("a hook that exists but does not run the checks is told to add the line, not to repoint git", () => {
  const root = nodeProject();
  fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nnpm run lint\n");
  const { applied } = install(root);
  const lane = applied.proposals.find((n) => /activation\.md/.test(n));
  assert.match(lane, /You already have a commit hook/);
  assert.equal(/git config core\.hooksPath/.test(lane), false,
    "repointing git would hide the owner's own hook");
});

test("the activation file names both hook shapes and the version-manager hazard", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const text = fs.readFileSync(path.join(root, ".jig", "activation.md"), "utf-8");
  assert.match(text, /node \.jig\/checks\/run\.mjs \|\| exit 1/);
  assert.match(text, /#!\/usr\/bin\/env node/);
  assert.match(text, /fnm, nvm, volta, or asdf/);
});

test("no host settings file is written, read back, or named as a target", () => {
  const root = nodeProject({ ".claude/settings.json": '{"hooks":{}}\n' });
  const before = fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf-8");
  install(root);
  assert.equal(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf-8"), before);
  for (const entry of INDEX.templates) {
    assert.equal(entry.target.includes("settings.json"), false);
  }
});

test("an artifact jig cannot read back is stamped a gap rather than reported as a guarantee", () => {
  const root = nodeProject();
  const { plan } = install(root);
  assert.deepEqual(plan.enforcementGaps.sort(),
    [".github/workflows/jig.yml", ".jig/activation.md", ".jig/hooks/pre-commit"]);
  const manifest = engine.readManifest(root);
  assert.ok(manifest.artifacts.every((a) => a.hash !== null));
});

// ---------------------------------------------------------------------------
// Toolchain probes in the witnessed catch
// ---------------------------------------------------------------------------

test("a tool config is proven by the tool's own verify run, named with its expected exit code", () => {
  // SCOPE, "How is a tool config proven": by running the tool's own
  // `verify.argv`, and `expectedExit` is machine-readable now — but jig does not
  // spawn somebody's linter behind a selftest. It says exactly what to run.
  const root = nodeProject({
    "package.json": "{ \"private\": true, \"devDependencies\": { \"eslint\": \"^9.0.0\" } }\n",
    "package-lock.json": "{ \"lockfileVersion\": 3 }\n",
  });
  const { plan } = install(root, { "no-ci": true, tools: "eslint" });
  assert.equal(plan.toolchain.items[0].present, true);
  assert.ok(plan.changes.some((c) => c.path === "eslint.config.mjs"));

  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  const probe = result.probes.find((p) => p.probe === "toolchain-eslint");
  assert.ok(probe, "no toolchain probe ran for the installed eslint config");
  assert.equal(probe.artifact, "eslint.config.mjs");
  assert.equal(probe.ran, false);
  assert.equal(typeof probe.expectedExit, "number");
  assert.ok(probe.seed, "the probe names no seeded violation to plant");
  assert.match(probe.why, /does not spawn/);
  assert.ok(result.notes.some((n) => n.includes("toolchain-eslint")));
});

// DERAIL-PASS defect 13: the close used to hand the owner a command and call
// that a probe. It still hands over the command — but only for a tool this run
// did not name, and the flag that names one is printed with it.
test("a toolchain probe says which flag would spawn the tool, and spawns nothing without it", () => {
  const root = nodeProject({
    "package.json": "{ \"private\": true, \"devDependencies\": { \"eslint\": \"^9.0.0\" } }\n",
    "package-lock.json": "{ \"lockfileVersion\": 3 }\n",
  });
  install(root, { "no-ci": true, tools: "eslint" });
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  const probe = result.probes.find((p) => p.probe === "toolchain-eslint");
  assert.equal(probe.ran, false);
  assert.equal(probe.caught, undefined);
  assert.match(probe.why, /--toolchain eslint/);
  // Nothing spawned means nothing planted, and no seed directory left over.
  assert.equal(fs.existsSync(path.join(root, ".jig", "selftest")), false);
});

test("a repository with no installed tool config gets no toolchain probe at all", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  assert.deepEqual(result.probes.filter((p) => p.kind === "toolchain"), []);
});

// ---------------------------------------------------------------------------
// The activation doc keeps step with the lane
// ---------------------------------------------------------------------------
//
// `--wire-commit` runs as its own plan AFTER the install, because git cannot be
// pointed at a hook that does not exist yet. So `.jig/activation.md` is written
// while the lane really is dead, and before this nothing ever went back to
// correct it. A file that hands the owner a task they no longer have is the
// same failure jig exists to prevent, one level up.

function wireCommit(root) {
  const plan = engine.cmdPlan(root, { _: [], change: [], "wire-commit": true });
  const ids = plan.changes.map((c) => c.id);
  const paths = plan.changes.map((c) => c.path);
  engine.cmdApply(root, { _: [], change: ids, path: paths });
  return plan;
}

test("the wiring plan rewrites the activation doc in the same plan that makes it stale", () => {
  const root = nodeProject();
  spawnSync("git", ["init", "-q"], { cwd: root });
  install(root);

  const before = fs.readFileSync(path.join(root, ".jig", "activation.md"), "utf-8");
  assert.match(before, /Let jig do it/, "the unwired doc should offer the wiring");

  const plan = wireCommit(root);
  assert.ok(plan.changes.some((c) => c.kind === "set-git-config"), "--wire-commit planned no setting");
  assert.equal(engine.commitLane(root).state, "live");

  const after = fs.readFileSync(path.join(root, ".jig", "activation.md"), "utf-8");
  assert.match(after, /Commit-time checks are running/);
  assert.match(after, /Nothing here is a task/);
  assert.match(after, /git config --unset core\.hooksPath/);
  // The sentence that sent the owner to ask a session whether they had to act.
  assert.equal(/one step jig leaves to you/.test(after), false);
  assert.equal(/Let jig do it/.test(after), false);
});

test("a rewritten artifact leaves one manifest row for its path, not two", () => {
  const root = nodeProject();
  spawnSync("git", ["init", "-q"], { cwd: root });
  install(root);
  wireCommit(root);

  const rows = engine.readManifest(root).artifacts.filter((a) => a.path === ".jig/activation.md");
  assert.equal(rows.length, 1, "the rewrite left a stale row claiming the same path");
  assert.equal(rows[0].template.name, "activation-wired");
  // The manifest now says why the file is there in words, not by template name.
  assert.match(rows[0].rationale, /commit time/);
});

test("each route gets the way back from the thing it actually did", () => {
  const root = nodeProject();
  assert.equal(engine.activationFace(root, {}), "activation");
  assert.equal(engine.activationFace(root, { "wire-commit": true }), "activation-wired");
  // Weaving puts one line into a hook the owner already had, and taking that
  // line back out is not unsetting core.hooksPath.
  assert.equal(engine.activationFace(root, { "weave-precommit": true }), "activation-woven");
});

test("a second interview on a wired repository is never offered the unwired text", () => {
  const root = nodeProject();
  spawnSync("git", ["init", "-q"], { cwd: root });
  install(root, { "no-ci": true });
  wireCommit(root);

  // Not `--refresh-activation`, not `--wire-commit`: an ordinary re-run. It used
  // to re-propose the doc that tells the owner to switch on checks that have
  // been running since the last plan.
  assert.equal(engine.activationFace(root, {}), "activation-wired");
  const plan = engine.cmdPlan(root, {
    _: [], change: [], authored: A.writeChecks(root, [A.HEURISTIC_ONLY]), provenance: "elicited", "no-ci": true,
  });
  const record = JSON.parse(fs.readFileSync(path.join(root, ".jig", "plan-" + plan.planId + ".json"), "utf-8"));
  const act = record.changes.find((c) => c.path === ".jig/activation.md");
  assert.ok(act, "the re-run planned no activation doc at all");
  assert.equal(act.template.name, "activation-wired");
  assert.match(act.content, /Commit-time checks are running/);
});

test("a repository wired under an older jig can be put back in step without being rewired", () => {
  const root = nodeProject();
  spawnSync("git", ["init", "-q"], { cwd: root });
  install(root);

  // Wired the manual way, which is exactly what an older jig told people to do.
  spawnSync("git", ["config", "core.hooksPath", ".jig/hooks"], { cwd: root });
  assert.equal(engine.commitLane(root).state, "live");
  assert.match(fs.readFileSync(path.join(root, ".jig", "activation.md"), "utf-8"), /Let jig do it/);

  const plan = engine.cmdPlan(root, { _: [], change: [], "refresh-activation": true });
  const row = plan.changes.find((c) => c.path === ".jig/activation.md");
  assert.ok(row, "--refresh-activation planned no rewrite");
  engine.cmdApply(root, { _: [], change: [row.id], path: [row.path] });

  const after = fs.readFileSync(path.join(root, ".jig", "activation.md"), "utf-8");
  assert.match(after, /Commit-time checks are running/);
  // Nothing was rewired. The setting is whatever it already was.
  assert.equal(engine.commitLane(root).state, "live");
});

test("refresh refuses rather than proposing nothing, and says which case it is", () => {
  const root = nodeProject();
  spawnSync("git", ["init", "-q"], { cwd: root });
  install(root);

  assert.throws(() => engine.cmdPlan(root, { _: [], change: [], "refresh-activation": true }),
    /commit-time checks do not run here yet/);

  wireCommit(root);
  assert.throws(() => engine.cmdPlan(root, { _: [], change: [], "refresh-activation": true }),
    /already says the checks are running/);
});

test("a file the owner edited is refused rather than rewritten out from under them", () => {
  const root = nodeProject();
  spawnSync("git", ["init", "-q"], { cwd: root });
  install(root);
  const file = path.join(root, ".jig", "activation.md");
  fs.appendFileSync(file, "\nOur team also runs the linter by hand on Fridays.\n");

  const plan = engine.cmdPlan(root, { _: [], change: [], "wire-commit": true });
  assert.equal(plan.changes.some((c) => c.path === ".jig/activation.md"), false,
    "an edited file was planned for overwrite");
  assert.ok(plan.refused.some((r) => /activation\.md/.test(r) && /yours now/.test(r)),
    "the refusal was not reported");
  // The setting is still proposed: the doc being theirs does not block the wiring.
  assert.ok(plan.changes.some((c) => c.kind === "set-git-config"));
  assert.match(fs.readFileSync(file, "utf-8"), /Fridays/);
});

test("the unwired doc no longer claims jig cannot do the wiring", () => {
  const root = nodeProject();
  install(root);
  const text = fs.readFileSync(path.join(root, ".jig", "activation.md"), "utf-8");
  assert.equal(/one step jig leaves to you/.test(text), false);
  assert.equal(/which jig never touches/.test(text), false);
  // The route jig can actually take comes first; the manual one is the fallback.
  assert.ok(text.indexOf("Let jig do it") < text.indexOf("Or do it by hand"));
  // The route it names has to be one the owner can actually take. Nothing puts
  // `jig` on a PATH, so a doc printing `jig plan --wire-commit` was printing a
  // command that answers "command not found".
  assert.match(text, /\/jig:jig/);
  assert.equal(/^\s*jig .*--wire-commit/m.test(text), false,
    "the activation doc hands out a `jig …` command nothing puts on a PATH");
});

test("a wiring plan never proposes a guard config, because it would be an empty one", () => {
  const root = nodeProject();
  spawnSync("git", ["init", "-q"], { cwd: root });
  install(root, { "no-ci": true });
  const before = JSON.parse(fs.readFileSync(path.join(root, ".jig", "config.json"), "utf-8")).guards.length;
  assert.ok(before > 0, "the fixture installed no guards, so this proves nothing");

  const wire = engine.cmdPlan(root, { _: [], change: [], "wire-commit": true });
  assert.equal(wire.changes.some((c) => c.kind === "write-config"), false,
    "a plan carrying no selection proposed a guard config, which can only be an empty one");

  // The whole plan, approved the way a skill walking both consent tiers would.
  engine.cmdApply(root, { _: [], change: wire.changes.map((c) => c.id), path: wire.changes.map((c) => c.path) });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".jig", "config.json"), "utf-8")).guards.length, before,
    "approving the wiring silently disarmed the guards");
  assert.equal(engine.commitLane(root).state, "live");
});

// ---------------------------------------------------------------------------
// What the reports say, and whether it is true (2.7.2)
// ---------------------------------------------------------------------------
//
// One story under seven fixes: a report is not allowed to claim a state jig can
// read and has not read. Each test below is the state, read.

test("the kill switch is the whole answer for the session lane", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  assert.equal(engine.cmdReview(root).lanes.session.runs, true);

  fs.writeFileSync(path.join(root, ".jig", "off"), "");
  const session = engine.cmdReview(root).lanes.session;
  // Every hook exits before it reads a guard while this file is there, so a
  // lane report that read the config and not the file said guards were running
  // when nothing was.
  assert.equal(session.runs, false);
  assert.equal(session.observing, false);
  assert.equal(session.off, true);
  assert.match(session.offSince, /^\d{4}-\d\d-\d\dT/);
  // And inventory, which reads the same lanes.
  assert.equal(engine.cmdInventory(root).lanes.session.off, true);
});

test("the CI lane is read from the workflow, not from the workflow file existing", () => {
  const root = nodeProject();
  install(root);
  const wf = path.join(root, ".github", "workflows", "jig.yml");
  assert.ok(fs.existsSync(wf), "the fixture installed no workflow, so this proves nothing");
  let ci = engine.cmdReview(root).lanes.ci;
  assert.equal(ci.runs, true);
  assert.equal(ci.state, "live");
  assert.equal(ci.path, ".github/workflows/jig.yml");

  // The owner's now: still jig's workflow, and no longer a file jig can vouch
  // for line by line. It runs the driver, so the lane runs — and the report
  // says whose file it is rather than passing it off as jig's.
  fs.appendFileSync(wf, "\n# tightened by hand\n");
  ci = engine.cmdInventory(root).lanes.ci;
  assert.equal(ci.runs, true);
  assert.equal(ci.state, "drifted");

  // Edited into something that no longer runs the checks. This is the one that
  // used to report as live coverage from `existsSync` alone.
  fs.writeFileSync(wf, "name: ci\non: push\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
  ci = engine.cmdReview(root).lanes.ci;
  assert.equal(ci.runs, false);
  assert.equal(ci.state, "unwired");

  fs.rmSync(wf);
  ci = engine.cmdReview(root).lanes.ci;
  assert.equal(ci.runs, false);
  assert.equal(ci.state, "absent");
  assert.equal(ci.path, null);
});

test("a guard demoted out of armed is reported as demoted by review and inventory", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const armed = engine.cmdReview(root).guards.find((g) => g.mode === "armed");
  assert.ok(armed, "the fixture installed no armed guard, so this proves nothing");
  assert.equal(armed.demoted, null);

  // A second project, because a check is loaded once per process: drifting the
  // one this process already read would compare the module against itself.
  const drifted = nodeProject();
  install(drifted, { "no-ci": true });
  fs.appendFileSync(path.join(drifted, ".jig", "checks", armed.check + ".check.mjs"), "\n// widened by hand\n");
  for (const surface of [engine.cmdReview(drifted), engine.cmdInventory(drifted)]) {
    const row = surface.guards.find((g) => g.guardId === armed.guardId);
    assert.equal(row.mode, "observe");
    assert.match(row.demoted, /does not match the check on disk/,
      "the config still says armed and the surface never said the guard was pulled back");
  }
});

test("the git setting's state is read from git, not from a path nothing answers", () => {
  const root = nodeProject();
  spawnSync("git", ["init", "-q"], { cwd: root });
  install(root, { "no-ci": true });
  const wire = engine.cmdPlan(root, { _: [], change: [], "wire-commit": true });
  engine.cmdApply(root, { _: [], change: wire.changes.map((c) => c.id), path: wire.changes.map((c) => c.path) });
  assert.equal(engine.commitLane(root).state, "live");

  const row = engine.cmdInventory(root).artifacts.find((a) => a.path === engine.GIT_SETTING_PATH);
  // `git:core.hooksPath` is not a file. Asking the disk about it returned null,
  // and inventory called the live lane `retired`.
  assert.equal(row.state, "active");

  spawnSync("git", ["config", "--unset", engine.GIT_SETTING], { cwd: root });
  assert.equal(engine.cmdInventory(root).artifacts.find((a) => a.path === engine.GIT_SETTING_PATH).state, "retired");
});

test("the hook shim is written executable and the lane says whether git can run it", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const shim = path.join(root, ".jig", "hooks", "pre-commit");
  if (process.platform === "win32") {
    // No exec bit here, and a synthesised mode is not an answer — the lane says
    // "not something this platform can be asked" rather than reporting `false`.
    assert.equal(engine.commitLane(root).executable, null);
  } else {
    assert.notEqual(fs.statSync(shim).mode & 0o111, 0, "git cannot run the hook jig wrote");
  }

  // The skip leaves a trace. A lane that goes quiet because node is missing and
  // a lane that never ran are the same silence otherwise.
  const text = fs.readFileSync(shim, "utf-8");
  assert.match(text, /node is not on PATH here[^\n]*>&2/);
  assert.match(text, /lane_log "skipped node-not-on-path"/);
  assert.match(text, /lane_log "ran"/);
  assert.match(text, /\.jig\/lane\.log/);
  // Machine-local, like every other derived record under `.jig/`.
  assert.match(fs.readFileSync(path.join(root, ".jig", ".gitignore"), "utf-8"), /^lane\.log$/m);
});

test("review answers plainly where nothing is installed instead of throwing ENOENT", () => {
  const root = nodeProject();
  const review = engine.cmdReview(root);
  assert.equal(review.ok, true);
  assert.equal(review.installed, false);
  assert.deepEqual(review.guards, []);
  assert.match(review.why, /no \.jig\/config\.json/);

  // Both surfaces read one truth. Inventory used to rethrow the raw ENOENT;
  // now that review answers it, inventory must not answer instead with an empty
  // guard list and a null problem, which reads as "everything was retired".
  const inv = engine.cmdInventory(root);
  assert.equal(inv.installed, false);
  assert.match(inv.why, /no \.jig\/config\.json/);
  assert.deepEqual(inv.guards, []);

  // A config that exists and cannot be read is still a refusal: that one IS
  // broken, and saying "nothing installed" about it would hide the damage.
  fs.mkdirSync(path.join(root, ".jig"), { recursive: true });
  fs.writeFileSync(path.join(root, ".jig", "config.json"), "{ not json\n");
  assert.throws(() => engine.cmdReview(root), /not valid JSON/);
  const refused = engine.cmdInventory(root);
  assert.equal(refused.installed, true, "a repository whose config jig refused is installed and broken, not absent");
  assert.match(refused.guardsProblem, /not valid JSON/);
  assert.equal(refused.why, null);
});

test("a selftest over no runnable check exits 1 and says nothing was proven", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  assert.equal(driver(root, ["--selftest"]).status, 0);

  for (const name of fs.readdirSync(path.join(root, ".jig", "checks"))) {
    if (name.endsWith(".check.mjs")) fs.rmSync(path.join(root, ".jig", "checks", name));
  }
  const run = driver(root, ["--selftest"]);
  // Nothing ran is not the same as nothing failed, and the old report said the
  // second about the first.
  assert.equal(run.status, 1);
  assert.equal(/Every runnable check caught its own violation/.test(run.stdout), false);
  assert.match(run.stdout, /nothing here is proven/);
});

test("a plan whose every check was discarded refuses rather than wiring empty lanes", () => {
  const root = nodeProject();
  const neverFires = A.authored({
    id: "never-fires",
    title: "A check whose pattern does not match its own violation",
    detectors: [
      { lever: "check-driver", actor: "human-editor", confidence: "deterministic",
        params: { patterns: ["zzz-nothing-here"], paths: ["**/*.js"] } },
    ],
    fixtures: { violation: "const a = 1;\n", nearMiss: "const b = 2;\n" },
    deny: A.DENY_CATCH,
  });
  // A driver, a hook and a CI workflow over zero check modules is a green lane
  // over no coverage — the coverage claim SCOPE forbids, made by omission.
  assert.throws(() => install(root, { "no-ci": true }, [neverFires]),
    /discarded at admission.*nothing for them to run.*Nothing was planned/s);
  assert.equal(fs.existsSync(path.join(root, ".jig", "checks", "run.mjs")), false);
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "jig.yml")), false);

  // With a tool ticked the answer is narrower: the lanes have nothing to run
  // and are dropped, and the linter the owner approved by name is still
  // installed. Throwing the whole plan away would discard an answer they gave.
  // Planned rather than applied: applying it would try to spawn npm, which is a
  // separate refusal on win32 and not what this is about.
  const withTool = nodeProject({ "package-lock.json": "{ \"lockfileVersion\": 3 }\n" });
  const plan = engine.cmdPlan(withTool, {
    _: [], change: [], provenance: "elicited", "no-ci": true, tools: "eslint",
    authored: A.writeChecks(withTool, [neverFires]),
  });
  assert.equal(plan.changes.some((c) => c.path === ".jig/checks/run.mjs"), false,
    "a driver was planned over zero check modules");
  assert.ok(plan.changes.some((c) => c.kind === "run-install" && c.id.startsWith("install-eslint")),
    "the ticked linter was discarded along with the checks");
  assert.ok(plan.refused.some((r) => /discarded at admission/.test(r)),
    "the dropped lanes were not disclosed");
  // And still no guard config: computed from an empty selection it would hold
  // no guards, and approving it would disarm the repository.
  assert.equal(plan.changes.some((c) => c.kind === "write-config"), false,
    "a plan with no coverage proposed a guard config");
});

// ---------------------------------------------------------------------------
// What the driver says when it could not do the whole job

test("a walk that hits the file ceiling is disclosed and never exits as a clean pass", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const driverPath = path.join(root, ".jig", "checks", "run.mjs");
  // The ceiling is 20000 files, and writing 20001 of them per run buys nothing
  // the constant does not. Substituting a small one is the whole patch: the
  // truncation path exercised below is the shipped one, byte for byte.
  const shrunk = fs.readFileSync(driverPath, "utf-8").replace("const MAX_FILES = 20000;", "const MAX_FILES = 3;");
  assert.match(shrunk, /const MAX_FILES = 3;/, "the driver no longer declares its ceiling where this test patches it");
  fs.writeFileSync(driverPath, shrunk);
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(root, "f" + i + ".js"), "const a = " + i + ";\n");

  const run = driver(root);
  assert.equal(run.status, 1, "a partial scan exited 0, which every caller reads as a full pass");
  assert.match(run.stdout, /PARTIAL {2}the walk stopped at 3 files/);
  assert.match(run.stdout, /partial scan, not a pass/);
  assert.equal(/\nNo findings\.\n/.test(run.stdout), false, "a partial scan reported itself clean");
  assert.equal(driverJson(root).out.truncated, true);
});

test("a walk that read the whole project says nothing about truncation", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const run = driverJson(root);
  assert.equal(run.status, 0);
  assert.equal(run.out.truncated, false);
  assert.match(driver(root).stdout, /\nNo findings\.\n/);
});

test("the driver crashing exits 0, says nothing was checked, and leaves a lane-log row", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const driverPath = path.join(root, ".jig", "checks", "run.mjs");
  // A top-level crash has no natural trigger: every failure the driver expects
  // — an unreadable checks directory, a module that will not import, a check
  // that throws — is already caught and reported where it happens. Planting one
  // is the only way the handler behind all of them is exercised at all.
  const source = fs.readFileSync(driverPath, "utf-8");
  const crashing = source.replace("  const out = await runChecks(ROOT, paths, argv.includes(\"--staged\"));",
    "  throw new Error(\"planted driver crash\");");
  assert.notEqual(crashing, source, "the driver no longer runs its checks where this test plants the crash");
  fs.writeFileSync(driverPath, crashing);

  const run = driver(root);
  assert.equal(run.status, 0, "a driver that could not run stopped somebody committing");
  assert.match(run.stderr, /jig checks failed to run, so nothing was checked: planted driver crash/);
  const lane = fs.readFileSync(path.join(root, ".jig", "lane.log"), "utf-8");
  assert.match(lane, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ checks crashed planted driver crash$/m);
});
