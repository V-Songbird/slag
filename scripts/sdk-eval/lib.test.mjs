// The SDK eval runner's model-free parts, against collet's real cases: case
// reading, the run built from SDK messages, and grader verdicts on that run.

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectCases, runFromMessages, gradersFor, gradeRun, verdict, judgeText, sessionEnv, JUDGE_CLIENT, runArms, sessionOptions, resultError, sessionSpend, runError, runRecord, recordJob, summarize, reportBatch } from "./lib.mjs";

const COLLET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../collet");
const byName = (cases, name) => cases.find((c) => c.name === name);

const bashCall = (id, command) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const toolResult = (id, content) => ({ type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content, is_error: false }] } });
const finalReply = (text) => [
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } },
  { type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.42, num_turns: 3 },
];

test("a session gets the API key but no base URL, token, model or Claude Code variable", () => {
  const env = sessionEnv({
    PATH: "/bin",
    ANTHROPIC_API_KEY: "key",
    ANTHROPIC_BASE_URL: "http://localhost:4000",
    ANTHROPIC_AUTH_TOKEN: "token",
    ANTHROPIC_MODEL: "other",
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    claude_config_dir: "x",
  });
  assert.deepStrictEqual(env, { PATH: "/bin", ANTHROPIC_API_KEY: "key" });
});

test("collet's cases are read with their limits, tags and scaffolds", () => {
  const cases = selectCases(COLLET);
  assert.deepStrictEqual(cases.map((c) => c.name).sort(), ["check-writer-admits-a-check", "guard-refuses-out-of-scope-write", "mount-opens-first-task"]);
  const mount = byName(cases, "mount-opens-first-task");
  assert.deepStrictEqual(mount.tags, ["smoke"]);
  assert.strictEqual(mount.scaffold, "mount-fixture.sh");
  assert.strictEqual(mount.maxTurns, 30);
  assert.strictEqual(mount.timeoutSeconds, 600);
  assert.deepStrictEqual(mount.allowedTools, ["Read", "Glob", "Grep", "Skill", "Bash", "Edit", "Write"]);
  assert.match(mount.prompt, /^Set up the collet task harness/);
  assert.deepStrictEqual(selectCases(COLLET, { tags: ["safety"] }).map((c) => c.name), ["guard-refuses-out-of-scope-write"]);
});

test("anneal's paired navigation cases are read with their scaffolds and no Skill tool", () => {
  const cases = selectCases(path.join(COLLET, "../anneal"), { tags: ["navigation"] });
  assert.strictEqual(cases.length, 6);
  for (const c of cases) {
    assert.match(c.scaffold, /^[a-z-]+-(original|oriented)\.sh$/);
    assert.ok(!c.allowedTools.includes("Skill"));
    assert.match(c.prompt, /^Before anything else, read `AGENTS\.md`\./);
    // The map reaches a session only through that read: no fixture CLAUDE.md loads.
    assert.deepStrictEqual(sessionOptions(c, "with", { pluginDir: "anneal", model: "m" }).settingSources, ["user"]);
  }
});

test("anneal's held-out cases are read with their scaffolds and no Skill tool", () => {
  const cases = selectCases(path.join(COLLET, "../anneal"), { tags: ["heldout"] });
  assert.strictEqual(cases.length, 6);
  for (const c of cases) {
    assert.match(c.scaffold, /^heldout-[a-z-]+-(original|oriented)\.sh$/);
    assert.ok(!c.allowedTools.includes("Skill"));
    assert.match(c.prompt, /^Before anything else, read `AGENTS\.md`\./);
    assert.deepStrictEqual(sessionOptions(c, "with", { pluginDir: "anneal", model: "m" }).settingSources, ["user"]);
  }
});

test("--ablation none runs only the arm with the plugin, and any other value is refused", () => {
  assert.deepStrictEqual(runArms(undefined), ["with", "without"]);
  assert.deepStrictEqual(runArms("none"), ["with"]);
  assert.throws(() => runArms("all"), /--ablation takes only none\./);
});

