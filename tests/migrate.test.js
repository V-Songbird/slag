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
const A = require("./authored.js");

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

// Migration drops a guard it cannot carry forward, and since 2.11.0 it refuses
// to do that unheard: the owner reads the rows and says `--accept-drops`. Every
// install below whose guard set contains one of those rows migrates with it.
const ACCEPT = { _: [], change: [], path: [], "accept-drops": true };

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
  const result = migrate.cmdMigrate(root, ACCEPT);

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
  const result = migrate.cmdMigrate(root, ACCEPT);

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
  const result = migrate.cmdMigrate(root, ACCEPT);

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

// Roadmap 227. A migration that removes a guard is coverage disappearing under
// an owner who asked for an upgrade, so the whole transaction stops before it
// starts and names every row it would drop. `--accept-drops` is the only way
// past it, and there is no way past it that skips the reading.
test("migrate refuses to drop a guard the owner has not seen, and writes nothing", () => {
  const root = install({
    guards: [
      legacyGuard("silent-catch", "edit-observe-guard", "PostToolUse"),
      legacyGuard("pipe-to-shell", "pipe", "PreToolUse", { mode: "armed" }),
    ],
  });
  const before = fs.readFileSync(path.join(root, ".jig/config.json"));

  let err = null;
  try { migrate.cmdMigrate(root); } catch (e) { err = e; }
  assert.ok(err, "the armed guard was removed with no pause at all");
  assert.match(err.message, /pipe-to-shell-pipe \[armed\]/, "the id and the mode are both in the refusal");
  assert.match(err.message, /discarded/, "and the reason it cannot be carried forward");
  assert.match(err.message, /--accept-drops/);
  assert.equal(err.expected, true);

  // Pre-flight: not one byte of the install moved, and no plan was left behind.
  assert.deepEqual(fs.readFileSync(path.join(root, ".jig/config.json")), before);
  assert.equal(fs.existsSync(path.join(root, ".jig/journal.jsonl")), false);
  assert.deepEqual(fs.readdirSync(path.join(root, ".jig")).filter((f) => f.startsWith("plan")), []);

  // And the same run with the drops accepted lands, naming what it removed.
  const result = migrate.cmdMigrate(root, ACCEPT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.droppedGuards.map((d) => d.guardId), ["pipe-to-shell-pipe"]);
  assert.equal(result.droppedGuards[0].mode, "armed");
  assert.equal(readJson(root, ".jig/config.json").guards.some((g) => g.id === "pipe-to-shell-pipe"), false);
});

// A migration that removes nothing has nothing to accept: the flag is a pause on
// a loss, not a ceremony on every upgrade.
test("a migration that drops no guard needs no acceptance", () => {
  const root = install({
    guards: [legacyGuard("silent-catch", "edit-observe-guard", "PostToolUse", { mode: "armed" })],
  });
  const result = migrate.cmdMigrate(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.droppedGuards, []);
  assert.equal(readJson(root, ".jig/config.json").guards[0].mode, "armed");
});

