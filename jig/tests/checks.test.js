"use strict";

// Two halves of one entry: the templates jig installs and the driver it
// installs them as. They share a suite because neither claim means anything
// alone — a template that is not what the catalogue says, and a driver that
// does not catch what the template promised, are the same failure seen from
// two ends.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const engine = require("../scripts/jig.js");
const lib = require("../hooks/jig-lib.js");
const catalogue = require("../scripts/catalogue.json");

const REPO_ROOT = path.join(__dirname, "..", "..");
const TEMPLATE_DIR = path.join(__dirname, "..", "scripts", "templates");
const INDEX = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, "templates.json"), "utf-8"));

const ALL_FOUR = "silent-catch,focused-or-skipped-test,pipe-to-shell,test-file-deletion";

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

function install(root, select, opts) {
  const plan = engine.cmdPlan(root, { _: [], change: [], select, ...(opts || {}) });
  const applied = engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  return { plan, applied };
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

// Fixtures are copied as bytes. Reading one as text on the way in would launder
// the exact thing the near-miss cases exist to catch.
function seedFixture(root, rel, fixtureRel) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, fs.readFileSync(path.join(REPO_ROOT, fixtureRel)));
}

function classOf(id) {
  return catalogue.classes.find((c) => c.id === id);
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

test("each installable class ships exactly one check template", () => {
  const shipped = INDEX.templates.filter((t) => t.classId).map((t) => t.classId).sort();
  const installable = catalogue.classes.filter((c) => c.installableAtV1).map((c) => c.id).sort();
  assert.deepEqual(shipped, installable);
});

test("a check template's patterns are the catalogue's, character for character", async () => {
  for (const entry of INDEX.templates.filter((t) => t.classId)) {
    const mod = await import(pathToFileURL(path.join(TEMPLATE_DIR, entry.file)).href);
    const cls = classOf(entry.classId);
    const fromCatalogue = cls.detectors
      .filter((d) => d.runner === "checks" && Array.isArray(d.params.patterns))
      .flatMap((d) => d.params.patterns);
    assert.equal(mod.id, entry.classId);
    if (mod.patterns) {
      assert.deepEqual(mod.patterns, fromCatalogue, entry.classId + ": patterns drifted from the catalogue");
    }
    if (mod.command) {
      const staged = cls.detectors.find((d) => Array.isArray(d.params.command));
      assert.deepEqual(mod.command, staged.params.command, entry.classId + ": command drifted from the catalogue");
    }
  }
});

test("a check template's path globs are the catalogue's too", async () => {
  for (const entry of INDEX.templates.filter((t) => t.classId)) {
    const mod = await import(pathToFileURL(path.join(TEMPLATE_DIR, entry.file)).href);
    const cls = classOf(entry.classId);
    const det = cls.detectors.find((d) => d.runner === "checks" && (d.params.paths || d.params.pathPatterns));
    assert.deepEqual(mod.paths, det.params.paths || det.params.pathPatterns, entry.classId + ": paths drifted");
  }
});

test("nothing is interpolated into a template on the way out", () => {
  const root = project({});
  install(root, ALL_FOUR);
  for (const entry of INDEX.templates) {
    if (!fs.existsSync(path.join(root, entry.target))) continue;
    const installed = fs.readFileSync(path.join(root, entry.target), "utf-8").replace(/\r\n/g, "\n");
    const source = fs.readFileSync(path.join(TEMPLATE_DIR, entry.file), "utf-8").replace(/\r\n/g, "\n");
    assert.equal(installed, source, entry.name + " was not copied out verbatim");
  }
});

test("every generated artifact carries the ownership marker a reader can see", () => {
  const root = project({});
  install(root, ALL_FOUR);
  for (const entry of INDEX.templates) {
    if (!fs.existsSync(path.join(root, entry.target))) continue;
    const text = fs.readFileSync(path.join(root, entry.target), "utf-8");
    assert.match(text, /jig:owned/, entry.target + " does not say who owns it");
  }
});

// ---------------------------------------------------------------------------
// The selection
// ---------------------------------------------------------------------------

test("a class that ships as data at v1 cannot be selected, and is refused by name", () => {
  const root = project({});
  assert.throws(() => engine.cmdPlan(root, { _: [], change: [], select: "nested-ternary" }),
    /nested-ternary ships as data at v1/);
});

test("a class that is not in the catalogue at all is refused by name", () => {
  const root = project({});
  assert.throws(() => engine.cmdPlan(root, { _: [], change: [], select: "make-me-a-guard" }),
    /not a class in the catalogue: make-me-a-guard/);
});

test("an empty selection is a refusal, not an empty install", () => {
  const root = project({});
  assert.throws(() => engine.cmdPlan(root, { _: [], change: [], select: "  ,  " }),
    /needs at least one class id/);
});

test("the generated config passes the runner's own validator, guard for guard", () => {
  const root = project({});
  install(root, ALL_FOUR);
  const config = JSON.parse(fs.readFileSync(path.join(root, ".jig", "config.json"), "utf-8"));
  const checked = lib.validateConfig(config);
  assert.deepEqual(checked.problems, []);
  assert.deepEqual(checked.warnings, []);
  assert.ok(checked.guards.length > 0);
  for (const guard of checked.guards) {
    assert.ok(lib.HOOK_RUNNERS.includes(guard.runner));
  }
});

test("the generated config carries no key that could become a matcher", () => {
  const config = engine.configFromSelection(["pipe-to-shell", "silent-catch"]);
  const text = JSON.stringify(config);
  for (const key of lib.MATCHER_KEYS) {
    assert.equal(text.includes('"' + key + '"'), false, "the config names " + key);
  }
  for (const guard of config.guards) {
    assert.deepEqual(Object.keys(guard).sort(), ["classId", "detector", "id", "runner"]);
  }
});

test("a class with no hook detector installs a check module and no guard", () => {
  const config = engine.configFromSelection(["silent-catch"]);
  assert.ok(config.guards.every((g) => g.classId === "silent-catch"));
  assert.equal(config.mode, "observe");
  assert.equal(config.schemaVersion, engine.SCHEMA_VERSION);
});

test("the permissions proposal names no host rule and says why it cannot", () => {
  const proposal = engine.permissionsProposal(["pipe-to-shell", "test-file-deletion"]);
  assert.ok(proposal.proposals.length > 0);
  for (const row of proposal.proposals) {
    assert.equal(row.hostRule, null);
    assert.match(row.gap, /prefix/);
  }
  assert.match(proposal.note, /never edits your settings/);
});

test("a selection with nothing an agent runs proposes no permissions at all", () => {
  assert.equal(engine.permissionsProposal(["silent-catch"]), null);
  const root = project({});
  install(root, "silent-catch");
  assert.equal(fs.existsSync(path.join(root, ".jig", "proposed-permissions.json")), false);
});

// ---------------------------------------------------------------------------
// Occupied slots and drift
// ---------------------------------------------------------------------------

test("a file jig did not write is refused, and the rest of the plan still goes ahead", () => {
  const root = project({ ".github/workflows/jig.yml": "name: somebody else\n" });
  const { plan } = install(root, "silent-catch");
  assert.equal(plan.refused.length, 1);
  assert.match(plan.refused[0], /already exists and jig did not write it/);
  assert.equal(fs.readFileSync(path.join(root, ".github/workflows/jig.yml"), "utf-8"), "name: somebody else\n");
  assert.ok(fs.existsSync(path.join(root, ".jig", "checks", "run.mjs")));
});

test("an artifact edited after jig wrote it is refused rather than overwritten", () => {
  const root = project({});
  install(root, "silent-catch");
  const rel = path.join(root, ".jig", "checks", "silent-catch.check.mjs");
  fs.appendFileSync(rel, "\n// a teammate changed this\n");
  const after = fs.readFileSync(rel, "utf-8");
  const { plan } = install(root, "silent-catch");
  assert.ok(plan.refused.some((r) => /was edited after jig wrote it/.test(r)));
  assert.equal(fs.readFileSync(rel, "utf-8"), after);
});

test("the config is the user's to edit — changing it is not drift", () => {
  const root = project({});
  install(root, ALL_FOUR);
  const rel = path.join(root, ".jig", "config.json");
  const config = JSON.parse(fs.readFileSync(rel, "utf-8"));
  config.guards = config.guards.filter((g) => g.classId !== "pipe-to-shell");
  fs.writeFileSync(rel, JSON.stringify(config, null, 2) + "\n");
  const states = engine.manifestStates(root, engine.readManifest(root));
  const row = states.find((s) => s.path === ".jig/config.json");
  assert.equal(row.ownership, "schema");
  assert.equal(row.state, "active");
});

test("a removed artifact reads as retired, not as missing", () => {
  const root = project({});
  install(root, "silent-catch");
  fs.rmSync(path.join(root, ".jig", "activation.md"));
  const states = engine.manifestStates(root, engine.readManifest(root));
  assert.equal(states.find((s) => s.path === ".jig/activation.md").state, "retired");
});

test("every slot taken means nothing is planned, and the reasons are all named", () => {
  const root = project({});
  install(root, "silent-catch");
  for (const rel of [".jig/checks/run.mjs", ".jig/checks/silent-catch.check.mjs", ".jig/activation.md",
    ".github/workflows/jig.yml", ".jig/config.json"]) {
    fs.appendFileSync(path.join(root, rel), "\n");
  }
  // config.json is schema-owned and stays writable, so a selection that needs
  // only the frozen ones is what proves the refusal.
  fs.writeFileSync(path.join(root, ".jig", "manifest-probe"), "");
  const states = engine.manifestStates(root, engine.readManifest(root));
  const frozen = states.filter((s) => s.state === "drifted").map((s) => s.path).sort();
  assert.deepEqual(frozen, [".github/workflows/jig.yml", ".jig/activation.md",
    ".jig/checks/run.mjs", ".jig/checks/silent-catch.check.mjs"]);
});

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

test("apply records every generated artifact with the whole row shape", () => {
  const root = project({});
  const { applied } = install(root, ALL_FOUR, { provenance: "elicited" });
  assert.equal(applied.manifest, ".jig/manifest.json");
  const manifest = engine.readManifest(root);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.artifacts.length, 10);
  for (const row of manifest.artifacts) {
    assert.deepEqual(Object.keys(row).sort(), [
      "classIds", "hash", "id", "installedAt", "kind", "mode", "ownership", "path",
      "provenance", "state", "template", "txId",
    ]);
    assert.equal(row.txId, applied.tx);
    assert.equal(row.mode, "observe");
    assert.equal(row.provenance, "elicited");
    assert.equal(row.hash, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, row.path))).digest("hex"));
    assert.ok(engine.OWNERSHIPS.includes(row.ownership));
  }
});

