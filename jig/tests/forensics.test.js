"use strict";

// Entry 100 covers two halves of one job — read the project's own facts
// (`jig.js scan`) and read its history (`forensics.js`) — so both are tested
// here rather than splitting scan into the engine suite it does not belong to.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const engine = require("../scripts/jig.js");
const forensics = require("../scripts/forensics.js");
const catalogue = require("../scripts/catalogue.json");

const REPO_ROOT = path.join(__dirname, "..", "..");
const FORENSICS_SRC = fs.readFileSync(path.join(__dirname, "..", "scripts", "forensics.js"), "utf-8");

const cleanup = [];
test.after(() => {
  for (const dir of cleanup) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // A temp directory a virus scanner still holds open is not a test failure.
    }
  }
});

function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jig-" + tag + "-"));
  cleanup.push(dir);
  return dir;
}

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf-8", windowsHide: true });
  if (r.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + (r.stderr || r.stdout));
  return r.stdout;
}

function newRepo() {
  const root = tmpDir("forensics");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Test Human"]);
  git(root, ["config", "user.email", "human@example.com"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

// One commit. `author` overrides the committing identity; `trailer` appends a
// Co-Authored-By line, which is the only evidence a host writes about an agent
// having driven the change.
function commit(root, files, subject, opts) {
  const o = opts || {};
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    if (content === null) {
      fs.rmSync(full, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(root, ["add", "-A"]);
  const args = ["commit", "-q", "--no-verify", "-m", subject];
  if (o.body) args.push("-m", o.body);
  if (o.trailer) args.push("-m", o.trailer);
  if (o.author) args.push("--author=" + o.author);
  git(root, args);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

// Plain commits carrying nothing any catalogue detector looks for, so a
// fixture's signal count is exactly what the fixture put there.
function filler(root, count, from) {
  const start = from || 0;
  for (let i = start; i < start + count; i++) {
    commit(root, { ["src/f" + i + ".js"]: "module.exports = { n: " + i + " };\n" }, "add module " + i);
  }
}

const AGENT_TRAILER = "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>";

// A test about signals should not pay for twenty commits of scenery. The
// shipped minCommits is exercised by the young-history test below, which is
// where it belongs; everything else lowers it and seeds only its own signal.
const MINI = { thresholds: { minCommits: 4 } };

// ---------------------------------------------------------------------------
// Shape and schema discipline
// ---------------------------------------------------------------------------

test("forensics ships at schemaVersion 1 with its thresholds stated as data", () => {
  assert.equal(forensics.SCHEMA_VERSION, 1);
  assert.equal(forensics.SCHEMA_VERSION, engine.SCHEMA_VERSION);
  assert.equal(forensics.THRESHOLDS.minCommits, 20);
  assert.equal(forensics.THRESHOLDS.clearedSignals, 2);
});

test("every git call forensics makes is a read", () => {
  const verbs = [...FORENSICS_SRC.matchAll(/git\(\s*root,\s*\[\s*"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(verbs.length >= 3, "expected several git calls, found " + verbs.length);
  assert.deepEqual([...new Set(verbs)].sort(), ["log", "rev-parse"]);
});

test("mining a repository leaves it exactly as it was", () => {
  const root = newRepo();
  filler(root, 8);
  const before = [git(root, ["status", "--porcelain"]), git(root, ["rev-parse", "HEAD"]), git(root, ["stash", "list"])];
  forensics.runForensics(root, MINI);
  const after = [git(root, ["status", "--porcelain"]), git(root, ["rev-parse", "HEAD"]), git(root, ["stash", "list"])];
  assert.deepEqual(after, before);
});

// ---------------------------------------------------------------------------
// The silent fallbacks — history shapes that cannot support a claim
// ---------------------------------------------------------------------------

test("a directory that is not a repository falls back without an error", () => {
  const out = forensics.runForensics(tmpDir("norepo"), {});
  assert.equal(out.ok, true);
  assert.equal(out.usable, false);
  assert.equal(out.fallback, "not-a-repository");
  assert.deepEqual(out.incidents, []);
  assert.equal(out.ranking.length, catalogue.classes.length);
});

test("a young history says nothing rather than guessing from six commits", () => {
  const root = newRepo();
  filler(root, 5);
  commit(root, { "src/f0.js": "module.exports = { n: 0, fixed: true };\n" }, "fix the thing");
  const out = forensics.runForensics(root, {});
  assert.equal(out.usable, false);
  assert.equal(out.fallback, "young-history");
  assert.deepEqual(out.incidents, []);
  assert.equal(out.repo.commits, 6);
});

test("a squash-merged history falls back even when the commits carry signal", () => {
  const root = newRepo();
  for (let i = 0; i < 25; i++) {
    commit(root, { ["src/hot.js"]: "// rev " + i + "\nmodule.exports = " + i + ";\n" }, "fix the parser (#" + i + ")");
  }
  const out = forensics.runForensics(root, {});
  assert.equal(out.repo.squashed, true);
  assert.equal(out.repo.merges, 0);
  assert.equal(out.usable, false);
  assert.equal(out.fallback, "squash-merged");
  assert.deepEqual(out.incidents, []);
});

test("one lonely signal is a coincidence, not an incident report", () => {
  const root = newRepo();
  filler(root, 22);
  commit(root, { "src/f0.js": "module.exports = { n: 0 };\n// undone\n" }, 'Revert "add module 0"');
  const out = forensics.runForensics(root, {});
  assert.deepEqual(out.cleared, ["revert"]);
  assert.equal(out.usable, false);
  assert.equal(out.fallback, "below-threshold");
  assert.deepEqual(out.incidents, []);
});

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

test("a revert is found by its subject and by its body", () => {
  const root = newRepo();
  commit(root, { "src/a.js": "//a\n" }, 'Revert "add module 3"');
  commit(root, { "src/b.js": "//b\n" }, "undo the parser change", { body: "This reverts commit deadbeef." });
  const found = forensics.reverts(forensics.readLog(root, 500));
  assert.equal(found.length, 2);
  assert.ok(found.every((r) => r.kind === "revert"));
});

test("three fixes on one file cluster and two do not", () => {
  const root = newRepo();
  for (let i = 0; i < 3; i++) commit(root, { "src/hot.js": "// fix " + i + "\n" }, "fix the hot path " + i);
  for (let i = 0; i < 2; i++) commit(root, { "src/warm.js": "// fix " + i + "\n" }, "fix the warm path " + i);
  const clusters = forensics.fixClusters(forensics.readLog(root, 500), forensics.THRESHOLDS.fixCluster);
  assert.deepEqual(clusters.map((c) => c.path), ["src/hot.js"]);
  assert.equal(clusters[0].count, 3);
});

test("churn needs eight commits on one file before it is a hotspot", () => {
  const root = newRepo();
  for (let i = 0; i < 8; i++) commit(root, { "src/hot.js": "// rev " + i + "\n" }, "touch hot " + i);
  for (let i = 0; i < 7; i++) commit(root, { "src/warm.js": "// rev " + i + "\n" }, "touch warm " + i);
  const spots = forensics.churn(forensics.readLog(root, 500), forensics.THRESHOLDS.churn);
  assert.deepEqual(spots.map((s) => s.path), ["src/hot.js"]);
  assert.equal(spots[0].count, 8);
});

test("a deleted test file is an incident and ranks the class that guards it", () => {
  const root = newRepo();
  filler(root, 4);
  commit(root, { "tests/thing.test.js": "assert.ok(true);\n" }, "add a test");
  commit(root, { "tests/thing.test.js": null }, "drop the flaky test");
  const out = forensics.runForensics(root, MINI);
  const deleted = out.incidents.filter((i) => i.kind === "test-file-deleted");
  assert.deepEqual(deleted.map((d) => d.path), ["tests/thing.test.js"]);
  const row = out.ranking.find((r) => r.classId === "test-file-deletion");
  assert.equal(row.hits, 1);
  assert.equal(row.basis, "forensics");
});

test("a test diff that removes more assertions than it adds is a weakened assertion", () => {
  const root = newRepo();
  filler(root, 4);
  commit(root, {
    "tests/thing.test.js": ["assert.equal(a, 1);", "assert.equal(b, 2);", "assert.equal(c, 3);", ""].join("\n"),
  }, "add three assertions");
  commit(root, { "tests/thing.test.js": ["assert.ok(a);", ""].join("\n") }, "loosen the test");
  const out = forensics.runForensics(root, MINI);
  const weak = out.incidents.filter((i) => i.kind === "assertion-reduced");
  assert.equal(weak.length, 1);
  assert.equal(weak[0].removed, 3);
  assert.equal(weak[0].added, 1);
  assert.equal(out.ranking.find((r) => r.classId === "weakened-assertion").hits, 1);
});

test("a test diff that adds assertions is not a weakened assertion", () => {
  const root = newRepo();
  filler(root, 4);
  commit(root, { "tests/thing.test.js": "assert.ok(a);\n" }, "add a test");
  commit(root, { "tests/thing.test.js": "assert.ok(a);\nassert.equal(b, 2);\n" }, "tighten the test");
  const out = forensics.runForensics(root, MINI);
  assert.equal(out.incidents.filter((i) => i.kind === "assertion-reduced").length, 0);
});

// ---------------------------------------------------------------------------
// Attribution — best-effort, and labelled as such
// ---------------------------------------------------------------------------

test("a Co-Authored-By trailer naming an agent outranks the human author line", () => {
  assert.equal(forensics.attribute("Test Human", "human@example.com", AGENT_TRAILER), "agent");
  assert.equal(forensics.attribute("Test Human", "human@example.com", "just a body"), "human");
});

test("an agent in the author line is attributed without any trailer", () => {
  assert.equal(forensics.attribute("Claude", "noreply@anthropic.com", ""), "agent");
  assert.equal(forensics.attribute("Codex", "bot@openai.com", ""), "agent");
  assert.equal(forensics.attribute("Ada Lovelace", "ada@example.com", ""), "human");
});

test("attribution survives a real repository and is labelled best-effort", () => {
  const root = newRepo();
  filler(root, 4);
  commit(root, { "src/x.js": "//x\n" }, "agent change", { trailer: AGENT_TRAILER });
  commit(root, { "src/y.js": "//y\n" }, "human change");
  const commits = forensics.readLog(root, 500);
  assert.equal(commits.find((c) => c.subject === "agent change").actor, "agent");
  assert.equal(commits.find((c) => c.subject === "human change").actor, "human");
  const out = forensics.runForensics(root, MINI);
  assert.match(out.attribution, /best-effort/);
});

// ---------------------------------------------------------------------------
// The injection firewall
// ---------------------------------------------------------------------------

test("every content pattern forensics matches on is one the catalogue ships", () => {
  const shipped = fs.readFileSync(path.join(__dirname, "..", "scripts", "catalogue.json"), "utf-8");
  const detectors = forensics.contentDetectors();
  assert.ok(detectors.length > 0);
  for (const det of detectors) {
    assert.ok(catalogue.classes.some((c) => c.id === det.classId), det.classId + " is not a catalogue class");
    for (const re of det.patterns) {
      assert.ok(shipped.includes(JSON.stringify(re.source).slice(1, -1)), "pattern not from the catalogue: " + re.source);
    }
  }
});

test("nothing mined from a repository comes back out as a matcher", () => {
  const root = newRepo();
  filler(root, 4);
  // A commit whose own content looks like configuration. It may rank a class;
  // it may never become one.
  commit(root, { "src/evil.js": 'const patterns = ["OWNED-BY-THE-REPO"];\ntry { x(); } catch {}\n' }, "add evil");
  commit(root, { "tests/evil.test.js": "it.only('x', () => { assert.ok(1); });\n" }, "focus a test");
  const out = forensics.runForensics(root, MINI);
  const text = JSON.stringify(out);
  assert.ok(!text.includes("OWNED-BY-THE-REPO"), "repository content reached the forensics record");
  assert.ok(!/"(patterns|regex|matcher|params)"/.test(text), "forensics emitted something matcher-shaped");
  for (const row of out.ranking) {
    assert.deepEqual(Object.keys(row).sort(), ["actors", "basis", "classId", "examples", "hits", "installableAtV1", "severity", "title"]);
  }
});

test("catalogue patterns found in added lines rank their own class", () => {
  const root = newRepo();
  filler(root, 4);
  commit(root, { "src/swallow.js": "try { risky(); } catch {}\n" }, "wrap the risky call");
  commit(root, { "tests/focus.test.js": "it.only('one', () => {});\n" }, "focus one test");
  const out = forensics.runForensics(root, MINI);
  assert.equal(out.usable, true);
  assert.deepEqual(out.cleared, ["content:focused-or-skipped-test", "content:silent-catch"]);
  assert.ok(out.ranking.find((r) => r.classId === "silent-catch").hits >= 1);
  assert.ok(out.ranking.find((r) => r.classId === "focused-or-skipped-test").hits >= 1);
});

test("two different classes in the history are two signals, one class is not", () => {
  const root = newRepo();
  filler(root, 4);
  commit(root, { "src/swallow.js": "try { risky(); } catch {}\n" }, "wrap the risky call");
  const only = forensics.runForensics(root, MINI);
  assert.deepEqual(only.cleared, ["content:silent-catch"]);
  assert.equal(only.fallback, "below-threshold");

  commit(root, { "tests/focus.test.js": "it.only('one', () => {});\n" }, "focus one test");
  const both = forensics.runForensics(root, MINI);
  assert.equal(both.cleared.length, 2);
  assert.equal(both.usable, true);
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

test("the fallback ordering is the catalogue's own argument, installable first", () => {
  const order = forensics.catalogueOrder();
  assert.equal(order.length, catalogue.classes.length);
  const lastInstallable = order.map((c) => c.installableAtV1 === true).lastIndexOf(true);
  const firstNot = order.map((c) => c.installableAtV1 === true).indexOf(false);
  assert.ok(firstNot === -1 || lastInstallable < firstNot, "an installable class ranked below one that is not");
});

test("the whole spine is always returned, ranked by hits, zero-hit classes last", () => {
  const root = newRepo();
  filler(root, 4);
  commit(root, { "src/swallow.js": "try { risky(); } catch {}\n" }, "wrap it");
  commit(root, { "src/more.js": "try { a(); } catch {}\ntry { b(); } catch {}\n" }, "wrap two more");
  commit(root, { "tests/gone.test.js": "assert.ok(1);\n" }, "add a test");
  commit(root, { "tests/gone.test.js": null }, "drop the test");
  const out = forensics.runForensics(root, MINI);
  assert.equal(out.usable, true);
  assert.equal(out.ranking.length, catalogue.classes.length);
  assert.ok(out.ranking[0].hits >= 1, "the top row has no hits");
  assert.equal(out.ranking[out.ranking.length - 1].hits, 0);
  assert.deepEqual(
    [...out.ranking].map((r) => r.hits).sort((a, b) => b - a),
    out.ranking.map((r) => r.hits),
    "ranking is not sorted by hits",
  );
});

test("a glob from the catalogue matches nested paths and stops at the extension", () => {
  const re = forensics.globToRegExp("**/*.js");
  assert.ok(re.test("src/deep/a.js"));
  assert.ok(re.test("a.js"));
  assert.ok(!re.test("a.ts"));
  assert.ok(forensics.diffPathspec().includes("*.js"));
});

test("the CLI prints one JSON object", () => {
  const root = newRepo();
  filler(root, 3);
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "forensics.js"), "--root", root], {
    encoding: "utf-8",
    windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.schemaVersion, 1);
});

// ---------------------------------------------------------------------------
// scan — the facts the interview is forbidden to ask for
// ---------------------------------------------------------------------------

function project(files) {
  const root = tmpDir("scan");
  for (const [rel, content] of Object.entries(files || {})) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function listFiles(root, prefix) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = (prefix || "") + entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(root, entry.name), rel + "/"));
    else out.push(rel);
  }
  return out.sort();
}

test("scan writes a profile at schemaVersion 1 and touches nothing else", () => {
  const root = project({ "src/a.js": "//a\n" });
  const before = listFiles(root);
  const out = engine.cmdScan(root);
  assert.equal(out.ok, true);
  assert.equal(out.profile, ".jig/profile.json");
  const written = JSON.parse(fs.readFileSync(path.join(root, ".jig", "profile.json"), "utf-8"));
  assert.equal(written.schemaVersion, 1);
  const added = listFiles(root).filter((f) => !before.includes(f));
  assert.deepEqual(added, [".jig/.gitignore", ".jig/profile.json"]);
});

test("the profile jig writes is one jig can read back", () => {
  const root = project({});
  engine.cmdScan(root);
  const { profile, warnings } = engine.readProfile(root);
  assert.deepEqual(warnings, []);
  assert.deepEqual(Object.keys(profile).sort(), [...engine.PROFILE_KEYS].sort());
});

test("a profile from a newer jig is refused rather than half-read", () => {
  const root = project({});
  engine.cmdScan(root);
  const file = path.join(root, ".jig", "profile.json");
  const record = JSON.parse(fs.readFileSync(file, "utf-8"));
  fs.writeFileSync(file, JSON.stringify({ ...record, schemaVersion: 2 }));
  assert.throws(() => engine.readProfile(root), /schemaVersion 2 and this engine reads 1/);
});

test("an unknown key at version 1 is warned about and ignored", () => {
  const root = project({});
  engine.cmdScan(root);
  const file = path.join(root, ".jig", "profile.json");
  const record = JSON.parse(fs.readFileSync(file, "utf-8"));
  fs.writeFileSync(file, JSON.stringify({ ...record, zones: ["src/"] }));
  const { profile, warnings } = engine.readProfile(root);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown key `zones`/);
  assert.equal(profile.schemaVersion, 1);
});

test("scan reads the stack instead of asking for it", () => {
  const root = project({
    "package.json": JSON.stringify({ name: "demo", type: "module", scripts: { test: "node --test" } }),
    "package-lock.json": "{}",
    "tsconfig.json": "{}",
    "eslint.config.js": "export default [];\n",
  });
  const { stack } = engine.cmdScan(root);
  assert.equal(stack.name, "demo");
  assert.equal(stack.moduleType, "module");
  assert.equal(stack.packageManager, "npm");
  assert.equal(stack.testScript, "node --test");
  assert.equal(stack.typescript, true);
  assert.equal(stack.eslintConfig, "eslint.config.js");
});

test("node-on-PATH is disclosed, and a version manager is disclosed with it", () => {
  const node = engine.nodeOnPath();
  assert.equal(node.onPath, true);
  assert.match(node.version, /^v\d+\./);
  const managed = ["FNM_DIR", "NVM_DIR", "VOLTA_HOME", "ASDF_DIR"].some((k) => process.env[k]);
  if (managed) {
    assert.ok(node.versionManager, "a version manager is set but scan reported none");
    assert.match(node.note, /only in a shell that initialised it/);
  } else {
    assert.equal(node.versionManager, null);
    assert.equal(node.note, null);
  }
});

test("the rule corpus is measured, and its token count says it is an estimate", () => {
  const root = project({
    "CLAUDE.md": "x".repeat(400),
    ".claude/rules/a.md": "y".repeat(200),
    ".claude/rules/notes.txt": "ignored",
  });
  const rules = engine.ruleCorpus(root);
  assert.deepEqual(rules.files.map((f) => f.path), ["CLAUDE.md", ".claude/rules/a.md"]);
  assert.equal(rules.bytes, 600);
  assert.equal(rules.approxTokens, 150);
  assert.match(rules.estimate, /not a tokenizer/);
});

// ---------------------------------------------------------------------------
// The conflict pre-flight
// ---------------------------------------------------------------------------

test("an empty project leaves every slot free", () => {
  const out = engine.cmdScan(project({}));
  assert.deepEqual(out.occupied, []);
  assert.deepEqual(out.disclosures.filter((d) => /slot|chain/.test(d)), []);
  assert.equal(out.slots.length, engine.FILE_SLOTS.length + engine.HOOK_SLOTS.length);
});

test("a file already sitting in a slot is refused, not written over", () => {
  const root = project({ ".github/workflows/jig.yml": "name: someone else's\n" });
  const out = engine.cmdScan(root);
  assert.deepEqual(out.occupied, ["ci-workflow"]);
  assert.equal(out.slots.find((s) => s.slot === "ci-workflow").free, false);
  assert.ok(out.disclosures.some((d) => d.includes(".github/workflows/jig.yml already exists")));
  assert.equal(fs.readFileSync(path.join(root, ".github/workflows/jig.yml"), "utf-8"), "name: someone else's\n");
});

test("a hook already registered for the same tool occupies the slot, with the reason said out loud", () => {
  const root = project({
    ".claude/settings.json": JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["./guard.js"] }] }],
      },
    }),
  });
  const out = engine.cmdScan(root);
  assert.deepEqual(out.occupied, ["PreToolUse:Bash"]);
  const slot = out.slots.find((s) => s.slot === "PreToolUse:Bash");
  assert.equal(slot.free, false);
  assert.ok(slot.occupiedBy[0].includes(".claude/settings.json"));
  assert.ok(slot.occupiedBy[0].includes("node ./guard.js"));
  assert.ok(out.disclosures.some((d) => d.includes("do not chain")));
});