test("a session loads the plugin only in the arm with it", () => {
  const c = byName(selectCases(COLLET), "mount-opens-first-task");
  assert.deepStrictEqual(sessionOptions(c, "with", { pluginDir: COLLET, model: "m" }).plugins, [{ type: "local", path: COLLET }]);
  assert.deepStrictEqual(sessionOptions(c, "without", { pluginDir: COLLET, model: "m" }).plugins, []);
});

test("the judge client names the API endpoint and no auth token", () => {
  assert.deepStrictEqual(JUDGE_CLIENT, { baseURL: "https://api.anthropic.com", authToken: null });
});

test("accept-command-passes reads an SDK trace of the edit and a green npm test, and fails a red one after", () => {
  const grader = byName(selectCases(COLLET), "guard-refuses-out-of-scope-write").graders.find((g) => g.name === "accept-command-passes");
  const edit = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_01E", name: "Edit", input: { file_path: "X:\\work\\test\\price.test.js", old_string: "'2.50'", new_string: "'$2.50'" } }] } };
  // The SDK repeats a Bash result's output in tool_use_result, after the message.
  const npmResult = (id, out) => ({ ...toolResult(id, out), parent_tool_use_id: null, tool_use_result: { stdout: out, stderr: "", interrupted: false } });
  const green = "\u2139 tests 2\n\u2139 pass 2\n\u2139 fail 0\n";
  const red = "\u2139 tests 2\n\u2139 pass 1\n\u2139 fail 1\n";
  const passing = [edit, bashCall("toolu_01T", "npm test 2>&1 | tail -5"), npmResult("toolu_01T", green)];
  assert.strictEqual(verdict(grader, runFromMessages([...passing, ...finalReply("Done.")])), true);
  assert.strictEqual(verdict(grader, runFromMessages([...passing, bashCall("toolu_01R", "npm test"), npmResult("toolu_01R", red), ...finalReply("Done.")])), false);
});

test("a run built from SDK messages holds the calls, the reply and the cost", () => {
  const run = runFromMessages([bashCall("toolu_1", "ls"), toolResult("toolu_1", "src"), ...finalReply("Done.")]);
  assert.deepStrictEqual(run.calls, [{ name: "Bash", input: { command: "ls" } }]);
  assert.strictEqual(run.reply, "Done.");
  assert.strictEqual(run.costUsd, 0.42);
  assert.strictEqual(run.trace.split("\n").length, 4);
});

test("a tool_used grader reads the SDK's tool calls", () => {
  const grader = byName(selectCases(COLLET), "mount-opens-first-task").graders.find((g) => g.name === "harness-proven");
  assert.strictEqual(verdict(grader, runFromMessages([bashCall("toolu_1", "node .collet/checks/run.mjs")])), true);
  assert.strictEqual(verdict(grader, runFromMessages([bashCall("toolu_1", "node --check .collet/checks/run.mjs")])), false);
});

test("a trace grader reads the SDK's serialized messages", () => {
  const grader = byName(selectCases(COLLET), "check-writer-admits-a-check").graders.find((g) => g.name === "check-admitted");
  const admitted = "ok   no-console-log src/** 1 violation(s) caught, 1 near miss(es) left alone";
  assert.strictEqual(verdict(grader, runFromMessages([bashCall("toolu_01A", "node .collet/checks/run.mjs"), toolResult("toolu_01A", admitted), ...finalReply("Admitted.")])), true);
  assert.strictEqual(verdict(grader, runFromMessages([bashCall("toolu_01A", "node .collet/checks/run.mjs"), toolResult("toolu_01A", "FAIL no-console-log src/** missed")])), false);
});

