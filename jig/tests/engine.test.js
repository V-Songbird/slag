"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const engine = require("../scripts/jig.js");

const CLI = path.join(__dirname, "..", "scripts", "jig.js");
const FIXTURES = path.join(__dirname, "fixtures");

function tmpProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jig-test-"));
  for (const [rel, content] of Object.entries(files || {})) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

// Copy a fixture in as raw bytes. Reading it as text anywhere in this suite
// would launder the exact property under test.
function seedFixture(root, fixture, rel) {
  const bytes = fs.readFileSync(path.join(FIXTURES, fixture));
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
  return bytes;
}

// The approval token is now `--change <id>` and `--path <rel>` together, so the
// helper remembers what each drafted id writes rather than making every caller
// repeat the path it already wrote two lines above.
const plannedPaths = new Map();

function draft(root, changes) {
  fs.writeFileSync(path.join(root, "draft.json"), JSON.stringify({ changes }));
  const plan = engine.cmdPlan(root, { _: [], change: [], from: "draft.json" });
  for (const c of plan.changes || []) plannedPaths.set(root + "|" + c.id, c.path);
  return plan;
}

function apply(root, ids) {
  return engine.cmdApply(root, { _: [], change: ids, path: ids.map((id) => plannedPaths.get(root + "|" + id)) });
}

// ---------------------------------------------------------------------------
// Schema discipline
// ---------------------------------------------------------------------------

