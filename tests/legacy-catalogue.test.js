"use strict";

// The frozen 1.0.1 catalogue, and what still depends on it.
//
// This file no longer describes anything jig ships from — the six editions under
// `catalogues/` do that. What it describes is the input `scripts/migrate.js`
// reads when it upgrades an install made before the rework: the class rows, the
// deny triple each guard shipped with, and the fixture pair its patterns were
// proven against. `installableAtV1` and the rest of the 1.0.1 vocabulary are
// asserted here because a migration reads them, not because anything gates on
// them any more.
//
// It is frozen. If a test here fails, either the file was edited (it should not
// be) or migration stopped reading something it needs.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const CATALOGUE_PATH = path.join(__dirname, "..", "scripts", "legacy", "catalogue-1.0.1.json");
const REPO_ROOT = path.join(__dirname, "..", "..");
const REFERENCE = path.join(__dirname, "..", "skills", "jig", "references", "catalogues.md");

const raw = fs.readFileSync(CATALOGUE_PATH, "utf-8");
const catalogue = JSON.parse(raw);

const INSTALLABLE_AT_V1 = [
  "focused-or-skipped-test",
  "silent-catch",
  "pipe-to-shell",
  "test-file-deletion",
];

function hasHostNeutralDeterministic(cls) {
  return cls.detectors.some(
    (d) => catalogue.levers[d.lever].hostNeutral && d.confidence === "deterministic",
  );
}

// ---------------------------------------------------------------------------
// Schema discipline

test("catalogue ships at schemaVersion 1", () => {
  assert.equal(catalogue.schemaVersion, 1);
});

