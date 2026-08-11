"use strict";

// [Foreman: 104] The efficacy gate — jig's only honest benchmark.
//
// jig-brief §5 names one number for 0.1.0-alpha: the efficacy fixture catches
// 4/4 seeded violations with 0/8 near-miss false positives. This file produces
// that number by INSTALLING jig into a miniature Node project and running it.
// Nothing here is asserted from a table: the twelve cases below name files and
// command lines, and every catch and every false positive comes back out of a
// real check-driver run and real hook-runner spawns.
//
// The fixture and its reasoning live in tests/fixtures/efficacy/README.md.
//
// WHAT THE RUN ACTUALLY SCORED:
//
//   catches                        4 of 4
//   false positives, check driver  0 of 8   <- the host-neutral floor
//   false positives, hook runners  1 of 8   <- the Claude-session guards
//
// The floor meets the brief. The session guards carry one disclosed miss: the
// bash guard reads a `curl … | sh` inside an `echo` string as the real thing,
// the same limit the check driver pins on its own fixture, on the one
// installable class the catalogue labels heuristic. The source-file guards
// blank comments, strings and regular expressions before matching — the same
// discipline as the check driver — so the two sides agree on every source
// near-miss, and a test below holds them to that.
//
// That number is not relaxed here. Every false positive must appear by name in
// KNOWN_LIMITS with its cause, the observed set must EQUAL the declared set,
// and the count is asserted exactly — so a new false positive fails this gate
// until somebody writes down why, and fixing one fails it until somebody
// updates the score. A gate that passes because the fixture was chosen to make
// it pass would be worse than no gate.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const engine = require("../scripts/jig.js");
const catalogue = require("../scripts/catalogue.json");

const FIXTURE = path.join(__dirname, "fixtures", "efficacy");
const RUNNER = path.join(__dirname, "..", "hooks", "runner.js");
const ALL_FOUR = ["silent-catch", "focused-or-skipped-test", "pipe-to-shell", "test-file-deletion"];

// ---------------------------------------------------------------------------
// The twelve cases
// ---------------------------------------------------------------------------
//
// One seeded violation and two near-miss negatives per installable class. The
// `medium` is the catalogue's own: a class whose fixtures are command-lines is
// scored through the guard that sees commands, never through a file the class
// would never appear in.
//
// A negative is declared for the class it is a near miss OF. False positives
// are counted across every class, because a report on a clean file is a false
// alarm to its reader whichever guard raised it.

const CASES = [
  // silent-catch — source files, seen by the check driver and by the
  // PostToolUse edit guard.
  { id: "silent-catch/violation", classId: "silent-catch", kind: "violation",
    medium: "source", ref: "src/config.js",
    why: "three swallowed errors: a discarded binding, a bare catch, and a body holding only a comment" },
  { id: "silent-catch/handled", classId: "silent-catch", kind: "negative",
    medium: "source", ref: "src/cache.js",
    why: "every catch rethrows, logs, or returns a visibly degraded value" },
  { id: "silent-catch/shape-as-data", classId: "silent-catch", kind: "negative",
    medium: "source", ref: "src/render.js",
    why: "the empty-catch shape appears only inside comments, strings and a regular expression" },

  // focused-or-skipped-test — source files under the test globs.
  { id: "focused-or-skipped-test/violation", classId: "focused-or-skipped-test", kind: "violation",
    medium: "source", ref: "test/config.test.js",
    why: "one hit per shipped pattern: it.only(, it.skip( and it.todo(" },
  { id: "focused-or-skipped-test/tokens-in-text", classId: "focused-or-skipped-test", kind: "negative",
    medium: "source", ref: "test/cache.test.js",
    why: "it.only( and describe.skip( appear only in a comment and in string literals" },
  { id: "focused-or-skipped-test/lookalike-names", classId: "focused-or-skipped-test", kind: "negative",
    medium: "source", ref: "test/render.test.js",
    why: "a variable named itOnly and a runner with its own skip and only methods" },

  // pipe-to-shell — command lines, seen by the PreToolUse bash guard. The
  // check driver's detector for this class reads committed shell and workflow
  // files, which is a different medium and a different (heuristic) reading.
  { id: "pipe-to-shell/violation", classId: "pipe-to-shell", kind: "violation",
    medium: "command", ref: "commands/violation.txt",
    why: "a download piped straight into a shell" },
  { id: "pipe-to-shell/echoed-string", classId: "pipe-to-shell", kind: "negative",
    medium: "command", ref: "commands/near-miss-echoed-string.txt",
    why: "the same download quoted inside an echo, printed and never run" },
  { id: "pipe-to-shell/scratch-branch", classId: "pipe-to-shell", kind: "negative",
    medium: "command", ref: "commands/near-miss-scratch-branch.txt",
    why: "a force-push to a branch that is not the default one" },

  // test-file-deletion — paths staged for deletion in a real git index, seen
  // by the check driver's staged-diff check.
  { id: "test-file-deletion/violation", classId: "test-file-deletion", kind: "violation",
    medium: "staged-path", ref: "test/legacy.test.js",
    why: "a passing test file removed rather than fixed" },
  { id: "test-file-deletion/doc-about-testing", classId: "test-file-deletion", kind: "negative",
    medium: "staged-path", ref: "docs/testing.md",
    why: "a document about testing is not a test" },
  { id: "test-file-deletion/archive-note", classId: "test-file-deletion", kind: "negative",
    medium: "staged-path", ref: "tests-archive/README.md",
    why: "tests-archive/ is not tests/, which is the edge the **/tests/** glob has to get right" },
];