test("every jig schema ships at version 1 and a newer plan is refused, not guessed", () => {
  assert.equal(engine.SCHEMA_VERSION, 1);
  const root = tmpProject({});
  fs.mkdirSync(path.join(root, ".jig"), { recursive: true });
  const file = path.join(root, ".jig", "plan-deadbeef0000.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, planId: "deadbeef0000", changes: [] }));
  assert.throws(() => engine.readPlan(file), /schemaVersion 2 and this engine reads 1/);
});

// ---------------------------------------------------------------------------
// The path guard
// ---------------------------------------------------------------------------

test("a target that escapes the project root is refused before any write", () => {
  const root = tmpProject({});
  for (const escape of ["../evil.json", "..\\evil.json", "C:/Windows/evil.json", "/etc/evil.json"]) {
    assert.match(String(engine.targetProblem(root, "write-side-file", escape)), /escapes the project root/);
  }
  assert.equal(engine.resolveInsideRoot(root, "../evil.json"), null);
  assert.notEqual(engine.resolveWritePath(root, ".jig/checks/run.mjs"), null);
});

// The widened boundary (SCOPE, "What this reverses"): the two kinds that carry a
// linter config or a package install may land anywhere the owner approved by
// name; the kinds whose target IS the point of the kind keep their narrow list.
test("the per-kind allowlist decides where a kind may land inside the root", () => {
  const root = tmpProject({});
  assert.equal(engine.targetProblem(root, "write-side-file", ".jig/checks/run.mjs"), null);
  assert.equal(engine.targetProblem(root, "write-side-file", ".github/workflows/jig.yml"), null);
  assert.equal(engine.targetProblem(root, "write-side-file", "eslint.config.js"), null);
  assert.equal(engine.targetProblem(root, "run-install", "package.json"), null);
  assert.equal(engine.targetProblem(root, "write-config", ".jig/config.json"), null);
  assert.match(String(engine.targetProblem(root, "write-config", ".jig/other.json")), /outside what write-config may write/);
  assert.match(String(engine.targetProblem(root, "write-settings", "src/index.js")), /outside what write-settings may write/);
  assert.match(String(engine.targetProblem(root, "write-side-file", ".git/hooks/pre-commit")), /inside \.git\//);
});

test("no change may write the transaction record itself", () => {
  const root = tmpProject({});
  for (const owned of [".jig/journal.jsonl", ".jig/preimages/abc", ".jig/plan-0123456789ab.json"]) {
    assert.equal(engine.isEngineOwned(owned), true);
    assert.match(String(engine.targetProblem(root, "write-side-file", owned)), /belongs to the engine/);
  }
});

// ---------------------------------------------------------------------------
// Byte fidelity — CRLF and BOM
// ---------------------------------------------------------------------------

test("a CRLF file stays CRLF when the engine rewrites it", () => {
  const root = tmpProject({});
  const before = seedFixture(root, "crlf.json", ".jig/config.json");
  assert.equal(before.includes(Buffer.from("\r\n")), true);

  draft(root, [{ id: "c1", kind: "write-config", path: ".jig/config.json", content: '{\n  "mode": "observe"\n}\n' }]);
  const result = apply(root, ["c1"]);
  assert.equal(result.applied[0].outcome, "applied");

  const after = fs.readFileSync(path.join(root, ".jig", "config.json"));
  assert.equal(after.includes(Buffer.from("\r\n")), true, "the CRLF style survived the write");
  assert.equal(after.toString("utf8").includes("\n\n"), false, "no line ending was doubled");
  assert.equal(engine.hasBom(after), false);
  assert.deepEqual(JSON.parse(after.toString("utf8")), { mode: "observe" });
});

test("a leading BOM survives the write, and so does both at once", () => {
  const root = tmpProject({});
  seedFixture(root, "bom-lf.json", ".jig/config.json");
  seedFixture(root, "crlf-bom.jsonl", ".jig/backlog.jsonl");

  draft(root, [
    { id: "bom", kind: "write-config", path: ".jig/config.json", content: '{\n  "mode": "observe"\n}\n' },
    { id: "both", kind: "write-side-file", path: ".jig/backlog.jsonl", content: '{"decision":"pass"}\n' },
  ]);
  apply(root, ["bom", "both"]);

  const config = fs.readFileSync(path.join(root, ".jig", "config.json"));
  assert.equal(engine.hasBom(config), true, "the BOM survived");
  assert.equal(config.includes(Buffer.from("\r\n")), false, "an LF file did not gain CRLF");

  const backlog = fs.readFileSync(path.join(root, ".jig", "backlog.jsonl"));
  assert.equal(engine.hasBom(backlog), true);
  assert.equal(backlog.includes(Buffer.from("\r\n")), true);
});

test("a new file gets no invented BOM and no invented CRLF", () => {
  const root = tmpProject({});
  draft(root, [{ id: "fresh", kind: "write-side-file", path: ".jig/checks/run.mjs", content: "export const ok = 1;\n" }]);
  apply(root, ["fresh"]);
  const bytes = fs.readFileSync(path.join(root, ".jig", "checks", "run.mjs"));
  assert.equal(engine.hasBom(bytes), false);
  assert.equal(bytes.includes(Buffer.from("\r\n")), false);
});

test("detectStyle reads the dominant ending, not the first one", () => {
  assert.deepEqual(engine.detectStyle(Buffer.from("a\r\nb\r\nc\n", "utf8")), { bom: false, eol: "crlf" });
  assert.deepEqual(engine.detectStyle(Buffer.from("a\nb\nc\r\n", "utf8")), { bom: false, eol: "lf" });
  assert.deepEqual(engine.detectStyle(Buffer.from("no newline at all", "utf8")), { bom: false, eol: "lf" });
  assert.deepEqual(engine.detectStyle(null), { bom: false, eol: "lf" });
});

// ---------------------------------------------------------------------------
// Staleness and idempotency
// ---------------------------------------------------------------------------

test("apply refuses a target that changed since the plan fingerprinted it", () => {
  const root = tmpProject({});
  seedFixture(root, "crlf.json", ".jig/config.json");
  draft(root, [{ id: "c1", kind: "write-config", path: ".jig/config.json", content: '{"mode":"observe"}\n' }]);

  const meanwhile = Buffer.from('{"mode":"armed"}\r\n', "utf8");
  fs.writeFileSync(path.join(root, ".jig", "config.json"), meanwhile);

  assert.throws(() => apply(root, ["c1"]), /has changed since it was fingerprinted/);
  assert.deepEqual(fs.readFileSync(path.join(root, ".jig", "config.json")), meanwhile, "the edit was left alone");
});

test("apply refuses to create a file something else already created", () => {
  const root = tmpProject({});
  draft(root, [{ id: "c1", kind: "write-side-file", path: ".jig/checks/run.mjs", content: "export const ok = 1;\n" }]);
  const other = path.join(root, ".jig", "checks", "run.mjs");
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, "// somebody else got here first\n");
  assert.throws(() => apply(root, ["c1"]), /did not exist when the plan was made/);
});

test("re-applying an applied change is a no-op, not a staleness refusal", () => {
  const root = tmpProject({});
  seedFixture(root, "crlf.json", ".jig/config.json");
  draft(root, [{ id: "c1", kind: "write-config", path: ".jig/config.json", content: '{"mode":"observe"}\n' }]);

  assert.equal(apply(root, ["c1"]).applied[0].outcome, "applied");
  const first = fs.readFileSync(path.join(root, ".jig", "config.json"));
  assert.equal(apply(root, ["c1"]).applied[0].outcome, "already-applied");
  assert.deepEqual(fs.readFileSync(path.join(root, ".jig", "config.json")), first);
});

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

test("revert puts a CRLF+BOM file back byte-for-byte", () => {
  const root = tmpProject({});
  const before = seedFixture(root, "crlf-bom.jsonl", ".jig/backlog.jsonl");
  draft(root, [{ id: "c1", kind: "write-side-file", path: ".jig/backlog.jsonl", content: '{"decision":"would-deny"}\n' }]);
  apply(root, ["c1"]);
  assert.notDeepEqual(fs.readFileSync(path.join(root, ".jig", "backlog.jsonl")), before);

  const result = engine.cmdRevert(root, { _: [], change: ["c1"] });
  assert.equal(result.reverted[0].outcome, "restored");
  assert.deepEqual(fs.readFileSync(path.join(root, ".jig", "backlog.jsonl")), before, "byte-identical");
});

test("reverting a created file removes it and the folders the write had to make", () => {
  const root = tmpProject({});
  draft(root, [{ id: "c1", kind: "write-side-file", path: ".jig/checks/nested/run.mjs", content: "export const ok = 1;\n" }]);
  apply(root, ["c1"]);
  assert.equal(fs.existsSync(path.join(root, ".jig", "checks", "nested", "run.mjs")), true);

  engine.cmdRevert(root, { _: [], change: ["c1"] });
  assert.equal(fs.existsSync(path.join(root, ".jig", "checks", "nested")), false);
  assert.equal(fs.existsSync(path.join(root, ".jig", "checks")), false);
  assert.equal(fs.existsSync(path.join(root, ".jig")), true, "the state directory itself stays");
});

test("revert refuses to discard an edit made after jig wrote the file, until forced", () => {
  const root = tmpProject({});
  const before = seedFixture(root, "crlf.json", ".jig/config.json");
  draft(root, [{ id: "c1", kind: "write-config", path: ".jig/config.json", content: '{"mode":"observe"}\n' }]);
  apply(root, ["c1"]);

  const mine = Buffer.from('{"mode":"observe","zone":"src"}\r\n', "utf8");
  fs.writeFileSync(path.join(root, ".jig", "config.json"), mine);

  assert.throws(() => engine.cmdRevert(root, { _: [], change: ["c1"] }), /changed after jig wrote it/);
  assert.deepEqual(fs.readFileSync(path.join(root, ".jig", "config.json")), mine, "nothing was restored");

  engine.cmdRevert(root, { _: [], change: ["c1"], force: true });
  assert.deepEqual(fs.readFileSync(path.join(root, ".jig", "config.json")), before);
});

test("revert --all unwinds a whole install and says so when there is nothing left", () => {
  const root = tmpProject({});
  seedFixture(root, "crlf.json", ".jig/config.json");
  draft(root, [
    { id: "a", kind: "write-config", path: ".jig/config.json", content: '{"mode":"observe"}\n' },
    { id: "b", kind: "write-side-file", path: ".jig/checks/run.mjs", content: "export const ok = 1;\n" },
  ]);
  apply(root, ["a", "b"]);

  assert.equal(engine.cmdRevert(root, { _: [], change: [], all: true }).reverted.length, 2);
  assert.equal(fs.existsSync(path.join(root, ".jig", "checks", "run.mjs")), false);
  const again = engine.cmdRevert(root, { _: [], change: [], all: true });
  assert.deepEqual(again.reverted, []);
  assert.match(again.note, /nothing to revert/);
});

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

test("the journal only ever grows, and the pre-image lives beside it", () => {
  const root = tmpProject({});
  seedFixture(root, "crlf.json", ".jig/config.json");
  draft(root, [{ id: "c1", kind: "write-config", path: ".jig/config.json", content: '{"mode":"observe"}\n' }]);

  apply(root, ["c1"]);
  const afterApply = engine.readJournal(root);
  assert.deepEqual(afterApply.map((r) => r.event), ["intent", "outcome"]);
  assert.equal(afterApply[0].preImage.length, 64, "the intent row points at a sha256 pre-image");
  assert.equal(fs.existsSync(path.join(root, ".jig", "preimages", afterApply[0].preImage)), true);

  engine.cmdRevert(root, { _: [], change: ["c1"] });
  const afterRevert = engine.readJournal(root);
  assert.deepEqual(afterRevert.map((r) => r.event), ["intent", "outcome", "restore"]);
  assert.deepEqual(afterRevert.slice(0, 2), afterApply, "the earlier rows were not rewritten");
});

test("a torn last line is tolerated, a torn earlier line is not", () => {
  const root = tmpProject({});
  seedFixture(root, "crlf.json", ".jig/config.json");
  draft(root, [{ id: "c1", kind: "write-config", path: ".jig/config.json", content: '{"mode":"observe"}\n' }]);
  apply(root, ["c1"]);

  const journal = path.join(root, ".jig", "journal.jsonl");
  const rows = fs.readFileSync(journal, "utf8");
  fs.writeFileSync(journal, rows + '{"event":"intent","chan');
  assert.equal(engine.readJournal(root).length, 2, "the interrupted append is skipped");

  fs.writeFileSync(journal, '{"event":"intent","chan\n' + rows);
  assert.throws(() => engine.readJournal(root), /is damaged: line 1/);
});

test("a missing or edited pre-image blocks the restore instead of writing the wrong bytes", () => {
  const root = tmpProject({});
  seedFixture(root, "crlf.json", ".jig/config.json");
  draft(root, [{ id: "c1", kind: "write-config", path: ".jig/config.json", content: '{"mode":"observe"}\n' }]);
  apply(root, ["c1"]);

  const sha = engine.readJournal(root)[0].preImage;
  const file = path.join(root, ".jig", "preimages", sha);
  fs.writeFileSync(file, "not what the file looked like\n");
  assert.throws(() => engine.cmdRevert(root, { _: [], change: ["c1"] }), /does not match its own fingerprint/);

  fs.rmSync(file);
  assert.throws(() => engine.cmdRevert(root, { _: [], change: ["c1"] }), /is missing from \.jig\/preimages/);
});

// ---------------------------------------------------------------------------
// The validator registry
// ---------------------------------------------------------------------------

test("each validator declares how it verifies, and json/jsonl/js are the v1 set", () => {
  assert.deepEqual(Object.keys(engine.VALIDATORS).sort(), ["js", "json", "jsonl"]);
  assert.equal(engine.VALIDATORS.json.verifyBy, "parse");
  assert.equal(engine.VALIDATORS.jsonl.verifyBy, "parse");
  assert.equal(engine.VALIDATORS.js.verifyBy, "exec");
  assert.equal(engine.verifyByFor(null), "none");
});

test("an artifact that does not read back is rolled back, not left on disk", () => {
  const root = tmpProject({});
  draft(root, [{ id: "bad", kind: "write-side-file", path: ".jig/checks/run.mjs", content: "export const a = ;\n" }]);
  assert.throws(() => apply(root, ["bad"]), /was rolled back: .*is not valid JavaScript/);
  assert.equal(fs.existsSync(path.join(root, ".jig", "checks", "run.mjs")), false);
});

test("a broken edit to an existing file is put back exactly as it was", () => {
  const root = tmpProject({});
  const before = seedFixture(root, "crlf.json", ".jig/config.json");
  draft(root, [{ id: "bad", kind: "write-config", path: ".jig/config.json", content: "{ this is not json\n" }]);
  assert.throws(() => apply(root, ["bad"]), /was rolled back: .*is not valid JSON/);
  assert.deepEqual(fs.readFileSync(path.join(root, ".jig", "config.json")), before);
});

test("a format jig cannot read back is stamped an enforcement gap, at plan time and at apply", () => {
  const root = tmpProject({});
  const planned = draft(root, [
    { id: "wf", kind: "write-side-file", path: ".github/workflows/jig.yml", content: "name: jig\non: [push]\n" },
  ]);
  assert.deepEqual(planned.enforcementGaps, [".github/workflows/jig.yml"]);
  assert.equal(planned.changes[0].verifyBy, "none");
  assert.equal(planned.changes[0].enforcementGap, true);

  const applied = apply(root, ["wf"]);
  assert.deepEqual(applied.enforcementGaps, [".github/workflows/jig.yml"]);
  assert.equal(engine.cmdStatus(root).changes[0].enforcementGap, true);
});

test("a node shebang makes an extensionless file JavaScript", () => {
  const root = tmpProject({});
  seedFixture(root, "precommit-node", "scripts/git-hooks/pre-commit");
  assert.equal(engine.formatOf(root, "scripts/git-hooks/pre-commit"), "js");
  assert.equal(engine.verifyWritten(root, "scripts/git-hooks/pre-commit").problem, null);
});

// ---------------------------------------------------------------------------
// include-line — implemented, tested, reserved for 0.2.0
// ---------------------------------------------------------------------------

test("include-line is installable from 0.2.0, and only into a committed hook location", () => {
  assert.equal(engine.CHANGE_KINDS.includes("include-line"), true);
  assert.equal(engine.INSTALLABLE_KINDS.includes("include-line"), true);
  const root = tmpProject({ "scripts/git-hooks/pre-commit": "#!/bin/sh\nexit 0\n" });
  const accepted = engine.planFromDraft(
    { changes: [{ id: "c1", kind: "include-line", path: "scripts/git-hooks/pre-commit",
      line: "node .jig/checks/run.mjs # jig:checks", marker: "jig:checks" }] },
    root
  );
  assert.deepEqual(accepted.problems, []);
  // …and nowhere else: the allowlist still refuses an instruction file.
  const rejected = engine.planFromDraft(
    { changes: [{ id: "c2", kind: "include-line", path: "CLAUDE.md",
      line: "x # jig:checks", marker: "jig:checks" }] },
    root
  );
  assert.match(rejected.problems.join(" "), /include-line/);
});

test("include-line refuses on a drifted or ambiguous anchor and no-ops on its own marker", () => {
  const host = "#!/usr/bin/env node\n\"use strict\";\nrun();\nrun();\n";
  assert.match(
    String(engine.includeLineText(host, { marker: "jig:include", line: "x", anchor: "no such line" }).problem),
    /drifted since the plan/
  );
  assert.match(
    String(engine.includeLineText(host, { marker: "jig:include", line: "x", anchor: "run();" }).problem),
    /occurs more than once/
  );
  assert.match(
    String(engine.includeLineText(host + "// jig:include\n", { marker: "jig:include", line: "x" }).noop),
    /already present/
  );
});

test("include-line inserts after its anchor and the host file still parses", () => {
  const root = tmpProject({});
  seedFixture(root, "precommit-node", "scripts/git-hooks/pre-commit");
  const rel = "scripts/git-hooks/pre-commit";
  const host = fs.readFileSync(path.join(root, rel), "utf8");

  const good = engine.includeLineText(host, {
    marker: "jig:include", anchor: '"use strict";', line: 'require("../../.jig/checks/run.mjs"); // jig:include',
  });
  fs.writeFileSync(path.join(root, rel), good.text);
  assert.equal(engine.verifyWritten(root, rel).problem, null);

  // Amendment 1's lesson, mechanically: a shell-syntax line in a node hook is a
  // SyntaxError, and the post-write re-parse is what catches it.
  const bad = engine.includeLineText(host, {
    marker: "jig:include", anchor: '"use strict";', line: ". .jig/checks/run.sh # jig:include",
  });
  fs.writeFileSync(path.join(root, rel), bad.text);
  assert.match(String(engine.verifyWritten(root, rel).problem), /is not valid JavaScript/);
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test("status on an untouched repository writes nothing", () => {
  const root = tmpProject({});
  const state = engine.cmdStatus(root);
  assert.equal(state.ok, true);
  assert.equal(state.journal, null);
  assert.deepEqual(state.changes, []);
  assert.deepEqual(state.open, []);
  assert.equal(fs.existsSync(path.join(root, ".jig")), false, "asking created nothing");
});

test("status reports each change as applied, then reverted", () => {
  const root = tmpProject({});
  seedFixture(root, "crlf.json", ".jig/config.json");
  draft(root, [{ id: "c1", kind: "write-config", path: ".jig/config.json", content: '{"mode":"observe"}\n' }]);
  apply(root, ["c1"]);

  const applied = engine.cmdStatus(root);
  assert.equal(applied.changes[0].state, "applied");
  assert.deepEqual(applied.open, ["c1"]);
  assert.equal(applied.plans.length, 1);

  engine.cmdRevert(root, { _: [], change: ["c1"] });
  const reverted = engine.cmdStatus(root);
  assert.equal(reverted.changes[0].state, "reverted");
  assert.deepEqual(reverted.open, []);
});

// ---------------------------------------------------------------------------
// The CLI itself
// ---------------------------------------------------------------------------

test("the CLI prints JSON and exits 0 for status on a repository with no journal", () => {
  const root = tmpProject({});
  const run = spawnSync(process.execPath, [CLI, "status"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const state = JSON.parse(run.stdout);
  assert.equal(state.journal, null);
  assert.equal(fs.existsSync(path.join(root, ".jig")), false);
});

test("apply without an approval boundary is a refusal, not the whole plan", () => {
  const root = tmpProject({});
  draft(root, [{ id: "c1", kind: "write-side-file", path: ".jig/checks/run.mjs", content: "export const ok = 1;\n" }]);
  const run = spawnSync(process.execPath, [CLI, "apply"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /the argument is the approval boundary/);
  assert.equal(fs.existsSync(path.join(root, ".jig", "checks", "run.mjs")), false);
});

test("the state directory jig creates keeps its own machine-local files out of git", () => {
  const root = tmpProject({});
  draft(root, [{ id: "c1", kind: "write-side-file", path: ".jig/checks/run.mjs", content: "export const ok = 1;\n" }]);
  apply(root, ["c1"]);
  const ignore = fs.readFileSync(path.join(root, ".jig", ".gitignore"), "utf8");
  assert.match(ignore, /journal\.jsonl/);
  assert.match(ignore, /preimages\//);
});

// ---------------------------------------------------------------------------
// include-line, applied for real (0.2.0 git-hook activation)

const NODE_HOOK = fs.readFileSync(path.join(__dirname, "fixtures", "precommit-node"), "utf-8");
const ACTIVATION = require("../scripts/catalogue.json").activation;

function hookProject(body) {
  return tmpProject({ "scripts/git-hooks/pre-commit": body });
}

function includeDraft(entry, anchor) {
  return [{ id: "wire-hook", kind: "include-line", path: "scripts/git-hooks/pre-commit",
    line: entry.line, marker: entry.marker, anchor }];
}


test("the node activation line lands after the anchor in a node-shebang hook, and verifies as JavaScript", () => {
  const root = hookProject(NODE_HOOK);
  draft(root, includeDraft(ACTIVATION.node, '"use strict";'));
  const applied = apply(root, ["wire-hook"]);
  assert.equal(applied.applied[0].outcome, "applied");
  assert.equal(applied.applied[0].verifyBy, "exec");
  const after = fs.readFileSync(path.join(root, "scripts/git-hooks/pre-commit"), "utf-8");
  assert.ok(after.includes(ACTIVATION.node.line));
  assert.ok(after.indexOf(ACTIVATION.node.line) < after.indexOf("process.exit(0)"),
    "the line landed after the early exit, where it would never run");
});

test("re-applying the activation is a no-op, and an edited host still accepts the weave", () => {
  const root = hookProject(NODE_HOOK);
  draft(root, includeDraft(ACTIVATION.node, '"use strict";'));
  apply(root, ["wire-hook"]);
  const again = apply(root, ["wire-hook"]);
  assert.equal(again.applied[0].outcome, "already-applied");

  const edited = hookProject(NODE_HOOK);
  draft(edited, includeDraft(ACTIVATION.node, '"use strict";'));
  fs.appendFileSync(path.join(edited, "scripts/git-hooks/pre-commit"), "// edited after the plan\n");
  const applied = apply(edited, ["wire-hook"]);
  assert.equal(applied.applied[0].outcome, "applied");
});

test("revert restores the hook byte for byte after an include-line apply", () => {
  const root = hookProject(NODE_HOOK);
  draft(root, includeDraft(ACTIVATION.node, '"use strict";'));
  apply(root, ["wire-hook"]);
  engine.cmdRevert(root, { _: [], change: [], all: true });
  assert.equal(fs.readFileSync(path.join(root, "scripts/git-hooks/pre-commit"), "utf-8"), NODE_HOOK);
});

test("an sh hook takes the sh line and is stamped a gap, because jig cannot parse sh back", () => {
  const root = hookProject("#!/bin/sh\nset -e\n");
  draft(root, includeDraft(ACTIVATION.sh));
  const applied = apply(root, ["wire-hook"]);
  assert.equal(applied.applied[0].outcome, "applied");
  assert.equal(applied.applied[0].enforcementGap, true);
  const after = fs.readFileSync(path.join(root, "scripts/git-hooks/pre-commit"), "utf-8");
  assert.ok(after.trimEnd().endsWith(ACTIVATION.sh.line));
});

// ---------------------------------------------------------------------------
// write-settings, behind the permissions probe gate (0.4.0)

test("write-settings is refused until the probe series is green, then installs item-approved", () => {
  const settingsDraft = [{ id: "perm", kind: "write-settings", path: ".claude/settings.json",
    content: '{\n  "permissions": { "deny": ["Bash(curl * | sh)"] }\n}\n' }];

  const gated = tmpProject({ ".claude/settings.json": "{}\n" });
  delete process.env.JIG_PROBE_RESULTS;
  const refused = engine.planFromDraft({ changes: settingsDraft }, gated);
  assert.match(refused.problems.join(" "), /gated behind the permissions probe series/);

  const green = tmpProject({ ".claude/settings.json": "{}\n" });
  const results = path.join(green, "probe-results.json");
  fs.writeFileSync(results, JSON.stringify({ cliVersion: "9.9.9 (probe fixture)", green: true, checks: [] }));
  process.env.JIG_PROBE_RESULTS = results;
  try {
    draft(green, settingsDraft);
    const applied = apply(green, ["perm"]);
    assert.equal(applied.applied[0].outcome, "applied");
    const written = JSON.parse(fs.readFileSync(path.join(green, ".claude", "settings.json"), "utf-8"));
    assert.deepEqual(written.permissions.deny, ["Bash(curl * | sh)"]);
    engine.cmdRevert(green, { _: [], change: [], all: true });
    assert.equal(fs.readFileSync(path.join(green, ".claude", "settings.json"), "utf-8"), "{}\n");
  } finally {
    delete process.env.JIG_PROBE_RESULTS;
  }
});

test("a red or malformed probe record keeps the gate closed", () => {
  const root = tmpProject({ ".claude/settings.json": "{}\n" });
  const results = path.join(root, "probe-results.json");
  fs.writeFileSync(results, JSON.stringify({ cliVersion: "9.9.9", green: false }));
  process.env.JIG_PROBE_RESULTS = results;
  try {
    const refused = engine.planFromDraft({ changes: [{ id: "perm", kind: "write-settings",
      path: ".claude/settings.json", content: "{}\n" }] }, root);
    assert.match(refused.problems.join(" "), /probe/);
  } finally {
    delete process.env.JIG_PROBE_RESULTS;
  }
});

// ---------------------------------------------------------------------------
// The AGENTS.md region (0.5.0, the Codex column)

const REGION_SELECT = "silent-catch,test-file-deletion";

function regionPlan(root) {
  return engine.cmdPlan(root, {
    _: [], change: [], select: REGION_SELECT, "no-ci": true,
    "agents-region": true, provenance: "elicited",
  });
}

test("the region lands fenced, replaces only itself, and never touches the user's own text", () => {
  const root = tmpProject({ "AGENTS.md": "# My rules\n\n- Mine stays mine.\n" });
  const plan = regionPlan(root);
  engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  const first = fs.readFileSync(path.join(root, "AGENTS.md"), "utf-8");
  assert.match(first, /# My rules/);
  assert.match(first, /jig:begin/);
  assert.match(first, /node \.jig\/checks\/run\.mjs/);

  // Re-planning with a different selection rewrites ONLY the region.
  const wider = engine.cmdPlan(root, {
    _: [], change: [], select: "silent-catch", "no-ci": true,
    "agents-region": true, provenance: "elicited",
  });
  engine.cmdApply(root, { _: [], change: [], plan: wider.planId });
  const second = fs.readFileSync(path.join(root, "AGENTS.md"), "utf-8");
  assert.match(second, /# My rules/);
  assert.equal(second.match(/jig:begin/g).length, 1, "the region duplicated instead of replacing itself");
  assert.equal(second.includes("test-file-deletion."), false);
});

test("a repository with no AGENTS.md gets one holding only the region, and revert removes it", () => {
  const root = tmpProject({});
  const plan = regionPlan(root);
  engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  const text = fs.readFileSync(path.join(root, "AGENTS.md"), "utf-8");
  assert.ok(text.startsWith(engine.AGENTS_BEGIN || "<!-- jig:begin"), "the file holds more than the region");
  engine.cmdRevert(root, { _: [], change: [], all: true });
  assert.equal(fs.existsSync(path.join(root, "AGENTS.md")), false);
});

test("the loadability ceiling refuses a region that would push AGENTS.md past 32 KiB", () => {
  const root = tmpProject({ "AGENTS.md": "# Mine\n" + "x".repeat(32700) + "\n" });
  const plan = regionPlan(root);
  assert.throws(() => engine.cmdApply(root, { _: [], change: [], plan: plan.planId }),
    /loadability ceiling/);
});

// ---------------------------------------------------------------------------
// The CLI entry itself (1.0.1)

test("every command runs through the real CLI entry, not just through require", () => {
  // The require cycle bug: jig-lib reads SCHEMA_VERSION and STATE_DIR off this
  // module's exports, and main() used to run BEFORE the exports assignment —
  // so any command that lazy-requires jig-lib worked under require (tests,
  // the runner) and broke only when invoked as `node jig.js <command>`.
  const root = tmpProject({ "package.json": "{ \"private\": true }\n" });
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args, "--root", root],
    { encoding: "utf-8", windowsHide: true });

  const plan = JSON.parse(cli(["plan", "--select", "silent-catch", "--no-ci",
    "--provenance", "elicited"]).stdout);
  assert.equal(plan.ok, true);
  assert.equal(cli(["apply", "--plan", plan.planId]).status, 0);
  const review = cli(["review"]);
  assert.equal(review.status, 0, "the review CLI died: " + review.stderr);
  assert.equal(JSON.parse(review.stdout).ok, true);
  assert.equal(cli(["rerun"]).status, 0);
  assert.equal(cli(["status"]).status, 0);
});
