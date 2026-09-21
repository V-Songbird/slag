"use strict";

// The session evidence script on synthetic transcripts built in temp
// directories: both hosts' record shapes, and the CLI through its real entry
// point. No real transcript is a fixture; one holds machine paths and secrets.

const { test, describe, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { analyzeClaude, analyzeCodex, detectHost, redact } = require("../scripts/session-evidence.js");

const CLI = path.join(__dirname, "..", "scripts", "session-evidence.js");
const SESSION = "0a1b2c3d-0000-4000-8000-00000000abcd";

const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anneal-session-"));
  created.push(dir);
  return dir;
}

// Rows become one JSON line each; `tail` is appended raw, for a half-written record.
function transcript(rows, { tail = "", name = `${SESSION}.jsonl`, dir = tempDir() } = {}) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join("") + tail);
  return file;
}

const at = (second) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;

// Claude Code record shapes.
const human = (text, second) => ({
  type: "user", origin: { kind: "human" }, timestamp: at(second), sessionId: SESSION, cwd: "/work/shop", version: "2.1.0",
  message: { role: "user", content: text },
});
const use = (id, name, input, second) => ({
  type: "assistant", timestamp: at(second),
  message: { id: `msg-${id}`, model: "model-x", content: [{ type: "tool_use", id, name, input }] },
});
const result = (id, text, second, error = false) => ({
  type: "user", timestamp: at(second),
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: [{ type: "text", text }] }] },
});

// Codex record shapes.
const meta = { timestamp: at(0), type: "session_meta", payload: { id: "thread-1", cwd: "/work/shop" } };
const started = (second) => ({ timestamp: at(second), type: "event_msg", payload: { type: "task_started" } });
const turn = (second) => ({ timestamp: at(second), type: "turn_context", payload: { cwd: "/work/shop", model: "model-y", effort: "medium" } });
const call = (id, input, second) => ({
  timestamp: at(second), type: "response_item", payload: { type: "custom_tool_call", call_id: id, name: "exec", input },
});
const output = (id, texts, second) => ({
  timestamp: at(second), type: "response_item",
  payload: { type: "custom_tool_call_output", call_id: id, output: texts.map((text) => ({ type: "input_text", text })) },
});

