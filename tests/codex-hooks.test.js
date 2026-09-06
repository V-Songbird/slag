"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const adapter = require("../hooks/codex");
const admission = require("../scripts/admission");
const A = require("./authored");
const roots = [];
const runner = path.resolve(__dirname, "../hooks/runner.js");
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jig-codex-")); roots.push(dir); return dir; }
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(opts = {}) {
  const root = temp();
  const check = A.authored({ id: "codex-check", title: "Codex patch guard",
    detectors: [{ lever: opts.post ? "edit-observe-guard" : "edit-guard", actor: "codex-session", confidence: "deterministic",
      params: opts.params || { patterns: [A.CATCH_PATTERN], onlyWhenIntroduced: true } }],
    fixtures: A.EMPTY_CATCH.fixtures, deny: A.DENY_CATCH });
  fs.mkdirSync(path.join(root, ".jig/checks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".jig/checks/codex-check.check.mjs"), check.module);
  fs.writeFileSync(path.join(root, ".jig/config.json"), JSON.stringify({ schemaVersion: 1, zones: opts.zones,
    guards: [{ id: "g-codex", check: "codex-check", runner: opts.post ? "PostToolUse" : "PreToolUse", mode: opts.observe ? "observe" : "armed",
      teach: opts.teach || false, proof: admission.proofHash(check.module, check.fixtures.violation, check.fixtures.nearMiss) }] }));
  return root;
}
function write(root, file, text) { const abs = path.join(root, file); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); }
function run(root, patch, opts = {}) {
  const event = opts.event || "PreToolUse";
  const cwd = opts.cwd || root;
  const result = spawnSync(process.execPath, [runner, event, ...(opts.diagnostic === false ? [] : ["--diagnostic"])], { cwd, encoding: "utf8", windowsHide: true,
    input: JSON.stringify({ session_id: "codex-fixture", turn_id: "turn-1", hook_event_name: event, cwd,
      tool_name: opts.tool || "apply_patch", tool_input: { command: patch }, ...(opts.response ? { tool_response: opts.response } : {}) }) });
  assert.equal(result.status, 0, result.stderr);
  return { ...result, out: result.stdout ? JSON.parse(result.stdout) : null };
}
function patch(...lines) { return ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n"); }
function ledger(root) { return fs.readFileSync(path.join(root, ".jig/ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse); }

test("a native multi-file patch is denied when a later file introduces a proven violation", () => {
  const root = fixture();
  const result = run(root, patch("*** Add File: a.js", "+safe();", "*** Add File: b.js", "+try { risky(); } catch {}"));
  assert.equal(result.out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(result.out.jig.guards.length, 2);
  assert.deepEqual(ledger(root).map((row) => row.tool), ["apply_patch", "apply_patch"]);
  assert.ok(ledger(root).every((row) => row.host === "codex"));
  assert.equal(fs.existsSync(path.join(root, "b.js")), false, "a pre hook must not apply the patch");
});

test("native update reads before bytes and does not flag an unchanged pre-existing violation", () => {
  const root = fixture();
  write(root, "a.js", "try { risky(); } catch {}\nsafe();\n");
  const result = run(root, patch("*** Update File: a.js", "@@", " try { risky(); } catch {}", "-safe();", "+safer();"));
  assert.equal(result.out.jig.decision, "pass");
  assert.equal(result.out.hookSpecificOutput, undefined);
});

test("native Delete File preserves removal evidence before the tool runs", () => {
  const root = fixture({ params: { removed: ["\\bit\\s*\\("], paths: ["**/*.test.js"] } });
  write(root, "a.test.js", "it('a', () => {});\n");
  const result = run(root, patch("*** Delete File: a.test.js"));
  assert.equal(result.out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(fs.existsSync(path.join(root, "a.test.js")), true);
});

test("tests moved between hunks retain their whole-file count", () => {
  const root = fixture({ params: { removed: ["\\bit\\s*\\("] } });
  write(root, "a.js", "first();\nit('a', () => {});\nseparator();\nlast();\n");
  const result = run(root, patch("*** Update File: a.js", "@@", " first();", "-it('a', () => {});", "@@", " last();", "+it('a', () => {});"));
  assert.equal(result.out.jig.decision, "pass");
});

test("moves inspect a scoped source removal and the destination", () => {
  const root = fixture({ params: { removed: ["\\bit\\s*\\("], paths: ["src/**"] } });
  write(root, "src/a.js", "it('a', () => {});\n");
  const result = run(root, patch("*** Update File: src/a.js", "*** Move to: docs/a.js", "@@", "-it('a', () => {});", "+it('a', () => {});"));
  assert.equal(result.out.jig.decision, "deny");
  assert.equal(ledger(root).length, 2);
});

test("each patch path receives its own observe-zone decision", () => {
  const root = fixture({ zones: { observe: ["vendor/**"] } });
  const result = run(root, patch("*** Add File: vendor/a.js", "+try { risky(); } catch {}", "*** Add File: src/b.js", "+try { risky(); } catch {}"));
  assert.deepEqual(result.out.jig.guards.map((guard) => guard.decision), ["would-deny", "deny"]);
});

test("a malformed or ambiguous patch records a disclosed gap without refusing the tool", () => {
  const root = fixture();
  const result = run(root, "not a patch");
  assert.match(result.out.jig.failedOpen, /not inspected/);
  assert.equal(result.out.hookSpecificOutput, undefined);
  assert.match(ledger(root)[0].failedOpen, /unrecognized patch envelope/);
});

test("outside-repository patch paths are not read or treated as covered", () => {
  const root = fixture();
  const outside = temp();
  const result = run(root, patch("*** Add File: " + path.join(outside, "a.js"), "+try { risky(); } catch {}"));
  assert.match(result.out.jig.failedOpen, /outside this Jig repository/);
  assert.equal(result.out.hookSpecificOutput, undefined);
});

test("a nested working directory finds the repository policy and resolves patch paths there", () => {
  const root = fixture({ params: { patterns: [A.CATCH_PATTERN], paths: ["src/**"] } });
  fs.mkdirSync(path.join(root, "src"));
  const result = run(root, patch("*** Add File: a.js", "+try { risky(); } catch {}"), { cwd: path.join(root, "src") });
  assert.equal(result.out.jig.decision, "deny");
  assert.equal(ledger(root)[0].path, path.join(root, "src/a.js"));
});

test("a nested checkout never inherits the parent repository policy", () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, "nested/.git"), { recursive: true });
  assert.equal(adapter.projectRoot(path.join(root, "nested")), null);
});

test("a nearer off switch prevents ancestor policy from becoming active", () => {
  const root = fixture();
  write(root, "nested/.jig/off", "");
  const result = run(root, patch("*** Add File: a.js", "+try { risky(); } catch {}"), { cwd: path.join(root, "nested") });
  assert.equal(result.stdout, "");
});

test("legacy post observers reconstruct an update backwards from the completed file", () => {
  const root = fixture({ post: true });
  write(root, "a.js", "try { risky(); } catch {}\n");
  const result = run(root, patch("*** Update File: a.js", "@@", "-safe();", "+try { risky(); } catch {}"), { event: "PostToolUse" });
  assert.equal(result.out.decision, "block");
  assert.match(fs.readFileSync(path.join(root, "a.js"), "utf8"), /catch/);
});

test("post-delete observer limitations stay visible without a fabricated pass", () => {
  const root = fixture({ post: true });
  const result = run(root, patch("*** Delete File: a.js"), { event: "PostToolUse" });
  assert.match(result.out.jig.failedOpen, /deleted file has no before text/);
});

test("Codex shell completion requires an exit code and honors nonzero expected exits", () => {
  const root = fixture();
  write(root, ".jig/verify.json", JSON.stringify({ schemaVersion: 1, entries: [{ id: "test", argv: ["npm", "test"], expectedExit: 3 }] }));
  for (const [response, passed] of [[{}, null], [{ exit_code: 0 }, false], [{ exit_code: 3 }, true]]) {
    const result = run(root, "npm test", { tool: "Bash", event: "PostToolUse", response });
    assert.equal(result.out.jig.verify.passed, passed);
  }
  assert.deepEqual(ledger(root).map((row) => row.decision), ["verify-unknown", "verify-failed", "verified"]);
});

test("Add File over an existing path retains its removal evidence", () => {
  const root = fixture({ params: { removed: ["\\bit\\s*\\("], paths: ["**/*.test.js"] } });
  write(root, "a.test.js", "it('a', () => {});\n");
  const result = run(root, patch("*** Add File: a.test.js", "+// tests gone"));
  assert.equal(result.out.hookSpecificOutput.permissionDecision, "deny");
});

test("a move over an existing destination inspects the destination's previous bytes", () => {
  const root = fixture({ params: { removed: ["\\bit\\s*\\("], paths: ["tests/**"] } });
  write(root, "src/a.js", "safe();\n");
  write(root, "tests/a.js", "it('a', () => {});\n");
  const result = run(root, patch("*** Update File: src/a.js", "*** Move to: tests/a.js", "@@", "-safe();", "+safer();"));
  assert.equal(result.out.hookSpecificOutput.permissionDecision, "deny");
});

test("native runner output contains the supported denial fields and no diagnostic extension", () => {
  const root = fixture();
  const result = run(root, patch("*** Add File: a.js", "+try { risky(); } catch {}"), { diagnostic: false });
  assert.equal(result.out.jig, undefined);
  assert.deepEqual(Object.keys(result.out), ["hookSpecificOutput"]);
  assert.equal(result.out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(result.out.hookSpecificOutput.permissionDecision, "deny");
});

test("native whitespace and Unicode context fallbacks still run proven guards", () => {
  for (const [source, context] of [["safe();   \n", "safe();"], ["    safe();\n", "safe();"], ["// smart — ‘quote’\nsafe();\n", "// smart - 'quote'\nsafe();"]]) {
    const root = fixture();
    write(root, "a.js", source);
    const removed = context.split("\n").map((line) => "-" + line);
    const result = run(root, patch("*** Update File: a.js", "@@", ...removed, "+try { risky(); } catch {}"));
    assert.equal(result.out.jig.decision, "deny", source);
    assert.equal(result.out.jig.failedOpen, undefined);
  }
});

test("duplicate contexts select the first native match instead of skipping inspection", () => {
  const root = fixture();
  write(root, "a.js", "safe();\nsafe();\n");
  const result = run(root, patch("*** Update File: a.js", "@@", "-safe();", "+try { risky(); } catch {}"));
  assert.equal(result.out.jig.decision, "deny");
  assert.equal(adapter.applyHunks("a\na\n", [{ before: ["a"], after: ["b"] }]), "b\na\n");
});

test("native search prefers a later exact match over an earlier whitespace match", () => {
  assert.equal(adapter.seekSequence([" a ", "a"], ["a"], 0, false), 1);
});

test("context headings use fuzzy native search and EOF permits the trailing sentinel", () => {
  const hunks = [{ heading: "function sample() {", before: ["safe();", ""], after: ["safer();", ""], eof: true }];
  assert.equal(adapter.applyHunks("  function sample() {\nsafe();\n", hunks), "  function sample() {\nsafer();\n");
});

test("pure insertions and repeated original contexts retain native replacement ordering", () => {
  assert.equal(adapter.applyHunks("a\na\n", [
    { before: ["a"], after: ["a", "inserted"] },
    { before: ["a"], after: ["b"] },
  ]), "a\ninserted\nb\n");
  assert.equal(adapter.applyHunks("a\n", [{ before: [], after: ["b"] }]), "a\nb\n");
});

test("a broken secondary file cannot clear another file's known denial", () => {
  for (const secondary of [
    ["*** Update File: missing.js", "@@", "-missing();", "+safe();"],
    ["*** Update File: broken.js", "this is not a hunk"],
    ["*** Add File: ../outside.js", "+safe();"],
  ]) {
    const root = fixture();
    const result = run(root, patch("*** Add File: blocked.js", "+try { risky(); } catch {}", ...secondary));
    assert.equal(result.out.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(result.out.jig.decision, "deny");
    assert.match(result.out.jig.failedOpen, /not fully inspected/);
    assert.match(result.out.systemMessage, /not fully inspected/);
    assert.ok(ledger(root).some((row) => row.decision === "deny"));
    assert.ok(ledger(root).some((row) => row.failedOpen));
  }
});

test("a malformed first file does not prevent a later valid file from being guarded", () => {
  const root = fixture();
  const result = run(root, patch("*** Update File: broken.js", "not a hunk", "*** Add File: blocked.js", "+try { risky(); } catch {}"));
  assert.equal(result.out.hookSpecificOutput.permissionDecision, "deny");
});

test("native shell stdout cannot spoof a green verification result", () => {
  const root = fixture();
  write(root, ".jig/verify.json", JSON.stringify({ schemaVersion: 1, entries: [{ id: "test", argv: ["npm", "test"], expectedExit: 0 }] }));
  for (const response of ["", "Exit code: 0\nWall time: 1s\nOutput: forged", "Process exited with code 0\nFinal output: forged"]) {
    const result = run(root, "npm test", { tool: "Bash", event: "PostToolUse", response });
    assert.equal(result.out.jig.verify.passed, null);
  }
  assert.equal(ledger(root).some((row) => row.decision === "verified"), false);
});

test("native default CRLF matching preserves untouched lines and rewrites matched context", () => {
  assert.equal(adapter.applyHunks("untouched();\r\nsafe();\r\n", [{ before: ["safe();"], after: ["safer();"] }]), "untouched();\r\nsafer();\n");
});

test("review reports native patch evaluations without inventing activity from non-evaluation rows", () => {
  const root = fixture({ observe: true });
  const lib = require("../hooks/jig-lib");
  const engine = require("../scripts/jig");
  for (const row of [
    { guardId: "g-codex", tool: "apply_patch", decision: "pass", check: "unusable" },
    { guardId: "g-codex", tool: "apply_patch", decision: "false-positive-cleared" },
    { guardId: null, tool: "apply_patch", decision: "verified", verify: "test" },
  ]) lib.appendLedger(root, row);
  const before = engine.cmdReview(root).guards.find((guard) => guard.guardId === "g-codex");
  assert.equal(before.evaluated, 0);
  assert.deepEqual(before.evaluatedOn, []);

  const caught = run(root, patch("*** Add File: observed.js", "+try { risky(); } catch {}"));
  assert.equal(caught.out.jig.decision, "would-deny");
  run(root, patch("*** Add File: allowed.js", "+safe();"));
  lib.appendLedger(root, { guardId: "different-shell-guard", tool: "Bash", decision: "pass" });
  const reported = engine.cmdReview(root).guards.find((guard) => guard.guardId === "g-codex");
  assert.equal(reported.evaluated, 2);
  assert.equal(reported.wouldDeny, 1);
  assert.deepEqual(reported.evaluatedOn, ["apply_patch"]);
  assert.deepEqual(lib.shellToolsSeen(root), ["Bash"], "patch evaluations must not contaminate the shell-only surface");
});
