"use strict";

// Fixture: the file the seeded test-file-deletion violation deletes. Never
// executed. It is an ordinary passing test on purpose — the defect is that it
// was removed rather than fixed, so nothing about the file itself is wrong.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULTS } = require("../src/config.js");

describe("legacy defaults", () => {
  it("still exposes a timeout", () => {
    assert.equal(DEFAULTS.timeoutMs, 2000);
  });
});
