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
  assert.equal(python.classes.length, 29);
  assert.equal(editions.loadEdition(PLUGIN_ROOT, "python"), python);
});

test("every shipped edition loads and matches its declared class count", () => {
  for (const row of index.editions) {
    const edition = editions.loadEdition(PLUGIN_ROOT, row.id);
    assert.equal(edition.edition, row.id);
    assert.equal(edition.classes.length, row.classCount, row.id + " class count");
  }
});

test("every shipped edition states what its projects never commit", () => {
  for (const row of index.editions) {
    const edition = editions.loadEdition(PLUGIN_ROOT, row.id);
    const ignore = edition.detect.ignore;
    assert.ok(Array.isArray(ignore) && ignore.length, row.id + " states no detect.ignore");
    for (const line of ignore) {
      assert.equal(typeof line, "string", row.id + " ignore entry is not a string");
      assert.equal(line.trim(), line, row.id + " ignore entry is padded: " + JSON.stringify(line));
      assert.ok(line !== "", row.id + " ignore entry is empty");
    }
  }
});

// The lint config jig ships is the first thing it runs on a fresh project, and
// it used to lint `.jig/checks/*.mjs` — files jig itself had just written, none
// of them in the tsconfig — and fail on a clean tree.
test("the eslint sample ignores jig's own files and installs the typescript its config needs", () => {
  const js = editions.loadEdition(PLUGIN_ROOT, "javascript-typescript");
  const eslint = js.toolchain.find((t) => t.id === "eslint");
  assert.match(eslint.configSample, /'\.jig\/\*\*'/, eslint.configSample);
  assert.match(eslint.configSample, /'\*\.config\.\{js,mjs,cjs,ts,mts,cts\}'/, eslint.configSample);
  // typescript-eslint resolves types through the typescript package, so a
  // ticked linter with no ticked type checker was red the moment it ran.
  for (const manager of Object.keys(eslint.install)) {
    assert.match(eslint.install[manager], /\btypescript\b/, manager + " install");
    assert.match(eslint.uninstall[manager], /\btypescript\b/, manager + " uninstall");
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

test("namespacing makes the 30 shared class ids unambiguous", () => {
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
  assert.equal(seen.size, 165);
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

// ---------------------------------------------------------------------------
// quickSelection
//
// `--quick` was prose in a skill and nothing computed it, so the selection had
// no recorded basis and the `assumed` provenance it plans under could not be
// checked. These pin the computation, not the wording.

test("quickSelection takes the head of the forensics ranking when history is usable", () => {
  const ranking = [
    { classId: "python/deleted-test", edition: "python", severity: "safety", hits: 9, basis: "forensics" },
    { classId: "python/softened-assertion", edition: "python", severity: "safety", hits: 2, basis: "forensics" },
    { classId: "python/broad-except", edition: "python", severity: "hygiene", hits: 0, basis: "catalogue" },
  ];
  const quick = editions.quickSelection({ editions: ["python"] }, { usable: true, fallback: null, ranking });
  assert.equal(quick.basis, "forensics");
  assert.equal(quick.considered, 3);
  assert.deepEqual(quick.classes.map((c) => c.classId), ranking.map((r) => r.classId));
  // The per-row basis survives, because a row forensics ranked by nothing is
  // not evidence and must not be presented as any.
  assert.deepEqual(quick.classes.map((c) => c.basis), ["forensics", "forensics", "catalogue"]);
  assert.deepEqual(quick.classes.map((c) => c.hits), [9, 2, 0]);
});

test("quickSelection falls back to tier then catalogue order, and names why", () => {
  const quick = editions.quickSelection({ editions: ["go"] }, { usable: false, fallback: "young-history", ranking: [] });
  assert.equal(quick.basis, "catalogue");
  assert.match(quick.why, /young-history/);
  const go = editions.loadEdition(PLUGIN_ROOT, "go");
  assert.equal(quick.considered, go.classes.length);
  // Safety before hygiene, and inside a tier the order the edition authored.
  const expected = go.classes
    .map((cls, i) => ({ id: "go/" + cls.id, safety: cls.severity === "safety", i }))
    .sort((a, b) => Number(b.safety) - Number(a.safety) || a.i - b.i)
    .slice(0, editions.QUICK_CAP)
    .map((r) => r.id);
  assert.deepEqual(quick.classes.map((c) => c.classId), expected);
  assert.ok(quick.classes.every((c) => c.basis === "catalogue" && c.hits === 0));
});

test("quickSelection caps the selection and states the cap", () => {
  const quick = editions.quickSelection({ editions: ["python", "go"] }, null);
  assert.equal(quick.cap, editions.QUICK_CAP);
  assert.equal(quick.classes.length, editions.QUICK_CAP);
  assert.ok(quick.considered > editions.QUICK_CAP, "the fallback ranked fewer classes than the cap");
  assert.match(quick.why, /it was never run/);
  assert.deepEqual(quick.editions, ["python", "go"]);
});

test("quickSelection selects nothing rather than guessing when no edition matched", () => {
  const quick = editions.quickSelection({ editions: [] }, { usable: false, fallback: "not-a-repository", ranking: [] });
  assert.deepEqual(quick.classes, []);
  assert.equal(quick.considered, 0);
});

test("quickSelection needs the profile", () => {
  assert.throws(() => editions.quickSelection(null, null), /needs the scan profile/);
});

// The ranking forensics returns spans every edition it could read. Taking its
// head unfiltered installed another language's classes while reporting the
// matched edition as the basis for them.
test("quickSelection ranks only inside the editions the scan matched", () => {
  const ranking = [
    { classId: "rust/unwrap-in-production", edition: "rust", severity: "safety", hits: 40, basis: "forensics" },
    { classId: "python/deleted-test", edition: "python", severity: "safety", hits: 9, basis: "forensics" },
    { classId: "python/broad-except", edition: "python", severity: "hygiene", hits: 3, basis: "forensics" },
  ];
  const quick = editions.quickSelection({ editions: ["python"] }, { usable: true, fallback: null, ranking });
  assert.deepEqual(quick.classes.map((c) => c.classId), ["python/deleted-test", "python/broad-except"]);
  assert.equal(quick.considered, 2, "a class from another edition was counted as considered");
  assert.deepEqual(quick.editions, ["python"]);
});

test("quickSelection selects nothing when the whole ranking is another edition's", () => {
  const ranking = [{ classId: "rust/unwrap-in-production", edition: "rust", severity: "safety", hits: 40 }];
  const quick = editions.quickSelection({ editions: [] }, { usable: true, fallback: null, ranking });
  assert.deepEqual(quick.classes, []);
  assert.equal(quick.basis, "catalogue", "an empty scoped ranking was still reported as evidence");
});

// ---------------------------------------------------------------------------
// The seed and the config that has to see it (2.9.0)
// ---------------------------------------------------------------------------

// The witnessed close plants a tool's own seed and runs the tool over it. A
// config that ignores where the seed lands makes that proof impossible: every
// JavaScript install ledgered `unverified` because eslint's `globalIgnores`
// named `.jig/**` and the probe planted under `.jig/selftest/`. The seed goes
// at the edition's stated path now, and these are the two shipped configs that
// have to keep looking there.
const JS = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "catalogues", "javascript-typescript.json"), "utf-8"));
const jsTool = (id) => JS.toolchain.find((t) => t.id === id);

test("eslint's shipped ignore list does not cover the tree its own seed lands in", () => {
  const eslint = jsTool("eslint");
  const ignores = /globalIgnores\(\[([^\]]*)\]\)/.exec(eslint.configSample);
  assert.ok(ignores, "the eslint sample no longer calls globalIgnores, so this test reads nothing");
  const dir = eslint.seed.path.split("/")[0];
  for (const glob of ignores[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean)) {
    assert.notEqual(glob.split("/")[0], dir,
      "eslint ignores " + glob + ", which is where its own seed " + eslint.seed.path + " is planted");
  }
});

test("tsconfig's shipped include covers the tree the typescript seed lands in", () => {
  const ts = jsTool("typescript");
  const include = /"include"\s*:\s*\[([^\]]*)\]/.exec(ts.configSample);
  assert.ok(include, "the tsconfig sample no longer carries an include, so this test reads nothing");
  const dirs = include[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  assert.ok(dirs.includes(ts.seed.path.split("/")[0]),
    "tsc compiles " + dirs.join(", ") + " and the seed is at " + ts.seed.path + ", so it is never read");
});

// The seed's whole point is to be seen by the project's own tool, and no shipped
// tool reads a jig state directory.
test("no shipped seed is planted inside jig's own state directory", () => {
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, "catalogues")).filter((f) => f.endsWith(".json"))) {
    const cat = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "catalogues", file), "utf-8"));
    for (const tool of cat.toolchain || []) {
      assert.equal(/^\.jig(\/|$)/.test(tool.seed.path), false, file + "/" + tool.id + " seeds under .jig/");
    }
  }
});

