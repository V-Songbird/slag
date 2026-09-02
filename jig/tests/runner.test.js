"use strict";

// The session guards, end to end through the process the host actually spawns.
//
// The arming model this suite walks is SCOPE's, not 1.0.1's. A guard names an
// installed check; the check carries its own patterns, its own fixtures and its
// own deny triple; and what lets a guard block is the proof hash recorded when
// the fixture pair admitted it. There is no session ladder, no observe
// probation, and no top-level `mode` — every bar that used to be counted in
// clean sessions is now an integrity question with a yes or no answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOOKS_DIR = path.join(__dirname, "..", "hooks");
const RUNNER = path.join(HOOKS_DIR, "runner.js");
const HOOKS_JSON = path.join(HOOKS_DIR, "hooks.json");
const lib = require("../hooks/jig-lib");
const admission = require("../scripts/admission.js");
const A = require("./authored.js");

// Two more authored checks this suite needs and the shared fixture does not:
// one whose detector is branch-scoped, and one over test files.
const FORCE_PUSH = A.authored({
  id: "force-push",
  title: "A force push over the default branch",
  confidence: "heuristic",
  detectors: [
    { lever: "bash-guard", actor: "claude-session", confidence: "heuristic",
      params: { patterns: ["git\\s+push\\b[^\\n]*(?:--force\\b(?!-with-lease)|\\s-f\\b)"],
        onlyBranches: ["<default>"] } },
  ],
  fixtures: {
    violation: "git push --force origin main\n",
    nearMiss: "git push --force-with-lease origin main\n",
  },
  deny: {
    reason: "This rewrites the default branch for everyone.",
    alternative: "push with --force-with-lease, or open a branch",
    override: "say what history is being rewritten and why",
  },
});

const FOCUSED_TEST = A.authored({
  id: "focused-test",
  title: "A focused test left behind",
  detectors: [
    { lever: "edit-observe-guard", actor: "claude-session", confidence: "deterministic",
      params: { patterns: ["\\b(?:it|test|describe)\\.(?:only|skip)\\s*\\("], onlyWhenIntroduced: true } },
  ],
  fixtures: {
    violation: "it.only('a', () => {});\n",
    nearMiss: "it('a', () => {});\n",
  },
  deny: {
    reason: "This leaves one test running and the rest silently skipped.",
    alternative: "run the focused test locally and drop the .only before committing",
    override: "say which suite is being narrowed and until when",
  },
});

// The same catch shape, scoped to one tree. `paths` is the field the check
// driver has always read; these tests are what makes the session guard read it
// too, so a guard installed for `src/**/*.js` stops firing on `docs/notes.js`.
const SCOPED_CATCH = A.authored({
  id: "scoped-catch",
  title: "A swallowed error under src only",
  detectors: [
    { lever: "edit-observe-guard", actor: "claude-session", confidence: "deterministic",
      params: { patterns: [A.CATCH_PATTERN], paths: ["src/**/*.js"] } },
  ],
  fixtures: A.EMPTY_CATCH.fixtures,
  deny: A.DENY_CATCH,
});

// 2.11.0 / C2: the same catch shape on the lever that denies BEFORE the host
// writes the file. It is a second lever rather than a new event for the first,
// because the proof recorded for an installed guard binds the lever it was
// admitted on — `migrate` is what moves one across and re-records that proof.
const PREVENTED_CATCH = A.authored({
  id: "prevented-catch",
  title: "A swallowed error, refused before it is written",
  detectors: [
    { lever: "edit-guard", actor: "claude-session", confidence: "deterministic",
      params: { patterns: [A.CATCH_PATTERN] } },
  ],
  fixtures: A.EMPTY_CATCH.fixtures,
  deny: A.DENY_CATCH,
});

// A Bash guard whose params carry `paths` anyway. A Bash call names no file, so
// the field must not reach it — scoping a command by a path it does not have
// would silence the guard entirely.
const SCOPED_PIPE = A.authored({
  id: "scoped-pipe",
  title: "A piped installer, with a path glob that does not apply",
  detectors: [
    { lever: "bash-guard", actor: "claude-session", confidence: "deterministic",
      params: { patterns: [A.PIPE_PATTERN], paths: ["src/**/*.sh"] } },
  ],
  fixtures: A.PIPED_INSTALLER.fixtures,
  deny: A.DENY_PIPE,
});

// A check carrying a pattern that will not compile. `(` is a real regular
// expression source right up to the moment `new RegExp` reads it, which is what
// makes it data rather than a syntax error anybody would have caught: the
// module parses, the fixtures hash, the proof matches, and the guard installs.
const BAD_BASH_PATTERN = A.authored({
  id: "bad-bash-pattern",
  title: "A bash check whose pattern will not compile",
  detectors: [
    { lever: "bash-guard", actor: "claude-session", confidence: "deterministic",
      params: { patterns: ["("] } },
  ],
  fixtures: A.PIPED_INSTALLER.fixtures,
  deny: A.DENY_PIPE,
});

const BAD_EDIT_PATTERN = A.authored({
  id: "bad-edit-pattern",
  title: "An edit check whose pattern will not compile",
  detectors: [
    { lever: "edit-observe-guard", actor: "claude-session", confidence: "deterministic",
      params: { patterns: ["("] } },
  ],
  fixtures: A.EMPTY_CATCH.fixtures,
  deny: A.DENY_CATCH,
});

const roots = [];

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jig-runner-"));
  roots.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

// The check as the engine installs it: one module under `.jig/checks/` carrying
// its fixtures inline. The proof is taken over exactly those bytes, which is
// what makes a hand-edited config unable to claim one.
function installCheck(root, check) {
  const dir = path.join(root, ".jig", "checks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, check.id + ".check.mjs"), check.module);
  return admission.proofHash(check.module, check.fixtures.violation, check.fixtures.nearMiss);
}

function configure(root, config) {
  fs.mkdirSync(path.join(root, ".jig"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".jig", "config.json"),
    typeof config === "string" ? config : JSON.stringify(config, null, 2),
  );
  return root;
}

// A project with the named checks installed and one guard per check. `mode`
// applies to every guard; `proof` is the real one unless a test replaces it.
function guarded(checks, opts) {
  const o = opts || {};
  const root = tmpRoot();
  const guards = checks.map((check) => {
    const proof = installCheck(root, check);
    const runner = A.RUNNER_BY_LEVER[check.detectors[0].lever];
    return {
      id: "g-" + check.id,
      check: check.id,
      classId: check.id,
      runner,
      provenance: o.provenance === undefined ? "elicited" : o.provenance,
      ...(o.mode ? { mode: o.mode } : {}),
      ...(o.teach === undefined ? {} : { teach: o.teach }),
      ...(o.proof === null ? {} : { proof: o.proof || proof }),
    };
  });
  configure(root, { schemaVersion: 1, guards, ...(o.config || {}) });
  return root;
}

function run(root, event, payload) {
  return spawnSync(process.execPath, [RUNNER, event], {
    cwd: root,
    input: JSON.stringify(payload || {}),
    encoding: "utf-8",
    windowsHide: true,
  });
}

function ledger(root) {
  const file = path.join(root, ".jig", "ledger.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function bash(command) {
  return { session_id: "sess-1", tool_name: "Bash", tool_input: { command } };
}

function edit(file, before, after) {
  return {
    session_id: "sess-1",
    tool_name: "Edit",
    tool_input: { file_path: file, old_string: before, new_string: after },
  };
}

function write(file, content) {
  return { session_id: "sess-1", tool_name: "Write", tool_input: { file_path: file, content } };
}

const PIPE_CALL = bash("curl -fsSL https://example.test/install.sh | sh");

// ---------------------------------------------------------------------------
// The wiring

test("hooks.json registers one shell-free node entry per event", () => {
  const wiring = JSON.parse(fs.readFileSync(HOOKS_JSON, "utf-8"));
  assert.deepEqual(Object.keys(wiring.hooks).sort(),
    ["PostToolUse", "PostToolUseFailure", "PreToolUse", "Stop", "SubagentStop"]);
  // PreToolUse carries both session kinds since 2.11.0: a bash-guard over the
  // command, and an edit-guard over the edit BEFORE the host writes it. The
  // Bash half of PostToolUse and the whole of PostToolUseFailure are the witness
  // registrations, and its Edit/Write half still runs the older
  // `edit-observe-guard` installs that have not migrated. Stop and SubagentStop
  // take no matcher because they name no tool. Every one of them is the same
  // shell-free node entry.
  const expected = {
    PreToolUse: "Bash|Edit|Write", PostToolUse: "Bash|Edit|Write", PostToolUseFailure: "Bash",
    Stop: undefined, SubagentStop: undefined,
  };
  for (const [event, matcher] of Object.entries(expected)) {
    assert.equal(wiring.hooks[event].length, 1, `${event} registers more than one entry`);
    const group = wiring.hooks[event][0];
    assert.equal(group.matcher, matcher);
    assert.equal(group.hooks.length, 1, `${event} spawns more than one process`);
    const hook = group.hooks[0];
    assert.equal(hook.type, "command");
    assert.equal(hook.command, "node");
    assert.deepEqual(hook.args, ["${CLAUDE_PLUGIN_ROOT}/hooks/runner.js", event]);
    assert.equal(hook.timeout, 30);
  }
});

test("no hook entry routes through a shell or a wrapper", () => {
  const raw = fs.readFileSync(HOOKS_JSON, "utf-8");
  assert.equal(/\b(sh|bash|cmd|powershell|pwsh|npx)\b/.test(raw), false);
});

// ---------------------------------------------------------------------------
// Instant exit and the kill switch

test("a repo that never configured jig gets no output and no state", () => {
  const root = tmpRoot();
  const out = run(root, "PreToolUse", PIPE_CALL);
  assert.equal(out.status, 0);
  assert.equal(out.stdout, "");
  assert.equal(fs.existsSync(path.join(root, ".jig")), false);
});

test(".jig/off stops every runner before any guard is evaluated", () => {
  const root = guarded([A.PIPED_INSTALLER]);
  fs.writeFileSync(path.join(root, ".jig", "off"), "");
  const out = run(root, "PreToolUse", PIPE_CALL);
  assert.equal(out.status, 0);
  assert.equal(out.stdout, "");
  assert.deepEqual(ledger(root), []);
});

test("an unknown event name is a no-op, not a failure", () => {
  const root = guarded([A.PIPED_INSTALLER]);
  const out = run(root, "SessionStart", PIPE_CALL);
  assert.equal(out.status, 0);
  assert.equal(out.stdout, "");
  assert.deepEqual(ledger(root), []);
});

// The standing-tax measurement. Measured against a bare node spawn on this
// machine rather than a fixed millisecond budget, so it states what jig
// actually adds instead of what the CI box happens to manage.
test("the unconfigured path costs about what starting node costs", () => {
  const root = tmpRoot();
  const median = (times) => times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
  const sample = (fn) => median(Array.from({ length: 7 }, () => {
    const t0 = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - t0) / 1e6;
  }));

  const baseline = sample(() =>
    spawnSync(process.execPath, ["-e", ""], { encoding: "utf-8", windowsHide: true }));
  const runner = sample(() => run(root, "PreToolUse", bash("echo hi")));
  const overhead = runner - baseline;

  console.log(`      spawn: bare node ${baseline.toFixed(1)}ms, jig runner ${runner.toFixed(1)}ms` +
    ` (+${overhead.toFixed(1)}ms)`);
  assert.ok(overhead < 250, `jig adds ${overhead.toFixed(1)}ms over a bare node spawn`);
});

// ---------------------------------------------------------------------------
// Fail open

test("an unparseable config fails open with exactly one ledger line", () => {
  const root = configure(tmpRoot(), "{ not json");
  const out = run(root, "PreToolUse", PIPE_CALL);
  assert.equal(out.status, 0);
  assert.match(out.stderr, /guards are off for this call/);
  const rows = ledger(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].config, "invalid");
  assert.equal(rows[0].decision, "pass");
  assert.match(rows[0].problems.join(" "), /not valid JSON/);
});