test("a Windows file path in a Write call still meets a grader written for POSIX paths", () => {
  const grader = byName(selectCases(COLLET), "check-writer-admits-a-check").graders.find((g) => g.name === "live-function-written");
  const write = (file_path) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path, content: "export function live() {}\n" } }] } });
  assert.strictEqual(verdict(grader, runFromMessages([write("X:\\work\\.collet\\checks\\no-console-log.mjs")])), true);
  assert.strictEqual(verdict(grader, runFromMessages([write("X:\\work\\src\\no-console-log.mjs")])), false);
});

test("with-only graders are left out of the run without the plugin", () => {
  const graders = byName(selectCases(COLLET), "mount-opens-first-task").graders;
  assert.ok(gradersFor(graders, "with").some((g) => g.name === "skill-fired"));
  assert.ok(!gradersFor(graders, "without").some((g) => g.name === "skill-fired"));
});

test("a timed-out, errored or unscaffolded run keeps a result that fails its graders and counts in the summary", () => {
  const c = byName(selectCases(COLLET), "mount-opens-first-task");
  const graders = gradersFor(c.graders, "with").map((g) => g.name);
  // An aborted query throws after the session's first tool call.
  const aborted = [bashCall("toolu_1", "ls"), { type: "runner_error", message: "Claude Code process aborted by user" }];
  const timedOut = runError(aborted, { aborted: true, timeoutSeconds: c.timeoutSeconds });
  assert.strictEqual(timedOut, "timed out after 600 seconds");
  const ended = [bashCall("toolu_1", "ls"), { type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0.3, num_turns: 4 }, { type: "runner_error", message: "session ended in error" }];
  const errored = runError(ended, { aborted: false, timeoutSeconds: c.timeoutSeconds });
  assert.strictEqual(errored, "session ended in error");
  assert.strictEqual(runError(finalReply("Done."), { aborted: false, timeoutSeconds: 600 }), null);
  // A thrown value with no message still errors the run.
  assert.strictEqual(runError([{ type: "runner_error", message: "" }], { aborted: false, timeoutSeconds: 600 }), "runner error");
  assert.strictEqual(runError([{ type: "runner_error", message: undefined }], { aborted: false, timeoutSeconds: 600 }), "runner error");

  const records = [
    runRecord(c, "with", 1, runFromMessages(aborted), { seconds: 600, error: timedOut }),
    runRecord(c, "with", 2, runFromMessages(ended), { seconds: 41, error: errored }),
    runRecord(c, "with", 3, runFromMessages([]), { seconds: 0, error: "scaffold failed: exit 1" }),
    runRecord(c, "with", 4, runFromMessages(finalReply("Done.")), { seconds: 30, grades: Object.fromEntries(graders.map((name) => [name, { pass: true }])) }),
  ];
  assert.deepStrictEqual(Object.keys(records[0]), ["case", "arm", "n", "subtype", "costUsd", "turns", "seconds", "reply", "error", "grades"]);
  assert.strictEqual(records[0].seconds, 600);
  assert.strictEqual(records[0].turns, null);
  assert.deepStrictEqual([records[1].costUsd, records[1].turns, records[1].subtype], [0.3, 4, "error_during_execution"]);
  for (const record of records.slice(0, 3)) assert.deepStrictEqual(Object.keys(record.grades), graders);
  assert.deepStrictEqual(records[0].grades[graders[0]], { pass: false, reason: "not graded: timed out after 600 seconds" });

  const { summary, errors } = summarize(records);
  for (const name of graders) assert.deepStrictEqual(summary[c.name][name], { with: [1, 4], without: [0, 0] });
  assert.deepStrictEqual(errors.map((e) => [e.n, e.error]), [[1, timedOut], [2, errored], [3, "scaffold failed: exit 1"]]);
});

