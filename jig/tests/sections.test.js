"use strict";

// Composing several tools' configuration into the one file they share, and the
// greenfield path that depends on it.
//
// The bug this defends against is quiet by construction. Five python tools all
// name `pyproject.toml`; jig wrote each one as a whole-file change, every write
// succeeded, and the last one applied was the only configuration left on disk.
// Nothing failed, so nothing said anything. Two claims are therefore load
// bearing here: that a shared section file comes out composed, and that a
// shared file jig CANNOT compose is written by nobody rather than by whoever
// went last.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sections = require("../scripts/sections.js");
const engine = require("../scripts/jig.js");
const editions = require("../scripts/editions.js");

const PLUGIN_ROOT = path.join(__dirname, "..");
const CATALOGUES = path.join(PLUGIN_ROOT, "catalogues");
const roots = [];

test.after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jig-sections-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files || {})) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function planOf(root, opts) {
  return engine.cmdPlan(root, { _: [], change: [], path: [], provenance: "elicited", ...opts });
}

function pathsOf(plan, kind) {
  return plan.changes.filter((c) => !kind || c.kind === kind).map((c) => c.path);
}

// The bytes a change would write. The plan summary carries ids and paths; the
// plan FILE carries the content, which is what a claim about composition has
// to be checked against.
function bodyOf(root, plan, rel) {
  const written = JSON.parse(fs.readFileSync(path.join(root, plan.plan), "utf8"));
  const hit = written.changes.find((c) => c.path === rel && c.kind === "write-side-file");
  assert.ok(hit, "no write planned for " + rel);
  return hit.content;
}

// ---------------------------------------------------------------------------
// mergeable

test("mergeable names section files and nothing with a real grammar", () => {
  for (const yes of ["pyproject.toml", "Cargo.toml", ".editorconfig", "a/b/setup.cfg", "tox.ini"]) {
    assert.equal(sections.mergeable(yes), true, yes + " is a section file");
  }
  for (const no of ["go.mod", "build.gradle.kts", "Directory.Build.props", "package.json", "", null]) {
    assert.equal(sections.mergeable(no), false, String(no) + " is not one jig composes");
  }
});

// ---------------------------------------------------------------------------
// merge

test("merge keeps every block and every key from every source", () => {
  const { body, conflicts } = sections.merge([
    { source: "one", body: '[tool.a]\nx = 1\n\n[tool.b]\ny = 2\n' },
    { source: "two", body: '[tool.a]\nz = 3\n\n[tool.c]\nw = 4\n' },
  ], "pyproject.toml");
  assert.deepEqual(conflicts, []);
  assert.match(body, /\[tool\.a\]\nx = 1\nz = 3/);
  assert.match(body, /\[tool\.b\]\ny = 2/);
  assert.match(body, /\[tool\.c\]\nw = 4/);
  assert.equal(body.match(/\[tool\.a\]/g).length, 1, "the shared header appears once");
});

test("merge keeps the first value of a disputed key and reports what it dropped", () => {
  const { body, conflicts } = sections.merge([
    { source: "ruff", body: "[tool.x]\nline-length = 100\n" },
    { source: "black", body: "[tool.x]\nline-length = 88\n" },
  ], "pyproject.toml");
  assert.match(body, /line-length = 100/);
  assert.doesNotMatch(body, /88/);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(
    { key: conflicts[0].key, keptFrom: conflicts[0].keptFrom, droppedFrom: conflicts[0].droppedFrom, path: conflicts[0].path },
    { key: "line-length", keptFrom: "ruff", droppedFrom: "black", path: "pyproject.toml" },
  );
});

test("merge carries a multi-line value whole and is not fooled by a bracket in a string", () => {
  const { body } = sections.merge([
    { source: "one", body: '[tool.a]\nselect = [\n  "E",\n  "F",\n]\nafter = 1\n' },
    { source: "two", body: '[tool.a]\nnote = "a ] inside a string"\n' },
  ], "pyproject.toml");
  assert.match(body, /select = \[\n {2}"E",\n {2}"F",\n\]/);
  assert.match(body, /after = 1/);
  assert.match(body, /note = "a \] inside a string"/);
  assert.equal(body.match(/\[tool\.a\]/g).length, 1);
});

