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

// The two blocks that must be identical, each named by the exact first and last
// line of its region. Markers rather than a parser: the bodies contain `}` inside
// character classes, so brace counting would slice them short and quietly compare
// less than it claims to.
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
  test("run.mjs and jig-lib.js carry the same copy of " + block.what, () => {
    const driver = slice(DRIVER, read(DRIVER), block);
    const lib = slice(LIB, read(LIB), block);
    assert.equal(lib, driver,
      "the check driver and the session guards have drifted apart on " + block.what +
      " — copy the block from scripts/templates/run.mjs into hooks/jig-lib.js verbatim");
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