test("a config from a newer schema is refused rather than guessed at", () => {
  const root = guarded([A.PIPED_INSTALLER]);
  const config = JSON.parse(fs.readFileSync(path.join(root, ".jig", "config.json"), "utf-8"));
  configure(root, { ...config, schemaVersion: 2 });
  run(root, "PreToolUse", PIPE_CALL);
  const rows = ledger(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].config, "invalid");
  assert.match(rows[0].problems.join(" "), /schemaVersion 2 .*reads 1/);
});

test("a guard naming a check that is not installed is reported once and blocks nothing", () => {
  const root = guarded([A.PIPED_INSTALLER], { mode: "armed" });
  fs.rmSync(path.join(root, ".jig", "checks", "piped-installer.check.mjs"));
  const out = run(root, "PreToolUse", PIPE_CALL);
  assert.equal(out.status, 0);
  assert.match(out.stderr, /is not running/);
  assert.deepEqual(Object.keys(JSON.parse(out.stdout)), ["jig"]);
  const row = ledger(root)[0];
  assert.equal(row.decision, "pass");
  assert.equal(row.check, "unusable");
});

test("a guard whose check carries nothing for its event is reported, not silently skipped", () => {
  // The check only ever declares a PostToolUse detector; the guard claims the
  // Bash runner. That is a broken install, and saying nothing about it would
  // report coverage nothing delivers.
  const root = tmpRoot();
  const proof = installCheck(root, A.EMPTY_CATCH);
  configure(root, { schemaVersion: 1, guards: [{ id: "g", check: "empty-catch", classId: "empty-catch",
    runner: "PreToolUse", mode: "armed", provenance: "elicited", proof }] });
  const out = run(root, "PreToolUse", PIPE_CALL);
  assert.match(out.stderr, /declares no PreToolUse detector/);
  assert.equal(ledger(root)[0].decision, "pass");
});

test("a check name that could climb out of .jig/checks is refused, never resolved", () => {
  for (const name of ["../../etc/passwd", "..", "a/b", "", "\\evil"]) {
    const { problems } = lib.validateConfig({
      schemaVersion: 1,
      guards: [{ id: "g", check: name, runner: "PreToolUse" }],
    });
    assert.match(problems.join(" "), /must name a check installed under/, JSON.stringify(name) + " slipped through");
  }
});

test("an unknown top-level key is warned about and ignored, and the guards still run", () => {
  const root = guarded([A.PIPED_INSTALLER], { config: { experimental: true } });
  const out = run(root, "PreToolUse", PIPE_CALL);
  assert.match(out.stderr, /ignoring unknown key `experimental`/);
  const rows = ledger(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, "would-deny");
});

// ---------------------------------------------------------------------------
// The injection firewall

test("a guard supplying its own pattern is refused, never installed", () => {
  const root = guarded([A.PIPED_INSTALLER]);
  const config = JSON.parse(fs.readFileSync(path.join(root, ".jig", "config.json"), "utf-8"));
  config.guards[0].patterns = ["^.*$"];
  configure(root, config);
  run(root, "PreToolUse", bash("ls"));
  const rows = ledger(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].config, "invalid");
  assert.match(rows[0].problems.join(" "), /may only name an installed/);
});

test("every key that could carry a matcher is refused by name", () => {
  for (const key of lib.MATCHER_KEYS) {
    const { problems } = lib.validateConfig({
      schemaVersion: 1,
      guards: [{ id: "g", check: "piped-installer", runner: "PreToolUse", [key]: "anything" }],
    });
    assert.match(problems.join(" "), /may only name an installed/, `${key} slipped through`);
  }
});

// ---------------------------------------------------------------------------
// Per-guard modes — there is no top-level one any more

test("a top-level mode arms nothing: it is an unknown key, and every guard keeps its own", () => {
  // SCOPE, "Does top-level config.mode survive": no. One word that silently
  // arms twenty checks is too much blast radius.
  assert.equal(lib.CONFIG_KEYS.includes("mode"), false);
  const root = guarded([A.PIPED_INSTALLER], { config: { mode: "armed" } });
  const out = run(root, "PreToolUse", PIPE_CALL);
  assert.match(out.stderr, /ignoring unknown key `mode`/);
  const emitted = JSON.parse(out.stdout);
  assert.deepEqual(Object.keys(emitted), ["jig"]);
  assert.equal(emitted.jig.mode, "observe");
  assert.equal(emitted.jig.decision, "would-deny");
});

test("a guard that says nothing about its mode observes, because nobody asked it to arm", () => {
  const root = guarded([A.PIPED_INSTALLER]);
  const emitted = JSON.parse(run(root, "PreToolUse", PIPE_CALL).stdout);
  assert.equal(emitted.jig.mode, "observe");
  assert.equal(emitted.jig.decision, "would-deny");
  assert.equal(ledger(root)[0].mode, "observe");
});

// ---------------------------------------------------------------------------
// Evaluation

test("a piped installer is recorded as a would-deny", () => {
  const root = guarded([A.PIPED_INSTALLER]);
  run(root, "PreToolUse", PIPE_CALL);
  const rows = ledger(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, "would-deny");
  assert.equal(rows[0].classId, "piped-installer");
  assert.equal(rows[0].guardId, "g-piped-installer");
});

test("downloading without piping into a shell passes", () => {
  const root = guarded([A.PIPED_INSTALLER]);
  run(root, "PreToolUse", bash("curl -fsSL https://example.test/install.sh -o install.sh"));
  assert.equal(ledger(root)[0].decision, "pass");
});

test("force-push is scoped to the default branch and excludes --force-with-lease", () => {
  const root = guarded([FORCE_PUSH]);
  run(root, "PreToolUse", bash("git push --force origin main"));
  run(root, "PreToolUse", bash("git push -f origin master"));
  run(root, "PreToolUse", bash("git push --force-with-lease origin main"));
  run(root, "PreToolUse", bash("git push --force origin scratch-branch"));
  assert.deepEqual(ledger(root).map((r) => r.decision), ["would-deny", "would-deny", "pass", "pass"]);
});