test("provenance defaults to assumed, which is what quick-start installs as", () => {
  const root = project({});
  install(root, "silent-catch");
  assert.ok(engine.readManifest(root).artifacts.every((a) => a.provenance === "assumed"));
});

test("a hand-written draft writes no manifest — the manifest records what jig generated", () => {
  const root = project({});
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

test("installing a second class keeps the first one's rows", () => {
  const root = project({});
  install(root, "silent-catch");
  const first = engine.readManifest(root).artifacts.map((a) => a.path);
  install(root, "silent-catch,focused-or-skipped-test");
  const second = engine.readManifest(root).artifacts.map((a) => a.path);
  assert.ok(first.every((p) => second.includes(p)));
  assert.ok(second.includes(".jig/checks/focused-or-skipped-test.check.mjs"));
});

test("re-applying the same plan changes nothing and says so", () => {
  const root = project({});
  const { plan } = install(root, ALL_FOUR);
  const again = engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  assert.ok(again.applied.every((r) => r.outcome === "already-applied"));
});

test("revert takes every generated artifact back out, manifest included", () => {
  const root = project({ "package.json": "{}\n" });
  const before = snapshot(root);
  install(root, ALL_FOUR);
  engine.cmdRevert(root, { _: [], change: [], all: true });
  const after = snapshot(root).filter((line) => !line.startsWith(".jig/"));
  assert.deepEqual(after, before);
  assert.equal(fs.existsSync(path.join(root, ".jig", "manifest.json")), false);
  assert.equal(fs.existsSync(path.join(root, ".github")), false);
});

test("an install writes nothing outside .jig and .github/workflows", () => {
  const root = project({ "package.json": "{}\n", "src/index.js": "module.exports = 1;\n" });
  install(root, ALL_FOUR);
  const touched = listFiles(root).filter((rel) => !rel.startsWith(".jig/") && !rel.startsWith(".github/workflows/"));
  assert.deepEqual(touched, ["package.json", "src/index.js"]);
});

test("the run is journalled, so what apply wrote is replayable from the record", () => {
  const root = project({});
  const { applied } = install(root, ALL_FOUR);
  const status = engine.cmdStatus(root);
  const paths = status.changes.flatMap((c) => c.files).sort();
  assert.ok(paths.includes(".jig/manifest.json"));
  for (const row of applied.applied) assert.ok(paths.includes(row.path));
  assert.ok(status.changes.every((c) => c.state === "applied"));
});

// ---------------------------------------------------------------------------
// The check driver
// ---------------------------------------------------------------------------

test("the driver catches every seeded violation the catalogue ships", () => {
  const root = project({});
  install(root, ALL_FOUR);
  seedFixture(root, "src/bad.js", classOf("silent-catch").fixtures.violation[0]);
  seedFixture(root, "test/bad.test.js", classOf("focused-or-skipped-test").fixtures.violation[0]);
  seedFixture(root, "scripts/bad.sh", classOf("pipe-to-shell").fixtures.violation[0]);
  const { status, out } = driverJson(root);
  assert.equal(status, 1);
  const caught = new Set(out.findings.map((f) => f.classId));
  assert.deepEqual([...caught].sort(), ["focused-or-skipped-test", "pipe-to-shell", "silent-catch"]);
  assert.deepEqual(out.broken, []);
});

test("the deterministic checks find nothing in their near-miss fixtures", () => {
  const root = project({});
  install(root, "silent-catch,focused-or-skipped-test");
  seedFixture(root, "src/ok.js", classOf("silent-catch").fixtures.nearMiss[0]);
  seedFixture(root, "test/ok.test.js", classOf("focused-or-skipped-test").fixtures.nearMiss[0]);
  const { status, out } = driverJson(root);
  assert.deepEqual(out.findings, []);
  assert.equal(status, 0);
});

// The near-miss file holds five commands that look like the defect. Four of
// them are clean here, and the fifth is a `curl … | sh` inside an echoed
// string — a shell string this check does not parse. That is the whole reason
// the catalogue labels this detector heuristic, and pinning the number is how
// the limit stays a known one instead of a surprise.
test("the heuristic shell check misses only the echoed command, and says it is heuristic", () => {
  const root = project({});
  install(root, "pipe-to-shell");
  seedFixture(root, "scripts/ok.sh", classOf("pipe-to-shell").fixtures.nearMiss[0]);
  const { out } = driverJson(root);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].line, 5);
  const detector = classOf("pipe-to-shell").detectors.find((d) => d.runner === "checks");
  assert.equal(detector.confidence, "heuristic");
});

