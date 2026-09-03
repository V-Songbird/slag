"use strict";

// The admission test is the only thing that admits a check, so these cases are
// written as the five ways a check can be wrong plus the one way it can be
// right. The blanker is the real one the session guards use — a pair proved
// against a toy blanker proves nothing about what the driver will read.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const admission = require("../scripts/admission.js");
const { blankRegions, evalSessionDetector } = require("../hooks/jig-lib.js");

const blank = (text, filename, opts) => blankRegions(text, filename, opts);

const roots = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jig-admission-"));
  roots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

const DENY = {
  reason: "This edit swallows the error, so nothing downstream can tell it failed.",
  alternative: "Rethrow, or return a visibly degraded value.",
  override: "set the guard to observe in .jig/config.json",
};

function check(over) {
  return {
    id: "swallowed-exception",
    deny: DENY,
    detectors: [{
      lever: "check-driver",
      params: { patterns: ["catch\\s*(\\([^)]*\\))?\\s*\\{\\s*\\}"], paths: ["**/*.js"] },
    }],
    fixtures: {
      violation: "try {\n  save(row);\n} catch (err) {}\n",
      nearMiss: "try {\n  save(row);\n} catch (err) {\n  throw new Error('save failed: ' + err.message);\n}\n",
    },
    ...over,
  };
}

test("a check whose patterns fire on the violation and miss the near miss passes", () => {
  const result = admission.ownPair(check(), blank);
  assert.deepEqual(result, {
    id: "swallowed-exception",
    violationHits: 1,
    nearMissHits: 0,
    passes: true,
    why: null,
  });
  assert.deepEqual(admission.admit([check()], blank).discarded, []);
});

test("a pattern that never fires on its own violation fails the pair", () => {
  const missing = check({
    detectors: [{ lever: "check-driver", params: { patterns: ["\\bdebugger\\b"], paths: ["**/*.js"] } }],
  });
  const result = admission.ownPair(missing, blank);
  assert.equal(result.passes, false);
  assert.equal(result.violationHits, 0);
  assert.match(result.why, /never fired on the violation fixture/);

  const { admitted, discarded } = admission.admit([missing], blank);
  assert.deepEqual(admitted, []);
  assert.equal(discarded.length, 1);
  assert.match(discarded[0].why, /never fired on the violation/);
});

test("a pattern that fires on its own near miss fails the pair", () => {
  const loose = check({
    detectors: [{ lever: "check-driver", params: { patterns: ["catch"], paths: ["**/*.js"] } }],
  });
  const result = admission.ownPair(loose, blank);
  assert.equal(result.passes, false);
  assert.equal(result.violationHits, 1);
  assert.equal(result.nearMissHits, 1);
  assert.match(result.why, /fired on the near miss/);
  assert.deepEqual(admission.admit([loose], blank).admitted, []);
});

test("a declared expectedNearMissHits admits the check and is carried into the result", () => {
  const heuristic = check({
    expectedNearMissHits: 1,
    detectors: [{ lever: "check-driver", params: { patterns: ["catch"], paths: ["**/*.js"] } }],
  });
  const { admitted, discarded } = admission.admit([heuristic], blank);
  assert.deepEqual(discarded, []);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].nearMissHits, 1);
  assert.equal(admitted[0].expectedNearMissHits, 1);
  // One tolerated hit does not buy a second.
  const worse = check({
    id: "greedy",
    expectedNearMissHits: 1,
    detectors: [{ lever: "check-driver", params: { patterns: ["catch", "save"], paths: ["**/*.js"] } }],
  });
  assert.equal(admission.admit([worse], blank).admitted.length, 0);
});

test("an incomplete deny triple discards the check before its fixtures are read", () => {
  for (const part of ["reason", "alternative", "override"]) {
    const partial = { ...DENY };
    delete partial[part];
    const { admitted, discarded } = admission.admit([check({ deny: partial })], blank);
    assert.deepEqual(admitted, []);
    assert.match(discarded[0].why, new RegExp("incomplete deny triple — missing " + part));
  }
  const none = admission.admit([check({ deny: undefined })], blank);
  assert.match(none.discarded[0].why, /declares no deny triple/);
});

// Defect 23: slag's own focused-test shipped an `alternative` sliced out of a
// catalogue note, complete by the presence rule and meaningless to the agent it
// refuses. The fixture pair cannot read prose; these two properties it can.
test("a deny part cut off inside an unclosed code span discards the check", () => {
  const garbled = "A focus applied dynamically — `const t = condition ? it. Fix the occurrence.";
  for (const part of ["reason", "alternative", "override"]) {
    const { admitted, discarded } = admission.admit([check({ deny: { ...DENY, [part]: garbled } })], blank);
    assert.deepEqual(admitted, []);
    assert.match(discarded[0].why, new RegExp("its " + part + " ends inside an unclosed code span"));
  }
  // A closed span is prose the author finished, and stays admissible.
  const whole = { ...DENY, alternative: "Drop the `.only` before you commit the file." };
  assert.deepEqual(admission.admit([check({ deny: whole })], blank).discarded, []);
});

test("a deny part under the length floor discards the check", () => {
  const { admitted, discarded } = admission.admit([check({ deny: { ...DENY, override: "no." } })], blank);
  assert.deepEqual(admitted, []);
  assert.match(discarded[0].why, /its override is 3 characters, under the 20-character floor/);
});

