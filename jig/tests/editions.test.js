"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const editions = require("../scripts/editions.js");

const PLUGIN_ROOT = path.join(__dirname, "..");

// A project tree built on disk, because detection reads a real directory by
// contract — every filesystem read takes an explicit root, so the tests give it
// real roots rather than mocking fs.
function project(tree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jig-editions-"));
  for (const [rel, body] of Object.entries(tree)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body === null ? "" : body);
  }
  return root;
}

// A hand-built plugin root, for the schema and shelf refusals that the shipped
// catalogue is (correctly) incapable of producing.
function shelf(indexRecord, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jig-shelf-"));
  fs.mkdirSync(path.join(root, "catalogues"));
  fs.writeFileSync(path.join(root, "catalogues", "index.json"), typeof indexRecord === "string"
    ? indexRecord
    : JSON.stringify(indexRecord));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, "catalogues", name), typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}

// ---------------------------------------------------------------------------
// loadIndex

test("loadIndex reads the shipped index", () => {
  const index = editions.loadIndex(PLUGIN_ROOT);
  assert.equal(index.schemaVersion, 3);
  assert.deepEqual(index.editions.map((e) => e.id).sort(), [
    "dotnet", "go", "javascript-typescript", "jvm", "python", "rust",
  ]);
});

test("loadIndex caches, returning the same object", () => {
  assert.equal(editions.loadIndex(PLUGIN_ROOT), editions.loadIndex(PLUGIN_ROOT));
});

test("loadIndex refuses a schemaVersion it does not know", () => {
  const root = shelf({ schemaVersion: 99, editions: [] });
  assert.throws(() => editions.loadIndex(root), /schemaVersion 99 and this loader reads 3/);
});

test("loadIndex refuses an older schemaVersion too", () => {
  const root = shelf({ schemaVersion: 1, editions: [{ id: "x", file: "x.json", detect: {} }] });
  assert.throws(() => editions.loadIndex(root), /schemaVersion 1 and this loader reads 3/);
});

test("loadIndex names the missing file rather than returning null", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jig-empty-"));
  assert.throws(() => editions.loadIndex(root), /the catalogue index is missing at .*index\.json/);
});

test("loadIndex refuses unreadable JSON", () => {
  const root = shelf("{ not json");
  assert.throws(() => editions.loadIndex(root), /is not readable JSON/);
});

test("loadIndex refuses an empty shelf and a malformed row", () => {
  assert.throws(() => editions.loadIndex(shelf({ schemaVersion: 3, editions: [] })), /lists no editions/);
  assert.throws(
    () => editions.loadIndex(shelf({ schemaVersion: 3, editions: [{ id: "x" }] })),
    /missing id, file or detect/,
  );
});

test("loadIndex refuses a missing root instead of guessing one", () => {
  assert.throws(() => editions.loadIndex(undefined), /needs an absolute path to the plugin root/);
});

// ---------------------------------------------------------------------------
// detectEditions

const index = editions.loadIndex(PLUGIN_ROOT);

test("detectEditions ranks the marker-file edition first", () => {
  const root = project({
    "go.mod": "module example.com/x\n",
    "go.sum": "",
    "cmd/main.go": "package main\n",
    "internal/util.go": "package internal\n",
  });
  const hits = editions.detectEditions(root, index);
  assert.equal(hits[0].id, "go");
  assert.deepEqual(hits[0].matchedFiles, ["go.mod", "go.sum"]);
  assert.equal(hits[0].matchedExtensions[".go"], 2);
  assert.ok(hits[0].score > 0);
});

test("detectEditions returns several entries for a polyglot repo, strongest first", () => {
  const root = project({
    "package.json": "{}",
    "tsconfig.json": "{}",
    "src/index.ts": "export const x = 1;\n",
    "svc/pyproject.toml": "[project]\n",
    "svc/app.py": "x = 1\n",
  });
  const hits = editions.detectEditions(root, index);
  const ids = hits.map((h) => h.id);
  assert.equal(ids[0], "javascript-typescript");
  assert.ok(ids.includes("python"), "python detected too: " + ids.join(","));
  assert.ok(hits[0].score > hits[1].score);
});

test("detectEditions counts extensions when no marker file exists", () => {
  const root = project({ "a.py": "x = 1\n", "b.py": "y = 2\n", "c.pyi": "x: int\n" });
  const hits = editions.detectEditions(root, index);
  assert.equal(hits[0].id, "python");
  assert.deepEqual(hits[0].matchedFiles, []);
  assert.deepEqual(hits[0].matchedExtensions, { ".py": 2, ".pyi": 1 });
});

