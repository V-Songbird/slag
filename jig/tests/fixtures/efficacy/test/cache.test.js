"use strict";

// Fixture: near-miss negative A for focused-or-skipped-test. Never executed.
//
// This comment names it.only( and describe.skip( on purpose, and the two names
// appear again below inside string literals. Nothing here focuses or skips.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { load, loadOr } = require("../src/cache.js");

describe("cache", () => {
  it("treats the literal string it.only( as a suite name, not a call", () => {
    assert.equal("it.only(".length, 8);
  });

  it("keeps describe.skip( harmless inside a template literal", () => {
    assert.equal(`describe.skip(`.length, 14);
  });

  it("degrades a bad cache instead of throwing", () => {
    assert.equal(typeof load, "function");
    assert.equal(loadOr("nope.json", { warm: false }).warm, false);
  });
});
