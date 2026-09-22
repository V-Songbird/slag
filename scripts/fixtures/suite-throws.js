"use strict";

// Broken on purpose: this suite throws while it defines its tests. Its name
// keeps it out of test discovery; suite-failure-reporter.test.js runs it with
// the arguments of npm run check.
const { describe } = require("node:test");

describe("a suite that throws while defining its tests", () => {
  throw new Error("fixture setup failed");
});
