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
const { hostDefaults } = require("../scripts/audit.js");

const CLI = path.join(__dirname, "..", "scripts", "docs-maintenance.js");

// Keep git from treating a temp directory as part of a repository above it.
process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
// The CLI's host defaults find homes that do not exist, never the real ones.
process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), "no-claude-home");
process.env.CODEX_HOME = path.join(os.tmpdir(), "no-codex-home");

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

const memory = (modified, body) => `---\nname: fixture\ndescription: "Synthetic fixture."\nmetadata:\n  type: project\n  modified: ${modified}\n---\n\n${body}\n`;
const NOW = Date.parse("2026-11-02T12:00:00Z") / 1000;

test("a memory written weeks ago that states a current condition is flagged for a recheck", () => {
  const root = repo();
  write(root, {
    "mem/MEMORY.md": "- [Deleted sessions are recoverable](deleted-desktop-sessions-recoverable.md) — a deleted Desktop session can still be resumed\n",
    "mem/deleted-desktop-sessions-recoverable.md": memory("2026-10-05T10:00:00.000Z", "Deleting a Claude Code Desktop session keeps its transcript, so it can still be resumed with `claude --resume`."),
  });
  assert.deepStrictEqual(of(maintain(root, { memories: ["mem"], now: NOW }), "memory-stale-state"), [
    'mem/deleted-desktop-sessions-recoverable.md last modified 2026-10-05 (modified field) and states a current condition: "Deleting a Claude Code Desktop session keeps its transcript, so it can still be resumed with `claude --resume`."; recheck it, then update or delete it',
  ]);
});

