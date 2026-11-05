"use strict";

// docs-check on small Git repositories built in temp directories, and the CLI through its real
// entry point. The ignore-rule and tracked-file cases came with the check from a user-level
// gitignore skill.

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
require("./temp-root.js");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const { check, frontmatter, linkTargets, recordIndex } = require("../scripts/docs-check.js");

const CLI = path.join(__dirname, "..", "scripts", "docs-check.js");

// Keep git from treating a temp directory as part of a repository above it.
process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();

const IGNORE = ".private/\ndocs/tasks/\ndocs/decisions/\ndocs/knowledge/private/\ndocs/apis/private/\n";
const NOTE = (type, extra = "") => `---\ntype: ${type}\nsummary: "Synthetic fixture."\nrelated_files: []\n${extra}---\n\n# Note\n`;

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

const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

// A repository with its own empty excludes file, so the machine's global ignore rules stay out.
// `tracked` is added to the index before `ignore` is written, as a file tracked before its rule.
function repo({ ignore = IGNORE, tracked = {}, files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anneal-docs-check-"));
  created.push(root);
  git(root, ["init", "-q"]);
  fs.writeFileSync(path.join(root, ".git", "empty-excludes"), "");
  git(root, ["config", "core.excludesFile", path.join(root, ".git", "empty-excludes")]);
  write(root, tracked);
  if (Object.keys(tracked).length) git(root, ["add", "--", ...Object.keys(tracked)]);
  write(root, { ".gitignore": ignore, ...files });
  return root;
}

const ids = (report, severity) => report.findings.filter((f) => !severity || f.severity === severity).map((f) => `${f.id} ${f.path}`);
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("a compliant project passes and its files, index and config stay unchanged", () => {
  const root = repo({
    tracked: {
      "README.md": "# Project\n\nSee [the contract](docs/knowledge/current-contract.md).\n",
      "docs/knowledge/current-contract.md": NOTE("knowledge"),
    },
    files: {
      "docs/tasks/240-docs-check.md": NOTE("task_summary", "status: active\n"),
      "docs/decisions/docs-visibility.md": NOTE("adr"),
      "docs/knowledge/private/research.md": NOTE("knowledge"),
      "docs/README.md": "# Docs\n",
    },
  });
  const before = git(root, ["status", "--short", "--ignored"]);
  const config = fs.readFileSync(path.join(root, ".git", "config"));
  const index = fs.readFileSync(path.join(root, ".git", "index"));
  const result = cli(["--root", root, "--json"]);
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.profile, "ignored");
  assert.strictEqual(report.docs, 5);
  assert.deepStrictEqual(report.findings, []);
  assert.strictEqual(git(root, ["status", "--short", "--ignored"]), before);
  assert.deepStrictEqual(fs.readFileSync(path.join(root, ".git", "config")), config);
  assert.deepStrictEqual(fs.readFileSync(path.join(root, ".git", "index")), index);
});

test("a broad docs ignore is reported as hiding public documentation", () => {
  const report = check(repo({ ignore: `${IGNORE}docs/\n` }));
  assert.deepStrictEqual(ids(report), [
    "public-ignored docs/README.md",
    "public-ignored docs/apis/current-api.md",
    "public-ignored docs/knowledge/current-contract.md",
  ]);
});

test("the profile comes from the ignore rules, and .private stays ignored in both", () => {
  const versioned = check(repo({ ignore: "" }));
  assert.strictEqual(versioned.profile, "versioned");
  assert.deepStrictEqual(ids(versioned), ["private-visible .private/"]);

  const mixed = check(repo({ ignore: ".private/\ndocs/tasks/\n" }));
  assert.strictEqual(mixed.profile, "ignored");
  assert.deepStrictEqual(ids(mixed), [
    "private-visible docs/apis/private/",
    "private-visible docs/decisions/",
    "private-visible docs/knowledge/private/",
  ]);
});