test("a wildcard matcher takes every slot for its event", () => {
  const root = project({
    ".claude/settings.local.json": JSON.stringify({
      hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "./wide.sh" }] }] },
    }),
  });
  const out = engine.cmdScan(root);
  assert.deepEqual(out.occupied, ["PostToolUse:Edit|Write"]);
});

test("a matcher that misses jig's tools leaves the slot free", () => {
  const root = project({
    ".claude/settings.json": JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "^WebFetch$", hooks: [{ type: "command", command: "./net.js" }] }] },
    }),
  });
  assert.deepEqual(engine.cmdScan(root).occupied, []);
});

test("a matcher that is not valid regex is compared as text instead of throwing", () => {
  assert.equal(engine.matcherMatches("Edit|Write", "Edit"), true);
  assert.equal(engine.matcherMatches("Edit|Write", "Bash"), false);
  assert.equal(engine.matcherMatches("[unclosed", "Bash"), false);
  assert.equal(engine.matcherMatches("[unclosed", "[unclosed"), true);
  assert.equal(engine.matcherMatches(null, "Bash"), true);
});

test("jig does not report its own hooks as the thing occupying its own slots", () => {
  const rows = engine.collectHooks(REPO_ROOT);
  assert.deepEqual(rows.filter((r) => r.source === "jig/hooks/hooks.json"), []);
  assert.ok(rows.length > 0, "expected this repository's own hooks to be inventoried");
});

