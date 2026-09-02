"use strict";

// The 1.0.1 upgrade path, tested against a real 1.0.1 install: the shipped
// check templates, a config in the shape 1.0.1 wrote, a manifest whose hashes
// match the files, and a ledger with history in it. Every assertion here is
// about something the owner would notice — a guard that kept its id, a check
// that stopped running because it could not be proven, and a revert that puts
// the whole thing back.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const jig = require("../scripts/jig.js");
const migrate = require("../scripts/migrate.js");
const admission = require("../scripts/admission.js");
const lib = require("../hooks/jig-lib.js");

const TEMPLATES = path.join(__dirname, "..", "scripts", "templates");
const CHECK_SUFFIX = ".check.mjs";
const LEGACY = ["silent-catch", "focused-or-skipped-test", "pipe-to-shell", "test-file-deletion"];

const roots = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jig-migrate-"));
  roots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

// The driver still ships as a template, but the four 1.0.1 per-class check
// modules do not: nothing installs them any more, so they live here as the
// legacy input migration has to be able to read. `checks/<id>.check.mjs`
// resolves to that fixture directory, everything else to the live templates.
function templateText(rel) {
  const base = rel.startsWith("checks/") ? path.join(__dirname, "fixtures", "legacy-checks") : TEMPLATES;
  const file = rel.startsWith("checks/") ? rel.slice("checks/".length) : rel;
  return fs.readFileSync(path.join(base, file), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

// The 1.0.1 guard row: it names a catalogue class and a detector inside it, and
// carries no `check` and no `proof` — those are what migration adds.
function legacyGuard(classId, detector, runner, over) {
  return { id: classId + "-" + detector, classId, detector, runner, ...over };
}

// A 1.0.1 install as it sits on disk. The manifest hashes are computed from the
// files actually written, because a manifest that disagrees with the tree is a
// drifted install and migration refuses one of those on purpose.
function install(over) {
  const o = over || {};
  const root = tmpDir();
  const checks = o.checks || Object.fromEntries(LEGACY.map((id) => [id, templateText("checks/" + id + ".check.mjs")]));
  fs.mkdirSync(path.join(root, ".jig", "checks"), { recursive: true });

  const artifacts = [];
  const style = (text) => (o.eol === "crlf" ? text.replace(/\n/g, "\r\n") : text);
  const write = (rel, text0, row) => {
    const text = style(text0);
    fs.writeFileSync(path.join(root, rel), text);
    artifacts.push({
      id: "old-" + path.basename(rel),
      classIds: row.classIds,
      kind: "write-side-file",
      path: rel,
      ownership: "file",
      hash: jig.hashBytes(Buffer.from(text, "utf8")),
      provenance: "elicited",
      proof: null,
      install: null,
      template: row.template,
      state: "active",
      installedAt: "2026-01-01T00:00:00.000Z",
      txId: "old000000000",
    });
  };
  write(".jig/checks/run.mjs", templateText("run.mjs"), { classIds: [], template: { name: "check-driver", version: "1.0.0" } });
  for (const [id, source] of Object.entries(checks)) {
    write(".jig/checks/" + id + ".check.mjs", source, { classIds: [id], template: { name: "check-" + id, version: "1.0.0" } });
  }
  fs.writeFileSync(path.join(root, ".jig", "manifest.json"),
    JSON.stringify({ schemaVersion: 1, artifacts }, null, 2) + "\n");

  const guards = o.guards || [
    legacyGuard("silent-catch", "edit-observe-guard", "PostToolUse", { provenance: "elicited", mode: "observe" }),
    legacyGuard("focused-or-skipped-test", "edit-observe-guard", "PostToolUse"),
    legacyGuard("pipe-to-shell", "pipe", "PreToolUse"),
    legacyGuard("test-file-deletion", "bash-guard", "PreToolUse"),
  ];
  fs.writeFileSync(path.join(root, ".jig", "config.json"),
    JSON.stringify({ schemaVersion: o.schemaVersion || 1, mode: "observe", guards }, null, 2) + "\n");

  // History, so the assertions about what follows a guard have something to
  // follow. Two guards fired; one of them is the one migration discards.
  fs.writeFileSync(path.join(root, ".jig", "ledger.jsonl"), [
    { guardId: "silent-catch-edit-observe-guard", decision: "would-deny" },
    { guardId: "silent-catch-edit-observe-guard", decision: "would-deny" },
    { guardId: "pipe-to-shell-pipe", decision: "would-deny" },
  ].map((r) => JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", ...r })).join("\n") + "\n");
  return root;
}

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

// The module the migration wrote, as a fresh session would see it. Node keeps
// one ESM module per path for the life of a process and the migration already
// read the 1.0.1 file at that path, so a copy is the only way to load the new
// bytes in the same process. Every hook and every driver run is its own
// process, where this does not arise.
function loadMigrated(root, slug) {
  const copy = path.join(root, slug + "-as-installed.check.mjs");
  fs.copyFileSync(path.join(root, ".jig/checks/" + slug + CHECK_SUFFIX), copy);
  return require(copy);
}

// The proof jig-lib computes at runtime: the module's own bytes as they sit on
// disk, plus both inline fixtures. Written out here rather than taken from
// lib.checkProof, which reads through the same one-module-per-path cache.
function proofOnDisk(root, slug, mod) {
  const source = fs.readFileSync(path.join(root, ".jig/checks/" + slug + CHECK_SUFFIX), "utf8");
  return admission.proofHash(source, mod.fixtures.violation, mod.fixtures.nearMiss);
}

// pipe-to-shell as a 1.0.1 install that blanked string literals. The shipped
// template does not, which is why the shipped one cannot pass its own near miss
// — that case is its own test below.
function pipeWithStrings() {
  return templateText("checks/pipe-to-shell.check.mjs")
    .replace("{ strings: false, perLine: true }", "{ strings: true, perLine: true }");
}

// The 1.0.1 guard set with pipe-to-shell watched by the bash detector that can
// still be proven. Admission now runs a bash-guard's own fixture pair through
// the runner's evaluation, and the class's `pipe` detector fires on its own
// near miss: `echo "curl … | sh"` is a command, and a Bash guard does not blank
// string literals the way the check driver does. `force-push` is the same
// class's other bash guard and it passes both halves.
function guardsWithProvenPipe() {
  return [
    legacyGuard("silent-catch", "edit-observe-guard", "PostToolUse", { provenance: "elicited", mode: "observe" }),
    legacyGuard("focused-or-skipped-test", "edit-observe-guard", "PostToolUse"),
    legacyGuard("pipe-to-shell", "force-push", "PreToolUse"),
    legacyGuard("test-file-deletion", "bash-guard", "PreToolUse"),
  ];
}

test("a clean 1.0.1 install migrates in place", () => {
  const root = install();
  const result = migrate.cmdMigrate(root);

  assert.equal(result.ok, true);
  const config = readJson(root, ".jig/config.json");
  assert.equal(config.mode, undefined, "no top-level mode survives the migration");
  const byId = new Map(config.guards.map((g) => [g.id, g]));

  // The two renamed classes, under the guard ids the ledger already knows.
  assert.deepEqual(byId.get("silent-catch-edit-observe-guard").classId, "javascript-typescript/swallowed-exception");
  assert.deepEqual(byId.get("focused-or-skipped-test-edit-observe-guard").classId, "javascript-typescript/skipped-test");
  assert.equal(byId.get("silent-catch-edit-observe-guard").check, "silent-catch");
  assert.equal(byId.get("silent-catch-edit-observe-guard").provenance, "elicited");

  // The proof binds the guard to the module on disk, which is the whole arming
  // gate: a row claiming a proof it does not have cannot arm.
  const mod = loadMigrated(root, "silent-catch");
  assert.equal(typeof mod.fixtures.violation, "string");
  assert.equal(typeof mod.fixtures.nearMiss, "string");
  assert.equal(mod.selftest, undefined, "the legacy selftest shape is gone");
  assert.equal(byId.get("silent-catch-edit-observe-guard").proof, proofOnDisk(root, "silent-catch", mod));
  assert.deepEqual(Object.keys(mod.deny).sort(), ["alternative", "override", "reason"]);
  assert.equal(lib.sessionDetectors(mod, "PostToolUse").length, 1);

  // The manifest describes the tree as it now is, with one row per path.
  const manifest = readJson(root, ".jig/manifest.json");
  const paths = manifest.artifacts.map((a) => a.path);
  assert.equal(new Set(paths).size, paths.length, "migration leaves one manifest row per file");
  for (const a of manifest.artifacts) {
    assert.equal(jig.hashBytes(fs.readFileSync(path.join(root, a.path))), a.hash, a.path + " hashes to its row");
  }
  assert.deepEqual(jig.manifestStates(root, manifest).filter((a) => a.state !== "active"), []);

  // The driver is the one the pairs were proven against.
  assert.equal(fs.readFileSync(path.join(root, ".jig/checks/run.mjs"), "utf8"),
    templateText("run.mjs"));
});

test("migration never arms anything, and history follows every surviving guard", () => {
  const root = install({
    guards: [
      legacyGuard("silent-catch", "edit-observe-guard", "PostToolUse", { mode: "armed" }),
      legacyGuard("focused-or-skipped-test", "edit-observe-guard", "PostToolUse"),
    ],
  });
  const result = migrate.cmdMigrate(root);
  const byId = new Map(readJson(root, ".jig/config.json").guards.map((g) => [g.id, g]));

  // The mode the old row recorded, and nothing more: the guard that recorded
  // nothing lands in observe rather than inheriting the file-wide word.
  assert.equal(byId.get("silent-catch-edit-observe-guard").mode, "armed");
  assert.equal(byId.get("focused-or-skipped-test-edit-observe-guard").mode, "observe");

  const fired = result.guards.find((g) => g.guardId === "silent-catch-edit-observe-guard");
  assert.equal(fired.fired, 2, "the ledger lines written before the migration still count for this guard");
  assert.equal(fired.was, "silent-catch");
  assert.equal(fired.classId, "javascript-typescript/swallowed-exception");
});

test("a class with no edition equivalent carries forward under its own id", () => {
  const checks = Object.fromEntries(LEGACY.map((id) => [id, templateText("checks/" + id + ".check.mjs")]));
  checks["pipe-to-shell"] = pipeWithStrings();
  const root = install({ checks, guards: guardsWithProvenPipe() });
  const result = migrate.cmdMigrate(root);

  const guard = readJson(root, ".jig/config.json").guards.find((g) => g.id === "pipe-to-shell-force-push");
  assert.equal(guard.classId, "pipe-to-shell", "no edition names this class, so the id is left alone");
  assert.equal(guard.check, "pipe-to-shell");
  assert.equal(guard.runner, "PreToolUse");
  assert.ok(result.migrated.some((m) => m.classId === "pipe-to-shell"));

  // The check it points at is the PreToolUse detector 1.0.1 installed, deny
  // reply and all — carried forward, not re-derived.
  const mod = loadMigrated(root, "pipe-to-shell");
  const dets = lib.sessionDetectors(mod, "PreToolUse");
  assert.equal(dets.length, 1);
  assert.ok(lib.denyOf(mod, dets[0]));
  assert.equal(guard.proof, proofOnDisk(root, "pipe-to-shell", mod));
});

// The other half of the same change, and the one an owner notices: their
// pipe-to-shell guard watched the `pipe` bash detector, which fires on the
// class's own near miss now that admission runs a bash-guard the way the runner
// does. A lever that cannot be proven discards the WHOLE check (SCOPE, "It
// never claims coverage it has not demonstrated"), so the commit-time half goes
// with it — and migration says so rather than quietly installing less.
test("a 1.0.1 guard whose bash lever fires on its own near miss is dropped, and named", () => {
  const checks = Object.fromEntries(LEGACY.map((id) => [id, templateText("checks/" + id + ".check.mjs")]));
  checks["pipe-to-shell"] = pipeWithStrings();
  const root = install({ checks });
  const result = migrate.cmdMigrate(root);

  assert.equal(result.ok, true);
  const dropped = result.droppedGuards.find((d) => d.guardId === "pipe-to-shell-pipe");
  assert.ok(dropped, "the guard vanished with nothing said about it: " + JSON.stringify(result.droppedGuards));
  assert.match(dropped.why, /discarded/);
  assert.equal(result.discarded.some((d) => d.id === "pipe-to-shell"), true);
  assert.equal(readJson(root, ".jig/config.json").guards.some((g) => g.classId === "pipe-to-shell"), false);
  // The commit-time half stops with it: the module is left as a tombstone that
  // exports nothing, so the driver has nothing to run and `revert` still has the
  // original to put back.
  const tomb = fs.readFileSync(path.join(root, ".jig/checks/pipe-to-shell.check.mjs"), "utf8");
  assert.match(tomb, /discarded by jig's 1\.0\.1 migration/);
  assert.doesNotMatch(tomb, /export const detectors/);
});

test("a CRLF install keeps a proof that still binds", () => {
  const checks = Object.fromEntries(LEGACY.map((id) => [id, templateText("checks/" + id + CHECK_SUFFIX)]));
  checks["pipe-to-shell"] = pipeWithStrings();
  const root = install({ checks, eol: "crlf", guards: guardsWithProvenPipe() });
  migrate.cmdMigrate(root);

  const source = fs.readFileSync(path.join(root, ".jig/checks/silent-catch.check.mjs"), "utf8");
  assert.ok(source.includes("\r\n"), "the migration writes in the file's own line endings");
  // The proof is over the bytes the runner will read, not over the payload as
  // jig composed it, or no guard on a Windows checkout could ever arm.
  const byId = new Map(readJson(root, ".jig/config.json").guards.map((g) => [g.id, g]));
  for (const slug of ["silent-catch", "pipe-to-shell"]) {
    const guard = [...byId.values()].find((g) => g.check === slug);
    assert.equal(guard.proof, proofOnDisk(root, slug, loadMigrated(root, slug)), slug + "'s proof binds on CRLF");
  }
});

test("a check that cannot form a passing pair is discarded, reported, and stops running", () => {
  const root = install();
  const result = migrate.cmdMigrate(root);

  const why = new Map(result.discarded.map((d) => [d.id, d.why]));
  // The shipped pipe-to-shell reads string literals as code, so its own near
  // miss — a quoted curl inside an echo — fires it.
  assert.match(why.get("pipe-to-shell"), /fired on the near miss/);
  // A staged-deletion check scans no patterns at all, so there is nothing a
  // fixture pair could prove about it.
  assert.match(why.get("test-file-deletion"), /scans no patterns/);
  assert.deepEqual(readJson(root, ".jig/discarded.json").discarded.map((d) => d.id).sort(),
    ["pipe-to-shell", "test-file-deletion"]);

  // Discarded means it stopped running, not that it was carried forward.
  const source = fs.readFileSync(path.join(root, ".jig/checks/pipe-to-shell.check.mjs"), "utf8");
  assert.match(source, /discarded by jig's 1\.0\.1 migration/);
  assert.doesNotMatch(source, /export const patterns/);
  assert.equal(loadMigrated(root, "pipe-to-shell").check, undefined, "the driver finds nothing to run");

  // The guards that named them are gone from the config and named on the
  // result, with the history they had.
  const ids = readJson(root, ".jig/config.json").guards.map((g) => g.id);
  assert.deepEqual(ids.sort(), ["focused-or-skipped-test-edit-observe-guard", "silent-catch-edit-observe-guard"]);
  const dropped = result.droppedGuards.map((g) => g.guardId).sort();
  assert.deepEqual(dropped, ["pipe-to-shell-pipe", "test-file-deletion-bash-guard"]);
  assert.match(result.droppedGuards[0].why, /discarded/);
});

test("the migration reverts as one transaction", () => {
  const root = install();
  const before = new Map();
  for (const rel of [".jig/config.json", ".jig/manifest.json", ".jig/checks/run.mjs",
    ...LEGACY.map((id) => ".jig/checks/" + id + ".check.mjs")]) {
    before.set(rel, fs.readFileSync(path.join(root, rel)));
  }

  const result = migrate.cmdMigrate(root);
  assert.notEqual(fs.readFileSync(path.join(root, ".jig/config.json")).toString(),
    before.get(".jig/config.json").toString());

  const reverted = jig.cmdRevert(root, { _: [], change: [], tx: result.tx });
  assert.equal(reverted.ok, true);
  for (const [rel, bytes] of before) {
    assert.deepEqual(fs.readFileSync(path.join(root, rel)), bytes, rel + " came back byte for byte");
  }
  // And the install is a 1.0.1 install again: migrate has something to do.
  assert.equal(migrate.cmdMigrate(root).ok, true);
});

test("migrate refuses an install it cannot fully read, and writes nothing", () => {
  const bare = tmpDir();
  assert.throws(() => migrate.cmdMigrate(bare), /nothing here to upgrade/);

  const newer = install({ schemaVersion: 2 });
  const config = fs.readFileSync(path.join(newer, ".jig/config.json"));
  assert.throws(() => migrate.cmdMigrate(newer), /newer than the jig running here/);
  assert.deepEqual(fs.readFileSync(path.join(newer, ".jig/config.json")), config);
  assert.equal(fs.existsSync(path.join(newer, ".jig", "journal.jsonl")), false);

  const notJig = tmpDir();
  fs.mkdirSync(path.join(notJig, ".jig"), { recursive: true });
  fs.writeFileSync(path.join(notJig, ".jig", "notes.txt"), "someone else's directory\n");
  assert.throws(() => migrate.cmdMigrate(notJig), /this is not a jig install/);
});

test("migrate answers a second run plainly, and refuses over a file somebody edited", () => {
  const root = install();
  migrate.cmdMigrate(root);
  // "Nothing to upgrade" is migrate's normal answer on a current install, not a
  // failure: it exits 0 and says so, so a caller cannot read the healthy case
  // as a broken one.
  const again = migrate.cmdMigrate(root);
  assert.equal(again.ok, true);
  assert.deepEqual(again.migrated, []);
  assert.match(again.why, /already on the pair shape/);

  const edited = install();
  fs.appendFileSync(path.join(edited, ".jig/checks/silent-catch.check.mjs"), "\n// mine now\n");
  assert.throws(() => migrate.cmdMigrate(edited), /was edited after jig wrote it/);
});