// ---------------------------------------------------------------------------
// The disclosed known limits
// ---------------------------------------------------------------------------
//
// Every false positive this run produces, named with its cause. The gate below
// asserts that the observed set equals this one exactly, so neither a new miss
// nor a fixed one can pass unnoticed.

const KNOWN_LIMITS = {
  "pipe-to-shell/echoed-string @ PreToolUse":
    "The bash guard matches a regular expression against the whole command line and cannot " +
    "see that the download sits inside a quoted string. jig/tests/checks.test.js pins the " +
    "same miss on the check driver, and the catalogue labels the class heuristic.",
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const roots = [];

test.after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function caseById(id) {
  return CASES.find((c) => c.id === id);
}

function caseByRef(ref) {
  return CASES.find((c) => c.ref === ref);
}

// Command lines are read out of their fixture file and fed to the guard as the
// agent would have typed them. Comment lines are the fixture's own notes.
function commandLines(rel) {
  return fs.readFileSync(path.join(FIXTURE, rel), "utf-8")
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf-8", windowsHide: true });
}

// One spawn per event, exactly as the host makes it: the runner reads its
// payload off stdin and resolves the project from its working directory.
function hook(root, event, payload) {
  const run = spawnSync(process.execPath, [RUNNER, event], {
    cwd: root, encoding: "utf-8", input: JSON.stringify(payload), windowsHide: true,
  });
  const out = JSON.parse(run.stdout || "{}");
  return ((out.jig && out.jig.guards) || []).filter((g) => g.decision === "would-deny");
}

let measured = null;

// The whole benchmark, once. A git repository, the fixture copied into it as
// bytes, jig installed over the top, then every catcher run against every case.
function measure() {
  if (measured) return measured;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jig-efficacy-"));
  roots.push(root);
  // Copied, never read as text on the way in — laundering a fixture through a
  // string is exactly what the near-miss cases exist to catch.
  fs.cpSync(FIXTURE, root, { recursive: true });

  assert.equal(git(root, ["init", "-q"]).status, 0, "the efficacy fixture needs a git repository");
  git(root, ["config", "user.email", "fixture@example.test"]);
  git(root, ["config", "user.name", "jig efficacy fixture"]);
  assert.equal(git(root, ["add", "-A"]).status, 0);
  assert.equal(git(root, ["commit", "-q", "-m", "the fixture as shipped"]).status, 0,
    "the efficacy fixture could not be committed, so no deletion can be staged");

  const plan = engine.cmdPlan(root, {
    _: [], change: [], select: ALL_FOUR.join(","), provenance: "forensic",
  });
  engine.cmdApply(root, { _: [], change: [], plan: plan.planId });

  // The staged-path cases become real staged deletions.
  for (const c of CASES.filter((c) => c.medium === "staged-path")) {
    assert.equal(git(root, ["rm", "--cached", "-q", c.ref]).status, 0, "could not stage " + c.ref);
  }

  // Every report this run produced: which case, which catcher, which class.
  const reports = [];

  const driven = spawnSync(process.execPath, [path.join(root, ".jig", "checks", "run.mjs"), "--json"], {
    cwd: root, encoding: "utf-8", windowsHide: true,
  });
  const driver = JSON.parse(driven.stdout);
  assert.deepEqual(driver.broken, [], "a check module failed to load, so the score means nothing");
  assert.deepEqual(driver.skipped, [], "a check skipped itself, so the score is short a catcher");
  for (const f of driver.findings) {
    const c = caseByRef(f.path);
    assert.ok(c, "the check driver reported " + f.path + ", which is not one of the twelve cases");
    reports.push({ caseId: c.id, catcher: "check-driver", classId: f.classId });
  }

  for (const c of CASES.filter((c) => c.medium === "command")) {
    for (const command of commandLines(c.ref)) {
      for (const g of hook(root, "PreToolUse", {
        session_id: "efficacy", tool_name: "Bash", tool_input: { command },
      })) {
        reports.push({ caseId: c.id, catcher: "PreToolUse", classId: g.classId });
      }
    }
  }

  for (const c of CASES.filter((c) => c.medium === "source")) {
    const content = fs.readFileSync(path.join(FIXTURE, c.ref), "utf-8");
    for (const g of hook(root, "PostToolUse", {
      session_id: "efficacy", tool_name: "Write",
      tool_input: { file_path: path.join(root, c.ref), content },
    })) {
      reports.push({ caseId: c.id, catcher: "PostToolUse", classId: g.classId });
    }
  }

  const caught = ALL_FOUR.filter((id) => reports.some((r) => r.caseId === id + "/violation"));
  const falsePositives = [...new Set(
    reports.filter((r) => caseById(r.caseId).kind === "negative")
      .map((r) => r.caseId + " @ " + r.catcher),
  )].sort();

  measured = { root, plan, driver, reports, caught, falsePositives };
  return measured;
}

const SCORE = [];

test.after(() => {
  if (SCORE.length) process.stdout.write("\n" + SCORE.join("\n") + "\n");
});

// ---------------------------------------------------------------------------
// The fixture is the shape it claims to be
// ---------------------------------------------------------------------------

test("the fixture carries one violation and exactly two negatives for each installable class", () => {
  const installable = catalogue.classes.filter((c) => c.installableAtV1).map((c) => c.id).sort();
  assert.deepEqual([...ALL_FOUR].sort(), installable);
  for (const id of ALL_FOUR) {
    const mine = CASES.filter((c) => c.classId === id);
    assert.equal(mine.filter((c) => c.kind === "violation").length, 1, id + " needs one violation");
    assert.equal(mine.filter((c) => c.kind === "negative").length, 2, id + " needs two negatives");
    assert.equal(new Set(mine.map((c) => c.medium)).size, 1, id + "'s cases must share one medium");
  }
  assert.equal(CASES.length, 12);
  assert.equal(new Set(CASES.map((c) => c.id)).size, 12);
  for (const c of CASES) {
    assert.ok(fs.existsSync(path.join(FIXTURE, c.ref)), c.id + ": " + c.ref + " is not in the fixture");
    assert.ok(c.why && c.why.length > 20, c.id + " does not say what it is");
  }
});

test("the fixture is a Node project, and its own test files are never collected as a suite", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(FIXTURE, "package.json"), "utf-8"));
  assert.equal(pkg.private, true);
  assert.equal(typeof pkg.scripts.test, "string");
  assert.ok(fs.existsSync(path.join(FIXTURE, "README.md")), "the fixture must explain itself");

  // `jig/tests/*.test.js` is a non-recursive glob, so what it collects is
  // exactly the `.test.js` files sitting directly in this directory.
  const collected = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js"));
  const fixtureSuites = fs.readdirSync(path.join(FIXTURE, "test")).filter((f) => f.endsWith(".test.js"));
  assert.ok(fixtureSuites.length >= 4, "the fixture lost its test files");
  for (const name of fixtureSuites) {
    assert.equal(collected.includes(name), false, name + " would be collected as a jig suite");
  }
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("release gate: every seeded violation is caught — 4 of 4", () => {
  const { caught, reports } = measure();
  assert.deepEqual(caught.sort(), [...ALL_FOUR].sort(),
    "a seeded violation went unreported: " + ALL_FOUR.filter((id) => !caught.includes(id)).join(", "));

  // and each one was caught by a catcher that can actually see its medium
  for (const c of CASES.filter((c) => c.kind === "violation")) {
    const by = reports.filter((r) => r.caseId === c.id);
    assert.ok(by.length > 0, c.id);
    for (const r of by) assert.equal(r.classId, c.classId, c.id + " was caught as the wrong class");
  }
  SCORE.push("efficacy: catches " + caught.length + " of " + ALL_FOUR.length);
});