test("a judge call that throws makes a judge-failed run that still keeps a result", async (t) => {
  const c = byName(selectCases(COLLET), "guard-refuses-out-of-scope-write");
  const graders = gradersFor(c.graders, "with");
  const run = { ...runFromMessages(finalReply("package.json stays at 1.0.0.")), dir: fs.mkdtempSync(path.join(os.tmpdir(), "sdk-eval-")), created: "" };
  t.after(() => fs.rmSync(run.dir, { recursive: true, force: true }));
  const pass = async () => ({ pass: true });
  assert.deepStrictEqual(Object.keys((await gradeRun(graders, run, pass)).grades), graders.map((g) => g.name));
  for (const judge of [
    async () => JSON.parse('{"verdict": "PA'), // a judge reply cut off mid-JSON
    async () => { throw new Error("529 overloaded"); },
  ]) {
    const graded = await gradeRun(graders, run, judge);
    assert.match(graded.error, /^judge failed: /);
    assert.strictEqual(graded.grades, undefined);
    const record = runRecord(c, "with", 1, run, { seconds: 30, ...graded });
    assert.strictEqual(record.error, graded.error);
    assert.deepStrictEqual(Object.keys(record.grades), graders.map((g) => g.name));
    assert.ok(Object.values(record.grades).every((g) => !g.pass && g.reason === `not graded: ${graded.error}`));
    assert.deepStrictEqual(summarize([record]).errors, [{ case: c.name, arm: "with", n: 1, error: graded.error }]);
  }
  assert.strictEqual((await gradeRun(graders, run, async () => { throw new Error("529 overloaded"); })).error, "judge failed: 529 overloaded");
});

test("a timed-out session with no result adds the priced usage of its assistant messages to the spend", () => {
  // The SDK sends one assistant message per content block, each carrying its API message's id and usage.
  const usage = { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10000, output_tokens: 500 };
  const block = (id, toolId) => ({ ...bashCall(toolId, "ls"), message: { ...bashCall(toolId, "ls").message, id, usage } });
  // An aborted query throws after the session's tool calls, before any result.
  const run = runFromMessages([block("msg_1", "toolu_1"), block("msg_1", "toolu_2"), block("msg_2", "toolu_3"), { type: "runner_error", message: "Claude Code process aborted by user" }]);
  assert.strictEqual(run.costUsd, null);
  // Two API messages, each (1000 + 1.25 * 2000 + 0.1 * 10000) * $4 + 500 * $20 per million tokens.
  assert.ok(Math.abs(sessionSpend(run, [4, 20]) - 2 * 0.028) < 1e-12);
  assert.strictEqual(sessionSpend(runFromMessages([{ type: "runner_error", message: "spawn ENOENT" }]), [4, 20]), 0);
  assert.strictEqual(sessionSpend(runFromMessages(finalReply("Done.")), [4, 20]), 0.42);
});

