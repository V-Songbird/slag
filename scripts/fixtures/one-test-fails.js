"use strict";

// One passing and one failing test, for suite-failure-reporter.test.js, which runs it with the arguments of
// npm run check. Its name keeps it out of test discovery.
const { test } = require("node:test");
const assert = require("node:assert/strict");

test("a fixture test that passes", () => {});

test("a fixture test that fails", () => {
  assert.equal("actual total", "expected total");
});