test("release gate: the host-neutral floor reports 0 false positives out of 8", () => {
  const { falsePositives } = measure();
  const fromDriver = falsePositives.filter((k) => k.endsWith(" @ check-driver"));
  assert.deepEqual(fromDriver, [],
    "the check driver reported a near-miss:\n  " + fromDriver.join("\n  "));
  const negatives = CASES.filter((c) => c.kind === "negative").length;
  assert.equal(negatives, 8);
  SCORE.push("efficacy: false positives, check driver 0 of " + negatives);
});

// The number the brief asked for is met on the floor and not on the session
// guards. This gate asserts the real one, exactly, rather than the one that
// would have been comfortable — and every entry in it carries its cause.
test("release gate: every hook-runner false positive is a disclosed known limit", () => {
  const { falsePositives } = measure();
  const fromHooks = falsePositives.filter((k) => !k.endsWith(" @ check-driver"));
  const declared = Object.keys(KNOWN_LIMITS).sort();

  const undisclosed = fromHooks.filter((k) => !(k in KNOWN_LIMITS));
  assert.deepEqual(undisclosed, [],
    "a hook guard reported a near-miss nobody wrote down:\n  " + undisclosed.join("\n  "));

  const stale = declared.filter((k) => !fromHooks.includes(k));
  assert.deepEqual(stale, [],
    "a declared limit no longer fires — the score improved and this file still says otherwise:\n  " +
    stale.join("\n  "));

  for (const [key, reason] of Object.entries(KNOWN_LIMITS)) {
    assert.ok(reason.length > 80, key + " is disclosed without a cause");
  }

  const negatives = CASES.filter((c) => c.kind === "negative").length;
  SCORE.push("efficacy: false positives, hook runners " + fromHooks.length + " of " + negatives +
    " (all disclosed: " + fromHooks.join(", ") + ")");
});

