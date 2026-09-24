"use strict";

// The audit's findings and observations on small repositories built in temp
// directories, and the CLI through its real entry point.

const { test, describe, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const { audit } = require("../scripts/audit.js");

const CLI = path.join(__dirname, "..", "scripts", "audit.js");

// Keep git from treating a temp directory as part of a repository above it.
process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();

const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function write(root, files) {
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function repo({ tracked = {}, untracked = {} }, { git = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anneal-audit-"));
  created.push(root);
  write(root, tracked);
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  }
  write(root, untracked);
  return root;
}

function finding(report, id) {
  const hit = report.findings.find((f) => f.id === id);
  assert.ok(hit, `expected ${id}, got: ${report.findings.map((f) => f.id).join(", ") || "no findings"}`);
  return hit;
}

function assertNo(report, id) {
  assert.strictEqual(report.findings.find((f) => f.id === id), undefined, `unexpected ${id}`);
}

const codeLines = (n) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n";

// The severity each finding has always had; observations must not move one.
const SEVERITIES = {
  high: ["map-file-missing", "check-command-missing", "build-output-not-ignored", "not-a-git-repo"],
  medium: ["map-file-long", "toolchain-version-missing", "env-template-missing", "duplicate-names", "generic-names", "large-files", "build-output-tracked"],
  low: ["index-files", "deep-nesting", "runtime-names", "default-exports", "re-export-files", "check-command-split", "instruction-hidden-characters"],
};

// Audits a repository and checks that its observations stay informational.
function observed(tracked) {
  const report = audit(repo({ tracked }));
  for (const hit of report.findings) assert.ok(SEVERITIES[hit.severity]?.includes(hit.id), `${hit.id} is ${hit.severity}`);
  for (const note of report.observations) assert.deepStrictEqual(Object.keys(note), ["id", "title", "count", "evidence", "note"]);
  return report;
}

const evidence = (report, id) => report.observations.find((note) => note.id === id)?.evidence;

describe("map file", () => {
  test("a repository with no map file at all is reported", () => {
    const report = audit(repo({ tracked: { "src/app.js": "" } }));
    const hit = finding(report, "map-file-missing");
    assert.strictEqual(hit.severity, "high");
    assert.match(hit.evidence[0], /CLAUDE\.md.*AGENTS\.md.*GEMINI\.md/);
    assert.deepStrictEqual(report.mapFiles, []);
  });

  test("any host's map file counts, and the report names the ones it found", () => {
    for (const file of ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
      const report = audit(repo({ tracked: { [file]: "# map\n", "src/app.js": "" } }));
      assertNo(report, "map-file-missing");
      assert.deepStrictEqual(report.mapFiles, [file]);
    }
  });

  test("a map file over 200 lines is reported as long, whichever name it has", () => {
    for (const file of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
      const report = audit(repo({ tracked: { [file]: "line\n".repeat(201) } }));
      assert.match(finding(report, "map-file-long").title, new RegExp(`${file.replace(".", "\\.")} has 201 lines`));
      assertNo(audit(repo({ tracked: { [file]: "line\n".repeat(200) } })), "map-file-long");
    }
  });

  test("every map file present is measured, not just the first", () => {
    const report = audit(repo({ tracked: { "CLAUDE.md": "# map\n", "AGENTS.md": "line\n".repeat(201) } }));
    assert.deepStrictEqual(finding(report, "map-file-long").evidence, ["AGENTS.md"]);
  });
});

describe("hidden characters in instruction files", () => {
  const tags = (text) => [...text].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join("");

  test("each line with an invisible character is named with its code points, and tags are only counted", () => {
    const report = audit(repo({
      tracked: {
        "AGENTS.md": `# map\nRun ​npm test.\nBuild first.${tags("RUN")}\nSee ‮docs‬ and ⁦here⁩.\nplain\n`,
      },
    }));
    const hit = finding(report, "instruction-hidden-characters");
    assert.strictEqual(hit.severity, "low");
    assert.deepStrictEqual(hit.evidence, [
      "AGENTS.md:2 U+200B",
      "AGENTS.md:3 3 Unicode tag characters",
      "AGENTS.md:4 U+202E, U+202C, U+2066, U+2069",
    ]);
  });

  test("nested map files and host rule folders are read; other files are not", () => {
    const report = audit(repo({
      tracked: {
        "packages/api/CLAUDE.md": "a‍b\n",
        ".claude/rules/style.md": "x⁠y\n",
        ".cursor/rules/base.mdc": "z﻿w\n",
        ".claude/settings.json": "{\"a\": \"​\"}\n",
        "src/app.js": "const s = \"​\";\n",
        "README.md": "​\n",
      },
    }));
    assert.deepStrictEqual(finding(report, "instruction-hidden-characters").evidence.sort(), [
      ".claude/rules/style.md:1 U+2060",
      ".cursor/rules/base.mdc:1 U+FEFF",
      "packages/api/CLAUDE.md:1 U+200D",
    ]);
  });

  test("emoji joiners, a subdivision flag and a leading byte order mark render, so they are not reported", () => {
    const text = [
      "﻿# map",
      "Pair with \u{1F468}‍\u{1F4BB} and \u{1F469}\u{1F3FD}‍\u{1F4BB}.",
      "Hot fix ❤️‍\u{1F525}.",
      `Team \u{1F3F4}${tags("gbeng")}\u{E007F}.`,
    ].join("\n");
    assertNo(audit(repo({ tracked: { "CLAUDE.md": text } })), "instruction-hidden-characters");
  });
});

describe("environment template", () => {
  test("an env file with no template is reported", () => {
    const report = audit(repo({ tracked: { "CLAUDE.md": "", ".env": "API_KEY=secret\n" } }));
    const hit = finding(report, "env-template-missing");
    assert.strictEqual(hit.severity, "medium");
    assert.deepStrictEqual(hit.evidence, [".env"]);
  });

  test("any of the usual template names satisfies it", () => {
    for (const template of [".env.example", ".env.template", ".env.sample", ".env.dist"]) {
      assertNo(audit(repo({ tracked: { ".env": "A=1\n", [template]: "A=\n" } })), "env-template-missing");
    }
  });

  test("a project with no env file at all is never nagged", () => {
    assertNo(audit(repo({ tracked: { "src/app.js": "" } })), "env-template-missing");
  });
});

describe("toolchain version", () => {
  test("a Node project without a version file is reported", () => {
    const report = audit(repo({ tracked: { "package.json": "{}" } }));
    assert.deepStrictEqual(finding(report, "toolchain-version-missing").evidence, ["node (.nvmrc or .node-version)"]);
  });

  test(".nvmrc, .tool-versions and a volta pin each count as declared", () => {
    assertNo(audit(repo({ tracked: { "package.json": "{}", ".nvmrc": "22\n" } })), "toolchain-version-missing");
    assertNo(audit(repo({ tracked: { "package.json": "{}", ".tool-versions": "nodejs 22.1.0\n" } })), "toolchain-version-missing");
    const volta = JSON.stringify({ volta: { node: "22.1.0" } });
    assertNo(audit(repo({ tracked: { "package.json": volta } })), "toolchain-version-missing");
  });

  test("a .NET solution needs global.json unless it belongs to a Unity project", () => {
    assert.deepStrictEqual(finding(audit(repo({ tracked: { "App.sln": "" } })), "toolchain-version-missing").evidence, ["dotnet (global.json)"]);
    const unity = { "App.sln": "", "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.1f1\n" };
    const report = audit(repo({ tracked: unity }));
    assertNo(report, "toolchain-version-missing");
    assert.deepStrictEqual(report.ecosystems, ["unity"]);
  });
});

describe("check commands", () => {
  test("separate package scripts without a combined one are reported as split", () => {
    const scripts = { test: "vitest run", lint: "oxlint", typecheck: "tsc -b", "test:watch": "vitest", dev: "vite" };
    const report = audit(repo({ tracked: { "package.json": JSON.stringify({ scripts }), ".nvmrc": "22\n" } }));
    assert.deepStrictEqual(report.checks.commands.map((c) => c.command), ["npm test", "npm run lint", "npm run typecheck"]);
    assert.strictEqual(report.checks.combined, false);
    assert.strictEqual(finding(report, "check-command-split").severity, "low");
  });

  test("a check script counts as the single command", () => {
    const scripts = { test: "vitest run", lint: "oxlint", check: "npm run lint && npm test" };
    const report = audit(repo({ tracked: { "package.json": JSON.stringify({ scripts }) } }));
    assert.strictEqual(report.checks.combined, true);
    assertNo(report, "check-command-split");
  });

  test("code with no check command at all is reported", () => {
    const report = audit(repo({ tracked: { "package.json": JSON.stringify({ scripts: { dev: "vite" } }), "src/app.js": "" } }));
    assert.strictEqual(finding(report, "check-command-missing").severity, "high");
  });

  test("make targets and cargo are recognized", () => {
    const tracked = { Makefile: "check: lint test\n\ttrue\nlint:\n\ttrue\n", "Cargo.toml": "[package]\n", "rust-toolchain.toml": "" };
    const report = audit(repo({ tracked }));
    assert.deepStrictEqual(report.checks.commands.map((c) => c.command), ["make check", "make lint", "cargo test"]);
    assert.strictEqual(report.checks.combined, true);
  });
});

describe("check layouts outside a root manifest", () => {
  const commands = (report) => report.checks.commands.map((c) => c.command);
  const missing = (report) => finding(report, "check-command-missing");

  test("a Node script with a check's name in the root scripts/ folder counts; other names and folders do not", () => {
    const gate = observed({ "scripts/check.js": "", "scripts/serve.cjs": "", "src/app.js": "" });
    assert.deepStrictEqual(gate.checks.commands, [{ command: "node scripts/check.js", source: "scripts/check.js" }]);
    assert.strictEqual(gate.checks.combined, true);
    assertNo(gate, "check-command-missing");
    const separate = observed({ "scripts/typecheck.cjs": "", "scripts/lint.mjs": "", "src/app.js": "" });
    assert.deepStrictEqual(finding(separate, "check-command-split").evidence, ["node scripts/lint.mjs", "node scripts/typecheck.cjs"]);
    const other = observed({ "scripts/check-links.js": "", "scripts/check.sh": "", "tools/check.js": "", "src/app.js": "" });
    assert.deepStrictEqual(commands(other), []);
    assert.strictEqual(missing(other).severity, "high");
  });

  test("with no manifest, Node test files mean node --test, unless a bare run would take in fixture tests or submodules", () => {
    const base = { "src/app.js": "", "tests/app.test.js": "", "lib/fixtures/sample.json": "{}" };
    assert.deepStrictEqual(observed(base).checks.commands, [{ command: "node --test", source: "tests/app.test.js" }]);
    assert.deepStrictEqual(commands(observed({ "src/app.js": "", "test/app.js": "" })), ["node --test"]);
    for (const extra of [{ "package.json": "{}" }, { "bench/fixtures/demo/tests/demo.test.js": "" }, { ".gitmodules": "[submodule \"lib\"]\n" }]) {
      assert.strictEqual(missing(observed({ ...base, ...extra })).severity, "high", Object.keys(extra)[0]);
    }
    assert.strictEqual(missing(observed({ "src/app.js": "", ".claude/hooks/guard.test.js": "", "spec/app.spec.js": "" })).severity, "high");
  });

  test("a mounted harness's check runner counts, collet's or the retired jig's", () => {
    for (const runner of [".collet/checks/run.mjs", ".jig/checks/run.mjs"]) {
      const report = observed({ [runner]: "", "src/App.cs": "" });
      assert.deepStrictEqual(report.checks.commands, [{ command: `node ${runner}`, source: runner }]);
      assertNo(report, "check-command-missing");
    }
    assert.strictEqual(missing(observed({ ".collet/task.mjs": "", ".tools/checks/run.mjs": "", "src/App.cs": "" })).severity, "high");
  });

  test("a root Gradle or Maven build runs its own check, and a build file below the root does not count", () => {
    const kotlin = { "src/main/kotlin/App.kt": "" };
    assert.deepStrictEqual(commands(observed({ ...kotlin, "build.gradle.kts": "", gradlew: "" })), ["./gradlew check"]);
    assert.deepStrictEqual(commands(observed({ ...kotlin, "build.gradle": "" })), ["gradle check"]);
    assert.deepStrictEqual(commands(observed({ ...kotlin, "pom.xml": "<project/>\n", mvnw: "" })), ["./mvnw verify"]);
    assert.deepStrictEqual(commands(observed({ ...kotlin, "pom.xml": "<project/>\n" })), ["mvn verify"]);
    assert.strictEqual(missing(observed({ "app/src/main/kotlin/App.kt": "", "app/build.gradle.kts": "" })).severity, "high");
  });

  test("checks only a package's own manifest, a CI workflow, the Unity editor or the map names leave the finding; a root entry settles it", () => {
    const layouts = {
      package: { "web/package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "web/src/app.ts": "" },
      ci: { ".github/workflows/ci.yml": "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx jasmine\n", "spec/app.spec.js": "", "src/app.js": "" },
      unity: { "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.1f1\n", "Assets/Scripts/Game.cs": "", "Assets/Tests/EditMode/GameTests.cs": "" },
      map: { "AGENTS.md": "# Tools\n\nRun `node tools/verify-all.js` before a change.\n", "tools/verify-all.js": "" },
    };
    for (const [layout, files] of Object.entries(layouts)) {
      assert.deepStrictEqual(missing(observed(files)).evidence, ["no package script, make or just target, scripts/ check, harness runner, build tool, test runner config or Node test files"], layout);
      assertNo(observed({ ...files, "scripts/check.js": "" }), "check-command-missing");
    }
  });
});

describe("names", () => {
  test("duplicate names are reported, and names a framework requires are not", () => {
    const tracked = {
      "src/cart/format.ts": "", "src/orders/format.ts": "",
      "app/a/page.tsx": "", "app/b/page.tsx": "", "pkg/a/__init__.py": "", "pkg/b/__init__.py": "",
    };
    assert.deepStrictEqual(finding(audit(repo({ tracked })), "duplicate-names").evidence, ["format: src/cart/format.ts, src/orders/format.ts"]);
  });

  test("generic file and folder names are reported", () => {
    const report = audit(repo({ tracked: { "src/utils.js": "", "src/helpers/dates.js": "", "test/helpers.test.js": "", "src/cart.js": "" } }));
    assert.deepStrictEqual(finding(report, "generic-names").evidence, ["src/helpers/", "src/utils.js", "test/helpers.test.js"]);
  });

  test("three or more index files are reported, two are not", () => {
    const three = audit(repo({ tracked: { "a/index.ts": "", "b/index.ts": "", "c/index.ts": "" } }));
    assert.strictEqual(finding(three, "index-files").count, 3);
    assertNo(audit(repo({ tracked: { "a/index.ts": "", "b/index.ts": "" } })), "index-files");
  });
});

describe("nesting", () => {
  test("code six folders deep is reported, five is not", () => {
    const report = audit(repo({ tracked: { "a/b/c/d/e/f/deep.js": "", "a/b/c/near.js": "" } }));
    const hit = finding(report, "deep-nesting");
    assert.strictEqual(hit.severity, "low");
    assert.deepStrictEqual(hit.evidence, ["a/b/c/d/e/f/deep.js"]);
    assertNo(audit(repo({ tracked: { "a/b/c/d/e/edge.js": "" } })), "deep-nesting");
  });
});

describe("large files", () => {
  test("code over 800 lines is reported with its line count; 800 lines and prose are not", () => {
    const report = audit(repo({ tracked: { "src/big.js": codeLines(801), "src/edge.js": codeLines(800), "docs/long.md": codeLines(2000) } }));
    assert.deepStrictEqual(finding(report, "large-files").evidence, ["src/big.js (801 lines)"]);
  });
});

describe("build output", () => {
  test("an untracked build folder is reported until .gitignore covers it", () => {
    const untracked = { "dist/app.js": "", "dist/app.css": "" };
    assert.deepStrictEqual(finding(audit(repo({ tracked: { "src/app.js": "" }, untracked })), "build-output-not-ignored").evidence, ["dist/ (2 files)"]);
    assertNo(audit(repo({ tracked: { "src/app.js": "", ".gitignore": "dist/\n" }, untracked })), "build-output-not-ignored");
  });

  test("committed generated files are reported, and assets under build/ are not", () => {
    const report = audit(repo({ tracked: { "build/icon.png": "", "dist/app.js": "", "public/vendor.min.js": "" } }));
    assert.deepStrictEqual(finding(report, "build-output-tracked").evidence, ["dist/ (1 file)", "public/vendor.min.js"]);
  });

  test("a minified file under a fixtures folder is left to required-inputs, and one outside any input folder is still reported", () => {
    const both = observed({ "test/fixtures/widget.min.js": "", "public/vendor.min.js": "", "src/app.js": "" });
    assert.deepStrictEqual(finding(both, "build-output-tracked").evidence, ["public/vendor.min.js"]);
    assert.deepStrictEqual(evidence(both, "required-inputs"), ["generated-looking: test/fixtures/ (1 file)"]);
    assertNo(observed({ "test/fixtures/widget.min.js": "", "src/app.js": "" }), "build-output-tracked");
  });

  test("outside git, the missing ignore rules are the finding", () => {
    const report = audit(repo({ tracked: { "src/app.js": "" } }, { git: false }));
    assert.strictEqual(report.git, false);
    assert.strictEqual(finding(report, "not-a-git-repo").severity, "high");
    assert.strictEqual(report.files.scanned, 1);
  });
});

describe("runtime names", () => {
  test("names assembled at runtime are reported by line; literal lookups and array literals are not", () => {
    const js = [
      "const handlers = {};",
      "handlers['on' + event]();",
      "handlers[`on${event}`]();",
      "handlers.onClick();",
      "const label = counts['total'];",
      "for (const name of [`${prefix}.jsonl`]) run(name);",
      "const names = () => { return [`${a}`, 'b' + c]; };",
      "this.handlers['on' + kind]();",
    ].join("\n") + "\n";
    const py = "import importlib\nhandler = getattr(self, f'on_{name}')\nvalue = getattr(self, 'total')\nmod = importlib.import_module(name)\n";
    const report = audit(repo({ tracked: { "src/events.js": js, "app/events.py": py } }));
    assert.deepStrictEqual(finding(report, "runtime-names").evidence, ["app/events.py:2", "app/events.py:4", "src/events.js:2", "src/events.js:3", "src/events.js:8"]);
  });
});

describe("JavaScript and TypeScript exports", () => {
  test("default exports and re-export-only index files are reported, and config files are not", () => {
    const tracked = {
      "src/cart.ts": "export default function cart() {}\n",
      "src/index.ts": "export * from './cart';\nexport {\n  total,\n} from './total';\n",
      "src/total.ts": "export const total = 1;\n",
      "vite.config.ts": "export default {};\n",
    };
    const report = audit(repo({ tracked }));
    assert.deepStrictEqual(finding(report, "default-exports").evidence, ["src/cart.ts"]);
    assert.deepStrictEqual(finding(report, "re-export-files").evidence, ["src/index.ts"]);
  });
});

describe("map routes", () => {
  const engine = {
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "packages/price-engine/package.json": JSON.stringify({ main: "src/index.js" }),
    "packages/price-engine/src/index.js": "",
    "packages/price-engine/README.md": "# Price engine\n",
    "docs/agents.md": "Storefront prices come from `packages/price-engine/`. Run `npm test`.\n",
  };
  const entry = "entry packages/price-engine/src/index.js";

  test("an @path import loads into the map; a quoted one is a document the map names", () => {
    const imported = observed({ ...engine, "CLAUDE.md": "@AGENTS.md\n", "AGENTS.md": "# Shop\n\n@docs/agents.md\n" });
    assert.deepStrictEqual(evidence(imported, "map-routes"), [
      "CLAUDE.md: 1 line, imports AGENTS.md, docs/agents.md; names 1 path (0 documents), check command npm test",
      "AGENTS.md: 3 lines; names 1 path (1 document) and none of the check commands found: npm test",
    ]);
    assert.deepStrictEqual(evidence(imported, "package-routes"), [`packages/price-engine: named at docs/agents.md:1 (prose); ${entry}`]);

    const quoted = observed({ ...engine, "CLAUDE.md": "# Shop\n\nThe agent notes are `@docs/agents.md`.\n" });
    assert.deepStrictEqual(evidence(quoted, "map-routes"), ["CLAUDE.md: 3 lines; names 1 path (1 document) and none of the check commands found: npm test"]);
    assert.deepStrictEqual(evidence(quoted, "package-routes"), [`packages/price-engine: named in docs/agents.md:1, a document the map names at CLAUDE.md:3; ${entry}`]);
  });

  test("prose, a table, a tree and a link each name a package; a parent folder or a bare word does not", () => {
    const maps = [
      ["Storefront prices come from `packages/price-engine/`.\n", "named at AGENTS.md:3 (prose)"],
      ["| Path | Content |\n| --- | --- |\n| `packages/price-engine/` | Storefront prices |\n", "named at AGENTS.md:5 (table)"],
      ["```text\npackages/\n├── pricing/\n└── price-engine/   storefront prices\n```\n", "named at AGENTS.md:6 (tree)"],
      ["- [Storefront prices](packages/price-engine/README.md)\n", "named at AGENTS.md:3 (link)"],
      ["Shared libraries live in `packages/`.\n", "not named; its folder packages/ is, at AGENTS.md:3 (prose)"],
      ["The price-engine package prices the storefront.\n", "not named in the map or a document it names"],
    ];
    for (const [map, route] of maps) {
      const report = observed({ ...engine, "AGENTS.md": `# Shop\n\n${map}` });
      assert.deepStrictEqual(evidence(report, "package-routes"), [`packages/price-engine: ${route}; ${entry}`]);
    }
  });

  test("a short map that names nothing routes nowhere; length is judged apart", () => {
    const base = { "package.json": JSON.stringify({ scripts: { test: "node --test" } }), ".nvmrc": "22\n", "src/app.js": "" };
    const vague = observed({ ...base, "AGENTS.md": "# Shop\n\nBe careful, keep things tidy and write good tests.\n" });
    assert.deepStrictEqual(evidence(vague, "map-routes"), ["AGENTS.md: 3 lines; names no path or document and none of the check commands found: npm test"]);
    assertNo(vague, "map-file-long");
    const useful = "# Shop\n\nRun `npm test` before a change. The code is in `src/`.\n";
    assert.deepStrictEqual(evidence(observed({ ...base, "AGENTS.md": useful }), "map-routes"), ["AGENTS.md: 3 lines; names 1 path (0 documents), check command npm test"]);
    const long = observed({ ...base, "AGENTS.md": `${useful}${"More words.\n".repeat(200)}` });
    assert.strictEqual(finding(long, "map-file-long").severity, "medium");
    assert.deepStrictEqual(evidence(long, "map-routes"), ["AGENTS.md: 203 lines; names 1 path (0 documents), check command npm test"]);
  });

  test("a map naming another check than the ones found lists those; naming a found one is credited", () => {
    const gradle = { "build.gradle.kts": "", gradlew: "", "src/main/kotlin/App.kt": "" };
    const other = observed({ ...gradle, "CLAUDE.md": "# Plugin\n\nRun `./gradlew test` before a change.\n" });
    assert.deepStrictEqual(evidence(other, "map-routes"), ["CLAUDE.md: 3 lines; names 1 path (0 documents) and none of the check commands found: ./gradlew check"]);
    const found = observed({ ...gradle, "CLAUDE.md": "# Plugin\n\nRun `./gradlew check` before a change.\n" });
    assert.deepStrictEqual(evidence(found, "map-routes"), ["CLAUDE.md: 3 lines; names 1 path (0 documents), check command ./gradlew check"]);
  });
});

describe("package routes", () => {
  test("each package shows whether the map names it, a document it names does, or only its folder; direct routes come last", () => {
    const report = observed({
      "AGENTS.md": "# Shop\n\n| Path | Content |\n| --- | --- |\n| `packages/` | Shared libraries |\n| `packages/price-engine/` | Storefront prices |\n\nPartner limits: read [the partner guide](docs/partners.md).\n",
      "docs/partners.md": "# Partners\n\nThe client is `tools/partner-client/`.\n",
      "packages/price-engine/package.json": JSON.stringify({ main: "src/index.js" }),
      "packages/price-engine/src/index.js": "",
      "packages/pricing/package.json": "{}",
      "packages/pricing/index.js": "",
      "packages/ui/package.json": JSON.stringify({ exports: { ".": { import: "./dist/index.mjs" } } }),
      "tools/partner-client/package.json": JSON.stringify({ main: "lib/client.js" }),
      "services/rates/pyproject.toml": "[project]\nname = \"rates\"\n",
      "services/rates/rates.py": "",
    });
    assert.deepStrictEqual(evidence(report, "package-routes"), [
      "services/rates: not named in the map or a document it names; manifest pyproject.toml",
      "packages/pricing: not named; its folder packages/ is, at AGENTS.md:5 (table); no entry declared",
      "packages/ui: not named; its folder packages/ is, at AGENTS.md:5 (table); entry packages/ui/dist/index.mjs, build output",
      "tools/partner-client: named in docs/partners.md:3, a document the map names at AGENTS.md:8; entry tools/partner-client/lib/client.js, not found",
      "packages/price-engine: named at AGENTS.md:6 (table); entry packages/price-engine/src/index.js",
    ]);
  });

  test("a repository without packages below its root gets no package routes", () => {
    const report = observed({ "AGENTS.md": "# Shop\n\nThe code is in `src/`.\n", "package.json": "{}", "src/app.js": "" });
    assert.strictEqual(evidence(report, "package-routes"), undefined);
  });
});

describe("document sections", () => {
  test("a long document with headings is navigable, a long part without one is named, and other formats stay unknown", () => {
    const text = "The default page size is 20 and the maximum is 100. ".repeat(20);
    const report = observed({
      "AGENTS.md": "# Shop\n\nThe partner contract is [docs/contract.md](docs/contract.md).\n",
      "README.md": "Page sizes: [resource 3](docs/contract.md#limits-for-resource-3), [old limits](docs/contract.md#old-limits).\n",
      "docs/contract.md": `# Contract\n\n${Array.from({ length: 30 }, (_, i) => `## Limits for resource ${i + 1}\n\n${text}\n\n`).join("")}`,
      "docs/notes.md": `# Notes\n\n${"A line of running notes with no structure at all.\n".repeat(500)}`,
      "docs/short.md": "Short and flat.\n".repeat(50),
      "docs/guide.rst": `Guide\n=====\n\n${"Text of the guide.\n".repeat(1200)}`,
    });
    assert.deepStrictEqual(evidence(report, "document-sections"), [
      "docs/notes.md: 502 lines, 1 heading; lines 2-502 (25001 characters) have no heading",
      "docs/guide.rst: 1203 lines; headings in .rst files are not read, so its structure is unknown",
      "docs/contract.md: navigable, 122 lines, 31 headings; its longest part without a heading is 3 lines; 2 section links from 1 file; no heading for #old-limits (README.md:1)",
    ]);
  });

  test("a long map file is left to map-file-long", () => {
    const report = observed({ "AGENTS.md": `# Shop\n\n${"A long line of map text that goes on.\n".repeat(600)}` });
    assert.strictEqual(finding(report, "map-file-long").severity, "medium");
    assert.strictEqual(evidence(report, "document-sections"), undefined);
  });
});

describe("findings a route, a framework or a test explains", () => {
  test("duplicate names one per package are told apart from duplicates inside one package or outside packages", () => {
    const report = observed({
      "packages/cart/package.json": "{}", "packages/cart/src/format.js": "", "packages/cart/src/a/price.js": "", "packages/cart/src/b/price.js": "",
      "packages/orders/package.json": "{}", "packages/orders/src/format.js": "",
      "src/cart/total.js": "", "src/orders/total.js": "",
    });
    assert.deepStrictEqual(finding(report, "duplicate-names").evidence, [
      "format: packages/cart/src/format.js, packages/orders/src/format.js",
      "price: packages/cart/src/a/price.js, packages/cart/src/b/price.js",
      "total: src/cart/total.js, src/orders/total.js",
    ]);
    assert.deepStrictEqual(evidence(report, "package-local-names"), ["format: packages/cart/src/format.js, packages/orders/src/format.js"]);
  });

  test("paths a framework, language or manifest requires are explained, and other deep code is not", () => {
    const report = observed({
      "src/main/java/com/acme/shop/cart/Cart.java": "", "src/test/java/com/acme/shop/cart/CartTest.java": "",
      "app/(shop)/products/[id]/reviews/[reviewId]/page.tsx": "",
      "a/b/c/d/e/f/deep.js": "",
      "packages/ui/package.json": JSON.stringify({ main: "src/index.ts" }), "packages/ui/src/index.ts": "", "lib/a/index.ts": "", "lib/b/index.ts": "",
    });
    assert.strictEqual(finding(report, "deep-nesting").count, 4);
    assert.strictEqual(finding(report, "index-files").count, 3);
    assert.deepStrictEqual(evidence(report, "framework-paths"), [
      "deep-nesting: app/ (1 file), route files whose folders are URL segments",
      "deep-nesting: src/main/java/ (1 file), source folders that spell the package name",
      "deep-nesting: src/test/java/ (1 file), source folders that spell the package name",
      "index-files: packages/ui/src/index.ts, the entry packages/ui/package.json declares",
    ]);
  });

  test("a tracked dist folder that nothing builds is qualified, and a built one is not", () => {
    const report = observed({
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }), "dist/install.sh": "", "dist/nginx.conf": "", "src/app.js": "",
      "packages/kit/package.json": "{}", "packages/kit/tsconfig.json": '{ "compilerOptions": { "outDir": "dist" } }', "packages/kit/dist/index.js": "",
      "packages/tools/package.json": "{}", "packages/tools/dist/run.sh": "",
    });
    assert.deepStrictEqual(finding(report, "build-output-tracked").evidence, ["dist/ (2 files)", "packages/kit/dist/ (1 file)", "packages/tools/dist/ (1 file)"]);
    assert.deepStrictEqual(evidence(report, "source-dist"), [
      "dist/ (2 files): no build script, bundler config or compiler outDir in the root writes it",
      "packages/tools/dist/ (1 file): no build script, bundler config or compiler outDir in packages/tools/ or the root writes it",
    ]);
    const built = observed({ "package.json": JSON.stringify({ scripts: { build: "vite build", test: "node --test" } }), "dist/app.js": "", "src/app.js": "" });
    assert.deepStrictEqual(finding(built, "build-output-tracked").evidence, ["dist/ (1 file)"]);
    assert.strictEqual(evidence(built, "source-dist"), undefined);
  });

  test("fixtures and data that look like build output or large code are kept, and the rest is not explained", () => {
    const report = observed({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "node --test" } }), "dist/app.js": "",
      "tests/fixtures/app/dist/bundle.js": "", "tests/fixtures/app/node_modules/left-pad/index.js": "",
      "test/data/zones.js": codeLines(900), "src/big.js": codeLines(900),
    });
    assert.deepStrictEqual(finding(report, "build-output-tracked").evidence, ["dist/ (1 file)"]);
    assert.deepStrictEqual(finding(report, "large-files").evidence, ["src/big.js (900 lines)", "test/data/zones.js (900 lines)"]);
    assert.deepStrictEqual(evidence(report, "required-inputs"), ["generated-looking: tests/fixtures/ (2 files)", "large-files: test/data/zones.js (900 lines) under test/data/"]);
    assert.strictEqual(evidence(report, "source-dist"), undefined);
  });
});