test("a CRLF install keeps a proof that still binds", () => {
  const checks = Object.fromEntries(LEGACY.map((id) => [id, templateText("checks/" + id + CHECK_SUFFIX)]));
  checks["pipe-to-shell"] = pipeWithStrings();
  const root = install({ checks, eol: "crlf", guards: guardsWithProvenPipe() });
  migrate.cmdMigrate(root, ACCEPT);

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
  const result = migrate.cmdMigrate(root, ACCEPT);

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

  const result = migrate.cmdMigrate(root, ACCEPT);
  assert.notEqual(fs.readFileSync(path.join(root, ".jig/config.json")).toString(),
    before.get(".jig/config.json").toString());

  const reverted = jig.cmdRevert(root, { _: [], change: [], tx: result.tx });
  assert.equal(reverted.ok, true);
  for (const [rel, bytes] of before) {
    assert.deepEqual(fs.readFileSync(path.join(root, rel)), bytes, rel + " came back byte for byte");
  }
  // And the install is a 1.0.1 install again: migrate has something to do.
  assert.equal(migrate.cmdMigrate(root, ACCEPT).ok, true);
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
  migrate.cmdMigrate(root, ACCEPT);
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

// ---------------------------------------------------------------------------
// The 2.11.0 pass: an installed edit guard moves to PreToolUse
// ---------------------------------------------------------------------------
//
// `edit-observe-guard` denies at PostToolUse, when the file is already written.
// The lever cannot simply be re-pointed at PreToolUse: the proof recorded for
// each installed guard binds the check source it was admitted on, so a silent
// move would leave every one of them claiming a proof for a lever it no longer
// runs. The move is a migration, and arriving at PreToolUse turns a report into
// a refusal — so it is approved one change at a time and nothing is applied for
// the owner.

// An install already on the pair shape, which is what every jig made between
// 1.1.0 and 2.10.0 left behind: an authored check whose edit detector is an
// `edit-observe-guard`, the manifest that describes it, and one guard naming it.
// Built here rather than by running the 1.0.1 pass first, because Node keeps one
// ESM module per path for the life of a process and the 1.0.1 pass has already
// read that path.
function currentInstall(extraGuards, extraChecks) {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, ".jig", "checks"), { recursive: true });
  const check = A.EMPTY_CATCH;
  const carried = [check, ...(extraChecks || [])];
  const proofs = carried.map((c) => {
    const rel = ".jig/checks/" + c.id + CHECK_SUFFIX;
    fs.writeFileSync(path.join(root, rel), c.module);
    return admission.proofHash(c.module, c.fixtures.violation, c.fixtures.nearMiss);
  });
  const proof = proofs[0];
  fs.writeFileSync(path.join(root, ".jig/manifest.json"), JSON.stringify({
    schemaVersion: 1,
    artifacts: carried.map((c, i) => ({
      id: "old-" + c.id, classIds: [c.id], kind: "write-side-file",
      path: ".jig/checks/" + c.id + CHECK_SUFFIX, ownership: "file",
      hash: jig.hashBytes(Buffer.from(c.module, "utf8")), provenance: "elicited", proof: proofs[i], install: null,
      template: { name: "check-" + c.id, version: "authored" }, state: "active",
      installedAt: "2026-01-01T00:00:00.000Z", txId: "old000000000",
    })),
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, ".jig/config.json"), JSON.stringify({
    schemaVersion: 1,
    guards: [
      ...carried.map((c, i) => ({ id: "g-" + c.id, check: c.id, classId: c.id, runner: "PostToolUse",
        mode: "observe", provenance: "elicited", proof: proofs[i] })),
      ...(extraGuards || []),
    ],
  }, null, 2) + "\n");
  return { root, check, proof };
}

// A fresh load of a module the migration has just rewritten. One ESM module per
// path, and the migration read that path already.
function loadFresh(root, slug, tag) {
  const copy = path.join(root, slug + "-" + tag + CHECK_SUFFIX);
  fs.copyFileSync(path.join(root, ".jig/checks/" + slug + CHECK_SUFFIX), copy);
  return require(copy);
}

test("the edit guards an install already carries are moved to PreToolUse, one approved change each", () => {
  const { root, check, proof } = currentInstall();
  const before = fs.readFileSync(path.join(root, ".jig/config.json"), "utf8");

  const plan = migrate.cmdMigrate(root);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.migrated, [], "a plan is not a landed change");
  assert.deepEqual(plan.refused, []);
  assert.deepEqual(plan.moving.map((m) => m.guards), [["g-" + check.id]]);
  assert.equal(fs.readFileSync(path.join(root, ".jig/config.json"), "utf8"), before,
    "migrate wrote a plan and nothing else");

  // Every change here can refuse a tool call, so none of them can be waved
  // through by naming the plan.
  assert.throws(() => jig.cmdApply(root, { _: [], change: [], plan: plan.plan }),
    /Approve each one by name/);
  assert.deepEqual(plan.changes.map((c) => c.path).sort(),
    [".jig/checks/" + check.id + CHECK_SUFFIX, ".jig/config.json"]);

  jig.cmdApply(root, {
    _: [], change: plan.changes.map((c) => c.id), path: plan.changes.map((c) => c.path),
  });

  const guard = readJson(root, ".jig/config.json").guards[0];
  assert.equal(guard.id, "g-" + check.id, "the guard keeps the id its ledger is keyed on");
  assert.equal(guard.runner, "PreToolUse");
  assert.equal(guard.mode, "observe", "moving a guard is not arming it");
  // Re-recorded, because the proof it carried bound the lever it no longer runs.
  const mod = loadFresh(root, check.id, "as-edit-guard");
  assert.notEqual(guard.proof, proof);
  assert.equal(guard.proof, proofOnDisk(root, check.id, mod));
  assert.equal(lib.sessionDetectors(mod, "PreToolUse", "Write").length, 1);
  assert.deepEqual(lib.sessionDetectors(mod, "PostToolUse"), []);
  assert.deepEqual(mod.fixtures, check.fixtures, "the pair the proof binds is untouched");

  // The tree still describes itself, and there is nothing left to move.
  assert.deepEqual(jig.manifestStates(root, readJson(root, ".jig/manifest.json"))
    .filter((a) => a.state !== "active"), []);
  assert.match(migrate.cmdMigrate(root).why, /no guard is left watching an edit at PostToolUse/);
});

// Two moving checks are two module changes and ONE config change carrying both
// rows, because a second write-config change over the same path would compute
// its content from the config as it was and undo the first. So the note the
// owner reads has to say that, rather than promise a per-guard independence the
// plan cannot give: approving the config without a module leaves that guard
// naming PreToolUse over a module that still declares PostToolUse.
const SECOND_EDIT_CHECK = A.authored({
  id: "focused-test",
  title: "A focused test left behind",
  detectors: [
    { lever: "edit-observe-guard", actor: "claude-session", confidence: "deterministic",
      params: { patterns: ["\\b(?:it|test|describe)\\.only\\s*\\("] } },
  ],
  fixtures: { violation: "it.only('a', () => {});\n", nearMiss: "it('a', () => {});\n" },
  deny: {
    reason: "This leaves one test running and the rest silently skipped.",
    alternative: "run the focused test locally and drop the .only before committing",
    override: "say which suite is being narrowed and until when",
  },
});