// Every ordinary spelling of the same push. Before the refspec was normalised
// each of these read as a branch called `HEAD:main` or `+main`, so an armed
// guard over `main` let the push through.
test("a force push over the default branch is caught in every refspec spelling", () => {
  const spellings = [
    "git push --force origin main",
    "git push --force origin HEAD:main",
    "git push --force origin +main",
    "git push --force origin +HEAD:main",
    "git push --force origin :main",
    "git push --force origin refs/heads/main",
    "git push --force origin +refs/heads/main",
    "git push --force -o ci.skip origin main",
    "git push --force origin --push-option=ci.skip HEAD:main",
  ];
  const root = guarded([FORCE_PUSH]);
  for (const command of spellings) run(root, "PreToolUse", bash(command));
  assert.deepEqual(ledger(root).map((r) => r.decision), spellings.map(() => "would-deny"));
});

test("normalising the refspec does not widen the guard past its branch", () => {
  const root = guarded([FORCE_PUSH]);
  for (const command of [
    "git push --force origin HEAD:scratch",
    "git push --force origin +refs/heads/scratch",
    "git push --force -o ci.skip origin scratch",
  ]) run(root, "PreToolUse", bash(command));
  assert.deepEqual(ledger(root).map((r) => r.decision), ["pass", "pass", "pass"]);
});

test("pushBranch reads the destination out of a refspec", () => {
  for (const [command, branch] of [
    ["git push origin main", "main"],
    ["git push origin HEAD:main", "main"],
    ["git push origin +main", "main"],
    ["git push origin +HEAD:main", "main"],
    ["git push origin :main", "main"],
    ["git push origin refs/heads/main", "main"],
    ["git push -o ci.skip origin main", "main"],
    ["git push origin main:", "main"],
    ["git push --force", null],
    ["git push -o ci.skip origin", null],
    // `-o` is not the only option whose value is the next word. Each of these
    // leaves one bare token in argv, and skipping the flag alone would read
    // that value as the remote and the remote as the branch.
    ["git push --receive-pack /usr/bin/git-receive-pack --force origin main", "main"],
    ["git push --exec /usr/bin/git-receive-pack --force origin main", "main"],
    ["git push --repo upstream --force origin main", "main"],
    ["git push --receive-pack=/usr/bin/git-receive-pack --force origin main", "main"],
  ]) assert.equal(lib.pushBranch(command), branch, command);
});

test("an armed force-push guard is not dodged by an option that takes a value", () => {
  const root = guarded([FORCE_PUSH], { mode: "armed" });
  const out = JSON.parse(run(root, "PreToolUse",
    bash("git push --receive-pack /usr/bin/git-receive-pack --force origin main")).stdout);
  assert.equal(out.jig.decision, "deny", "a separated option value shifted the refspec out of scope");
});

test("the default branch set is configurable without touching a pattern", () => {
  const root = guarded([FORCE_PUSH], { config: { defaultBranches: ["trunk"] } });
  run(root, "PreToolUse", bash("git push --force origin trunk"));
  run(root, "PreToolUse", bash("git push --force origin main"));
  assert.deepEqual(ledger(root).map((r) => r.decision), ["would-deny", "pass"]);
});

test("deleting a test file by shell is recorded as the labeled heuristic it is", () => {
  const root = guarded([A.HEURISTIC_ONLY]);
  run(root, "PreToolUse", bash("git rm tests/tokenize.spec.js"));
  run(root, "PreToolUse", bash("rm -rf build/"));
  const rows = ledger(root);
  assert.deepEqual(rows.map((r) => r.decision), ["would-deny", "pass"]);
  assert.equal(rows[0].confidence, "heuristic");
});

test("an edit that introduces a focused test fires, and one that only moves it does not", () => {
  const root = guarded([FOCUSED_TEST]);
  run(root, "PostToolUse", edit("a.test.js", "it(", "it.only("));
  run(root, "PostToolUse", edit("a.test.js", "it.only('a'", "it.only('b'"));
  assert.deepEqual(ledger(root).map((r) => r.decision), ["would-deny", "pass"]);
});

test("an edit that introduces an empty catch fires", () => {
  const root = guarded([A.EMPTY_CATCH]);
  run(root, "PostToolUse", edit("a.js", "risky();", "try { risky(); } catch (err) {}"));
  const rows = ledger(root);
  assert.equal(rows[0].decision, "would-deny");
  assert.equal(rows[0].path, "a.js");
  assert.equal(rows[0].tool, "Edit");
});

// ---------------------------------------------------------------------------
// 2.11.0 / C6: an observing guard that was asked to say so
//
// SCOPE, "Does an observing guard teach by default": no. Observe is a mode the
// owner chose, and turning every observing guard into a line in the transcript
// changes what that choice meant after the fact. So the default below is the
// binding half of this feature, not the feature.

test("an observing guard says nothing in the transcript unless its own row asked", () => {
  const root = guarded([A.EMPTY_CATCH]);
  const out = JSON.parse(run(root, "PostToolUse", edit("a.js", "risky();", "try { risky(); } catch {}")).stdout);
  assert.equal(out.jig.decision, "would-deny");
  assert.deepEqual(Object.keys(out), ["jig"], "a would-deny reached the model with nobody asking it to");
});

test("a guard opted into teaching emits the would-deny as one line of PostToolUse context", () => {
  const root = guarded([A.EMPTY_CATCH], { teach: true });
  const out = JSON.parse(run(root, "PostToolUse", edit("a.js", "risky();", "try { risky(); } catch {}")).stdout);
  assert.equal(out.jig.decision, "would-deny");
  assert.equal(out.jig.mode, "observe");
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  const line = out.hookSpecificOutput.additionalContext;
  // The guard id and the deny triple, and one line of them.
  assert.equal(line.includes("\n"), false);
  assert.match(line, /^\[jig guard g-empty-catch would have denied this\]/);
  assert.ok(line.includes(A.DENY_CATCH.reason));
  assert.ok(line.includes(A.DENY_CATCH.alternative));
  assert.ok(line.includes(A.DENY_CATCH.override));
  // No source. The line names the mistake, never the bytes that made it.
  assert.equal(line.includes("catch {}"), false);
  assert.equal(line.includes("a.js"), false);
  // Teaching is not deciding: nothing here blocks the call the host already ran.
  assert.equal(out.decision, undefined);
});

test("teaching stays quiet on a pass, and speaks once however many guards matched", () => {
  const root = guarded([A.EMPTY_CATCH, FOCUSED_TEST], { teach: true });
  const clean = JSON.parse(run(root, "PostToolUse", write("a.test.js", "it('a', () => {});")).stdout);
  assert.equal(clean.jig.decision, "pass");
  assert.equal(clean.hookSpecificOutput, undefined);
  const both = JSON.parse(run(root, "PostToolUse",
    write("a.test.js", "it.only('a', () => { try { x(); } catch {} });")).stdout);
  assert.deepEqual(both.jig.guards.map((g) => g.decision), ["would-deny", "would-deny"]);
  assert.equal(both.hookSpecificOutput.additionalContext.split("\n").length, 1);
  // And it is the FIRST match that speaks. One line is true whichever guard
  // wrote it, so without naming the guard the first-wins rule is untested.
  assert.match(both.hookSpecificOutput.additionalContext,
    /^\[jig guard g-empty-catch would have denied this\]/);
});

test("teaching is refused the unverified PreToolUse channel, out loud", () => {
  // HARNESS-PASS C6: a non-blocking model-visible channel on PreToolUse is
  // unverified against a live host, so a row asking for one is told so rather
  // than left believing the transcript carries its line.
  const root = guarded([A.PIPED_INSTALLER], { teach: true });
  const out = run(root, "PreToolUse", PIPE_CALL);
  assert.match(out.stderr, /`teach` speaks on PostToolUse only, and g-piped-installer runs on PreToolUse/);
  const emitted = JSON.parse(out.stdout);
  assert.equal(emitted.jig.decision, "would-deny");
  assert.deepEqual(Object.keys(emitted), ["jig"]);
});

test("a non-boolean teach is a config that cannot be read as an answer", () => {
  const check = lib.validateConfig({
    schemaVersion: 1,
    guards: [{ id: "g", check: "c", runner: "PostToolUse", teach: "yes" }],
  });
  assert.match(check.problems.join("\n"), /`teach` must be true or false/);
  assert.equal(check.guards.length, 0);
});

test("an armed guard on the same event still refuses, and teaching does not ride the refusal", () => {
  const root = guarded([A.EMPTY_CATCH], { mode: "armed", teach: true });
  const out = JSON.parse(run(root, "PostToolUse", edit("a.js", "risky();", "try { risky(); } catch {}")).stdout);
  assert.equal(out.jig.decision, "deny");
  assert.equal(out.decision, "block");
  // Nothing to teach: the guard armed, so the deny reply already said it.
  assert.equal(out.hookSpecificOutput, undefined);
});

test("a whole-file Write has no prior text, so its whole body counts as introduced", () => {
  const root = guarded([A.EMPTY_CATCH]);
  run(root, "PostToolUse", write("a.js", "try { risky(); } catch {}"));
  assert.equal(ledger(root)[0].decision, "would-deny");
});

test("a shape living only in a comment, a string, or a regex does not fire", () => {
  const root = guarded([A.EMPTY_CATCH, FOCUSED_TEST]);
  run(root, "PostToolUse", write("a.test.js", [
    "// it.only( lives in this comment",
    "/* and catch (e) {} in this block one */",
    'const s = "it.only(";',
    "const t = `describe.skip(`;",
    "const re = /catch\\s*\\{\\s*\\}/;",
  ].join("\n")));
  assert.deepEqual(ledger(root).map((r) => r.decision), ["pass", "pass"]);
});