// ---------------------------------------------------------------------------
// The starter tree
//
// A project file on its own is not a project: cargo exits 101 on a `Cargo.toml`
// with no `src/lib.rs`. `detect.manifest.starter.files` is the rest of the
// smallest tree that builds, and every path in it is a byte jig writes into
// somebody's repository — so the shape is refused at load rather than at write.

function starterShelf(manifest) {
  return shelf(
    { schemaVersion: 3, editions: [{ id: "x", file: "x.json", detect: {} }] },
    { "x.json": { schemaVersion: 4, edition: "x", classes: [], detect: { manifest, packageManagers: ["npm"] } } },
  );
}

test("an edition offering starter files for a project file it does not write is refused at load", () => {
  const root = starterShelf({
    path: "go.mod", sample: null, hint: "run `go mod init <module path>` here",
    starter: { files: [{ path: "src/main.go", body: "package main\n" }] },
  });
  assert.throws(() => editions.loadEdition(root, "x"), /for a project file it does not write/);
});

test("a starter file that escapes the project is refused at load", () => {
  for (const rel of ["../.bashrc", "a/../../b", "/etc/profile", "C:/Windows/x", "src\\index.js"]) {
    const root = starterShelf({
      path: "package.json", sample: "{}\n", hint: null,
      starter: { files: [{ path: rel, body: "x\n" }] },
    });
    assert.throws(() => editions.loadEdition(root, "x"), /is not a relative path inside the project/, rel);
  }
});