describe("a Claude Code transcript", () => {
  test("the latest human prompt is the cutoff, so the audit's own turn is left out", () => {
    const report = analyzeClaude(transcript([
      human("fix the cart total", 1),
      use("t1", "Bash", { command: "npm test" }, 2),
      result("t1", "Exit code 1\n1 failing", 3, true),
      human("audit this session", 4),
      use("t2", "Bash", { command: "npm test" }, 5),
      result("t2", "Exit code 1\nstill failing", 6, true),
    ]));
    assert.strictEqual(report.boundary.mode, "before-latest-human-prompt");
    assert.strictEqual(report.boundary.line, 4);
    assert.strictEqual(report.recordsSelected, 3);
    assert.deepStrictEqual(report.candidateCounts, { "nonzero-exit": 1 });
    assert.strictEqual(report.sessionId, SESSION);
    assert.deepStrictEqual(report.context, { cwd: "/work/shop", version: "2.1.0", model: "model-x" });
  });

  test("an older transcript has no origin tag, and the cutoff is the last prompt that is not injected", () => {
    const old = (text, second, isMeta) => ({ type: "user", isMeta, timestamp: at(second), message: { content: text } });
    const report = analyzeClaude(transcript([
      old("fix the cart total", 1, false),
      use("t1", "Bash", { command: "npm test" }, 2),
      result("t1", "ok", 3),
      old("audit this session", 4, false),
      old("<injected reminder>", 5, true),
    ]));
    assert.strictEqual(report.boundary.line, 4);
  });

  test("a reported error carries its call, its exit code and the same tool's later success", () => {
    const report = analyzeClaude(transcript([
      human("run the suite", 1),
      use("t1", "Bash", { command: "npm tset" }, 2),
      result("t1", "Exit code 127\nbash: npm tset: command not found", 3, true),
      use("t2", "Read", { file_path: "package.json" }, 4),
      result("t2", "{}", 5),
      use("t3", "Bash", { command: "npm test" }, 6),
      result("t3", "# pass 4", 7),
      human("audit", 8),
    ]));
    assert.strictEqual(report.candidates.length, 1);
    const [failure] = report.candidates;
    assert.strictEqual(failure.category, "command-not-found");
    assert.strictEqual(failure.evidenceBasis, "reported-error");
    assert.strictEqual(failure.exitCode, 127);
    assert.strictEqual(failure.tool, "Bash");
    assert.strictEqual(failure.callLine, 2);
    assert.strictEqual(failure.commandOrArguments, "npm tset");
    assert.deepStrictEqual(failure.laterSameToolSuccesses.map((s) => s.commandOrArguments), ["npm test"]);
  });

  test("error text inside a file that was read is not a candidate, and inside shell output it is", () => {
    const report = analyzeClaude(transcript([
      human("look around", 1),
      use("t1", "Read", { file_path: "notes.md" }, 2),
      result("t1", "yesterday: bash: foo: command not found", 3),
      use("t2", "Bash", { command: "foo || true" }, 4),
      result("t2", "bash: foo: command not found", 5),
      human("audit", 6),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.tool, c.evidenceBasis]), [["Bash", "diagnostic-text-match-only"]]);
  });

  test("a host's own error text names the category", () => {
    const report = analyzeClaude(transcript([
      human("edit it", 1),
      use("t1", "Edit", { file_path: "a.js", old_string: "x", new_string: "y" }, 2),
      result("t1", "<tool_use_error>String to replace not found in file.</tool_use_error>", 3, true),
      use("t2", "Frob", {}, 4),
      result("t2", "<tool_use_error>something else</tool_use_error>", 5, true),
      human("audit", 6),
    ]));
    assert.deepStrictEqual(report.candidateCounts, { "edit-no-match": 1, "tool-use-error": 1 });
  });

  test("--before selects by time, and a record without a timestamp is skipped out loud", () => {
    const untimed = { type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } };
    const report = analyzeClaude(transcript([
      human("first", 1),
      use("t1", "Bash", { command: "false" }, 2),
      result("t1", "Exit code 1", 3, true),
      untimed,
      use("t2", "Bash", { command: "false" }, 8),
      result("t2", "Exit code 1", 9, true),
    ]), new Date(at(5)));
    assert.strictEqual(report.boundary.mode, "explicit-time");
    assert.strictEqual(report.boundary.line, null);
    assert.strictEqual(report.recordsSelected, 3);
    assert.deepStrictEqual(report.candidateCounts, { "nonzero-exit": 1 });
    assert.match(report.warnings.join("\n"), /without a usable timestamp/);
  });

  test("the limit bounds what is shown, never what is counted", () => {
    const rows = [human("loop", 1)];
    for (let i = 0; i < 4; i++) {
      rows.push(use(`t${i}`, "Bash", { command: `step ${i}` }, 2), result(`t${i}`, "Exit code 1", 3, true));
    }
    rows.push(human("audit", 4));
    const report = analyzeClaude(transcript(rows), null, 2);
    assert.deepStrictEqual(report.candidateCounts, { "nonzero-exit": 4 });
    assert.deepStrictEqual(report.candidates.map((c) => c.commandOrArguments), ["step 2", "step 3"]);
    assert.match(report.warnings.join("\n"), /Only the last 2 candidates/);
  });

  test("the three largest tool outputs are reported by size, not by content", () => {
    const rows = [human("read", 1)];
    [10, 4000, 300, 20000].forEach((size, i) => {
      rows.push(use(`t${i}`, "Read", { file_path: `f${i}` }, 2), result(`t${i}`, "x".repeat(size), 3));
    });
    rows.push(human("audit", 4));
    const report = analyzeClaude(transcript(rows));
    assert.deepStrictEqual(report.largestToolTexts.map((entry) => entry.characters), [20000, 4000, 300]);
    assert.ok(!JSON.stringify(report.largestToolTexts).includes("xxx"));
  });

  test("a half-written last record is dropped, and a broken one in the middle stops the audit", () => {
    const rows = [human("go", 1), use("t1", "Bash", { command: "ls" }, 2), result("t1", "a.js", 3), human("audit", 4)];
    const report = analyzeClaude(transcript(rows, { tail: '{"type":"assist' }));
    assert.match(report.warnings.join("\n"), /incomplete trailing record/);
    assert.strictEqual(report.recordsSelected, 3);

    const broken = transcript(rows, { tail: "{not json}\n" });
    assert.throws(() => analyzeClaude(broken), /Invalid JSON record at line 5/);
  });

  test("a transcript with no human prompt asks for --before instead of guessing", () => {
    const file = transcript([use("t1", "Bash", { command: "ls" }, 1), result("t1", "a.js", 2)]);
    assert.throws(() => analyzeClaude(file), /No human prompt boundary found\. Supply --before/);
  });

  test("subagent transcripts are listed beside the session and never read", () => {
    const dir = tempDir();
    const file = transcript([human("go", 1), human("audit", 2)], { dir });
    const folder = path.join(dir, SESSION, "subagents");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "agent-1.jsonl"), "{not json, and never parsed}\n");
    fs.writeFileSync(path.join(folder, "agent-1.meta.json"), JSON.stringify({ agentType: "Explore", description: "find the cart" }));
    const report = analyzeClaude(file);
    assert.deepStrictEqual(report.subagentTranscripts, [
      { file: path.join(folder, "agent-1.jsonl"), agentType: "Explore", description: "find the cart" },
    ]);
  });
});