test("blanking reads the file's own comment style, so a hash comment is a comment in a yml file", () => {
  const root = guarded([A.EMPTY_CATCH]);
  run(root, "PostToolUse", write("notes.yml", "# mentions catch {} in a comment\nkey: value"));
  run(root, "PostToolUse", write("a.js", "try { x(); } catch {} // real, outside the comment"));
  assert.deepEqual(ledger(root).map((r) => r.decision), ["pass", "would-deny"]);
});

test("a comment-only catch body still counts as a catch after blanking", () => {
  // Blanked regions keep their length and newlines, so `catch (err) { /* why */ }`
  // still reads as an empty body — the fixture's comment-only-catch decision.
  const root = guarded([A.EMPTY_CATCH]);
  run(root, "PostToolUse", write("a.js", "try { x(); } catch (err) {\n  // the cache is optional\n}"));
  assert.equal(ledger(root)[0].decision, "would-deny");
});

test("an edit that moves a violation out of a string into code is an introduction", () => {
  const root = guarded([FOCUSED_TEST]);
  run(root, "PostToolUse", edit("a.test.js", 'const s = "it.only(";', "it.only('now real', () => {});"));
  assert.equal(ledger(root)[0].decision, "would-deny");
});

// ---------------------------------------------------------------------------
// The scope a check already declared

test("a guard scoped by paths passes on a file outside them", () => {
  const root = guarded([SCOPED_CATCH]);
  run(root, "PostToolUse", write("docs/notes.js", "try { x(); } catch {}"));
  const rows = ledger(root);
  assert.equal(rows[0].decision, "pass", "an out-of-scope edit was recorded as a catch");
  assert.equal(rows[0].matched, null);
});

test("the same guard fires on a file inside them", () => {
  const root = guarded([SCOPED_CATCH]);
  run(root, "PostToolUse", write("src/lib/a.js", "try { x(); } catch {}"));
  assert.equal(ledger(root)[0].decision, "would-deny");
});

