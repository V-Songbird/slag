// Fixture: seeded violations for class focused-or-skipped-test. Never executed.
// Three shapes, one per pattern in the detector's params.
const { describe, it } = require("node:test");
const assert = require("node:assert");

describe("flag parser", () => {
  it.only("parses a long flag", () => {
    assert.equal(parse("--verbose").verbose, true);
  });

  it.skip("parses a repeated flag", () => {
    assert.equal(parse("-v -v").count, 2);
  });

  it.todo("parses a flag cluster");
});
