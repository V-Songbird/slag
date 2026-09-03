"use strict";

// The efficacy gate — jig's only honest benchmark.
//
// SCOPE, "What replaces the single efficacy headline": per-edition pair results
// over all 165 pairs, plus the cross-class false-positive count. That is what
// this file measures, and the numbers it prints are the ones a release
// publishes.
//
// The old headline — 4 of 4 catches on one Node fixture — measured the four
// classes jig 1.0.1 could install. It cannot be carried forward: there are no
// installable-at-v1 classes any more, the catalogue does not gate anything, and
// six editions ship 165 pairs between them. A score over four of those would be
// a smaller claim dressed as the same one.
//
// Two numbers, per edition and in total:
//
//   pairs        every class fires on its own violation and stays silent on its
//                own near miss. A single failure is a check that ships broken.
//   cross hits   every admitted check run against every OTHER check's near miss
//                in the same edition. The pair test cannot see a check that
//                fires on everything, because such a check still passes its own
//                pair; somebody else's near miss is the only sample it was not
//                authored against.
//
// A cross hit is disclosed rather than fatal — two checks over one language
// legitimately share shapes — but every one must appear by name in KNOWN_CROSS
// with its cause, and the observed set must EQUAL the declared set. So a new
// cross hit fails this gate until somebody writes down why, and fixing one
// fails it until somebody updates the score.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const editions = require("../scripts/editions.js");
const admission = require("../scripts/admission.js");
// The blanker the session guards use. blanker-drift.test.js holds it byte for
// byte against the check driver's copy, so measuring through this one measures
// both.
const { blankRegions } = require("../hooks/jig-lib.js");

const PLUGIN_ROOT = path.join(__dirname, "..");

// Every cross-class hit the six editions produce, named with its cause. Each
// key is `<edition>: <check> on <foreignCheck>'s near miss`.
const KNOWN_CROSS = {
  "dotnet: blocking-call-in-async on async-void-method's near miss":
    "The async-void near miss demonstrates the correct `async Task` signature by contrasting it with a " +
    "blocking `.Wait()` call, which is genuinely the other class's violation. Both checks are right.",
  "go: type-widened-to-any on type-assertion-without-comma-ok's near miss":
    "The comma-ok near miss takes an `any` parameter to have something to assert on, and a widened `any` " +
    "in a signature is exactly what the other check reads. The sample is a violation of both.",
  "javascript-typescript: loose-equality-coercion on ci-step-allowed-to-fail's near miss":
    "The CI near miss is YAML, and `==` inside a workflow expression is not the JavaScript coercion the " +
    "other check reads. The two classes never share a path glob, so the collision cannot happen in a run.",
  "jvm: hardcoded-config-value on catch-all-exception's near miss":
    "The catch-all near miss logs a URL literal to show the error being handled rather than swallowed, and " +
    "a hardcoded URL is the other class's violation. Both readings of that line are correct.",
  "rust: unwrap-on-fallible on softened-assertion's near miss":
    "The softened-assertion near miss uses `.expect(\"…\")` to unwrap a test fixture, which is the other " +
    "class's violation in library code. The paths differ — one is a test, one is not.",
  "rust: panic-macro-in-library on bare-should-panic's near miss":
    "A `#[should_panic(expected = …)]` test has to panic to be a test at all, so its near miss contains the " +
    "macro the library check refuses. The library check's own path glob excludes tests.",
  "rust: numeric-cast-to-silence-checker on float-equality-assert's near miss":
    "The float near miss casts to f64 to compare within an epsilon, which is the deliberate, correct use of " +
    "the cast the other class reads as silencing the checker.",
  "rust: unwrap-on-fallible on blocking-call-in-async's near miss":
    "The async near miss awaits and unwraps a join handle to show the non-blocking form, and `.unwrap()` is " +
    "the other class's violation. Both checks are reading their own language correctly.",
};

const SCORE = [];

test.after(() => {
  if (SCORE.length) process.stdout.write("\n" + SCORE.join("\n") + "\n");
});

let measured = null;