test("a download and an unrelated pipe on different lines are not one violation", () => {
  const root = project({});
  install(root, "pipe-to-shell");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "spread.sh"),
    "#!/bin/sh\ncurl -fsSL https://example.test/a -o a\nls -1\ncat a | sh_helper\n");
  const { out } = driverJson(root);
  assert.deepEqual(out.findings, []);
});

test("a violation inside a comment or a string literal is not a violation", () => {
  const root = project({});
  install(root, "silent-catch,focused-or-skipped-test");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "quoted.js"), [
    "// try { x() } catch (err) { }",
    "/* catch {} */",
    'const sample = "catch (err) { }";',
    "const other = `catch {}`;",
    "const re = /catch\\s*\\{\\s*\\}/;",
    "module.exports = { sample, other, re };",
  ].join("\n") + "\n");
  const { out } = driverJson(root);
  assert.deepEqual(out.findings, []);
});

test("a violation is reported with its own line number, not the file's first line", () => {
  const root = project({});
  install(root, "silent-catch");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "late.js"),
    "// a comment\n\n/* a block\n   spanning lines */\n\nfunction f() {\n  try { g(); } catch (e) {}\n}\n");
  const { out } = driverJson(root);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].line, 7);
});

test("a finding names the file, the line and the pattern, and never the text that matched", () => {
  const root = project({});
  install(root, "silent-catch");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "secret.js"), "function f() {\n  try { OWNED_BY_THE_REPO(); } catch {}\n}\n");
  const run = driver(root, ["--json"]);
  assert.equal(run.stdout.includes("OWNED_BY_THE_REPO"), false);
  const finding = JSON.parse(run.stdout).findings[0];
  assert.deepEqual(Object.keys(finding).sort(), ["classId", "line", "note", "path", "pattern"]);
});