test("only a committed .gitignore counts toward the profile and .private", () => {
  // Machine-local excludes hide every private directory here, but a clone carries none of them.
  const root = repo({ ignore: "" });
  fs.writeFileSync(path.join(root, ".git", "empty-excludes"), "docs/tasks/\ndocs/decisions/\n.private/\n");
  fs.writeFileSync(path.join(root, ".git", "info", "exclude"), "docs/knowledge/private/\ndocs/apis/private/\n");
  const local = check(root);
  assert.strictEqual(local.profile, "versioned");
  assert.deepStrictEqual(ids(local), ["private-visible .private/"]);

  // A negation in the committed file leaves its path uncovered.
  const negated = check(repo({ ignore: IGNORE.replace("docs/tasks/\n", "docs/tasks/*\n!docs/tasks/docs-check-probe.md\n") }));
  assert.deepStrictEqual(ids(negated), ["private-visible docs/tasks/"]);
});

test("tracked private files are reported without leaving the index", () => {
  const tracked = { ".private/example.txt": "Synthetic.\n", "docs/decisions/example.md": NOTE("adr"), "pkg/docs/tasks/nested.md": NOTE("task_summary", "status: active\n") };
  const root = repo({ tracked });
  const before = git(root, ["ls-files", "-z"]);
  const report = check(root);
  assert.deepStrictEqual(ids(report, "high"), [
    "tracked-private .private/example.txt",
    "tracked-private docs/decisions/example.md",
    "tracked-private pkg/docs/tasks/nested.md",
  ]);
  assert.strictEqual(git(root, ["ls-files", "-z"]), before);
});

test("a versioned project may track its private documentation but not .private", () => {
  const report = check(repo({
    ignore: ".private/\n",
    tracked: { ".private/example.txt": "Synthetic.\n", "docs/decisions/example.md": NOTE("adr"), "README.md": "[Decision](docs/decisions/example.md)\n" },
  }));
  assert.strictEqual(report.profile, "versioned");
  assert.deepStrictEqual(ids(report, "high"), ["tracked-private .private/example.txt"]);
});

test("a public page linking a private path is reported, outside code only", () => {
  const report = check(repo({
    tracked: {
      "README.md": [
        "[task](docs/tasks/240-docs-check.md#status)",
        "[up](../docs/tasks/outside.md)",
        "[web](https://example.com/docs/tasks/x.md)",
        "[contract](docs/knowledge/current-contract.md)",
        "`[code](docs/tasks/inline.md)`",
        "```md\n[fenced](docs/tasks/fenced.md)\n```",
        "[ref]: .private/raw.txt",
      ].join("\n\n"),
      "pkg/docs/knowledge/guide.md": `${NOTE("knowledge")}\n[research](private/research.md)\n`,
    },
  }));
  assert.deepStrictEqual(report.findings.filter((f) => f.id === "public-links-private").map((f) => `${f.path} ${f.detail}`), [
    "README.md links docs/tasks/240-docs-check.md#status",
    "README.md links .private/raw.txt",
    "pkg/docs/knowledge/guide.md links private/research.md",
  ]);
});

test("oversized and completed task notes and oversized history docs are medium findings", () => {
  const report = check(repo({
    files: {
      "docs/tasks/big-note.md": NOTE("task_summary", "status: active\n") + "x".repeat(20000),
      "docs/tasks/done-note.md": NOTE("task_summary", "status: completed\n"),
      "docs/knowledge/private/history.md": NOTE("knowledge") + "x".repeat(50000),
      "docs/knowledge/private/short.md": NOTE("knowledge") + "x".repeat(40000),
      "docs/knowledge/reference.md": NOTE("knowledge") + "x".repeat(50000),
      "docs/knowledge/release-history.md": NOTE("knowledge") + "x".repeat(50000),
    },
  }));
  assert.deepStrictEqual(ids(report, "medium"), [
    "history-doc-large docs/knowledge/private/history.md",
    "history-doc-large docs/knowledge/release-history.md",
    "task-note-completed docs/tasks/done-note.md",
    "task-note-large docs/tasks/big-note.md",
  ]);
  assert.deepStrictEqual(ids(report, "low"), []);
});

