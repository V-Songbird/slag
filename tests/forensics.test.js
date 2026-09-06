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
const editions = require("../scripts/editions.js");

const PLUGIN_ROOT = path.join(__dirname, "..");
// The shelf forensics ranks over: every class of every shipped edition, under
// the same namespaced id the engine selects by.
const SHIPPED = editions.loadIndex(PLUGIN_ROOT).editions
  .flatMap((row) => editions.loadEdition(PLUGIN_ROOT, row.id).classes
    .map((cls) => ({ ...cls, id: editions.namespacedId(row.id, cls.id) })));
// What a Node fixture repository narrows to once its edition is detected.
const NODE_CLASSES = SHIPPED.filter((cls) => cls.id.startsWith("javascript-typescript/"));

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

function git(root, args, env) {
  const r = spawnSync("git", args, {
    cwd: root, encoding: "utf-8", windowsHide: true, env: { ...process.env, ...(env || {}) },
  });
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
  // `date` pins when the commit landed, which is the only way a test can put
  // one either side of an install timestamp deterministically.
  git(root, args, o.date ? { GIT_AUTHOR_DATE: o.date, GIT_COMMITTER_DATE: o.date } : null);
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
  assert.equal(out.ranking.length, SHIPPED.length);
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

test("a deleted test file is an incident once a second signal clears with it", () => {
  const root = newRepo();
  filler(root, 4);
  commit(root, { "tests/thing.test.js": "assert.ok(true);\n" }, "add a test");
  commit(root, { "tests/thing.test.js": null }, "drop the flaky test");

  // On its own it is one signal, and one signal is a coincidence.
  const alone = forensics.runForensics(root, MINI);
  assert.deepEqual(alone.cleared, ["test-file-deleted"]);
  assert.equal(alone.fallback, "below-threshold");
  assert.deepEqual(alone.incidents, []);

  // A second, different signal makes it evidence.
  commit(root, { "src/swallow.js": "try { risky(); } catch {}\n" }, "wrap the risky call");
  const out = forensics.runForensics(root, MINI);
  assert.equal(out.usable, true);
  const deleted = out.incidents.filter((i) => i.kind === "test-file-deleted");
  assert.deepEqual(deleted.map((d) => d.path), ["tests/thing.test.js"]);
  // It ranks a class only where the project's own edition ships one. This is a
  // Node repository, and that edition carries no deleted-test class, so the
  // incident stands on its own rather than being attributed to a foreign id.
  assert.ok(out.ranking.every((r) => r.edition === "javascript-typescript"));
  for (const row of out.ranking.filter((r) => r.classId.endsWith("/deleted-test") && r.hits > 0)) {
    assert.equal(row.basis, "forensics");
  }
});

// ---------------------------------------------------------------------------
// Stale pairs — the relation git carries for free
// ---------------------------------------------------------------------------

// A pair that co-changed `n` times and then let one side drift `alone` commits
// on its own. `n` and `alone` are what the thresholds are read against.
function pairHistory(root, n, alone) {
  for (let i = 0; i < n; i++) {
    commit(root, {
      "src/flags.js": "// flag " + i + "\n",
      "docs/flags.md": "flag " + i + "\n",
    }, "add flag " + i);
  }
  for (let i = 0; i < alone; i++) {
    commit(root, { "src/flags.js": "// flag drift " + i + "\n" }, "change a flag " + i);
  }
}

test("two files that changed together five times and then diverged are a stale pair", () => {
  const root = newRepo();
  filler(root, 4);
  pairHistory(root, 5, 3);
  const pairs = forensics.stalePairs(forensics.readLog(root, 500), forensics.THRESHOLDS);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].paths, ["docs/flags.md", "src/flags.js"]);
  assert.equal(pairs[0].moved, "src/flags.js");
  assert.equal(pairs[0].stale, "docs/flags.md");
  assert.equal(pairs[0].coChanges, 5);
  assert.equal(pairs[0].drifted, 3);
  // Correlation is the whole of the evidence, and the row says so itself.
  assert.match(pairs[0].confidence, /^best-effort —/);
});

test("a pair four commits deep, or drifting only twice, is not yet a stale pair", () => {
  const shallow = newRepo();
  pairHistory(shallow, 4, 5);
  assert.deepEqual(forensics.stalePairs(forensics.readLog(shallow, 500), forensics.THRESHOLDS), []);

  const barely = newRepo();
  pairHistory(barely, 6, 2);
  assert.deepEqual(forensics.stalePairs(forensics.readLog(barely, 500), forensics.THRESHOLDS), []);
});

