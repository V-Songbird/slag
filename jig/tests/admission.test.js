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
