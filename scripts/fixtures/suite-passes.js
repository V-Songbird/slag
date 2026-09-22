"use strict";

// Passing counterpart of suite-throws.js for suite-failure-reporter.test.js.
const { describe, test } = require("node:test");

describe("a suite that defines its tests", () => {
  test("passes", () => {});
});
