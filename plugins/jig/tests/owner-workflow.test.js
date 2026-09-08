"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { runOwnerWorkflow } = require("../scripts/probes/owner-workflow.js");

test("offline owner workflow preserves consent boundaries and restores exact original bytes", () => {
  const report = runOwnerWorkflow();
  assert.equal(report.ok, true, JSON.stringify(report.error));
  assert.equal(report.evidence, "automated-owner-workflow-fixture");
  assert.equal(report.humanInterview, false);
  assert.equal(report.nativeHostVerified, false);
  assert.equal(report.networkUsed, false);
  assert.equal(report.packagesInstalled, false);
  assert.equal(report.ownerDecisions.length, 6);
  assert.deepEqual(report.steps.map((step) => step.step), [
    "disposable-project", "reviewed-plan-and-consent-refusals", "named-apply-and-review",
    "armed-runtime-fixtures", "disarm-requires-approved-token",
    "false-positive-requires-approved-token", "full-journal-revert",
  ]);
  assert.ok(report.steps.every((step) => step.passed));
  const reverted = report.steps.at(-1);
  assert.equal(reverted.exactOriginalProjectBytes, true);
  assert.equal(reverted.originalSha256, reverted.restoredSha256);
  assert.equal(reverted.idempotent, true);
  assert.equal(reverted.retainedAudit.directory, ".jig");
  const approvedPaths = report.steps.find((step) => step.step === "reviewed-plan-and-consent-refusals").approvals
    .map((approval) => approval.path).filter((target) => target.startsWith(".jig/"));
  assert.deepEqual(reverted.restoredInstallPaths, approvedPaths);
  assert.equal(fs.existsSync(report.workspace), false, "the disposable fixture workspace was not cleaned up");
  assert.equal(report.kept, false);
  assert.equal(fs.existsSync(report.project), false, "the disposable fixture was not cleaned up");
});