test("a check that declares no fixtures is discarded, not silently admitted", () => {
  const { admitted, discarded } = admission.admit([check({ fixtures: { violation: "try {} catch (e) {}" } })], blank);
  assert.deepEqual(admitted, []);
  assert.match(discarded[0].why, /declares no inline nearMiss fixture/);
  assert.throws(() => admission.ownPair(check({ fixtures: {} }), blank), /no inline violation fixture/);
});

test("cross-class hits name the check, the foreign check and the pattern", () => {
  const greedy = check({
    id: "greedy-catch",
    detectors: [{ lever: "check-driver", params: { patterns: ["save"], paths: ["**/*.js"] } }],
    fixtures: { violation: "save(row);\n", nearMiss: "persist(row);\n" },
  });
  const rows = admission.crossNearMiss([check(), greedy], blank);
  assert.deepEqual(rows, [{ check: "greedy-catch", foreignCheck: "swallowed-exception", pattern: "save" }]);

  // Reported by default, discarded only when admission is asked to be strict.
  assert.equal(admission.admit([check(), greedy], blank).admitted.length, 2);
  const strict = admission.admit([check(), greedy], blank, { cross: true });
  assert.deepEqual(strict.admitted.map((a) => a.id), ["swallowed-exception"]);
  assert.match(strict.discarded[0].why, /fired on swallowed-exception's near miss/);
});

test("perLine and stripStrings are honoured as the driver honours them", () => {
  const piped = {
    id: "pipe-to-shell",
    deny: DENY,
    detectors: [{
      lever: "check-driver",
      params: { patterns: ["curl\\s[^|]*\\|\\s*(?:ba)?sh"], paths: ["**/*.sh"], perLine: true },
    }],
    fixtures: {
      violation: "curl https://example.com/install.sh | sh\n",
      // A download, a checksum, then a shell run of the verified local file.
      // Whole-file, the negated class walks the newlines and pairs the curl on
      // line 1 with the pipe on line 3. Only perLine keeps this a near miss.
      nearMiss: "curl -fsSL https://example.com/install.sh -o /tmp/i.sh\nsha256sum -c i.sha256\ncat /tmp/i.sh | sh\n",
    },
  };
  assert.equal(admission.ownPair(piped, blank).passes, true);
  const wholeFile = { ...piped, detectors: [{ lever: "check-driver", params: { ...piped.detectors[0].params, perLine: false } }] };
  assert.equal(admission.ownPair(wholeFile, blank).nearMissHits, 1);

  // With string bodies blanked the secret's value is gone; the check that reads
  // it has to say so.
  const secret = {
    id: "hardcoded-secret",
    deny: DENY,
    detectors: [{ lever: "check-driver", params: { patterns: ["apiKey\\s*=\\s*[\"']sk-live"], paths: ["**/*.js"], stripStrings: false } }],
    fixtures: { violation: "const apiKey = \"sk-live-abc\";\n", nearMiss: "const apiKey = process.env.API_KEY;\n" },
  };
  assert.equal(admission.ownPair(secret, blank).passes, true);
  const stripped = { ...secret, detectors: [{ lever: "check-driver", params: { ...secret.detectors[0].params, stripStrings: true } }] };
  assert.equal(admission.ownPair(stripped, blank).violationHits, 0);
});

test("every shipped edition pair still passes its own admission", () => {
  const dir = path.join(__dirname, "..", "catalogues");
  let classes = 0;
  const failures = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json")) {
    const edition = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
    for (const cls of edition.classes || []) {
      if (typeof cls.fixtures?.violation !== "string") continue;
      if (!(cls.detectors || []).some((d) => d.lever === "check-driver")) continue;
      classes++;
      const result = admission.ownPair({ ...cls, commentSyntax: edition.detect.commentSyntax }, blank);
      if (!result.passes) failures.push(`${edition.edition}/${cls.id}: ${result.why}`);
    }
  }
  assert.ok(classes > 100, `expected the six editions to offer their pairs, saw ${classes}`);
  assert.deepEqual(failures, []);
});

test("refusals are errors a human can act on", () => {
  assert.throws(() => admission.ownPair(check(), null), /no blanker function was injected/);
  assert.throws(() => admission.ownPair({ deny: DENY }, blank), /every check needs a string id/);
  assert.throws(() => admission.ownPair(check({ detectors: [] }), blank), /declares no check-driver patterns/);
  assert.throws(() => admission.ownPair(check({ detectors: [{ lever: "check-driver", params: { patterns: ["("], paths: ["**/*.js"] } }] }), blank), /unusable pattern/);
  assert.throws(() => admission.admit([check(), check()], blank), /two checks claim the id/);
  assert.throws(() => admission.admit(check(), blank), /expects an array/);
  const bad = admission.admit([check({ expectedNearMissHits: -1 })], blank);
  assert.match(bad.discarded[0].why, /non-negative integer/);
});

// ---------------------------------------------------------------------------
// The paired-change kind
// ---------------------------------------------------------------------------
//
// Its fixtures are change sets rather than source, so the whole point of these
// cases is that a check with no pattern in it is still admitted the same way:
// on its own pair, and on nothing else.

const { globToRegExp } = require("../hooks/jig-lib.js");
const match = (glob) => globToRegExp(glob);