test("merge treats an array-of-tables header as its own block", () => {
  const { body } = sections.merge([
    { source: "one", body: "[[tool.mypy.overrides]]\nmodule = [\"tests.*\"]\n" },
    { source: "two", body: "[tool.mypy]\nstrict = true\n" },
  ], "pyproject.toml");
  assert.match(body, /\[\[tool\.mypy\.overrides\]\]/);
  assert.match(body, /\[tool\.mypy\]\nstrict = true/);
});

test("merge keeps a preamble key once and refuses a part with no body", () => {
  const { body } = sections.merge([
    { source: "one", body: "root = true\n\n[*.cs]\na = 1\n" },
    { source: "two", body: "root = true\n\n[*.cs]\nb = 2\n" },
  ], ".editorconfig");
  assert.equal(body.match(/root = true/g).length, 1);
  assert.match(body, /\[\*\.cs\]\na = 1\nb = 2/);
  assert.throws(() => sections.merge([{ source: "x" }], ".editorconfig"), /no body/);
  assert.throws(() => sections.merge([], ".editorconfig"), /at least one body/);
});

// ---------------------------------------------------------------------------
// The shipped shelf

test("release gate G5: every shared config file in every edition is composed or reported, never overwritten", () => {
  const index = editions.loadIndex(PLUGIN_ROOT);
  let sharedPaths = 0;
  for (const row of index.editions) {
    const edition = JSON.parse(fs.readFileSync(path.join(CATALOGUES, row.file), "utf8"));
    const byPath = new Map();
    for (const tool of edition.toolchain || []) {
      if (!tool.configPath) continue;
      if (!byPath.has(tool.configPath)) byPath.set(tool.configPath, []);
      byPath.get(tool.configPath).push(tool);
    }
    for (const [configPath, tools] of byPath) {
      if (tools.length < 2) continue;
      sharedPaths++;
      if (!sections.mergeable(configPath)) continue;
      const merged = sections.merge(tools.map((t) => ({ source: t.id, body: t.configSample })), configPath);
      // A conflict in shipped data is a research problem, not a runtime one:
      // two tools in one edition disagreeing about one key means somebody has
      // to decide which is right before the release goes out.
      assert.deepEqual(merged.conflicts, [],
        row.id + " tools disagree inside " + configPath + ": " +
          merged.conflicts.map((c) => c.key).join(", "));
      for (const tool of tools) {
        for (const line of tool.configSample.split("\n")) {
          const key = line.match(/^\s*[^\s#[][^=]*=/);
          if (!key) continue;
          assert.ok(merged.body.includes(line.trim()),
            row.id + " " + configPath + " lost " + tool.id + "'s line: " + line.trim());
        }
      }
    }
  }
  assert.ok(sharedPaths >= 5, "the shelf still has the shared paths this gate exists for: " + sharedPaths);
});

test("every shipped edition declares a project file jig can either write or explain", () => {
  for (const row of editions.loadIndex(PLUGIN_ROOT).editions) {
    const manifest = editions.manifestFor(editions.loadEdition(PLUGIN_ROOT, row.id));
    assert.equal(manifest.edition, row.id);
    assert.equal(Boolean(manifest.sample) !== Boolean(manifest.hint), true,
      row.id + " must offer a starter or a reason, not both and not neither");
    if (manifest.sample) assert.ok(manifest.path, row.id + " offers a sample with nowhere to write it");
  }
});

// ---------------------------------------------------------------------------
// The greenfield plan

test("a folder with no project in it plans the starter file before any install", () => {
  const root = project({});
  const plan = planOf(root, {
    edition: "python", "package-manager": "uv",
    tools: "ruff,ruff-format,mypy,pytest", select: "python/silenced-test",
  });
  const starter = plan.changes.find((c) => c.path === "pyproject.toml" && c.kind === "write-side-file");
  assert.ok(starter, "the starter pyproject.toml is planned: " + pathsOf(plan).join(", "));

  const installs = plan.changes.map((c, i) => ({ i, kind: c.kind })).filter((c) => c.kind === "run-install");
  const at = plan.changes.indexOf(starter);
  for (const install of installs) {
    assert.ok(at < install.i, "the project file is written before install " + install.i + " runs");
  }
  assert.equal(plan.greenfield.length, 1);
  assert.equal(plan.greenfield[0].edition, "python");
});

test("four python tools sharing pyproject.toml produce one composed file, not four", () => {
  const root = project({});
  const plan = planOf(root, {
    edition: "python", "package-manager": "uv",
    tools: "ruff,ruff-format,mypy,pytest", select: "python/silenced-test",
  });
  const writes = plan.changes.filter((c) => c.path === "pyproject.toml" && c.kind === "write-side-file");
  assert.equal(writes.length, 1, "one write for the shared file");
  assert.deepEqual(plan.configConflicts, []);

  // The proof the old code could not give: every tool's own section survives.
  const body = bodyOf(root, plan, "pyproject.toml");
  for (const header of ["[tool.ruff]", "[tool.ruff.format]", "[tool.mypy]", "[tool.pytest.ini_options]", "[project]"]) {
    assert.ok(body.includes(header), "the composed file kept " + header);
  }
});

test("a shared file jig cannot compose is written by nobody and handed back as snippets", () => {
  const root = project({ "App.csproj": "<Project></Project>\n" });
  const plan = planOf(root, {
    edition: "dotnet", "package-manager": "dotnet",
    tools: "csc,nuget-audit", select: "dotnet/swallowed-exception",
  });
  assert.equal(pathsOf(plan).includes("Directory.Build.props"), false, "jig writes none of it");
  assert.deepEqual(plan.configNotes.map((n) => n.tool).sort(), ["csc", "nuget-audit"]);
  for (const note of plan.configNotes) {
    assert.equal(note.path, "Directory.Build.props");
    assert.ok(note.snippet.includes("<Project>"), "the note carries the snippet to put in yourself");
  }
});

test("an edition that cannot be scaffolded refuses its installs once, with the sentence to act on", () => {
  const root = project({});
  const plan = planOf(root, {
    edition: "go", "package-manager": "go", tools: "go-vet,go-test", select: "go/skipped-test",
  });
  const hints = plan.refused.filter((r) => r.includes("go mod init"));
  assert.equal(hints.length, 1, "said once, not once per tool: " + JSON.stringify(plan.refused));
  assert.equal(pathsOf(plan, "run-install").length, 0, "nothing installs into a folder with no module in it");
});

test("a starter is written only for an edition the owner named", () => {
  // A pyproject.toml makes this repo match the rust edition too, because .toml
  // is one of rust's extensions. Detection must never conjure a Cargo.toml.
  const root = project({ "pyproject.toml": '[project]\nname = "demo"\n', "src/a.py": "x = 1\n" });
  const plan = planOf(root, { "package-manager": "uv", tools: "ruff,mypy", select: "python/silenced-test" });
  assert.equal(pathsOf(plan).includes("Cargo.toml"), false, "no crate file in a Python project");
  assert.ok(plan.refused.some((r) => r.includes("--edition rust")), "and it says why: " + JSON.stringify(plan.refused));
});

test("a config file the project already owns keeps the tool and reports the section", () => {
  const root = project({ "pyproject.toml": '[project]\nname = "demo"\n', "src/a.py": "x = 1\n" });
  const plan = planOf(root, {
    edition: "python", "package-manager": "uv", tools: "ruff,mypy,pytest", select: "python/silenced-test",
  });
  assert.equal(pathsOf(plan, "write-side-file").includes("pyproject.toml"), false, "jig does not write over it");
  assert.deepEqual(plan.configNotes.map((n) => n.tool).sort(), ["mypy", "pytest", "ruff"]);
  assert.ok(plan.configNotes[0].why.includes("already exists"), plan.configNotes[0].why);
  // The regression this closes: an existing pyproject.toml used to refuse every
  // python tool outright, so a real Python project got no toolchain at all.
  assert.ok(plan.toolchain.items.length >= 3, "every tool is still on the proposal");
});
