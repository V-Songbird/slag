"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { gradeOne, grade } = require("../lib/grade");

function tmpDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test("file_exists / file_absent", () => {
  const dir = tmpDir({ "docs/api.md": "# API" });
  assert.equal(gradeOne({ type: "file_exists", path: "docs/api.md" }, { dir }), 1);
  assert.equal(gradeOne({ type: "file_exists", path: "nope.md" }, { dir }), 0);
  assert.equal(gradeOne({ type: "file_absent", path: "nope.md" }, { dir }), 1);
  assert.equal(gradeOne({ type: "file_absent", path: "docs/api.md" }, { dir }), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file_regex and file_regex_absent; a missing file is never compliant absence", () => {
  const dir = tmpDir({ "docs/api.md": "# API\n- clamp(n, min, max)\n" });
  assert.equal(gradeOne({ type: "file_regex", path: "docs/api.md", pattern: "clamp" }, { dir }), 1);
  assert.equal(gradeOne({ type: "file_regex", path: "docs/api.md", pattern: "nope" }, { dir }), 0);
  assert.equal(gradeOne({ type: "file_regex_absent", path: "docs/api.md", pattern: "nope" }, { dir }), 1);
  assert.equal(gradeOne({ type: "file_regex_absent", path: "docs/api.md", pattern: "clamp" }, { dir }), 0);
  assert.equal(gradeOne({ type: "file_regex_absent", path: "missing.md", pattern: "x" }, { dir }), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("response graders and composites", () => {
  const ctx = { dir: tmpDir({}), response: "Done. Listed clamp in docs/api.md." };
  assert.equal(gradeOne({ type: "response_regex", pattern: "clamp" }, ctx), 1);
  assert.equal(gradeOne({ type: "response_regex_absent", pattern: "error" }, ctx), 1);
  assert.equal(gradeOne({ type: "composite", op: "or", children: [
    { type: "response_regex", pattern: "nope" },
    { type: "response_regex", pattern: "Done" },
  ] }, ctx), 1);
  assert.equal(gradeOne({ type: "composite", op: "and", children: [
    { type: "response_regex", pattern: "Done" },
    { type: "response_regex", pattern: "nope" },
  ] }, ctx), 0);
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test("grade takes the min across graders", () => {
  const dir = tmpDir({ "a.txt": "yes" });
  assert.equal(grade([{ type: "file_exists", path: "a.txt" }, { type: "file_exists", path: "b.txt" }], { dir }).score, 0);
  assert.equal(grade([{ type: "file_exists", path: "a.txt" }], { dir }).score, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("unknown grader type throws", () => {
  assert.throws(() => gradeOne({ type: "bogus" }, { dir: "." }));
});