function paired(over) {
  return {
    id: "doc-left-behind",
    deny: DENY,
    detectors: [{
      lever: "check-driver",
      params: { paths: ["src/engine/**"], pairedWith: ["docs/**/*.md"] },
    }],
    fixtures: {
      violation: "src/engine/solver.ts\nsrc/engine/types.ts\n",
      nearMiss: "src/engine/solver.ts\ndocs/engine.md\n",
    },
    ...over,
  };
}

test("a paired-change check is admitted on a change set the way a pattern check is on source", () => {
  const result = admission.ownPair(paired(), blank, match);
  assert.deepEqual(result, {
    id: "doc-left-behind",
    violationHits: 1,
    nearMissHits: 0,
    passes: true,
    why: null,
  });
  assert.deepEqual(admission.admit([paired()], blank, { match }).discarded, []);
});

test("a paired rule its own violation does not trip is discarded", () => {
  // The violation set names nothing under `paths`, so nothing obliged the docs
  // to move and the rule is silent on the very change it was written for.
  const wrong = paired({ fixtures: { violation: "README.md\n", nearMiss: "src/engine/a.ts\ndocs/a.md\n" } });
  const result = admission.ownPair(wrong, blank, match);
  assert.equal(result.passes, false);
  assert.equal(result.violationHits, 0);
  assert.match(result.why, /never fired on the violation fixture/);
  assert.deepEqual(admission.admit([wrong], blank, { match }).admitted, []);
});

test("a paired rule that also fires on its own near miss is discarded", () => {
  // `pairedWith` names a path this repository never has, so every change to the
  // engine reads as drift — including the near miss that updated the doc.
  const loose = paired({
    detectors: [{ lever: "check-driver", params: { paths: ["src/engine/**"], pairedWith: ["CHANGELOG.md"] } }],
  });
  const result = admission.ownPair(loose, blank, match);
  assert.equal(result.passes, false);
  assert.equal(result.nearMissHits, 1);
  assert.match(result.why, /fired on the near miss/);
  assert.deepEqual(admission.admit([loose], blank, { match }).admitted, []);
});

test("a paired check with no glob matcher injected is discarded, never admitted untested", () => {
  assert.throws(() => admission.ownPair(paired(), blank), /no glob matcher was injected/);
  const { admitted, discarded } = admission.admit([paired()], blank);
  assert.deepEqual(admitted, []);
  assert.match(discarded[0].why, /no glob matcher was injected/);
});

