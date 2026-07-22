"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { lintTaskSet } = require("../lib/lint");

const goodTask = (over = {}) => ({
  id: "t", type: "bugfix", surface: "instructions",
  assert: [{ type: "file_regex", path: "src/a.js", pattern: "clamp" }],
  ...over,
});

test("a diverse, assertion-carrying set passes", () => {
  const set = [
    goodTask({ id: "a", type: "bugfix", assert: [{ type: "file_regex", path: "src/a.js", pattern: "clamp" }] }),
    goodTask({ id: "b", type: "revert", assert: [{ type: "file_exists", path: "docs/api.md" }] }),
    goodTask({ id: "c", type: "bugfix", assert: [{ type: "response_regex", pattern: "fixed" }] }),
  ];
  const r = lintTaskSet(set);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.errors.length, 0);
});

test("a task with no deterministic assertion is a blocking error", () => {
  const r = lintTaskSet([goodTask({ id: "x", assert: [] }), goodTask({ id: "y" })]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /no deterministic assertion/.test(e)));
});

test("a rubric-only task does not satisfy the tier-1 assertion wall", () => {
  const r = lintTaskSet([{ id: "z", type: "bugfix", assert: [{ type: "rubric", question: "is it good?" }] }]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /no deterministic assertion/.test(e)));
});

test("marker-file assertion is rejected outright (S03 lesson)", () => {
  const r = lintTaskSet([
    { id: "m", type: "skill-firing", surface: "skill", assert: [{ type: "file_regex", path: "SKILL_FIRED.txt", pattern: "csv-report" }] },
    goodTask({ id: "n", type: "bugfix" }),
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /marker-file assertion/.test(e)), JSON.stringify(r.errors));
});

test("marker-file assertion nested inside a composite is still rejected", () => {
  const r = lintTaskSet([{
    id: "c", type: "skill-firing", surface: "skill",
    assert: [{ type: "composite", op: "or", children: [
      { type: "file_exists", path: "report.md" },
      { type: "file_exists", path: "PROOF_RAN.flag" },
    ] }],
  }]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /marker-file/.test(e)));
});

test("an all-one-shape set (one type, one file) is refused", () => {
  const set = [
    { id: "a", type: "import-reorder", surface: "skill", assert: [{ type: "file_regex", path: "src/x.js", pattern: "import" }] },
    { id: "b", type: "import-reorder", surface: "skill", assert: [{ type: "file_regex", path: "src/x.js", pattern: "import" }] },
  ];
  const r = lintTaskSet(set);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /all one shape/.test(e)));
});

test("thin diversity (one type, multiple files) warns but still runs", () => {
  const set = [
    { id: "a", type: "import-reorder", surface: "skill", assert: [{ type: "file_regex", path: "src/x.js", pattern: "import" }] },
    { id: "b", type: "import-reorder", surface: "skill", assert: [{ type: "file_regex", path: "src/y.js", pattern: "import" }] },
    { id: "c", type: "import-reorder", surface: "skill", assert: [{ type: "file_regex", path: "src/z.js", pattern: "import" }] },
  ];
  const r = lintTaskSet(set);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => /thin diversity/.test(w)));
});

test("a weak/tautological pattern warns", () => {
  const r = lintTaskSet([
    goodTask({ id: "a", assert: [{ type: "file_regex", path: "src/a.js", pattern: ".*" }] }),
    goodTask({ id: "b", type: "revert", assert: [{ type: "file_exists", path: "b.md" }] }),
  ]);
  assert.ok(r.warnings.some((w) => /weak\/tautological/.test(w)));
});

test("an empty set is not runnable", () => {
  const r = lintTaskSet([]);
  assert.equal(r.ok, false);
});