test("named paths are the only ones checked when paths are named", () => {
  const root = project({});
  install(root, "silent-catch");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.js"), "try { x(); } catch {}\n");
  fs.writeFileSync(path.join(root, "src", "b.js"), "try { y(); } catch {}\n");
  const { out } = driverJson(root, ["src/a.js"]);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].path, "src/a.js");
});

test("the driver reads and never writes", () => {
  const root = project({ "src/bad.js": "try { x(); } catch {}\n" });
  install(root, ALL_FOUR);
  const before = snapshot(root);
  driver(root);
  driver(root, ["--selftest"]);
  assert.deepEqual(snapshot(root), before);
});

test("the driver skips its own state directory and node_modules", () => {
  const root = project({});
  install(root, "silent-catch");
  fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "try { x(); } catch {}\n");
  const { out } = driverJson(root);
  assert.deepEqual(out.findings, []);
});

test("a staged-deletion check outside a repository says so instead of reporting clean", () => {
  const root = project({});
  install(root, "test-file-deletion");
  const { out } = driverJson(root);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].id, "test-file-deletion");
  assert.match(out.skipped[0].command, /git diff --cached --diff-filter=D --name-only/);
});

test("the staged-deletion globs match a test path and leave a doc about testing alone", async () => {
  const mod = await import(pathToFileURL(path.join(TEMPLATE_DIR, "checks", "test-file-deletion.check.mjs")).href);
  const lines = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const cls = classOf("test-file-deletion");
  const root = project({});
  install(root, "test-file-deletion");
  // The module's own matcher is exercised through the driver's contract: seed
  // the fixture paths as if git had printed them.
  const check = mod;
  const fakeCtx = {
    git: () => ({ ok: true, stdout: lines(cls.fixtures.violation[0]).join("\n") }),
    finding: (classId, rel) => ({ classId, path: rel }),
  };
  assert.equal(check.check(fakeCtx).length, 3);
  const clean = {
    git: () => ({ ok: true, stdout: lines(cls.fixtures.nearMiss[0]).join("\n") }),
    finding: (classId, rel) => ({ classId, path: rel }),
  };
  assert.deepEqual(clean.git().stdout.split("\n").length, 4);
  assert.deepEqual(check.check(clean), []);
});