test("two moving guards share one config change, and the note says so instead of promising otherwise", () => {
  const { root } = currentInstall(undefined, [SECOND_EDIT_CHECK]);
  const plan = migrate.cmdMigrate(root);
  assert.deepEqual(plan.moving.map((m) => m.check).sort(), ["empty-catch", "focused-test"]);
  const configChanges = plan.changes.filter((c) => c.path === ".jig/config.json");
  assert.equal(configChanges.length, 1, "one path, one change — a second would undo the first");
  assert.match(configChanges[0].rationale, /g-empty-catch, g-focused-test/);
  assert.match(plan.notes[0], /config change carries all 2 rows/);
  assert.match(plan.notes[0], /guards nothing until that module change is applied too/);

  // And that is what actually happens: the config alone moves both rows, and the
  // guard whose module was left behind stops running rather than keeping on as
  // it was.
  jig.cmdApply(root, { _: [], change: [configChanges[0].id], path: [configChanges[0].path] });
  const guards = readJson(root, ".jig/config.json").guards;
  assert.deepEqual(guards.map((g) => g.runner), ["PreToolUse", "PreToolUse"]);
  const mod = loadFresh(root, "focused-test", "unmoved");
  assert.deepEqual(lib.sessionDetectors(mod, "PreToolUse"), [],
    "the module still declares PostToolUse, so the moved row names an event it cannot run");
});

// Teaching used to be the one answer this migration could not carry, because
// the channel was verified on PostToolUse alone. 2.13.0 measured it on
// PreToolUse (roadmap 233), so the move preserves the owner's answer — and an
// answer silently discarded on an upgrade is what SCOPE forbids.
test("a guard opted into teaching keeps it when it moves", () => {
  const { root } = currentInstall();
  const before = readJson(root, ".jig/config.json");
  before.guards[0].teach = true;
  fs.writeFileSync(path.join(root, ".jig/config.json"), JSON.stringify(before, null, 2) + "\n");

  const plan = migrate.cmdMigrate(root);
  const config = plan.changes.find((c) => c.path === ".jig/config.json");
  jig.cmdApply(root, { _: [], change: [config.id], path: [config.path] });

  const after = readJson(root, ".jig/config.json");
  assert.equal(after.guards[0].runner, "PreToolUse");
  assert.equal(after.guards[0].teach, true, "the owner's answer was dropped on the way to the new lever");
  const read = lib.validateConfig(after);
  assert.deepEqual(read.warnings, [], "and the moved row warns about nothing");
  assert.equal(read.guards[0].teach, true, "the runner reads it back on the lever it moved to");
  assert.equal(plan.notes.some((n) => /teaching/.test(n)), false,
    "nothing is lost, so nothing is announced as lost");
});

test("a guard whose check the install no longer carries is named, and the rest still move", () => {
  const { root, check } = currentInstall([
    { id: "orphan", check: "gone", classId: "gone", runner: "PostToolUse", mode: "observe",
      provenance: "assumed" },
  ]);
  const plan = migrate.cmdMigrate(root);
  assert.deepEqual(plan.refused.map((r) => r.check), ["gone"]);
  assert.deepEqual(plan.refused[0].guards, ["orphan"]);
  assert.match(plan.refused[0].why, /no installed check module/);
  assert.deepEqual(plan.moving.map((m) => m.check), [check.id],
    "one guard nobody can move does not hold up the others");
});

// The rewrite touches two words in a file jig did not compose, so the count is
// the safety: a module stating either word anywhere but on the detectors the
// runner read is left alone rather than rewritten into something nobody proved.
test("the lever rewrite refuses a module that states the lever more often than the install runs it", () => {
  const good = 'export const detectors = [{ "lever": "edit-observe-guard", "runner": "PostToolUse" }];\n';
  assert.equal(migrate.swapEditLever(good, 1).source,
    'export const detectors = [{ "lever": "edit-guard", "runner": "PreToolUse" }];\n');

  // The unquoted key spelling a hand-written module may use.
  const bare = "export const detectors = [{ lever: 'edit-observe-guard', runner: 'PostToolUse' }];\n";
  assert.equal(migrate.swapEditLever(bare, 1).source,
    "export const detectors = [{ lever: 'edit-guard', runner: 'PreToolUse' }];\n");

  const inFixture = good + 'export const fixtures = { violation: \'lever: "edit-observe-guard"\' };\n';
  const refused = migrate.swapEditLever(inFixture, 1);
  assert.equal(refused.source, undefined, "the module was rewritten past its detectors");
  assert.match(refused.why || refused.problem, /will not guess/);
});