test("the host names the file absolutely, and on win32 with backslashes", () => {
  const root = guarded([SCOPED_CATCH]);
  const slash = root.replace(/\\/g, "/");
  run(root, "PostToolUse", write(slash + "/src/lib/a.js", "try { x(); } catch {}"));
  run(root, "PostToolUse", write(slash.replace(/\//g, "\\") + "\\src\\lib\\a.js", "try { x(); } catch {}"));
  run(root, "PostToolUse", write(slash + "/docs/notes.js", "try { x(); } catch {}"));
  assert.deepEqual(ledger(root).map((r) => r.decision), ["would-deny", "would-deny", "pass"]);
});

// The two halves of the same rule: a repo-relative glob is anchored at the
// repository root, not at any separator that happens to precede it. Matching a
// TAIL of the path instead reads a directory named like the glob at any depth —
// and above the checkout too, so a repository cloned under a `vendor` directory
// has every armed guard in it disarmed by an observe zone the owner wrote for
// its own `vendor/`.
test("a guard scoped by paths ignores a directory of the same name deeper in", () => {
  const root = guarded([SCOPED_CATCH]);
  run(root, "PostToolUse", write("vendor/src/lib/a.js", "try { x(); } catch {}"));
  const rows = ledger(root);
  assert.equal(rows[0].decision, "pass", "a path glob matched a tail of the path rather than the whole of it");
  assert.equal(rows[0].matched, null);
});

test("an observe zone disarms the directory it names and no other of that name", () => {
  const root = guarded([A.EMPTY_CATCH], { mode: "armed", config: { zones: { observe: ["docs/**"] } } });
  const inZone = JSON.parse(run(root, "PostToolUse",
    write("docs/notes.js", "try { x(); } catch {}")).stdout);
  assert.equal(inZone.jig.guards[0].mode, "observe");
  const outside = JSON.parse(run(root, "PostToolUse",
    write("src/docs/notes.js", "try { x(); } catch {}")).stdout);
  assert.equal(outside.jig.guards[0].mode, "armed",
    "a zone named for one directory pulled an armed guard to observe in another of that name");
  assert.equal(outside.jig.decision, "deny");
});

test("a guard whose check names no paths still matches everywhere", () => {
  const root = guarded([A.EMPTY_CATCH]);
  run(root, "PostToolUse", write("docs/notes.js", "try { x(); } catch {}"));
  run(root, "PostToolUse", write("anywhere/at/all.js", "try { x(); } catch {}"));
  assert.deepEqual(ledger(root).map((r) => r.decision), ["would-deny", "would-deny"]);
});

test("an armed scoped guard refuses nothing outside its own paths", () => {
  const root = guarded([SCOPED_CATCH], { mode: "armed" });
  const out = JSON.parse(run(root, "PostToolUse", write("docs/notes.js", "try { x(); } catch {}")).stdout);
  assert.equal(out.jig.decision, "pass");
  assert.equal(out.decision, undefined, "an out-of-scope edit was blocked");
});

test("paths never reaches a Bash call, which names no file at all", () => {
  const root = guarded([SCOPED_PIPE]);
  run(root, "PreToolUse", PIPE_CALL);
  assert.equal(ledger(root)[0].decision, "would-deny");
});

test("an observe zone reads an absolute path the same way a scope glob does", () => {
  const root = guarded([A.EMPTY_CATCH], { mode: "armed", config: { zones: { observe: ["docs/**"] } } });
  const out = JSON.parse(run(root, "PostToolUse",
    write(root.replace(/\//g, "\\") + "\\docs\\notes.js", "try { x(); } catch {}")).stdout);
  assert.equal(out.jig.decision, "would-deny");
  assert.equal(out.jig.guards[0].mode, "observe");
});

test("a PreToolUse guard never runs on a PostToolUse event", () => {
  const root = guarded([A.PIPED_INSTALLER, A.EMPTY_CATCH]);
  run(root, "PostToolUse", edit("a.js", "risky();", "try { risky(); } catch {}"));
  assert.deepEqual(ledger(root).map((r) => r.guardId), ["g-empty-catch"]);
});

// ---------------------------------------------------------------------------
// Order and the ledger record

test("guards evaluate in an order the config file cannot reorder", () => {
  const forward = guarded([A.PIPED_INSTALLER, FORCE_PUSH, A.HEURISTIC_ONLY]);
  const reversed = guarded([A.HEURISTIC_ONLY, FORCE_PUSH, A.PIPED_INSTALLER]);
  const call = bash("ls");
  run(forward, "PreToolUse", call);
  run(reversed, "PreToolUse", call);
  assert.deepEqual(ledger(forward).map((r) => r.guardId), ledger(reversed).map((r) => r.guardId));
  assert.deepEqual(ledger(forward).map((r) => r.guardId),
    ["g-force-push", "g-piped-installer", "g-test-file-removal"]);
});

test("every ledger line carries the session and the actor that produced it", () => {
  const root = guarded([A.PIPED_INSTALLER]);
  run(root, "PreToolUse", PIPE_CALL);
  const row = ledger(root)[0];
  assert.equal(row.session, "sess-1");
  assert.equal(row.actor, "claude-session");
});

test("a ledger line records which pattern fired, never the text it matched", () => {
  const root = guarded([A.EMPTY_CATCH]);
  const secret = "try { charge(CARD_9421); } catch (err) {}";
  run(root, "PostToolUse", edit("a.js", "", secret));
  const row = ledger(root)[0];
  assert.doesNotThrow(() => new RegExp(row.matched));
  assert.equal(fs.readFileSync(path.join(root, ".jig", "ledger.jsonl"), "utf-8").includes("CARD_9421"), false);
});

test("the ledger schema ships every field the review surface reads", () => {
  const root = guarded([A.PIPED_INSTALLER]);
  run(root, "PreToolUse", PIPE_CALL);
  const row = ledger(root)[0];
  for (const field of ["ts", "session", "actor", "guardId", "classId", "mode", "decision", "tool", "matched", "path", "durMs"]) {
    assert.ok(field in row, `ledger line is missing ${field}`);
  }
  assert.equal(typeof row.durMs, "number");
});

// ---------------------------------------------------------------------------
// The arming gate
//
// effectiveState is a pure truth table; these tests walk its rows. Deny then
// gets one end-to-end proof per event, against a real installed check whose
// proof really was taken over the module on disk.

const PROVEN = { proof: "a".repeat(64), deny: A.DENY_PIPE, falsePositive: false };

function state(guardExtra, configExtra, evidence) {
  const guard = { id: "g", check: "piped-installer", classId: "piped-installer",
    runner: "PreToolUse", provenance: "elicited", mode: "armed", proof: "a".repeat(64), ...guardExtra };
  const config = { schemaVersion: 1, guards: [], ...configExtra };
  return lib.effectiveState(guard, config, guardExtra && guardExtra._path,
    evidence === undefined ? PROVEN : evidence);
}

test("the truth table: every bar to arming holds in order", () => {
  assert.equal(state({ mode: undefined }).mode, "observe");
  assert.match(state({ mode: undefined }).why, /not asked to arm/);

  // An incomplete deny triple: the check should have been discarded at
  // admission, and reaching here means something wrote a guard for one that
  // never earned a reply.
  assert.match(state({}, {}, { ...PROVEN, deny: null }).why, /no complete deny reply/);

  assert.match(state({ proof: undefined }).why, /records no proof/);
  assert.match(state({ proof: "b".repeat(64) }).why, /does not match the check on disk/);

  assert.equal(state({ _path: "src/app.js" }, { zones: { observe: ["src/**"] } }).mode, "observe");
  assert.equal(state({ _path: "bin/x.js" }, { zones: { observe: ["src/**"] } }).mode, "armed");

  assert.match(state({}, {}, { ...PROVEN, falsePositive: true }).why, /false positive/);
  assert.equal(state({}).mode, "armed");
  assert.match(state({}).why, /proof matches the check on disk/);

  // Provenance is disclosed and decides nothing at runtime: what proves a check
  // now is its fixture pair, not where the answer came from (SCOPE).
  assert.equal(state({ provenance: "assumed" }).mode, "armed");
});

test("no session count reaches the truth table at all", () => {
  // The ten and twenty-five clean-session ladder is deleted (SCOPE, "Does the
  // ten-clean-session ladder survive": no). Nothing arms on a count, so a
  // brand-new install with an empty ledger arms exactly as a veteran one does.
  const fresh = guarded([A.PIPED_INSTALLER], { mode: "armed" });
  assert.equal(JSON.parse(run(fresh, "PreToolUse", PIPE_CALL).stdout).jig.mode, "armed");
  assert.equal(lib.effectiveState.length, 4, "effectiveState grew an argument the ladder used to need");
  assert.equal(JSON.stringify(lib.ledgerStats(fresh)).includes("sessionsSinceReset"), false);
});

test("ledgerStats reports what each guard did, and a false positive stands until it is cleared", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".jig"), { recursive: true });
  const rows = [
    { session: "s0", guardId: "g", decision: "pass" },
    { session: "s1", guardId: "g", decision: "would-deny" },
    { session: "s2", guardId: "g", decision: "deny" },
    { guardId: "g", decision: "false-positive" },
    { guardId: "h", decision: "false-positive" },
    { guardId: "h", decision: "false-positive-cleared" },
  ];
  fs.writeFileSync(path.join(root, ".jig", "ledger.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const stats = lib.ledgerStats(root);
  assert.equal(stats.g.fired, 2);
  assert.equal(stats.g.falsePositives, 1);
  assert.equal(stats.g.standingFalsePositive, true);
  assert.equal(stats.h.falsePositives, 1);
  assert.equal(stats.h.standingFalsePositive, false, "a cleared wave-off still held the guard down");
});

test("fired carries a denominator, the deny/would-deny split and the last catch", () => {
  // `fired` alone made four catches in four calls read like four in four
  // thousand. Every evaluated guard leaves a row on every call, so the
  // denominator is already in the ledger — it was never counted.
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".jig"), { recursive: true });
  const rows = [
    { ts: "2026-09-01T00:00:00.000Z", guardId: "g", decision: "pass" },
    { ts: "2026-09-01T00:00:01.000Z", guardId: "g", decision: "would-deny" },
    { ts: "2026-09-01T00:00:03.000Z", guardId: "g", decision: "deny" },
    { ts: "2026-09-01T00:00:02.000Z", guardId: "g", decision: "pass" },
    // A wave-off is a judgment, not a call the guard was run on.
    { ts: "2026-09-01T00:00:04.000Z", guardId: "g", decision: "false-positive" },
    // A witness row carries no guardId and reaches none of this.
    { ts: "2026-09-01T00:00:05.000Z", decision: "verified", verify: "tests" },
    { ts: "2026-09-01T00:00:06.000Z", guardId: "h", decision: "pass" },
  ];
  fs.writeFileSync(path.join(root, ".jig", "ledger.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const stats = lib.ledgerStats(root);
  assert.equal(stats.g.evaluated, 4, "the pass rows are the denominator");
  assert.equal(stats.g.fired, 2);
  assert.equal(stats.g.denied, 1);
  assert.equal(stats.g.wouldDeny, 1);
  // Ordered by the row's own timestamp: more than one lane appends here, so
  // position in the file is not the order things happened in.
  assert.equal(stats.g.lastFired, "2026-09-01T00:00:03.000Z");
  assert.equal(stats.h.evaluated, 1);
  assert.equal(stats.h.fired, 0);
  assert.equal(stats.h.lastFired, null, "a guard that never fired reported a last catch");
});

// The row a broken guard leaves on every call. Counted, it reported "caught 0
// out of 4 looks" for a guard that never looked once — the denominator saying
// the guard was working hardest on exactly the calls it was not running for.
test("a call a guard could not be run on is not part of its denominator", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".jig"), { recursive: true });
  const rows = [
    { guardId: "g", decision: "pass" },
    { guardId: "g", decision: "pass", check: "unusable", why: "the installed check could not be read" },
    { guardId: "g", decision: "pass", check: "unusable", why: "the installed check could not be read" },
  ];
  fs.writeFileSync(path.join(root, ".jig", "ledger.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(lib.ledgerStats(root).g.evaluated, 1);
});

// The commit lane writes rows with the class it caught and no guard id, because
// the check driver runs no guard. Keyed by class, they are what stops a class
// that has only ever fired at commit time reading as one that never fired.
test("a commit-lane row is counted under its class, never under a guard", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".jig"), { recursive: true });
  const rows = [
    { ts: "2026-09-01T00:00:00.000Z", guardId: "g", decision: "pass" },
    { ts: "2026-09-01T00:00:01.000Z", lane: "commit", guardId: null, classId: "empty-catch", decision: "deny" },
  ];
  fs.writeFileSync(path.join(root, ".jig", "ledger.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const stats = lib.ledgerStats(root);
  assert.equal(stats.g.fired, 0, "a lane with no denominator was folded into one that has");
  assert.equal(stats.g.evaluated, 1);
  assert.equal(stats[lib.CLASS_KEY + "empty-catch"].fired, 1);
  assert.equal(stats[lib.CLASS_KEY + "empty-catch"].lastFired, "2026-09-01T00:00:01.000Z");
});

test("a guard whose proof matches denies a PreToolUse call, with reason, alternative and override", () => {
  const root = guarded([A.PIPED_INSTALLER], { mode: "armed" });
  const out = run(root, "PreToolUse", PIPE_CALL);
  const emitted = JSON.parse(out.stdout);
  assert.equal(emitted.jig.decision, "deny");
  assert.equal(emitted.hookSpecificOutput.permissionDecision, "deny");
  const reason = emitted.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /unreviewed code/);
  assert.match(reason, /Instead:/);
  assert.match(reason, /To override:/);
  const last = ledger(root).at(-1);
  assert.equal(last.decision, "deny");
  assert.equal(last.mode, "armed");
});

// Defect 23: the blocked agent is the one audience jig never wrote for. It was
// told what was wrong and offered nothing to look up and no way to appeal.
test("a deny names the guard that refused and how to report it as a false alarm", () => {
  const root = guarded([A.PIPED_INSTALLER], { mode: "armed" });
  const emitted = JSON.parse(run(root, "PreToolUse", PIPE_CALL).stdout);
  const guardId = emitted.jig.guards.find((g) => g.decision === "deny").guardId;
  const reason = emitted.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.startsWith("[jig guard " + guardId + "] "), reason);
  assert.ok(reason.endsWith("(false alarm? /jig:review fp " + guardId + ")"), reason);
});

// 2.9.0 / C7: the deny reply is jig's only channel to the model and it fires
// after the fact, so it is also the one place worth naming the driver — but
// only where there is one to name.
test("a deny points at the check driver when the install has one", () => {
  const root = guarded([A.PIPED_INSTALLER], { mode: "armed" });
  fs.mkdirSync(path.join(root, ".jig", "checks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".jig", "checks", "run.mjs"), "// driver\n");
  const emitted = JSON.parse(run(root, "PreToolUse", PIPE_CALL).stdout);
  assert.match(emitted.hookSpecificOutput.permissionDecisionReason,
    /Before calling this work done, run: node \.jig\/checks\/run\.mjs\./);
});

test("a deny from an install with no driver never names one", () => {
  const root = guarded([A.PIPED_INSTALLER], { mode: "armed" });
  assert.equal(fs.existsSync(path.join(root, ".jig", "checks", "run.mjs")), false);
  const emitted = JSON.parse(run(root, "PreToolUse", PIPE_CALL).stdout);
  assert.equal(emitted.hookSpecificOutput.permissionDecisionReason.includes("run.mjs"), false);
});

test("an armed edit guard blocks a PostToolUse write with the same three-part reason", () => {
  const root = guarded([A.EMPTY_CATCH], { mode: "armed" });
  const out = run(root, "PostToolUse", edit("a.js", "risky();", "try { risky(); } catch {}"));
  const emitted = JSON.parse(out.stdout);
  assert.equal(emitted.decision, "block");
  assert.match(emitted.reason, /Instead:/);
  assert.match(emitted.reason, /To override:/);
});

// 2.11.0 / C2. The `edit-observe-guard` above denies at PostToolUse, by which
// time the host has already written the file: jig's prevention story ended one
// step too late. `edit-guard` is the same detector one event earlier, and the
// answer the host reads is a permission decision rather than a block after the
// fact.
test("an armed edit-guard refuses the write before the bytes land", () => {
  const root = guarded([PREVENTED_CATCH], { mode: "armed" });
  const call = write("a.js", "try { risky(); } catch (err) {}");
  const emitted = JSON.parse(run(root, "PreToolUse", call).stdout);
  assert.equal(emitted.jig.decision, "deny");
  assert.equal(emitted.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(emitted.hookSpecificOutput.permissionDecision, "deny");
  assert.match(emitted.hookSpecificOutput.permissionDecisionReason, /Instead:/);
  // And nothing is left behind on the event the older lever runs on.
  assert.equal(JSON.parse(run(root, "PostToolUse", call).stdout).jig.decision, "pass");
});

// Both session levers arrive on PreToolUse now, so the EVENT can no longer say
// how a detector's params are read. Reading them by event would run a shell
// pattern over a file's contents, and would put a pass row on the guard that
// was never asked — inflating the denominator `fired` is reported against.
test("a bash guard and an edit guard share PreToolUse and never read each other's call", () => {
  const root = guarded([A.PIPED_INSTALLER, PREVENTED_CATCH]);
  run(root, "PreToolUse", PIPE_CALL);
  run(root, "PreToolUse", write("a.js", "try { risky(); } catch (err) {}"));
  assert.deepEqual(ledger(root).map((r) => r.guardId + " " + r.decision),
    ["g-piped-installer would-deny", "g-prevented-catch would-deny"]);
});

test("a config claiming a proof the check does not have cannot deny", () => {
  const root = guarded([A.PIPED_INSTALLER], { mode: "armed", proof: "0".repeat(64) });
  const emitted = JSON.parse(run(root, "PreToolUse", PIPE_CALL).stdout);
  assert.deepEqual(Object.keys(emitted), ["jig"]);
  assert.equal(emitted.jig.decision, "would-deny");
  assert.equal(ledger(root).at(-1).mode, "observe");
});

test("editing the check under an armed guard drops it back to observe", () => {
  const root = guarded([A.PIPED_INSTALLER], { mode: "armed" });
  fs.appendFileSync(path.join(root, ".jig", "checks", "piped-installer.check.mjs"),
    "\n// a teammate widened this\n");
  const emitted = JSON.parse(run(root, "PreToolUse", PIPE_CALL).stdout);
  assert.deepEqual(Object.keys(emitted), ["jig"]);
  assert.equal(emitted.jig.decision, "would-deny");
});

// The demotion the owner cannot see anywhere else: the config still reads
// `armed`, and every surface that only echoed `mode` reported an observing
// guard as though observe was what somebody asked for.
test("a guard demoted out of armed says so on stderr and records why on its row", () => {
  const root = guarded([A.PIPED_INSTALLER], { mode: "armed" });
  fs.appendFileSync(path.join(root, ".jig", "checks", "piped-installer.check.mjs"),
    "\n// a teammate widened this\n");
  const out = run(root, "PreToolUse", PIPE_CALL);
  assert.match(out.stderr, /g-piped-installer is armed in the config but ran as observe/);
  assert.match(out.stderr, /does not match the check on disk/);
  const row = ledger(root).at(-1);
  assert.equal(row.mode, "observe");
  assert.match(row.demoted, /does not match the check on disk/);
});

test("a guard nobody armed is not reported as demoted", () => {
  const root = guarded([A.PIPED_INSTALLER], { mode: "observe" });
  const out = run(root, "PreToolUse", PIPE_CALL);
  assert.equal(/ran as observe/.test(out.stderr), false);
  assert.equal(ledger(root).at(-1).demoted, null);
});

test("a standing false positive holds an armed guard in observe until it is cleared", () => {
  const root = guarded([A.PIPED_INSTALLER], { mode: "armed" });
  const file = path.join(root, ".jig", "ledger.jsonl");
  fs.writeFileSync(file, JSON.stringify({ guardId: "g-piped-installer", decision: "false-positive" }) + "\n");
  assert.equal(JSON.parse(run(root, "PreToolUse", PIPE_CALL).stdout).jig.decision, "would-deny");

  fs.appendFileSync(file, JSON.stringify({ guardId: "g-piped-installer", decision: "false-positive-cleared" }) + "\n");
  assert.equal(JSON.parse(run(root, "PreToolUse", PIPE_CALL).stdout).jig.decision, "deny");
});

test("an observe zone holds an armed edit guard to a ledger line for the paths it names", () => {
  const root = guarded([A.EMPTY_CATCH], { mode: "armed", config: { zones: { observe: ["src/**"] } } });
  const call = (file) => JSON.parse(run(root, "PostToolUse",
    edit(file, "risky();", "try { risky(); } catch {}")).stdout);
  assert.equal(call("src/deep/a.js").jig.decision, "would-deny");
  assert.equal(call("bin/a.js").jig.decision, "deny");
});

test("a check shipping an incomplete deny triple can never arm, whatever the config says", () => {
  const half = A.authored({
    ...A.PIPED_INSTALLER,
    id: "half-deny",
    title: A.PIPED_INSTALLER.title,
    detectors: A.PIPED_INSTALLER.detectors,
    fixtures: A.PIPED_INSTALLER.fixtures,
    deny: { reason: "no alternative and no override here" },
  });
  const root = guarded([half], { mode: "armed" });
  const emitted = JSON.parse(run(root, "PreToolUse", PIPE_CALL).stdout);
  assert.deepEqual(Object.keys(emitted), ["jig"]);
  assert.equal(emitted.jig.decision, "would-deny");
});

// ---------------------------------------------------------------------------
// A pattern that will not compile
//
// Containment, one guard wide. An uncompilable pattern used to throw out of the
// guard loop and reach the runner's own catch, which fails the whole call open:
// every guard queued behind the bad one was skipped, armed ones included, and
// the only trace was a single line about the runner. The pattern is skipped
// now, its own guard says so and records it, and the rest of the event runs.

test("a bash pattern that will not compile is skipped and the armed guard behind it still denies", () => {
  const root = guarded([BAD_BASH_PATTERN, A.PIPED_INSTALLER], { mode: "armed" });
  const out = run(root, "PreToolUse", PIPE_CALL);
  assert.equal(out.status, 0);
  const emitted = JSON.parse(out.stdout);
  assert.equal(emitted.jig.decision, "deny", "the healthy armed guard behind the bad pattern never ran");
  assert.equal(emitted.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(emitted.jig.guards.length, 2);
  assert.match(out.stderr, /g-bad-bash-pattern skipped a pattern that will not compile/);
  assert.equal(/runner failed open/.test(out.stderr), false, "the throw reached the runner");
  const rows = ledger(root);
  const bad = rows.find((r) => r.guardId === "g-bad-bash-pattern");
  assert.equal(bad.decision, "pass");
  assert.deepEqual(bad.patternsFailed, ["("], "the guard did not record which pattern it could not run");
  assert.equal(rows.find((r) => r.guardId === "g-piped-installer").decision, "deny");
});

test("an edit pattern that will not compile is contained the same way", () => {
  const root = guarded([BAD_EDIT_PATTERN, A.EMPTY_CATCH], { mode: "armed" });
  const out = run(root, "PostToolUse", write("a.js", "try { risky(); } catch {}"));
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).jig.decision, "deny");
  const bad = ledger(root).find((r) => r.guardId === "g-bad-edit-pattern");
  assert.deepEqual(bad.patternsFailed, ["("]);
});

test("a guard whose every pattern compiles records none as failed", () => {
  const root = guarded([A.PIPED_INSTALLER], { mode: "armed" });
  run(root, "PreToolUse", PIPE_CALL);
  assert.equal(ledger(root)[0].patternsFailed, null);
});

// ---------------------------------------------------------------------------
// The removal kind's session half (2.11.0 / N11)
//
// `removed` reads a count going down between the text an edit replaced and the
// text it wrote. An Edit carries both; a Write carries only the second, and the
// miss that follows is disclosed rather than worked around.

const REMOVAL_DET = A.TESTS_DELETED.detectors[0].params;
const REMOVAL = { lever: "edit-guard", runner: "PreToolUse", params: REMOVAL_DET };
const fired = (payload) => {
  const hit = lib.evaluateGuard([REMOVAL], payload, {}, [], payload.tool_input.file_path);
  return hit ? hit.matched : null;
};

test("an edit that deletes a test case fires the removal detector", () => {
  assert.equal(fired(edit("src/a.test.js", "it('a', () => {});\nit('b', () => {});\n", "it('a', () => {});\n")),
    A.TEST_COUNT_PATTERN);
});

test("an edit that deletes the case outright fires it too", () => {
  // `new_string: ""` is the shape a deleted test actually arrives in, and it is
  // the payload the pattern kind returns null on.
  assert.equal(fired(edit("src/a.test.js", "it('b', () => {});\n", "")), A.TEST_COUNT_PATTERN);
});

test("an edit that rewrites a test body without dropping one is silent", () => {
  assert.equal(fired(edit("src/a.test.js", "it('a', () => {});\n",
    "it('a', () => { expect(1).toBe(1); });\n")), null);
});

test("a case deleted out of a comment is not a removal", () => {
  // With the control beside it, because "returns null" is also what a removal
  // branch that does not exist returns.
  assert.equal(fired(edit("src/a.test.js", "it('b', () => {});\n", "")), A.TEST_COUNT_PATTERN);
  assert.equal(fired(edit("src/a.test.js", "// it('b', () => {});\n", "")), null);
});

test("a Write payload can never fire a removal detector, which is the disclosed limit", () => {
  // A Write carries no prior text, so a whole-file rewrite that drops half the
  // suite is invisible here. It is also why a removal lever cannot be proven in
  // the session lane: admission builds exactly this payload.
  assert.equal(fired(write("src/a.test.js", "it('a', () => {});\n")), null);
  assert.equal(lib.evalSessionDetector(REMOVAL, "it('a', () => {});\nit('b', () => {});\n"), false);
});

test("a removal detector still honours the paths that scope it", () => {
  const scoped = { lever: "edit-guard", runner: "PreToolUse",
    params: { ...REMOVAL_DET, paths: ["src/**/*.test.js"] } };
  const deletion = (file) => edit(file, "it('a', () => {});\nit('b', () => {});\n", "it('a', () => {});\n");
  // In scope first: without the control, "null" is what a removal that never
  // ran returns and the path scoping is never exercised at all.
  const hit = lib.evaluateGuard([scoped], deletion("src/a.test.js"), {}, [], "src/a.test.js");
  assert.equal(hit && hit.matched, A.TEST_COUNT_PATTERN);
  assert.equal(lib.evaluateGuard([scoped], deletion("docs/a.test.js"), {}, [], "docs/a.test.js"), null);
});

// 2.11.0 / N11, the other half. A removal detector names no `patterns`, and
// `sessionDetectors` used to require some — so a check that admitted on its
// fenced pair was filtered out before it was ever evaluated, and the class was
// watched by nothing anywhere.
const TESTS_DELETED_SESSION = A.authored({
  id: "tests-deleted-session",
  title: "Fewer test cases after the edit than before it",
  detectors: [
    { lever: "edit-guard", actor: "claude-session", confidence: "heuristic",
      params: { paths: ["**/*.test.js"], removed: [A.TEST_COUNT_PATTERN] } },
  ],
  fixtures: {
    violation: "it('a', () => {});\nit('b', () => {});\n--- after\nit('a', () => {});\n",
    nearMiss: "it('a', () => {});\n--- after\nit('a', () => { expect(1).toBe(1); });\n",
  },
  deny: A.TESTS_DELETED.deny,
});

test("a removal-only session guard is dispatched, and denies the deletion at PreToolUse", () => {
  const dets = TESTS_DELETED_SESSION.detectors.map((d) => ({ ...d, runner: "PreToolUse" }));
  assert.equal(lib.sessionDetectors({ detectors: dets }, "PreToolUse", "Edit").length, 1,
    "a detector with no `patterns` was filtered out before it could guard");

  const root = guarded([TESTS_DELETED_SESSION], { mode: "armed" });
  const out = JSON.parse(run(root, "PreToolUse",
    edit("a.test.js", "it('a', () => {});\nit('b', () => {});\n", "it('a', () => {});\n")).stdout);
  assert.equal(out.jig.decision, "deny");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  const clean = JSON.parse(run(root, "PreToolUse",
    edit("a.test.js", "it('a', () => {});\n", "it('a', () => { expect(1).toBe(1); });\n")).stdout);
  assert.equal(clean.jig.decision, "pass");
});

test("a session guard on a lever this build does not run is reported, never silently skipped", () => {
  // The narrowing `continue` that keeps a bash guard quiet on an Edit call also
  // swallowed this: an unknown lever reads no tool, so it was dropped by the
  // tool-narrowed pass AND matched by the tool-less one, and the guard stopped
  // evaluating with no warning, no ledger row and no `problem` on /jig:review.
  const root = tmpRoot();
  const dir = path.join(root, ".jig", "checks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "unknown-lever.check.mjs"),
    A.EMPTY_CATCH.module.split('"edit-observe-guard"').join('"edit-guard-v2"'));
  configure(root, { schemaVersion: 1, guards: [{
    id: "g-unknown-lever", check: "unknown-lever", classId: "empty-catch",
    runner: "PostToolUse", provenance: "elicited",
  }] });
  const out = run(root, "PostToolUse", edit("a.js", "risky();", "try { risky(); } catch {}"));
  assert.match(out.stderr, /g-unknown-lever is not running — the installed check `unknown-lever` declares no PostToolUse detector/);
  const emitted = JSON.parse(out.stdout);
  assert.deepEqual(emitted.jig.guards.map((g) => g.guardId), ["g-unknown-lever"]);
  assert.equal(ledger(root)[0].check, "unusable");
});

// DERAIL-PASS: the deny reply is three authored sentences printed as one string,
// and an author who ended a clause without a stop had it run straight into the
// next label.
test("every part of a deny reply is closed before the next one starts", () => {
  const text = lib.denyText("g-empty-catch", A.DENY_CATCH, false);
  assert.ok(text.includes(A.DENY_CATCH.alternative + ". To override:"),
    "the alternative ran into the override with no sentence break: " + text);
  assert.ok(text.includes(A.DENY_CATCH.reason + " Instead:"));
  // Already closed stays closed once, never twice.
  assert.equal(text.includes(".."), false, text);
  const taught = lib.teachText("g-empty-catch", A.DENY_CATCH);
  assert.ok(taught.endsWith(A.DENY_CATCH.override + "."));
  assert.equal(taught.includes(".."), false, taught);
});

// ---------------------------------------------------------------------------
// Proof of verification (N9)
//
// The headline gap of both passes: a session that ran the tests and a session
// that only said it did left identical traces. Two halves that must not blur —
// the Bash witness events are EVIDENCE, and Stop is additionalContext only,
// because SCOPE's derail pass answers "May the Stop hook exit 2" with a No.

const VERIFY_ENTRY = {
  id: "test-script", argv: ["npm", "test"], expectedExit: 0,
  paths: ["src/**/*.js"], lanes: ["ci", "commit"],
};

function verified(root, entries) {
  fs.mkdirSync(path.join(root, ".jig"), { recursive: true });
  fs.writeFileSync(path.join(root, ".jig", "verify.json"),
    JSON.stringify({ schemaVersion: 1, entries: entries || [VERIFY_ENTRY] }, null, 2));
  return root;
}

// A repository git can answer `status` for, which is what the Stop half reads.
function repo(root, dirty) {
  spawnSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
  for (const rel of dirty || []) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), "console.log(1);\n");
  }
  return root;
}

function ranBash(command, response) {
  return {
    session_id: "sess-1", tool_name: "Bash", tool_input: { command },
    ...(response === undefined ? {} : { tool_response: response }),
  };
}

test("a Bash call that ran a verify entry leaves a green row naming it", () => {
  const root = verified(guarded([]));
  const out = run(root, "PostToolUse", ranBash("npm test"));
  assert.equal(out.status, 0);
  assert.deepEqual(JSON.parse(out.stdout).jig.verify, { entry: "test-script", passed: true, exitCode: null });
  const rows = ledger(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, "verified");
  assert.equal(rows[0].verify, "test-script");
  assert.equal(rows[0].guardId, null, "a witness row is not a guard row");
});

test("the failure event is what makes a run red, not a code read off the payload", () => {
  const root = verified(guarded([]));
  run(root, "PostToolUseFailure", ranBash("npm test"));
  const rows = ledger(root);
  assert.equal(rows[0].decision, "verify-failed");
  assert.equal(rows[0].exitCode, null, "an exit code was recorded where the payload carried none");
});

test("an exit code is recorded only where the payload carries one", () => {
  const root = verified(guarded([]));
  run(root, "PostToolUseFailure", ranBash("npm test", { exit_code: 1 }));
  assert.equal(ledger(root)[0].exitCode, 1);
});

// The event is the documented signal, not the only one. A host that hands jig a
// failing command on PostToolUse — because something upstream swallowed the
// non-zero exit — would otherwise make every red run green, and `lastGreen`
// would name the run that failed.
test("a non-zero exit contradicts the event that carried it", () => {
  const root = verified(guarded([]));
  const out = run(root, "PostToolUse", ranBash("npm test", { exit_code: 1 }));
  assert.deepEqual(JSON.parse(out.stdout).jig.verify, { entry: "test-script", passed: false, exitCode: 1 });
  const row = ledger(root)[0];
  assert.equal(row.decision, "verify-failed", "a run that exited 1 was recorded green");
  assert.equal(row.exitCode, 1);
  assert.equal(lib.lastGreenRuns(lib.verifyRows(root)).size, 0, "a failed run became a green baseline");
});

test("a zero exit on the failure event is still a green run", () => {
  const root = verified(guarded([]));
  run(root, "PostToolUseFailure", ranBash("npm test", { exit_code: 0 }));
  assert.equal(ledger(root)[0].decision, "verified");
});

// The entry's own answer to what green means. A tool that catches by exiting
// non-zero has not failed when it does (SCOPE, "What counts as caught for a
// non-zero exit").
test("green is the entry's expectedExit, not the number zero", () => {
  const root = verified(guarded([]), [
    { id: "linter", argv: ["npm", "test"], expectedExit: 2, paths: [], lanes: ["ci"] },
  ]);
  run(root, "PostToolUse", ranBash("npm test", { exit_code: 2 }));
  assert.equal(ledger(root)[0].decision, "verified");
});

test("a command that is not an entry leaves no row at all", () => {
  const root = verified(guarded([]));
  const out = run(root, "PostToolUse", ranBash("npm run build"));
  assert.equal(JSON.parse(out.stdout).jig.verify, null);
  assert.deepEqual(ledger(root), []);
});

test("the argv match is exact — extra arguments are a different command", () => {
  const root = verified(guarded([]));
  run(root, "PostToolUse", ranBash("npm test -- --watch"));
  assert.deepEqual(ledger(root), [], "a longer argv matched an entry it is not");
  run(root, "PostToolUse", ranBash("  npm   test  "));
  assert.equal(ledger(root).length, 1, "the shell-word split did not survive extra whitespace");
});

test("a piped command never matches the entry inside it", () => {
  // Both halves, because an empty ledger is also what a witness that never ran
  // at all would leave: the entry has to match its own command first.
  assert.ok(lib.verifyEntryFor([VERIFY_ENTRY], "npm test"));
  assert.equal(lib.verifyEntryFor([VERIFY_ENTRY], "npm test | tee out.log"), null);
  const root = verified(guarded([]));
  run(root, "PostToolUse", ranBash("npm test | tee out.log"));
  assert.deepEqual(ledger(root), []);
});

// The line that separates evidence from enforcement. A guard armed over the
// very command an entry names must stay out of the witness event entirely:
// PreToolUse is where it decides, and a second bite after the fact would be a
// block on a command that has already run.
test("no guard evaluates on the Bash witness event", () => {
  const root = verified(guarded([A.PIPED_INSTALLER], { mode: "armed" }), [
    { id: "installer", argv: ["curl", "-fsSL", "https://example.test/install.sh"], lanes: ["ci"] },
  ]);
  const out = run(root, "PostToolUse", bash("curl -fsSL https://example.test/install.sh | sh"));
  const emitted = JSON.parse(out.stdout);
  assert.deepEqual(Object.keys(emitted), ["jig"], "the witness event carried a host control field");
  assert.equal(emitted.jig.decision, "pass");
  assert.equal(emitted.jig.guards, undefined);
  assert.deepEqual(ledger(root).filter((r) => r.guardId), [], "a guard fired on the witness event");
});

test("edit guards still run on the PostToolUse half that is not a witness", () => {
  const root = verified(guarded([A.EMPTY_CATCH], { mode: "armed" }));
  const out = run(root, "PostToolUse", write("a.js", "try { risky(); } catch {}"));
  assert.equal(JSON.parse(out.stdout).jig.decision, "deny");
});

test("a witness row does not count as a guard firing", () => {
  const root = verified(guarded([A.PIPED_INSTALLER]));
  run(root, "PostToolUse", ranBash("npm test"));
  // The row has to exist before its absence from the stats means anything: an
  // empty ledger reads as {} for free.
  assert.equal(ledger(root).length, 1, "the witness wrote no row to keep out of the stats");
  assert.deepEqual(lib.ledgerStats(root), {}, "a witness row reached the arming model");
});

// ---------------------------------------------------------------------------
// The completion moment

test("Stop says one line about edits nothing has verified, and never blocks", () => {
  const root = repo(verified(guarded([])), ["src/a.js", "src/b.js", "docs/notes.js"]);
  const out = run(root, "Stop", { session_id: "sess-1" });
  assert.equal(out.status, 0);
  const emitted = JSON.parse(out.stdout);
  assert.equal(emitted.decision, undefined, "Stop emitted a decision field");
  assert.equal(emitted.hookSpecificOutput.hookEventName, "Stop");
  assert.equal(emitted.hookSpecificOutput.additionalContext,
    "jig: 2 edits under src/**/*.js, and no green run of test-script is recorded.");
});

test("Stop names the last green run once there has been one", () => {
  const root = repo(verified(guarded([])), ["src/a.js"]);
  run(root, "PostToolUse", ranBash("npm test"));
  const line = JSON.parse(run(root, "Stop", { session_id: "sess-1" }).stdout)
    .hookSpecificOutput.additionalContext;
  assert.match(line, /^jig: 1 edit under src\/\*\*\/\*\.js since the last green run of test-script \(2\d{3}-/);
});

test("Stop stays silent when nothing in the entry's scope changed", () => {
  const root = repo(verified(guarded([])), ["docs/notes.js"]);
  const emitted = JSON.parse(run(root, "Stop", { session_id: "sess-1" }).stdout);
  assert.equal(emitted.hookSpecificOutput, undefined);
  assert.equal(emitted.jig.stale, null);
});

test("SubagentStop is the same additionalContext-only channel", () => {
  const root = repo(verified(guarded([])), ["src/a.js"]);
  const emitted = JSON.parse(run(root, "SubagentStop", { session_id: "sess-1" }).stdout);
  assert.equal(emitted.hookSpecificOutput.hookEventName, "SubagentStop");
  assert.equal(emitted.decision, undefined);
});

test("a Stop where git cannot answer fails open with a row and no line", () => {
  const root = verified(guarded([]));
  const out = run(root, "Stop", { session_id: "sess-1" });
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).hookSpecificOutput, undefined);
  assert.match(out.stderr, /no verification check at this stop/);
  assert.equal(ledger(root)[0].failedOpen, "git status could not be read here");
});

