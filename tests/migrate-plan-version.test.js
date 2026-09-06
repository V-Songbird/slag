"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const jig = require("../scripts/jig.js");
const migrate = require("../scripts/migrate.js");

// Frozen readPlan from the imported 2.15.1 engine, before host-migration
// metadata existed. Running that reader proves older builds refuse the new
// artifact format without requiring a Git checkout or executing project code.
const legacyReadPlan = vm.runInNewContext(`(function readPlan(file) {
  let record;
  try {
    record = JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  } catch (err) {
    throw expected(path.basename(file) + " is not readable JSON (" + err.message + ")");
  }
  if (!isObject(record) || !Array.isArray(record.changes)) throw expected(path.basename(file) + " is not a plan");
  if (record.schemaVersion > SCHEMA_VERSION) {
    throw expected(path.basename(file) + " is schemaVersion " + record.schemaVersion + " and this engine reads " +
      SCHEMA_VERSION + ". Upgrade jig rather than applying a plan it cannot fully read.");
  }
  return record;
})`, {
  fs, path, SCHEMA_VERSION: 1, stripBom: jig.stripBom,
  isObject: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  expected: (message) => Object.assign(new Error(message), { expected: true }),
});

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "jig-plan-version-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith("jig-plan-version-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, ".jig"));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Claude owner policy\nKeep the approved scope.\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Codex owner policy\nPreserve existing files.\n");
  fs.writeFileSync(path.join(root, ".jig/config.json"), JSON.stringify({ schemaVersion: 1, guards: [] }) + "\n");
  const bytes = Buffer.from("Existing host-neutral artifact.\n");
  fs.writeFileSync(path.join(root, ".jig/activation.md"), bytes);
  fs.writeFileSync(path.join(root, ".jig/manifest.json"), JSON.stringify({ schemaVersion: 1, artifacts: [
    { id: "existing-activation", path: ".jig/activation.md", ownership: "file", kind: "write-side-file",
      state: "active", hash: jig.hashBytes(bytes), template: { name: "activation", version: "1.0.0" } },
  ] }) + "\n");
  return root;
}
function plan(root, host = "codex") {
  const result = migrate.cmdMigrate(root, { _: [], change: [], path: [], host });
  assert.equal(result.changes.length, 1);
  const file = path.join(root, result.planPath);
  return { file, record: JSON.parse(fs.readFileSync(file, "utf8")), change: result.changes[0] };
}
function save(file, record) { fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n"); }
function apply(root, change) { return jig.cmdApply(root, { _: [], change: [change.id], path: [change.path] }); }

for (const host of ["codex", "claude"]) {
  test(host + " host plans require version 2, older readers refuse, and named reapply stays reversible", (t) => {
    const root = fixture(t);
    const target = path.join(root, host === "codex" ? "AGENTS.md" : "CLAUDE.md");
    const before = fs.readFileSync(target);
    const { file, record, change } = plan(root, host);
    assert.equal(jig.SCHEMA_VERSION, 1, "config and manifest version must stay unchanged");
    assert.equal(record.schemaVersion, 2);
    assert.deepEqual(jig.readPlan(file), record);
    assert.throws(() => legacyReadPlan(file), /schemaVersion 2 and this engine reads 1/);
    assert.throws(() => jig.cmdApply(root, { _: [], change: [], path: [], plan: record.planId }), /Approve each one/);
    apply(root, change);
    const applied = fs.readFileSync(target);
    assert.notDeepEqual(applied, before);
    apply(root, change);
    assert.deepEqual(fs.readFileSync(target), applied);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".jig/config.json"), "utf8")).schemaVersion, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".jig/manifest.json"), "utf8")).schemaVersion, 1);
    jig.cmdRevert(root, { _: [], change: [change.id] });
    assert.deepEqual(fs.readFileSync(target), before);
  });
}

test("ordinary plans stay version 1 and cannot acquire version 2 by changing the header", (t) => {
  const root = fixture(t);
  const result = jig.planFromDraft({ changes: [{ id: "ordinary", kind: "write-side-file", path: "note.md", content: "Note.\n" }] }, root);
  assert.deepEqual(result.problems, []);
  assert.equal(result.payload.schemaVersion, 1);
  const file = path.join(root, ".jig/plan-aabbcc.json");
  save(file, result.payload);
  assert.equal(JSON.stringify(legacyReadPlan(file)), JSON.stringify(jig.readPlan(file)));
  for (const changes of [[], result.payload.changes]) {
    save(file, { ...result.payload, schemaVersion: 2, changes });
    assert.throws(() => jig.readPlan(file), /host migration/);
  }
});

test("version 2 rejects absent metadata, unsupported targets, changed IDs, and mixed plans", (t) => {
  const root = fixture(t);
  const { file, record } = plan(root);
  const cases = [
    (copy) => { delete copy.changes[0].migrationReview; },
    (copy) => { copy.changes[0].migrationReview.version = 2; },
    (copy) => { copy.changes[0].migrationReview.snapshot = null; },
    (copy) => { copy.changes[0].path = "unrelated.md"; },
    (copy) => { copy.changes[0].id = "approved-other-id"; },
    (copy) => { copy.planId = "000000000000"; },
    (copy) => { copy.changes.push({ id: "ordinary", kind: "write-side-file", path: "note.md", content: "Note.\n" }); },
  ];
  for (const mutate of cases) {
    const copy = structuredClone(record);
    mutate(copy);
    save(file, copy);
    assert.throws(() => jig.readPlan(file), /host migration/);
  }
  save(file, record);
  const mixed = jig.planFromDraft({ changes: [...record.changes,
    { id: "ordinary", kind: "write-side-file", path: "note.md", content: "Note.\n" }] }, root);
  assert.match(mixed.problems.join("; "), /exactly one reviewed bridge/);
});

test("current readers reject a host plan downgraded to version 1", (t) => {
  const root = fixture(t);
  const { file, record } = plan(root);
  save(file, { ...record, schemaVersion: 1 });
  assert.throws(() => jig.readPlan(file), /requires schemaVersion 2/);
});

test("reading historical version 2 plans is pure while selected stale apply still refuses", (t) => {
  const root = fixture(t);
  const { file, record, change } = plan(root);
  fs.appendFileSync(path.join(root, "CLAUDE.md"), "A new owner instruction.\n");
  assert.deepEqual(jig.readPlan(file), record, "loading history must not require its sources to still match");
  const target = fs.readFileSync(path.join(root, change.path));
  const ordinary = jig.planFromDraft({ changes: [
    { id: "ordinary-first", kind: "write-side-file", path: "note.md", content: "Approved ordinary note.\n" },
  ] }, root).payload;
  save(path.join(root, ".jig/plan-" + ordinary.planId + ".json"), ordinary);
  assert.throws(() => jig.cmdApply(root, { _: [], change: ["ordinary-first", change.id],
    path: ["note.md", change.path] }), /changed since review/);
  assert.equal(fs.existsSync(path.join(root, "note.md")), false, "stale bridge preflight must run before an earlier selected write");
  assert.deepEqual(fs.readFileSync(path.join(root, change.path)), target);
  assert.equal(fs.existsSync(path.join(root, ".jig/journal.jsonl")), false);
});