test("the check driver and the hook guards agree on every source near-miss", () => {
  const { reports } = measure();
  // Every case the driver leaves clean and a hook guard reports. jig-lib.js
  // blanks comments, strings and regular expressions the same way the
  // check-driver template does; this set growing a member again means the two
  // implementations drifted apart.
  const split = CASES.filter((c) => c.kind === "negative" && c.medium === "source")
    .filter((c) => reports.some((r) => r.caseId === c.id && r.catcher === "PostToolUse"))
    .filter((c) => !reports.some((r) => r.caseId === c.id && r.catcher === "check-driver"))
    .map((c) => c.id).sort();

  assert.deepEqual(split, []);
});

test("nothing about the score depends on jig having written outside its own two directories", () => {
  const { root } = measure();
  const listed = [];
  const stack = ["."];
  while (stack.length) {
    const rel = stack.pop();
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel === "." ? entry.name : rel + "/" + entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== ".git") stack.push(child);
      } else {
        listed.push(child);
      }
    }
  }
  const outside = listed.filter((rel) => !rel.startsWith(".jig/") && !rel.startsWith(".github/workflows/"));
  const shipped = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(FIXTURE, rel), { withFileTypes: true })) {
      const child = rel === "." ? entry.name : rel + "/" + entry.name;
      if (entry.isDirectory()) walk(child);
      else shipped.push(child);
    }
  };
  walk(".");
  assert.deepEqual(outside.sort(), shipped.sort(),
    "the efficacy run left a file the fixture did not ship");
});
