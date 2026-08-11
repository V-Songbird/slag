"use strict";

// The review surface: the screen somebody reads before any guard is written.
// Two claims are load-bearing here and neither can be checked by reading the
// output — that every cell is DERIVED from the catalogue rather than written by
// hand, and that the floor FAILS a plan rather than being a convention people
// remember. So the suite checks the derivation against the catalogue itself,
// and exercises the throw against a class the catalogue does not contain.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const engine = require("../scripts/jig.js");
const catalogue = require("../scripts/catalogue.json");

const ALL_FOUR = "silent-catch,focused-or-skipped-test,pipe-to-shell,test-file-deletion";

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

function planOnly(root, select, opts) {
  return engine.cmdPlan(root, { _: [], change: [], select, ...(opts || {}) });
}

function install(root, select, opts) {
  const plan = planOnly(root, select, opts);
  const applied = engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  return { plan, applied };
}

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf-8"));
}

function classOf(id) {
  return catalogue.classes.find((c) => c.id === id);
}

// A class the catalogue does not ship, so the floor can be exercised without
// first breaking the catalogue every other suite reads.
function synthetic(overrides) {
  return {
    id: "synthetic-class",
    title: "A class invented by this test",
    severity: "hygiene",
    axes: ["agent"],
    installableAtV1: false,
    enforcementGap: false,
    detectors: [],
    ...overrides,
  };
}

const HOOK_DETECTOR = { actor: "claude-session", lever: "bash-guard", runner: "PreToolUse", confidence: "deterministic" };
const DRIVER_DETECTOR = { actor: "human-editor", lever: "check-driver", runner: "checks", confidence: "deterministic" };

// ---------------------------------------------------------------------------
// The host-neutral floor
// ---------------------------------------------------------------------------

test("a class with a host-neutral deterministic lever clears the floor", () => {
  const cls = synthetic({ detectors: [DRIVER_DETECTOR] });
  assert.equal(engine.hostNeutralFloor(cls), true);
  assert.equal(engine.floorProblem(cls), null);
});

test("a lever only an agent host can run does not clear the floor, however deterministic", () => {
  const cls = synthetic({ detectors: [HOOK_DETECTOR] });
  assert.equal(catalogue.levers["bash-guard"].hostNeutral, false);
  assert.equal(engine.hostNeutralFloor(cls), false);
  assert.match(engine.floorProblem(cls), /no host-neutral deterministic lever/);
});

test("a host-neutral lever that can be wrong does not clear the floor either", () => {
  const cls = synthetic({ detectors: [{ ...DRIVER_DETECTOR, confidence: "heuristic" }] });
  assert.equal(engine.hostNeutralFloor(cls), false);
  assert.equal(typeof engine.floorProblem(cls), "string");
});

test("the ENFORCEMENT GAP stamp is the only way past the floor", () => {
  const bare = synthetic({ detectors: [HOOK_DETECTOR] });
  assert.equal(typeof engine.floorProblem(bare), "string");
  assert.equal(engine.floorProblem({ ...bare, enforcementGap: true }), null);
});

test("the floor throws, naming the class — it is a construction, not a convention", () => {
  assert.throws(
    () => engine.floorCheck([synthetic({ detectors: [HOOK_DETECTOR] })]),
    /host-neutral floor[\s\S]*synthetic-class/);
});

test("a selection where one class fails the floor throws for that class alone", () => {
  const ok = synthetic({ id: "clears-the-floor", detectors: [DRIVER_DETECTOR] });
  const bad = synthetic({ id: "fails-the-floor", detectors: [HOOK_DETECTOR] });
  try {
    engine.floorCheck([ok, bad]);
    assert.fail("the floor let a class through");
  } catch (err) {
    assert.equal(err.expected, true);
    assert.match(err.message, /fails-the-floor/);
    assert.equal(err.message.includes("clears-the-floor"), false);
  }
});

test("every class the catalogue ships already clears the floor or carries the stamp", () => {
  // Which is why the throw above cannot fire in production. The pairing is the
  // point: the construction is real, and today nothing trips it.
  assert.doesNotThrow(() => engine.floorCheck(catalogue.classes));
});