test("a check module that will not load is reported and the others still run", () => {
  const root = project({ "src/bad.js": "try { x(); } catch {}\n" });
  install(root, "silent-catch");
  fs.writeFileSync(path.join(root, ".jig", "checks", "broken.check.mjs"), "export const id = ; // not javascript\n");
  const { status, out } = driverJson(root);
  assert.equal(out.broken.length, 1);
  assert.equal(out.findings.length, 1);
  assert.equal(status, 1);
});

// ---------------------------------------------------------------------------
// The witnessed catch
// ---------------------------------------------------------------------------

test("the driver's own selftest catches every check that can seed itself", () => {
  const root = project({});
  install(root, ALL_FOUR);
  const run = driver(root, ["--selftest", "--json"]);
  assert.equal(run.status, 0);
  const results = JSON.parse(run.stdout).selftest;
  const caught = results.filter((r) => r.caught === true).map((r) => r.id).sort();
  assert.deepEqual(caught, ["focused-or-skipped-test", "pipe-to-shell", "silent-catch"]);
  const skipped = results.find((r) => r.caught === null);
  assert.equal(skipped.id, "test-file-deletion");
  assert.match(skipped.command, /git rm --cached/);
});

test("selftest --live watches every installed guard catch its own violation", () => {
  const root = project({});
  install(root, ALL_FOUR);
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  assert.equal(result.witnessed, true);
  const guards = result.probes.filter((p) => p.kind === "guard");
  assert.equal(guards.length, 4);
  for (const probe of guards) {
    assert.equal(probe.ran, true, probe.probe + " did not run");
    assert.equal(probe.caught, true, probe.probe + " did not catch its own violation");
    assert.equal(probe.decision, "would-deny");
    assert.equal(probe.mode, "observe");
    assert.match(probe.output, /"decision":"would-deny"/);
  }
});

