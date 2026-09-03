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

test("mergeable names the four families and nothing with a free grammar", () => {
  const yes = [
    "pyproject.toml", "Cargo.toml", ".editorconfig", "a/b/setup.cfg", "tox.ini",
    "Directory.Build.props", "a/b/Directory.Build.targets",
    "build.gradle.kts", "app/build.gradle",
    "package.json", "a/b/tsconfig.json",
  ];
  for (const rel of yes) assert.equal(sections.mergeable(rel), true, rel + " is one jig composes");
  for (const no of ["go.mod", "Main.kt", "", null]) {
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
// merge — MSBuild property files

const PROPS_CSC = '<Project>\n  <PropertyGroup>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n</Project>\n';
const PROPS_AUDIT = '<Project>\n  <PropertyGroup>\n    <NuGetAudit>true</NuGetAudit>\n  </PropertyGroup>\n</Project>\n';

test("merge folds two property groups into one Project and one PropertyGroup", () => {
  const { body, conflicts } = sections.merge([
    { source: "csc", body: PROPS_CSC },
    { source: "nuget-audit", body: PROPS_AUDIT },
  ], "Directory.Build.props");
  assert.deepEqual(conflicts, []);
  assert.equal(body.match(/<Project>/g).length, 1, "one root element");
  assert.equal(body.match(/<PropertyGroup>/g).length, 1, "one property group");
  assert.match(body, /<Nullable>enable<\/Nullable>\n\s*<NuGetAudit>true<\/NuGetAudit>/);
  assert.ok(body.trimEnd().endsWith("</Project>"), body);
});

test("merge reports two tools setting one MSBuild property differently", () => {
  const { body, conflicts } = sections.merge([
    { source: "csc", body: '<Project>\n  <PropertyGroup>\n    <LangVersion>latest</LangVersion>\n  </PropertyGroup>\n</Project>\n' },
    { source: "other", body: '<Project>\n  <PropertyGroup>\n    <LangVersion>9.0</LangVersion>\n  </PropertyGroup>\n</Project>\n' },
  ], "Directory.Build.props");
  assert.match(body, /<LangVersion>latest<\/LangVersion>/);
  assert.doesNotMatch(body, /9\.0/);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(
    { key: conflicts[0].key, keptFrom: conflicts[0].keptFrom, droppedFrom: conflicts[0].droppedFrom },
    { key: "LangVersion", keptFrom: "csc", droppedFrom: "other" },
  );
});

test("merge keeps two different items in a group, and a condition apart from an unconditional group", () => {
  const { body, conflicts } = sections.merge([
    { source: "one", body: '<Project>\n  <ItemGroup>\n    <PackageReference Include="A" />\n  </ItemGroup>\n</Project>\n' },
    {
      source: "two",
      body: '<Project>\n  <ItemGroup>\n    <PackageReference Include="B" />\n  </ItemGroup>\n' +
        '  <PropertyGroup Condition="\'$(CI)\' == \'true\'">\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n</Project>\n',
    },
  ], "Directory.Build.props");
  assert.deepEqual(conflicts, [], "two package references are not a dispute");
  assert.match(body, /Include="A"/);
  assert.match(body, /Include="B"/);
  assert.match(body, /<PropertyGroup Condition="'\$\(CI\)' == 'true'">/);
});

// ---------------------------------------------------------------------------
// merge — Gradle build scripts

test("merge gives a Gradle script one plugins block with the shared plugin named once", () => {
  const { body, conflicts } = sections.merge([
    { source: "gradle", body: 'plugins {\n    java\n    checkstyle\n}\n\nrepositories { mavenCentral() }\n' },
    { source: "errorprone", body: 'plugins {\n    java\n    id("net.ltgt.errorprone") version "4.3.0"\n}\n' },
  ], "build.gradle.kts");
  assert.deepEqual(conflicts, []);
  assert.equal(body.match(/^plugins \{$/gm).length, 1, "Gradle allows exactly one plugins block: " + body);
  assert.equal(body.match(/^ *java$/gm).length, 1, "the plugin both tools ask for is named once");
  assert.match(body, /id\("net\.ltgt\.errorprone"\) version "4\.3\.0"/);
  assert.match(body, /repositories \{\n {4}mavenCentral\(\)\n\}/, "a one-line block still composes: " + body);
  assert.equal(body.indexOf("plugins {"), 0, "and it is still the first statement");
});

test("merge carries a nested Gradle block whole and keys the assignments inside one", () => {
  const { body, conflicts } = sections.merge([
    { source: "gradle", body: 'tasks.withType<Test>().configureEach {\n    useJUnitPlatform()\n    ignoreFailures = false\n}\n' },
    {
      source: "errorprone",
      body: 'tasks.withType<Test>().configureEach {\n    ignoreFailures = true\n' +
        '    options.errorprone {\n        error(\n            "EmptyCatch"\n        )\n    }\n}\n',
    },
  ], "build.gradle.kts");
  assert.equal(body.match(/configureEach \{/g).length, 1, "one block, not two");
  assert.match(body, /options\.errorprone \{\n {8}error\(\n {12}"EmptyCatch"\n {8}\)\n {4}\}/, body);
  assert.match(body, /ignoreFailures = false/);
  assert.doesNotMatch(body, /ignoreFailures = true/);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(
    { key: conflicts[0].key, keptFrom: conflicts[0].keptFrom, droppedFrom: conflicts[0].droppedFrom },
    { key: "ignoreFailures", keptFrom: "gradle", droppedFrom: "errorprone" },
  );
});

// ---------------------------------------------------------------------------
// merge — JSON manifests

test("merge folds every tool's script into one package.json scripts block", () => {
  const { body, conflicts } = sections.merge([
    { source: "the starter", body: '{ "name": "app", "type": "module" }' },
    { source: "eslint", body: '{ "scripts": { "lint": "eslint ." } }' },
    { source: "vitest", body: '{ "scripts": { "test": "vitest run" } }' },
  ], "package.json");
  assert.deepEqual(conflicts, []);
  const parsed = JSON.parse(body);
  assert.deepEqual(parsed, { name: "app", type: "module", scripts: { lint: "eslint .", test: "vitest run" } });
  assert.equal(body.match(/"scripts"/g).length, 1, "one scripts block, not one per tool");
  assert.ok(body.endsWith("}\n"), JSON.stringify(body.slice(-4)));
});

test("merge keeps the first script for a name two tools claim and reports the dispute", () => {
  const { body, conflicts } = sections.merge([
    { source: "vitest", body: '{ "scripts": { "test": "vitest run" } }' },
    { source: "other", body: '{ "scripts": { "test": "node --test" } }' },
  ], "package.json");
  assert.equal(JSON.parse(body).scripts.test, "vitest run");
  assert.equal(conflicts.length, 1);
  assert.deepEqual(
    { key: conflicts[0].key, keptFrom: conflicts[0].keptFrom, droppedFrom: conflicts[0].droppedFrom, path: conflicts[0].path },
    { key: "test", keptFrom: "vitest", droppedFrom: "other", path: "package.json" },
  );
});

test("merge carries a JSON array and a nested object whole, and refuses a body that is not JSON", () => {
  const { body } = sections.merge([
    { source: "one", body: '{ "files": ["dist"], "exports": { "." : { "import": "./a.js" } } }' },
    { source: "two", body: '{ "exports": { "./b": "./b.js" } }' },
  ], "package.json");
  assert.deepEqual(JSON.parse(body), {
    files: ["dist"],
    exports: { ".": { import: "./a.js" }, "./b": "./b.js" },
  });
  assert.throws(() => sections.merge([{ source: "x", body: "not json" }], "package.json"), /not JSON/);
  assert.throws(() => sections.merge([{ source: "x", body: "[1]" }], "package.json"), /composes a JSON object/);
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
      // Not the keys alone. An XML element and a Gradle statement have no `=`
      // in them, so the claim the new formats have to answer is the stronger
      // one: every line of every sample is somewhere in the composed body.
      const kept = new Set(merged.body.split("\n").map((l) => l.trim()));
      for (const tool of tools) {
        for (const raw of tool.configSample.split("\n")) {
          const line = raw.trim();
          if (line === "" || line === "<Project>" || line === "</Project>") continue;
          if (kept.has(line)) continue;
          // A block written on one line is composed onto two, and both halves
          // have to be there: `repositories { mavenCentral() }`.
          const one = line.match(/^([^{}]+)\{(.+)\}$/);
          assert.ok(one && kept.has(one[1].trim() + " {") && kept.has(one[2].trim()),
            row.id + " " + configPath + " lost " + tool.id + "'s line: " + line);
        }
      }
    }
  }
  assert.ok(sharedPaths >= 5, "the shelf still has the shared paths this gate exists for: " + sharedPaths);
});

test("every shipped edition declares a project file jig can either write or explain, per package manager", () => {
  for (const row of editions.loadIndex(PLUGIN_ROOT).editions) {
    const edition = editions.loadEdition(PLUGIN_ROOT, row.id);
    // Per manager, not per edition. `jvm` covers Gradle and Maven, and a
    // settings file is not a project file a Maven build can do anything with.
    for (const manager of edition.detect.packageManagers) {
      const manifest = editions.manifestFor(edition, manager);
      const where = row.id + " under " + manager;
      assert.equal(manifest.edition, row.id);
      assert.equal(manifest.packageManager, manager);
      assert.equal(Boolean(manifest.sample) !== Boolean(manifest.hint), true,
        where + " must offer a starter or a reason, not both and not neither");
      if (manifest.sample) assert.ok(manifest.path, where + " offers a sample with nowhere to write it");
    }
  }
});

test("a manager the edition does not claim falls back to its first, and never to nothing", () => {
  const jvm = editions.loadEdition(PLUGIN_ROOT, "jvm");
  assert.equal(editions.manifestFor(jvm, "gradle").path, "settings.gradle.kts");
  assert.equal(editions.manifestFor(jvm, "maven").path, "pom.xml");
  for (const nonsense of [undefined, null, "npm"]) {
    const fallback = editions.manifestFor(jvm, nonsense);
    assert.equal(fallback.packageManager, "gradle", "the edition's first manager answers for " + String(nonsense));
    assert.ok(fallback.sample, "and it still carries a starter");
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

// The other half of the same promise. A `pyproject.toml` with no package
// directory builds an empty wheel and a `Cargo.toml` with no `src/lib.rs` is a
// manifest cargo exits 101 on — so the starter is the whole smallest tree, and
// each file in it is its own approved change rather than a folder that appears.
test("a starter is the whole tree its build needs, one approved change per file", () => {
  const root = project({});
  const plan = planOf(root, {
    edition: "python", "package-manager": "uv", tools: "ruff", select: "python/silenced-test",
  });
  const written = JSON.parse(fs.readFileSync(path.join(root, plan.plan), "utf8"));
  for (const rel of ["src/example_app/__init__.py", "tests/test_smoke.py"]) {
    const change = written.changes.find((c) => c.path === rel);
    assert.ok(change, rel + " is not planned: " + pathsOf(plan).join(", "));
    assert.equal(change.kind, "write-side-file");
    assert.match(change.rationale, /part of the starter python project/);
    assert.ok(change.content.length > 0, rel + " is planned empty");
  }
  // And only where the owner named the edition, which is what makes the write
  // a stated intent rather than an extension match.
  const unnamed = planOf(project({}), { "package-manager": "uv", tools: "ruff", select: "python/silenced-test" });
  assert.equal(unnamed.changes.some((c) => c.path.startsWith("src/example_app")), false,
    "an unnamed edition was scaffolded a source tree: " + pathsOf(unnamed).join(", "));
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

test("two dotnet tools sharing Directory.Build.props produce one composed property file", () => {
  const root = project({ "App.csproj": "<Project></Project>\n" });
  const plan = planOf(root, {
    edition: "dotnet", "package-manager": "dotnet",
    tools: "csc,nuget-audit", select: "dotnet/swallowed-exception",
  });
  const writes = plan.changes.filter((c) => c.path === "Directory.Build.props" && c.kind === "write-side-file");
  assert.equal(writes.length, 1, "one write for the shared file");
  assert.deepEqual(plan.configConflicts, []);
  assert.deepEqual(plan.configNotes.map((n) => n.path), [], "nothing is handed back to paste");

  const body = bodyOf(root, plan, "Directory.Build.props");
  assert.equal(body.match(/<Project>/g).length, 1, "one root element, not two files fighting");
  for (const property of ["<TreatWarningsAsErrors>", "<Nullable>", "<NuGetAudit>", "<WarningsAsErrors>"]) {
    assert.ok(body.includes(property), "the composed file kept " + property);
  }
});

test("two jvm tools sharing build.gradle.kts produce one script Gradle would accept", () => {
  // A Gradle project whose root build script has not been written yet — the
  // settings file and the wrapper are what make it a jvm project.
  const root = project({
    "settings.gradle.kts": 'rootProject.name = "demo"\n',
    "app/src/main/java/A.java": "class A {}\n",
  });
  const plan = planOf(root, {
    edition: "jvm", "package-manager": "gradle",
    tools: "gradle,errorprone", select: "jvm/swallowed-exception",
  });
  const writes = plan.changes.filter((c) => c.path === "build.gradle.kts" && c.kind === "write-side-file");
  assert.equal(writes.length, 1, "one write for the shared file: " + pathsOf(plan).join(", "));
  assert.deepEqual(plan.configConflicts, []);

  // The reason composing this one beats reporting it: two `plugins` blocks is
  // not a merge that lost something, it is a build script that cannot compile.
  const body = bodyOf(root, plan, "build.gradle.kts");
  assert.equal(body.match(/^plugins \{$/gm).length, 1, body);
  assert.equal(body.indexOf("plugins {"), 0, "and Gradle wants it first");
  assert.equal(body.match(/^ *java$/gm).length, 1, "the plugin both tools ask for is applied once");
  assert.ok(body.includes('errorprone("com.google.errorprone:error_prone_core:2.42.0")'), body);
  assert.ok(body.includes("options.errorprone {"), body);
});

// ---------------------------------------------------------------------------
// A starter that is green on line one

test("a greenfield JS starter carries the script every tool's CI step calls", () => {
  const root = project({});
  const plan = planOf(root, {
    edition: "javascript-typescript", "package-manager": "npm",
    tools: "eslint,typescript,vitest", select: "javascript-typescript/skipped-test",
  });
  const writes = plan.changes.filter((c) => c.path === "package.json" && c.kind === "write-side-file");
  assert.equal(writes.length, 1, "one write for the manifest: " + pathsOf(plan).join(", "));
  assert.deepEqual(plan.configConflicts, []);

  // The defect: the starter was the sample verbatim, so `npm run lint` — the CI
  // step jig planned in the same breath — had nothing to call.
  const manifest = JSON.parse(bodyOf(root, plan, "package.json"));
  assert.equal(manifest.name, "example-app", "the starter's own members survive composition");
  assert.deepEqual(manifest.scripts, {
    lint: "eslint . --max-warnings 0 --report-unused-disable-directives",
    typecheck: "tsc --noEmit",
    test: "vitest run --coverage",
  });
});

test("a starter gets the edition's .gitignore, and a folder that has one keeps it", () => {
  const root = project({});
  const plan = planOf(root, {
    edition: "javascript-typescript", "package-manager": "npm",
    tools: "eslint", select: "javascript-typescript/skipped-test",
  });
  const body = bodyOf(root, plan, ".gitignore");
  assert.match(body, /^# javascript-typescript$/m, body);
  for (const line of ["node_modules/", "dist/", "coverage/"]) assert.ok(body.includes(line), body);

  // Somebody else's file, and the same rule every other write obeys.
  const held = project({ ".gitignore": "*.log\n" });
  const second = planOf(held, {
    edition: "javascript-typescript", "package-manager": "npm",
    tools: "eslint", select: "javascript-typescript/skipped-test",
  });
  assert.equal(pathsOf(second).includes(".gitignore"), false, pathsOf(second).join(", "));
  assert.ok(second.refused.some((r) => r.includes(".gitignore already exists")),
    JSON.stringify(second.refused));
  assert.equal(fs.readFileSync(path.join(held, ".gitignore"), "utf8"), "*.log\n");
});

test("installs run in installKind order, so the scaffold that writes gradlew runs first", () => {
  const root = project({});
  const plan = planOf(root, {
    edition: "jvm", "package-manager": "gradle",
    tools: "gradle,checkstyle,pmd,errorprone", select: "jvm/swallowed-exception",
  });
  // The install item lives in the plan FILE; the summary carries ids and paths.
  const written = JSON.parse(fs.readFileSync(path.join(root, plan.plan), "utf8"));
  const installs = written.changes.filter((c) => c.kind === "run-install");
  const commands = installs.map((c) => c.install.command);
  const wrapper = commands.findIndex((cmd) => cmd.startsWith("gradle wrapper"));
  assert.ok(wrapper >= 0, commands.join(" | "));
  // Ordered by id, `./gradlew checkstyleMain` came first and ran a script the
  // wrapper had not written yet.
  for (const [i, cmd] of commands.entries()) {
    if (cmd.startsWith("./gradlew")) assert.ok(wrapper < i, cmd + " runs before the wrapper exists");
  }
  assert.deepEqual(installs.map((c) => c.install.installKind), ["scaffold", "audit", "audit", "audit"]);
});

test("a shared file jig cannot compose is written by nobody and handed back as snippets", () => {
  // `go.mod` stays out: its samples are pictures of a module file rather than
  // fragments, and a module path is the owner's to choose.
  assert.equal(sections.mergeable("go.mod"), false);
  const root = project({ "go.mod": "module demo\n\ngo 1.23\n", "main.go": "package main\n" });
  const plan = planOf(root, {
    edition: "go", "package-manager": "go", tools: "go-vet,go-test", select: "go/skipped-test",
  });
  assert.equal(pathsOf(plan).includes("go.mod"), false, "jig writes none of it");
  assert.deepEqual(plan.configNotes.map((n) => n.tool).sort(), ["go-test", "go-vet"]);
  for (const note of plan.configNotes) {
    assert.equal(note.path, "go.mod");
    assert.ok(note.snippet.includes("go "), "the note carries the snippet to put in yourself");
  }
});

test("a greenfield Gradle project gets the settings file and the composed build script", () => {
  const root = project({});
  const plan = planOf(root, {
    edition: "jvm", "package-manager": "gradle",
    tools: "gradle,errorprone", select: "jvm/swallowed-exception",
  });
  assert.deepEqual(plan.refused, [], "nothing is refused for want of a project");
  const starter = plan.changes.find((c) => c.path === "settings.gradle.kts" && c.kind === "write-side-file");
  assert.ok(starter, "the settings file is what makes the directory a Gradle build root: " + pathsOf(plan).join(", "));
  assert.match(bodyOf(root, plan, "settings.gradle.kts"), /rootProject\.name = "app"/);

  // The build script is not the starter — it is composed from the tools, and
  // that is what 158 made possible.
  const body = bodyOf(root, plan, "build.gradle.kts");
  assert.equal(body.match(/^plugins \{$/gm).length, 1, body);
  assert.ok(body.includes("options.errorprone {"), body);

  const at = plan.changes.indexOf(starter);
  for (const [i, change] of plan.changes.entries()) {
    if (change.kind === "run-install") assert.ok(at < i, "the project file is written before install " + i);
  }
});

test("the same edition under Maven gets a pom, not a Gradle settings file", () => {
  const root = project({});
  const plan = planOf(root, {
    edition: "jvm", "package-manager": "maven",
    tools: "checkstyle,pmd", select: "jvm/swallowed-exception",
  });
  assert.deepEqual(plan.refused, []);
  assert.equal(pathsOf(plan).includes("settings.gradle.kts"), false, "a Maven build cannot use one");
  assert.ok(pathsOf(plan).includes("pom.xml"), pathsOf(plan).join(", "));
  const body = bodyOf(root, plan, "pom.xml");
  assert.match(body, /<modelVersion>4\.0\.0<\/modelVersion>/);
  assert.match(body, /<artifactId>app<\/artifactId>/);
});

test("a greenfield .NET project gets a project file that compiles with nothing in it", () => {
  const root = project({});
  const plan = planOf(root, {
    edition: "dotnet", "package-manager": "dotnet",
    tools: "csc,nuget-audit", select: "dotnet/swallowed-exception",
  });
  assert.deepEqual(plan.refused, []);
  const starter = plan.changes.find((c) => c.path === "App.csproj" && c.kind === "write-side-file");
  assert.ok(starter, pathsOf(plan).join(", "));
  const body = bodyOf(root, plan, "App.csproj");
  assert.match(body, /<Project Sdk="Microsoft\.NET\.Sdk">/);
  // No entry point is written, so an executable would fail to build on the
  // first check jig runs. A library compiles with no source files at all.
  assert.doesNotMatch(body, /^\s*<OutputType>/m, "the comment may name it; the project may not set it");
  assert.ok(pathsOf(plan).includes("Directory.Build.props"), "and the shared config still composes");
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