test("frontmatter, type versus folder, related files and filenames are low findings", () => {
  const report = check(repo({
    files: {
      "src/kept.js": "",
      "docs/README.md": "# No frontmatter needed\n",
      "docs/knowledge/bare.md": "# No frontmatter\n",
      "docs/knowledge/partial.md": "---\ntype: knowledge\n---\n",
      "docs/knowledge/odd-type.md": NOTE("notes"),
      "docs/knowledge/task-here.md": NOTE("task_summary", "status: active\n"),
      "docs/decisions/wrong.md": NOTE("knowledge"),
      "docs/tasks/no-status.md": NOTE("task_summary"),
      "docs/tasks/240.md": NOTE("task_summary", "status: active\n"),
      "docs/tasks/240-with-slug.md": NOTE("task_summary", "status: active\n"),
      "docs/knowledge/Camel_Case.md": NOTE("knowledge"),
      "docs/knowledge/notes-2026-11-03.md": NOTE("knowledge"),
      "docs/knowledge/links.md": "---\ntype: knowledge\nsummary: x\nrelated_files:\n  - src/kept.js\n  - \"src/gone.js\"\n  - src/**\n---\n",
      "docs/apis/client.md": NOTE("api_spec"),
      "pkg/hooks/run.js": "",
      "pkg/docs/knowledge/plugin.md": "---\ntype: knowledge\nsummary: x\nrelated_files:\n  - hooks/run.js\n  - hooks/gone.js\n---\n",
    },
  }));
  assert.deepStrictEqual(ids(report, "low"), [
    "filename docs/knowledge/Camel_Case.md",
    "filename docs/knowledge/notes-2026-11-03.md",
    "filename docs/tasks/240.md",
    "frontmatter-field-missing docs/knowledge/partial.md",
    "frontmatter-field-missing docs/knowledge/partial.md",
    "frontmatter-field-missing docs/tasks/no-status.md",
    "frontmatter-missing docs/knowledge/bare.md",
    "frontmatter-type-unknown docs/knowledge/odd-type.md",
    "related-file-missing docs/knowledge/links.md",
    "related-file-missing pkg/docs/knowledge/plugin.md",
    "type-folder-mismatch docs/decisions/wrong.md",
    "type-folder-mismatch docs/knowledge/task-here.md",
  ]);
  assert.strictEqual(report.counts.high, 0);
});

test("docs inside ignored build output are skipped, ignored private docs are read", () => {
  const report = check(repo({
    ignore: `${IGNORE}out/\n`,
    files: { "out/run-1/docs/knowledge/Bad.md": "# Copy\n", "docs/knowledge/private/Bad_Name.md": NOTE("knowledge") },
  }));
  assert.strictEqual(report.docs, 1);
  assert.deepStrictEqual(ids(report), ["filename docs/knowledge/private/Bad_Name.md"]);
});

test("frontmatter and link parsing", () => {
  assert.strictEqual(frontmatter("# Title\n"), null);
  assert.deepStrictEqual(frontmatter("---\r\ntype: adr\r\nrelated_files: [\"a.js\", b.js]\r\n---\r\n"), { type: "adr", related_files: ["a.js", "b.js"] });
  assert.deepStrictEqual(linkTargets('[a](<b.md>) [c](c.md "title") ![i](img.png)'), ["b.md", "c.md", "img.png"]);
});

