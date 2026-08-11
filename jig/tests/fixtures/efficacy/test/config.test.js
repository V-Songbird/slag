"use strict";

// Fixture: the seeded focused-or-skipped-test violation. Never executed.
//
// Three shapes, one per pattern the detector ships. `jig/tests/*.test.js` is a
// non-recursive glob and this file sits three directories below it, so no
// suite ever collects it.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULTS, readVersion } = require("../src/config.js");

describe("config", () => {
  it.only("reads the defaults", () => {
    assert.equal(DEFAULTS.retries, 3);
  });

  it.skip("reads a missing file as null", () => {
    assert.equal(readVersion("nope.json"), null);
  });

  it.todo("reads overrides from disk");
});
