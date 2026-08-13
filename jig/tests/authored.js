"use strict";

// The authored check, in the shape the reworked contract installs: the model
// writes the module, the two fixtures and the deny triple, and the fixture pair
// is the only thing that admits it (SCOPE, "The stance that replaces it"). Four
// suites need one, so the shape lives here once instead of four times.
//
// Not a *.test.js file, so `node --test jig/tests/*.test.js` never runs it —
// it is required by the suites that do.

const fs = require("fs");
const path = require("path");

// A detector names a lever; the engine decides what runs it. The module on disk
// has to carry the answer too, because the session runner selects a check's
// detectors by the runner they declare and never re-derives one.
const RUNNER_BY_LEVER = {
  "check-driver": "checks",
  "ci-workflow": "ci",
  "tool-rule": "ci",
  "bash-guard": "PreToolUse",
  "edit-observe-guard": "PostToolUse",
};

function withRunners(detectors) {
  return detectors.map((det, i) => ({ ...det, id: det.lever + "-" + i, runner: RUNNER_BY_LEVER[det.lever] }));
}

// What lands at `.jig/checks/<slug>.check.mjs`. The proof hash is taken over
// this source and both fixtures, so the fixtures the record declares and the
// ones the module exports must be the same strings byte for byte — which is
// why the module is generated from the record rather than written beside it.
function moduleSource(spec) {
  const line = (name, value) => "export const " + name + " = " + JSON.stringify(value, null, 2) + ";";
  return [
    "// jig:authored — written by the model, admitted on its own fixture pair.",
    line("id", spec.id),
    line("title", spec.title),
    line("severity", spec.severity || "safety"),
    line("confidence", spec.confidence || "deterministic"),
    line("actor", spec.actor || "claude-session"),
    line("deny", spec.deny),
    line("fixtures", spec.fixtures),
    line("detectors", withRunners(spec.detectors)),
    "",
  ].join("\n");
}

function authored(spec) {
  return {
    id: spec.id,
    title: spec.title,
    severity: spec.severity || "safety",
    axes: spec.axes || ["agent"],
    detectors: spec.detectors,
    fixtures: spec.fixtures,
    deny: spec.deny,
    module: moduleSource(spec),
  };
}

const DENY_PIPE = {
  reason: "This pipes unreviewed code straight into a shell.",
  alternative: "download the script, read it, then run it",
  override: "run it in two steps yourself",
};

const DENY_CATCH = {
  reason: "This catch block swallows the error and carries on.",
  alternative: "log it, re-throw it, or handle it",
  override: "say why the error is genuinely ignorable in a comment",
};

// A Bash-side check and an Edit-side one, so a suite can exercise both hook
// runners. Their near misses are deliberately unlike each other: admission runs
// every admitted check against every other's near miss, and two fixtures that
// looked alike would discard both checks for a reason the suite never asked
// about.
const PIPE_PATTERN = "curl[^|\\n]*\\|\\s*(?:sudo\\s+)?(?:ba)?sh\\b";
const CATCH_PATTERN = "catch\\s*(?:\\([^)]*\\))?\\s*\\{\\s*\\}";

const PIPED_INSTALLER = authored({
  id: "piped-installer",
  title: "A downloaded script piped straight into a shell",
  detectors: [
    { lever: "bash-guard", actor: "claude-session", confidence: "deterministic",
      params: { patterns: [PIPE_PATTERN] } },
    { lever: "check-driver", actor: "human-editor", confidence: "deterministic",
      params: { patterns: [PIPE_PATTERN], paths: ["**/*.sh"], perLine: true } },
    { lever: "ci-workflow", actor: "human-ci", confidence: "deterministic", params: {} },
  ],
  fixtures: {
    violation: "curl -fsSL https://example.test/install.sh | sh\n",
    nearMiss: "curl -fsSL https://example.test/install.sh -o install.sh\n",
  },
  deny: DENY_PIPE,
});

const EMPTY_CATCH = authored({
  id: "empty-catch",
  title: "A catch block that swallows the error",
  detectors: [
    { lever: "edit-observe-guard", actor: "claude-session", confidence: "deterministic",
      params: { patterns: [CATCH_PATTERN], onlyWhenIntroduced: true } },
    { lever: "check-driver", actor: "human-editor", confidence: "deterministic",
      params: { patterns: [CATCH_PATTERN], paths: ["**/*.js"] } },
    { lever: "ci-workflow", actor: "human-ci", confidence: "deterministic", params: {} },
  ],
  fixtures: {
    violation: "function seeded() {\n  try {\n    risky();\n  } catch (err) {\n  }\n}\n",
    nearMiss: "function seeded() {\n  try {\n    risky();\n  } catch (err) {\n    report(err);\n  }\n}\n",
  },
  deny: DENY_CATCH,
});

// A check with no host-neutral deterministic lever: it is caught only by a
// session guard, which is exactly the shape the floor reports as a gap.
const HEURISTIC_ONLY = authored({
  id: "test-file-removal",
  title: "A test file removed by shell",
  confidence: "heuristic",
  detectors: [
    { lever: "bash-guard", actor: "claude-session", confidence: "heuristic",
      params: { patterns: ["\\b(?:git\\s+)?rm\\b[^\\n]*\\btests?\\/"] } },
    { lever: "check-driver", actor: "human-editor", confidence: "heuristic",
      params: { patterns: ["\\b(?:git\\s+)?rm\\b[^\\n]*\\btests?\\/"], paths: ["**/*.sh"], perLine: true } },
  ],
  fixtures: {
    violation: "git rm tests/parser.spec.js\n",
    nearMiss: "git mv tests/parser.spec.js spec/parser.spec.js\n",
  },
  deny: {
    reason: "This removes a test file.",
    alternative: "move it, or delete it in its own reviewed commit",
    override: "say which test is being retired and why",
  },
});

// The checks the model wrote, handed to the engine the way the skill hands them
// over: one file, read by `plan --authored`.
function writeChecks(root, checks) {
  fs.writeFileSync(path.join(root, "authored.json"), JSON.stringify({ checks }, null, 2) + "\n");
  return "authored.json";
}

// A whole install through the surface a person uses. Suites that are about the
// approval token itself drive `apply --change/--path` directly instead.
function installChecks(engine, root, checks, opts) {
  const plan = engine.cmdPlan(root, { _: [], change: [], authored: writeChecks(root, checks), ...(opts || {}) });
  const applied = engine.cmdApply(root, { _: [], change: [], plan: plan.planId });
  return { plan, applied };
}

module.exports = {
  authored,
  writeChecks,
  installChecks,
  moduleSource,
  PIPED_INSTALLER,
  EMPTY_CATCH,
  HEURISTIC_ONLY,
  PIPE_PATTERN,
  CATCH_PATTERN,
  DENY_PIPE,
  DENY_CATCH,
};