test("catalogue carries a verified-on date", () => {
  assert.match(catalogue.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
});

test("the closed vocabularies are all present", () => {
  assert.deepEqual(catalogue.axes, ["human", "agent"]);
  assert.deepEqual(catalogue.actors, [
    "human-editor",
    "human-ci",
    "claude-session",
    "codex-session",
  ]);
  assert.deepEqual(catalogue.severities, ["hygiene", "safety"]);
  assert.deepEqual(catalogue.confidences, ["deterministic", "heuristic"]);
  assert.deepEqual(catalogue.evidenceTiers, [
    "experiment-supported",
    "documented",
    "inherited",
    "reasoned",
  ]);
});

test("every lever declares hostNeutral, probabilistic and availableAt", () => {
  const levers = Object.entries(catalogue.levers);
  assert.ok(levers.length > 0);
  for (const [id, lever] of levers) {
    assert.equal(typeof lever.hostNeutral, "boolean", `${id}.hostNeutral`);
    assert.equal(typeof lever.probabilistic, "boolean", `${id}.probabilistic`);
    assert.ok(lever.availableAt, `${id}.availableAt`);
    assert.ok(lever.description, `${id}.description`);
  }
});

// ---------------------------------------------------------------------------
// Class rows

test("class ids are unique", () => {
  const ids = catalogue.classes.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every class carries the full row shape", () => {
  for (const cls of catalogue.classes) {
    assert.ok(cls.id, "id");
    assert.ok(cls.title, `${cls.id}.title`);
    assert.ok(Array.isArray(cls.axes) && cls.axes.length > 0, `${cls.id}.axes`);
    for (const axis of cls.axes) assert.ok(catalogue.axes.includes(axis), `${cls.id} axis ${axis}`);
    assert.ok(Array.isArray(cls.agentModes), `${cls.id}.agentModes`);
    assert.ok(catalogue.severities.includes(cls.severity), `${cls.id}.severity`);
    assert.equal(typeof cls.installableAtV1, "boolean", `${cls.id}.installableAtV1`);
    assert.equal(typeof cls.enforcementGap, "boolean", `${cls.id}.enforcementGap`);
    assert.ok(cls.detectors.length > 0, `${cls.id}.detectors`);
    assert.ok(cls.gapNotes, `${cls.id}.gapNotes`);
  }
});

test("an agent-axis class says how an agent produces it", () => {
  for (const cls of catalogue.classes) {
    if (!cls.axes.includes("agent")) {
      assert.equal(cls.agentModes.length, 0, `${cls.id} is human-only but names agent modes`);
      continue;
    }
    assert.ok(cls.agentModes.length > 0, `${cls.id} has an agent axis and no agent modes`);
  }
});

test("every detector names a known actor, lever, runner and confidence", () => {
  for (const cls of catalogue.classes) {
    for (const d of cls.detectors) {
      const where = `${cls.id}/${d.lever}`;
      assert.ok(catalogue.actors.includes(d.actor), `${where} actor ${d.actor}`);
      assert.ok(catalogue.levers[d.lever], `${where} lever`);
      assert.ok(catalogue.runners.includes(d.runner), `${where} runner ${d.runner}`);
      assert.ok(catalogue.confidences.includes(d.confidence), `${where} confidence`);
      assert.equal(typeof d.params, "object", `${where} params`);
      assert.notEqual(d.params, null, `${where} params`);
    }
  }
});

test("every regex in a detector compiles", () => {
  for (const cls of catalogue.classes) {
    for (const d of cls.detectors) {
      for (const p of d.params.patterns || []) {
        assert.doesNotThrow(() => new RegExp(p), `${cls.id}: ${p}`);
      }
      for (const p of d.params.pathPatterns || []) {
        assert.equal(typeof p, "string", `${cls.id} pathPattern`);
      }
    }
  }
});

test("every class discloses an evidence tier and the generation that judged it", () => {
  for (const cls of catalogue.classes) {
    assert.ok(catalogue.evidenceTiers.includes(cls.evidence.tier), `${cls.id}.evidence.tier`);
    assert.ok(cls.evidence.generation, `${cls.id}.evidence.generation`);
  }
});

test("nothing claims to be experiment-supported, because nothing was measured", () => {
  const measured = catalogue.classes.filter((c) => c.evidence.tier === "experiment-supported");
  assert.deepEqual(measured, []);
});

// ---------------------------------------------------------------------------
// The dual-axis spine

test("the full spine ships: fifteen human-axis classes and seven agent-only", () => {
  const human = catalogue.classes.filter((c) => c.axes.includes("human"));
  const agentOnly = catalogue.classes.filter((c) => !c.axes.includes("human"));
  assert.equal(human.length, 15);
  assert.equal(agentOnly.length, 7);
});

test("both axes are represented among the installable four", () => {
  const installable = catalogue.classes.filter((c) => c.installableAtV1);
  assert.ok(installable.some((c) => c.axes.includes("human")));
  assert.ok(installable.some((c) => c.axes.includes("agent")));
});

// ---------------------------------------------------------------------------
// The installable four

test("exactly four classes are installable at v1, and they are the named four", () => {
  const installable = catalogue.classes.filter((c) => c.installableAtV1).map((c) => c.id);
  assert.equal(installable.length, 4);
  assert.deepEqual([...installable].sort(), [...INSTALLABLE_AT_V1].sort());
});

test("test-file-deletion detects via the staged-deletion diff", () => {
  const cls = catalogue.classes.find((c) => c.id === "test-file-deletion");
  const staged = cls.detectors.find((d) => Array.isArray(d.params.command));
  assert.deepEqual(staged.params.command, [
    "git",
    "diff",
    "--cached",
    "--diff-filter=D",
    "--name-only",
  ]);
  assert.equal(staged.confidence, "deterministic");
});

test("the force-push pattern excludes --force-with-lease", () => {
  const cls = catalogue.classes.find((c) => c.id === "pipe-to-shell");
  const forcePush = cls.detectors.find((d) =>
    (d.params.patterns || []).some((p) => p.includes("git")),
  );
  const [pattern] = forcePush.params.patterns;
  const re = new RegExp(pattern);
  assert.ok(re.test("git push --force origin main"));
  assert.ok(re.test("git push -f origin main"));
  assert.equal(re.test("git push --force-with-lease origin feature/parser"), false);
});

// ---------------------------------------------------------------------------
// Fixtures

test("every installable class pairs a violation fixture with a near-miss fixture", () => {
  for (const cls of catalogue.classes.filter((c) => c.installableAtV1)) {
    assert.ok(cls.fixtures, `${cls.id} has no fixtures`);
    assert.ok(cls.fixtures.kind, `${cls.id}.fixtures.kind`);
    assert.ok(cls.fixtures.violation.length > 0, `${cls.id} has no violation fixture`);
    assert.ok(cls.fixtures.nearMiss.length > 0, `${cls.id} has no near-miss fixture`);
  }
});

test("every fixture path names a file that exists", () => {
  for (const cls of catalogue.classes) {
    if (!cls.fixtures) continue;
    for (const rel of [...cls.fixtures.violation, ...cls.fixtures.nearMiss]) {
      const full = path.join(REPO_ROOT, rel);
      assert.ok(fs.existsSync(full), `${cls.id}: missing fixture ${rel}`);
      assert.ok(fs.readFileSync(full, "utf-8").trim().length > 0, `${cls.id}: empty fixture ${rel}`);
    }
  }
});

test("a class that ships no detector of its own ships no fixtures", () => {
  for (const cls of catalogue.classes.filter((c) => !c.installableAtV1)) {
    assert.equal(cls.fixtures, null, `${cls.id} is not installable but carries fixtures`);
  }
});

test("fixtures live under the fixture root that suppresses newline normalisation", () => {
  const attrs = fs.readFileSync(path.join(__dirname, "fixtures", ".gitattributes"), "utf-8");
  assert.match(attrs, /^\* -text$/m);
  for (const cls of catalogue.classes) {
    if (!cls.fixtures) continue;
    for (const rel of [...cls.fixtures.violation, ...cls.fixtures.nearMiss]) {
      assert.ok(rel.startsWith("jig/tests/fixtures/"), `${cls.id}: ${rel} sits outside the root`);
    }
  }
});

// ---------------------------------------------------------------------------
// The plan floor, as data

test("enforcementGap is computed, never asserted", () => {
  for (const cls of catalogue.classes) {
    assert.equal(
      cls.enforcementGap,
      !hasHostNeutralDeterministic(cls),
      `${cls.id}: stamp disagrees with its own detectors`,
    );
  }
});

test("an installable class without a host-neutral deterministic lever carries the stamp in prose", () => {
  for (const cls of catalogue.classes.filter((c) => c.installableAtV1 && c.enforcementGap)) {
    assert.match(cls.gapNotes, /ENFORCEMENT GAP/, `${cls.id}: stamped in data, silent in prose`);
  }
});

test("three of the installable four clear the floor without a stamp", () => {
  const clear = catalogue.classes.filter((c) => c.installableAtV1 && !c.enforcementGap);
  assert.deepEqual(
    clear.map((c) => c.id).sort(),
    ["focused-or-skipped-test", "silent-catch", "test-file-deletion"],
  );
});

test("no detector claims v1 coverage through a lever that does not exist yet", () => {
  for (const cls of catalogue.classes.filter((c) => c.installableAtV1)) {
    const v1 = cls.detectors.filter(
      (d) => catalogue.levers[d.lever].availableAt === "0.1.0-alpha",
    );
    assert.ok(v1.length > 0, `${cls.id} is installable with no lever available at v1`);
  }
});

test("the Codex column is real from 0.5.0: every installable class carries an agents-region detector", () => {
  for (const cls of catalogue.classes) {
    const codex = cls.detectors.filter((d) => d.actor === "codex-session");
    if (cls.installableAtV1) {
      assert.equal(codex.length, 1, cls.id + " has no codex-session detector");
      assert.equal(codex[0].lever, "agents-region");
      // Honest by construction: a region a session READS is instructions, and
      // instructions are probabilistic — never deterministic, never armable.
      assert.equal(codex[0].confidence, "heuristic");
      assert.equal(codex[0].runner, "none");
    } else {
      assert.deepEqual(codex, [], cls.id + " gained a codex detector nothing installs");
    }
  }
  assert.equal(catalogue.levers["agents-region"].probabilistic, true);
});

// ---------------------------------------------------------------------------
// The human-readable companion

test("the reference file exists and states its verified-on date", () => {
  const md = fs.readFileSync(REFERENCE, "utf-8");
  assert.ok(md.includes(`Verified on ${catalogue.verifiedOn}`));
});

test("the reference file names every installable class", () => {
  const md = fs.readFileSync(REFERENCE, "utf-8");
  for (const id of INSTALLABLE_AT_V1) {
    assert.ok(md.includes(id), `reference never mentions ${id}`);
  }
});

// ---------------------------------------------------------------------------
// Stable detector ids
//
// Guard identity is `<classId>-<detectorId>` in the generated config, the
// manifest, the ledger and the matrix. The id is what survives a reorder of a
// class's detectors array — which is the whole reason it exists.

test("every detector carries a kebab-case id, unique within its class", () => {
  for (const cls of catalogue.classes) {
    const ids = cls.detectors.map((d) => d.id);
    for (const id of ids) {
      assert.equal(typeof id, "string", `${cls.id} has a detector with no id`);
      assert.match(id, /^[a-z][a-z0-9-]*$/, `${cls.id} detector id "${id}" is not kebab-case`);
    }
    assert.equal(new Set(ids).size, ids.length, `${cls.id} has duplicate detector ids`);
  }
});

// ---------------------------------------------------------------------------
// Activation lines and command presets (0.2.0)

test("both activation lines carry their marker, and the node one parses as JavaScript", () => {
  for (const key of ["sh", "node"]) {
    const entry = catalogue.activation[key];
    assert.ok(entry.line.includes(entry.marker), key + ": the marker is not in the line");
    assert.ok(entry.note && entry.note.length > 20, key + " has no note");
  }
  const { spawnSync } = require("child_process");
  const os = require("os");
  const tmp = path.join(os.tmpdir(), "jig-activation-check.js");
  fs.writeFileSync(tmp, catalogue.activation.node.line + "\n");
  const run = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf-8", windowsHide: true });
  fs.rmSync(tmp, { force: true });
  assert.equal(run.status, 0, "the node activation line does not parse: " + run.stderr);
});

test("every command preset is an argv array of plain strings, never a shell string", () => {
  const { presets, windowsNote } = catalogue.commandPresets;
  assert.match(windowsNote, /shell:true/);
  for (const [id, byStack] of Object.entries(presets)) {
    for (const [stack, argv] of Object.entries(byStack)) {
      assert.ok(Array.isArray(argv) && argv.length > 0, id + "/" + stack + " is not an argv array");
      for (const word of argv) {
        assert.equal(typeof word, "string");
        assert.equal(/\s/.test(word), false, id + "/" + stack + " smuggles a shell string: " + word);
      }
      assert.notEqual(argv[0], "sh");
      assert.notEqual(argv[1], "-c");
    }
  }
});