test("detectEditions matches the star globs the dotnet edition uses", () => {
  const root = project({ "App/App.csproj": "<Project/>", "App/Program.cs": "class P {}" });
  const hits = editions.detectEditions(root, index);
  assert.equal(hits[0].id, "dotnet");
  assert.deepEqual(hits[0].matchedFiles, ["App/App.csproj"]);
});

test("detectEditions ignores vendored and build directories", () => {
  const root = project({
    "package.json": "{}",
    "node_modules/dep/go.mod": "module dep\n",
    "node_modules/dep/dep.go": "package dep\n",
    "target/build.rs": "fn main() {}\n",
  });
  const ids = editions.detectEditions(root, index).map((h) => h.id);
  assert.deepEqual(ids, ["javascript-typescript"]);
});

test("detectEditions returns [] when nothing matches", () => {
  const root = project({ "README.md": "# hi\n", "notes.txt": "hi\n" });
  assert.deepEqual(editions.detectEditions(root, index), []);
});

test("detectEditions is stable across runs over the same tree", () => {
  const root = project({ "go.mod": "", "main.go": "package main\n", "app.py": "x = 1\n" });
  assert.deepEqual(editions.detectEditions(root, index), editions.detectEditions(root, index));
});

test("detectEditions refuses an unreadable project root and a non-index", () => {
  assert.throws(
    () => editions.detectEditions(path.join(os.tmpdir(), "jig-does-not-exist-" + Date.now()), index),
    /could not be read/,
  );
  assert.throws(() => editions.detectEditions(project({}), { nope: true }), /needs the parsed catalogue index/);
});

// ---------------------------------------------------------------------------
// loadEdition / editionClass

test("loadEdition loads one edition and caches it", () => {
  const python = editions.loadEdition(PLUGIN_ROOT, "python");
  assert.equal(python.schemaVersion, 4);
  assert.equal(python.edition, "python");
  assert.equal(python.classes.length, 25);
  assert.equal(editions.loadEdition(PLUGIN_ROOT, "python"), python);
});

test("every shipped edition loads and matches its declared class count", () => {
  for (const row of index.editions) {
    const edition = editions.loadEdition(PLUGIN_ROOT, row.id);
    assert.equal(edition.edition, row.id);
    assert.equal(edition.classes.length, row.classCount, row.id + " class count");
  }
});

test("loadEdition refuses an unknown id and lists what it has", () => {
  assert.throws(() => editions.loadEdition(PLUGIN_ROOT, "cobol"), /no edition `cobol`.*python/s);
});

test("loadEdition refuses an edition whose schemaVersion it does not know", () => {
  const root = shelf(
    { schemaVersion: 3, editions: [{ id: "x", file: "x.json", detect: {} }] },
    { "x.json": { schemaVersion: 3, edition: "x", classes: [] } },
  );
  assert.throws(() => editions.loadEdition(root, "x"), /schemaVersion 3 and this loader reads 4/);
});

test("loadEdition refuses a file that disagrees with the index about its own id", () => {
  const root = shelf(
    { schemaVersion: 3, editions: [{ id: "x", file: "x.json", detect: {} }] },
    { "x.json": { schemaVersion: 4, edition: "y", classes: [] } },
  );
  assert.throws(() => editions.loadEdition(root, "x"), /calls itself `y`/);
});

test("editionClass finds a class and refuses one that is absent", () => {
  const go = editions.loadEdition(PLUGIN_ROOT, "go");
  assert.equal(editionClassId(go, "skipped-test"), "skipped-test");
  assert.throws(() => editions.editionClass(go, "not-a-class"), /has no class `not-a-class`/);
});

function editionClassId(edition, id) {
  return editions.editionClass(edition, id).id;
}

// ---------------------------------------------------------------------------
// adaptDetector

test("adaptDetector maps check-driver to the checks runner with a positional id", () => {
  const cls = { id: "softened-assertion" };
  const det = { lever: "check-driver", actor: "human-editor", confidence: "deterministic", params: { patterns: [] } };
  const out = editions.adaptDetector(cls, det, 0);
  assert.equal(out.runner, "checks");
  assert.equal(out.id, "check-driver-0");
  assert.equal(out.confidence, "deterministic");
  assert.deepEqual(out.params, det.params);
});

test("adaptDetector maps tool-rule to ci with an order-proof id", () => {
  const cls = { id: "softened-assertion" };
  const det = { lever: "tool-rule", actor: "human-ci", confidence: "deterministic", params: { tool: "ruff", rule: "PLR0124" } };
  assert.deepEqual(
    [editions.adaptDetector(cls, det, 1).id, editions.adaptDetector(cls, det, 7).id],
    ["tool-rule-ruff-PLR0124", "tool-rule-ruff-PLR0124"],
  );
  assert.equal(editions.adaptDetector(cls, det, 1).runner, "ci");
});