test("a plan that clears the floor leaves the plan artifact, one that does not writes nothing", () => {
  const root = project({});
  assert.doesNotThrow(() => planOnly(root, "silent-catch"));
  assert.ok(fs.existsSync(path.join(root, ".jig", "plan.json")));

  const empty = project({});
  assert.throws(() => planOnly(empty, "nested-ternary"), /ships as data at v1/);
  assert.equal(fs.existsSync(path.join(empty, ".jig")), false);
});

// ---------------------------------------------------------------------------
// The matrix is computed, never authored
// ---------------------------------------------------------------------------

test("the columns are the catalogue's own actor list, in its own order", () => {
  const root = project({});
  planOnly(root, ALL_FOUR);
  const matrix = readJson(root, ".jig/plan.json");
  assert.deepEqual(matrix.actors, catalogue.actors);
  for (const row of matrix.rows) assert.deepEqual(Object.keys(row.cells), catalogue.actors);
});

test("there is one row per selected class and nothing else", () => {
  const root = project({});
  planOnly(root, "silent-catch,pipe-to-shell");
  const matrix = readJson(root, ".jig/plan.json");
  assert.deepEqual(matrix.rows.map((r) => r.classId), ["pipe-to-shell", "silent-catch"]);
  assert.deepEqual(matrix.selection, ["pipe-to-shell", "silent-catch"]);
});

test("every cell traces back to a detector the catalogue defines, or says none does", () => {
  const root = project({});
  planOnly(root, ALL_FOUR);
  for (const row of readJson(root, ".jig/plan.json").rows) {
    const cls = classOf(row.classId);
    for (const [actor, cell] of Object.entries(row.cells)) {
      if (cell.lever === null) {
        assert.equal(cell.grade, "GAP");
        assert.match(cell.why, new RegExp("no detector in the catalogue names " + actor));
        continue;
      }
      assert.ok(catalogue.levers[cell.lever], cell.lever + " is not a lever");
      assert.ok(cls.detectors.some((d) => d.actor === actor && d.lever === cell.lever),
        row.classId + "/" + actor + " names a detector the class does not carry");
    }
  }
});

