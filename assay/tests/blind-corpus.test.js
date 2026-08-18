"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const engine = require("../scripts/assay.js");

// [Foreman: 154] A blind corpus. Every other skill fixture in this suite was
// written to exercise a check, so it can only confirm the check does what its
// author already meant it to do. These fifteen files were written by nobody
// here, for a purpose that has nothing to do with grading, and three defects in
// them were verified by hand before a line of this file existed.
//
// The clone is external and its project name may never appear in a file this
// repo commits, so the directory is found by shape instead of named: the child
// of CORPUS_PARENT carrying a `for-agents/` that holds both answer-key files.
// When it is absent — another machine, a deleted clone — every test here skips
// with its reason rather than passing on nothing.
const CORPUS_PARENT = "D:\\Projects\\Knowledge";
const ANSWER_KEY_FILES = ["pre-mortem.md", "review-synthesis.md"];

function findCorpus() {
  let children;
  try {
    children = fs.readdirSync(CORPUS_PARENT, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of children) {
    if (!entry.isDirectory()) continue;
    const agents = path.join(CORPUS_PARENT, entry.name, "for-agents");
    if (ANSWER_KEY_FILES.every((f) => fs.existsSync(path.join(agents, f)))) {
      return { root: path.join(CORPUS_PARENT, entry.name), agents };
    }
  }
  return null;
}

const CORPUS = findCorpus();
const ABSENT = CORPUS ? false : "no external skill corpus under " + CORPUS_PARENT;

// The dialect with frontmatter. Its sibling directory strips `name` and
// `description` entirely, which is a different corpus and not this answer key.
function gradeCorpus() {
  const found = fs
    .readdirSync(CORPUS.agents)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => ({
      absPath: path.join(CORPUS.agents, f),
      path: "for-agents/" + f,
      name: f.replace(/\.md$/, ""),
      scope: "project",
      source: "project",
    }));
  return engine.readSkills(found);
}

test("the blind corpus grades as fifteen skill descriptions", { skip: ABSENT }, () => {
  // A clone that has drifted must fail here rather than let every assertion
  // below pass over a shrunken set.
  const skills = gradeCorpus();
  assert.equal(skills.length, 15);
  assert.ok(skills.every((s) => s.checks.mode === "model"),
    "every file declares a description the recipe checks apply to");
});

test("the grader finds all three dangling reference paths", { skip: ABSENT }, () => {
  const body = fs.readFileSync(path.join(CORPUS.agents, "pre-mortem.md"), "utf8");
  const staleness = engine.checkStaleness(body, CORPUS.root, undefined, "for-agents/pre-mortem.md");
  assert.equal(staleness.gated, true);
  assert.deepEqual(staleness.missing.map((m) => m.ref).sort(), [
    "references/why_it_works.md",
    "references/worked_example.md",
    "scripts/post_check.py",
  ]);
  assert.ok(staleness.missing.every((m) => m.moved.length === 0),
    "none of the three has a moved candidate anywhere in the corpus");
});

test("the grader flags the four architecture descriptions as enumerated", { skip: ABSENT }, () => {
  // The defect the answer key calls description bloat. None of them is over the
  // listing cap — see below — so what makes them bad is shape, not size: an
  // opening sentence that lists the skill's whole contents, with no trigger
  // clause and no exclusion clause to route on.
  const byName = new Map(gradeCorpus().map((s) => [s.name, s]));
  for (const name of ["skill-master", "conductor", "topology", "kaleidoscope-guide"]) {
    assert.deepEqual(byName.get(name).checks.missing.sort(),
      ["concrete", "enumerated", "exclusion", "trigger"], name);
  }
  // And it is a property of those four, not of the file set: the twelve
  // operational skills each open on one sentence and are not flagged for it.
  const enumerated = gradeCorpus().filter((s) => s.checks.missing.includes("enumerated"));
  assert.equal(enumerated.length, 4);
});

test("no description in the corpus is over the listing cap", { skip: ABSENT }, () => {
  // Measured, because the note that filed this entry said otherwise. The
  // longest is 862 characters against a 1,536-character cap, and the two the
  // note singled out are 122 and 135 words, not 180 and 120.
  const skills = gradeCorpus();
  assert.ok(skills.every((s) => s.checks.overCap === false));
  const longest = Math.max(...skills.map((s) => s.checks.length));
  assert.ok(longest > 800 && longest < 900, "longest description is " + longest + " chars");
});

test("the corpus name mismatch is real and no check in assay reads it", { skip: ABSENT }, () => {
  // The third defect. assay grades a description against its own file and never
  // compares one instruction file's skill names against another's, so this one
  // is corpus-verified only: the facts are asserted here so the answer key
  // cannot rot, and a cross-file routing check does not exist to assert.
  const skills = gradeCorpus();
  const declared = skills.find((s) => s.path === "for-agents/review-synthesis.md");
  assert.equal(declared.name, "review-synthesis");
  for (const router of ["skill-master.md", "conductor.md", "topology.md"]) {
    const text = fs.readFileSync(path.join(CORPUS.agents, router), "utf8");
    assert.equal(text.includes("review-synthesis"), false, router + " never names the declared skill");
    assert.match(text, /\breview\b/, router + " routes to a name nothing declares");
  }
});