test("a pair still changing together has not diverged", () => {
  const root = newRepo();
  pairHistory(root, 6, 3);
  commit(root, { "src/flags.js": "// back\n", "docs/flags.md": "back\n" }, "document the drift");
  assert.deepEqual(forensics.stalePairs(forensics.readLog(root, 500), forensics.THRESHOLDS), []);
});

test("both files moving alone since the last co-change is drift, not a lapsed relation", () => {
  const root = newRepo();
  pairHistory(root, 6, 3);
  commit(root, { "docs/flags.md": "an unrelated edit\n" }, "tidy the doc");
  assert.deepEqual(forensics.stalePairs(forensics.readLog(root, 500), forensics.THRESHOLDS), []);
});

test("two busy files that also change alone between co-changes are not a pair", () => {
  const root = newRepo();
  // Five co-changes, but src/hot.js also moved alone between every one of
  // them. That is a churning package, not a relation: the support ratio is the
  // only thing that tells the two shapes apart.
  for (let i = 0; i < 5; i++) {
    commit(root, { "src/hot.js": "// hot " + i + "\n", "docs/flags.md": "note " + i + "\n" }, "touch both " + i);
    commit(root, { "src/hot.js": "// hot alone " + i + "\n" }, "touch hot alone " + i);
  }
  // Enough drift on the end that only the support ratio is left to reject it.
  for (let i = 0; i < 3; i++) commit(root, { "src/hot.js": "// drift " + i + "\n" }, "drift " + i);
  assert.deepEqual(forensics.stalePairs(forensics.readLog(root, 500), forensics.THRESHOLDS), []);
});

test("a sweeping commit relates everything to everything and is skipped for pairing", () => {
  const root = newRepo();
  for (let i = 0; i < 6; i++) {
    const sweep = {};
    for (let f = 0; f < 25; f++) sweep["src/wide" + f + ".js"] = "// v" + i + "\n";
    commit(root, sweep, "reformat everything " + i);
  }
  for (let i = 0; i < 3; i++) commit(root, { "src/wide0.js": "// drift " + i + "\n" }, "edit one of them " + i);
  assert.deepEqual(forensics.stalePairs(forensics.readLog(root, 500), forensics.THRESHOLDS), []);
});

