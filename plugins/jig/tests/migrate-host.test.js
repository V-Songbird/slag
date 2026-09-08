"use strict";

// Host migration transports reviewed instruction pointers. It must never
// recreate a harness, rewrite a proof-bearing module, or spend an approval
// after the source/target/install the owner reviewed has changed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const jig = require("../scripts/jig.js");
const migrate = require("../scripts/migrate.js");
const admission = require("../scripts/admission.js");
const A = require("./authored.js");

const OPTIONS = Object.freeze({ _: [], change: [], path: [] });
const HISTORY = '{"ts":"2026-01-01T00:00:00Z","session":"old-owner-session","guardId":"keep-armed-id","decision":"deny"}\n';

function write(root, rel, value) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, value);
}
function bytes(root, rel) { return fs.readFileSync(path.join(root, rel)); }
function read(root, rel) { return bytes(root, rel).toString("utf8"); }
function json(root, rel) { return JSON.parse(read(root, rel)); }
function snapshot(root) {
  const result = new Map();
  function walk(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else result.set(rel, bytes(root, rel));
    }
  }
  walk(root);
  return result;
}
function assertExistingBytes(root, before) {
  for (const [rel, value] of before) assert.deepEqual(bytes(root, rel), value, "changed existing bytes: " + rel);
}
function assertOnlyPlanRecords(root, before) {
  assertExistingBytes(root, before);
  for (const rel of snapshot(root).keys()) {
    if (before.has(rel)) continue;
    assert.match(rel, /^\.jig\/plan(?:-[a-z0-9]+)?\.(?:json|md)$/, "planning wrote a non-plan file: " + rel);
  }
}
function fixture(t, options = {}) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "jig-host-migrate-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith("jig-host-migrate-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  write(root, "CLAUDE.md", "# Claude owner\nCLAUDE_ROOT_OWNER_TEXT\nRead docs/architecture.md.\n");
  write(root, "AGENTS.md", "# Codex owner\nCODEX_ROOT_OWNER_TEXT\nRead docs/architecture.md.\n");
  write(root, "packages/api/CLAUDE.md", "# Local Claude instructions\nCLAUDE_PACKAGE_SCOPED_TEXT\n");
  write(root, "packages/api/AGENTS.md", "# Local Codex instructions\nCODEX_PACKAGE_SCOPED_TEXT\n");
  write(root, ".claude/rules/api.md", '---\npaths: ["src/api/**"]\n---\nCLAUDE_API_SCOPED_RULE_TEXT\n');
  write(root, "docs/architecture.md", "# Architecture\nPreserve the approved engine boundary.\n");
  write(root, "src/api/handler.js", "export const handler = () => 1;\n");

  const artifacts = [];
  const guards = [];
  for (const [index, mode] of ["armed", "observe"].entries()) {
    const id = "preserved-check-" + index;
    const spec = {
      id, title: "Keep the owner's existing " + mode + " check", actor: "claude-session",
      detectors: [{ lever: "edit-guard", actor: "claude-session", confidence: "deterministic",
        params: { patterns: ["UNAPPROVED_" + index], paths: ["**/*.js"], onlyWhenIntroduced: true } }],
      fixtures: { violation: "UNAPPROVED_" + index + "\n", nearMiss: "APPROVED_" + index + "\n" },
      deny: { reason: "The owner disallowed this fixture.", alternative: "Use the approved value.", override: "Ask the owner to review this guard." },
    };
    const module = A.moduleSource(spec);
    const rel = ".jig/checks/" + id + ".check.mjs";
    const proof = admission.proofHash(module, spec.fixtures.violation, spec.fixtures.nearMiss);
    write(root, rel, module);
    artifacts.push({ id: "installed-" + id, path: rel, kind: "write-side-file", ownership: "file",
      hash: jig.hashBytes(Buffer.from(module)), proof, provenance: "elicited", state: "active",
      installedAt: "2026-01-01T00:00:00Z", txId: "old-install", template: { name: "check-" + id, version: "authored" } });
    guards.push({ id: mode === "armed" ? "keep-armed-id" : "keep-observe-id", check: id, classId: id,
      runner: "PreToolUse", mode, teach: index === 1, provenance: "elicited", proof });
  }
  write(root, ".jig/checks/run.mjs", Buffer.concat([
    fs.readFileSync(path.join(__dirname, "../scripts/templates/run.mjs")),
    Buffer.from("\n// Existing installed driver: host migration must preserve this version.\n"),
  ]));
  write(root, ".jig/config.json", JSON.stringify({ schemaVersion: 1, guards }, null, 2) + "\n");
  write(root, ".jig/manifest.json", JSON.stringify({ schemaVersion: 1, artifacts }, null, 2) + "\n");
  write(root, ".jig/ledger.jsonl", HISTORY);
  write(root, ".jig/journal.jsonl", '{"kind":"historical-owner-note","preserve":"exact original audit bytes"}\n');
  write(root, ".jig/preimages/" + "a".repeat(64), Buffer.from([0, 255, 13, 10, 7]));
  write(root, ".jig/.gitignore", "ledger.jsonl\njournal.jsonl\npreimages/\nplan-*\n");
  if (options.override) write(root, "AGENTS.override.md", Buffer.from("\ufeff# Active owner policy\r\nKeep these CRLF bytes exactly.\r\n"));
  return root;
}
function planFor(root, host) {
  const result = migrate.cmdMigrate(root, { ...OPTIONS, host });
  assert.equal(result.ok, true);
  assert.equal(result.host, host);
  assert.deepEqual(result.migrated, [], "host migration must only plan");
  assert.equal(result.changes.length, 1, "host migration should propose one owned target region");
  assert.equal(typeof result.plan, "string");
  const change = result.changes[0];
  assert.equal(typeof change.id, "string");
  assert.equal(typeof change.content, "string");
  assert.match(change.apply, /--change/);
  assert.ok(change.apply.includes(change.id) && change.apply.includes(change.path));
  return { result, change };
}
function apply(root, change) {
  return jig.cmdApply(root, { ...OPTIONS, change: [change.id], path: [change.path] });
}
function retainedInstall(root) {
  const all = snapshot(root);
  return new Map([...all].filter(([rel]) => rel === ".jig/config.json" || rel === ".jig/ledger.jsonl"
    || rel.startsWith(".jig/checks/") || rel.startsWith(".jig/preimages/")));
}
function assertRefusedWithoutMutation(root, change) {
  const before = snapshot(root);
  assert.throws(() => apply(root, change), /changed|stale|review|refus|migration/i);
  assert.deepEqual(snapshot(root), before, "a stale approval wrote files before refusing");
}