test("every covered cell names an artifact this plan actually writes", () => {
  const root = project({});
  const { plan } = install(root, ALL_FOUR);
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

test("the Codex column is GAP in every row, because no detector names codex-session", () => {
  assert.equal(catalogue.classes.some((c) => c.detectors.some((d) => d.actor === "codex-session")), false);
  const root = project({});
  planOnly(root, ALL_FOUR);
  for (const row of readJson(root, ".jig/plan.json").rows) {
    assert.equal(row.cells["codex-session"].grade, "GAP");
    assert.equal(row.cells["codex-session"].artifact, null);
    assert.match(row.cells["codex-session"].why, /no detector in the catalogue names codex-session/);
  }
});

test("a detector on a lever that ships later reads GAP, naming the release", () => {
  const later = { actor: "human-editor", lever: "review", runner: "none", confidence: "heuristic" };
  assert.equal(engine.leverAvailable(catalogue.levers["review"]), false);
  const cell = engine.detectorCell(synthetic({}), later, 0, "elicited", [], []);
  assert.equal(cell.grade, "GAP");
  assert.match(cell.why, /review lever ships at never/);
});

test("a class covered by both a shipping lever and a later one is graded on the shipping one", () => {
  const cls = classOf("silent-catch");
  const ci = cls.detectors.filter((d) => d.actor === "human-ci").map((d) => d.lever).sort();
  assert.deepEqual(ci, ["ci-workflow", "detekt-rule", "eslint-rule"]);
  const root = project({});
  planOnly(root, "silent-catch");
  const cell = readJson(root, ".jig/plan.json").rows[0].cells["human-ci"];
  assert.equal(cell.grade, "DET");
  assert.equal(cell.lever, "ci-workflow");
});

test("a lever the catalogue names and this build does not ship reads GAP by name", () => {
  const cell = engine.detectorCell(synthetic({}),
    { actor: "human-ci", lever: "invented-lever", runner: "ci", confidence: "deterministic" }, 0, "elicited", [], []);
  assert.equal(engine.leverOf("invented-lever"), null);
  assert.equal(cell.grade, "GAP");
  assert.match(cell.why, /does not ship/);
});

test("skipping the CI workflow drops the CI column rather than quietly keeping the claim", () => {
  const root = project({});
  planOnly(root, "silent-catch", { "no-ci": true });
  const cell = readJson(root, ".jig/plan.json").rows[0].cells["human-ci"];
  assert.equal(cell.grade, "GAP");
  assert.match(cell.why, /writes no ci-workflow artifact for silent-catch/);
});

test("a detector that can be wrong reads PROB carrying the kind of doubt, never a number", () => {
  const root = project({});
  planOnly(root, "pipe-to-shell");
  const cell = readJson(root, ".jig/plan.json").rows[0].cells["human-editor"];
  assert.equal(cell.grade, "PROB");
  assert.equal(cell.ceiling, "heuristic");
  assert.equal(/\d/.test(engine.cellText(cell).split(" ")[0]), false);
});

test("a probabilistic lever says its ceiling is unmeasured rather than inventing one", () => {
  const prose = { actor: "claude-session", lever: "prose-rule", runner: "none", confidence: "heuristic" };
  assert.equal(catalogue.levers["prose-rule"].probabilistic, true);
  assert.equal(engine.detectorCeiling(prose), "unmeasured");
  assert.equal(engine.detectorCeiling({ ...DRIVER_DETECTOR, confidence: "heuristic" }), "heuristic");
});

test("AVAILABLE_NOW picks out exactly the levers this build can emit an artifact for", () => {
  const now = Object.keys(catalogue.levers).filter((id) => engine.leverAvailable(catalogue.levers[id]));
  assert.deepEqual(now.sort(), [
    "bash-guard", "check-driver", "ci-workflow", "detekt-rule",
    "edit-observe-guard", "eslint-rule", "prose-rule", "test-suite", "type-system",
  ]);
  // …and the ordering really is an ordering: an earlier release's lever stays
  // available, a later one does not.
  assert.equal(engine.leverAvailable({ availableAt: "0.1.0-alpha" }), true);
  assert.equal(engine.leverAvailable({ availableAt: "0.5.0-alpha" }), false);
  assert.equal(engine.leverAvailable({ availableAt: "never" }), false);
});

// ---------------------------------------------------------------------------
// Provenance bars arming
// ---------------------------------------------------------------------------

test("an assumed row can never arm a deny-capable lever", () => {
  const root = project({});
  planOnly(root, ALL_FOUR, { provenance: "assumed" });
  const rows = readJson(root, ".jig/plan.json").rows;
  const deny = rows.flatMap((r) => Object.values(r.cells)).filter((c) => c.armable !== null);
  assert.ok(deny.length > 0, "no deny-capable cell to test");
  for (const cell of deny) assert.equal(cell.armable, false);
});

test("quick-start installs as assumed, so quick-start arms nothing", () => {
  const root = project({});
  planOnly(root, ALL_FOUR);
  const matrix = readJson(root, ".jig/plan.json");
  assert.equal(matrix.provenance, "assumed");
  assert.ok(matrix.rows.every((r) => Object.values(r.cells).every((c) => c.armable !== true)));
});

test("no option makes an assumed row armable — the bar holds under every configuration", () => {
  for (const opts of [{}, { "no-ci": true }, { provenance: "assumed" }, { provenance: "nonsense" }]) {
    const root = project({});
    planOnly(root, ALL_FOUR, opts);
    const matrix = readJson(root, ".jig/plan.json");
    assert.equal(matrix.provenance, "assumed", JSON.stringify(opts));
    for (const row of matrix.rows) {
      for (const cell of Object.values(row.cells)) {
        assert.notEqual(cell.armable, true, JSON.stringify(opts) + " armed " + row.classId);
      }
    }
  }
});

test("an elicited or forensic row may arm later, which is what makes provenance load-bearing", () => {
  for (const provenance of ["elicited", "forensic"]) {
    const root = project({});
    planOnly(root, ALL_FOUR, { provenance });
    const cells = readJson(root, ".jig/plan.json").rows.flatMap((r) => Object.values(r.cells));
    assert.ok(cells.some((c) => c.armable === true), provenance + " armed nothing");
    assert.equal(cells.some((c) => c.armable === false), false);
  }
});

test("only a hook detector raises the arming question at all", () => {
  const root = project({});
  planOnly(root, ALL_FOUR, { provenance: "elicited" });
  for (const row of readJson(root, ".jig/plan.json").rows) {
    const cls = classOf(row.classId);
    for (const [actor, cell] of Object.entries(row.cells)) {
      if (cell.armable === null) continue;
      const det = cls.detectors.find((d) => d.actor === actor && d.lever === cell.lever);
      assert.ok(engine.HOOK_RUNNERS.includes(det.runner), row.classId + "/" + actor + " is not a hook");
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

// ---------------------------------------------------------------------------
// plan.md and plan.json describe the same matrix
// ---------------------------------------------------------------------------

function tableRows(md) {
  return md.split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.slice(1, -1).split(" | ").map((s) => s.trim()));
}

test("every cell in plan.json is rendered verbatim in plan.md", () => {
  const root = project({});
  planOnly(root, ALL_FOUR, { provenance: "elicited" });
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
  const root = project({});
  planOnly(root, ALL_FOUR);
  const md = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
  const header = md.split("\n").find((l) => l.startsWith("| class |"));
  assert.deepEqual(header.slice(1, -1).split(" | ").map((s) => s.trim()), ["class", "provenance", ...catalogue.actors]);
});

test("both files name the same plan, so a review can be tied to the transaction it reviews", () => {
  const root = project({});
  const plan = planOnly(root, ALL_FOUR);
  const matrix = readJson(root, ".jig/plan.json");
  assert.equal(matrix.planId, plan.planId);
  assert.ok(fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8").includes("# jig plan " + plan.planId));
});

test("the stamped classes and the unverifiable artifacts both reach the rendered page", () => {
  const root = project({});
  planOnly(root, ALL_FOUR);
  const md = fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8");
  const matrix = readJson(root, ".jig/plan.json");
  assert.deepEqual(matrix.enforcementGaps.sort(), [".github/workflows/jig.yml", ".jig/activation.md", ".jig/hooks/pre-commit"]);
  for (const p of matrix.enforcementGaps) assert.ok(md.includes("`" + p + "`"), p + " is not on the page");
  for (const row of matrix.rows.filter((r) => r.enforcementGap)) {
    assert.ok(md.includes("`" + row.classId + "` — no host-neutral deterministic lever"));
  }
});

test("a refusal reaches the review surface rather than being swallowed", () => {
  const root = project({ ".github/workflows/jig.yml": "name: someone else's\n" });
  const plan = planOnly(root, "silent-catch");
  assert.equal(plan.consent.item.length, 1);
  const matrix = readJson(root, ".jig/plan.json");
  assert.equal(matrix.refused.length, 1);
  assert.ok(fs.readFileSync(path.join(root, ".jig", "plan.md"), "utf-8").includes(matrix.refused[0]));
});

// ---------------------------------------------------------------------------
// Tiered consent
// ---------------------------------------------------------------------------

test("everything that can refuse something is approved one at a time", () => {
  const root = project({});
  const plan = planOnly(root, ALL_FOUR);
  const matrix = readJson(root, ".jig/plan.json");
  const item = matrix.artifacts.filter((a) => a.tier === "item");
  assert.deepEqual(item.map((a) => a.path).sort(), [".github/workflows/jig.yml", ".jig/config.json"]);
  assert.deepEqual(plan.consent.item.sort(), item.map((a) => a.id).sort());
  assert.match(item.find((a) => a.path === ".jig/config.json").why, /refuse a tool call/);
  assert.match(item.find((a) => a.path.startsWith(".github/")).why, /fails the build/);
});

test("everything that only reports is approved in one go", () => {
  const root = project({});
  planOnly(root, ALL_FOUR);
  const batch = readJson(root, ".jig/plan.json").artifacts.filter((a) => a.tier === "batch");
  assert.deepEqual(batch.map((a) => a.path).sort(), [
    ".jig/activation.md",
    ".jig/checks/focused-or-skipped-test.check.mjs",
    ".jig/checks/pipe-to-shell.check.mjs",
    ".jig/checks/run.mjs",
    ".jig/checks/silent-catch.check.mjs",
    ".jig/checks/test-file-deletion.check.mjs",
    ".jig/hooks/pre-commit",
    ".jig/proposed-permissions.json",
  ]);
  for (const a of batch) assert.match(a.why, /reports only, and refuses nothing/);
});

test("every artifact lands in exactly one tier and both lists cover the plan", () => {
  const root = project({});
  const plan = planOnly(root, ALL_FOUR);
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

test("every class the user did not take is written down", () => {
  const root = project({});
  planOnly(root, "silent-catch");
  const { schemaVersion, backlog } = readJson(root, ".jig/backlog.json");
  assert.equal(schemaVersion, 1);
  assert.deepEqual(
    backlog.map((b) => b.classId).sort(),
    catalogue.classes.map((c) => c.id).filter((id) => id !== "silent-catch").sort());
  assert.equal(new Set(backlog.map((b) => b.classId)).size, backlog.length);
});

test("a selected class is never also in the backlog", () => {
  const root = project({});
  planOnly(root, ALL_FOUR);
  const taken = new Set(ALL_FOUR.split(","));
  for (const row of readJson(root, ".jig/backlog.json").backlog) assert.equal(taken.has(row.classId), false);
});

test("the backlog says why each class is on it, and ranks what jig could do about it", () => {
  const root = project({});
  planOnly(root, ALL_FOUR);
  for (const row of readJson(root, ".jig/backlog.json").backlog) {
    const cls = classOf(row.classId);
    assert.equal(row.installableAtV1, cls.installableAtV1);
    assert.equal(row.enforcementGap, cls.enforcementGap);
    assert.ok(engine.CELL_RANK[row.best] !== undefined);
    assert.equal(row.reason, cls.installableAtV1 ? "not selected" : "ships as data at v1 — no lever jig can install for it yet");
  }
});

test("an installable class left out says so, rather than blaming the release", () => {
  const root = project({});
  planOnly(root, "silent-catch");
  const rows = readJson(root, ".jig/backlog.json").backlog.filter((b) => b.installableAtV1);
  assert.deepEqual(rows.map((b) => b.classId).sort(),
    ["focused-or-skipped-test", "pipe-to-shell", "test-file-deletion"]);
  for (const row of rows) assert.equal(row.reason, "not selected");
});

test("the count on the page is the count in the file", () => {
  const root = project({});
  planOnly(root, "silent-catch");
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
  const root = project({});
  const plan = planOnly(root, ALL_FOUR);
  assert.deepEqual(
    [plan.review, plan.matrix, plan.backlog],
    [".jig/plan.md", ".jig/plan.json", ".jig/backlog.json"]);
  for (const rel of [plan.review, plan.matrix, plan.backlog]) {
    assert.ok(fs.existsSync(path.join(root, rel)), rel + " was named but not written");
  }
  assert.equal(readJson(root, ".jig/plan.json").schemaVersion, engine.SCHEMA_VERSION);
});

test("a hand-written draft gets no review surface — there is no selection behind it", () => {
  const root = project({});
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
  const root = project({});
  const first = planOnly(root, "silent-catch");
  const second = planOnly(root, "pipe-to-shell");
  assert.notEqual(first.planId, second.planId);
  assert.equal(readJson(root, ".jig/plan.json").planId, second.planId);
  assert.deepEqual(readJson(root, ".jig/plan.json").selection, ["pipe-to-shell"]);
});

test("plan.json is a review, never mistaken for a transaction plan to apply", () => {
  const root = project({});
  const plan = planOnly(root, "silent-catch");
  assert.equal(readJson(root, ".jig/plan.json").kind, "review");
  assert.deepEqual(engine.planFiles(root).map((f) => path.basename(f)), ["plan-" + plan.planId + ".json"]);
});

test("the review surface is not an installed artifact, so revert leaves it where it is", () => {
  const root = project({});
  install(root, ALL_FOUR);
  engine.cmdRevert(root, { _: [], change: [], all: true });
  assert.equal(fs.existsSync(path.join(root, ".jig", "manifest.json")), false);
  for (const name of ["plan.md", "plan.json", "backlog.json"]) {
    assert.ok(fs.existsSync(path.join(root, ".jig", name)), name + " was reverted");
  }
});

test("the review surface never claims coverage the manifest does not hold", () => {
  const root = project({});
  install(root, ALL_FOUR, { provenance: "elicited" });
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
// The review surface and the arming cycle (0.2.0)

const GUARD = "silent-catch-edit-observe-guard";

function armProject() {
  const root = project({ "package.json": "{ \"private\": true }\n" });
  const plan = engine.cmdPlan(root, {
    _: [], change: [], select: "silent-catch", provenance: "elicited", "no-ci": true,
  });
  engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  return root;
}

function seedSessions(root, n) {
  const rows = Array.from({ length: n }, (_, i) =>
    JSON.stringify({ session: "s" + i, guardId: GUARD, decision: "pass" }));
  fs.appendFileSync(path.join(root, ".jig", "ledger.jsonl"), rows.join("\n") + "\n");
}

function configRow(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, ".jig", "config.json"), "utf-8"));
  return config.guards.find((g) => g.id === GUARD);
}

test("review names the barrier while the gate is unmet, and arm refuses with the same words", () => {
  const root = armProject();
  const review = engine.cmdReview(root);
  const row = review.guards.find((g) => g.guardId === GUARD);
  assert.equal(row.provenance, "elicited");
  assert.equal(row.mode, "observe");
  assert.equal(row.armable, false);
  assert.match(row.barrier, /0 of 10/);
  assert.throws(() => engine.cmdArm(root, { _: [], change: [], guard: GUARD }),
    /arming gate is not met.*0 of 10/s);
});

test("ten clean sessions arm the guard through a journaled config change", () => {
  const root = armProject();
  seedSessions(root, 10);
  assert.equal(engine.cmdReview(root).guards.find((g) => g.guardId === GUARD).armable, true);

  const journalBefore = engine.readJournal(root).length;
  const armed = engine.cmdArm(root, { _: [], change: [], guard: GUARD });
  assert.equal(armed.ok, true);
  assert.equal(configRow(root).mode, "armed");
  assert.equal(configRow(root).provenance, "elicited");
  assert.ok(engine.readJournal(root).length > journalBefore, "the arm was not journaled");

  const review = engine.cmdReview(root);
  assert.equal(review.guards.find((g) => g.guardId === GUARD).mode, "armed");
});

test("a recorded false positive resets the gate, and disarm returns the guard to observe", () => {
  const root = armProject();
  seedSessions(root, 10);
  engine.cmdArm(root, { _: [], change: [], guard: GUARD });

  const fp = engine.cmdFp(root, { _: [], change: [], guard: GUARD });
  assert.equal(fp.recorded, "false-positive");
  const review = engine.cmdReview(root);
  const row = review.guards.find((g) => g.guardId === GUARD);
  assert.equal(row.wavedOff, 1);
  assert.equal(row.mode, "observe", "the false positive did not pull the guard back to observe");
  assert.match(row.why, /false positive reset/);

  engine.cmdDisarm(root, { _: [], change: [], guard: GUARD });
  assert.equal(configRow(root).mode, undefined);
});

test("an assumed install can never reach arm, and the refusal says so", () => {
  const root = project({ "package.json": "{ \"private\": true }\n" });
  const plan = engine.cmdPlan(root, { _: [], change: [], select: "silent-catch", "no-ci": true });
  engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  seedSessions(root, 50);
  assert.throws(() => engine.cmdArm(root, { _: [], change: [], guard: GUARD }),
    /assumed.*never arm/s);
});

// ---------------------------------------------------------------------------
// Toolchain levers (0.3.0) — the repo's own tools, side-files, never a download

test("a repo carrying eslint gets the side-file, the wiring line, and a DET ci cell", () => {
  const root = project({
    "package.json": "{ \"private\": true }\n",
    "node_modules/eslint/package.json": "{ \"name\": \"eslint\" }\n",
  });
  const plan = engine.cmdPlan(root, {
    _: [], change: [], select: "silent-catch,focused-or-skipped-test", provenance: "elicited", "no-ci": true,
  });
  assert.equal(plan.toolchain.included.length, 1);
  assert.equal(plan.toolchain.included[0].tool, "eslint");
  assert.match(plan.toolchain.included[0].wiring, /lint:jig/);
  assert.ok(plan.changes.some((c) => c.path === ".jig/eslint.jig.config.mjs"));

  const matrix = readJson(root, ".jig/plan.json");
  const sc = matrix.rows.find((r) => r.classId === "silent-catch");
  assert.equal(sc.cells["human-ci"].grade, "DET");
  assert.equal(sc.cells["human-ci"].artifact, ".jig/eslint.jig.config.mjs");
});

test("an absent tool is a named note that says jig never downloads, and the cell stays honest", () => {
  const root = project({ "package.json": "{ \"private\": true }\n" });
  const plan = engine.cmdPlan(root, {
    _: [], change: [], select: "silent-catch", provenance: "elicited", "no-ci": true,
  });
  assert.equal(plan.toolchain.included.length, 0);
  const absent = plan.toolchain.absent.map((t) => t.tool).sort();
  assert.deepEqual([...new Set(absent)], ["detekt", "eslint"]);
  for (const row of plan.toolchain.absent) assert.match(row.why, /never downloads/);
  assert.equal(plan.changes.some((c) => c.path.startsWith(".jig/eslint")), false);
  const sc = readJson(root, ".jig/plan.json").rows.find((r) => r.classId === "silent-catch");
  assert.equal(sc.cells["human-ci"].grade, "GAP");
});

test("a Kotlin-Gradle repo carrying detekt gets the detekt side-file and a DET ci cell", () => {
  const root = project({
    "build.gradle.kts": 'plugins { id("io.gitlab.arturbosch.detekt") version "1.23.6" }\n',
  });
  const plan = engine.cmdPlan(root, {
    _: [], change: [], select: "silent-catch", provenance: "forensic", "no-ci": true,
  });
  assert.deepEqual(plan.toolchain.included.map((t) => t.tool), ["detekt"]);
  assert.ok(plan.changes.some((c) => c.path === ".jig/detekt.jig.yml"));

  engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  const sc = readJson(root, ".jig/plan.json").rows.find((r) => r.classId === "silent-catch");
  assert.equal(sc.cells["human-ci"].grade, "DET");
  assert.equal(sc.cells["human-ci"].artifact, ".jig/detekt.jig.yml");
  // A yml side-file cannot be read back without a dependency, so it is a
  // stamped gap — D17 the same way activation.md is.
  assert.ok(plan.enforcementGaps.includes(".jig/detekt.jig.yml"));
});

// ---------------------------------------------------------------------------
// Prose emission (0.4.0) — budgeted, labeled, on request only

test("prose is emitted only on request, lands under jig- names, and reverts clean", () => {
  const root = project({ "package.json": "{ \"private\": true }\n" });
  const bare = planOnly(root, "silent-catch", { "no-ci": true });
  assert.equal(bare.changes.some((c) => c.kind === "write-rule"), false,
    "a default install emitted prose");

  const plan = engine.cmdPlan(root, {
    _: [], change: [], select: "silent-catch", "no-ci": true,
    prose: "env-read-at-use-site,implicit-clock", provenance: "elicited",
  });
  const rules = plan.changes.filter((c) => c.path.startsWith(".claude/rules/"));
  assert.deepEqual(rules.map((c) => c.path).sort(),
    [".claude/rules/jig-env-read.md", ".claude/rules/jig-implicit-clock.md"]);

  engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  const text = fs.readFileSync(path.join(root, ".claude/rules/jig-env-read.md"), "utf-8");
  assert.match(text, /generated by jig/);
  assert.match(text, /evidence:/);

  engine.cmdRevert(root, { _: [], change: [], all: true });
  assert.equal(fs.existsSync(path.join(root, ".claude", "rules", "jig-env-read.md")), false);
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
  const root = project({
    "CLAUDE.md": "# House\n",
    "SCOPE.md": "# Scope\n",
    "docs/adr/0001-x.md": "# ADR\n",
  });
  engine.cmdScan(root, { _: [], change: [] });
  const plan = engine.cmdPlan(root, {
    _: [], change: [], select: "silent-catch", "no-ci": true,
    "wire-governance": true, provenance: "elicited",
  });
  const rule = plan.changes.find((c) => c.path === ".claude/rules/jig-governance.md");
  assert.ok(rule, "no governance rule was planned");
  engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  const text = fs.readFileSync(path.join(root, ".claude/rules/jig-governance.md"), "utf-8");
  assert.match(text, /SCOPE\.md/);
  assert.match(text, /docs\/adr\/0001-x\.md/);
  assert.match(text, /generated by jig/);

  const clean = project({ "CLAUDE.md": "read SCOPE.md\n", "SCOPE.md": "# Scope\n" });
  engine.cmdScan(clean, { _: [], change: [] });
  assert.throws(() => engine.cmdPlan(clean, {
    _: [], change: [], select: "silent-catch", "no-ci": true, "wire-governance": true,
  }), /no orphaned governance docs/);
});

// ---------------------------------------------------------------------------
// The re-run regimen (0.5.0)

test("rerun reports drift, the firing record, the quiet guards and the backlog in one read", () => {
  const root = project({ "package.json": "{ \"private\": true }\n" });
  install(root, "silent-catch,focused-or-skipped-test", { provenance: "elicited", "no-ci": true });

  fs.appendFileSync(path.join(root, ".jig", "ledger.jsonl"),
    JSON.stringify({ session: "s1", guardId: GUARD, decision: "would-deny" }) + "\n");
  fs.appendFileSync(path.join(root, ".jig", "checks", "run.mjs"), "\n// drifted\n");

  const report = engine.cmdRerun(root);
  assert.ok(report.installedAt, "no install timestamp");
  assert.deepEqual(report.drifted, [".jig/checks/run.mjs"]);
  const quiet = report.guards.find((g) => g.guardId === "focused-or-skipped-test-edit-observe-guard");
  assert.equal(quiet.fired, 0);
  assert.ok(report.neverFired.includes("focused-or-skipped-test-edit-observe-guard"));
  assert.equal(report.neverFired.includes(GUARD), false, "a fired guard was called dead");
  assert.ok(report.backlog.length > 0);
});

test("retiring a guard is a journaled config change the ledger survives", () => {
  const root = project({ "package.json": "{ \"private\": true }\n" });
  install(root, "silent-catch", { provenance: "elicited", "no-ci": true });
  const before = engine.readJournal(root).length;

  const out = engine.cmdRetire(root, { _: [], change: [], guard: GUARD });
  assert.equal(out.retired, GUARD);
  const config = readJson(root, ".jig/config.json");
  assert.equal(config.guards.some((g) => g.id === GUARD), false);
  assert.ok(engine.readJournal(root).length > before);
  assert.throws(() => engine.cmdRetire(root, { _: [], change: [], guard: GUARD }), /not a configured guard/);
});

test("rerun on a bare repository refuses with the reason", () => {
  const root = project({});
  assert.throws(() => engine.cmdRerun(root), /nothing is installed here/);
});
