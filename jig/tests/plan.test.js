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
  const applied = engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
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
    "edit-observe-guard", "prose-rule", "tool-rule",
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
    ".jig/config.json",
  ]);
  assert.deepEqual(plan.consent.item.sort(), item.map((a) => a.id).sort());
  assert.match(item.find((a) => a.path === ".jig/config.json").why, /refuse a tool call/);
  assert.match(item.find((a) => a.path.startsWith(".github/")).why, /fails the build/);
  assert.match(item.find((a) => a.path.endsWith(".check.mjs")).why, /can fail a build/);
});

test("everything that only reports is approved in one go", () => {
  const root = nodeProject();
  planOnly(root);
  const batch = readJson(root, ".jig/plan.json").artifacts.filter((a) => a.tier === "batch");
  assert.deepEqual(batch.map((a) => a.path).sort(), [
    ".jig/activation.md",
    ".jig/checks/run.mjs",
    ".jig/hooks/pre-commit",
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

test("the review surface is not an installed artifact, so revert leaves it where it is", () => {
  const root = nodeProject();
  install(root);
  engine.cmdRevert(root, { _: [], change: [], all: true });
  assert.equal(fs.existsSync(path.join(root, ".jig", "manifest.json")), false);
  for (const name of ["plan.md", "plan.json", "backlog.json"]) {
    assert.ok(fs.existsSync(path.join(root, ".jig", name)), name + " was reverted");
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

test("an observing guard reports that nobody asked it to arm, and arming is offered", () => {
  const root = armProject();
  const row = engine.cmdReview(root).guards.find((g) => g.guardId === GUARD);
  assert.equal(row.provenance, "elicited");
  assert.equal(row.mode, "observe");
  assert.match(row.why, /not asked to arm/);
  assert.equal(row.armable, true);
  assert.equal(row.barrier, null);
  assert.equal(row.fired, 0);
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

test("a recorded false positive holds the guard in observe, and disarm drops its mode", () => {
  const root = armProject();
  engine.cmdArm(root, { _: [], change: [], guard: GUARD });

  const fp = engine.cmdFp(root, { _: [], change: [], guard: GUARD });
  assert.equal(fp.recorded, "false-positive");
  const row = engine.cmdReview(root).guards.find((g) => g.guardId === GUARD);
  assert.equal(row.wavedOff, 1);
  assert.equal(row.mode, "observe", "the false positive did not pull the guard back to observe");
  assert.match(row.why, /false positive/);
  assert.equal(row.armable, false);
  assert.match(row.barrier, /false positive/);

  engine.cmdDisarm(root, { _: [], change: [], guard: GUARD });
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

test("--prose refuses a class with no prose-rule detector rather than inventing one", () => {
  const root = nodeProject();
  assert.throws(() => engine.cmdPlan(root, {
    _: [], change: [], provenance: "elicited", "no-ci": true,
    authored: A.writeChecks(root, CHECKS), prose: "piped-installer",
  }), /has no prose-rule detector/);
  assert.throws(() => engine.cmdPlan(root, {
    _: [], change: [], provenance: "elicited", "no-ci": true,
    authored: A.writeChecks(root, CHECKS), prose: "not-in-this-plan",
  }), /is not in this plan's selection/);
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
  engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
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
});

test("retiring a guard is a journaled config change the ledger survives", () => {
  const root = nodeProject();
  install(root, { "no-ci": true });
  const before = engine.readJournal(root).length;

  const out = engine.cmdRetire(root, { _: [], change: [], guard: GUARD });
  assert.equal(out.retired, GUARD);
  assert.equal(readJson(root, ".jig/config.json").guards.some((g) => g.id === GUARD), false);
  assert.ok(engine.readJournal(root).length > before);
  assert.throws(() => engine.cmdRetire(root, { _: [], change: [], guard: GUARD }), /not a configured guard/);
});

test("rerun on a bare repository refuses with the reason", () => {
  const root = project({});
  assert.throws(() => engine.cmdRerun(root), /nothing is installed here/);
});