test("a stale pair is an incident, and it counts as one cleared signal", () => {
  const root = newRepo();
  filler(root, 4);
  pairHistory(root, 5, 3);

  // src/flags.js lands in eight commits here, which is a churn hotspot too, so
  // this fixture reads the pair on its own by lifting churn out of the way.
  const only = { thresholds: { minCommits: 4, churn: 20 } };

  // On its own it is one signal, and one signal is a coincidence.
  const alone = forensics.runForensics(root, only);
  assert.deepEqual(alone.cleared, ["stale-pair"]);
  assert.equal(alone.fallback, "below-threshold");

  commit(root, { "tests/thing.test.js": "assert.ok(true);\n" }, "add a test");
  commit(root, { "tests/thing.test.js": null }, "drop the flaky test");
  const out = forensics.runForensics(root, only);
  assert.equal(out.usable, true);
  const stale = out.incidents.filter((i) => i.kind === "stale-pair");
  assert.equal(stale.length, 1);
  assert.deepEqual(stale[0].paths, ["docs/flags.md", "src/flags.js"]);
  assert.equal(stale[0].actors.human, 5);
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
  assert.equal(out.ranking.find((r) => r.classId === "javascript-typescript/softened-assertion").hits, 1);
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

test("every content pattern forensics matches on is one an edition ships", () => {
  // Compiled against compiled, never against the file text: `RegExp.source`
  // normalises an unescaped `/` to an escaped one, so a string comparison
  // would fail on shipped data that is perfectly fine.
  const shipped = new Set();
  for (const cls of SHIPPED) {
    for (const det of cls.detectors || []) {
      for (const src of (det.params && det.params.patterns) || []) shipped.add(new RegExp(src).source);
    }
  }
  const detectors = forensics.contentDetectors();
  assert.ok(detectors.length > 0);
  for (const det of detectors) {
    assert.ok(SHIPPED.some((c) => c.id === det.classId), det.classId + " is not a shipped class");
    for (const re of det.patterns) {
      assert.ok(shipped.has(re.source), "pattern not from an edition: " + re.source);
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
    assert.deepEqual(Object.keys(row).sort(), ["actors", "basis", "classId", "edition", "examples", "hits", "severity", "title"]);
  }
});

test("catalogue patterns found in added lines rank their own class", () => {
  const root = newRepo();
  filler(root, 4);
  commit(root, { "src/swallow.js": "try { risky(); } catch {}\n" }, "wrap the risky call");
  commit(root, { "tests/focus.test.js": "it.only('one', () => {});\n" }, "focus one test");
  const out = forensics.runForensics(root, MINI);
  assert.equal(out.usable, true);
  assert.deepEqual(out.cleared, ["content:javascript-typescript/focused-test", "content:javascript-typescript/swallowed-exception"]);
  assert.ok(out.ranking.find((r) => r.classId === "javascript-typescript/swallowed-exception").hits >= 1);
  assert.ok(out.ranking.find((r) => r.classId === "javascript-typescript/focused-test").hits >= 1);
});

test("two different classes in the history are two signals, one class is not", () => {
  const root = newRepo();
  filler(root, 4);
  commit(root, { "src/swallow.js": "try { risky(); } catch {}\n" }, "wrap the risky call");
  const only = forensics.runForensics(root, MINI);
  assert.deepEqual(only.cleared, ["content:javascript-typescript/swallowed-exception"]);
  assert.equal(only.fallback, "below-threshold");

  commit(root, { "tests/focus.test.js": "it.only('one', () => {});\n" }, "focus one test");
  const both = forensics.runForensics(root, MINI);
  assert.equal(both.cleared.length, 2);
  assert.equal(both.usable, true);
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

test("the fallback ordering is the editions' own argument, safety first", () => {
  const order = forensics.catalogueOrder();
  assert.equal(order.length, SHIPPED.length);
  const lastSafety = order.map((c) => c.severity === "safety").lastIndexOf(true);
  const firstNot = order.map((c) => c.severity === "safety").indexOf(false);
  assert.ok(firstNot === -1 || lastSafety < firstNot, "a safety class ranked below one that is not");
  // Nothing installable-first survives: every class is installable now, and the
  // fixture pair is what admits it.
  assert.ok(order.every((c) => c.installableAtV1 === undefined), "a deleted field is still shaping the order");
});

test("every id forensics hands out is namespaced by its edition", () => {
  for (const cls of forensics.catalogueOrder()) {
    assert.match(cls.id, /^[a-z0-9-]+\/[a-z0-9-]+$/, cls.id + " is not namespaced");
  }
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
  assert.equal(out.ranking.length, NODE_CLASSES.length,
    "the spine is every class of the editions this project matched");
  assert.ok(out.ranking.every((r) => r.edition === "javascript-typescript"),
    "a Node repository was ranked in another language's ids");
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
// Since the install — the month-later view
// ---------------------------------------------------------------------------

const INSTALL = "2026-06-01T00:00:00.000Z";
const BEFORE = "2026-05-01T12:00:00Z";
const AFTER = "2026-07-01T12:00:00Z";

function dated(root, count, date, from) {
  const start = from || 0;
  for (let i = start; i < start + count; i++) {
    commit(root, { ["src/f" + i + ".js"]: "module.exports = " + i + ";\n" }, "add module " + i, { date });
  }
}

test("no install date asked about means no since-install section at all", () => {
  const root = newRepo();
  filler(root, 4);
  commit(root, { "src/swallow.js": "try { risky(); } catch {}\n" }, "wrap the risky call");
  commit(root, { "tests/focus.test.js": "it.only('one', () => {});\n" }, "focus one test");
  const out = forensics.runForensics(root, MINI);
  assert.equal(out.usable, true);
  assert.equal(out.sinceInstall, null);
});

test("the since-install view splits each class's content hits on the install date", () => {
  const root = newRepo();
  dated(root, 4, BEFORE);
  commit(root, { "src/old.js": "try { risky(); } catch {}\n" }, "wrap the risky call", { date: BEFORE });
  commit(root, { "src/new.js": "try { other(); } catch {}\n" }, "wrap the other risky call", { date: AFTER });
  commit(root, { "tests/focus.test.js": "it.only('one', () => {});\n" }, "focus one test", { date: AFTER });

  const out = forensics.runForensics(root, { ...MINI, since: INSTALL });
  assert.equal(out.usable, true);
  assert.equal(out.sinceInstall.since, INSTALL);
  assert.equal(out.sinceInstall.commits, 2);
  assert.equal(out.sinceInstall.truncated, false);
  assert.deepEqual(out.sinceInstall.byClass["javascript-typescript/swallowed-exception"], { before: 1, after: 1 });
  assert.deepEqual(out.sinceInstall.byClass["javascript-typescript/focused-test"], { before: 0, after: 1 });
});

test("the since-install commits are split by actor and the split says it is best-effort", () => {
  const root = newRepo();
  dated(root, 4, BEFORE);
  commit(root, { "src/mate.js": "module.exports = 1;\n" }, "a teammate's commit", { date: AFTER });
  commit(root, { "src/bot.js": "module.exports = 2;\n" }, "an agent's commit",
    { date: AFTER, trailer: AGENT_TRAILER });

  const out = forensics.runForensics(root, { ...MINI, since: INSTALL });
  assert.deepEqual(out.sinceInstall.actors, { human: 1, agent: 1 });
  assert.match(out.sinceInstall.attribution, /^best-effort/);
});

test("a history too young to rank still says what has landed since the install", () => {
  const root = newRepo();
  commit(root, { "src/a.js": "module.exports = 1;\n" }, "before the install", { date: BEFORE });
  commit(root, { "src/b.js": "module.exports = 2;\n" }, "after the install", { date: AFTER });

  const out = forensics.runForensics(root, { since: INSTALL });
  assert.equal(out.fallback, "young-history");
  assert.equal(out.usable, false);
  assert.equal(out.sinceInstall.commits, 1);
  assert.deepEqual(out.sinceInstall.byClass, {});
});

test("a mining window that does not reach back to the install says so", () => {
  const root = newRepo();
  dated(root, 5, AFTER);
  const out = forensics.runForensics(root, { thresholds: { minCommits: 4 }, since: INSTALL });
  assert.equal(out.sinceInstall.commits, 5);
  assert.equal(out.sinceInstall.truncated, true, "a window starting after the install claimed to cover it");
});

// The two passes have different depths, and `byClass` comes from the shallower
// one. Read against the log pass, `truncated` said the window reached back to
// the install while every class read `before: 0` — the same report saying the
// history covers the install and that nothing existed before it.
test("truncated answers for the window byClass was actually built from", () => {
  const root = newRepo();
  commit(root, { "src/old.js": "try { risky(); } catch {}\n" }, "wrap the risky call", { date: BEFORE });
  dated(root, 4, AFTER);
  commit(root, { "src/new.js": "try { other(); } catch {}\n" }, "wrap the other one", { date: AFTER });

  const deep = forensics.runForensics(root, { ...MINI, since: INSTALL });
  assert.equal(deep.sinceInstall.truncated, false);
  assert.deepEqual(deep.sinceInstall.byClass["javascript-typescript/swallowed-exception"],
    { before: 1, after: 1 });

  // Same repository, same install date, a content pass too shallow to see the
  // pre-install commit. `before` drops to 0, so `truncated` has to say so.
  const shallow = forensics.runForensics(root, { thresholds: { minCommits: 4, diffCommits: 2 }, since: INSTALL });
  assert.deepEqual(shallow.sinceInstall.byClass["javascript-typescript/swallowed-exception"],
    { before: 0, after: 1 }, "the shallow pass still reached the pre-install commit");
  assert.equal(shallow.sinceInstall.truncated, true,
    "before: 0 was reported as a count over a window that never reached the install");
  assert.equal(shallow.sinceInstall.commits, 5, "the metadata pass was narrowed too");
});

test("an install date that cannot be read yields no section rather than a nonsense one", () => {
  const root = newRepo();
  dated(root, 5, AFTER);
  assert.equal(forensics.runForensics(root, { ...MINI, since: "whenever" }).sinceInstall, null);
});

test("the CLI takes --since and mines from it", () => {
  const root = newRepo();
  dated(root, 4, BEFORE);
  dated(root, 2, AFTER, 4);
  const r = spawnSync(process.execPath,
    [path.join(__dirname, "..", "scripts", "forensics.js"), "--root", root, "--since", INSTALL],
    { encoding: "utf-8", windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).sinceInstall.commits, 2);
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
  // The literal, not `SHELL_TOOLS` joined back against itself: the slot id is a
  // report string an owner reads, and 2.14.0 widened it off `Bash` alone.
  assert.deepEqual(out.occupied, ["PreToolUse:Bash|PowerShell"]);
  const slot = out.slots.find((s) => s.slot === "PreToolUse:Bash|PowerShell");
  assert.equal(slot.free, false);
  assert.ok(slot.occupiedBy[0].includes(".claude/settings.json"));
  assert.ok(slot.occupiedBy[0].includes("node ./guard.js"));
  assert.ok(out.disclosures.some((d) => d.includes("do not chain")));
});

// 2.14.0 / roadmap 237. Widening `HOOK_SLOTS[0].tools` to every shell tool is a
// behaviour change on the install path, not only on the guard path: a foreign
// hook registered for `PowerShell` alone used to leave the command-guard slot
// free, and jig would have registered a second PreToolUse hook beside it.
// Registrations do not chain, so one of the two would silently never fire.
test("a foreign hook on the other shell tool takes the command-guard slot too", () => {
  const root = project({
    ".claude/settings.json": JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "PowerShell", hooks: [{ type: "command", command: "node", args: ["./ps-guard.js"] }] }],
      },
    }),
  });
  const out = engine.cmdScan(root);
  assert.deepEqual(out.occupied, ["PreToolUse:Bash|PowerShell"]);
  const slot = out.slots.find((s) => s.slot === "PreToolUse:Bash|PowerShell");
  assert.ok(slot.occupiedBy[0].includes("node ./ps-guard.js"));
  assert.ok(out.disclosures.some((d) => d.includes("do not chain")));

  // SCOPE, "Is a foreign hook on one shell tool a full occupancy": yes, whole,
  // because the session's tool list is not knowable from here and jig's matcher
  // is one static registration covering both names. What the owner is owed is
  // WHICH name is contested — a flat "taken" over a slot named for two tools is
  // the report claiming more than jig knows, and this hook holds only one.
  assert.deepEqual(slot.overlap, ["PowerShell"]);
  assert.ok(out.disclosures.some((d) => d.includes("held on PowerShell only, not on Bash")),
    "the owner is refused a guard without being told which name the hook holds");
});

// The other direction: a foreign hook on the matcher jig's own slot covers whole
// contends for both names, and there is no partial hold to disclose.
test("a foreign hook covering every shell tool holds the whole slot with nothing to qualify", () => {
  const root = project({
    ".claude/settings.json": JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash|PowerShell", hooks: [{ type: "command", command: "node", args: ["./both.js"] }] }],
      },
    }),
  });
  const out = engine.cmdScan(root);
  const slot = out.slots.find((s) => s.slot === "PreToolUse:Bash|PowerShell");
  assert.equal(slot.free, false);
  assert.deepEqual(slot.overlap, ["Bash", "PowerShell"]);
  assert.ok(!out.disclosures.some((d) => d.includes("only, not on")),
    "a hook holding both names is qualified as if it held one");
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
  assert.deepEqual(out.occupied, ["PreToolUse:Bash|PowerShell"]);
});