describe("a Codex rollout", () => {
  test("the latest task start is the cutoff, and a code-mode result carries its own exit code", () => {
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1),
      call("c1", "npm test", 2),
      output("c1", ["Script completed\nOutput:\n", '{"exit_code":1,"output":"1 failing\\n"}'], 3),
      call("c2", "npm test", 4),
      output("c2", ['{"exit_code":0,"output":"# pass 4\\n"}'], 5),
      started(6),
      call("c3", "npm test", 7),
      output("c3", ['{"exit_code":1,"output":"after the cutoff"}'], 8),
    ]));
    assert.strictEqual(report.boundary.mode, "before-latest-task-start");
    assert.strictEqual(report.boundary.line, 8);
    assert.strictEqual(report.sessionId, "thread-1");
    assert.deepStrictEqual(report.context, { cwd: "/work/shop", model: "model-y", effort: "medium" });
    assert.deepStrictEqual(report.candidateCounts, { "nonzero-exit": 1 });
    const [failure] = report.candidates;
    assert.strictEqual(failure.evidenceBasis, "reported-nonzero-exit");
    assert.strictEqual(failure.exitCode, 1);
    assert.strictEqual(failure.tool, "exec");
    assert.strictEqual(failure.diagnosticCandidate, "1 failing\n");
    assert.deepStrictEqual(failure.nearbyReportedSuccesses.map((s) => s.line), [7]);
  });

  test("a result object is read where it starts, whatever is printed after it or however it is wrapped", () => {
    const pretty = JSON.stringify({ exit_code: 2, output: "a brace } in a string" }, null, 2);
    const report = analyzeCodex(transcript([
      meta, started(1),
      call("c1", "build", 2),
      output("c1", [`${pretty} trailing text\n  {"exit_code":3,"output":"second"}`], 3),
      started(4),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.exitCode, c.diagnosticCandidate]), [
      [2, "a brace } in a string"],
      [3, "second"],
    ]);
  });

  test("a failed script and a plain exit line are both read", () => {
    const report = analyzeCodex(transcript([
      meta, started(1),
      call("c1", "write README.md", 2),
      output("c1", ["Script failed\nWall time 0.3 seconds\nOutput:\n", "Script error:\nCommand blocked by a hook"], 3),
      { timestamp: at(4), type: "response_item", payload: { type: "function_call", call_id: "c2", name: "shell", arguments: '{"command":"make"}' } },
      { timestamp: at(5), type: "response_item", payload: { type: "function_call_output", call_id: "c2", output: "Process exited with code 2\nmake: *** no rule" } },
      started(6),
    ]));
    assert.deepStrictEqual(report.candidateCounts, { "tool-script-failure": 2, "nonzero-exit": 1 });
    assert.strictEqual(report.candidates[2].tool, "shell");
    assert.strictEqual(report.candidates[2].commandOrArguments, '{"command":"make"}');
  });

  test("a rollout with no task start asks for --before instead of guessing", () => {
    assert.throws(() => analyzeCodex(transcript([meta, call("c1", "ls", 1)])), /No task_started boundary found/);
  });
});