const INDEX_HEAD = '---\ntype: knowledge\nsummary: "Lists the path and summary line of every maintained record, grouped by type; generated by docs-check.js --index, read it to find a record before guessing a path."\nrelated_files: []\n---\n\n# Record index\n\nGenerated by `docs-check.js --index`; regenerate it instead of editing it.\n';
const RECORD = (type, summary, extra = "") => `---\ntype: ${type}\nsummary: "${summary}"\nrelated_files: []\n${extra}---\n\n# Record\n`;
const RECORDS = {
  "docs/knowledge/zeta.md": RECORD("knowledge", "Zeta."),
  "docs/knowledge/alpha.md": RECORD("knowledge", "Alpha."),
  "docs/apis/client.md": RECORD("api_spec", "Client."),
  "docs/decisions/choice.md": RECORD("adr", "Choice."),
  "docs/tasks/1-work.md": RECORD("task_summary", "Work.", "status: active\n"),
  "docs/knowledge/private/research.md": RECORD("knowledge", "Research."),
  "docs/knowledge/bare.md": "# No frontmatter\n",
  "docs/knowledge/odd.md": RECORD("notes", "Odd."),
  "docs/README.md": "# Docs\n",
  "docs/index.md": "stale\n",
  "pkg/docs/knowledge/plugin.md": RECORD("knowledge", "Plugin."),
  "pkg/docs/index.md": "stale\n",
  ".private/docs/knowledge/local.md": RECORD("knowledge", "Local."),
  "docs/knowledge/draft-secret.md": RECORD("knowledge", "Draft."),
  "docs/knowledge/excluded.md": RECORD("knowledge", "Excluded."),
};

test("the record index lists each public record's summary, grouped by type", () => {
  // A tracked file stays listed though a rule matches it; ignored untracked files never are.
  const root = repo({ ignore: `${IGNORE}docs/knowledge/draft-*.md\n`, tracked: { "docs/knowledge/draft-kept.md": RECORD("knowledge", "Kept.") }, files: RECORDS });
  fs.appendFileSync(path.join(root, ".git", "info", "exclude"), "docs/knowledge/excluded.md\n");
  const before = git(root, ["status", "--short", "--ignored"]);
  const result = cli(["--root", root, "--index"]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, `${INDEX_HEAD}
## api_spec

- \`docs/apis/client.md\`: Client.

## knowledge

- \`docs/knowledge/alpha.md\`: Alpha.
- \`docs/knowledge/draft-kept.md\`: Kept.
- \`docs/knowledge/zeta.md\`: Zeta.
- \`pkg/docs/knowledge/plugin.md\`: Plugin.

## other

- \`docs/knowledge/bare.md\`: (no summary)
- \`docs/knowledge/odd.md\`: Odd.
`);
  assert.strictEqual(git(root, ["status", "--short", "--ignored"]), before);

  // Versioned private records are tracked anyway, so they are listed; .private never is.
  const versioned = recordIndex(repo({ ignore: ".private/\n", files: RECORDS }));
  assert.ok(versioned.includes("\n## adr\n\n- `docs/decisions/choice.md`: Choice.\n"), versioned);
  assert.ok(versioned.includes("\n## task_summary\n\n- `docs/tasks/1-work.md`: Work.\n"), versioned);
  assert.ok(versioned.includes("- `docs/knowledge/private/research.md`: Research.\n"), versioned);
  assert.ok(!versioned.includes(".private/"), versioned);

  assert.strictEqual(recordIndex(repo()), INDEX_HEAD);
});

test("high findings exit 1, and bad arguments or no Git working tree exit 2 without creating one", () => {
  assert.strictEqual(cli(["--root", repo({ ignore: "" })]).status, 1);
  assert.strictEqual(cli(["--root", repo({ ignore: "" }), "--index"]).status, 0);
  assert.strictEqual(cli(["--root", repo(), "--index", "--json"]).status, 2);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "anneal-docs-check-"));
  created.push(plain);
  assert.strictEqual(cli(["--root", plain]).status, 2);
  assert.strictEqual(cli(["--root", plain, "--index"]).status, 2);
  assert.strictEqual(fs.existsSync(path.join(plain, ".git")), false);
  assert.strictEqual(cli([]).status, 2);
  assert.strictEqual(cli(["--unknown"]).status, 2);
  assert.strictEqual(cli(["--root", "--json"]).status, 2);
  assert.strictEqual(cli(["--help"]).status, 0);
});