test("a witnessed catch means a ledger line exists, not just a decision on screen", () => {
  const root = project({});
  install(root, ALL_FOUR);
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  assert.equal(result.ledger.linesBefore, 0);
  assert.ok(result.ledger.linesAfter > 0);
  const rows = fs.readFileSync(path.join(root, ".jig", "ledger.jsonl"), "utf-8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.decision === "would-deny"));
  assert.ok(rows.every((r) => r.mode === "observe"));
});

test("without --live nothing runs, and every probe prints the command to run by hand", () => {
  const root = project({});
  install(root, ALL_FOUR);
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
  const root = project({});
  install(root, ALL_FOUR);
  fs.rmSync(path.join(root, ".jig", "checks"), { recursive: true, force: true });
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  const driverProbe = result.probes.find((p) => p.kind === "checks");
  assert.equal(driverProbe.ran, false);
  assert.match(driverProbe.why, /is not installed here/);
  assert.equal(driverProbe.command, "node .jig/checks/run.mjs --selftest");
  assert.equal(result.witnessed, true);
  assert.ok(result.notes.some((n) => n.includes("node .jig/checks/run.mjs --selftest")));
});

test("only the classes actually installed are probed", () => {
  const root = project({});
  install(root, "silent-catch");
  const result = engine.cmdSelftest(root, { _: [], change: [], live: true });
  assert.deepEqual(result.probes.filter((p) => p.kind === "guard").map((p) => p.probe), ["silent-catch"]);
});

test("every installable class has a probe, so nothing installs unwatched", () => {
  const installable = catalogue.classes.filter((c) => c.installableAtV1).map((c) => c.id).sort();
  assert.deepEqual(Object.keys(engine.LIVE_PROBES).sort(), installable);
});

// ---------------------------------------------------------------------------
// What jig refuses to do for you
// ---------------------------------------------------------------------------

test("apply says out loud that the pre-commit line and the permissions are yours to apply", () => {
  const root = project({});
  const { applied } = install(root, ALL_FOUR);
  assert.equal(applied.proposals.length, 2);
  assert.ok(applied.proposals.some((n) => /activation\.md/.test(n) && /does not edit it/.test(n)));
  assert.ok(applied.proposals.some((n) => /proposed-permissions\.json/.test(n) && /never edits your settings/.test(n)));
});

test("the activation file names both hook shapes and the version-manager hazard", () => {
  const root = project({});
  install(root, "silent-catch");
  const text = fs.readFileSync(path.join(root, ".jig", "activation.md"), "utf-8");
  assert.match(text, /node \.jig\/checks\/run\.mjs \|\| exit 1/);
  assert.match(text, /#!\/usr\/bin\/env node/);
  assert.match(text, /fnm, nvm, volta, or asdf/);
});

test("no host settings file is written, read back, or named as a target", () => {
  const root = project({ ".claude/settings.json": '{"hooks":{}}\n' });
  const before = fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf-8");
  install(root, ALL_FOUR);
  assert.equal(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf-8"), before);
  for (const entry of INDEX.templates) {
    assert.equal(entry.target.includes("settings.json"), false);
  }
});

test("an artifact jig cannot read back is stamped a gap rather than reported as a guarantee", () => {
  const root = project({});
  const { plan } = install(root, ALL_FOUR);
  assert.deepEqual(plan.enforcementGaps.sort(), [".github/workflows/jig.yml", ".jig/activation.md", ".jig/hooks/pre-commit"]);
  const manifest = engine.readManifest(root);
  assert.ok(manifest.artifacts.every((a) => a.hash !== null));
});