// The whole benchmark, once. Every shipped edition, every class, both halves of
// every pair, and then every check against every foreign near miss.
function measure() {
  if (measured) return measured;

  const index = editions.loadIndex(PLUGIN_ROOT);
  const rows = [];
  let pairs = 0;
  const failures = [];
  const cross = [];

  for (const row of index.editions) {
    const edition = editions.loadEdition(PLUGIN_ROOT, row.id);
    // The blanker reads comment and string syntax off a filename, and the
    // edition is what knows the language — so its own map rides every class.
    const classes = edition.classes.map((c) => ({ ...c, commentSyntax: edition.detect.commentSyntax }));
    pairs += classes.length;

    // A class caught only by a tool rule has no patterns of jig's to prove; it
    // is counted and disclosed rather than scored as a pass.
    const driven = classes.filter((c) => (c.detectors || []).some((d) => d.lever === "check-driver"));
    let passed = 0;
    for (const cls of driven) {
      const result = admission.ownPair(cls, blankRegions);
      if (result.passes) passed++;
      else failures.push(row.id + "/" + cls.id + ": " + result.why);
    }

    for (const hit of admission.crossNearMiss(driven, blankRegions)) {
      cross.push(row.id + ": " + hit.check + " on " + hit.foreignCheck + "'s near miss");
    }

    rows.push({
      edition: row.id,
      classes: classes.length,
      driven: driven.length,
      passed,
      toolRuleOnly: classes.length - driven.length,
    });
  }

  measured = { rows, pairs, failures, cross: [...new Set(cross)].sort() };
  return measured;
}

// ---------------------------------------------------------------------------
// The shelf is the shape the score claims to be over
// ---------------------------------------------------------------------------

test("the benchmark runs over all six editions and all 165 pairs", () => {
  const { rows, pairs } = measure();
  assert.equal(rows.length, 6);
  assert.equal(pairs, 165, "the editions ship " + pairs + " pairs and this benchmark is written for 165");
  for (const row of rows) {
    assert.ok(row.classes > 0, row.edition + " ships no classes");
    assert.ok(row.driven > 0, row.edition + " has no class with patterns of jig's own to prove");
  }
});

// ---------------------------------------------------------------------------
// The published score is the measured score
// ---------------------------------------------------------------------------

// The README's benchmark table is the one coverage claim jig makes in public,
// and it was hand-copied. A cell reads its number off the table so a figure that
// drifts fails here instead of ageing quietly in the prose.
function cell(readme, label) {
  const row = readme.split("\n").find((line) => line.startsWith("| " + label + " |"));
  assert.ok(row, "the README benchmark table has no row for " + JSON.stringify(label));
  const cells = row.split("|").map((c) => c.replace(/\*/g, "").trim());
  return cells[2];
}