describe("redaction", () => {
  test("credentials in a command or an output never reach an excerpt", () => {
    const report = analyzeClaude(transcript([
      human("deploy", 1),
      use("t1", "Bash", { command: "curl -H 'Authorization: Bearer abc.def.ghi' https://user:hunter2@example.invalid --token s3cr3t" }, 2),
      result("t1", "Exit code 1\nAPI_KEY=sk-abcdefghijklmnop1234 rejected\nSet-Cookie: session=abc123", 3, true),
      human("audit", 4),
    ]));
    const shown = JSON.stringify(report.candidates);
    for (const secret of ["abc.def.ghi", "hunter2", "s3cr3t", "sk-abcdefghijklmnop1234", "session=abc123"]) {
      assert.ok(!shown.includes(secret), `${secret} leaked`);
    }
    assert.match(shown, /\[REDACTED\]/);
  });

  test("the home directory is shortened however it is spelled", () => {
    const home = os.homedir();
    const spellings = [home, home.replace(/\\/g, "/"), JSON.stringify(home).slice(1, -1)];
    for (const spelled of spellings) assert.strictEqual(redact(`cd ${spelled}/work`), "cd ~/work");
  });
});

describe("the command line", () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "", ...env },
  });

  test("a transcript handed over by path says which host wrote it", () => {
    const claude = transcript([human("go", 1), human("audit", 2)]);
    const codex = transcript([meta, started(1), started(2)]);
    assert.strictEqual(detectHost(claude), "claude");
    assert.strictEqual(detectHost(codex), "codex");
    const done = run(["--session-file", codex]);
    assert.strictEqual(done.status, 0, done.stderr);
    assert.strictEqual(JSON.parse(done.stdout).host, "codex");
  });

  test("a session id finds exactly one transcript under the host's home, and nothing else is a guess", () => {
    const home = tempDir();
    const file = transcript([human("go", 1), human("audit", 2)], { dir: path.join(home, "projects", "shop") });
    const found = run(["--claude-home", home], { CLAUDE_CODE_SESSION_ID: SESSION });
    assert.strictEqual(found.status, 0, found.stderr);
    assert.strictEqual(JSON.parse(found.stdout).sessionFile, file);

    transcript([human("go", 1), human("audit", 2)], { dir: path.join(home, "projects", "copy") });
    const twice = run(["--claude-home", home], { CLAUDE_CODE_SESSION_ID: SESSION });
    assert.strictEqual(twice.status, 2);
    assert.match(twice.stderr, /expected one transcript for that session, found 2/);
  });

  test("a Codex thread id is found at any depth under sessions", () => {
    const home = tempDir();
    const file = transcript([meta, started(1), started(2)], {
      dir: path.join(home, "sessions", "2026", "01", "01"), name: `rollout-2026-01-01T00-00-00-${SESSION}.jsonl`,
    });
    const found = run(["--host", "codex", "--session-id", SESSION, "--codex-home", home]);
    assert.strictEqual(found.status, 0, found.stderr);
    assert.strictEqual(JSON.parse(found.stdout).sessionFile, file);
  });

  test("with no session variable and no file, it says what to supply", () => {
    const none = run([]);
    assert.strictEqual(none.status, 2);
    assert.match(none.stderr, /Supply --host or --session-file/);
  });

  test("a bad flag, a bad limit and a cutoff without a timezone are refused", () => {
    const file = transcript([human("go", 1), human("audit", 2)]);
    assert.strictEqual(run(["--nope", "x"]).status, 2);
    assert.strictEqual(run(["--session-file", file, "--limit", "31"]).status, 2);
    const naive = run(["--session-file", file, "--before", "2026-01-01T00:00:00"]);
    assert.strictEqual(naive.status, 1);
    assert.match(naive.stderr, /The cutoff must include a timezone/);
  });

  test("a transcript that does not parse exits 1 and prints no evidence", () => {
    const broken = transcript([human("go", 1)], { tail: "{not json}\n" });
    const done = run(["--session-file", broken]);
    assert.strictEqual(done.status, 1);
    assert.strictEqual(done.stdout, "");
    assert.match(done.stderr, /Invalid JSON record at line 2/);
  });
});