for (const host of ["codex", "claude"]) {
  test("host migration to " + host + " is plan-only, scoped, explicitly approved, and reversible", (t) => {
    const root = fixture(t);
    const original = snapshot(root);
    const protectedInstall = retainedInstall(root);
    const originalArtifacts = json(root, ".jig/manifest.json").artifacts;
    const { result, change } = planFor(root, host);
    assert.equal(change.path, host === "codex" ? "AGENTS.md" : "CLAUDE.md");
    assertOnlyPlanRecords(root, original);

    const source = host === "codex" ? "CLAUDE.md" : "AGENTS.md";
    const nested = "packages/api/" + source;
    assert.ok(change.content.includes(source), "root source instructions were omitted");
    assert.ok(change.content.includes(nested), "nested source instructions were omitted");
    assert.equal(change.content.includes(host === "codex" ? "CLAUDE_PACKAGE_SCOPED_TEXT" : "CODEX_PACKAGE_SCOPED_TEXT"), false,
      "nested instructions were copied into global scope instead of referenced");
    const nestedReport = result.report.instructions.find((item) => item.path === nested);
    assert.ok(nestedReport, "scoped instruction is absent from the report");
    assert.ok(JSON.stringify(nestedReport).includes("packages/api"), "nested scope was not reported");
    if (host === "codex") {
      assert.ok(change.content.includes(".claude/rules/api.md"));
      assert.ok(change.content.includes("src/api/**"), "the rule's declared path restriction was dropped");
      assert.equal(change.content.includes("CLAUDE_API_SCOPED_RULE_TEXT"), false);
    }

    assert.throws(() => jig.cmdApply(root, { ...OPTIONS, plan: result.plan }), /Approve each one by name|Refusing to apply/);
    assert.throws(() => jig.cmdApply(root, { ...OPTIONS, change: [change.id] }), /--path/);
    assert.throws(() => jig.cmdApply(root, { ...OPTIONS, change: [change.id], path: ["unapproved.md"] }), /Refusing to apply/);
    assertOnlyPlanRecords(root, original);
    const applied = apply(root, change);
    assert.equal(applied.ok, true);
    assert.equal(read(root, change.path), change.content);
    assertExistingBytes(root, protectedInstall);
    assert.deepEqual(bytes(root, source), original.get(source));
    assert.deepEqual(bytes(root, nested), original.get(nested));
    assert.ok(read(root, ".jig/journal.jsonl").startsWith(original.get(".jig/journal.jsonl").toString("utf8")));
    for (const artifact of originalArtifacts) {
      assert.deepEqual(json(root, ".jig/manifest.json").artifacts.find((row) => row.path === artifact.path), artifact,
        "the existing manifest/proof row changed");
    }

    const reverted = jig.cmdRevert(root, { ...OPTIONS, tx: applied.tx });
    assert.equal(reverted.ok, true);
    assert.ok(reverted.reverted.some((row) => row.path === change.path));
    assert.deepEqual(bytes(root, change.path), original.get(change.path));
    assert.deepEqual(bytes(root, ".jig/manifest.json"), original.get(".jig/manifest.json"));
    assertExistingBytes(root, protectedInstall);
    assert.deepEqual(bytes(root, source), original.get(source));
  });
}

