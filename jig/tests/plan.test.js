"use strict";

// The review surface: the screen somebody reads before any guard is written.
//
// Two claims are load-bearing and neither can be checked by reading the output
// — that every cell is DERIVED from each detector's own metadata and from the
// changes the plan writes, and that the host-neutral floor is REPORTED rather
// than enforced. SCOPE turned the second one around: a class nothing
// host-neutral catches is a disclosed gap now, not a refusal, so the suite
// proves the sentence still reaches the page instead of proving a throw.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const engine = require("../scripts/jig.js");
const editions = require("../scripts/editions.js");
const A = require("./authored.js");

const PLUGIN_ROOT = path.join(__dirname, "..");
const CHECKS = [A.PIPED_INSTALLER, A.EMPTY_CATCH];

const roots = [];

test.after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jig-plan-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files || {})) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

// A Node project, so exactly one edition is detected and the backlog it
// produces is a fixed list rather than whatever the machine happened to match.
function nodeProject(files) {
  return project({ "package.json": "{ \"private\": true }\n", "src/a.ts": "export const a = 1;\n", ...(files || {}) });
}

function planOnly(root, opts, checks) {
  return engine.cmdPlan(root, {
    _: [], change: [], authored: A.writeChecks(root, checks || CHECKS), provenance: "elicited", ...(opts || {}),
  });
}

function install(root, opts, checks) {
  const plan = planOnly(root, opts, checks);
  const applied = A.applyPlan(engine, root, plan);
  return { plan, applied };
}

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf-8"));
}

// A class nothing ships, so the pure grading functions can be exercised without
// first bending an edition every other suite reads.
function synthetic(overrides) {
  return {
    id: "synthetic-class",
    title: "A class invented by this test",
    severity: "hygiene",
    axes: ["agent"],
    detectors: [],
    ...overrides,
  };
}

const HOOK_DETECTOR = { actor: "claude-session", lever: "bash-guard", runner: "PreToolUse", confidence: "deterministic" };
const DRIVER_DETECTOR = { actor: "human-editor", lever: "check-driver", runner: "checks", confidence: "deterministic" };

// ---------------------------------------------------------------------------
// The host-neutral floor, as a report
// ---------------------------------------------------------------------------

test("a class with a host-neutral deterministic lever clears the floor", () => {
  const cls = synthetic({ detectors: [DRIVER_DETECTOR] });
  assert.equal(engine.hostNeutralFloor(cls), true);
  assert.equal(engine.floorNote(cls), null);
});

test("a lever only an agent host can run does not clear the floor, however deterministic", () => {
  const cls = synthetic({ detectors: [HOOK_DETECTOR] });
  assert.equal(engine.LEVERS["bash-guard"].hostNeutral, false);
  assert.equal(engine.hostNeutralFloor(cls), false);
  assert.match(engine.floorNote(cls), /no host-neutral deterministic lever/);
});

test("a host-neutral lever that can be wrong does not clear the floor either", () => {
  const cls = synthetic({ detectors: [{ ...DRIVER_DETECTOR, confidence: "heuristic" }] });
  assert.equal(engine.hostNeutralFloor(cls), false);
  assert.equal(typeof engine.floorNote(cls), "string");
});

test("the floor names the class and refuses nothing — it is a report now, not a gate", () => {
  // SCOPE, "Does hostNeutralFloor stay a release gate": no. A class nothing
  // catches is a disclosed gap, and there is no throwing floor left to call.
  assert.equal(typeof engine.floorProblem, "undefined");
  assert.equal(typeof engine.floorCheck, "undefined");
  assert.match(engine.floorNote(synthetic({ detectors: [HOOK_DETECTOR] })), /synthetic-class/);
});

test("a plan whose class fails the floor still writes the plan, and says so on the page", () => {
  const root = nodeProject();
  const plan = planOnly(root, { "no-ci": true }, [A.HEURISTIC_ONLY]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.floorGaps.map((g) => g.classId), ["test-file-removal"]);
  assert.ok(fs.existsSync(path.join(root, ".jig", "plan.json")));

  const md = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
  assert.match(md, /## ENFORCEMENT GAP/);
  assert.ok(md.includes("`test-file-removal`"));
});

test("a plan with nothing to install at all is a refusal, not an empty install", () => {
  const root = nodeProject();
  assert.throws(() => engine.cmdPlan(root, { _: [], change: [], select: "  ,  " }),
    /needs --select|--from <file>/);
  assert.equal(fs.existsSync(path.join(root, ".jig")), false, "asking created state");
});

// ---------------------------------------------------------------------------
// The matrix is computed, never authored
// ---------------------------------------------------------------------------

test("the columns are the engine's own actor list, in its own order", () => {
  const root = nodeProject();
  planOnly(root);
  const matrix = readJson(root, ".jig/plan.json");
  assert.deepEqual(matrix.actors, engine.ACTORS);
  for (const row of matrix.rows) assert.deepEqual(Object.keys(row.cells), engine.ACTORS);
});

test("there is one row per selected class and nothing else", () => {
  const root = nodeProject();
  planOnly(root);
  const matrix = readJson(root, ".jig/plan.json");
  assert.deepEqual(matrix.rows.map((r) => r.classId), ["empty-catch", "piped-installer"]);
  assert.deepEqual(matrix.selection, ["empty-catch", "piped-installer"]);
});

test("every cell traces back to a detector the class carries, or says none does", () => {
  const root = nodeProject();
  planOnly(root);
  const byId = new Map(CHECKS.map((c) => [c.id, c]));
  for (const row of readJson(root, ".jig/plan.json").rows) {
    const cls = byId.get(row.classId);
    for (const [actor, cell] of Object.entries(row.cells)) {
      if (cell.lever === null) {
        assert.equal(cell.grade, "GAP");
        assert.match(cell.why, new RegExp("no detector on this class names " + actor));
        continue;
      }
      assert.ok(engine.LEVERS[cell.lever], cell.lever + " is not a lever");
      assert.ok(cls.detectors.some((d) => d.actor === actor && d.lever === cell.lever),
        row.classId + "/" + actor + " names a detector the class does not carry");
    }
  }
});

test("every covered cell names an artifact this plan actually writes", () => {
  const root = nodeProject();
  const { plan } = install(root);
  const guards = readJson(root, ".jig/config.json").guards.map((g) => g.id);
  const paths = plan.changes.map((c) => c.path);
  for (const row of readJson(root, ".jig/plan.json").rows) {
    for (const cell of Object.values(row.cells)) {
      if (cell.grade === "GAP") { assert.equal(cell.artifact, null); continue; }
      assert.ok(paths.includes(cell.artifact) || guards.includes(cell.artifact),
        cell.artifact + " is named by a cell but written by nothing");
    }
  }
});

test("a class the editions carry and nobody authored reads GAP in every column", () => {
  // The catalogue informs and never gates (SCOPE): selecting an edition class
  // puts it on the matrix, and the matrix says plainly that this plan writes
  // nothing for it, because only an admitted check becomes an artifact.
  const root = nodeProject();
  planOnly(root, { select: "javascript-typescript/swallowed-exception" });
  const row = readJson(root, ".jig/plan.json").rows
    .find((r) => r.classId === "javascript-typescript/swallowed-exception");
  assert.equal(row.edition, "javascript-typescript");
  assert.equal(row.authored, false);
  for (const cell of Object.values(row.cells)) assert.equal(cell.grade, "GAP");
  assert.match(row.cells["human-editor"].why, /writes no check-driver artifact/);
});

test("a detector on a lever this build does not run reads GAP by name", () => {
  const cell = engine.detectorCell(synthetic({}),
    { actor: "human-ci", lever: "invented-lever", runner: "ci", confidence: "deterministic" }, 0, "elicited", [], []);
  assert.equal(engine.leverOf("invented-lever"), null);
  assert.equal(cell.grade, "GAP");
  assert.match(cell.why, /does not run/);
});

test("a detector on a lever that ships later reads GAP, naming the release", () => {
  const later = { actor: "human-editor", lever: "check-driver", runner: "checks", confidence: "deterministic" };
  assert.equal(engine.leverAvailable({ availableAt: "9.9.9" }), false);
  const cell = engine.detectorCell(synthetic({}), later, 0, "elicited", [], []);
  // Nothing writes an artifact for a synthetic class, so this cell is the other
  // GAP: available lever, no artifact.
  assert.equal(cell.grade, "GAP");
  assert.match(cell.why, /writes no check-driver artifact/);
});

test("a class covered by both a shipping lever and a later one is graded on the shipping one", () => {
  // Best-of, not first-of: two detectors on one actor, and the cell takes the
  // stronger grade rather than whichever came first in the list.
  const cls = synthetic({
    detectors: [
      { actor: "human-ci", lever: "prose-rule", runner: "none", confidence: "heuristic" },
      { actor: "human-ci", lever: "ci-workflow", runner: "ci", confidence: "deterministic" },
    ],
  });
  const changes = [{ id: "ci", path: ".github/workflows/jig.yml", template: { name: "ci-workflow" }, classIds: [cls.id] }];
  const row = engine.matrixRow(cls, "elicited", changes, []);
  assert.equal(row.cells["human-ci"].grade, "DET");
  assert.equal(row.cells["human-ci"].lever, "ci-workflow");
});

test("skipping the CI workflow drops the CI column rather than quietly keeping the claim", () => {
  const root = nodeProject();
  planOnly(root, { "no-ci": true });
  const cell = readJson(root, ".jig/plan.json").rows[0].cells["human-ci"];
  assert.equal(cell.grade, "GAP");
  assert.match(cell.why, /writes no ci-workflow artifact for empty-catch/);
});

// DERAIL-PASS defect 15, the cell it was seen through: a `--select` install with
// eslint ticked printed `DET eslint.config.mjs` for a CI job that ran the check
// driver and nothing else. The config is half the answer; the other half is a
// lane that runs the tool.
const TOOL_RULE = { actor: "human-ci", lever: "tool-rule", runner: "ci", confidence: "deterministic",
  params: { tool: "eslint", rule: "vitest/no-focused-tests" } };

function toolPlan(changes) {
  return [{ id: "toolchain-eslint", path: "eslint.config.mjs", template: { name: "toolchain-eslint" },
    classIds: ["synthetic-class"] }, ...(changes || [])];
}

function laneChange(entries) {
  return { id: "verify", path: ".jig/verify.json", kind: "write-side-file",
    content: JSON.stringify({ schemaVersion: 1, entries }) };
}

test("a tool config with no lane running the tool is GAP, and the gap names the tool", () => {
  const cls = synthetic({ detectors: [TOOL_RULE] });
  const cell = engine.matrixRow(cls, "elicited", toolPlan(), []).cells["human-ci"];
  assert.equal(cell.grade, "GAP");
  assert.equal(cell.artifact, null);
  assert.equal(cell.why, "no lane runs eslint");
});

test("a lane entry with no tool config is GAP too — both halves or nothing", () => {
  const cls = synthetic({ detectors: [TOOL_RULE] });
  const changes = [laneChange([{ id: "eslint", argv: ["npx", "eslint", "."], expectedExit: 0, paths: [], lanes: ["ci"] }])];
  const cell = engine.matrixRow(cls, "elicited", changes, []).cells["human-ci"];
  assert.equal(cell.grade, "GAP");
  assert.equal(cell.why, "no lane runs eslint");
});

test("a lane that runs another tool does not cover this one", () => {
  const cls = synthetic({ detectors: [TOOL_RULE] });
  const changes = toolPlan([laneChange([{ id: "vitest", argv: ["npx", "vitest", "run"], expectedExit: 0, paths: [], lanes: ["ci"] }])]);
  assert.equal(engine.matrixRow(cls, "elicited", changes, []).cells["human-ci"].grade, "GAP");
});

test("a tool that only runs at commit time does not fill the CI cell", () => {
  // `tool-rule` is the CI lever by definition, and the column is `human-ci`. An
  // owner who took the commit lane and declined the workflow has the tool
  // running — somewhere this column does not speak for.
  const cls = synthetic({ detectors: [TOOL_RULE] });
  const changes = toolPlan([laneChange([{ id: "eslint", argv: ["npx", "eslint", "."], expectedExit: 0, paths: [], lanes: ["commit"] }])]);
  const cell = engine.matrixRow(cls, "elicited", changes, []).cells["human-ci"];
  assert.equal(cell.grade, "GAP");
  assert.equal(cell.why, "no lane runs eslint");
});

test("the config and a lane entry together are what read DET", () => {
  const cls = synthetic({ detectors: [TOOL_RULE] });
  const changes = toolPlan([laneChange([{ id: "eslint", argv: ["npx", "eslint", "."], expectedExit: 0, paths: [], lanes: ["ci"] }])]);
  const cell = engine.matrixRow(cls, "elicited", changes, []).cells["human-ci"];
  assert.equal(cell.grade, "DET");
  assert.equal(cell.artifact, "eslint.config.mjs");
  assert.equal(cell.why, null);
});

// The config half of that pair, for a tool whose config shares a file. The
// change is named after the PATH — `toolchain-config-pyproject.toml` — so a
// lookup keyed on `toolchain-<tool>` found nothing and the cell said "no lane
// runs ruff" on a plan whose own verify.json runs ruff in CI. Measured on a
// greenfield python install: 21 such cells against one DET.
test("a config composed into a shared file is still the tool's config", () => {
  const cls = synthetic({ detectors: [{ ...TOOL_RULE, params: { tool: "ruff", rule: "PT009" } }] });
  const composed = { id: "toolchain-config-pyproject.toml", path: "pyproject.toml",
    template: { name: "toolchain-config-pyproject.toml", version: "composed" },
    tools: ["ruff", "mypy"], classIds: [cls.id] };
  const changes = [composed, laneChange([{ id: "ruff", argv: ["ruff", "check", "."], expectedExit: 0, paths: [], lanes: ["ci"] }])];
  const cell = engine.matrixRow(cls, "elicited", changes, []).cells["human-ci"];
  assert.equal(cell.grade, "DET");
  assert.equal(cell.artifact, "pyproject.toml");
  // And a tool the file does NOT configure is still uncovered by it: the list is
  // read, not the fact that some composed file exists.
  const other = synthetic({ detectors: [{ ...TOOL_RULE, params: { tool: "pytest" } }] });
  assert.equal(engine.matrixRow(other, "elicited", changes, []).cells["human-ci"].grade, "GAP");
});

test("a greenfield python plan grades every tool its own verify.json runs", () => {
  // Driven end to end, because the unit above cannot see the half that was
  // actually broken: `planFromDraft` rebuilds every change from a whitelist, so
  // the tool list has to ride the plan file too or the matrix reads none.
  const root = project();
  const edition = editions.loadEdition(PLUGIN_ROOT, "python");
  const select = edition.classes.map((c) => "python/" + c.id).join(",");
  const plan = engine.cmdPlan(root, { _: [], change: [], provenance: "elicited",
    edition: "python", "package-manager": "uv",
    tools: edition.toolchain.map((t) => t.id).join(","), select });
  const review = readJson(root, ".jig/plan.json");
  const unrun = review.rows.flatMap((r) => Object.values(r.cells))
    .filter((c) => /^no lane runs /.test(c.why || "")).map((c) => c.why);
  assert.deepEqual([...new Set(unrun)], [], "cells claiming nothing runs a tool this plan wires");
  const cells = review.rows.flatMap((r) => Object.values(r.cells)).filter((c) => c.lever === "tool-rule");
  assert.equal(cells.length, 22);
  assert.ok(cells.every((c) => c.grade !== "GAP"));
  assert.ok(cells.some((c) => c.artifact === "pyproject.toml"), "ruff, mypy and pytest are configured there");

  // And the installed half, which is the same fact read from the other side. A
  // re-plan is an interview about what to ADD, so it proposes no config at all —
  // the cell has only the manifest to ask, and a composed row that recorded no
  // tools would tell an owner their linter is uncovered while it sits configured
  // and running in CI.
  const payload = engine.planFiles(root).map(engine.readPlan).find((p) => p.planId === plan.planId);
  const keep = payload.changes.filter((c) => c.kind !== "run-install");
  engine.cmdApply(root, { _: [], change: keep.map((c) => c.id), path: keep.map((c) => c.path) });
  const composed = readJson(root, ".jig/manifest.json").artifacts.find((a) => a.path === "pyproject.toml");
  assert.ok(composed.tools.includes("ruff") && composed.tools.includes("mypy"));
  engine.cmdPlan(root, { _: [], change: [], provenance: "elicited", select });
  const again = readJson(root, ".jig/plan.json").rows.flatMap((r) => Object.values(r.cells))
    .filter((c) => c.lever === "tool-rule");
  assert.equal(again.length, 22);
  assert.ok(again.every((c) => c.grade !== "GAP"), "a re-plan reads its own install as uncovered");
});

test("an unreadable lane list is read as no lane at all, never as coverage", () => {
  const cls = synthetic({ detectors: [TOOL_RULE] });
  const torn = { id: "verify", path: ".jig/verify.json", kind: "write-side-file", content: "{ not json" };
  assert.equal(engine.proposedVerifyEntries("{ not json"), null);
  assert.equal(engine.matrixRow(cls, "elicited", toolPlan([torn]), []).cells["human-ci"].grade, "GAP");
});

// A starter file that names a tool is written only where that tool is in the
// plan. Both smoke tests otherwise: `node --test` cannot read the vitest one,
// so a project that ticked no test runner would be scaffolded with an import
// nothing resolves and a lint and a typecheck that fail on it.
test("a starter file belonging to a tool lands only where that tool is ticked", () => {
  const paths = (tools) => planOnly(project({}), {
    select: "javascript-typescript/focused-test", edition: "javascript-typescript",
    "package-manager": "npm", tools, "no-ci": true,
  }).changes.map((c) => c.path);

  const withVitest = paths("vitest");
  assert.ok(withVitest.includes("tests/smoke.spec.js"),
    "vitest was ticked and its smoke test was never planned");
  assert.ok(withVitest.includes("test/smoke.js"));

  const withoutVitest = paths("eslint");
  assert.equal(withoutVitest.includes("tests/smoke.spec.js"), false,
    "a vitest test was written into a project that ticked no test runner");
  assert.ok(withoutVitest.includes("test/smoke.js"),
    "the edition's own smoke test is not a tool's and must land either way");
});

// The template row a starter is written under is derived from the edition and
// the path, and its version is the one the catalogue recorded beside the body —
// not a hand-written 1.0.0 no install could check against anything.
test("a starter's template row names its edition and carries the catalogue's version", () => {
  const root = project({});
  install(root, {
    select: "javascript-typescript/focused-test", edition: "javascript-typescript",
    "package-manager": "npm", "no-ci": true,
  });
  const row = readJson(root, ".jig/manifest.json").artifacts.find((a) => a.path === "src/index.js");
  const recorded = editions.manifestFor(editions.loadEdition(PLUGIN_ROOT, "javascript-typescript"), "npm")
    .starter.find((f) => f.path === "src/index.js");
  assert.equal(row.template.name, "starter-javascript-typescript-src/index.js");
  assert.equal(row.template.version, recorded.version);
  // Every shipped starter is at 1.0.0, so the comparison above cannot tell a
  // version read off the catalogue from the hard-coded "1.0.0" the call site
  // used before 2.14.0 — it stays green on the reverted code. The call site is
  // what can discriminate, until two starters carry different versions, and
  // bumping one to make them differ would be a claim about a body that has not
  // changed (release gate "every shipped starter body hashes to the sha256
  // recorded beside it": the version is a claim about history, the hash is the
  // claim about the file).
  assert.match(fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "jig.js"), "utf8"),
    /name: "starter-" \+ m\.edition \+ "-" \+ file\.path, version: file\.version,/,
    "the starter template row hard-codes a version the catalogue does not supply");
  // The bytes on disk, hashed at write time, are the bytes that version shipped.
  assert.equal(row.hash, recorded.sha256);
});