test("a starter file with no body is refused at load", () => {
  const root = starterShelf({
    path: "package.json", sample: "{}\n", hint: null,
    starter: { files: [{ path: "src/index.js" }] },
  });
  assert.throws(() => editions.loadEdition(root, "x"), /must each carry a `path` and a `body`/);
});

// A starter file may belong to one tool rather than to the edition, because
// `node --test` and vitest read different files and neither can read the
// other's. An unreachable name would leave a file nobody ever writes and
// nobody ever hears about.
test("a starter file naming a tool the edition does not offer is refused at load", () => {
  const root = starterShelf({
    path: "package.json", sample: "{}\n", hint: null,
    starter: { files: [{ path: "tests/smoke.spec.js", body: "x\n", tool: "vitest" }] },
  });
  assert.throws(() => editions.loadEdition(root, "x"), /which this edition does not offer/);
});

// A starter body is generated content jig writes into somebody's repository,
// so it is under the same discipline as a template: the catalogue records the
// version and the hash of the bytes that version shipped, and a body edited
// without restamping both never reaches a plan.
test("a starter file with no version and sha256 is refused at load", () => {
  const root = starterShelf({
    path: "package.json", sample: "{}\n", hint: null,
    starter: { files: [{ path: "src/index.js", body: "x\n" }] },
  });
  assert.throws(() => editions.loadEdition(root, "x"), /carries no `version` and `sha256`/);
});

test("a starter body that does not match its recorded hash is refused at load", () => {
  const root = starterShelf({
    path: "package.json", sample: "{}\n", hint: null,
    starter: { files: [{ path: "src/index.js", body: "x\n", version: "1.0.0", sha256: "0".repeat(64) }] },
  });
  assert.throws(() => editions.loadEdition(root, "x"), /does not match the hash its catalogue recorded/);
});

test("the shipped JavaScript starter keeps one smoke test per runner", () => {
  const js = editions.loadEdition(PLUGIN_ROOT, "javascript-typescript");
  const starter = editions.manifestFor(js, "npm").starter;
  assert.deepEqual(starter.map((f) => f.path), ["src/index.js", "test/smoke.js", "tests/smoke.spec.js"]);
  // The node one is unconditional and invisible to vitest; the vitest one is
  // written only where vitest is, and `node --test` discovers neither `tests/`
  // nor a `.spec.` name.
  assert.equal(starter.find((f) => f.path === "test/smoke.js").tool, undefined);
  assert.equal(starter.find((f) => f.path === "tests/smoke.spec.js").tool, "vitest");
});

test("manifestFor hands back the starter tree, and an empty one where the edition declares none", () => {
  const rust = editions.loadEdition(PLUGIN_ROOT, "rust");
  assert.deepEqual(editions.manifestFor(rust, "cargo").starter.map((f) => f.path), ["src/lib.rs", "Cargo.lock"]);
  const go = editions.loadEdition(PLUGIN_ROOT, "go");
  assert.deepEqual(editions.manifestFor(go, "go").starter, []);
});
