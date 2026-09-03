"use strict";

// The blanker lives twice.
//
// `scripts/templates/run.mjs` is ESM text that gets byte-copied into a user's
// repository, so `hooks/jig-lib.js` cannot import it and carries a hand-copied
// second version instead. Two copies of the same scanner is a standing invitation
// to fix one and forget the other — which is exactly how the check driver and the
// session guards would start disagreeing about what counts as a comment.
//
// This file holds them to the letter. It slices the shared region out of both
// files and compares the text, so any edit to one copy fails until the same edit
// lands in the other. It is deliberately a byte comparison and not a behavioural
// one: a difference that has not changed behaviour yet is still drift, and it is
// far cheaper to reconcile now than after it has.
//
// When this fails, the fix is never to relax the test. Copy the block.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DRIVER = path.join(__dirname, "..", "scripts", "templates", "run.mjs");
const LIB = path.join(__dirname, "..", "hooks", "jig-lib.js");
const VOCAB = path.join(__dirname, "..", "scripts", "vocab.js");
const TOOLCHAIN = path.join(__dirname, "..", "scripts", "toolchain.js");
const ADMISSION = path.join(__dirname, "..", "scripts", "admission.js");

// The blocks that must be identical, each named by the exact first and last
// line of its region and by the pair of files that carry it. Markers rather than
// a parser: the bodies contain `}` inside character classes, so brace counting
// would slice them short and quietly compare less than it claims to.
const BLOCKS = [
  {
    what: "the comment and string blanker",
    from: "const DEFAULT_COMMENT_SYNTAX = {",
    to: '  return out.join("");\n}',
  },
  {
    what: "the glob compiler",
    from: "function globToRegExp(glob) {",
    to: '  return new RegExp("^" + out + ")".repeat(depth) + "$", "i");\n}',
  },
  {
    // The selftest seeds a violation at a path the detector's own globs match.
    // The driver does it for the check side and `guardProbe` does it for the
    // guard side, and a probe seeded where the guard does not look reports a
    // miss the guard never had.
    what: "the fixture path derivation",
    files: [DRIVER, VOCAB],
    from: "function concreteSegment(glob, star) {",
    to: '  return [...dirs, base].join("/");\n}',
  },
  {
    // A removal fixture is one file before an edit and the same file after it,
    // and an extract fixture is a doc and the union its names appear in. Both
    // are two texts in one string, and admission and the shipped driver have to
    // read the fence the same way or a check admits on a pair the driver splits
    // differently — the selftest then disagrees with the admission that let the
    // check in.
    what: "the fenced fixture's split",
    files: [DRIVER, ADMISSION],
    from: "function fencedHalves(text, label) {",
    // Down to the label itself: a fence read the same way on both sides but
    // named differently on one is the same drift with an extra step.
    to: 'const PAIRED_FENCE = "paired";',
  },
  {
    // The extract rule. Admission decides a check is coverage by it and the
    // shipped driver reports findings by it, and a hand-kept second copy is what
    // lets a check admit on a pair the driver reads the other way.
    what: "the doc-name lookup",
    files: [DRIVER, ADMISSION],
    from: "function extractMisses(det, doc, union) {",
    to: "  return out;\n}",
  },
  {
    // The lanes run the same argv the installer runs, and on Windows `npx` is a
    // batch shim neither of them may open a shell for. The engine learned the
    // route first; the driver carries the second copy because it imports
    // nothing outside node's own standard library.
    what: "the shell-free argv rewrite",
    files: [DRIVER, TOOLCHAIN],
    from: "function windowsShim(name) {",
    to: "  return [process.execPath, entry, ...argv.slice(1)];\n}",
  },
];

function read(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function slice(file, text, block) {
  const from = text.indexOf(block.from);
  assert.notEqual(from, -1,
    path.basename(file) + " no longer contains " + JSON.stringify(block.from) +
    " — " + block.what + " was renamed or removed on one side only");
  assert.equal(text.indexOf(block.from, from + 1), -1,
    path.basename(file) + " contains " + JSON.stringify(block.from) + " more than once");
  const to = text.indexOf(block.to, from);
  assert.notEqual(to, -1,
    path.basename(file) + " no longer ends " + block.what + " with " + JSON.stringify(block.to));
  return text.slice(from, to + block.to.length);
}

for (const block of BLOCKS) {
  const [source, copy] = block.files || [DRIVER, LIB];
  test("run.mjs and " + path.basename(copy) + " carry the same copy of " + block.what, () => {
    const original = slice(source, read(source), block);
    const second = slice(copy, read(copy), block);
    assert.equal(second, original,
      "the two copies of " + block.what + " have drifted apart — copy the block from " +
      path.basename(source) + " into " + path.basename(copy) + " verbatim");
  });
}

test("the shared region is big enough to be worth comparing", () => {
  // A marker that matched a one-line stub would pass this file while comparing
  // almost nothing, so the size of what was actually compared is asserted too.
  const driver = read(DRIVER);
  const blanker = slice(DRIVER, driver, BLOCKS[0]);
  assert.ok(blanker.split("\n").length > 80,
    "the blanker block sliced down to " + blanker.split("\n").length + " lines");
  assert.ok(blanker.includes("stripComments") && blanker.includes("stripStrings"),
    "the sliced block is not the blanker");
});
