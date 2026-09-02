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
    const runner = check.detectors[0].lever === "bash-guard" ? "PreToolUse" : "PostToolUse";
    return {
      id: "g-" + check.id,
      check: check.id,
      classId: check.id,
      runner,
      provenance: o.provenance === undefined ? "elicited" : o.provenance,
      ...(o.mode ? { mode: o.mode } : {}),
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
  assert.deepEqual(Object.keys(wiring.hooks).sort(), ["PostToolUse", "PreToolUse"]);
  const expected = { PreToolUse: "Bash", PostToolUse: "Edit|Write" };
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