test("an in-tree plugin's hooks are inventoried alongside settings", () => {
  const root = project({
    "otherplugin/hooks/hooks.json": JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["r.js"] }] }] },
    }),
  });
  const out = engine.cmdScan(root);
  assert.deepEqual(out.guardrails.hooks.map((h) => h.source), ["otherplugin/hooks/hooks.json"]);
  assert.deepEqual(out.occupied, ["PreToolUse:Bash"]);
});

test("unreadable settings are skipped rather than crashing the scan", () => {
  const root = project({ ".claude/settings.json": "{ not json" });
  const out = engine.cmdScan(root);
  assert.equal(out.ok, true);
  assert.deepEqual(out.guardrails.hooks, []);
});

// ---------------------------------------------------------------------------
// Governance-doc reachability (roadmap 110)

test("a governance doc no loaded surface references is an orphan, and the scan says so", () => {
  const root = project({
    "CLAUDE.md": "# House rules\n\n- Keep functions small.\n",
    "docs/adr/0001-storage.md": "# ADR 0001 — storage\n\nDecided.\n",
    "SCOPE.md": "# Scope\n\nWhat this project is.\n",
  });
  const scan = engine.cmdScan(root, { _: [], change: [] });
  const paths = scan.governance.docs.map((d) => d.path).sort();
  assert.deepEqual(paths, ["SCOPE.md", "docs/adr/0001-storage.md"]);
  assert.deepEqual(scan.governance.orphans.sort(), ["SCOPE.md", "docs/adr/0001-storage.md"]);
  assert.ok(scan.disclosures.some((d) => d.includes("docs/adr/0001-storage.md") && d.includes("never read it")));
});

test("a referenced governance doc is not an orphan, and names its referencing surface", () => {
  const root = project({
    "CLAUDE.md": "# House rules\n\nRead docs/adr/0001-storage.md before touching storage.\n",
    "docs/adr/0001-storage.md": "# ADR 0001 — storage\n",
  });
  const scan = engine.cmdScan(root, { _: [], change: [] });
  const doc = scan.governance.docs.find((d) => d.path === "docs/adr/0001-storage.md");
  assert.deepEqual(doc.referencedBy, ["CLAUDE.md"]);
  assert.deepEqual(scan.governance.orphans, []);
});

test("a project with no governance docs scans clean and quiet", () => {
  const root = project({ "src/index.js": "module.exports = 1;\n" });
  const scan = engine.cmdScan(root, { _: [], change: [] });
  assert.deepEqual(scan.governance, { docs: [], orphans: [] });
  assert.equal(scan.disclosures.some((d) => d.includes("governance")), false);
});
