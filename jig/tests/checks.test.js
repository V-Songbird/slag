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
const A = require("./authored.js");

const TEMPLATE_DIR = path.join(__dirname, "..", "scripts", "templates");
const INDEX = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, "templates.json"), "utf-8"));

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
  for (const entry of INDEX.templates) {
    if (!fs.existsSync(path.join(root, entry.target))) continue;
    const installed = fs.readFileSync(path.join(root, entry.target), "utf-8").replace(/\r\n/g, "\n");
    const source = fs.readFileSync(path.join(TEMPLATE_DIR, entry.file), "utf-8").replace(/\r\n/g, "\n");
    assert.equal(installed, source, entry.name + " was not copied out verbatim");
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
      "proof", "provenance", "state", "template", "txId",
    ]);
    assert.equal(row.txId, applied.tx);
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
  const again = engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
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

test("a repository with no installed tool config gets no toolchain probe at all", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  assert.deepEqual(result.probes.filter((p) => p.kind === "toolchain"), []);
});
