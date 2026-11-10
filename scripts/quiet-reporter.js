"use strict";

// The reporter npm run check writes to stdout. A passing test prints nothing: with more than a thousand tests the
// spec reporter printed over 100,000 characters on a clean run, an agent host then kept only a preview of that
// output, and the summary that says the run passed was cut off. This one prints each failed test with its location
// and error, what a test file wrote to stderr, and the runner's closing counts.
const { inspect } = require("node:util");

module.exports = async function* quietReporter(source) {
  for await (const { type, data } of source) {
    if (type === "test:fail") {
      const error = data.details?.error;
      // A parent fails because a subtest did, and the subtest already printed.
      if (data.todo || data.skip || error?.failureType === "subtestsFailed") continue;
      const cause = error?.cause ?? error;
      yield `✖ ${data.name} (${data.file}:${data.line})\n${inspect(cause, { depth: 5, colors: false })}\n\n`;
    } else if (type === "test:stderr") {
      yield data.message;
    } else if (type === "test:diagnostic") {
      yield `ℹ ${data.message}\n`;
    }
  }
};
