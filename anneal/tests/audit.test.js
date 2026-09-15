"use strict";

// The audit's findings on small repositories built in temp directories, and
// the CLI through its real entry point.

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

describe("map file", () => {
  test("a missing CLAUDE.md is reported, pointing at AGENTS.md when it exists", () => {
    const report = audit(repo({ tracked: { "AGENTS.md": "# rules\n", "src/app.js": "" } }));
    const hit = finding(report, "map-file-missing");
    assert.strictEqual(hit.severity, "high");
    assert.match(hit.evidence[0], /AGENTS\.md exists/);
  });

  test("a short CLAUDE.md counts, at the root or under .claude/", () => {
    assertNo(audit(repo({ tracked: { "CLAUDE.md": "# map\n" } })), "map-file-missing");
    assertNo(audit(repo({ tracked: { ".claude/CLAUDE.md": "# map\n" } })), "map-file-missing");
  });

  test("a CLAUDE.md over 200 lines is reported as long", () => {
    const report = audit(repo({ tracked: { "CLAUDE.md": "line\n".repeat(201) } }));
    assert.match(finding(report, "map-file-long").title, /201 lines/);
    assertNo(audit(repo({ tracked: { "CLAUDE.md": "line\n".repeat(200) } })), "map-file-long");
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

describe("CLI", () => {
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