test("Codex migration selects the active override and preserves its BOM and CRLF owner prefix", (t) => {
  const root = fixture(t, { override: true });
  const owner = bytes(root, "AGENTS.override.md");
  const shadowed = bytes(root, "AGENTS.md");
  const { change } = planFor(root, "codex");
  assert.equal(change.path, "AGENTS.override.md");
  const applied = apply(root, change);
  assert.deepEqual(bytes(root, change.path).subarray(0, owner.length), owner);
  assert.deepEqual(bytes(root, "AGENTS.md"), shadowed);
  assert.equal(read(root, change.path).replace(/\r\n/g, "").includes("\n"), false, "generated region ignored owner CRLF style");
  jig.cmdRevert(root, { ...OPTIONS, tx: applied.tx });
  assert.deepEqual(bytes(root, change.path), owner);
});

test("unchanged host migration is idempotent on rerun and identical named reapply", (t) => {
  const root = fixture(t);
  const { change } = planFor(root, "codex");
  apply(root, change);
  const before = snapshot(root);
  const rerun = migrate.cmdMigrate(root, { ...OPTIONS, host: "codex" });
  assert.equal(rerun.ok, true);
  assert.equal(rerun.plan, null);
  assert.deepEqual(rerun.changes, []);
  assert.deepEqual(snapshot(root), before);
  apply(root, change);
  assert.deepEqual(bytes(root, change.path), before.get(change.path), "reapply duplicated the owned region");
  fs.unlinkSync(path.join(root, change.path));
  assertRefusedWithoutMutation(root, change);
});

for (const [name, mutate] of [
  ["source instruction edit", (root) => fs.appendFileSync(path.join(root, "CLAUDE.md"), "\nNew owner instruction.\n")],
  ["new scoped source", (root) => write(root, "packages/new/CLAUDE.md", "# Newly scoped source\n")],
  ["new target override", (root) => write(root, "AGENTS.override.md", "# New active owner instructions\n")],
  ["changed target owner text", (root) => fs.appendFileSync(path.join(root, "AGENTS.md"), "\nNew target owner instruction.\n")],
  ["changed installed config", (root) => {
    const config = json(root, ".jig/config.json");
    config.guards[0].mode = "observe";
    write(root, ".jig/config.json", JSON.stringify(config) + "\n");
  }],
  ["changed installed manifest", (root) => {
    const manifest = json(root, ".jig/manifest.json");
    manifest.artifacts[0].proof = "b".repeat(64);
    write(root, ".jig/manifest.json", JSON.stringify(manifest) + "\n");
  }],
]) {
  test("host migration refuses stale approval after " + name, (t) => {
    const root = fixture(t);
    const { change } = planFor(root, "codex");
    mutate(root);
    assertRefusedWithoutMutation(root, change);
  });
}