test("the README benchmark table publishes the figures this suite measures", () => {
  const { rows, pairs, cross } = measure();
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");
  const driven = rows.reduce((n, r) => n + r.driven, 0);

  assert.equal(cell(readme, "Checks jig runs, each passing its own pair"), driven + " of " + driven);
  assert.equal(cell(readme, "Mistake classes across the six editions"), String(pairs));
  assert.equal(cell(readme, "Cross-sample hits, disclosed"), String(cross.length));
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("release gate: every shipped pair passes its own admission, per edition", () => {
  const { rows, failures, pairs } = measure();
  assert.deepEqual(failures, [],
    "a shipped check misses its own violation or fires on its own near miss:\n  " + failures.join("\n  "));

  let driven = 0;
  for (const row of rows) {
    assert.equal(row.passed, row.driven, row.edition + " lost a pair");
    driven += row.driven;
    SCORE.push("efficacy: " + row.edition + " — " + row.passed + " of " + row.driven +
      " pairs proved, " + row.toolRuleOnly + " class(es) caught only by a tool rule");
  }
  SCORE.push("efficacy: total — " + driven + " of " + driven + " driver-backed pairs proved, over " +
    pairs + " shipped pairs");
});

test("release gate: every cross-class false positive is a disclosed known limit", () => {
  const { cross } = measure();
  const declared = Object.keys(KNOWN_CROSS).sort();

  const undisclosed = cross.filter((k) => !(k in KNOWN_CROSS));
  assert.deepEqual(undisclosed, [],
    "a check fired on another check's near miss and nobody wrote it down:\n  " + undisclosed.join("\n  "));

  const stale = declared.filter((k) => !cross.includes(k));
  assert.deepEqual(stale, [],
    "a declared cross hit no longer fires — the score improved and this file still says otherwise:\n  " +
    stale.join("\n  "));

  for (const [key, reason] of Object.entries(KNOWN_CROSS)) {
    assert.ok(reason.length > 80, key + " is disclosed without a cause");
  }
  SCORE.push("efficacy: cross-class false positives " + cross.length + ", all disclosed");
});

// ---------------------------------------------------------------------------
// What the score does not cover, said out loud
// ---------------------------------------------------------------------------

test("a class no check-driver detector covers is counted as a gap, never as a pass", () => {
  const { rows, pairs } = measure();
  const driven = rows.reduce((n, r) => n + r.driven, 0);
  const only = pairs - driven;
  assert.ok(only > 0, "every class now has patterns of jig's own — update this disclosure");
  assert.equal(rows.reduce((n, r) => n + r.toolRuleOnly, 0), only);
  SCORE.push("efficacy: " + only + " of " + pairs + " shipped classes carry no check-driver patterns, so " +
    "nothing in this benchmark proves them — their coverage is the tool's, and the plan says so per class");
});

test("the pair test alone could not catch a check that fires on everything", () => {
  // Why the cross-class run exists, stated as a fact rather than a comment: a
  // check written to pass its own pair and match anything else still passes
  // ownPair, and only a foreign near miss finds it.
  const greedy = {
    id: "fires-on-everything",
    deny: { reason: "r", alternative: "a", override: "o" },
    detectors: [{ lever: "check-driver", params: { patterns: ["\\S"], paths: ["**/*.js"] } }],
    fixtures: { violation: "anything at all\n", nearMiss: "\n" },
  };
  const honest = {
    id: "honest",
    deny: { reason: "r", alternative: "a", override: "o" },
    detectors: [{ lever: "check-driver", params: { patterns: ["debugger;"], paths: ["**/*.js"] } }],
    fixtures: { violation: "debugger;\n", nearMiss: "const debuggerName = 1;\n" },
  };
  assert.equal(admission.ownPair(greedy, blankRegions).passes, true, "the pair test saw through it after all");
  const hits = admission.crossNearMiss([greedy, honest], blankRegions);
  assert.deepEqual(hits.map((h) => h.check), ["fires-on-everything"]);
});

// ---------------------------------------------------------------------------
// The shapes the derail pass found uncovered
// ---------------------------------------------------------------------------
//
// The pair test above proves every check against the fixtures its own author
// wrote, which is exactly the wrong witness for "this shape is still covered":
// delete a pattern and its fixture together and the pair still passes. These
// name the shapes instead, so a pattern cannot leave the catalogue quietly.

// Does this edition's class fire on this sample? Blanked the way the benchmark
// blanks, and matched the way the driver matches, so a hit here is a hit there.
function firesOn(editionId, classId, sample) {
  const edition = editions.loadEdition(PLUGIN_ROOT, editionId);
  const cls = edition.classes.find((c) => c.id === classId);
  assert.ok(cls, editionId + " ships no class `" + classId + "`");
  return (cls.detectors || []).filter((d) => d.lever === "check-driver").some((det) => {
    const p = det.params || {};
    const glob = (p.paths || ["x.txt"])[0];
    const ext = (String(glob).match(/\.[A-Za-z0-9]+$/) || [".txt"])[0];
    const blanked = blankRegions(sample, "fixture" + ext, {
      stripComments: p.stripComments !== false,
      stripStrings: p.stripStrings !== false,
      commentSyntax: edition.detect.commentSyntax,
    });
    return (p.patterns || []).some((pattern) => {
      const re = new RegExp(pattern);
      return p.perLine === true ? blanked.split("\n").some((line) => re.test(line)) : re.test(blanked);
    });
  });
}

function configSample(editionId, toolId) {
  const tool = editions.loadEdition(PLUGIN_ROOT, editionId).toolchain.find((t) => t.id === toolId);
  assert.ok(tool, editionId + " installs no `" + toolId + "`");
  return tool.configSample;
}

test("the literal tautology is a softened assertion in JavaScript, and a real comparison is not", () => {
  assert.equal(firesOn("javascript-typescript", "softened-assertion", "expect(true).toBe(true);\n"), true);
  assert.equal(firesOn("javascript-typescript", "softened-assertion", "expect(1).toStrictEqual(1);\n"), true);
  // The back-reference is what keeps it honest: a literal against a DIFFERENT
  // literal is an always-failing assertion, which is a different mistake, and a
  // literal against an expression is an ordinary test.
  assert.equal(firesOn("javascript-typescript", "softened-assertion", "expect(true).toBe(false);\n"), false);
  assert.equal(firesOn("javascript-typescript", "softened-assertion", "expect(total).toBe(1080);\n"), false);
});

test("a #pragma warning disable with no rule id at all is caught, and a restored one is not", () => {
  const bare = "#pragma warning disable\n\npublic sealed class Digest { }\n";
  const restored = "#pragma warning disable\npublic sealed class Digest { }\n#pragma warning restore\n";
  assert.equal(firesOn("dotnet", "unrestored-pragma-suppression", bare), true);
  assert.equal(firesOn("dotnet", "unrestored-pragma-suppression", restored), false);
  // The id-carrying form the class already read still reads the same way.
  assert.equal(firesOn("dotnet", "unrestored-pragma-suppression", "#pragma warning disable CS8602\nvar x = 1;\n"), true);
});

test("the dotnet edition reads a debug artifact and an emptied test body", () => {
  assert.equal(firesOn("dotnet", "debug-artifact-left-behind", "Console.WriteLine(\"here\");\n"), true);
  assert.equal(firesOn("dotnet", "debug-artifact-left-behind", "Debugger.Break();\n"), true);
  assert.equal(firesOn("dotnet", "debug-artifact-left-behind", "_logger.LogDebug(\"here\");\n"), false);
  const emptied = "    [Fact]\n    public void Total_IncludesTax()\n    {\n    }\n";
  const kept = "    [Fact]\n    public void Total_IncludesTax()\n    {\n        Assert.Equal(119m, t);\n    }\n";
  assert.equal(firesOn("dotnet", "emptied-test-body", emptied), true);
  assert.equal(firesOn("dotnet", "emptied-test-body", kept), false);
  // An empty method that carries no test attribute is somebody's null sink.
  assert.equal(firesOn("dotnet", "emptied-test-body", "    public void Record(string line)\n    {\n    }\n"), false);
});

test("every edition that can leave a stub token reads one, and reads its own", () => {
  const stubs = {
    "javascript-typescript": "export function balance() {\n  throw new Error('not implemented');\n}\n",
    python: "def balance() -> Money:\n    raise NotImplementedError\n",
    go: "func Balance() (Money, error) {\n\tpanic(\"not implemented\")\n}\n",
    dotnet: "public Money Balance() => throw new NotImplementedException();\n",
    jvm: "public Money balance() {\n    throw new UnsupportedOperationException(\"not implemented\");\n}\n",
  };
  for (const [edition, sample] of Object.entries(stubs)) {
    assert.equal(firesOn(edition, "unimplemented-stub-shipped", sample), true, edition + " misses its stub token");
  }
  // And the marker half, which is the same class's second detector everywhere.
  assert.equal(firesOn("go", "unimplemented-stub-shipped", "// TODO: finish this\n"), true);
  assert.equal(firesOn("go", "unimplemented-stub-shipped", "const todoReviewLimit = 25\n"), false);
});

test("every edition that can sleep in a test reads one, and reads its own", () => {
  const sleeps = {
    "javascript-typescript": "it('drains', async () => {\n  await new Promise((r) => setTimeout(r, 500));\n});\n",
    python: "def test_drains() -> None:\n    time.sleep(0.5)\n",
    go: "func TestDrains(t *testing.T) {\n\ttime.Sleep(500 * time.Millisecond)\n}\n",
    dotnet: "    [Fact]\n    public void Drains()\n    {\n        Thread.Sleep(500);\n    }\n",
    rust: "#[test]\nfn drains() {\n    thread::sleep(Duration::from_millis(500));\n}\n",
    jvm: "    @Test\n    void drains() throws InterruptedException {\n        Thread.sleep(500);\n    }\n",
  };
  for (const [edition, sample] of Object.entries(sleeps)) {
    assert.equal(firesOn(edition, "sleep-based-test-synchronisation", sample), true, edition + " misses its sleep");
  }
  // A method that names sleeping without doing it is the trap in every one.
  assert.equal(firesOn("go", "sleep-based-test-synchronisation",
    "func TestBudget(t *testing.T) {\n\t_ = New().SleepBudget()\n}\n"), false);
});

// SCOPE: jig never leaves an install it cannot undo, and it must never report
// its own install as a defect either. The near miss for the class that watches
// the harness config is that config — the bytes jig writes — so the day a
// pattern would fire on a fresh install, this pair fails instead of the owner.
test("the test-config-loosened near miss IS the harness config jig installs", () => {
  const installed = {
    "javascript-typescript": "vitest",
    python: "pytest",
    dotnet: "dotnet-test",
    rust: "cargo-nextest",
    jvm: "gradle",
  };
  for (const [edition, tool] of Object.entries(installed)) {
    const cls = editions.loadEdition(PLUGIN_ROOT, edition).classes.find((c) => c.id === "test-config-loosened");
    assert.ok(cls, edition + " ships no test-config-loosened");
    assert.equal(cls.fixtures.nearMiss, configSample(edition, tool),
      edition + "'s near miss has drifted from the file jig writes");
  }
  // Go has no test-runner config of its own; the harness settings live in the
  // linter's file, and the near miss is an excerpt of it rather than the whole.
  const go = editions.loadEdition(PLUGIN_ROOT, "go").classes.find((c) => c.id === "test-config-loosened");
  const golangci = configSample("go", "golangci-lint");
  for (const line of go.fixtures.nearMiss.split("\n").filter((l) => l.trim())) {
    assert.ok(golangci.includes(line), "go's near miss carries a line jig never writes: " + JSON.stringify(line));
  }
});

test("every edition watches the harness config it writes, and only that one", () => {
  const scoped = {
    "javascript-typescript": /vitest\.config/,
    python: /pyproject\.toml/,
    go: /\.golangci\.ya?ml/,
    dotnet: /\.runsettings/,
    rust: /nextest\.toml/,
    jvm: /build\.gradle/,
  };
  for (const [edition, glob] of Object.entries(scoped)) {
    const cls = editions.loadEdition(PLUGIN_ROOT, edition).classes.find((c) => c.id === "test-config-loosened");
    const paths = cls.detectors.filter((d) => d.lever === "check-driver").flatMap((d) => d.params.paths);
    assert.ok(paths.length, edition + "'s test-config-loosened is scoped to nothing");
    assert.ok(paths.some((p) => glob.test(p)), edition + " does not watch " + glob + ": " + paths.join(", "));
    // Not a source glob: this class reads config, and a class that also read
    // source would be a second copy of every other check in the edition.
    for (const p of paths) {
      assert.ok(!/\*\*\/\*\.(?:js|ts|py|go|cs|rs|java|kt)$/.test(p), edition + " scopes its config check at source: " + p);
    }
  }
});

// The judges' call on N13: this is a check-driver over what was COMMITTED, and
// nothing else. A bash-guard in a catalogue would derive a session lever from
// catalogue data, which SCOPE:205 forbids and the panel rejected twice.
test("the wholesale snapshot update is read off committed scripts and workflows only", () => {
  const cls = editions.loadEdition(PLUGIN_ROOT, "javascript-typescript").classes
    .find((c) => c.id === "snapshot-updated-wholesale");
  assert.ok(cls, "the javascript-typescript edition ships no snapshot-updated-wholesale");
  for (const det of cls.detectors) {
    assert.equal(det.lever, "check-driver", "a session lever reached the catalogue: " + det.lever);
  }
  const paths = cls.detectors.flatMap((d) => d.params.paths);
  for (const p of paths) {
    assert.ok(/workflows|gitlab-ci|package\.json|Makefile|\.sh$/.test(p),
      "snapshot-updated-wholesale reads something that is not a committed script or workflow: " + p);
  }
  assert.equal(firesOn("javascript-typescript", "snapshot-updated-wholesale", "      - run: npx vitest run -u\n"), true);
  assert.equal(firesOn("javascript-typescript", "snapshot-updated-wholesale",
    "    \"test:snap\": \"jest --updateSnapshot\"\n"), true);
  assert.equal(firesOn("javascript-typescript", "snapshot-updated-wholesale",
    "      - run: npx vitest run --coverage\n"), false);
});
