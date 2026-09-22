"use strict";

// Broken on purpose: this suite's after hook throws once its test has passed.
// Its name keeps it out of test discovery; suite-failure-reporter.test.js runs
// it with the arguments of npm run check.
const { after, describe, test } = require("node:test");

describe("a suite whose after hook throws", () => {
  after(() => {
    throw new Error("fixture cleanup failed");
  });
  test("passes before the hook runs", () => {});
});