// A repository with no lane entries has nothing to verify and nothing to say.
// Before this returned early it paid a `git status` spawn and a whole-file
// ledger read on every single turn, and where git could not answer it left a
// stderr line and a row on every one of them — for the life of a repository
// whose ledger is never compacted.
test("a Stop with no lane entries spawns nothing and writes nothing", () => {
  const root = guarded([]);
  const out = run(root, "Stop", { session_id: "sess-1" });
  assert.equal(out.status, 0);
  assert.deepEqual(JSON.parse(out.stdout), { jig: { event: "Stop", decision: "pass", stale: null } });
  assert.equal(out.stderr, "", "a repository with nothing to verify failed open out loud");
  assert.deepEqual(ledger(root), [], "a stop with nothing to check left a row anyway");
});

// `verified` is an older decision than this feature: `apply` writes selftest
// rows under it. Only the `verify` string separates the two, so the separation
// is asserted rather than left to a field-presence convention.
test("an apply-time selftest row is not a green verification run", () => {
  const root = verified(guarded([]));
  lib.appendLedger(root, {
    session: "jig-selftest", actor: "jig", guardId: null, classId: null, mode: null,
    decision: "verified", tool: "check-driver",
  });
  assert.deepEqual(lib.verifyRows(root), []);
  assert.equal(lib.lastGreenRuns(lib.verifyRows(root)).size, 0);
});