describe("CLI", () => {
  test("prints observations after the findings, each with its note", () => {
    const root = repo({ tracked: { "AGENTS.md": "# Shop\n", "src/app.js": "" } });
    const { status, stdout } = spawnSync(process.execPath, [CLI, "--root", root], { encoding: "utf-8" });
    assert.strictEqual(status, 0);
    assert.match(stdout, /\nobservations \(informational\)\n {2}map-routes \(1\): .+\n {4}AGENTS\.md: 1 line; names no path or document\n {4}note: /);
  });

  test("prints a summary by default and the full report with --json", () => {
    const root = repo({ tracked: { "src/utils.js": "" } });
    const summary = spawnSync(process.execPath, [CLI, "--root", root], { encoding: "utf-8" });
    assert.strictEqual(summary.status, 0);
    assert.match(summary.stdout, /^anneal audit: /);
    assert.match(summary.stdout, /generic-names \(1\): /);
    const json = spawnSync(process.execPath, [CLI, "--root", root, "--json"], { encoding: "utf-8" });
    assert.strictEqual(json.status, 0);
    assert.strictEqual(JSON.parse(json.stdout).tool, "anneal-audit");
  });

  test("an unknown argument or a missing directory exits 2", () => {
    assert.strictEqual(spawnSync(process.execPath, [CLI, "--bogus"], { encoding: "utf-8" }).status, 2);
    const missing = path.join(os.tmpdir(), "anneal-audit-does-not-exist");
    assert.strictEqual(spawnSync(process.execPath, [CLI, "--root", missing], { encoding: "utf-8" }).status, 2);
  });

  test("an audit leaves the repository exactly as it was", () => {
    const root = repo({ tracked: { "src/app.js": "" }, untracked: { "notes.txt": "" } });
    const status = () => execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: root, encoding: "utf-8" });
    const before = status();
    assert.strictEqual(spawnSync(process.execPath, [CLI, "--root", root]).status, 0);
    assert.strictEqual(status(), before);
  });
});
