"use strict";

// docs-maintenance on small Git repositories built in temp directories, with commits at fixed
// dates and file times set by hand, and the CLI through its real entry point.

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
require("./temp-root.js");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const { maintain } = require("../scripts/docs-maintenance.js");

const CLI = path.join(__dirname, "..", "scripts", "docs-maintenance.js");

// Keep git from treating a temp directory as part of a repository above it.
process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();

const IGNORE = ".private/\ndocs/tasks/\ndocs/decisions/\ndocs/knowledge/private/\ndocs/apis/private/\n";
const doc = (related, extra = "") => `---\ntype: knowledge\nsummary: "Synthetic fixture."\nrelated_files:\n${related.map((r) => `  - ${r}\n`).join("")}${extra}---\n\n# Doc\n`;
const task = (status) => `---\ntype: task_summary\nsummary: "Synthetic fixture."\nrelated_files: []\nstatus: ${status}\n---\n`;
const DAY = 86400 * 1000;

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

const git = (root, args, env = {}) => execFileSync("git", ["-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { encoding: "utf8", env: { ...process.env, ...env } });

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anneal-docs-maintenance-"));
  created.push(root);
  git(root, ["init", "-q"]);
  fs.writeFileSync(path.join(root, ".git", "empty-excludes"), "");
  git(root, ["config", "core.excludesFile", path.join(root, ".git", "empty-excludes")]);
  write(root, { ".gitignore": IGNORE });
  return root;
}

function commit(root, files, date) {
  write(root, files);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", `fixture ${date}`], { GIT_AUTHOR_DATE: `${date}T12:00:00Z`, GIT_COMMITTER_DATE: `${date}T12:00:00Z` });
}

function age(root, file, days) {
  const when = new Date(Date.now() - days * DAY);
  fs.utimesSync(path.join(root, file), when, when);
}

const of = (report, id) => report.proposals.filter((p) => p.id === id).map((p) => `${p.path} ${p.detail}`);

test("a doc is drifting when a related file or directory was committed after it", () => {
  const root = repo();
  commit(root, { "src/a.js": "1", "src/b.js": "1", "src/lib/x.js": "1", "pkg/hooks/run.js": "1" }, "2026-09-01");
  commit(root, {
    "docs/knowledge/guide.md": doc(["src/a.js", "src/b.js", "src/lib/", "src/**"]),
    "docs/knowledge/fresh.md": doc(["src/b.js"]),
    "pkg/docs/knowledge/plugin.md": doc(["hooks/run.js"]),
    "docs/decisions/choice.md": doc(["src/a.js"]).replace("type: knowledge", "type: adr"),
    "docs/tasks/work.md": task("active").replace("related_files: []", "related_files: [src/a.js]"),
  }, "2026-10-01");
  commit(root, { "src/a.js": "2", "src/lib/x.js": "2", "pkg/hooks/run.js": "2" }, "2026-10-15");
  assert.deepStrictEqual(of(maintain(root), "drift"), [
    "docs/knowledge/guide.md last written 2026-10-01 (commit); changed since: src/a.js (2026-10-15), src/lib/ (2026-10-15)",
    "pkg/docs/knowledge/plugin.md last written 2026-10-01 (commit); changed since: hooks/run.js (2026-10-15)",
  ]);
});

test("uncommitted edits count from their file time, for the doc and for its related files", () => {
  const root = repo();
  commit(root, { "src/a.js": "1", "src/b.js": "1", "docs/knowledge/edited.md": doc(["src/a.js"]), "docs/knowledge/stale.md": doc(["src/b.js"]) }, "2026-10-01");
  commit(root, { "src/a.js": "2" }, "2026-10-15");
  // The doc caught up in the working tree after src/a.js's commit; src/b.js changed and was not committed.
  write(root, { "docs/knowledge/edited.md": doc(["src/a.js"]) + "\nUpdated.\n", "src/b.js": "2" });
  const report = maintain(root);
  assert.deepStrictEqual(of(report, "drift").map((line) => line.split(" ")[0]), ["docs/knowledge/stale.md"]);
  assert.match(of(report, "drift")[0], new RegExp(`src/b\\.js \\(${new Date().toISOString().slice(0, 10)}\\)`));
});

test("an ignored doc is dated by its file time", () => {
  const root = repo();
  commit(root, { "src/a.js": "1" }, "2026-10-15");
  write(root, { "docs/knowledge/private/old.md": doc(["src/a.js"]), "docs/knowledge/private/new.md": doc(["src/a.js"]) });
  age(root, "docs/knowledge/private/old.md", (Date.now() - Date.parse("2026-10-01T00:00:00Z")) / DAY);
  assert.deepStrictEqual(of(maintain(root), "drift-private").map((line) => line.split(" ")[0]), ["docs/knowledge/private/old.md"]);
});

test("a completed task note untouched for more than three days is proposed for folding", () => {
  const root = repo();
  write(root, {
    "docs/tasks/old-done.md": task("completed"),
    "docs/tasks/recent-done.md": task("completed"),
    "docs/tasks/old-active.md": task("active"),
  });
  age(root, "docs/tasks/old-done.md", 5);
  age(root, "docs/tasks/recent-done.md", 1);
  age(root, "docs/tasks/old-active.md", 30);
  const report = maintain(root);
  assert.deepStrictEqual(report.proposals.map((p) => `${p.id} ${p.path}`), ["fold-completed docs/tasks/old-done.md"]);
  assert.match(report.proposals[0].detail, /^completed, last written \d{4}-\d\d-\d\d \(file time\), no transcripts read; fold its findings/);
});

test("with transcripts, a completed note another session read within three days is kept", () => {
  const root = repo();
  write(root, { "docs/tasks/read-later.md": task("completed"), "docs/tasks/unread.md": task("completed"), "docs/tasks/read-too-late.md": task("completed") });
  for (const file of ["docs/tasks/read-later.md", "docs/tasks/unread.md", "docs/tasks/read-too-late.md"]) age(root, file, 10);
  const written = Date.now() - 10 * DAY;
  const at = (ms) => new Date(ms).toISOString();
  const use = (name, input, ms) => JSON.stringify({ type: "assistant", timestamp: at(ms), message: { content: [{ type: "tool_use", name, input }] } });
  const abs = (file) => path.join(root, file);
  const dir = path.join(root, ".private", "transcripts");
  write(root, {
    ".private/transcripts/writer.jsonl": [
      use("Write", { file_path: abs("docs/tasks/read-later.md") }, written),
      use("Write", { file_path: abs("docs/tasks/unread.md") }, written),
      use("Read", { file_path: abs("docs/tasks/unread.md") }, written + DAY),
    ].join("\n"),
    ".private/transcripts/reader.jsonl": [
      use("PowerShell", { command: "Get-Content docs\\tasks\\read-later.md" }, written + 2 * DAY),
      use("Read", { file_path: abs("docs/tasks/read-too-late.md") }, written + 5 * DAY),
      use("Bash", { command: "echo done >> docs/tasks/unread.md" }, written - 3000),
    ].join("\n"),
  });
  const report = maintain(root, { transcripts: [dir] });
  assert.deepStrictEqual(report.proposals.map((p) => p.path), ["docs/tasks/read-too-late.md", "docs/tasks/unread.md"]);
  assert.ok(report.proposals.every((p) => p.detail.includes("no other session read it within 3 days")));
});

test("oversized history is proposed for condensing and per-entry docs for merging", () => {
  const root = repo();
  const entry = (n) => `---\ntype: knowledge\nsummary: "Evidence from roadmap entry ${n}."\nrelated_files: []\n---\n`;
  write(root, {
    "docs/knowledge/private/history.md": doc([]) + "x".repeat(50000),
    "docs/knowledge/private/probe-one.md": entry(1),
    "docs/knowledge/private/probe-two.md": entry(2),
    "docs/knowledge/private/probe-three.md": entry(3),
    "docs/knowledge/private/trial-one.md": entry(4),
    "docs/knowledge/private/trial-two.md": entry(5),
    "docs/knowledge/private/probe-topic.md": doc([]),
  });
  const report = maintain(root);
  assert.deepStrictEqual(of(report, "condense").map((line) => line.split(" ")[0]), ["docs/knowledge/private/history.md"]);
  assert.deepStrictEqual(of(report, "merge-per-entry"), [
    "docs/knowledge/private/probe-*.md 3 docs, each summarized as one roadmap entry's evidence; merge them into one topic doc",
  ]);
});

test("each store record with paths goes to the docs that list them", () => {
  const root = repo();
  commit(root, {
    "src/a.js": "1",
    "src/lib/x.js": "1",
    "docs/knowledge/guide.md": doc(["src/a.js", "src/lib/"]),
    "docs/knowledge/overview.md": doc(["src/"]),
  }, "2026-10-01");
  write(root, { "docs/tasks/note.md": task("active").replace("related_files: []", "related_files: [src/a.js]") });
  write(root, {
    ".private/store.jsonl": [
      JSON.stringify({ text: "Covered.", paths: ["src/a.js"] }),
      "not json",
      JSON.stringify({ text: "Below a listed directory.", paths: ["src/lib/x.js"] }),
      JSON.stringify({ text: "Nobody lists it.", paths: ["tools/z.js"] }),
      JSON.stringify({ text: "No paths." }),
    ].join("\n"),
  });
  assert.deepStrictEqual(of(maintain(root, { stores: [".private/store.jsonl"] }), "fold-store"), [
    ".private/store.jsonl:1 fold into docs/knowledge/guide.md",
    ".private/store.jsonl:3 fold into docs/knowledge/guide.md",
    ".private/store.jsonl:4 no doc lists tools/z.js; keep it in a code comment or drop it",
  ]);
});

test("the CLI changes nothing, works before the first commit, and exits 2 on bad input", () => {
  const root = repo();
  write(root, { "docs/tasks/done.md": task("completed") });
  age(root, "docs/tasks/done.md", 10);
  const before = git(root, ["status", "--short", "--ignored"]);
  const result = spawnSync(process.execPath, [CLI, "--root", root, "--json"], { encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout).counts, { "fold-completed": 1 });
  assert.strictEqual(git(root, ["status", "--short", "--ignored"]), before);
  assert.strictEqual(fs.existsSync(path.join(root, "docs/tasks/done.md")), true);

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "anneal-docs-maintenance-"));
  created.push(plain);
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" }).status;
  assert.strictEqual(cli(["--root", plain]), 2);
  assert.strictEqual(fs.existsSync(path.join(plain, ".git")), false);
  assert.strictEqual(cli(["--root", root, "--store", "missing.jsonl"]), 2);
  assert.strictEqual(cli([]), 2);
  assert.strictEqual(cli(["--root", root, "--store"]), 2);
  assert.strictEqual(cli(["--root", root, "--transcripts", path.join(root, "missing")]), 2);
  assert.strictEqual(cli(["--help"]), 0);
});