// ---------------------------------------------------------------------------
// staleVerification, as a truth table

test("staleVerification reads the newest green row, not the last one written", () => {
  const rows = [
    { verify: "t", decision: "verified", ts: "2026-09-02T10:00:00.000Z" },
    { verify: "t", decision: "verified", ts: "2026-09-01T10:00:00.000Z" },
    { verify: "t", decision: "verify-failed", ts: "2026-09-03T10:00:00.000Z" },
  ];
  const line = lib.staleVerification(rows, [{ id: "t", paths: ["src/**"] }], ["src/a.js"]);
  assert.match(line, /since the last green run of t \(2026-09-02T10:00:00\.000Z\)\.$/);
});

test("an entry with no paths speaks for the whole repository", () => {
  assert.equal(lib.staleVerification([], [{ id: "t", paths: [] }], ["anywhere.txt"]),
    "jig: 1 edit under this repository, and no green run of t is recorded.");
});

test("staleVerification says nothing when the working tree is clean", () => {
  assert.equal(lib.staleVerification([], [{ id: "t", paths: ["src/**"] }], []), null);
});

test("a renamed path is read from its destination", () => {
  assert.equal(lib.porcelainPath('R  "old name.js" -> src/new.js'), "src/new.js");
  assert.equal(lib.porcelainPath(" M src/a.js"), "src/a.js");
});

// ---------------------------------------------------------------------------
// The hook/engine boundary

// A hook spawns on every tool call, and 2.10.0's witness doubled how often.
// `jig-lib.js` used to require `scripts/jig.js` at top level, so each of those
// spawns parsed the whole engine to read a schema number, a directory name and
// two pure helpers — all of which now live in `scripts/vocab.js`. The boundary
// is worth opening once, so this holds it open: nothing `jig-lib.js` pulls in
// may reach the engine at load time, transitively included.
test("loading jig-lib does not load the engine", () => {
  const engine = JSON.stringify(path.join(__dirname, "..", "scripts", "jig.js"));
  const probe =
    "require(" + JSON.stringify(path.join(HOOKS_DIR, "jig-lib.js")) + ");" +
    "console.log(Object.keys(require.cache).filter((k) => k === require.resolve(" + engine + ")).join());";
  const res = spawnSync(process.execPath, ["-e", probe], { encoding: "utf-8" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), "",
    "hooks/jig-lib.js reaches scripts/jig.js at require time again — every hook spawn " +
    "now parses the whole engine. Move what it needs into scripts/vocab.js instead.");
});