// The rename ships with no migration, which is only safe because nothing reads
// a template name back: every manifest surface keys on the path and the hash.
// A row written by an older jig has to keep reporting exactly as it did, or the
// rename would have quietly retired the starters on every install already out
// there — so the pre-2.14.0 shape is pinned here rather than assumed. It is a
// pin over behaviour 2.14.0 did not touch, so no revert of the rename can make
// it fail: it does not count toward the rename's proof, which is the literal
// `template.name` assertion in the test above.
test("a manifest row carrying the old starter template name still reports and still drifts", () => {
  const root = project({});
  install(root, {
    select: "javascript-typescript/focused-test", edition: "javascript-typescript",
    "package-manager": "npm", "no-ci": true,
  });
  const file = path.join(root, ".jig", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf-8"));
  const row = manifest.artifacts.find((a) => a.path === "src/index.js");
  row.template = { name: "starter-src/index.js", version: "1.0.0" };
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");

  const before = engine.cmdInventory(root).artifacts.find((a) => a.path === "src/index.js");
  assert.ok(before, "the old row is gone from inventory");
  assert.equal(before.state, "active");
  assert.equal(readJson(root, ".jig/manifest.json").artifacts.find((a) => a.path === "src/index.js").template.name,
    "starter-src/index.js", "a read rewrote a row jig did not write");

  // And the hash is still what decides drift, which is the half a rename could
  // have broken without anything failing at install time.
  fs.appendFileSync(path.join(root, "src", "index.js"), "// mine now\n");
  assert.equal(engine.cmdInventory(root).artifacts.find((a) => a.path === "src/index.js").state, "drifted");
});

test("a real plan that ticks a tool covers the CI cell, and one that skips CI does not", () => {
  const root = nodeProject();
  planOnly(root, { select: "javascript-typescript/focused-test", edition: "javascript-typescript",
    "package-manager": "npm", tools: "eslint" });
  const covered = readJson(root, ".jig/plan.json").rows
    .find((r) => r.classId === "javascript-typescript/focused-test").cells["human-ci"];
  assert.equal(covered.grade, "DET");
  assert.equal(covered.artifact, "eslint.config.mjs");

  const bare = nodeProject();
  planOnly(bare, { select: "javascript-typescript/focused-test", edition: "javascript-typescript",
    "package-manager": "npm", tools: "eslint", "no-ci": true });
  const gap = readJson(bare, ".jig/plan.json").rows
    .find((r) => r.classId === "javascript-typescript/focused-test").cells["human-ci"];
  assert.equal(gap.grade, "GAP");
  assert.equal(gap.why, "no lane runs eslint");
  assert.equal(fs.existsSync(path.join(bare, ".jig", "verify.json")), false);
});

// jig writes its plans, its manifest and its check modules into `.jig/`, and
// then installs prettier, which walks the project by path and reads every one of
// them. On a greenfield install that was the whole of a red first commit:
// eleven `[warn]` lines about files the owner never wrote. The ignore file is
// the tool's own and is approved like any other write, so it is in the plan and
// not something apply invents.
test("a tool that walks by path is given its own ignore file, and jig's state is in it", () => {
  const root = nodeProject();
  const plan = planOnly(root, { select: "javascript-typescript/focused-test", edition: "javascript-typescript",
    "package-manager": "npm", tools: "prettier" });
  const change = plan.changes.find((c) => c.path === ".prettierignore");
  assert.ok(change, "prettier was ticked and no .prettierignore was planned");
  // Approved by name like every other write outside `.jig/`, never in the batch.
  assert.ok(plan.consent.item.includes(change.id));

  engine.cmdApply(root, { _: [], change: [change.id], path: [change.path] });
  assert.match(fs.readFileSync(path.join(root, ".prettierignore"), "utf8"), /^\.jig\/\s*$/m,
    ".prettierignore landed without the one directory it exists to exclude");
});

// The same understatement arriving from the other side. 2.9.0 made the cell
// read both halves off THIS plan's changes, which is right on a first install
// and wrong on every one after it: a re-plan is an interview about what to ADD,
// so it ticks no tool and proposes no config — while the tool sits installed,
// configured and in the ci lane on disk. The owner was told their linter was
// uncovered when it was not.
test("a re-plan over an installed tool reads the cell off the installed state", () => {
  const root = nodeProject();
  install(root, { select: "javascript-typescript/focused-test", edition: "javascript-typescript",
    "package-manager": "npm", tools: "eslint" });
  const face = engine.installedToolFace(root);
  assert.equal(face.config.get("eslint"), "eslint.config.mjs");
  assert.equal(face.ci.has("eslint"), true);

  planOnly(root, { select: "javascript-typescript/focused-test" });
  const cell = readJson(root, ".jig/plan.json").rows
    .find((r) => r.classId === "javascript-typescript/focused-test").cells["human-ci"];
  assert.equal(cell.grade, "DET");
  assert.equal(cell.artifact, "eslint.config.mjs");
  assert.equal(cell.why, null);
});

test("an installed config with no lane running it is still GAP, and a lane with no config too", () => {
  // Both halves or nothing holds on the installed side exactly as it does on
  // the plan's: reading the disk widens where a half may come FROM, never what
  // counts as coverage.
  const cls = synthetic({ detectors: [TOOL_RULE] });
  const configOnly = { config: new Map([["eslint", "eslint.config.mjs"]]), ci: new Set() };
  const laneOnly = { config: new Map(), ci: new Set(["eslint"]) };
  for (const face of [configOnly, laneOnly]) {
    const cell = engine.matrixRow(cls, "elicited", [], [], face).cells["human-ci"];
    assert.equal(cell.grade, "GAP");
    assert.equal(cell.why, "no lane runs eslint");
  }
  // And one installed half plus the other from this plan is coverage.
  const cell = engine.matrixRow(cls, "elicited", toolPlan(), [], laneOnly).cells["human-ci"];
  assert.equal(cell.grade, "DET");
  assert.equal(cell.artifact, "eslint.config.mjs");
});

test("the lane list is approved one at a time, and names what will run", () => {
  const root = nodeProject();
  planOnly(root, { select: "javascript-typescript/focused-test", edition: "javascript-typescript",
    "package-manager": "npm", tools: "eslint" });
  const row = readJson(root, ".jig/plan.json").artifacts.find((a) => a.path === ".jig/verify.json");
  assert.equal(row.tier, "item");
  assert.match(row.why, /names what the lanes run — eslint — and a non-zero exit/);
  const item = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8").split("Approve one at a time")[1];
  assert.ok(item.includes("`.jig/verify.json`"), "the lane list is not on the item-tier list");
});

// The 2.7.1 lesson, one release later: a second interview is about what to ADD.
// Computing the whole file from this run's ticked tools alone would take the
// linter out of CI because the second interview was about the type checker.
// Planned and applied without the installs themselves: applying a `run-install`
// change spawns a package manager, and none of these claims is about npm.
function installWithTools(root, tools) {
  const plan = planOnly(root, { select: "javascript-typescript/focused-test", edition: "javascript-typescript",
    "package-manager": "npm", tools });
  // By id, never by position: the plan files are named for their own content
  // hash, so the order they list in says nothing about which came last.
  const payload = engine.planFiles(root).map(engine.readPlan).find((p) => p.planId === plan.planId);
  const keep = payload.changes.filter((c) => c.kind !== "run-install");
  engine.cmdApply(root, { _: [], change: keep.map((c) => c.id), path: keep.map((c) => c.path) });
  return payload;
}

test("a second plan carries the installed lane entries forward and adds the new one", () => {
  const root = nodeProject();
  installWithTools(root, "vitest");
  const payload = installWithTools(root, "eslint");
  const entries = JSON.parse(payload.changes.find((c) => c.path === ".jig/verify.json").content).entries;
  assert.deepEqual(entries.map((e) => e.id), ["vitest", "eslint"]);
  // And the workflow keeps the step that runs the carried one.
  const yml = payload.changes.find((c) => c.path === ".github/workflows/jig.yml").content;
  assert.match(yml, /--verify --lane ci --entry vitest/);
  assert.match(yml, /--verify --lane ci --entry eslint/);
  // And the reason recorded on the row says which half is new — the same
  // sentence `inventory` reads back as why the file is here.
  assert.match(payload.changes.find((c) => c.path === ".jig/verify.json").rationale,
    /what the ci lane runs: eslint — carried forward: vitest/);
});

test("a plan that ticks no tool proposes no lane list over the installed one", () => {
  const root = nodeProject();
  installWithTools(root, "eslint");
  const before = fs.readFileSync(path.join(root, ".jig", "verify.json"), "utf-8");
  const plan = planOnly(root);
  assert.equal(plan.changes.some((c) => c.path === ".jig/verify.json"), false,
    "a plan with no tools proposed a lane list anyway");
  assert.equal(fs.readFileSync(path.join(root, ".jig", "verify.json"), "utf-8"), before);
});

// The same 2.7.1 lesson, on the file the entries feed rather than on the entries.
// A re-plan that ticks nothing still rewrites the workflow, and rendering its
// steps from this run's empty list took the linter out of CI while
// `.jig/verify.json` went on saying the ci lane runs it.
test("a re-plan that ticks no tool keeps the installed tools' CI steps", () => {
  const root = nodeProject();
  installWithTools(root, "eslint");
  const again = planOnly(root);
  const payload = engine.planFiles(root).map(engine.readPlan).find((p) => p.planId === again.planId);
  const yml = payload.changes.find((c) => c.path === ".github/workflows/jig.yml");
  assert.ok(yml, "the re-plan proposed no workflow at all");
  assert.match(yml.content, /--verify --lane ci --entry eslint/,
    "the re-planned workflow dropped the step .jig/verify.json still says the ci lane runs");
  // And the file those steps read is untouched, so the two never disagree.
  assert.equal(payload.changes.some((c) => c.path === ".jig/verify.json"), false);
});

// `--verify-commit` is the whole opt-in commit lane, and until now deleting the
// one line that reads it left the suite green.
test("--verify-commit is what puts an entry in the commit lane, and nothing else does", () => {
  const laneList = (opts) => {
    const root = nodeProject();
    const plan = planOnly(root, { select: "javascript-typescript/focused-test", edition: "javascript-typescript",
      "package-manager": "npm", tools: "eslint", ...opts });
    const payload = engine.planFiles(root).map(engine.readPlan).find((p) => p.planId === plan.planId);
    const change = payload.changes.find((c) => c.path === ".jig/verify.json");
    return { entries: JSON.parse(change.content).entries, why: change.rationale };
  };
  assert.deepEqual(laneList({}).entries[0].lanes, ["ci"]);

  const opted = laneList({ "verify-commit": true });
  assert.deepEqual(opted.entries[0].lanes, ["ci", "commit"]);
  assert.match(opted.why, /ci and commit lanes/,
    "the consent line does not say the commit lane is being wired");
});

test("a detector that can be wrong reads PROB carrying the kind of doubt, never a number", () => {
  const root = nodeProject();
  planOnly(root, { "no-ci": true }, [A.HEURISTIC_ONLY]);
  const cell = readJson(root, ".jig/plan.json").rows[0].cells["human-editor"];
  assert.equal(cell.grade, "PROB");
  assert.equal(cell.ceiling, "heuristic");
  assert.equal(/\d/.test(engine.cellText(cell).split(" ")[0]), false);
});

test("a probabilistic lever says its ceiling is unmeasured rather than inventing one", () => {
  const prose = { actor: "claude-session", lever: "prose-rule", runner: "none", confidence: "heuristic" };
  assert.equal(engine.LEVERS["prose-rule"].probabilistic, true);
  assert.equal(engine.detectorCeiling(prose), "unmeasured");
  assert.equal(engine.detectorCeiling({ ...DRIVER_DETECTOR, confidence: "heuristic" }), "heuristic");
});

test("AVAILABLE_NOW picks out exactly the levers this build can emit an artifact for", () => {
  const now = Object.keys(engine.LEVERS).filter((id) => engine.leverAvailable(engine.LEVERS[id]));
  assert.deepEqual(now.sort(), [
    "agents-region", "bash-guard", "check-driver", "ci-workflow",
    "edit-guard", "edit-observe-guard", "prose-rule", "tool-rule",
  ]);
  // …and the ordering really is an ordering: an earlier release's lever stays
  // available, a later one does not.
  assert.equal(engine.leverAvailable({ availableAt: "0.1.0-alpha" }), true);
  assert.equal(engine.leverAvailable({ availableAt: "1.0.0" }), false);
  assert.equal(engine.leverAvailable({ availableAt: "never" }), false);
});

// ---------------------------------------------------------------------------
// What makes a guard armable
// ---------------------------------------------------------------------------
//
// REVERSED by SCOPE. Provenance used to bar arming and a ten-session ladder
// used to earn it; what arms a guard now is that its own fixture pair passed
// and the proof hash binds the module to it. Provenance is still recorded and
// still disclosed — it just decides nothing, and the runner does not read it
// either, so a cell claiming it did would be a coverage claim nothing enforces.

test("an admitted check is armable from install, whatever its provenance", () => {
  for (const provenance of ["assumed", "elicited", "forensic"]) {
    const root = nodeProject();
    planOnly(root, { provenance, "no-ci": true });
    const matrix = readJson(root, ".jig/plan.json");
    assert.equal(matrix.provenance, provenance);
    const deny = matrix.rows.flatMap((r) => Object.values(r.cells)).filter((c) => c.armable !== null);
    assert.ok(deny.length > 0, "no deny-capable cell to test");
    for (const cell of deny) assert.equal(cell.armable, true, provenance + " left a proven check unarmable");
  }
});

test("armable is the proof, said in the cell text a person reads", () => {
  const root = nodeProject();
  planOnly(root, { "no-ci": true });
  const matrix = readJson(root, ".jig/plan.json");
  const row = matrix.rows.find((r) => r.classId === "piped-installer");
  assert.match(row.proof, /^[0-9a-f]{64}$/);
  assert.match(engine.cellText(row.cells["claude-session"]), /proven by its fixture pair/);
  // A class with no admitted check behind it carries no proof and cannot arm.
  assert.equal(engine.detectorCell(synthetic({}), HOOK_DETECTOR, 0, "elicited", [], []).armable, false);
});

test("only a hook detector raises the arming question at all", () => {
  const root = nodeProject();
  planOnly(root);
  const byId = new Map(CHECKS.map((c) => [c.id, c]));
  for (const row of readJson(root, ".jig/plan.json").rows) {
    const cls = byId.get(row.classId);
    for (const [actor, cell] of Object.entries(row.cells)) {
      if (cell.armable === null) continue;
      const det = cls.detectors.find((d) => d.actor === actor && d.lever === cell.lever);
      assert.ok(["bash-guard", "edit-observe-guard"].includes(det.lever),
        row.classId + "/" + actor + " is not a hook");
    }
  }
});

test("deny capability is read off the runner, so no list of lever names can go stale", () => {
  assert.equal(engine.denyCapable({ runner: "PreToolUse" }), true);
  assert.equal(engine.denyCapable({ runner: "PostToolUse" }), true);
  assert.equal(engine.denyCapable({ runner: "checks" }), false);
  assert.equal(engine.denyCapable({ runner: "ci" }), false);
  assert.equal(engine.denyCapable({ runner: "none" }), false);
});

test("the plan says which mode every guard row takes, and observe is a choice", () => {
  const root = nodeProject();
  assert.equal(planOnly(root, { "no-ci": true }).mode, engine.DEFAULT_INSTALL_MODE);
  assert.equal(engine.DEFAULT_INSTALL_MODE, "armed");
  const observing = nodeProject();
  const plan = planOnly(observing, { "no-ci": true, observe: true });
  assert.equal(plan.mode, "observe");
  const md = fs.readFileSync(path.join(observing, ".jig", "plan.md"), "utf-8");
  assert.match(md, /you asked for observe/);

  // `observe` is the only one of the two anybody asks for — `armed` is what a run
  // takes when nothing was said. The armed page told the owner "you asked for
  // blocking" on a run where no question was put to them.
  const armed = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
  assert.ok(!/you asked for blocking/.test(armed), "the page credits the owner with an answer nobody gave");
  assert.match(armed, /mode: `armed` — the default; `--observe` is how you ask for the other one/);
});

// ---------------------------------------------------------------------------
// plan.md and plan.json describe the same matrix
// ---------------------------------------------------------------------------

function tableRows(md) {
  return md.split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.slice(1, -1).split(" | ").map((s) => s.trim()));
}

