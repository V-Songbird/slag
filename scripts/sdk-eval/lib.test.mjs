// The SDK eval runner's model-free parts, against collet's real cases: case
// reading, the run built from SDK messages, and grader verdicts on that run.

import { test } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectCases, runFromMessages, gradersFor, verdict, judgeText, sessionEnv, JUDGE_CLIENT, runArms, sessionOptions } from "./lib.mjs";

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

test("an llm grader has no fixed verdict, and its judge reads the last reply", () => {
  const grader = byName(selectCases(COLLET), "guard-refuses-out-of-scope-write").graders.find((g) => g.name === "names-the-refused-file");
  const run = runFromMessages(finalReply("package.json stays at 1.0.0."));
  assert.strictEqual(verdict(grader, run), null);
  assert.strictEqual(judgeText(grader, run), "package.json stays at 1.0.0.");
});