test("adaptDetector does not mutate the catalogue detector", () => {
  const det = { lever: "check-driver", params: {} };
  editions.adaptDetector({ id: "c" }, det, 0);
  assert.deepEqual(Object.keys(det), ["lever", "params"]);
});

test("adaptDetector refuses a lever this build does not run", () => {
  assert.throws(
    () => editions.adaptDetector({ id: "c" }, { lever: "agents-region" }, 0),
    /lever `agents-region`, which this build does not run/,
  );
});

test("adaptDetector refuses a tool-rule with no self-identity", () => {
  assert.throws(
    () => editions.adaptDetector({ id: "c" }, { lever: "tool-rule", params: { tool: "ruff" } }, 0),
    /no params\.tool or params\.rule/,
  );
});

test("adaptDetector refuses a positional id with no position", () => {
  assert.throws(
    () => editions.adaptDetector({ id: "c" }, { lever: "check-driver", params: {} }, undefined),
    /adaptDetector was called with index undefined/,
  );
});

test("every shipped detector adapts, and ids are unique inside a class", () => {
  let detectors = 0;
  for (const row of index.editions) {
    const edition = editions.loadEdition(PLUGIN_ROOT, row.id);
    for (const cls of edition.classes) {
      const ids = new Set();
      cls.detectors.forEach((det, i) => {
        const out = editions.adaptDetector(cls, det, i);
        assert.ok(["checks", "ci"].includes(out.runner));
        assert.ok(!ids.has(out.id), row.id + "/" + cls.id + " repeats detector id " + out.id);
        ids.add(out.id);
        detectors += 1;
      });
    }
  }
  assert.ok(detectors > 200, "adapted " + detectors + " detectors");
});

// ---------------------------------------------------------------------------
// namespacedId

test("namespacedId qualifies a class id by its edition", () => {
  assert.equal(editions.namespacedId("python", "swallowed-exception"), "python/swallowed-exception");
});

test("namespacing makes the 26 shared class ids unambiguous", () => {
  const seen = new Set();
  const bare = new Set();
  let shared = 0;
  for (const row of index.editions) {
    for (const cls of editions.loadEdition(PLUGIN_ROOT, row.id).classes) {
      if (bare.has(cls.id)) shared += 1;
      bare.add(cls.id);
      const id = editions.namespacedId(row.id, cls.id);
      assert.ok(!seen.has(id), "namespaced id collides: " + id);
      seen.add(id);
    }
  }
  assert.ok(shared > 0, "the editions do share class ids");
  assert.equal(seen.size, 141);
});

test("namespacedId refuses an empty half rather than producing `/x`", () => {
  assert.throws(() => editions.namespacedId("", "x"), /needs an edition id/);
  assert.throws(() => editions.namespacedId("python", null), /needs a class id/);
});

// ---------------------------------------------------------------------------
// commentSyntaxFor

test("commentSyntaxFor reads the edition's own map", () => {
  const python = editions.loadEdition(PLUGIN_ROOT, "python");
  const go = editions.loadEdition(PLUGIN_ROOT, "go");
  assert.equal(editions.commentSyntaxFor(python, ".py"), "hash");
  assert.equal(editions.commentSyntaxFor(go, ".go"), "slash");
  assert.equal(editions.commentSyntaxFor(go, ".sum"), "none");
});

test("commentSyntaxFor normalises a bare or upper-case extension", () => {
  const python = editions.loadEdition(PLUGIN_ROOT, "python");
  assert.equal(editions.commentSyntaxFor(python, "py"), "hash");
  assert.equal(editions.commentSyntaxFor(python, ".PY"), "hash");
});

test("commentSyntaxFor returns none for an extension the edition never claimed", () => {
  assert.equal(editions.commentSyntaxFor(editions.loadEdition(PLUGIN_ROOT, "python"), ".md"), "none");
});

test("every shipped edition declares a syntax in the closed set for every extension it detects", () => {
  for (const row of index.editions) {
    const edition = editions.loadEdition(PLUGIN_ROOT, row.id);
    for (const ext of row.detect.extensions) {
      assert.ok(
        ["hash", "slash", "none"].includes(editions.commentSyntaxFor(edition, ext)),
        row.id + " " + ext,
      );
    }
  }
});

test("commentSyntaxFor refuses an edition with no map and a bad value", () => {
  assert.throws(() => editions.commentSyntaxFor({ edition: "x", detect: {} }, ".py"), /declares no detect\.commentSyntax/);
  assert.throws(
    () => editions.commentSyntaxFor({ edition: "x", detect: { commentSyntax: { ".py": "semicolon" } } }, ".py"),
    /declares comment syntax `semicolon`/,
  );
  assert.throws(
    () => editions.commentSyntaxFor(editions.loadEdition(PLUGIN_ROOT, "go"), ""),
    /needs a file extension/,
  );
});