test("every cell in plan.json is rendered verbatim in plan.md", () => {
  const root = nodeProject();
  planOnly(root);
  const matrix = readJson(root, ".jig/plan.json");
  const rendered = tableRows(fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8"));
  assert.equal(rendered.length, matrix.rows.length);
  matrix.rows.forEach((row, i) => {
    const cells = rendered[i];
    assert.equal(cells[0], "`" + row.classId + "`");
    assert.equal(cells[1], row.provenance);
    matrix.actors.forEach((actor, j) => {
      assert.equal(cells[2 + j], engine.cellText(row.cells[actor]), row.classId + "/" + actor);
    });
  });
});

// Defect 23: nothing on the plan showed the owner the sentence a blocked agent
// gets back, so a garbled one shipped past an approval. It is rendered through
// the hook library's own composer, which is the string that actually ships.
test("plan.md prints the exact reply each guard hands a blocked call", () => {
  const root = nodeProject();
  planOnly(root);
  const plan = readJson(root, ".jig/plan.json");
  const md = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
  assert.ok(plan.denyReplies.length, "no guard on this plan speaks at all");
  assert.match(md, /## What a blocked call will read/);
  for (const reply of plan.denyReplies) {
    assert.ok(reply.text.startsWith("[jig guard " + reply.guardId + "] "), reply.text);
    assert.ok(md.includes("- `" + reply.guardId + "` — " + reply.text), reply.guardId);
  }
});

// The runner takes a detector's own deny over the check's (`denyOf`), so a plan
// that read the check's showed the owner one set of words and shipped another.
test("plan.md prints the detector's own deny where a detector states one", () => {
  const own = {
    reason: "This bash call pipes an unread script into a shell on this machine.",
    alternative: "Fetch it to a file, read it, then run the file.",
    override: "Run the two steps by hand if you have already read the script.",
  };
  const check = A.authored({
    id: "piped-installer",
    title: "A downloaded script piped straight into a shell",
    detectors: A.PIPED_INSTALLER.detectors.map((det, i) => (i === 0 ? { ...det, deny: own } : det)),
    fixtures: A.PIPED_INSTALLER.fixtures,
    deny: A.PIPED_INSTALLER.deny,
  });

  const root = nodeProject();
  planOnly(root, { "no-ci": true }, [check]);
  const reply = readJson(root, ".jig/plan.json").denyReplies.find((r) => r.guardId === GUARD);
  assert.ok(reply, "the guard that can refuse a call says nothing on the plan");
  assert.ok(reply.text.includes(own.reason), reply.text);
  assert.ok(!reply.text.includes(A.PIPED_INSTALLER.deny.reason), reply.text);
  assert.ok(fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8").includes(reply.text));
});

test("plan.md's header names every actor column, so no column is rendered unlabelled", () => {
  const root = nodeProject();
  planOnly(root);
  const md = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
  const header = md.split("\n").find((l) => l.startsWith("| class |"));
  assert.deepEqual(header.slice(1, -1).split(" | ").map((s) => s.trim()), ["class", "provenance", ...engine.ACTORS]);
});

test("both files name the same plan, so a review can be tied to the transaction it reviews", () => {
  const root = nodeProject();
  const plan = planOnly(root);
  const matrix = readJson(root, ".jig/plan.json");
  assert.equal(matrix.planId, plan.planId);
  assert.ok(fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8").includes("# jig plan " + plan.planId));
});

test("the unverifiable artifacts reach the rendered page", () => {
  const root = nodeProject();
  planOnly(root);
  const md = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
  const matrix = readJson(root, ".jig/plan.json");
  assert.deepEqual(matrix.enforcementGaps.sort(),
    [".github/workflows/jig.yml", ".jig/activation.md", ".jig/hooks/pre-commit"]);
  for (const p of matrix.enforcementGaps) assert.ok(md.includes("`" + p + "`"), p + " is not on the page");
});

test("a discarded check is reported on the page and never counted as coverage", () => {
  const root = nodeProject();
  const broken = A.authored({
    ...A.PIPED_INSTALLER,
    id: "cannot-prove-itself",
    detectors: [{ lever: "check-driver", actor: "human-editor", confidence: "deterministic",
      params: { patterns: ["never-in-either-fixture"], paths: ["**/*.sh"] } }],
  });
  const plan = planOnly(root, { "no-ci": true }, [A.PIPED_INSTALLER, broken]);
  assert.deepEqual(plan.discarded.map((d) => d.id), ["cannot-prove-itself"]);
  assert.equal(plan.discardedFile, ".jig/discarded.json");
  assert.equal(plan.selection.includes("cannot-prove-itself"), false, "a discard was counted as coverage");
  assert.deepEqual(readJson(root, ".jig/discarded.json").discarded.map((d) => d.id), ["cannot-prove-itself"]);

  const md = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
  assert.match(md, /## Discarded/);
  assert.ok(md.includes("`cannot-prove-itself`"));
});

test("a refusal reaches the review surface rather than being swallowed", () => {
  const root = nodeProject({ ".github/workflows/jig.yml": "name: someone else's\n" });
  planOnly(root);
  const matrix = readJson(root, ".jig/plan.json");
  assert.equal(matrix.refused.length, 1);
  assert.match(matrix.refused[0], /already exists and jig did not write it/);
  assert.ok(fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8").includes(matrix.refused[0]));
});

// 2.11.0 / N14. A `--select` install of `focused-test` wrote no guard that runs
// inside a session — an edition class carries only host-neutral detectors — and
// the page said so nowhere: the per-actor cells report each class naming no
// session detector, which is not the same sentence as "nothing here watches your
// sessions". The owner who answered "Me and my AI sessions" was told nothing.
test("a plan with no session guard says so, and says why", () => {
  const root = nodeProject();
  engine.cmdPlan(root, { _: [], change: [], select: "javascript-typescript/focused-test", provenance: "elicited" });
  assert.deepEqual(readJson(root, ".jig/plan.json").sessionGuards, []);
  const md = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
  assert.match(md, /## No session guard/);
  assert.ok(md.includes("`javascript-typescript/focused-test`"), "the class with no session lever is not named");
  assert.match(md, /a `--select` run installs none/);

  // And it stays quiet where it would be false: these authored checks carry
  // session levers, so this plan does install one.
  const guarded = nodeProject();
  planOnly(guarded);
  assert.ok(readJson(guarded, ".jig/plan.json").sessionGuards.length);
  assert.doesNotMatch(fs.readFileSync(path.join(guarded, ".jig", "plan.md"), "utf-8"), /## No session guard/);
});

// 2.14.0. The same `--select` run as above, read for what the PROSE claims.
// Every cell in it is GAP and nothing was installed, while the header said
// "every check below fired on its own violation and stayed silent on its near
// miss, so it blocks from install" and the paragraph six lines under the matrix
// told the owner the check driver catches these classes at commit time and in
// CI. Both were coverage claims over an empty table, on the page whose second
// sentence is "Nothing here is hand-written prose about coverage."
test("a --select run that writes no check claims no coverage in prose either", () => {
  const root = nodeProject();
  engine.cmdPlan(root, { _: [], change: [], select: "javascript-typescript/focused-test", provenance: "elicited" });
  const review = readJson(root, ".jig/plan.json");
  assert.equal(review.mode, "armed", "the header under test is the armed one");
  // The check-driver lever lands in whichever actor column its detector names,
  // so the question is asked of the cells rather than of a column.
  const driverCells = review.rows.flatMap((r) => Object.values(r.cells).filter((c) => c.lever === "check-driver"));
  assert.ok(driverCells.length, "no cell here grades the check driver, so this proves nothing");
  for (const cell of driverCells) {
    assert.equal(cell.grade, "GAP", "this run writes a driver module, so it proves nothing");
  }

  const md = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
  assert.ok(!md.includes("every check below fired on its own violation"),
    "the armed header claims every check in an all-GAP matrix was proven");
  assert.match(md, /Each cell below says what that row can refuse and where/,
    "the header does not send the owner to the cells for what refuses anything");
  assert.ok(!/caught by the check driver at commit time and in CI/.test(md),
    "the page tells the owner a driver with no module for these classes catches them");
  assert.match(md, /the check driver gets no module for these/);

  // And the sentence comes back where it is true, off a plan that actually
  // writes the module rather than off a cell flipped by hand: this check carries
  // one check-driver detector and no session lever, so the section renders and
  // its driver cell grades DET on the module the plan writes.
  const driven = nodeProject();
  planOnly(driven, { "no-ci": true }, [A.DOC_LEFT_BEHIND]);
  const drivenReview = readJson(driven, ".jig/plan.json");
  assert.deepEqual(drivenReview.sessionGuards, [], "this plan installs a session guard, so the section is skipped");
  assert.equal(drivenReview.rows[0].checkModule, ".jig/checks/doc-left-behind.check.mjs");
  const page = fs.readFileSync(path.join(driven, ".jig", "plan.md"), "utf-8");
  assert.match(page, /## No session guard/);
  // …and it names the lanes this repository actually runs. `--no-ci` writes no
  // workflow and nothing points git at the shim, so "at commit time and in CI"
  // was the header's blanket claim again, twenty lines lower.
  assert.deepEqual(drivenReview.lanes, { commit: false, ci: false });
  assert.match(page, /no lane here runs the driver/);
  assert.ok(!/the check driver gets no module for these/.test(page));
  assert.ok(!/this plan writes their check module/.test(page));
});

// 2.14.0, the ship-check. `detectorArtifact` returns null — forcing GAP — for a
// removal-only detector before it ever looks for a written module, so a class
// GAPs because no commit lane is wired YET while the same plan writes both the
// class's check module and the pre-commit shim. The page then told the owner
// "the check driver gets no module for these, so neither the commit hook nor CI
// runs their patterns": both halves false, on the page that promises no
// hand-written prose about coverage.
test("a GAP driver cell whose module this plan writes is not reported as no module", () => {
  const root = nodeProject();
  const plan = planOnly(root, { "no-ci": true }, [A.TESTS_DELETED]);
  const module = ".jig/checks/tests-deleted.check.mjs";
  assert.ok(plan.changes.some((c) => c.path === module), "this plan writes no check module, so it proves nothing");
  assert.ok(plan.changes.some((c) => c.path === ".jig/hooks/pre-commit"));

  const review = readJson(root, ".jig/plan.json");
  const row = review.rows.find((r) => r.classId === "tests-deleted");
  const cells = Object.values(row.cells).filter((c) => c.lever === "check-driver");
  assert.ok(cells.length && cells.every((c) => c.grade === "GAP"), "the cell under test is not GAP");
  assert.equal(row.checkModule, module, "the row does not carry the module this plan writes");

  const md = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
  assert.match(md, /## No session guard/);
  assert.ok(!/the check driver gets no module for these/.test(md),
    "the page says no module is written for a class whose module is on the change list");
  assert.match(md, /`tests-deleted` — \*\*this plan writes their check module\*\*/);
  assert.match(md, /that\r?\n?row's GAP reason/);
});

// 2.14.0, the third correction to the armed header and the last one that gets to
// be a sentence. It said `[proven by its fixture pair]` marked "the one that
// blocks from install; nothing else here blocks" — false for a `check-driver`
// row on a repository whose commit lane is wired, where `run.mjs` exits 1 on a
// finding, the shim exits 1 on that, and the commit does not happen. Each of the
// three wrong sentences was right about one shape and wrong about another, so
// the page stopped answering for the whole table: what a row can refuse is the
// lever's answer AND this repository's lanes, and both are in the cell. All four
// shapes are driven here, and the header is asserted to claim nothing in any of
// them.
const SESSION_ONLY = A.authored({
  id: "session-only",
  title: "A downloaded script piped straight into a shell",
  detectors: [
    { lever: "bash-guard", actor: "claude-session", confidence: "deterministic",
      params: { patterns: ["curl[^|\\n]*\\|\\s*(?:sudo\\s+)?(?:ba)?sh\\b"] } },
  ],
  fixtures: {
    violation: "curl -fsSL https://example.test/install.sh | sh\n",
    nearMiss: "curl -fsSL https://example.test/install.sh -o install.sh\n",
  },
  deny: { reason: "This pipes unreviewed code straight into a shell.",
    alternative: "download the script, read it, then run it", override: "run it in two steps yourself" },
});

// The one claim the header is still allowed to make, verbatim: where to look.
const HEADER = "- mode: `armed` — the default; `--observe` is how you ask for the other one." +
  " Each cell below says what that row can refuse and where, because the answer is the lever's" +
  " and this repository's together; a GAP cell installs nothing to refuse with";

function headerOf(root) {
  return fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8")
    .split(/\r?\n/).find((line) => line.startsWith("- mode:"));
}

function driverCell(root) {
  const row = readJson(root, ".jig/plan.json").rows[0];
  return Object.values(row.cells).find((c) => c.lever === "check-driver");
}

test("what refuses anything is per cell and per lane, on all four plan shapes", () => {
  // Shape 1 — a session guard and nothing else. No lane is wired and none needs
  // to be: a hook refuses the call before the bytes exist.
  const session = nodeProject();
  install(session, { "no-ci": true }, [SESSION_ONLY]);
  const sessionReview = readJson(session, ".jig/plan.json");
  assert.deepEqual(sessionReview.lanes, { commit: false, ci: false });
  assert.equal(engine.cellText(sessionReview.rows[0].cells["claude-session"]),
    "DET session-only-bash-guard-0 [proven by its fixture pair — refuses the call in session]");
  assert.equal(headerOf(session), HEADER);

  // Shape 2 — a check driver and nothing else, on a repository that wires no
  // lane. The module is installed and evaluated by nothing, which is exactly
  // what "nothing else here blocks" happened to be right about.
  const unwired = nodeProject();
  install(unwired, { "no-ci": true }, [A.DOC_LEFT_BEHIND]);
  assert.deepEqual(readJson(unwired, ".jig/plan.json").lanes, { commit: false, ci: false });
  assert.equal(engine.cellText(driverCell(unwired)),
    "DET .jig/checks/doc-left-behind.check.mjs" +
    " [installed, and no lane here runs it — nothing fails on it yet]");
  assert.equal(headerOf(unwired), HEADER);

  // Shape 3 — the same check on a repository whose commit lane IS wired. This is
  // the defect: `armable` is null on a check-driver cell, so no marker was
  // printed and the header spoke for it — while the shim exits 1 on a finding
  // and the commit does not happen.
  const wired = nodeProject();
  spawnSync("git", ["init", "-q"], { cwd: wired });
  install(wired, { "no-ci": true }, [A.DOC_LEFT_BEHIND]);
  const wiring = engine.cmdPlan(wired, { _: [], change: [], "wire-commit": true });
  A.applyPlan(engine, wired, wiring);
  assert.equal(engine.commitLane(wired).state, "live");
  install(wired, { "no-ci": true }, [A.DOC_LEFT_BEHIND]);
  assert.deepEqual(readJson(wired, ".jig/plan.json").lanes, { commit: true, ci: false });
  const wiredCell = driverCell(wired);
  assert.equal(wiredCell.armable, null, "this cell is a hook cell, so it proves nothing about the defect");
  assert.equal(engine.cellText(wiredCell),
    "DET .jig/checks/doc-left-behind.check.mjs [fails the commit]");
  assert.equal(headerOf(wired), HEADER);

  // Shape 4 — both levers, with both lanes live. The two cells give different
  // answers on one row, which is why no single sentence could ever have covered
  // the page.
  const both = nodeProject();
  spawnSync("git", ["init", "-q"], { cwd: both });
  install(both, {}, [A.PIPED_INSTALLER]);
  A.applyPlan(engine, both, engine.cmdPlan(both, { _: [], change: [], "wire-commit": true }));
  install(both, {}, [A.PIPED_INSTALLER]);
  const bothReview = readJson(both, ".jig/plan.json");
  assert.deepEqual(bothReview.lanes, { commit: true, ci: true });
  const cells = bothReview.rows[0].cells;
  assert.equal(engine.cellText(cells["human-editor"]),
    "DET .jig/checks/piped-installer.check.mjs [fails the commit and CI]");
  assert.equal(engine.cellText(cells["human-ci"]), "DET .github/workflows/jig.yml [fails CI]");
  assert.equal(engine.cellText(cells["claude-session"]),
    "DET piped-installer-bash-guard-0 [proven by its fixture pair — refuses the call in session]");
  assert.equal(headerOf(both), HEADER);

  // And the sentence the header stopped making is gone from every shape, not
  // reworded somewhere else on the page.
  for (const root of [session, unwired, wired, both]) {
    const md = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
    assert.ok(!/nothing else here blocks/.test(md), "the blanket claim is back on " + root);
    assert.ok(!/blocks from install/.test(md), "the blanket claim is back on " + root);
  }
});

// Shape 5, and the fifth wrong claim this cell has made. All four shapes above
// are armed, so the mode was never a variable: the marker read "refuses the call
// in session" whatever `.jig/config.json` said. Under `--observe` the page
// printed that four lines below a header saying every guard here refuses
// nothing, over a config that really did say `mode: observe`.
test("an observing plan's guard cell says it records rather than refuses", () => {
  const observing = nodeProject();
  install(observing, { "no-ci": true, observe: true }, [SESSION_ONLY]);
  const review = readJson(observing, ".jig/plan.json");
  assert.equal(review.mode, "observe");
  const config = readJson(observing, ".jig/config.json");
  assert.equal(config.guards[0].mode, "observe", "the config this plan writes is the fact the cell answers for");
  assert.equal(engine.cellText(review.rows[0].cells["claude-session"]),
    "DET session-only-bash-guard-0 [proven by its fixture pair — records the call in session, refuses nothing]");
  // The header and the cell now say the same thing, which is what the page was
  // contradicting itself about.
  assert.match(headerOf(observing), /refuses nothing$/);
  const md = fs.readFileSync(path.join(observing, ".jig", "plan.md"), "utf-8");
  assert.ok(!/refuses the call in session/.test(md), "an observe page still claims a refusal");

  // And the armed page is unchanged: the correction has to be true in BOTH
  // modes, which is the way the last four went wrong.
  const armed = nodeProject();
  install(armed, { "no-ci": true }, [SESSION_ONLY]);
  assert.equal(engine.cellText(readJson(armed, ".jig/plan.json").rows[0].cells["claude-session"]),
    "DET session-only-bash-guard-0 [proven by its fixture pair — refuses the call in session]");
});

// ---------------------------------------------------------------------------
// Tiered consent
// ---------------------------------------------------------------------------

test("everything that can refuse something is approved one at a time", () => {
  const root = nodeProject();
  const plan = planOnly(root);
  const matrix = readJson(root, ".jig/plan.json");
  const item = matrix.artifacts.filter((a) => a.tier === "item");
  assert.deepEqual(item.map((a) => a.path).sort(), [
    ".github/workflows/jig.yml",
    ".jig/checks/empty-catch.check.mjs",
    ".jig/checks/piped-installer.check.mjs",
    // The driver's exit code IS the build verdict and the shim is what asks for
    // it, so neither one is a thing that "only ever reports". They live under
    // `.jig/` and used to fall through to the batch tier on that alone.
    ".jig/checks/run.mjs",
    ".jig/config.json",
    ".jig/hooks/pre-commit",
  ]);
  assert.deepEqual(plan.consent.item.sort(), item.map((a) => a.id).sort());
  assert.match(item.find((a) => a.path === ".jig/config.json").why, /refuse a tool call/);
  assert.match(item.find((a) => a.path.startsWith(".github/")).why, /fails the build/);
  assert.match(item.find((a) => a.path.endsWith(".check.mjs")).why, /can fail a build/);
  assert.match(item.find((a) => a.path === ".jig/checks/run.mjs").why, /commit and CI verdict/);
  // And the shim's line does not say git runs it HERE. `core.hooksPath` is unset
  // in this project — scan reports the lane `no-hook` — so "is the hook git runs
  // at commit time" described a repository other than the one being planned.
  // It names no lane at all now: a consent line reads as a claim about THIS
  // repository, and gate G14 holds every lane claim to `review.lanes`, so the
  // line says what the file is and leaves the lanes to the cells that know them.
  const shim = item.find((a) => a.path === ".jig/hooks/pre-commit").why;
  assert.match(shim, /once `core\.hooksPath` points at \.jig\/hooks/);
  assert.match(shim, /nothing runs it/);
  assert.ok(!/at commit time/.test(shim), "the line claims a lane this repository has not wired");
  assert.ok(!/\bin CI\b/.test(shim), "the line claims a lane this repository has not wired");
});

// `.jig/plan.md` and `.jig/plan.json` are fixed paths, and the skill orders a
// wiring plan straight after the install — so the matrix the owner approved from
// was destroyed by the next documented command, and the stored record carried
// only the changes. The page and the rows are kept under the plan's own id now.
test("a later plan leaves the page and the rows an earlier one was approved from", () => {
  const root = nodeProject();
  const first = planOnly(root, { "no-ci": true });
  const kept = path.join(root, ".jig", "plan-" + first.planId + ".md");
  const page = fs.readFileSync(kept, "utf-8");
  const rows = readJson(root, ".jig/plan-" + first.planId + ".json").review.rows;
  assert.ok(rows.length, "the record carries no coverage rows");
  assert.equal(page, fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8"));

  const second = planOnly(root);
  assert.notEqual(second.planId, first.planId);
  assert.notEqual(fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8"), page,
    "the fixed path is the latest plan's");
  assert.equal(fs.readFileSync(kept, "utf-8"), page, "the approved page was overwritten");
  assert.deepEqual(readJson(root, ".jig/plan-" + first.planId + ".json").review.rows, rows);
});

// DERAIL-PASS defect 20: `apply --plan <id>` was the widened form SCOPE:190
// forbids — one approval, every destination, no path named for any of them.
test("apply --plan refuses the item tier and names the token for every change in it", () => {
  const root = nodeProject();
  const plan = planOnly(root, { "no-ci": true });
  let message = null;
  try {
    engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  } catch (err) {
    message = err.message;
  }
  assert.ok(message, "a whole plan applied with no path named for anything in it");
  const item = readJson(root, ".jig/plan.json").artifacts.filter((a) => a.tier === "item");
  assert.ok(item.length > 1);
  for (const a of item) assert.ok(message.includes("--change " + a.id + " --path " + a.path), a.id);
  // Refused whole, not half: nothing in the plan was written.
  assert.equal(fs.existsSync(path.join(root, ".jig", "config.json")), false);
  assert.equal(fs.existsSync(path.join(root, ".jig", "manifest.json")), false);
});

// Roadmap 234: the refusal above used to fire for ever. `selected` was the
// whole plan, so a plan whose item tier had already landed still carried it,
// and the batch half was unreachable by `--plan` on every real install.
test("apply --plan carries the batch tier once every item-tier change has landed", () => {
  const root = nodeProject();
  const plan = planOnly(root, { "no-ci": true });
  const matrix = readJson(root, ".jig/plan.json");
  const item = matrix.artifacts.filter((a) => a.tier === "item");
  const batch = matrix.artifacts.filter((a) => a.tier === "batch");
  assert.ok(item.length && batch.length);
  engine.cmdApply(root, { _: [], change: item.map((a) => a.id), path: item.map((a) => a.path) });

  const rest = engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  assert.deepEqual(rest.applied.map((r) => r.path).sort(), batch.map((a) => a.path).sort());
  for (const r of rest.applied) assert.equal(r.outcome, "applied");
  // Named, not silently dropped: SCOPE, "May a batch approval skip a change
  // already applied".
  assert.deepEqual(rest.skipped.map((s) => s.path).sort(), item.map((a) => a.path).sort());
});

// And why that filter never fired on a real project: an install journals a
// write row for every candidate the ecosystem might use, so under npm
// `pnpm-lock.yaml`, `yarn.lock` and `bun.lock` are recorded and never appear on
// disk. Counting a row that produced no file made the `.every` false for ever —
// no install was skipped, and the batch tier of every plan that ticks a tool
// stayed unreachable behind the item-tier refusal.
test("apply --plan skips an applied install whose candidate lockfiles never landed", () => {
  const root = nodeProject();
  const item = {
    id: "fakelint",
    role: "linter",
    edition: "javascript-typescript",
    installKind: "package",
    packageManager: "npm",
    command: "fake install fakelint",
    // The command writes ONE of the edition's marker files, exactly as `npm
    // install` writes `package-lock.json` and leaves the other three lockfiles
    // alone. process.execPath, so the test never depends on a PATH entry.
    argv: [process.execPath, "-e", "require('fs').writeFileSync('package-lock.json','{}\\n')"],
    configPath: "fakelint.config.json",
    configBody: "{}\n",
    wiring: null,
    ciStep: null,
    uninstallCommand: "fake uninstall fakelint",
    uninstallArgv: [process.execPath, "-e", "0"],
    timeoutMs: 20000,
  };
  fs.writeFileSync(path.join(root, "draft.json"), JSON.stringify({
    changes: [
      { id: "install-fakelint", kind: "run-install", path: item.configPath, install: item },
      { id: "batch-note", kind: "write-side-file", path: ".jig/hand.json", content: "{}\n" },
    ],
  }));
  const plan = engine.cmdPlan(root, { _: [], change: [], from: "draft.json" });
  const install = plan.changes.find((c) => c.kind === "run-install");
  assert.equal(engine.cmdApply(root, { _: [], change: [install.id], path: [install.path] })
    .applied[0].outcome, "installed");

  const writes = [...engine.replayJournal(engine.readJournal(root)).get(install.id).writes.values()];
  assert.ok(writes.some((w) => w.hashAfter === null && !fs.existsSync(path.join(root, w.path))),
    "no candidate path went unwritten, so this project cannot show the defect");

  const rest = engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  assert.deepEqual(rest.skipped.map((s) => s.change), [install.id]);
  assert.deepEqual(rest.applied.map((r) => r.path), [".jig/hand.json"]);
});

// The direction that filter must NOT reach: an install the ecosystem rejected.
// It journals an outcome row for every candidate path before it reads the exit
// code — the command may have created files, and a created path with no
// pre-image is the one thing revert has to know about — so the replay read it as
// `applied` and the batch tier skipped it as already installed. That is how
// three dotnet analyzers whose `dotnet add package` exited 1 left a
// `.jig/verify.json` naming them, and `dotnet build` then came back green over
// analyzers no project referenced.
test("apply --plan does not skip an install the ecosystem rejected", () => {
  const root = nodeProject();
  const item = {
    id: "fakelint",
    role: "linter",
    edition: "javascript-typescript",
    installKind: "package",
    packageManager: "npm",
    command: "fake install fakelint",
    // Writes a marker file and THEN exits 1, which is the shape that fooled the
    // replay: real outcome rows, and a rejection after all of them.
    argv: [process.execPath, "-e", "require('fs').writeFileSync('package-lock.json','{}\\n');process.exit(1)"],
    configPath: "fakelint.config.json",
    configBody: "{}\n",
    wiring: null,
    ciStep: null,
    uninstallCommand: "fake uninstall fakelint",
    uninstallArgv: [process.execPath, "-e", "0"],
    timeoutMs: 20000,
  };
  fs.writeFileSync(path.join(root, "draft.json"), JSON.stringify({
    changes: [
      { id: "install-fakelint", kind: "run-install", path: item.configPath, install: item },
      { id: "batch-note", kind: "write-side-file", path: ".jig/hand.json", content: "{}\n" },
    ],
  }));
  const plan = engine.cmdPlan(root, { _: [], change: [], from: "draft.json" });
  const install = plan.changes.find((c) => c.kind === "run-install");
  assert.throws(() => engine.cmdApply(root, { _: [], change: [install.id], path: [install.path] }),
    /exited 1/);

  const state = engine.replayJournal(engine.readJournal(root)).get(install.id);
  assert.equal(engine.changeState(state), "refused");
  assert.ok(!fs.existsSync(path.join(root, item.configPath)),
    "the config landed for an install that failed");

  // So the batch half is refused and names it, rather than skipping it as
  // already installed and writing the lane over a tool that is not there.
  assert.throws(() => engine.cmdApply(root, { _: [], change: [], plan: plan.planId }),
    /Refusing to apply plan .* Approve each one by name[\s\S]*install-fakelint/);
  assert.ok(!fs.existsSync(path.join(root, ".jig", "hand.json")),
    "the batch tier landed over an install that never did");
});

// The other half of that filter: the journal records what jig did, the disk
// records what the repository still has, and re-apply repair reads the disk.
// A skip taken on the journal alone would make `--plan` report `ok` having
// written nothing back, and the batch tier — the checks driver, the config, the
// activation note — is exactly what re-running an approved plan used to restore.
test("apply --plan writes back a change whose file is gone, and skips the ones still on disk", () => {
  const root = nodeProject();
  const plan = planOnly(root, { "no-ci": true });
  const matrix = readJson(root, ".jig/plan.json");
  const item = matrix.artifacts.filter((a) => a.tier === "item");
  const batch = matrix.artifacts.filter((a) => a.tier === "batch");
  engine.cmdApply(root, { _: [], change: item.map((a) => a.id), path: item.map((a) => a.path) });
  engine.cmdApply(root, { _: [], change: [], plan: plan.planId });

  const gone = batch[0];
  fs.unlinkSync(path.join(root, gone.path));
  const repair = engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  assert.deepEqual(repair.applied.map((r) => r.path), [gone.path]);
  assert.equal(fs.existsSync(path.join(root, gone.path)), true, gone.path + " was not put back");
  // Everything the repository still carries is skipped, and named.
  assert.equal(repair.skipped.some((s) => s.path === gone.path), false);
  assert.equal(repair.skipped.length, matrix.artifacts.length - 1);

  // And the item tier is not smuggled back in by the same door: a deleted
  // item-tier file re-enters the plan and the refusal fires on it, naming its
  // pair. A repair is a write, and a write that can fail a build is approved by
  // name whatever put the file there the first time.
  fs.unlinkSync(path.join(root, item[0].path));
  assert.throws(() => engine.cmdApply(root, { _: [], change: [], plan: plan.planId }),
    new RegExp("--change " + item[0].id + " --path " + item[0].path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  engine.cmdApply(root, { _: [], change: [item[0].id], path: [item[0].path] });
  assert.equal(fs.existsSync(path.join(root, item[0].path)), true);
});

test("apply --plan still carries a plan whose every change only reports", () => {
  const root = nodeProject();
  fs.writeFileSync(path.join(root, "draft.json"), JSON.stringify({
    changes: [{ id: "batch-only", kind: "write-side-file", path: ".jig/hand.json", content: "{}\n" }],
  }));
  const plan = engine.cmdPlan(root, { _: [], change: [], from: "draft.json" });
  assert.equal(engine.cmdApply(root, { _: [], change: [], plan: plan.planId }).applied[0].outcome, "applied");
});

test("everything that only reports is approved in one go", () => {
  const root = nodeProject();
  planOnly(root);
  const batch = readJson(root, ".jig/plan.json").artifacts.filter((a) => a.tier === "batch");
  assert.deepEqual(batch.map((a) => a.path).sort(), [
    ".jig/activation.md",
    ".jig/proposed-permissions.json",
  ]);
  for (const a of batch) assert.match(a.why, /reports only, and refuses nothing/);
});

test("a file outside .jig/ is approved one at a time, because it is yours", () => {
  // The widened boundary's own tier: inside `.jig/` a side-file is jig's own
  // reporting; outside it, the file belongs to the owner.
  const mine = engine.consentFor({ kind: "write-side-file", path: "eslint.config.mjs" }, []);
  assert.equal(mine.tier, "item");
  assert.match(mine.why, /a file outside \.jig\/ that is yours/);
  assert.equal(engine.consentFor({ kind: "write-side-file", path: ".jig/backlog.json" }, []).tier, "batch");
});

test("every artifact lands in exactly one tier and both lists cover the plan", () => {
  const root = nodeProject();
  const plan = planOnly(root);
  const matrix = readJson(root, ".jig/plan.json");
  for (const a of matrix.artifacts) assert.ok(engine.CONSENT_TIERS.includes(a.tier));
  assert.deepEqual(
    [...plan.consent.batch, ...plan.consent.item].sort(),
    plan.changes.map((c) => c.id).sort());
  assert.equal(new Set([...plan.consent.batch, ...plan.consent.item]).size, plan.changes.length);
});

test("a config wiring no guard is not treated as deny-capable", () => {
  const armed = engine.consentFor({ kind: "write-config", path: ".jig/config.json" }, [{ id: "a-0" }]);
  assert.equal(armed.tier, "item");
  const bare = engine.consentFor({ kind: "write-config", path: ".jig/config.json" }, []);
  assert.equal(bare.tier, "batch");
});

test("a config that stops an armed guard refusing is item tier and names it", () => {
  const installed = [{ id: "a-0", mode: "armed" }, { id: "b-0", mode: "armed" }];
  // b-0 is gone and a-0 is back to observe: two different ways to stop refusing
  // a tool call, and neither is an approval anybody gives in a batch.
  const content = JSON.stringify({ schemaVersion: 1, guards: [{ id: "a-0" }] }) + "\n";
  const consent = engine.consentFor({ kind: "write-config", path: ".jig/config.json", content }, [], installed);
  assert.equal(consent.tier, "item");
  assert.match(consent.why, /a-0/);
  assert.match(consent.why, /b-0/);
});

// ---------------------------------------------------------------------------
// The config face of a re-run (DERAIL-PASS defect 3)
// ---------------------------------------------------------------------------
//
// A plan is an interview about what to ADD. Computing the whole config from the
// current selection put `guards: []` in front of an owner whose repository had
// two armed guards, under the tier you approve in one go.

test("a second interview carries the installed guards forward and adds the new one", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const before = readJson(root, ".jig/config.json").guards.map((g) => g.id).sort();
  assert.equal(before.length, 2);

  const plan = planOnly(root, { "no-ci": true }, [A.HEURISTIC_ONLY]);
  const record = readJson(root, ".jig/plan-" + plan.planId + ".json");
  const change = record.changes.find((c) => c.kind === "write-config");
  const proposed = JSON.parse(change.content);
  assert.deepEqual(proposed.guards.map((g) => g.id).sort(),
    [...before, "test-file-removal-bash-guard-0"].sort());
  // The owner's answer on a row they already gave one for is carried verbatim.
  for (const row of readJson(root, ".jig/config.json").guards) {
    assert.deepEqual(proposed.guards.find((g) => g.id === row.id), row);
  }
  assert.match(change.rationale, /carried forward: /);

  const matrix = readJson(root, ".jig/plan.json");
  assert.equal(matrix.artifacts.find((a) => a.id === change.id).tier, "item");
  assert.ok(plan.consent.item.includes(change.id));
});

test("a selection plan with nothing armable behind it still proposes the installed guards", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const before = readJson(root, ".jig/config.json").guards;
  fs.rmSync(path.join(root, "authored.json"), { force: true });

  // The live reproduction: an edition class taken with `--select` and nothing
  // authored behind it installs no guard, so the config used to come out empty.
  const plan = engine.cmdPlan(root, {
    _: [], change: [], select: "javascript-typescript/swallowed-exception",
    provenance: "elicited", "no-ci": true,
  });
  const record = readJson(root, ".jig/plan-" + plan.planId + ".json");
  const change = record.changes.find((c) => c.kind === "write-config");
  assert.deepEqual(JSON.parse(change.content).guards, before);
  assert.ok(plan.consent.item.includes(change.id), "a config holding two armed guards sat in the batch tier");
  // Nothing was added, so nothing is proposed: the face is byte for byte the
  // file already on disk.
  assert.equal(change.content, fs.readFileSync(path.join(root, ".jig", "config.json"), "utf-8"));
});

test("an empty config proposed over a non-empty one is a refusal, not a change", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.PIPED_INSTALLER]);
  const guard = readJson(root, ".jig/config.json").guards[0].id;

  // Retiring the last guard is the shortest route to an empty config through
  // jig's own CLI. It refuses rather than disarming the repository; `revert` is
  // the door that takes an install back out.
  assert.throws(() => engine.cmdRetire(root, { _: [], change: [], guard }),
    /disarms this repository/);
  assert.equal(readJson(root, ".jig/config.json").guards.length, 1);
});

// The gate above refuses to COMPOSE that config. A plan file is a file, and the
// token the owner was handed names a change in it rather than the bytes it held
// when they read it — so the same gate has to run against what is about to
// land, or jig's own approved, journalled path is the cheapest way to disarm
// everything.
test("apply refuses an approved change whose plan file was edited to empty the config", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.PIPED_INSTALLER]);
  const guard = readJson(root, ".jig/config.json").guards[0].id;
  const out = engine.cmdDisarm(root, { _: [], change: [], guard });

  // Only the content, and only inside the change the owner approved: the plan
  // id and the change id are left exactly as they were printed.
  const file = path.join(root, ".jig", "plan-" + out.plan + ".json");
  const record = JSON.parse(fs.readFileSync(file, "utf-8"));
  record.changes[0].content = JSON.stringify({ schemaVersion: 1, guards: [] }, null, 2) + "\n";
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");

  assert.throws(() => engine.cmdApply(root, { _: [], change: [out.change], path: [out.path] }),
    /disarms this repository/);
  assert.equal(readJson(root, ".jig/config.json").guards.length, 1);
});

// Deleting an observing guard refuses nothing and fails no build, so the tier
// rule read off the guard's mode alone put a config that drops it in the batch.
// Coverage the owner approved is still coverage they are being asked to lose.
test("a config that drops an installed guard is item tier whatever mode it was in", () => {
  const installed = [{ id: "a-0", mode: "observe" }, { id: "b-0" }];
  const content = JSON.stringify({ schemaVersion: 1, guards: [{ id: "a-0", mode: "observe" }] }) + "\n";
  const consent = engine.consentFor({ kind: "write-config", path: ".jig/config.json", content }, [], installed);
  assert.equal(consent.tier, "item");
  assert.match(consent.why, /b-0/);
  assert.doesNotMatch(consent.why, /a-0/, "a row this config keeps untouched was named as a loss");
});

// DERAIL-PASS N3: a second interview is the whole point of carrying the
// installed guards forward, and after N17 the only token that carries the item
// tier is the pair — which could not resolve, because an artifact id comes from
// its template and every unchanged artifact was defined by both plan files.
test("a second interview applies, one pair at a time, against the plan just reviewed", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.PIPED_INSTALLER]);
  const plan = planOnly(root, { "no-ci": true }, [A.PIPED_INSTALLER, A.EMPTY_CATCH]);
  assert.ok(fs.readdirSync(path.join(root, ".jig")).filter((f) => /^plan-[0-9a-f]+\.json$/.test(f)).length > 1,
    "the first plan file is gone, so there is no ambiguity left to resolve");

  const artifacts = readJson(root, ".jig/plan.json").artifacts;
  const applied = engine.cmdApply(root, {
    _: [], change: artifacts.map((a) => a.id), path: artifacts.map((a) => a.path),
  });
  assert.ok(applied.ok);
  assert.deepEqual(readJson(root, ".jig/config.json").guards.map((g) => g.id).sort(),
    ["empty-catch-edit-observe-guard-0", "piped-installer-bash-guard-0"]);
});

// The mechanical half of a carried row is not the owner's answer. Carrying the
// `proof` forward recorded the proof of the module the same plan replaced, so
// jig's own install came out unarmable and drifted.
test("a re-run that installs an edited check module carries the mode, not the stale proof", () => {
  const root = nodeProject();
  install(root, { "no-ci": true }, [A.PIPED_INSTALLER]);
  const before = configRow(root);
  // The one answer that IS the owner's: they took this guard back to observe,
  // and running the interview again does not re-ask it.
  const down = engine.cmdDisarm(root, { _: [], change: [], guard: before.id });
  engine.cmdApply(root, { _: [], change: [down.change], path: [down.path] });
  assert.equal(configRow(root).mode, undefined);

  const edited = { ...A.PIPED_INSTALLER, module: A.PIPED_INSTALLER.module + "\n// one more line\n" };
  const plan = planOnly(root, { "no-ci": true }, [edited]);
  const change = readJson(root, ".jig/plan-" + plan.planId + ".json").changes.find((c) => c.kind === "write-config");
  const row = JSON.parse(change.content).guards.find((g) => g.id === before.id);
  assert.notEqual(row.proof, before.proof, "the plan proposed the proof of the module it replaces");
  assert.equal(row.provenance, before.provenance, "the owner's provenance was re-asked");
  assert.equal(row.mode, undefined, "the interview re-armed a guard the owner had quieted");
});

// ---------------------------------------------------------------------------
// The backlog
// ---------------------------------------------------------------------------

test("every class the editions matched and the user did not take is written down", () => {
  const root = nodeProject();
  planOnly(root, { select: "javascript-typescript/swallowed-exception" });
  const { schemaVersion, backlog } = readJson(root, ".jig/backlog.json");
  assert.equal(schemaVersion, 1);
  const edition = editions.loadEdition(PLUGIN_ROOT, "javascript-typescript");
  const expected = edition.classes
    .map((c) => editions.namespacedId("javascript-typescript", c.id))
    .filter((id) => id !== "javascript-typescript/swallowed-exception")
    .sort();
  assert.deepEqual(backlog.map((b) => b.classId).sort(), expected);
  assert.equal(new Set(backlog.map((b) => b.classId)).size, backlog.length);
});

test("a selected class is never also in the backlog, and an authored one is never in it at all", () => {
  const root = nodeProject();
  planOnly(root, { select: "javascript-typescript/swallowed-exception" });
  const rows = readJson(root, ".jig/backlog.json").backlog;
  for (const row of rows) {
    assert.notEqual(row.classId, "javascript-typescript/swallowed-exception");
    // Authored ids are not edition ids, so they never appear on a shelf.
    assert.equal(CHECKS.some((c) => c.id === row.classId), false);
  }
});

test("every backlog row is namespaced by its edition, so a shared id is never ambiguous", () => {
  const root = project({
    "package.json": "{ \"private\": true }\n",
    "src/a.ts": "export const a = 1;\n",
    "go.mod": "module example.test/x\n",
    "main.go": "package main\n",
  });
  planOnly(root, { "no-ci": true });
  const rows = readJson(root, ".jig/backlog.json").backlog;
  const shared = rows.filter((r) => r.classId.endsWith("/swallowed-exception")).map((r) => r.classId).sort();
  assert.deepEqual(shared, ["go/swallowed-exception", "javascript-typescript/swallowed-exception"]);
  for (const row of rows) assert.equal(row.classId, row.edition + "/" + row.classId.split("/").slice(1).join("/"));
});

test("the backlog says why each class is on it, and ranks what jig could do about it", () => {
  const root = nodeProject();
  planOnly(root);
  const edition = editions.loadEdition(PLUGIN_ROOT, "javascript-typescript");
  for (const row of readJson(root, ".jig/backlog.json").backlog) {
    const cls = edition.classes.find((c) => editions.namespacedId("javascript-typescript", c.id) === row.classId);
    assert.ok(cls, row.classId + " is on the backlog and in no edition");
    assert.equal(row.title, cls.title);
    assert.ok(engine.CELL_RANK[row.best] !== undefined);
    assert.equal(row.reason, "not selected");
  }
});

test("the count on the page is the count in the file", () => {
  const root = nodeProject();
  planOnly(root);
  const matrix = readJson(root, ".jig/plan.json");
  const { backlog } = readJson(root, ".jig/backlog.json");
  assert.equal(matrix.backlogCount, backlog.length);
  assert.equal(matrix.backlogFile, ".jig/backlog.json");
  const md = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
  assert.ok(md.includes(backlog.length + " classes were not selected"));
});

// ---------------------------------------------------------------------------
// The files themselves
// ---------------------------------------------------------------------------

test("a generated plan writes the whole review surface into .jig", () => {
  const root = nodeProject();
  const plan = planOnly(root);
  assert.deepEqual(
    [plan.review, plan.matrix, plan.backlog],
    [".jig/plan.md", ".jig/plan.json", ".jig/backlog.json"]);
  for (const rel of [plan.review, plan.matrix, plan.backlog]) {
    assert.ok(fs.existsSync(path.join(root, rel)), rel + " was named but not written");
  }
  assert.equal(readJson(root, ".jig/plan.json").schemaVersion, engine.SCHEMA_VERSION);
});

test("a hand-written draft gets no review surface — there is no selection behind it", () => {
  const root = nodeProject();
  fs.writeFileSync(path.join(root, "draft.json"), JSON.stringify({
    changes: [{ id: "hand", kind: "write-side-file", path: ".jig/hand.json", content: "{}\n" }],
  }));
  const plan = engine.cmdPlan(root, { _: [], change: [], from: "draft.json" });
  assert.deepEqual([plan.review, plan.matrix, plan.backlog, plan.consent], [null, null, null, null]);
  for (const name of ["plan.md", "plan.json", "backlog.json"]) {
    assert.equal(fs.existsSync(path.join(root, ".jig", name)), false, name + " was written anyway");
  }
});

test("the review surface is the current one, not a pile of them", () => {
  const root = nodeProject();
  const first = planOnly(root, { "no-ci": true }, [A.PIPED_INSTALLER, A.EMPTY_CATCH]);
  const second = planOnly(root, { "no-ci": true }, [A.PIPED_INSTALLER]);
  assert.notEqual(first.planId, second.planId);
  assert.equal(readJson(root, ".jig/plan.json").planId, second.planId);
  assert.deepEqual(readJson(root, ".jig/plan.json").selection, ["piped-installer"]);
});

test("plan.json is a review, never mistaken for a transaction plan to apply", () => {
  const root = nodeProject();
  const plan = planOnly(root);
  assert.equal(readJson(root, ".jig/plan.json").kind, "review");
  assert.deepEqual(engine.planFiles(root).map((f) => path.basename(f)), ["plan-" + plan.planId + ".json"]);
});

// The review surface is still not a journalled artifact — it does not go
// through `restoreWrite` and no single change puts it back. What changed in
// 2.14.0 is what `--all` means: the fixed names say "the plan for this
// repository as it stands", and after the whole install comes out there is no
// such plan, so leaving `.jig/plan.md` behind left an armed-mode coverage
// matrix on disk for a harness that is gone.
test("revert --all takes the fixed-name review surfaces out and names them", () => {
  const root = nodeProject();
  const { plan } = install(root);
  const out = engine.cmdRevert(root, { _: [], change: [], all: true });
  assert.equal(fs.existsSync(path.join(root, ".jig", "manifest.json")), false);
  for (const name of ["plan.md", "plan.json", "backlog.json"]) {
    assert.equal(fs.existsSync(path.join(root, ".jig", name)), false, name + " survived revert --all");
    assert.ok(out.removedSurfaces.includes(".jig/" + name), name + " was removed without being named");
  }
  assert.ok(out.notes.some((n) => n.includes(".jig/plan.md")), "the removal is not disclosed in the notes");
  // The record an approval refers back to is not an install artifact either,
  // and undoing the install is not a reason to lose the audit trail.
  assert.ok(fs.existsSync(path.join(root, ".jig", "plan-" + plan.planId + ".md")), "the kept page was removed");
  assert.ok(fs.existsSync(path.join(root, ".jig", "plan-" + plan.planId + ".json")), "the kept record was removed");
});

test("a revert of one change leaves the review surfaces alone", () => {
  const root = nodeProject();
  install(root);
  const first = engine.readManifest(root).artifacts[0];
  const out = engine.cmdRevert(root, { _: [], change: [first.id], all: false });
  assert.deepEqual(out.removedSurfaces, []);
  for (const name of ["plan.md", "plan.json", "backlog.json"]) {
    assert.ok(fs.existsSync(path.join(root, ".jig", name)), name + " went with a single change");
  }
});

test("the review surface never claims coverage the manifest does not hold", () => {
  const root = nodeProject();
  install(root);
  const installed = new Set(engine.readManifest(root).artifacts.map((a) => a.path));
  const guards = new Set(readJson(root, ".jig/config.json").guards.map((g) => g.id));
  for (const row of readJson(root, ".jig/plan.json").rows) {
    for (const cell of Object.values(row.cells)) {
      if (cell.grade === "GAP") continue;
      assert.ok(installed.has(cell.artifact) || guards.has(cell.artifact),
        cell.artifact + " is claimed by the matrix and absent from the install");
    }
  }
});

// ---------------------------------------------------------------------------
// The review surface and the arming cycle
// ---------------------------------------------------------------------------

const GUARD = "piped-installer-bash-guard-0";

function armProject() {
  const root = nodeProject();
  install(root, { "no-ci": true, observe: true });
  return root;
}

function configRow(root, id) {
  return readJson(root, ".jig/config.json").guards.find((g) => g.id === (id || GUARD));
}

// 2.14.0 / roadmap 237. Widening the matchers makes a command guard EVALUATE
// on a PowerShell line where it used to never run — which is the honest
// direction and not the same as catching, so both surfaces that make a coverage
// claim disclose the syntax question.
//
// `shell.seen` is an observation off the ledger and nothing else. It replaced a
// `process.platform === "win32" ? "PowerShell" : "Bash"` inference that the two
// surfaces printed as measured fact and that is wrong on the machine it was
// written for: the interactive Claude Code session that made this change was
// offered a `Bash` tool and a `PowerShell` tool at once, on the same machine
// whose headless session had only `PowerShell` (HOST-PROBE-2026-09-02, sections
// 3 and 4). One platform, two answers — so the platform names neither.
test("the lanes report the shell tools actually seen, and never guess one", () => {
  const vocab = require("../scripts/vocab.js");
  const root = armProject();
  const fresh = engine.cmdInventory(root).lanes.session.shell;
  assert.deepEqual(fresh.watched, vocab.SHELL_TOOLS);
  // Nothing has run, so nothing is claimed. This is the assertion the platform
  // inference could not make.
  assert.deepEqual(fresh.seen, []);

  // One evaluated call on each name, through the runner, is the only thing that
  // fills it in — and it fills in exactly what the payloads carried.
  const ledger = path.join(root, ".jig", "ledger.jsonl");
  fs.appendFileSync(ledger, JSON.stringify({ decision: "pass", tool: "PowerShell", guardId: GUARD }) + "\n");
  assert.deepEqual(engine.cmdInventory(root).lanes.session.shell.seen, ["PowerShell"]);
  fs.appendFileSync(ledger, JSON.stringify({ decision: "deny", tool: "Bash", guardId: GUARD }) + "\n");
  assert.deepEqual(engine.cmdInventory(root).lanes.session.shell.seen, ["Bash", "PowerShell"]);
  // A tool nobody watches is not a shell tool jig saw.
  fs.appendFileSync(ledger, JSON.stringify({ decision: "pass", tool: "Write", guardId: GUARD }) + "\n");
  assert.deepEqual(engine.cmdInventory(root).lanes.session.shell.seen, ["Bash", "PowerShell"]);
});

// The matrix is rendered at plan time, before any guard has run, so it can name
// no host tool at all. What it owes is the syntax warning — the only user-facing
// payload of this disclosure — and it owed it on every platform: the warning
// used to sit behind a `!== "Bash"` branch that is dead code on the ubuntu
// runner CI grades the release on.
test("the coverage matrix warns about shell syntax on every platform", () => {
  const vocab = require("../scripts/vocab.js");
  const root = armProject();
  const md = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
  assert.match(md, /## The shell tool a command guard meets here/);
  for (const tool of vocab.SHELL_TOOLS) assert.ok(md.includes("`" + tool + "`"), tool);
  assert.match(md, /It matches text and not meaning/);
  assert.match(md, /evaluates and passes is not the same coverage as one that catches/);
  // No claim about which tool this host sends: the matrix cannot know.
  assert.ok(!md.includes("This host's shell tool is"),
    "the matrix asserts a host tool it has not observed");
  // And no claim about WHICH syntax fails to match either. 2.14.0 first shipped
  // "a pattern written in POSIX shell idiom (`&&`, `2>/dev/null`, `| sh`) will
  // not fire on a PowerShell line", gated by this test. PowerShell 7 — the
  // `powershell_path` HOST-PROBE-2026-09-02 section 3 recorded — implements
  // `&&` and `||` as pipeline chain operators, so that example fires there, and
  // nothing in the probe record measures any of the three. The gate now forbids
  // the example rather than pinning it: an unmeasured claim held in place by a
  // release condition is the second failure this release exists to stop.
  for (const unmeasured of ["will not fire on a PowerShell line", "2>/dev/null", "| sh"]) {
    assert.ok(!md.includes(unmeasured), "the matrix names an idiom nothing measured: " + unmeasured);
  }
});

test("review reports which lanes actually run, and the one fix for a dead one", () => {
  const root = armProject();
  let lanes = engine.cmdReview(root).lanes;
  // `armProject` installs with --no-ci and nothing wired, so exactly one lane
  // is alive: the session, and only as an observer.
  assert.equal(lanes.ci.runs, false);
  assert.equal(lanes.commit.runs, false);
  assert.equal(lanes.commit.state, "no-hook");
  // The fix has to be runnable, and it has to be the WHOLE fix. Nothing puts
  // `jig` on a PATH, so it names the skill and this script by its own path —
  // pinned entire, because a second invocation appended to it would be a second
  // thing to run and nothing here would notice.
  assert.equal(lanes.commit.fix, "ask /jig:jig to wire the commit lane, or run: node " +
    path.join(__dirname, "..", "scripts", "jig.js").replace(/\\/g, "/") + " plan --wire-commit");
  assert.equal(lanes.session.observing, true);

  // A wiring that goes quiet later is reported later. This is the whole reason
  // the lane is read fresh instead of remembered from the install.
  fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nnpm test\n");
  lanes = engine.cmdReview(root).lanes;
  assert.equal(lanes.commit.state, "hook-without-jig");
  assert.match(lanes.commit.fix, /add jig's line to \.git\/hooks\/pre-commit/);

  fs.appendFileSync(path.join(root, ".git", "hooks", "pre-commit"), "node .jig/checks/run.mjs || exit 1\n");
  lanes = engine.cmdReview(root).lanes;
  assert.equal(lanes.commit.runs, true);
  assert.equal(lanes.commit.fix, null);
});

// `lanes.session.shell.seen` is a union over the WHOLE ledger — no guard filter,
// no host filter, no time bound — so a retired guard's row and a teammate's
// committed row are both in it. The review skill was asking the model to read it
// as "the syntax THIS guard's catch count was earned against", which it cannot
// support in either direction. The per-guard fact was one grouping away: every
// row that feeds `evaluated` already carries `tool`.
test("a guard reports the shell tools its own evaluated calls arrived on", () => {
  const root = armProject();
  const other = "some-other-guard-0";
  const ledger = path.join(root, ".jig", "ledger.jsonl");
  fs.appendFileSync(ledger, [
    { ts: "2026-09-01T00:00:00.000Z", guardId: GUARD, decision: "pass", tool: "PowerShell" },
    { ts: "2026-09-01T00:00:01.000Z", guardId: GUARD, decision: "would-deny", tool: "PowerShell" },
    // Another guard's row, on the other shell tool. It is in `seen` and it is
    // NOT this guard's syntax — the whole reason a per-guard field exists.
    { ts: "2026-09-01T00:00:02.000Z", guardId: other, decision: "pass", tool: "Bash" },
    // A tool nobody watches, and a row that evaluated nothing: neither is a
    // shell this guard met.
    { ts: "2026-09-01T00:00:03.000Z", guardId: GUARD, decision: "pass", tool: "Write" },
    { ts: "2026-09-01T00:00:04.000Z", guardId: GUARD, decision: "pass", tool: "Bash", check: "unusable" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");

  const review = engine.cmdReview(root);
  const row = review.guards.find((g) => g.guardId === GUARD);
  assert.deepEqual(row.evaluatedOn, ["PowerShell"],
    "the guard's own calls arrived on PowerShell alone; Bash is another guard's row");
  // The repository-wide field carries both, which is exactly what makes it the
  // wrong thing to report beside one guard's catch count.
  assert.deepEqual(review.lanes.session.shell.seen, ["Bash", "PowerShell"]);
});

test("a guard that has never been evaluated names no shell rather than the first watched one", () => {
  const root = armProject();
  const row = engine.cmdReview(root).guards.find((g) => g.guardId === GUARD);
  assert.deepEqual(row.evaluatedOn, [], "an unrun guard claims a shell it never met");
});

test("an observing guard reports that nobody asked it to arm, and arming is offered", () => {
  const root = armProject();
  const row = engine.cmdReview(root).guards.find((g) => g.guardId === GUARD);
  assert.equal(row.provenance, "elicited");
  assert.equal(row.mode, "observe");
  assert.match(row.why, /not asked to arm/);
  assert.equal(row.armable, true);
  assert.equal(row.barrier, null);
  assert.equal(row.fired, 0);
  // A quiet guard has to say how many calls it was quiet over, or "never fired"
  // is a number with nothing under it.
  assert.equal(row.evaluated, 0);
  assert.equal(row.denied, 0);
  assert.equal(row.wouldDeny, 0);
  assert.equal(row.lastFired, null);
});

test("the review row divides what a guard caught by what it was run on", () => {
  const root = armProject();
  const rows = [
    { ts: "2026-09-01T00:00:00.000Z", guardId: GUARD, decision: "pass" },
    { ts: "2026-09-01T00:00:01.000Z", guardId: GUARD, decision: "pass" },
    { ts: "2026-09-01T00:00:02.000Z", guardId: GUARD, decision: "would-deny" },
  ];
  fs.appendFileSync(path.join(root, ".jig", "ledger.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const row = engine.cmdReview(root).guards.find((g) => g.guardId === GUARD);
  assert.equal(row.fired, 1);
  assert.equal(row.evaluated, 3, "one catch in three calls reported without the three");
  // The guard is observing, so the catch it made cost nothing — that is the
  // half of `fired` the report never separated.
  assert.equal(row.wouldDeny, 1);
  assert.equal(row.denied, 0);
  assert.equal(row.lastFired, "2026-09-01T00:00:02.000Z");
});

test("arming is a journaled config change, and the review agrees afterwards", () => {
  const root = armProject();
  const journalBefore = engine.readJournal(root).length;
  const armed = engine.cmdArm(root, { _: [], change: [], guard: GUARD });
  assert.equal(armed.ok, true);
  assert.match(armed.evidence, /proof matches the check on disk/);
  assert.equal(configRow(root).mode, "armed");
  assert.equal(configRow(root).provenance, "elicited");
  assert.ok(engine.readJournal(root).length > journalBefore, "the arm was not journaled");
  assert.equal(engine.cmdReview(root).guards.find((g) => g.guardId === GUARD).mode, "armed");
});

// SCOPE, the derail pass: "Does `fp` need the same pause as disarm | Yes."
// Waving a report off stops an armed guard refusing tool calls, so the ledger
// line is the judgment and the config change the owner approves is the effect.
test("fp records the wave-off, changes nothing, and hands back the token that does", () => {
  const root = armProject();
  engine.cmdArm(root, { _: [], change: [], guard: GUARD });

  const fp = engine.cmdFp(root, { _: [], change: [], guard: GUARD });
  assert.equal(fp.recorded, "false-positive-pending");
  assert.equal(fp.applied, false);
  assert.equal(fp.pending, "false-positive");
  assert.equal(fp.path, ".jig/config.json");
  assert.equal(fp.apply, "apply --change " + fp.change + " --path .jig/config.json");
  assert.equal(configRow(root).mode, "armed", "fp quieted the guard with nobody approving anything");

  const row = engine.cmdReview(root).guards.find((g) => g.guardId === GUARD);
  assert.equal(row.wavedOff, 1);
  assert.equal(row.pendingWaveOff, true);
  assert.equal(row.mode, "armed");

  engine.cmdApply(root, { _: [], change: [fp.change], path: [fp.path] });
  assert.equal(configRow(root).mode, undefined, "the approved change did not quiet the guard");
});

test("a false positive left standing by an older install holds the guard, and --clear releases it", () => {
  const root = armProject();
  engine.cmdArm(root, { _: [], change: [], guard: GUARD });
  // The shape a 1.0.1 install migrates in with, and the one the arming gate has
  // always read. Nothing shipped writes it any more; `--clear` is the way out.
  fs.appendFileSync(path.join(root, ".jig", "ledger.jsonl"),
    JSON.stringify({ guardId: GUARD, decision: "false-positive" }) + "\n");

  let row = engine.cmdReview(root).guards.find((g) => g.guardId === GUARD);
  assert.equal(row.mode, "observe", "the standing false positive did not pull the guard back");
  assert.match(row.why, /false positive/);
  assert.equal(row.armable, false);
  // The sentence the review prints for this case, not just the throw: it is the
  // only place the owner is told WHY the guard will not go back to blocking.
  assert.match(row.barrier, /false positive/);
  assert.throws(() => engine.cmdArm(root, { _: [], change: [], guard: GUARD }), /false positive/);

  const cleared = engine.cmdFp(root, { _: [], change: [], guard: GUARD, clear: true });
  assert.equal(cleared.recorded, "false-positive-cleared");
  assert.equal(cleared.cleared, GUARD);
  // Append-only: the earlier judgment is still on the record, it just no longer
  // stands.
  const decisions = fs.readFileSync(path.join(root, ".jig", "ledger.jsonl"), "utf-8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l).decision);
  assert.ok(decisions.includes("false-positive"));
  assert.equal(decisions[decisions.length - 1], "false-positive-cleared");

  row = engine.cmdReview(root).guards.find((g) => g.guardId === GUARD);
  assert.equal(row.mode, "armed");
  assert.equal(row.armable, true);
});

test("disarm plans and stops — nothing changes until the pair is approved", () => {
  const root = armProject();
  engine.cmdArm(root, { _: [], change: [], guard: GUARD });

  const out = engine.cmdDisarm(root, { _: [], change: [], guard: GUARD });
  assert.equal(out.applied, false);
  assert.equal(out.pending, "disarm");
  assert.equal(out.path, ".jig/config.json");
  assert.equal(configRow(root).mode, "armed", "disarm took the guard down with no approval");

  // The pair is the token, and the wrong half of it is a refusal.
  assert.throws(() => engine.cmdApply(root, { _: [], change: [out.change], path: ["package.json"] }),
    /Refusing to apply/);
  engine.cmdApply(root, { _: [], change: [out.change], path: [out.path] });
  assert.equal(configRow(root).mode, undefined);
});

test("arming refuses with the same words the runner would use, when the proof no longer holds", () => {
  const root = armProject();
  fs.appendFileSync(path.join(root, ".jig", "checks", "piped-installer.check.mjs"), "\n// widened by hand\n");
  const row = engine.cmdReview(root).guards.find((g) => g.guardId === GUARD);
  assert.equal(row.armable, false);
  assert.match(row.barrier, /does not match the check on disk/);
  assert.throws(() => engine.cmdArm(root, { _: [], change: [], guard: GUARD }),
    /arming gate is not met.*does not match the check on disk/s);
});

test("arm, disarm, fp and retire all refuse a guard the config does not carry", () => {
  const root = armProject();
  for (const cmd of [engine.cmdArm, engine.cmdDisarm, engine.cmdFp, engine.cmdRetire]) {
    assert.throws(() => cmd(root, { _: [], change: [], guard: "no-such-guard" }), /not a configured guard/);
  }
});

// ---------------------------------------------------------------------------
// The toolchain, on the surface the owner approves from
// ---------------------------------------------------------------------------
//
// REVERSED by SCOPE: jig proposes the exact install command and runs it on
// approval. So the plan has to carry the command, the config path and the way
// back out — an install approved from a surface nobody read is the failure this
// section exists to prevent.

test("a tool the machine does not carry becomes a named install item on the reviewed plan", () => {
  const root = nodeProject({ "package-lock.json": "{ \"lockfileVersion\": 3 }\n" });
  const plan = planOnly(root, { "no-ci": true, tools: "eslint" });
  assert.equal(plan.toolchain.packageManager, "npm");
  const row = plan.toolchain.items.find((t) => t.id === "eslint");
  assert.ok(row, "eslint was asked for and is not on the plan");
  assert.equal(row.present, false);
  assert.equal(row.installKind, "package");
  assert.match(row.command, /^npm install --save-dev eslint\b/);
  assert.ok(row.uninstall, "an install with no way back out reached the plan");

  const change = plan.changes.find((c) => c.kind === "run-install");
  assert.equal(change.path, row.configPath);
  const md = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
  assert.ok(md.includes("`" + row.command + "`"), "the command that will run is not on the page");
  assert.ok(md.includes("`" + row.uninstall + "`"), "the way back out is not on the page");
});

test("an install is approved one at a time, naming the command that will run", () => {
  const root = nodeProject({ "package-lock.json": "{ \"lockfileVersion\": 3 }\n" });
  const plan = planOnly(root, { "no-ci": true, tools: "eslint" });
  const change = plan.changes.find((c) => c.kind === "run-install");
  const artifact = readJson(root, ".jig/plan.json").artifacts.find((a) => a.id === change.id);
  assert.equal(artifact.tier, "item");
  assert.match(artifact.why, /against this machine/);
  assert.ok(plan.consent.item.includes(change.id));
});

test("a toolchain question jig cannot answer honestly is refused onto the page, never guessed", () => {
  const noManager = nodeProject();
  const plan = planOnly(noManager, { "no-ci": true, tools: "eslint" });
  assert.deepEqual(plan.toolchain.items, []);
  assert.equal(plan.refused.length, 1);
  assert.match(plan.refused[0], /no package manager is conclusive/);
  assert.ok(fs.readFileSync(path.join(noManager, ".jig", "plan.md"), "utf-8").includes(plan.refused[0]));

  const unknown = nodeProject({ "package-lock.json": "{}\n" });
  const second = planOnly(unknown, { "no-ci": true, tools: "not-a-tool" });
  assert.match(second.refused.join(" "), /is not a tool in any edition/);
});

// ---------------------------------------------------------------------------
// Prose emission — budgeted, labeled, on request only
// ---------------------------------------------------------------------------

test("a default install emits no always-loaded prose at all", () => {
  const root = nodeProject();
  const plan = planOnly(root, { "no-ci": true });
  assert.equal(plan.changes.some((c) => c.kind === "write-rule"), false);
});

test("the prose budget refuses a plan that would out-spend it, naming the number", () => {
  const root = project({});
  const fat = "x".repeat(engine.PROSE_BUDGET_BYTES + 1) + "\n<!-- generated by jig — evidence: reasoned -->\n";
  const { problems } = engine.planFromDraft({ changes: [{
    id: "fat", kind: "write-rule", path: ".claude/rules/jig-fat.md", content: fat,
  }] }, root);
  assert.match(problems.join(" "), new RegExp("budget is " + engine.PROSE_BUDGET_BYTES));
});

test("unlabeled prose is refused, and a rule outside the jig- namespace is refused", () => {
  const root = project({});
  const unlabeled = engine.planFromDraft({ changes: [{
    id: "r", kind: "write-rule", path: ".claude/rules/jig-x.md", content: "- rule text\n",
  }] }, root);
  assert.match(unlabeled.problems.join(" "), /evidence label/);

  const squatting = engine.planFromDraft({ changes: [{
    id: "r", kind: "write-rule", path: ".claude/rules/api.md",
    content: "- rule\n<!-- generated by jig — evidence: reasoned -->\n",
  }] }, root);
  assert.match(squatting.problems.join(" "), /jig-<slug>\.md/);
});

test("weave-precommit puts jig's line into a committed sh hook, and only there", () => {
  const root = nodeProject({
    "scripts/git-hooks/pre-commit": "#!/bin/sh\nset -e\nnpm test\n",
  });
  const scan = engine.cmdScan(root, { _: [], change: [] });
  const hosts = scan.guardrails.precommit;
  assert.deepEqual(hosts.map((h) => [h.path, h.host, h.woven]), [["scripts/git-hooks/pre-commit", "sh", false]]);

  const plan = planOnly(root, { "no-ci": true, "weave-precommit": true });
  const woven = plan.changes.find((c) => c.kind === "include-line");
  assert.ok(woven, "no weave was planned");
  assert.equal(woven.path, "scripts/git-hooks/pre-commit");
  A.applyPlan(engine, root, plan);

  const after = fs.readFileSync(path.join(root, "scripts/git-hooks/pre-commit"), "utf-8");
  assert.ok(after.includes("jig:checks"), "the marker never landed");
  assert.ok(after.includes("npm test"), "the host's own work was disturbed");

  // Reverting takes the line back out and leaves the hook exactly as it was.
  engine.cmdRevert(root, { _: [], change: [], all: true });
  assert.equal(fs.readFileSync(path.join(root, "scripts/git-hooks/pre-commit"), "utf-8"),
    "#!/bin/sh\nset -e\nnpm test\n");
});

test("a node-shebang hook gets the in-process line, below its strict-mode directive", () => {
  const root = nodeProject({
    "scripts/git-hooks/pre-commit": '#!/usr/bin/env node\n"use strict";\nprocess.exit(0);\n',
  });
  const scan = engine.cmdScan(root, { _: [], change: [] });
  assert.equal(scan.guardrails.precommit[0].host, "node");

  const plan = planOnly(root, { "no-ci": true, "weave-precommit": true });
  A.applyPlan(engine, root, plan);
  const after = fs.readFileSync(path.join(root, "scripts/git-hooks/pre-commit"), "utf-8");
  assert.ok(after.indexOf('"use strict";') < after.indexOf("jig:checks"),
    "the line landed above the directive prologue, which turns strict mode off");
});

test("weave-precommit refuses a repository with no committed hook to weave into", () => {
  const root = nodeProject({});
  engine.cmdScan(root, { _: [], change: [] });
  assert.throws(() => planOnly(root, { "no-ci": true, "weave-precommit": true }),
    /no committed pre-commit hook/);
});

test("wire-governance emits one computed pointer rule from the scan's own orphans", () => {
  const root = nodeProject({
    "CLAUDE.md": "# House\n",
    "SCOPE.md": "# Scope\n",
    "docs/adr/0001-x.md": "# ADR\n",
  });
  engine.cmdScan(root, { _: [], change: [] });
  const plan = planOnly(root, { "no-ci": true, "wire-governance": true });
  const rule = plan.changes.find((c) => c.path === ".claude/rules/jig-governance.md");
  assert.ok(rule, "no governance rule was planned");
  A.applyPlan(engine, root, plan);
  const text = fs.readFileSync(path.join(root, ".claude/rules/jig-governance.md"), "utf-8");
  assert.match(text, /SCOPE\.md/);
  assert.match(text, /docs\/adr\/0001-x\.md/);
  assert.match(text, /generated by jig/);

  const clean = nodeProject({ "CLAUDE.md": "read SCOPE.md\n", "SCOPE.md": "# Scope\n" });
  engine.cmdScan(clean, { _: [], change: [] });
  assert.throws(() => planOnly(clean, { "no-ci": true, "wire-governance": true }),
    /no orphaned governance docs/);
});

// ---------------------------------------------------------------------------
// The re-run regimen
// ---------------------------------------------------------------------------

test("rerun reports drift, the firing record, the quiet guards and the backlog in one read", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });

  fs.appendFileSync(path.join(root, ".jig", "ledger.jsonl"),
    JSON.stringify({ session: "s1", guardId: GUARD, decision: "would-deny" }) + "\n");
  fs.appendFileSync(path.join(root, ".jig", "checks", "run.mjs"), "\n// drifted\n");

  const report = engine.cmdRerun(root);
  assert.ok(report.installedAt, "no install timestamp");
  assert.deepEqual(report.drifted, [".jig/checks/run.mjs"]);
  const quiet = report.guards.find((g) => g.guardId === "empty-catch-edit-observe-guard-0");
  assert.equal(quiet.fired, 0);
  assert.ok(report.neverFired.includes("empty-catch-edit-observe-guard-0"));
  assert.equal(report.neverFired.includes(GUARD), false, "a fired guard was called dead");
  assert.ok(report.backlog.length > 0);
  // A fixture is not a git repository, so there is nothing to mine — the
  // section is present and null, never missing and never invented.
  assert.equal("sinceInstall" in report, true, "rerun said nothing about what happened since the install");
  assert.equal(report.sinceInstall, null);
});

test("retiring a guard plans and stops, then lands as a journaled config change the ledger survives", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const before = engine.readJournal(root).length;

  const out = engine.cmdRetire(root, { _: [], change: [], guard: GUARD });
  assert.equal(out.applied, false);
  assert.equal(out.pending, "retire");
  assert.equal(readJson(root, ".jig/config.json").guards.some((g) => g.id === GUARD), true,
    "the guard was deleted before anybody approved it");
  assert.equal(engine.readJournal(root).length, before);

  engine.cmdApply(root, { _: [], change: [out.change], path: [out.path] });
  assert.equal(readJson(root, ".jig/config.json").guards.some((g) => g.id === GUARD), false);
  assert.ok(engine.readJournal(root).length > before);
  assert.throws(() => engine.cmdRetire(root, { _: [], change: [], guard: GUARD }), /not a configured guard/);
});

test("rerun on a bare repository refuses with the reason", () => {
  const root = project({});
  assert.throws(() => engine.cmdRerun(root), /nothing is installed here/);
});

// ---------------------------------------------------------------------------
// The inventory surface: what is here, why, and whether it watches anything
// ---------------------------------------------------------------------------
//
// `review` answers what the guards have CAUGHT. Everything below is about the
// other half — what each one WATCHES, and why the owner approved it — which
// lived nowhere on disk before this surface existed.

test("inventory reports what each guard watches, and counts the matchers rather than printing them", () => {
  const root = armProject();
  const inv = engine.cmdInventory(root);
  const row = inv.guards.find((g) => g.guardId === GUARD);

  assert.equal(row.watches.event, "PreToolUse");
  // Both shell tools, because the session names its own: a command guard that
  // reported `Bash` alone would have been naming a tool the measured headless
  // session did not have (2.14.0). Spelled out, not read off `SHELL_TOOLS` — this is the
  // only per-guard assertion on the widened list, and an expectation derived
  // from the list under test survives the list narrowing back.
  assert.deepEqual(row.watches.tools, ["Bash", "PowerShell"]);
  assert.deepEqual(row.watches.tools, require("../scripts/vocab.js").SHELL_TOOLS,
    "the guard reports a tool list that is not the shared one");
  assert.ok(row.watches.patterns > 0, "the guard reports no matchers at all");
  assert.ok(row.watches.deny && row.watches.deny.reason, "an armable guard with no deny reply");
  assert.equal(row.provable, true);

  // The matcher source is behind an approval boundary. A report that re-issued
  // it would be a matcher nobody reviewed, arriving through the back door.
  assert.ok(!JSON.stringify(inv).includes(A.PIPED_INSTALLER.detectors[0].params.patterns[0]),
    "the inventory printed a matcher instead of counting it");
});

// 2.11.0 / C6. Teaching is the owner's answer, and the two things that could
// lose it are the report that never mentions it and the re-run that overwrites
// the row. SCOPE, "Does an observing guard teach by default": no.
test("inventory reports which guards teach, and a re-run carries that answer forward", () => {
  const root = nodeProject();
  install(root, { "no-ci": true, observe: true });
  const config = readJson(root, ".jig/config.json");
  const observing = config.guards.find((g) => g.runner === "PostToolUse");
  assert.ok(observing, "no PostToolUse guard to teach from");

  // Off unless asked, on every row, however the install went.
  for (const row of engine.cmdInventory(root).guards) assert.equal(row.teach, false);

  observing.teach = true;
  fs.writeFileSync(path.join(root, ".jig", "config.json"), JSON.stringify(config, null, 2) + "\n");
  const inv = engine.cmdInventory(root);
  assert.equal(inv.guards.find((g) => g.guardId === observing.id).teach, true);
  assert.equal(inv.guards.find((g) => g.guardId === GUARD).teach, false);

  // A second interview is not where it silently reverts to off.
  const plan = planOnly(root, { "no-ci": true }, [A.HEURISTIC_ONLY]);
  const proposed = JSON.parse(readJson(root, ".jig/plan-" + plan.planId + ".json")
    .changes.find((c) => c.kind === "write-config").content);
  assert.equal(proposed.guards.find((g) => g.id === observing.id).teach, true);
});

test("inventory records why each artifact is here, and says where the answer came from", () => {
  const root = armProject();
  const inv = engine.cmdInventory(root);
  const rows = inv.artifacts.filter((a) => a.why);
  assert.ok(rows.length, "no artifact carried a rationale");
  for (const a of rows) assert.equal(a.whySource, "manifest");

  const check = inv.artifacts.find((a) => a.path.endsWith("piped-installer.check.mjs"));
  assert.ok(check.why, "the check module landed with no recorded reason");
  assert.equal(check.state, "active");
});

test("inventory recovers a missing rationale from the plan file, and never invents one", () => {
  const root = armProject();
  const file = path.join(root, ".jig", "manifest.json");

  // A manifest written before the field existed. The plan it was applied from
  // is still beside it, so the answer survives.
  const manifest = JSON.parse(fs.readFileSync(file, "utf-8"));
  for (const a of manifest.artifacts) delete a.rationale;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");

  const recovered = engine.cmdInventory(root).artifacts.filter((a) => a.why);
  assert.ok(recovered.length, "nothing was recovered from the plan files");
  for (const a of recovered) assert.equal(a.whySource, "plan");

  // Now take the plan files away too. Neither source survives, and jig says so
  // rather than supplying a reason it never recorded.
  for (const f of fs.readdirSync(path.join(root, ".jig")).filter((n) => /^plan-[0-9a-f]+\.json$/.test(n))) {
    fs.unlinkSync(path.join(root, ".jig", f));
  }
  for (const a of engine.cmdInventory(root).artifacts) {
    assert.equal(a.why, null);
    assert.equal(a.whySource, "none");
  }
});

test("inventory lists the check modules, including detectors no guard row carries", () => {
  const root = armProject();
  const inv = engine.cmdInventory(root);
  const check = inv.checks.find((c) => c.slug === "piped-installer");

  assert.equal(check.problem, null);
  assert.equal(check.provable, true);
  assert.ok(check.detectors.length, "the module reports no detectors");

  // The whole reason this section is not the guard list: a `checks` detector is
  // what the commit hook and CI run and it appears in no config row at all.
  const guarded = new Set(inv.guards.map((g) => g.watches && g.watches.event));
  const beyond = inv.checks.flatMap((c) => c.detectors).filter((d) => !guarded.has(d.event));
  assert.ok(beyond.length, "every detector was already covered by a guard row");
});

test("inventory reports a repository jig never touched instead of refusing it", () => {
  const root = project({});
  const inv = engine.cmdInventory(root);
  assert.deepEqual(inv.guards, []);
  assert.deepEqual(inv.artifacts, []);
  assert.deepEqual(inv.checks, []);
  assert.equal(inv.lanes.commit.runs, false);
  assert.ok(inv.lanes.commit.fix, "a dead commit lane was reported with no fix");
});

test("inventory reports a refused config as the problem it is, not as an empty list", () => {
  const root = armProject();
  fs.writeFileSync(path.join(root, ".jig", "config.json"), "{ not json\n");
  const inv = engine.cmdInventory(root);
  assert.deepEqual(inv.guards, []);
  assert.match(inv.guardsProblem, /config/);
  // The rest of the report survives, which is the point of not throwing.
  assert.ok(inv.artifacts.length, "an unreadable config took the artifact list with it");
  assert.ok(inv.checks.length, "an unreadable config took the check list with it");
});
