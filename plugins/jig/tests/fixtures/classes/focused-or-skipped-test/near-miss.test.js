// Fixture: near-miss negatives for class focused-or-skipped-test. Never executed.
// Every line here looks like a focused or skipped test and is not one.
// This comment mentions it.only( and describe.skip( on purpose.
const { describe, it } = require("node:test");
const assert = require("node:assert");

describe("flag parser", () => {
  it("rejects the literal string \"it.only(\" as a flag value", () => {
    assert.equal(parse("--name=it.only(").name, "it.only(");
  });

  it("skips blank lines in the argument list", () => {
    assert.equal(parse("--a\n\n--b").count, 2);
  });

  it("keeps a variable named itOnly out of the pattern", () => {
    const itOnly = true;
    assert.equal(itOnly, true);
  });
});