test("source instruction drift is reported and preserved rather than silently repaired", (t) => {
  const root = fixture(t);
  const source = ".claude/rules/api.md";
  const manifest = json(root, ".jig/manifest.json");
  manifest.artifacts.push({ id: "old-governance", path: source, kind: "write-rule", ownership: "file",
    hash: jig.hashBytes(Buffer.from("previous installed rule\n")), proof: null, state: "active",
    template: { name: "jig-governance", version: "1.0.0" } });
  write(root, ".jig/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  const ownerBytes = bytes(root, source);
  const { result, change } = planFor(root, "codex");
  const driftRows = Object.entries(result.report).filter(([key]) => /drift/i.test(key)).map(([, value]) => value);
  assert.ok(JSON.stringify(driftRows).includes(source), "the exact source drift is absent from the drift report");
  apply(root, change);
  assert.deepEqual(bytes(root, source), ownerBytes);
});

test("an unknown host is rejected without writes, while no host retains ordinary migration behavior", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  assert.throws(() => migrate.cmdMigrate(root, { ...OPTIONS, host: "unsupported-host" }), /host|codex|claude/i);
  assert.deepEqual(snapshot(root), before);
  const ordinary = migrate.cmdMigrate(root, OPTIONS);
  assert.equal(ordinary.ok, true);
  assert.deepEqual(ordinary.migrated, []);
  assert.deepEqual(snapshot(root), before, "ordinary pair-shaped migration unexpectedly converted host instructions");
});

const hostMigration = require("../scripts/migrate-host.js");

test("alternating host migrations stabilize without recursively importing their bridges", (t) => {
  const root = fixture(t);
  apply(root, planFor(root, "codex").change);
  apply(root, planFor(root, "claude").change);
  const before = snapshot(root);
  for (const host of ["codex", "claude", "codex"]) {
    const result = migrate.cmdMigrate(root, { ...OPTIONS, host });
    assert.equal(result.plan, null, host + " unnecessarily re-migrated the other bridge");
  }
  assert.deepEqual(snapshot(root), before);
});

test("new source content requires a new approval even when its path and scope are unchanged", (t) => {
  const root = fixture(t);
  const first = planFor(root, "codex").change;
  fs.appendFileSync(path.join(root, "CLAUDE.md"), "\nNew approved architecture decision.\n");
  const second = planFor(root, "codex").change;
  assert.notEqual(first.id, second.id);
  assertRefusedWithoutMutation(root, first);
  apply(root, second);
});

test("named reapply tolerates the manifest ordering performed by apply itself", (t) => {
  const root = fixture(t);
  const manifest = json(root, ".jig/manifest.json");
  manifest.artifacts.reverse();
  write(root, ".jig/manifest.json", JSON.stringify(manifest));
  const { change } = planFor(root, "codex");
  apply(root, change);
  assert.doesNotThrow(() => apply(root, change));
});

test("nested repositories are excluded and reported without importing their instructions", (t) => {
  const root = fixture(t);
  write(root, "other-project/.git", "gitdir: elsewhere\n");
  write(root, "other-project/CLAUDE.md", "Unrelated repository policy.\n");
  const { result, change } = planFor(root, "codex");
  assert.ok(result.report.nestedRepositories.includes("other-project"));
  assert.ok(!result.report.instructions.some((r) => r.path.startsWith("other-project/")));
  assert.doesNotMatch(change.content, /other-project/);
});