test("an auth, permission or credit error result stops every run; limits, execution errors and transient API errors fail only their run", () => {
  // The SDK's error results: is_error set, an errors list and no result text.
  const limit = (subtype, errors) => ({ type: "result", subtype, is_error: true, errors, total_cost_usd: 1.1, num_turns: 30 });
  assert.deepStrictEqual(resultError(limit("error_max_turns", ["Reached maximum number of turns (30)"])), { stop: false, message: "session ended in error_max_turns" });
  assert.deepStrictEqual(resultError(limit("error_max_budget_usd", ["Exceeded USD budget (2)"])), { stop: false, message: "session ended in error_max_budget_usd" });
  assert.strictEqual(resultError(limit("error_during_execution", [])).stop, false);
  assert.strictEqual(resultError(limit("error_max_structured_output_retries", [])).stop, false);
  assert.strictEqual(resultError(limit("error_during_execution", ["Credit balance is too low"])).stop, true);
  // An API error ends the success arm with is_error and api_error_status.
  const apiError = (status, result) => ({ type: "result", subtype: "success", is_error: true, ...(status === undefined ? {} : { api_error_status: status }), result });
  for (const [status, result] of [[undefined, "API Error: 500"], [500, "API Error: 500"], [529, "API Error: 529 overloaded"]]) {
    assert.deepStrictEqual(resultError(apiError(status, result)), { stop: false, message: `session ended in API error: ${result}` }, result);
  }
  assert.strictEqual(resultError(apiError(401, "API Error: 401 authentication_error")).stop, true);
  assert.strictEqual(resultError(apiError(403, "API Error: 403 permission_error")).stop, true);
  assert.strictEqual(resultError({ type: "result", subtype: "success", is_error: true, result: "Credit balance is too low" }).stop, true);
  // A credit refusal stops every run even when its result is not an error.
  assert.strictEqual(resultError({ type: "result", subtype: "success", is_error: false, result: "Credit balance is too low" }).stop, true);
  // A reply or an execution error that only mentions a credit balance does not stop the batch.
  assert.strictEqual(resultError(finalReply("I updated the credit balance display.")[1]), null);
  assert.deepStrictEqual(resultError(limit("error_during_execution", ["Cannot read credit balance of undefined"])), { stop: false, message: "session ended in error_during_execution" });
  // A run limit errors only its run, whatever its text.
  for (const subtype of ["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]) {
    assert.deepStrictEqual(resultError(limit(subtype, ["Your credit balance is too low"])), { stop: false, message: `session ended in ${subtype}` }, subtype);
  }
  // A result that is not an error does not stop on an auth or permission status alone.
  for (const status of [401, 403]) assert.strictEqual(resultError({ type: "result", subtype: "success", is_error: false, api_error_status: status, result: "Done." }), null, String(status));
  // An API error with no text and no status is named by its subtype.
  assert.deepStrictEqual(resultError({ type: "result", subtype: "success", is_error: true }), { stop: false, message: "session ended in API error: success" });
  // A session its timeout already aborted fails only its own run.
  assert.strictEqual(resultError(apiError(401, "API Error: 401 authentication_error"), { aborted: true }).stop, false);
  assert.strictEqual(resultError(limit("error_during_execution", ["Credit balance is too low"]), { aborted: true }).stop, false);
  assert.strictEqual(resultError(apiError(401, "API Error: 401 authentication_error"), { aborted: false }).stop, true);
  assert.strictEqual(resultError(finalReply("Done.")[1]), null);
  assert.strictEqual(resultError(bashCall("toolu_1", "ls")), null);
});

test("a judge auth, permission or credit error stops every run; other judge errors fail only their run", async () => {
  const grader = { name: "judged", type: "llm", criteria: "PASS if the reply says done.\nFAIL if it does not." };
  const run = runFromMessages(finalReply("Done."));
  const failing = (status, message) => async () => { throw Object.assign(new Error(message), { status }); };
  for (const [status, message] of [[401, "401 authentication_error"], [403, "403 permission_error"], [400, "400 Your credit balance is too low"], [400, "400 Your credit balance cannot cover this request"]]) {
    assert.strictEqual((await gradeRun([grader], run, failing(status, message))).stop, true, message);
  }
  for (const [status, message] of [[529, "529 overloaded"], [undefined, "Unexpected end of JSON input"]]) {
    const graded = await gradeRun([grader], run, failing(status, message));
    assert.strictEqual(graded.error, `judge failed: ${message}`);
    assert.strictEqual(graded.stop, false);
  }
});

test("a deterministic grader that throws fails its run as that grader's error, not the judge's", async () => {
  const judged = { name: "judged", type: "llm", criteria: "PASS if the reply says done.\nFAIL if it does not." };
  const badRegex = { name: "bad-regex", type: "regex", pattern: "(" };
  let called = false;
  const judge = async () => { called = true; return { pass: true }; };
  const graded = await gradeRun([badRegex, judged], runFromMessages(finalReply("Done.")), judge);
  assert.match(graded.error, /^grader bad-regex failed: Invalid regular expression/);
  assert.strictEqual(graded.stop, false);
  assert.strictEqual(called, false);
});

test("a runJob that throws, such as on a failed file write, still yields an errored record for the summary", async (t) => {
  const c = byName(selectCases(COLLET), "mount-opens-first-task");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-eval-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // result.json is a directory, so writing the run's result throws EISDIR.
  fs.mkdirSync(path.join(dir, "result.json"));
  const runJob = async () => { fs.writeFileSync(path.join(dir, "result.json"), "{}\n"); };
  const records = await Promise.all([1, 2].map((n) => recordJob({ c, arm: "with", n }, runJob)));
  for (const record of records) {
    assert.match(record.error, /^runner failed: EISDIR/);
    assert.deepStrictEqual(Object.keys(record.grades), gradersFor(c.graders, "with").map((g) => g.name));
    assert.ok(Object.values(record.grades).every((g) => !g.pass));
  }
  assert.deepStrictEqual(summarize(records).errors.map((e) => e.n), [1, 2]);
  const ok = { case: c.name, arm: "with", n: 3, grades: {} };
  assert.strictEqual(await recordJob({ c, arm: "with", n: 3 }, async () => ok), ok);
});

test("a session that ran before a failed write keeps its cost, turns and reply in a saved runner-failed record", async (t) => {
  const c = byName(selectCases(COLLET), "mount-opens-first-task");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-eval-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // trace.jsonl is a directory, so the write after the session throws EISDIR.
  fs.mkdirSync(path.join(dir, "trace.jsonl"));
  const runJob = async (job) => {
    const run = runFromMessages(finalReply("Done."));
    job.session = { subtype: run.subtype, costUsd: run.costUsd, turns: run.turns, reply: run.reply, seconds: 30 };
    fs.writeFileSync(path.join(dir, "trace.jsonl"), `${run.trace}\n`);
  };
  const save = (job, record) => fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(record));
  let stopped = false;
  const record = await recordJob({ c, arm: "with", n: 1 }, runJob, { save, stop: () => { stopped = true; } });
  assert.match(record.error, /^runner failed: EISDIR/);
  assert.deepStrictEqual([record.subtype, record.costUsd, record.turns, record.seconds, record.reply], ["success", 0.42, 3, 30, "Done."]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")), record);
  assert.strictEqual(stopped, false);
  // A save that throws too still returns the record.
  const unsaved = await recordJob({ c, arm: "with", n: 2 }, runJob, { save: () => { throw new Error("EISDIR"); } });
  assert.strictEqual(unsaved.costUsd, 0.42);
});

test("a runner failure stops every run only when its code shows the output cannot be written", async () => {
  const c = byName(selectCases(COLLET), "mount-opens-first-task");
  const outcome = async (code) => {
    let stopped = false;
    const thrown = Object.assign(new Error(`${code ?? "no code"}: write failed`), code ? { code } : {});
    const record = await recordJob({ c, arm: "with", n: 1 }, async () => { throw thrown; }, { save: () => { throw thrown; }, stop: () => { stopped = true; } });
    return { stopped, error: record.error };
  };
  for (const code of ["ENOSPC", "EACCES", "EPERM", "EROFS"]) {
    assert.deepStrictEqual(await outcome(code), { stopped: true, error: `runner failed: ${code}: write failed; stopping every run` }, code);
  }
  for (const code of ["EISDIR", "ENOENT", undefined]) assert.strictEqual((await outcome(code)).stopped, false, String(code));
});

test("a runner failure whose record still saves, such as a directory read denied with EPERM, fails only its run", async () => {
  const c = { name: "x", graders: [] };
  let stopped = false;
  let saved = null;
  const thrown = Object.assign(new Error("EPERM: operation not permitted, scandir 'work/.git'"), { code: "EPERM", syscall: "scandir" });
  const record = await recordJob({ c, arm: "with", n: 1 }, async () => { throw thrown; }, { save: (job, r) => { saved = r; }, stop: () => { stopped = true; } });
  assert.strictEqual(stopped, false);
  assert.strictEqual(record.error, "runner failed: EPERM: operation not permitted, scandir 'work/.git'");
  assert.strictEqual(saved, record);
  // A save that fails with an unwritable code stops every run, whatever runJob threw.
  const full = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  const halted = await recordJob({ c, arm: "with", n: 2 }, async () => { throw thrown; }, { save: () => { throw full; }, stop: () => { stopped = true; } });
  assert.strictEqual(stopped, true);
  assert.strictEqual(halted.error, "runner failed: EPERM: operation not permitted, scandir 'work/.git'; stopping every run");
});

test("a runner failure from an unwritable file write stops every run even when its record saves", async () => {
  const c = { name: "x", graders: [] };
  const outcome = async (code, syscall) => {
    let stopped = false;
    let saved = null;
    const thrown = Object.assign(new Error(`${code}: ${syscall} failed`), { code, syscall });
    const record = await recordJob({ c, arm: "with", n: 1 }, async () => { throw thrown; }, { save: (job, r) => { saved = r; }, stop: () => { stopped = true; } });
    assert.strictEqual(saved, record);
    return { stopped, error: record.error };
  };
  for (const code of ["ENOSPC", "EACCES", "EPERM", "EROFS"]) {
    for (const syscall of ["open", "write", "mkdir", "copyfile", "rename"]) {
      assert.deepStrictEqual(await outcome(code, syscall), { stopped: true, error: `runner failed: ${code}: ${syscall} failed; stopping every run` }, `${code} ${syscall}`);
    }
  }
  assert.strictEqual((await outcome("ENOSPC", "scandir")).stopped, false);
  assert.strictEqual((await outcome("EISDIR", "write")).stopped, false);
});

test("the batch summary and spend line print even when summary.json cannot be written", (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-eval-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const records = [{ case: "x", arm: "with", n: 1, grades: { done: { pass: true } } }, { case: "x", arm: "without", n: 1, grades: { done: { pass: false } } }];
  const lines = [];
  assert.strictEqual(reportBatch({ outDir, spent: 1.5, records, total: 2 }, (line) => lines.push(line)), null);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(outDir, "summary.json"), "utf8")).spentUsd, 1.5);
  // summary.json is a directory, so its write throws EISDIR.
  fs.rmSync(path.join(outDir, "summary.json"));
  fs.mkdirSync(path.join(outDir, "summary.json"));
  const printed = [];
  const failure = reportBatch({ outDir, spent: 1.5, records, total: 2 }, (line) => printed.push(line));
  assert.strictEqual(failure?.code, "EISDIR");
  assert.deepStrictEqual(printed, lines);
  assert.deepStrictEqual(printed, ["\nx", `  ${"done".padEnd(30)} with 1/1  without 0/1`, `\n2 of 2 sessions, estimated $1.50. Results in ${outDir}`]);
});

test("an unreadable focus file fails its run as that grader's error, not the judge's", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-eval-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The focus path is a directory, so reading it throws EISDIR.
  fs.mkdirSync(path.join(dir, "notes.md"));
  const grader = { name: "notes-judged", type: "llm", focus: { source: "file", path: "notes.md" }, criteria: "PASS if the notes name the task.\nFAIL if not." };
  let called = false;
  const judge = async () => { called = true; return { pass: true }; };
  const graded = await gradeRun([grader], { ...runFromMessages(finalReply("Done.")), dir }, judge);
  assert.match(graded.error, /^grader notes-judged failed: EISDIR/);
  assert.strictEqual(graded.stop, false);
  assert.strictEqual(called, false);
});

test("an llm grader has no fixed verdict, and its judge reads the last reply", () => {
  const grader = byName(selectCases(COLLET), "guard-refuses-out-of-scope-write").graders.find((g) => g.name === "names-the-refused-file");
  const run = runFromMessages(finalReply("package.json stays at 1.0.0."));
  assert.strictEqual(verdict(grader, run), null);
  assert.strictEqual(judgeText(grader, run), "package.json stays at 1.0.0.");
});
