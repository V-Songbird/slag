"use strict";

// Test reporter that npm run check adds after the spec reporter. Node 22's
// runner shows a failed suite but leaves it out of the exit code when no test
// inside it fails, so a describe callback that throws or rejects before it
// registers a test, or a suite's after hook that throws, still exits 0. Here
// every failure the runner reports fails the run.
module.exports = async function* suiteFailureReporter(source) {
  for await (const { type, data } of source) {
    if (type !== "test:fail" || data.todo || data.skip) continue;
    process.exitCode = 1;
    const { error } = data.details;
    if (data.details.type === "suite" && error?.failureType !== "subtestsFailed") {
      // A hook failure's message is generic; its cause is the hook's own error.
      const cause = error?.cause?.message;
      const reason = cause && cause !== error.message ? `${error.message}: ${cause}` : error?.message;
      yield `Suite failed outside its tests: "${data.name}" (${data.file}:${data.line}): ${reason}\n`;
    }
  }
};