test("a paired check that fires on everything is caught by another paired check's near miss", () => {
  const greedy = paired({
    id: "fires-on-everything",
    detectors: [{ lever: "check-driver", params: { paths: ["**"], pairedWith: ["nothing/ever/here.md"] } }],
    fixtures: { violation: "anything.ts\n", nearMiss: "nothing/ever/here.md\n" },
  });
  const rows = admission.crossNearMiss([paired(), greedy], blank, match);
  assert.deepEqual(rows, [{ check: "fires-on-everything", foreignCheck: "doc-left-behind", pattern: "paired-change" }]);

  const { admitted, discarded } = admission.admit([paired(), greedy], blank, { cross: true, match });
  assert.deepEqual(admitted.map((a) => a.id), ["doc-left-behind"]);
  assert.equal(discarded.length, 1);
  assert.match(discarded[0].why, /fired on doc-left-behind's near miss/);
});

test("the two kinds are never crossed against each other", () => {
  // A source pattern over a list of paths, or a path rule over somebody's
  // JavaScript, compares two different kinds of thing and would fail at random.
  assert.deepEqual(admission.crossNearMiss([check(), paired()], blank, match), []);
});

// ---------------------------------------------------------------------------
// The removal kind
// ---------------------------------------------------------------------------
//
// A removal is not in any file's content: the deleted case is absent from the
// text that is left, which is why `onlyWhenRemoved` over one text could never
// pass this test. So each fixture carries two texts, fenced by `--- after`, and
// the rule is that the count went down.

function removed(over) {
  return {
    id: "tests-deleted",
    deny: DENY,
    detectors: [{
      lever: "check-driver",
      params: { removed: ["\\b(?:it|test)\\s*\\("], paths: ["**/*.test.js"] },
    }],
    fixtures: {
      violation: "describe('suite', () => {\n  it('a', () => {});\n  it('b', () => {});\n});\n" +
        "--- after\ndescribe('suite', () => {\n  it('a', () => {});\n});\n",
      // The near miss drops the redundant `describe` wrapper and keeps both
      // cases: an edit that removes real text without removing a test.
      nearMiss: "describe('suite', () => {\n  it('a', () => {});\n  it('b', () => {});\n});\n" +
        "--- after\nit('a', () => {});\nit('b', () => {});\n",
    },
    ...over,
  };
}

test("a removal check is admitted when the count drops on the violation and holds on the near miss", () => {
  const result = admission.ownPair(removed(), blank);
  assert.deepEqual(result, {
    id: "tests-deleted",
    violationHits: 1,
    nearMissHits: 0,
    passes: true,
    why: null,
  });
  assert.deepEqual(admission.admit([removed()], blank).discarded, []);
});

test("a removal rule its own violation does not trip is discarded", () => {
  // The edit renamed a case rather than deleting one, so nothing was removed and
  // the rule is silent on the very change it was written for.
  const wrong = removed({
    fixtures: {
      violation: "it('a', () => {});\n--- after\nit('renamed a', () => {});\n",
      nearMiss: "it('a', () => {});\n--- after\nit('a', () => { expect(1).toBe(1); });\n",
    },
  });
  const result = admission.ownPair(wrong, blank);
  assert.equal(result.passes, false);
  assert.equal(result.violationHits, 0);
  assert.match(result.why, /never fired on the violation fixture: removal/);
  assert.deepEqual(admission.admit([wrong], blank).admitted, []);
});

test("a removal rule that also fires on its own near miss is discarded", () => {
  // Counting arrow functions instead of cases goes down on any edit that
  // removes a wrapper, including the near miss that kept every case.
  const loose = removed({
    detectors: [{ lever: "check-driver", params: { removed: ["=>"], paths: ["**/*.test.js"] } }],
  });
  const result = admission.ownPair(loose, blank);
  assert.equal(result.passes, false);
  assert.equal(result.nearMissHits, 1);
  assert.match(result.why, /fired on the near miss: removal/);
  assert.deepEqual(admission.admit([loose], blank).admitted, []);
});

test("a removal fixture with no `--- after` fence is discarded, never admitted on half a pair", () => {
  const halved = removed({
    fixtures: { violation: "it('a', () => {});\n", nearMiss: "it('a', () => {});\nit('b', () => {});\n" },
  });
  assert.throws(() => admission.ownPair(halved, blank), /violation fixture has no `--- after` fence/);
  const { admitted, discarded } = admission.admit([halved], blank);
  assert.deepEqual(admitted, []);
  assert.match(discarded[0].why, /`--- after` fence/);
});

test("a case that only ever lived in a comment is not a removal", () => {
  // Both halves are blanked before they are counted, exactly as the pattern kind
  // blanks a file — otherwise deleting a commented-out example reads as deleting
  // the test it quotes.
  const commented = removed({
    fixtures: {
      violation: "it('a', () => {});\nit('b', () => {});\n--- after\nit('a', () => {});\n",
      nearMiss: "it('a', () => {});\n// it('b', () => {});\n--- after\nit('a', () => {});\n",
    },
  });
  const result = admission.ownPair(commented, blank);
  assert.equal(result.passes, true);
  assert.equal(result.nearMissHits, 0);
});

test("a removal check that reads every edit as a deletion is caught by another one's near miss", () => {
  const greedy = removed({
    id: "fires-on-everything",
    detectors: [{ lever: "check-driver", params: { removed: ["\\w"], paths: ["**/*.test.js"] } }],
    fixtures: {
      violation: "aaaa\n--- after\na\n",
      nearMiss: "a\n--- after\naaaa\n",
    },
  });
  const rows = admission.crossNearMiss([removed(), greedy], blank, match);
  assert.deepEqual(rows, [{ check: "fires-on-everything", foreignCheck: "tests-deleted", pattern: "removal" }]);

  const { admitted, discarded } = admission.admit([removed(), greedy], blank, { cross: true, match });
  assert.deepEqual(admitted.map((a) => a.id), ["tests-deleted"]);
  assert.equal(discarded.length, 1);
  assert.match(discarded[0].why, /fired on tests-deleted's near miss/);
});

test("removal crosses only among removal kinds", () => {
  // A pattern check reading a fenced pair, or a removal rule counting a list of
  // paths, compares two different kinds of thing and would fail at random.
  assert.deepEqual(admission.crossNearMiss([check(), removed(), paired()], blank, match), []);
});

// ---------------------------------------------------------------------------
// The extract kind
// ---------------------------------------------------------------------------
//
// The doc-sync mistake co-change cannot reach: both files moved, and the doc
// names the thing the code no longer has. So each fixture carries two texts —
// the doc, then the union its names have to appear in, fenced by `--- paired`.

function extract(over) {
  return {
    id: "doc-names-what-the-code-lost",
    deny: DENY,
    detectors: [{
      lever: "check-driver",
      params: { paths: ["docs/**/*.md"], extract: ["`(--[a-z][a-z0-9-]*)`"], pairedWith: ["src/**/*.js"] },
    }],
    fixtures: {
      violation: "Pass `--outdir` to choose where the build lands.\n--- paired\nconst flags = ['--out-dir'];\n",
      nearMiss: "Pass `--out-dir` to choose where the build lands.\n--- paired\nconst flags = ['--out-dir'];\n",
    },
    ...over,
  };
}

test("an extract check is admitted when the doc names what the union lacks and not when it does not", () => {
  const result = admission.ownPair(extract(), blank);
  assert.deepEqual(result, {
    id: "doc-names-what-the-code-lost",
    violationHits: 1,
    nearMissHits: 0,
    passes: true,
    why: null,
  });
  assert.deepEqual(admission.admit([extract()], blank).discarded, []);
});

// The kind is `extract`, and `pairedWith` means something else here than it does
// on a paired-change detector: not "this had to change alongside" but "this is
// where the names have to appear". Read as the other kind it would be held to a
// change-set fixture it is not, and discarded for wanting a glob matcher.
test("an extract detector is never read as a paired-change rule", () => {
  const result = admission.ownPair(extract(), blank);
  assert.equal(result.violationHits, 1, "the paired half counted a second hit off the same detector");
  assert.deepEqual(admission.admit([extract()], blank).admitted.map((a) => a.id),
    ["doc-names-what-the-code-lost"]);
});

test("an extract rule its own violation does not trip is discarded", () => {
  // The doc was corrected in the same edit, so nothing in it names anything the
  // union lacks and the rule is silent on the very drift it was written for.
  const wrong = extract({
    fixtures: {
      violation: "Pass `--out-dir` to choose where the build lands.\n--- paired\nconst flags = ['--out-dir'];\n",
      nearMiss: "Pass `--out-dir` to choose where the build lands.\n--- paired\nconst flags = ['--out-dir'];\n",
    },
  });
  const result = admission.ownPair(wrong, blank);
  assert.equal(result.passes, false);
  assert.equal(result.violationHits, 0);
  assert.match(result.why, /never fired on the violation fixture: extract/);
  assert.deepEqual(admission.admit([wrong], blank).admitted, []);
});

test("an extract rule that also fires on its own near miss is discarded", () => {
  // Capturing the whole code span rather than the flag inside it takes the
  // backticks with it, and no source file has those — so the corrected doc reads
  // as drift too.
  const loose = extract({
    detectors: [{
      lever: "check-driver",
      params: { paths: ["docs/**/*.md"], extract: ["(`--[a-z][a-z0-9-]*`)"], pairedWith: ["src/**/*.js"] },
    }],
  });
  const result = admission.ownPair(loose, blank);
  assert.equal(result.passes, false);
  assert.equal(result.nearMissHits, 1);
  assert.match(result.why, /fired on the near miss: extract/);
  assert.deepEqual(admission.admit([loose], blank).admitted, []);
});

test("an extract fixture with no `--- paired` fence is discarded, never admitted on half a pair", () => {
  const halved = extract({
    fixtures: {
      violation: "Pass `--outdir` to choose where the build lands.\n",
      nearMiss: "Pass `--out-dir` to choose where the build lands.\n",
    },
  });
  assert.throws(() => admission.ownPair(halved, blank), /violation fixture has no `--- paired` fence/);
  const { admitted, discarded } = admission.admit([halved], blank);
  assert.deepEqual(admitted, []);
  assert.match(discarded[0].why, /`--- paired` fence/);
});

test("an extract check that reads every doc as drifted is caught by another one's near miss", () => {
  // `(\w+)` takes every word out of the doc, and no union has every word — so it
  // reports drift on any pair of files. Its own violation cannot show that.
  const greedy = extract({
    id: "fires-on-everything",
    detectors: [{
      lever: "check-driver",
      params: { paths: ["docs/**/*.md"], extract: ["(\\w+)"], pairedWith: ["src/**/*.js"] },
    }],
    fixtures: { violation: "alpha\n--- paired\nbeta\n", nearMiss: "beta\n--- paired\nbeta\n" },
  });
  const rows = admission.crossNearMiss([extract(), greedy], blank, match);
  assert.deepEqual(rows,
    [{ check: "fires-on-everything", foreignCheck: "doc-names-what-the-code-lost", pattern: "extract" }]);

  const { admitted, discarded } = admission.admit([extract(), greedy], blank, { cross: true, match });
  assert.deepEqual(admitted.map((a) => a.id), ["doc-names-what-the-code-lost"]);
  assert.equal(discarded.length, 1);
  assert.match(discarded[0].why, /fired on doc-names-what-the-code-lost's near miss/);
});

test("extract crosses only among extract kinds", () => {
  // A capture regex over a list of paths, or a source pattern over a doc fenced
  // against its union, compares two different kinds of thing.
  assert.deepEqual(admission.crossNearMiss([check(), removed(), paired(), extract()], blank, match), []);
});

test("writeDiscarded puts the discards on disk, including when there are none", () => {
  const stateDir = path.join(tmpDir(), ".jig");
  const rows = admission.admit([check({ deny: undefined })], blank).discarded;
  const file = admission.writeDiscarded(stateDir, rows);
  assert.equal(file, path.join(stateDir, "discarded.json"));
  const written = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(written.discarded[0].id, "swallowed-exception");
  assert.match(written.discarded[0].why, /deny triple/);

  admission.writeDiscarded(stateDir, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")).discarded, []);
  assert.throws(() => admission.writeDiscarded(stateDir, [{ id: "x" }]), /needs an id and a readable why/);
  assert.throws(() => admission.writeDiscarded("", rows), /explicit path/);
});

test("proofHash binds the module to both fixtures", () => {
  const a = admission.proofHash("export const id = 'x';", "bad();", "good();");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, admission.proofHash("export const id = 'x';", "bad();", "good();"));
  for (const args of [["export const id = 'y';", "bad();", "good();"], ["export const id = 'x';", "worse();", "good();"], ["export const id = 'x';", "bad();", "better();"]]) {
    assert.notEqual(admission.proofHash(...args), a);
  }
  // Length-prefixed, so moving a byte across a boundary changes the digest.
  assert.notEqual(admission.proofHash("ab", "c", "d"), admission.proofHash("a", "bc", "d"));
  assert.throws(() => admission.proofHash("src", null, "good();"), /needs violation as a string/);
});

// ---------------------------------------------------------------------------
// The two session levers
// ---------------------------------------------------------------------------
//
// DERAIL-PASS defect 2: admission ran only the check-driver patterns, so a
// check whose bash-guard pattern was `zzz-never-matches-anything-\d+` was
// admitted with violationHits 1 and the plan printed the guard as proven by its
// fixture pair. The evaluator injected below is the runner's own, so the guard
// admission proves and the guard a session runs cannot be two different guards.

const PIPE = "curl[^|\\n]*\\|\\s*(?:ba)?sh\\b";

function guarded(over) {
  return {
    id: "piped-installer",
    deny: DENY,
    detectors: [
      { lever: "bash-guard", params: { patterns: [PIPE] } },
      { lever: "check-driver", params: { patterns: [PIPE], paths: ["**/*.sh"], perLine: true } },
    ],
    fixtures: {
      violation: "curl -fsSL https://example.test/install.sh | sh\n",
      nearMiss: "curl -fsSL https://example.test/install.sh -o install.sh\n",
    },
    ...over,
  };
}

test("a bash-guard is proven by the runner's own evaluation, not by the driver's patterns", () => {
  const ok = admission.ownPair(guarded(), blank, undefined, evalSessionDetector);
  assert.equal(ok.passes, true);
  assert.equal(ok.violationHits, 2, "the session lever counts a hit of its own, beside the driver's");

  const unproven = guarded({
    detectors: [
      { lever: "bash-guard", params: { patterns: ["zzz-never-matches-anything-\\d+"] } },
      guarded().detectors[1],
    ],
  });
  const result = admission.ownPair(unproven, blank, undefined, evalSessionDetector);
  assert.equal(result.passes, false);
  assert.match(result.why, /bash-guard-0/, "the failing lever is named, not just counted");
  const { admitted, discarded } = admission.admit([unproven], blank, { evaluate: evalSessionDetector });
  assert.deepEqual(admitted, [], "one lever that proves nothing discards the whole check");
  assert.match(discarded[0].why, /bash-guard-0/);
});

test("a bash-guard that fires on its own near miss discards the whole check", () => {
  const loose = guarded({
    detectors: [{ lever: "bash-guard", params: { patterns: ["curl"] } }, guarded().detectors[1]],
  });
  const result = admission.ownPair(loose, blank, undefined, evalSessionDetector);
  assert.equal(result.nearMissHits, 1);
  assert.match(result.why, /bash-guard-0/);
  assert.deepEqual(admission.admit([loose], blank, { evaluate: evalSessionDetector }).admitted, []);
});

test("an edit-observe-guard is proven at a path its own globs match", () => {
  // The edit lever is path-scoped, so a fixture dropped at the repository root
  // would be out of scope for this detector and the check would be discarded
  // for doing exactly what it was authored to do.
  const scoped = {
    id: "swallowed-exception-src",
    deny: DENY,
    detectors: [{
      lever: "edit-observe-guard",
      params: {
        patterns: ["catch\\s*(\\([^)]*\\))?\\s*\\{\\s*\\}"],
        paths: ["src/**/*.ts"],
        onlyWhenIntroduced: true,
      },
    }],
    fixtures: check().fixtures,
  };
  const ok = admission.ownPair(scoped, blank, undefined, evalSessionDetector);
  assert.deepEqual(ok, {
    id: "swallowed-exception-src",
    violationHits: 1,
    nearMissHits: 0,
    passes: true,
    why: null,
  });

  const missing = { ...scoped, detectors: [{ ...scoped.detectors[0], params: { ...scoped.detectors[0].params, patterns: ["\\bdebugger\\b"] } }] };
  const result = admission.ownPair(missing, blank, undefined, evalSessionDetector);
  assert.equal(result.passes, false);
  assert.match(result.why, /edit-observe-guard-0/);
});

// 2.11.0 / C2. `edit-guard` is the same detector at PreToolUse, and it earns
// its place the same way roadmap 199 made the other two earn theirs: through
// the runner's own evaluation, at a path its own globs match.
test("an edit-guard is proven the way the lever it replaces is", () => {
  const prevented = {
    id: "swallowed-exception-prevented",
    deny: DENY,
    detectors: [{
      lever: "edit-guard",
      params: { patterns: ["catch\\s*(\\([^)]*\\))?\\s*\\{\\s*\\}"], paths: ["src/**/*.ts"] },
    }],
    fixtures: check().fixtures,
  };
  const ok = admission.ownPair(prevented, blank, undefined, evalSessionDetector);
  assert.equal(ok.passes, true);
  assert.equal(ok.violationHits, 1);
  assert.deepEqual(admission.admit([prevented], blank, { evaluate: evalSessionDetector }).discarded, []);

  const missing = { ...prevented, detectors: [{ ...prevented.detectors[0], params: { patterns: ["\\bdebugger\\b"] } }] };
  const result = admission.ownPair(missing, blank, undefined, evalSessionDetector);
  assert.equal(result.passes, false);
  assert.match(result.why, /edit-guard-0/, "the failing lever is named, not just counted");
});

// 2.11.0 / N11. The removal kind on a session lever. A fenced fixture IS an
// edit — the file before it and the file after it — so it is proven as one,
// which is the only way a rule about a count going down can be demonstrated at
// all. Before this, `evalSessionDetector` built a Write payload with no
// `old_string`, so a removal lever missed its own violation and every check
// carrying one was discarded while the SKILL and six catalogues said the session
// lane was where it watched.
const REMOVAL_PAIR = {
  violation: "it('a', () => {});\nit('b', () => {});\n--- after\nit('a', () => {});\n",
  nearMiss: "it('a', () => {});\n--- after\nit('a', () => { expect(1).toBe(1); });\n",
};

test("a removal on a session lever is proven by the edit its fenced pair describes", () => {
  const session = {
    id: "tests-deleted-session",
    deny: DENY,
    detectors: [{
      lever: "edit-guard",
      params: { paths: ["**/*.test.js"], removed: ["\\b(?:it|test)\\s*\\("] },
    }],
    fixtures: REMOVAL_PAIR,
  };
  const ok = admission.ownPair(session, blank, undefined, evalSessionDetector);
  assert.equal(ok.passes, true);
  assert.equal(ok.violationHits, 1);
  assert.equal(ok.nearMissHits, 0);
  assert.deepEqual(admission.admit([session], blank, { evaluate: evalSessionDetector }).discarded, []);

  // And it is held to a fence like every other removal: unfenced there is no
  // before, and a check admitted over half a pair would claim a deletion it
  // never saw one of.
  const unfenced = { ...session, fixtures: { violation: "it('a', () => {});\n", nearMiss: "it('b', () => {});\n" } };
  assert.throws(() => admission.ownPair(unfenced, blank, undefined, evalSessionDetector),
    /violation fixture has no `--- after` fence/);
});

test("a `removed` rule beside patterns is proven on its own, never on the patterns' hit", () => {
  // The smuggle: one evaluation over the whole detector fires on either kind, so
  // a `removed: ["."]` nobody exercised rode into an armed guard under the
  // patterns' proof — and then denied any edit that shortened a file.
  const smuggled = {
    id: "smuggled-removal",
    deny: DENY,
    detectors: [{
      lever: "edit-guard",
      params: { paths: ["**/*.test.js"], patterns: ["\\bit\\.only\\s*\\("], removed: ["."] },
    }],
    fixtures: { violation: "it.only('a', () => {});\n", nearMiss: "it('a', () => {});\n" },
  };
  const out = admission.admit([smuggled], blank, { evaluate: evalSessionDetector });
  assert.deepEqual(out.admitted, [], "a rule the pair never exercised was admitted as proven");
  assert.match(out.discarded[0].why, /`--- after` fence/);

  // Both kinds on one detector count one hit each, and each names itself.
  const both = {
    ...smuggled,
    detectors: [{
      lever: "edit-guard",
      params: { paths: ["**/*.test.js"], patterns: ["\\bit\\s*\\("], removed: ["\\b(?:it|test)\\s*\\("] },
    }],
    fixtures: REMOVAL_PAIR,
  };
  const ok = admission.ownPair(both, blank, undefined, evalSessionDetector);
  assert.equal(ok.violationHits, 2, "one of the two kinds on the detector was never proven");
  const half = { ...both, detectors: [{ ...both.detectors[0],
    params: { ...both.detectors[0].params, removed: ["\\bnothing-here\\b"] } }] };
  const result = admission.ownPair(half, blank, undefined, evalSessionDetector);
  assert.equal(result.passes, false);
  assert.match(result.why, /edit-guard-0 \(removed\)/, "the failing kind is named, not just the detector");
});

// 2.11.0 / N14. The laziness classes are authored for the "Me and my AI
// sessions" persona as ONE module with a driver and an edit guard over the same
// patterns, so the mistake is refused in the session AND caught at commit. That
// shape is only writable if one fixture pair proves both levers — two pairs per
// module would be two checks wearing one id — so this is the assertion the
// SKILL's guidance rests on.
test("one fixture pair proves both a check-driver and the edit-guard beside it", () => {
  const ONLY = "\\b(?:describe|it|test)\\s*\\.\\s*only\\s*\\(";
  const twinned = (over) => ({
    id: "focused-test",
    deny: DENY,
    detectors: [
      { lever: "check-driver", params: { paths: ["**/*.test.js"], patterns: [ONLY] } },
      { lever: "edit-guard", params: { paths: ["**/*.test.js"], patterns: [ONLY], onlyWhenIntroduced: true } },
    ],
    fixtures: {
      violation: "it.only('collapses runs of whitespace', () => {});\n",
      nearMiss: "it('collapses runs of whitespace', () => {});\n",
    },
    ...over,
  });

  const ok = admission.ownPair(twinned(), blank, undefined, evalSessionDetector);
  assert.equal(ok.passes, true);
  // Two hits off one pair: the driver's pattern and the guard's own evaluation.
  assert.equal(ok.violationHits, 2, "one of the two levers was never proven");
  assert.equal(ok.nearMissHits, 0);
  assert.deepEqual(admission.admit([twinned()], blank, { evaluate: evalSessionDetector }).discarded, []);

  // Either lever failing discards the WHOLE module, so a plan can never print
  // the driver as coverage while the session half sits unproven beside it.
  for (const [i, id] of [[0, "check-driver"], [1, "edit-guard-1"]]) {
    const dets = twinned().detectors.map((det, j) => (j === i
      ? { ...det, params: { ...det.params, patterns: ["\\bdebugger\\b"] } } : det));
    const out = admission.admit([twinned({ detectors: dets })], blank, { evaluate: evalSessionDetector });
    assert.deepEqual(out.admitted, [], id + " failed its own pair and the module was still admitted");
    assert.match(out.discarded[0].why, i === 0 ? /debugger/ : /edit-guard-1/);
  }
});

// The cross pairs a lever against its own KIND — a command against a command,
// an edit against an edit. That is no longer the same question as which event a
// lever runs on: `bash-guard` and `edit-guard` share PreToolUse and read nothing
// alike, so crossing them would discard both for a reason neither is guilty of.
test("the cross never runs a bash-guard over an edit guard's near-miss source", () => {
  const bashOnly = {
    id: "save-by-shell",
    deny: DENY,
    // The word is in the edit check's near miss, so grouping the cross by event
    // rather than by kind fires this guard on source it will never be handed.
    detectors: [{ lever: "bash-guard", params: { patterns: ["\\bsave\\b"] } }],
    fixtures: { violation: "save --force\n", nearMiss: "restore --dry-run\n" },
  };
  const prevented = {
    id: "swallowed-exception-prevented",
    deny: DENY,
    detectors: [{ lever: "edit-guard", params: { patterns: ["catch\\s*(\\([^)]*\\))?\\s*\\{\\s*\\}"] } }],
    fixtures: check().fixtures,
  };
  const out = admission.admit([bashOnly, prevented], blank, { cross: true, evaluate: evalSessionDetector });
  assert.deepEqual(out.discarded, []);
  assert.deepEqual(out.admitted.map((a) => a.id).sort(), ["save-by-shell", "swallowed-exception-prevented"]);
});

test("a check carrying a session lever with no evaluator injected is discarded, never admitted untested", () => {
  assert.throws(() => admission.ownPair(guarded(), blank), /no session evaluator was injected/);
  const { admitted, discarded } = admission.admit([guarded()], blank);
  assert.deepEqual(admitted, []);
  assert.match(discarded[0].why, /bash-guard-0/);
});

// A branch-scoped bash-guard is the shape that shipped proven and caught
// nothing: `branchInScope` passes a push naming no branch, so a fixture of
// `git push --force` admitted a guard scoped to a branch nobody has.
const FORCE_PUSH = "git\\s+push\\b[^\\n]*--force";

test("a bash-guard scoped to branches is proven only by a fixture that names one", () => {
  const scoped = (branches, violation) => ({
    id: "force-push-guard",
    deny: DENY,
    detectors: [{ lever: "bash-guard", params: { patterns: [FORCE_PUSH], onlyBranches: branches } }],
    fixtures: { violation, nearMiss: "git push origin main\n" },
  });

  const unnamed = scoped(["zzz-no-such-branch"], "git push --force\n");
  const out = admission.admit([unnamed], blank, { evaluate: evalSessionDetector });
  assert.deepEqual(out.admitted, [], "a guard scoped to a branch nobody has was admitted as proven");
  assert.match(out.discarded[0].why, /bash-guard-0/);

  // The same detector against the push it exists to stop, which is what the
  // guard will actually be handed.
  const named = scoped(["<default>"], "git push --force origin main\n");
  assert.deepEqual(admission.admit([named], blank, { evaluate: evalSessionDetector }).discarded, []);
});

// SCOPE:255 — "Is the admission test only a check against its own pair | No."
// The pair test cannot see a bash-guard that fires on every command: it fires
// on its own violation and can be written to dodge its own near miss.
test("a bash-guard that fires on another check's near miss is discarded by the cross", () => {
  const greedy = {
    id: "greedy-bash",
    deny: DENY,
    detectors: [{ lever: "bash-guard", params: { patterns: ["^(?!.*--dry-run)[\\s\\S]*$"] } }],
    fixtures: { violation: "rm -rf build\n", nearMiss: "rm -rf build --dry-run\n" },
  };
  const alone = admission.admit([greedy], blank, { cross: true, evaluate: evalSessionDetector });
  assert.deepEqual(alone.admitted.map((a) => a.id), ["greedy-bash"], "its own pair cannot see this");

  const crossed = admission.admit([greedy, guarded()], blank, { cross: true, evaluate: evalSessionDetector });
  assert.deepEqual(crossed.admitted.map((a) => a.id), ["piped-installer"]);
  assert.match(crossed.discarded[0].why, /fired on piped-installer's near miss with \/bash-guard-0\//);
});

// A patternless session detector still mints an armed guard row with a coverage
// cell, which an empty check-driver unit does not. Skipping it from the proof
// set is a coverage claim with nothing behind it.
test("a session detector carrying no patterns discards the check rather than shipping unproven", () => {
  const mixed = {
    ...check(),
    id: "mixed-lever",
    detectors: [check().detectors[0], { lever: "bash-guard", params: {} }],
  };
  const { admitted, discarded } = admission.admit([mixed], blank, { evaluate: evalSessionDetector });
  assert.deepEqual(admitted, []);
  assert.match(discarded[0].why, /bash-guard-1/);
});

// The runner prefers a detector's own deny over the check's (`denyOf`), so a
// per-detector triple was the one that shipped and the check's was the one
// admission read.
test("a deny stated on the detector is read by admission, not just the check's own", () => {
  const perDetector = (deny) => ({
    ...check(),
    id: "swallowed-exception",
    detectors: [{ ...check().detectors[0], deny }],
  });
  const garbled = { reason: "No.", alternative: "see `jig", override: "-" };
  const { admitted, discarded } = admission.admit([perDetector(garbled)], blank);
  assert.deepEqual(admitted, [], "a per-detector deny went past admission unread");
  assert.match(discarded[0].why, /was not authored whole/);

  // A whole one on the detector still admits, with the check's own left alone.
  assert.deepEqual(admission.admit([perDetector({ ...DENY, reason: "This one was written for the detector." })],
    blank).discarded, []);
});