test("rule scopes retain quoted brace globs and reject ambiguous YAML rather than broadening it", () => {
  for (const source of ['---\npaths: ["src/{api,web}/**", "tests/**"]\n---\nbody', "---\npaths:\n  - 'src/{api,web}/**'\n  - tests/**\n---\nbody"]) {
    assert.deepEqual(hostMigration.rulePaths(source), { paths: ["src/{api,web}/**", "tests/**"] });
  }
  assert.deepEqual(hostMigration.rulePaths("---\n---\nbody"), { paths: null });
  for (const source of ["---\npaths: &alias\n---\nbody", "---\npaths: []\n---\nbody", "---\npaths: [\"a\" \"b\"]\n---\nbody"]) {
    assert.ok(hostMigration.rulePaths(source).problem);
  }
});

test("ambiguous scope reports the exact file and produces no plan", (t) => {
  const root = fixture(t);
  write(root, ".claude/rules/api.md", "---\npaths: *scopes\n---\nDo not globalize me.\n");
  const before = snapshot(root);
  const result = migrate.cmdMigrate(root, { ...OPTIONS, host: "codex" });
  assert.equal(result.plan, null);
  assert.ok(result.report.unresolved.some((r) => r.path === ".claude/rules/api.md"));
  assert.deepEqual(snapshot(root), before);
});

test("a malformed existing bridge cannot be silently replaced", (t) => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, "AGENTS.md"), hostMigration.markers("codex").begin);
  const before = snapshot(root);
  assert.throws(() => migrate.cmdMigrate(root, { ...OPTIONS, host: "codex" }), /marker|boundar/i);
  assert.deepEqual(snapshot(root), before);
});

test("source deletion and target deletion both invalidate an unapplied review", (t) => {
  for (const rel of ["CLAUDE.md", "AGENTS.md"]) {
    const root = fixture(t);
    const { change } = planFor(root, "codex");
    fs.unlinkSync(path.join(root, rel));
    assertRefusedWithoutMutation(root, change);
  }
});

test("empty Codex overrides fall through while a nonempty nested override shadows AGENTS.md", (t) => {
  const root = fixture(t);
  write(root, "AGENTS.override.md", "\n");
  assert.equal(planFor(root, "codex").change.path, "AGENTS.md");
  write(root, "packages/api/AGENTS.override.md", "Nested override instructions.\n");
  const { result } = planFor(root, "claude");
  const paths = result.report.instructions.map((r) => r.path);
  assert.ok(paths.includes("packages/api/AGENTS.override.md"));
  assert.ok(!paths.includes("packages/api/AGENTS.md"));
});

test("instruction budgets refuse before writing a plan or target", (t) => {
  const root = fixture(t);
  write(root, "AGENTS.md", "Owner ".repeat(6000));
  const before = snapshot(root);
  assert.throws(() => migrate.cmdMigrate(root, { ...OPTIONS, host: "codex" }), /budget/i);
  assert.deepEqual(snapshot(root), before);
});

test("missing local history remains unavailable and native coverage is never inferred", (t) => {
  const root = fixture(t);
  fs.unlinkSync(path.join(root, ".jig/journal.jsonl"));
  fs.unlinkSync(path.join(root, ".jig/ledger.jsonl"));
  write(root, ".jig/off", "");
  const { result, change } = planFor(root, "codex");
  assert.equal(result.report.history.journal, "missing");
  assert.equal(result.report.history.ledger, "missing");
  assert.equal(result.report.session.verified, false);
  assert.equal(result.report.wiring.verified, false);
  assert.equal(result.report.controls.off, true);
  apply(root, change);
  assert.ok(fs.existsSync(path.join(root, ".jig/off")));
});

test("instruction file symlinks and directory junctions never become approved source policy", (t) => {
  const root = fixture(t);
  const external = fixture(t);
  const link = path.join(root, "linked-instructions");
  try { fs.symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (err) { if (["EPERM", "EACCES", "ENOTSUP"].includes(err.code)) { t.skip("OS does not permit symlink fixtures"); return; } throw err; }
  const result = migrate.cmdMigrate(root, { ...OPTIONS, host: "codex" });
  assert.equal(result.plan, null);
  assert.ok(result.report.unresolved.some((r) => r.path === "linked-instructions"));
  fs.unlinkSync(link);
});