test("memory flags: missing named path, command or flag, near-duplicate pair, index line with no file, file with no index line", () => {
  const root = repo();
  commit(root, { "scripts/run.js": "--root", "package.json": '{"scripts":{"check":"node --test"}}' }, "2026-10-01");
  const fresh = "2026-10-30T00:00:00.000Z";
  write(root, {
    "mem/MEMORY.md": [
      "- [Run](run.md) — how to run",
      "- [Gone](./gone.md#why) — deleted earlier",
      "- [Export one](export-one.md) — export",
      "- [Export two](export-two.md) — export",
    ].join("\n"),
    "mem/run.md": memory(fresh, "Run `node scripts/run.js --root .`, not `scripts/old.js` or `node scripts/old.js --gone-flag`; `npm run gone` and `npm run check -- --removed-flag` are gone too, while `git log --oneline` is no project command; see [[export-one|the export]] and [[missing-note]]. Paths like `~/.claude/x` and `D:/x/y` are outside the project."),
    "mem/export-one.md": memory(fresh, "Image exports fail on the shared build machine; render them from the drawing laptop with the vector fonts installed."),
    "mem/export-two.md": memory(fresh, "Image exports fail on the shared build machine, so render them from the drawing laptop where the vector fonts are installed."),
    "mem/orphan.md": memory(fresh, "Nothing links this one."),
  });
  const report = maintain(root, { memories: ["mem"], now: NOW });
  assert.deepStrictEqual(report.proposals.filter((p) => p.id.startsWith("memory-")).map((p) => `${p.id} ${p.path}`), [
    "memory-index-orphan mem/MEMORY.md:2",
    "memory-unindexed mem/orphan.md",
    "memory-missing-path mem/run.md",
    "memory-duplicate mem/export-one.md",
  ]);
  assert.match(of(report, "memory-missing-path")[0], /names scripts\/old\.js, --gone-flag, npm run gone, --removed-flag, \[\[missing-note\]\], absent/);
  assert.match(of(report, "memory-index-orphan")[0], /links \.\/gone\.md#why, which does not exist/);
  assert.match(of(report, "memory-duplicate")[0], /with export-two\.md; merge the two$/);
});

test("memory spans that name another tool's refs, flags or files are not missing project paths", () => {
  const root = repo();
  commit(root, { "anneal/scripts/x.js": "x", "tests/x.test.js": "x", "scripts/run.js": "--root-dir --rooted" }, "2026-10-01");
  const fresh = "2026-10-30T00:00:00.000Z";
  write(root, {
    "mem/MEMORY.md": "- [Steps](steps.md) — owner steps\n- [Logs](logs.md) — evidence names\n- [Refs](refs.md) — other tools\n",
    "mem/steps.md": memory(fresh, "Never recommend `git branch -D draft/spike` to the owner."),
    "mem/logs.md": memory(fresh, "A script such as `run.sh` may write `out/trace/output.txt`."),
    "mem/refs.md": memory(fresh, "Compare against `origin/main`, send `application/json`, read `git log --oneline anneal/scripts/x.js` and run `node --test tests/x.test.js`; `node scripts/run.js --root` takes a flag."),
  });
  assert.deepStrictEqual(of(maintain(root, { memories: ["mem"], now: NOW }), "memory-missing-path"), [
    "mem/refs.md names --root, absent from the project or the memory folder",
  ]);
});

test("memory scripts run by an interpreter have their paths and flags checked; git refs, other workspaces and node option values do not", () => {
  const root = repo();
  commit(root, { "scripts/run.js": "--root", "tools/keep.py": "x" }, "2026-10-01");
  const fresh = "2026-10-30T00:00:00.000Z";
  write(root, {
    "mem/MEMORY.md": "- [Tools](tools.md) — other interpreters\n- [Refs](refs.md) — git refs\n- [Away](away.md) — elsewhere\n- [Preload](preload.md) — node options\n",
    "mem/tools.md": memory(fresh, "Run `bash scripts/gone.sh --gone-sh`, `sh scripts/run.js --gone-sh2`, `py tools/gone.py --gone-py`, `python tools/keep.py --gone-python`, `pwsh scripts/run.js --gone-pwsh` or `node run.js --gone-root`, not `python -m tools.keep --module-flag`; `./scripts/old.js` is gone too."),
    "mem/refs.md": memory(fresh, "`git checkout scripts/hotfix`, `git switch -c scripts/next`, `git push origin scripts/hotfix`, `git branch -D scripts/old`, `git merge scripts/hotfix` and `git rebase scripts/base` name refs; `git checkout -- scripts/lost.js` names a path."),
    "mem/away.md": memory(fresh, "The sibling checkout has `../other-repo/src/x.js`; `./gone/x.js` sat under a removed folder."),
    "mem/preload.md": memory(fresh, "Debug with `node --import ./scripts/run.js --inspect scripts/run.js --root`."),
  });
  assert.deepStrictEqual(of(maintain(root, { memories: ["mem"], now: NOW }), "memory-missing-path"), [
    "mem/refs.md names scripts/lost.js, absent from the project or the memory folder",
    "mem/tools.md names scripts/gone.sh, --gone-sh, --gone-sh2, tools/gone.py, --gone-py, --gone-python, --gone-pwsh, --gone-root, ./scripts/old.js, absent from the project or the memory folder",
  ]);
});

test("a missing root-level file written as ./name is a missing memory path", () => {
  const root = repo();
  commit(root, { "kept.js": "x" }, "2026-10-01");
  write(root, {
    "mem/MEMORY.md": "- [Root](root.md) — root files\n",
    "mem/root.md": memory("2026-10-30T00:00:00.000Z", "Run `./gone.js`, not `./kept.js`."),
  });
  assert.deepStrictEqual(of(maintain(root, { memories: ["mem"], now: NOW }), "memory-missing-path"), [
    "mem/root.md names ./gone.js, absent from the project or the memory folder",
  ]);
});

test("a memory flag found only in a committed binary file is present", () => {
  const root = repo();
  commit(root, { "scripts/run.js": "x", "bin/tool.bin": "\0\x01--binflag\0" }, "2026-10-01");
  write(root, {
    "mem/MEMORY.md": "- [Bin](bin.md) — binary flag\n",
    "mem/bin.md": memory("2026-10-30T00:00:00.000Z", "Run `node scripts/run.js --binflag`."),
  });
  assert.deepStrictEqual(of(maintain(root, { memories: ["mem"], now: NOW }), "memory-missing-path"), []);
});

test("a node option's path value is not the script, so node's own flags after it are not checked", () => {
  const root = repo();
  commit(root, { "scripts/run.js": "--root" }, "2026-10-01");
  write(root, {
    "mem/MEMORY.md": "- [Report](report.md) — reporter\n",
    "mem/report.md": memory("2026-10-30T00:00:00.000Z", "Run `node --test-reporter-destination out/r.txt --test-reporter spec scripts/run.js --root` or `node --watch-path src/lib --cpu-prof-dir prof/out scripts/run.js --root`."),
  });
  assert.deepStrictEqual(of(maintain(root, { memories: ["mem"], now: NOW }), "memory-missing-path"), []);
});

test("each command of a memory span is read on its own", () => {
  const root = repo();
  commit(root, { "scripts/run.sh": "x", "scripts/run.js": "--root" }, "2026-10-01");
  write(root, {
    "mem/MEMORY.md": "- [Chain](chain.md) — chained commands\n",
    "mem/chain.md": memory("2026-10-30T00:00:00.000Z", "Run `bash scripts/run.sh && git log --oneline`, `node scripts/run.js --root | sh scripts/run.sh; git log --stat` and `git checkout scripts/hotfix && node scripts/gone.js`."),
  });
  assert.deepStrictEqual(of(maintain(root, { memories: ["mem"], now: NOW }), "memory-missing-path"), [
    "mem/chain.md names scripts/gone.js, absent from the project or the memory folder",
  ]);
});

test("an npm run script after a cd in the same span is not read against the root package.json", () => {
  const root = repo();
  commit(root, { "package.json": '{"scripts":{"check":"x"}}', "sub/package.json": '{"scripts":{"build":"x"}}' }, "2026-10-01");
  write(root, {
    "mem/MEMORY.md": "- [Sub](sub.md) — nested package\n",
    "mem/sub.md": memory("2026-10-30T00:00:00.000Z", "Run `cd sub && npm run build`; after `cd sub` a separate `npm run gone` is read at the root, and so is `npm run gone2`."),
  });
  assert.deepStrictEqual(of(maintain(root, { memories: ["mem"], now: NOW }), "memory-missing-path"), [
    "mem/sub.md names npm run gone, npm run gone2, absent from the project or the memory folder",
  ]);
});

test("a script outside the project, written as a ../ path, has no flags checked", () => {
  const root = repo();
  commit(root, { "scripts/run.sh": "x" }, "2026-10-01");
  write(root, {
    "mem/MEMORY.md": "- [Away](away.md) — another workspace\n",
    "mem/away.md": memory("2026-10-30T00:00:00.000Z", "Run `bash ../other-repo/deploy.sh --target-x`, `node ./../other-repo/tool.js --their-flag` or `bash scripts/run.sh --gone-flag`."),
  });
  assert.deepStrictEqual(of(maintain(root, { memories: ["mem"], now: NOW }), "memory-missing-path"), [
    "mem/away.md names --gone-flag, absent from the project or the memory folder",
  ]);
});

test("a dotted value of an unlisted node option is not the script", () => {
  const root = repo();
  commit(root, { "scripts/run.js": "--root" }, "2026-10-01");
  write(root, {
    "mem/MEMORY.md": "- [Pattern](pattern.md) — node options\n",
    "mem/pattern.md": memory("2026-10-30T00:00:00.000Z", "Run `node --test-name-pattern foo.bar --test scripts/run.js` or `node --snapshot-blob snap.blob --build-snapshot scripts/run.js`."),
  });
  assert.deepStrictEqual(of(maintain(root, { memories: ["mem"], now: NOW }), "memory-missing-path"), []);
});

test("a memory pass leaves the memory folder byte-identical", () => {
  const root = repo();
  commit(root, { "scripts/run.js": "--root" }, "2026-10-01");
  write(root, {
    "mem/MEMORY.md": "- [Run](run.md) — how to run\n- [Gone](gone.md) — deleted\n",
    "mem/run.md": memory("2026-09-01T00:00:00.000Z", "Run `node scripts/old.js --gone` while it is still pending."),
    "mem/orphan.md": memory("2026-09-01T00:00:00.000Z", "Nothing links this one."),
  });
  const snapshot = () => Object.fromEntries(fs.readdirSync(path.join(root, "mem")).map((n) => [n, fs.readFileSync(path.join(root, "mem", n))]));
  const before = snapshot();
  assert.ok(maintain(root, { memories: ["mem"], now: NOW }).proposals.length >= 4);
  assert.strictEqual(spawnSync(process.execPath, [CLI, "--root", root, "--memory", "mem"], { encoding: "utf8" }).status, 0);
  assert.deepStrictEqual(snapshot(), before);
});

test("a clean memory folder has no memory proposals", () => {
  const root = repo();
  commit(root, { "scripts/run.js": "--root", "package.json": '{"scripts":{"check":"node --test"}}' }, "2026-10-01");
  write(root, {
    "mem/MEMORY.md": "- [Run](./run.md) — how to run\n- [Login](<login.md#why>) — ask first\n- [Nested](sub/nested.md) — a linked file below the folder\n- [Spaced](my%20note.md?plain=1) — an encoded name with a query\n",
    "mem/my note.md": memory("2026-10-30T00:00:00.000Z", "Linked through an encoded target."),
    // Old, but states no current condition.
    "mem/run.md": memory("2026-09-01T00:00:00.000Z", "Run `node scripts/run.js --root .` or `npm run check` from the repository root; see [[login]], [[login|the login rule]] and [[login#why]]."),
    // States a current condition, but recently.
    "mem/login.md": memory("2026-10-30T00:00:00.000Z", "The owner still asks before every account-bound CLI run."),
    "mem/sub/nested.md": "Linked from the index by its relative path.\n",
  });
  assert.deepStrictEqual(maintain(root, { memories: ["mem"], now: NOW }).proposals, []);
});

test("the CLI reads the project's transcripts and memory folder from the host home unless a flag names them", () => {
  const root = repo();
  write(root, { "docs/tasks/done.md": task("completed"), "mem/MEMORY.md": "- [Kept](kept.md) — indexed\n", "mem/kept.md": memory("2026-10-30T00:00:00.000Z", "Indexed.") });
  age(root, "docs/tasks/done.md", 10);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "anneal-claude-home-"));
  created.push(home);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home };
  const { project, memory: memoryDir } = hostDefaults(root, env);
  write(memoryDir, { "MEMORY.md": "- [Kept](kept.md) — indexed\n", "kept.md": memory("2026-10-30T00:00:00.000Z", "Indexed."), "orphan.md": memory("2026-10-30T00:00:00.000Z", "Nothing links this one.") });
  const run = (...args) => spawnSync(process.execPath, [CLI, "--root", root, "--json", ...args], { encoding: "utf8", env });
  const ids = (result) => JSON.parse(result.stdout).proposals.map((p) => `${p.id} ${p.path} ${p.detail.includes("no transcripts read") ? "unread" : "read"}`);

  const derived = run();
  assert.strictEqual(derived.status, 0, derived.stderr);
  assert.strictEqual(derived.stderr, "");
  const [fold, orphan] = JSON.parse(derived.stdout).proposals;
  assert.deepStrictEqual(ids(derived).slice(0, 1), ["fold-completed docs/tasks/done.md read"]);
  // The memory proposal's path names the file.
  assert.strictEqual(orphan.id, "memory-unindexed");
  assert.ok(fs.existsSync(orphan.path.replace(/^~(?=\/)/, os.homedir().replace(/\\/g, "/"))), orphan.path);
  assert.strictEqual(fold.path, "docs/tasks/done.md");
  // A session in a worktree of the root counts as a reader.
  const worktree = `${project}--claude-worktrees-side`;
  const read = { type: "assistant", timestamp: new Date(Date.now() - 9 * 86400000).toISOString(), message: { content: [{ type: "tool_use", name: "Read", input: { file_path: path.join(root, "docs/tasks/done.md") } }] } };
  write(worktree, { "reader.jsonl": JSON.stringify(read) });
  assert.deepStrictEqual(ids(run()).filter((line) => line.startsWith("fold-completed")), []);
  fs.rmSync(worktree, { recursive: true });
  // Flags replace the defaults.
  assert.deepStrictEqual(ids(run("--transcripts", root, "--memory", "mem")), ["fold-completed docs/tasks/done.md read"]);

  // A missing default folder is one line each, and the run goes on.
  fs.rmSync(project, { recursive: true });
  const absent = run();
  assert.strictEqual(absent.status, 0);
  assert.match(absent.stderr, /^docs-maintenance\.js: no Claude Code transcripts folder at .*; pass --transcripts <directory> to name one\ndocs-maintenance\.js: no Claude Code memory folder with a MEMORY\.md at .*; pass --memory <directory> to name one\n$/);
  assert.deepStrictEqual(ids(absent), ["fold-completed docs/tasks/done.md unread"]);
});

test("a memory folder without MEMORY.md is refused", () => {
  const root = repo();
  write(root, { "docs/note.md": "# Note\n" });
  assert.throws(() => maintain(root, { memories: ["docs"], now: NOW }), /docs\/MEMORY\.md not found/);
  assert.strictEqual(spawnSync(process.execPath, [CLI, "--root", root, "--memory", "docs"], { encoding: "utf8" }).status, 2);
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
  assert.strictEqual(cli(["--root", root, "--memory", "missing"]), 2);
  assert.strictEqual(cli(["--help"]), 0);
});