test("unreadable settings are skipped rather than crashing the scan", () => {
  const root = project({ ".claude/settings.json": "{ not json" });
  const out = engine.cmdScan(root);
  assert.equal(out.ok, true);
  assert.deepEqual(out.guardrails.hooks, []);
});

// ---------------------------------------------------------------------------
// Governance-doc reachability

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

// `--quick` skips every round, so the classes it installs have to be computed
// and recorded rather than decided in the moment by whoever is driving.

test("scan --quick records the selection and its basis; an ordinary scan records none", () => {
  const root = project({ "src/a.js": "//a\n", "package.json": "{\"name\":\"q\"}\n" });

  engine.cmdScan(root, { _: [], change: [] });
  assert.equal(engine.readProfile(root).profile.quick, null,
    "an ordinary scan selected classes nobody asked it to");

  const out = engine.cmdScan(root, { _: [], change: [], quick: true });
  const quick = engine.readProfile(root).profile.quick;
  assert.deepEqual(quick, out.quick, "the profile on disk disagrees with what scan returned");
  assert.ok(["forensics", "catalogue"].includes(quick.basis));
  assert.equal(quick.cap, editions.QUICK_CAP);
  assert.ok(quick.classes.length > 0 && quick.classes.length <= quick.cap);
  assert.ok(quick.classes.every((c) => c.classId.startsWith("javascript-typescript/")),
    "quick start selected classes from an edition this project is not written in");
  // The same tree twice: a selection nobody can reproduce is not one anybody
  // can check.
  assert.deepEqual(engine.cmdScan(root, { _: [], change: [], quick: true }).quick.classes, quick.classes);

  const said = out.disclosures.filter((d) => d.startsWith("Quick start selected "));
  assert.equal(said.length, 1, "the quick selection was not disclosed");
  assert.match(said[0], /\.jig\/profile\.json under `quick`/);
});
