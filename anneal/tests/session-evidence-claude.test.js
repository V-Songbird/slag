"use strict";

// The session evidence script on synthetic Claude Code transcripts: the cutoff, failures and what followed them,
// and who issued each call and when.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  CLI, SESSION, tempDir, transcript, at, truncated, human, use, result, typed, meta, started, turn, call, output,
} = require("./session-transcripts.js");
const { analyzeClaude, analyzeCodex } = require("../scripts/session-evidence.js");

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

  test("a transcript with no assistant record before its cutoff says the latest prompt may not be this audit", () => {
    const empty = analyzeClaude(transcript([human("fix the cart total", 1), human("/anneal:session-review", 2)]));
    assert.match(empty.warnings.join("\n"), /No assistant records precede the selected cutoff\. .*; pass --before-line or --before\./);
    const worked = analyzeClaude(transcript([
      human("fix the cart total", 1), use("t1", "Bash", { command: "npm test" }, 2), result("t1", "# pass 4", 3), human("/anneal:session-review", 4),
    ]));
    assert.doesNotMatch(worked.warnings.join("\n"), /No assistant records precede/);
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

  test("a rerun with the first run's line cutoff covers exactly its interval, where --before with its time would not", () => {
    const file = transcript([
      human("fix the cart total", 1),
      use("t1", "Bash", { command: "npm test" }, 2),
      // A call the host wrote without a timestamp: a time cutoff cannot place it, a line cutoff keeps it.
      { type: "assistant", message: { id: "msg-t2", model: "model-x", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm run lint" } }] } },
      result("t1", "Exit code 1\n1 failing", 3, true),
      result("t2", "Exit code 1\n2 problems", 4, true),
      human("audit this session", 6),
      // Written after the prompt with an earlier time: a time cutoff takes it in.
      use("t3", "Bash", { command: "npm run build" }, 5),
      result("t3", "Exit code 1\nbuild failed", 5, true),
    ]);
    const first = analyzeClaude(file);
    const rerun = analyzeClaude(file, first.boundary.line);
    assert.deepStrictEqual([first.boundary.line, first.boundary.mode, rerun.boundary.mode], [6, "before-latest-human-prompt", "explicit-line"]);
    assert.deepStrictEqual({ ...rerun, boundary: { ...rerun.boundary, mode: first.boundary.mode } }, first);
    assert.deepStrictEqual(first.candidates.map((c) => c.commandOrArguments), ["npm test", "npm run lint"]);

    const byTime = analyzeClaude(file, new Date(first.boundary.before));
    assert.deepStrictEqual(byTime.candidates.map((c) => c.commandOrArguments), ["npm test", null, "npm run build"]);
    assert.strictEqual(byTime.boundary.skippedWithoutTimestamp, 1);
  });

  test("a time cutoff counts every record it cannot place, and warns only about one that held conversation", () => {
    const rows = [
      human("fix the cart total", 1),
      { type: "file-history-snapshot", messageId: "m1", snapshot: {} },
      { type: "summary", summary: "Cart work", leafUuid: "u1" },
      use("t1", "Bash", { command: "npm test" }, 2),
      result("t1", "Exit code 1\n1 failing", 3, true),
    ];
    const quiet = analyzeClaude(transcript(rows), new Date(at(30)));
    assert.strictEqual(quiet.boundary.skippedWithoutTimestamp, 2);
    assert.doesNotMatch(quiet.warnings.join("\n"), /without a usable timestamp/);

    const untimed = { type: "user", message: { role: "user", content: "and check the tax" } };
    const warned = analyzeClaude(transcript([...rows, untimed]), new Date(at(30)));
    assert.strictEqual(warned.boundary.skippedWithoutTimestamp, 3);
    assert.match(warned.warnings.join("\n"), /Skipped 1 record with a message but without a usable timestamp while using --before/);
    // A line cutoff places every record, so it skips none.
    assert.strictEqual(analyzeClaude(transcript([...rows, untimed]), 7).boundary.skippedWithoutTimestamp, 0);

    // On Codex too, host metadata without a time is counted quietly, and a response without one is warned about.
    const rollout = (...extra) => analyzeCodex(transcript([
      meta, started(1), turn(1), { type: "session_meta", payload: { id: "thread-1" } }, call("c1", "npm test", 2), ...extra,
      output("c1", ['{"exit_code":1,"output":"1 failing"}'], 3),
    ]), new Date(at(30)));
    const codexQuiet = rollout();
    assert.deepStrictEqual([codexQuiet.boundary.skippedWithoutTimestamp, codexQuiet.warnings.some((w) => /usable timestamp/.test(w))], [1, false]);
    const codexWarned = rollout({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "and the tax" }] } });
    assert.deepStrictEqual([codexWarned.boundary.skippedWithoutTimestamp, codexWarned.warnings.some((w) => /usable timestamp/.test(w))], [2, true]);
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

describe("identity and chronology in a Claude Code transcript", () => {
  test("a call keeps the prompt its actor had when it issued the call, never a later one", () => {
    const report = analyzeClaude(transcript([
      human("fix the cart total", 1),
      use("t1", "Bash", { command: "npm tset" }, 2),
      human("also check the tax", 3),
      result("t1", "Exit code 127\nbash: npm tset: command not found", 4, true),
      use("t2", "Bash", { command: "npm test" }, 5),
      result("t2", "# pass 4", 6),
      human("audit", 7),
    ]));
    const [failure] = report.candidates;
    assert.deepStrictEqual([failure.callLine, failure.line, failure.promptLine], [2, 4, 1]);
    assert.deepStrictEqual(failure.laterSameToolSuccesses.map((s) => [s.callLine, s.promptLine]), [[5, 3]]);
  });

  test("a subagent's records keep their own actor, prompt and call ids, and never set the cutoff", () => {
    const agent = { isSidechain: true, agentId: "agent-7" };
    const report = analyzeClaude(transcript([
      typed("find where the cart total is computed", 1),
      use("same", "Read", { file_path: "/work/shop/cart.js" }, 2),
      typed("Search the cart module for the total", 3, agent),
      use("same", "Bash", { command: "cat totals.txt" }, 4, agent),
      result("same", "export const total = 1;", 5),
      result("same", "Exit code 1\ncat: totals.txt: No such file or directory", 6, true, agent),
      use("t2", "Bash", { command: "cat totals.txt" }, 7),
      result("t2", "total = 1", 8),
      typed("audit this session", 9),
      typed("Check the audit's findings", 10, agent),
    ]));
    assert.strictEqual(report.boundary.line, 9);
    const [failure] = report.candidates;
    assert.deepStrictEqual(
      [failure.actor, failure.tool, failure.callLine, failure.line, failure.promptLine, failure.path],
      ["agent-7", "Bash", 4, 6, 3, "/work/shop/totals.txt"],
    );
    // The same command later succeeded in the main session, which is another actor.
    assert.deepStrictEqual(failure.laterSameToolSuccesses, []);
    assert.deepStrictEqual([report.coverage.calls, report.coverage.answered, report.coverage.resultsWithoutCall], [3, 3, 0]);
    assert.match(report.warnings.join("\n"), /each entry names its actor/);
  });

  test("a call id seen again is not a second call, whether it repeats before or after its result", () => {
    const report = analyzeClaude(transcript([
      human("run the checks", 1),
      use("dup", "Bash", { command: "npm test" }, 2),
      use("dup", "Bash", { command: "npm test" }, 2),
      result("dup", "Exit code 1\n1 failing", 3, true),
      use("dup", "Bash", { command: "npm test" }, 2),
      result("dup", "Exit code 1\n1 failing", 3, true),
      use("t2", "Bash", { command: "npm run lint" }, 4),
      result("t2", "Exit code 1\n2 problems", 5, true),
      human("audit", 6),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.commandOrArguments]), [[2, "npm test"], [7, "npm run lint"]]);
    const { calls, answered, repeatedCallIds, unanswered, resultsWithoutCall } = report.coverage;
    assert.deepStrictEqual([calls, answered, repeatedCallIds, unanswered, resultsWithoutCall], [2, 2, 2, 0, 0]);
  });

  test("history a bridged session replays, record for record, is read once and never moves the cutoff", () => {
    const rows = [
      human("fix the cart total", 1),
      use("t1", "Bash", { command: "npm tset" }, 2),
      result("t1", "Exit code 127\nbash: npm tset: command not found", 3, true),
      use("t2", "Bash", { command: "npm test" }, 4),
      result("t2", "# pass 4", 5),
      human("audit this session", 6),
      use("t3", "Bash", { command: "node session-evidence.js" }, 7),
    ].map((row, i) => ({ ...row, uuid: `00000000-0000-4000-8000-00000000000${i}` }));
    const bridge = { type: "bridge-session", bridgeSessionId: "bridge-1", lastSequenceNum: 7, sessionId: SESSION };
    const file = transcript([...rows, bridge, ...rows]);
    const report = analyzeClaude(file);
    assert.deepStrictEqual([report.boundary.line, report.recordsSelected, report.coverage.calls], [6, 5, 2]);
    assert.deepStrictEqual(report.candidateCounts, { "command-not-found": 1 });
    assert.deepStrictEqual(report.candidates[0].laterSameToolSuccesses.map((s) => s.line), [5]);
    assert.match(report.warnings.join("\n"), /Skipped 7 records that repeat an earlier record's uuid/);
    const rerun = analyzeClaude(file, new Date(at(30)));
    assert.deepStrictEqual([rerun.coverage.calls, rerun.coverage.unanswered, rerun.coverage.repeatedCallIds], [3, 1, 0]);
    assert.deepStrictEqual(rerun.candidateCounts, { "command-not-found": 1 });
  });

  test("a prompt queued while the agent works claims the calls after it, and a queued notification does not", () => {
    const queued = (prompt, second, extra = {}) => ({
      type: "attachment", timestamp: at(second),
      attachment: { type: "queued_command", commandMode: "prompt", prompt, origin: { kind: "human" }, ...extra },
    });
    const report = analyzeClaude(transcript([
      human("fix the cart total", 1),
      use("t1", "Bash", { command: "npm test" }, 2),
      result("t1", "# pass 4", 3),
      queued("stop, use pnpm instead", 4),
      use("t2", "Bash", { command: "pnpm tset" }, 5),
      result("t2", "Exit code 1\npnpm: tset: command not found", 6, true),
      queued("<task-notification><status>completed</status></task-notification>", 7, { commandMode: "task-notification", origin: undefined }),
      queued("the reviewer agrees", 8, { origin: { kind: "peer" }, isMeta: true }),
      use("t3", "Bash", { command: "pnpm tst" }, 9),
      result("t3", "Exit code 1\npnpm: tst: command not found", 10, true),
      human("audit", 11),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.promptLine]), [[5, 4], [9, 4]]);
    assert.strictEqual(report.boundary.line, 11);
  });

  test("an automatic notification is never a prompt or the cutoff, and a request typed after one is", () => {
    const report = analyzeClaude(transcript([
      typed("fix the cart total, then explain what a <task-notification> is", 1),
      use("t1", "Bash", { command: "npm test" }, 2),
      typed("<task-notification><task-id>b1</task-id><status>completed</status></task-notification>", 3),
      result("t1", "Exit code 1\n1 failing", 4, true),
      use("t2", "Bash", { command: "npm test -- cart" }, 5),
      result("t2", "Exit code 1\n1 failing", 6, true),
      typed("<system-reminder>The cart file changed.</system-reminder>\nnow check the tax too", 7),
      use("t3", "Bash", { command: "npm test -- tax" }, 8),
      result("t3", "Exit code 1\n1 failing", 9, true),
      typed("<command-message>session-review</command-message>\n<command-name>/session-review</command-name>", 10),
      typed("<task-notification><status>completed</status></task-notification>", 11),
      typed("<local-command-stdout>ok</local-command-stdout>", 12),
    ]));
    assert.strictEqual(report.boundary.line, 10);
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.promptLine]), [[2, 1], [5, 1], [8, 7]]);
  });

  test("a prompt-submit hook's output alone is not a prompt, and a request typed after it is", () => {
    const report = analyzeClaude(transcript([
      typed("fix the cart total", 1),
      use("t1", "Bash", { command: "npm test" }, 2),
      result("t1", "Exit code 1\n1 failing", 3, true),
      typed("<user-prompt-submit-hook>lint passed</user-prompt-submit-hook>", 4),
      typed("<user-prompt-submit-hook>lint passed</user-prompt-submit-hook>\nnow check the tax", 5),
      use("t2", "Bash", { command: "npm test -- tax" }, 6),
      result("t2", "Exit code 1\n1 failing", 7, true),
      typed("audit", 8),
      typed("<user-prompt-submit-hook>audit hook ran</user-prompt-submit-hook>", 9),
    ]));
    assert.strictEqual(report.boundary.line, 8);
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.promptLine]), [[2, 1], [6, 5]]);
  });

  test("a reminder the host appends to a tool result is not output", () => {
    const report = analyzeClaude(transcript([
      human("build it", 1),
      use("t1", "Bash", { command: "npm run build" }, 2),
      result("t1", "built in 2s\n<system-reminder>Commands blocked by policy: none.</system-reminder>", 3),
      use("t2", "Read", { file_path: "/work/shop/notes.md" }, 4),
      result("t2", `${"n".repeat(40)}\n<system-reminder>${"r".repeat(5000)}</system-reminder>`, 5),
      human("audit", 6),
    ]));
    assert.deepStrictEqual(report.candidates, []);
    assert.deepStrictEqual(report.largestToolTexts.map((entry) => [entry.callLine, entry.characters]), [[4, 40], [2, 11]]);
  });

  test("error text printed by a successful read or search is content, not a failure", () => {
    const report = analyzeClaude(transcript([
      human("why did the deploy fail yesterday?", 1),
      use("t1", "Bash", { command: "cat notes/yesterday.md" }, 2),
      result("t1", "we saw: bash: deploy: command not found", 3),
      use("t2", "Bash", { command: 'rg -n "Permission denied" logs' }, 4),
      result("t2", "logs/ci.log:12: Permission denied (publickey)", 5),
      use("t3", "PowerShell", { command: "Get-Content logs/ci.log -Tail 5" }, 6),
      result("t3", "Error: listen EADDRINUSE: address already in use", 7),
      use("t4", "Bash", { command: "npm start" }, 8),
      result("t4", "Error: listen EADDRINUSE: address already in use :::3000", 9),
      human("audit", 10),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.operation, c.category, c.evidenceBasis]), [
      [8, "command", "port-in-use", "diagnostic-text-match-only"],
    ]);
  });

  test("files with the same name keep their full paths, resolved from each call's directory", () => {
    const report = analyzeClaude(transcript([
      human("fix the index", 1),
      use("a", "Read", { file_path: "/work/shop/pkg-a/index.js" }, 2),
      result("a", "<tool_use_error>File does not exist.</tool_use_error>", 3, true),
      use("b", "Read", { file_path: "/work/shop/pkg-b/lib/../index.js" }, 4),
      result("b", "export {};", 5),
      use("c", "Grep", { pattern: "total", path: "index.js" }, 6, { cwd: "/work/shop/pkg-a" }),
      result("c", "<tool_use_error>Path does not exist: index.js</tool_use_error>", 7, true),
      use("d", "Grep", { pattern: "total", path: "index.js" }, 8, { cwd: "/work/shop/pkg-b" }),
      result("d", "<tool_use_error>Path does not exist: index.js</tool_use_error>", 9, true),
      human("audit", 10),
    ]));
    const [missing, ...searches] = report.candidates;
    assert.strictEqual(missing.path, "/work/shop/pkg-a/index.js");
    assert.deepStrictEqual(missing.laterSameToolSuccesses.map((s) => s.path), ["/work/shop/pkg-b/index.js"]);
    assert.deepStrictEqual(searches.map((c) => [c.commandOrArguments, c.operation, c.path]), [
      ['{"pattern":"total","path":"index.js"}', "search", "/work/shop/pkg-a/index.js"],
      ['{"pattern":"total","path":"index.js"}', "search", "/work/shop/pkg-b/index.js"],
    ]);
  });

  test("a Windows path is one identity whatever its spelling, and a shell-dependent one is none", () => {
    const windows = { cwd: "D:\\work\\shop" };
    const report = analyzeClaude(transcript([
      human("fix the index", 1),
      use("a", "Read", { file_path: "d:\\work\\shop\\pkg-a\\index.js" }, 2, windows),
      result("a", "<tool_use_error>File does not exist.</tool_use_error>", 3, true),
      use("b", "Grep", { pattern: "total", path: "pkg-b/index.js" }, 4, windows),
      result("b", "<tool_use_error>Path does not exist</tool_use_error>", 5, true),
      use("c", "PowerShell", { command: "Get-Content -Path 'pkg-a\\index.js' -TotalCount 5" }, 6, windows),
      result("c", "Exit code 1\nCannot find path", 7, true),
      use("d", "Bash", { command: "cat /d/work/shop/pkg-a/index.js" }, 8, windows),
      result("d", "Exit code 1\ncat: no such file", 9, true),
      use("e", "Bash", { command: "cat $HOME/index.js" }, 10, windows),
      result("e", "Exit code 1\ncat: no such file", 11, true),
      human("audit", 12),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.operation, c.path]), [
      ["read", "D:/work/shop/pkg-a/index.js"],
      ["search", "D:/work/shop/pkg-b/index.js"],
      ["read", "D:/work/shop/pkg-a/index.js"],
      ["read", null],
      ["read", null],
    ]);
  });

  test("results pair by call id in any order, and only a call issued after a failure can follow it", () => {
    const report = analyzeClaude(transcript([
      human("check the cart", 1),
      use("a", "Read", { file_path: "/work/shop/cart.js" }, 2),
      use("b", "Read", { file_path: "/work/shop/tax.js" }, 2),
      result("a", "<tool_use_error>File does not exist.</tool_use_error>", 3, true),
      result("b", "export const tax = 0;", 3),
      use("c", "Read", { file_path: "/work/shop/src/cart.js" }, 4),
      result("c", "export const cart = [];", 5),
      use("d", "Bash", { command: "npm test" }, 6),
      use("e", "Bash", { command: "npm run lint" }, 6),
      result("e", "Exit code 1\n2 problems", 7, true),
      result("d", "Exit code 1\n1 failing", 7, true),
      human("audit", 8),
    ]));
    const [missing, lint, tests] = report.candidates;
    // tax.js was read beside the failed read; only the read issued after the failure can follow it.
    assert.deepStrictEqual(missing.laterSameToolSuccesses.map((s) => [s.callLine, s.path]), [[6, "/work/shop/src/cart.js"]]);
    assert.deepStrictEqual([lint.line, lint.callLine, lint.commandOrArguments], [10, 9, "npm run lint"]);
    assert.deepStrictEqual([tests.line, tests.callLine, tests.commandOrArguments], [11, 8, "npm test"]);
  });

  test("a call without a result is counted apart from one answered after the cutoff, and neither is a failure", () => {
    const report = analyzeClaude(transcript([
      human("build it", 1),
      use("t1", "Bash", { command: "npm run build" }, 2),
      use("t2", "Bash", { command: "ls" }, 3),
      result("t2", "src", 4),
      result("ghost", "Exit code 1\nno call carries this id", 5, true),
      use("t3", "Bash", { command: "npm test" }, 6),
      human("audit", 7),
      result("t3", "Exit code 1\n1 failing", 8, true),
    ]));
    // Claude Code runs no scripts in cells, and every result it answers carries is_error, so none is pending or unknown.
    const { calls, answered, answeredAfterCutoff, unanswered, unansweredCallLines, pending, outcomeUnknown, resultsWithoutCall } = report.coverage;
    assert.deepStrictEqual(
      { calls, answered, answeredAfterCutoff, unanswered, unansweredCallLines, pending, outcomeUnknown, resultsWithoutCall },
      {
        calls: 3, answered: 1, answeredAfterCutoff: 1, unanswered: 1, unansweredCallLines: [2], pending: 0, outcomeUnknown: 0, resultsWithoutCall: 1,
      },
    );
    assert.deepStrictEqual(report.candidates.map((c) => [c.line, c.callLine, c.tool]), [[5, null, null]]);
  });

  test("a session that only reads and searches is marked read-only and still reports its failures", () => {
    const reads = [
      human("where is the total computed?", 1),
      use("t1", "Grep", { pattern: "total", path: "src" }, 2),
      result("t1", "No matches found", 3),
      use("t2", "Read", { file_path: "/work/shop/src/total.js" }, 4),
      result("t2", "<tool_use_error>File does not exist.</tool_use_error>", 5, true),
      use("t3", "Bash", { command: "rg -n total src" }, 6),
      result("t3", "src/cart/index.js:3:export const total = 1;", 7),
      use("t4", "Bash", { command: "sed -n '1,20p' src/cart/index.js" }, 8),
      result("t4", "export const total = 1;", 9),
    ];
    const report = analyzeClaude(transcript([...reads, human("audit", 10)]));
    assert.strictEqual(report.coverage.readOnly, true);
    assert.deepStrictEqual(report.coverage.operations, { read: 2, search: 2, edit: 0, write: 0, command: 0, mixed: 0, other: 0 });
    assert.deepStrictEqual(report.candidateCounts, { "missing-path": 1 });

    const then = (name, input) => analyzeClaude(transcript([...reads, use("t5", name, input, 10), result("t5", "done", 11), human("audit", 12)]));
    const tested = then("Bash", { command: "npm test" });
    const converted = then("Bash", { command: "rg --pre ./convert.sh total docs" });
    const removed = then("Bash", { command: "rm -rf build" });
    const edited = then("Edit", { file_path: "/work/shop/src/cart/index.js", old_string: "= 1", new_string: "= 2" });
    assert.deepStrictEqual(
      [tested.coverage.readOnly, converted.coverage.readOnly, removed.coverage.readOnly, edited.coverage.readOnly],
      [null, null, false, false],
    );
  });

  test("read-only stays open with no calls, or when a subagent or an MCP server did the work", () => {
    const quiet = analyzeClaude(transcript([human("hello", 1), human("audit", 2)]));
    const delegated = analyzeClaude(transcript([
      human("tidy the repo", 1),
      use("t1", "Agent", { subagent_type: "general-purpose", prompt: "rename utils.js to money.js" }, 2),
      result("t1", "Renamed utils.js.", 3),
      use("t2", "mcp__github__create_pull_request", { title: "Rename" }, 4),
      result("t2", "PR created", 5),
      human("audit", 6),
    ]));
    const planned = analyzeClaude(transcript([
      human("plan it", 1),
      use("t1", "Read", { file_path: "/work/shop/a.js" }, 2),
      result("t1", "export {};", 3),
      use("t2", "TodoWrite", { todos: [] }, 4),
      result("t2", "ok", 5),
      human("audit", 6),
    ]));
    assert.deepStrictEqual([quiet.coverage.readOnly, delegated.coverage.readOnly, planned.coverage.readOnly], [null, null, true]);
  });

  test("a compound command names no single path, and one that substitutes or redirects into a file is mixed", () => {
    const report = analyzeClaude(transcript([
      human("look at pkg-b", 1),
      use("t1", "Bash", { command: "cd pkg-b && cat index.js" }, 2),
      result("t1", "Exit code 1\ncat: index.js: No such file or directory", 3, true),
      use("t2", "Bash", { command: "rg -n total src | head -n 5" }, 4),
      result("t2", "Exit code 1", 5, true),
      use("t3", "Bash", { command: "cat $(git ls-files '*.md')" }, 6),
      result("t3", "Exit code 1", 7, true),
      use("t4", "Bash", { command: "cat notes.md > copy.md" }, 8),
      result("t4", "Exit code 1", 9, true),
      use("t5", "Bash", { command: 'cat "notes; draft.md"' }, 10),
      result("t5", "Exit code 1\ncat: no such file", 11, true),
      human("audit", 12),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.operation, c.path]), [
      ["read", null], ["search", null], ["mixed", null], ["mixed", null], ["read", "/work/shop/notes; draft.md"],
    ]);
    assert.deepStrictEqual([report.coverage.operations.mixed, report.coverage.readOnly], [2, null]);
  });

  test("a successful compound of reads and searches is content, and a failure hidden behind a pipe is not", () => {
    const report = analyzeClaude(transcript([
      human("why did the deploy fail?", 1),
      use("t1", "Bash", { command: "cd /work/shop && sed -n '1,40p' docs/incident.md" }, 2),
      result("t1", "the deploy failed with: bash: deploy: command not found", 3),
      use("t2", "Bash", { command: "rg -n EADDRINUSE logs | head -5" }, 4),
      result("t2", "logs/app.log:3: listen EADDRINUSE: address already in use", 5),
      use("t3", "Bash", { command: "head -12 docs/a.md && echo ---- && grep -rn blocked docs 2>/dev/null" }, 6),
      result("t3", "Leaving alpha is blocked until the audit passes.", 7),
      use("t4", "Bash", { command: "npm test 2>&1 | tail -20" }, 8),
      result("t4", "sh: jest: command not found", 9),
      human("audit", 10),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.operation, c.category]), [[8, "mixed", "command-not-found"]]);
    assert.deepStrictEqual(report.coverage.operations, { read: 2, search: 1, edit: 0, write: 0, command: 0, mixed: 1, other: 0 });
  });

  test("a compound that writes files is still text-matched, so a failure behind its pipe is a candidate", () => {
    const report = analyzeClaude(transcript([
      human("build it", 1),
      use("t1", "Bash", { command: "mkdir -p out && node build.js 2>&1 | tail -3" }, 2),
      result("t1", "Error: Cannot find module './lib'\n  code: 'MODULE_NOT_FOUND'", 3),
      use("t2", "Bash", { command: "mkdir -p out" }, 4),
      result("t2", "", 5),
      human("audit", 6),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.operation, c.category]), [[2, "write", "command-not-found"]]);
    assert.strictEqual(report.coverage.readOnly, false);
  });

  test("a write is reported as a write, whether or not the file was read first", () => {
    const report = analyzeClaude(transcript([
      human("add a changelog", 1),
      use("t1", "Write", { file_path: "/work/shop/CHANGELOG.md", content: "# Changes\n" }, 2),
      result("t1", "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>", 3, true),
      use("t2", "Read", { file_path: "/work/shop/CHANGELOG.md" }, 4),
      result("t2", "# Old changes", 5),
      use("t3", "Write", { file_path: "/work/shop/CHANGELOG.md", content: "# Changes\n" }, 6),
      result("t3", "The file /work/shop/CHANGELOG.md has been updated.", 7),
      use("t4", "Write", { file_path: "/work/shop/NOTES.md", content: "notes\n" }, 8),
      result("t4", "File created successfully at: /work/shop/NOTES.md", 9),
      human("audit", 10),
    ]));
    const [refused] = report.candidates;
    assert.strictEqual(refused.category, "stale-file-state");
    const [replaced, unread] = refused.laterSameToolSuccesses;
    assert.deepStrictEqual([replaced.operation, replaced.path], ["write", "/work/shop/CHANGELOG.md"]);
    // Nothing read NOTES.md first, and that still does not make the call evidence of a new file.
    assert.deepStrictEqual([unread.operation, unread.path], ["write", "/work/shop/NOTES.md"]);
    assert.deepStrictEqual(Object.keys(unread), Object.keys(replaced));
    assert.deepStrictEqual([report.coverage.operations.write, report.coverage.readOnly], [3, false]);
  });

  test("backslashes and escapes in tool inputs reach the evidence unchanged", () => {
    const regex = String.raw`rg -n "\bload\(\s*'[^']+\.json'\s*\)" src`;
    const printf = String.raw`printf 'a\tb\n' | grep -c "\\t"`;
    const search = { pattern: String.raw`^\s*export\s+const\s+(\w+)\s*=\s*"[^"\\]*(?:\\.[^"\\]*)*"`, path: "src" };
    const edit = { file_path: "/work/shop/src/lines.js", old_string: String.raw`text.split("\n")`, new_string: String.raw`text.split(/\r?\n/)` };
    const windows = String.raw`Get-Content -Path 'C:\work\logs\app.log' -TotalCount 5`;
    const report = analyzeClaude(transcript([
      human("tidy the parser", 1),
      use("t1", "Bash", { command: regex }, 2),
      result("t1", "Exit code 2\nregex parse error", 3, true),
      use("t2", "Bash", { command: printf }, 4),
      result("t2", "Exit code 1\n0", 5, true),
      use("t3", "Grep", search, 6),
      result("t3", "<tool_use_error>Invalid regex</tool_use_error>", 7, true),
      use("t4", "Edit", edit, 8),
      result("t4", "<tool_use_error>String to replace not found in file.</tool_use_error>", 9, true),
      use("t5", "PowerShell", { command: windows }, 10),
      result("t5", "Exit code 1\nCannot find path", 11, true),
      human("audit", 12),
    ]));
    const shown = report.candidates.map((c) => c.commandOrArguments);
    assert.deepStrictEqual(shown, [regex, printf, JSON.stringify(search), JSON.stringify(edit), windows]);
    assert.strictEqual(JSON.parse(shown[2]).pattern, search.pattern);
    assert.deepStrictEqual(JSON.parse(shown[3]), edit);
    // Only the path field is normalized.
    assert.strictEqual(report.candidates[4].path, "C:/work/logs/app.log");
  });

  test("the evidence does not grow with the transcript", () => {
    const size = (steps) => {
      const rows = [human("loop", 1)];
      for (let i = 0; i < steps; i++) {
        rows.push(
          use(`f${i}`, "Bash", { command: `step ${i} ${"a".repeat(2000)}` }, 2),
          result(`f${i}`, `Exit code 1\n${"b".repeat(2000)}`, 3, true),
          use(`s${i}`, "Bash", { command: `retry ${i} ${"c".repeat(2000)}` }, 4),
          result(`s${i}`, "d".repeat(2000), 5),
          use(`u${i}`, "Read", { file_path: `/work/shop/${"e".repeat(600)}/${i}.js` }, 6),
        );
      }
      rows.push(human("audit", 7));
      return JSON.stringify(analyzeClaude(transcript(rows), null, 30)).length;
    };
    const short = size(40);
    const long = size(1000);
    assert.ok(long - short < 2000, `grew from ${short} to ${long} characters`);
  });

  test("a huge timestamp or tool name is cut like any copied field, and a normal one is kept as written", () => {
    const session = (stamp, tool) => transcript([
      human("run the suite", 1),
      use("t1", tool, { command: "npm test" }, 2),
      result("t1", "Exit code 1\n1 failing", 3, true),
      use("t2", tool, { command: "npm test" }, 4),
      result("t2", "# pass 4", 5),
      human("audit", 6),
    ].map((row) => ({ ...row, timestamp: stamp })));
    const normal = analyzeClaude(session(at(2), "mcp__shop__run_tests"));
    const [kept] = normal.candidates;
    assert.deepStrictEqual(
      [normal.boundary.before, kept.timestamp, kept.tool, kept.laterSameToolSuccesses[0].timestamp],
      [at(2), at(2), "mcp__shop__run_tests", at(2)],
    );

    const huge = analyzeClaude(session("9".repeat(1e6), "T".repeat(1e6)));
    const [cut] = huge.candidates;
    const stamp = `${"9".repeat(120)} [excerpt truncated]`;
    const tool = `${"T".repeat(120)} [excerpt truncated]`;
    assert.deepStrictEqual(
      [huge.boundary.before, cut.timestamp, cut.tool, cut.laterSameToolSuccesses[0].timestamp, huge.largestToolTexts[0].tool],
      [stamp, stamp, tool, stamp, tool],
    );
    // Seven copied timestamps and tool names, each cut to 140 characters at most.
    assert.ok(JSON.stringify(huge).length - JSON.stringify(normal).length < 7 * 140);
  });

  test("a huge session id, directory, version, model or agent type is cut, and a normal one is kept as written", () => {
    const read = ({ id, dir, version, model, agentType }) => {
      const folder = tempDir();
      const file = transcript([
        { ...human("fix it", 1), sessionId: id, cwd: dir, version },
        { type: "assistant", timestamp: at(2), message: { model, content: [] } },
        human("audit", 3),
      ], { dir: folder });
      const subagents = path.join(folder, SESSION, "subagents");
      fs.mkdirSync(subagents, { recursive: true });
      fs.writeFileSync(path.join(subagents, "agent-1.jsonl"), "");
      fs.writeFileSync(path.join(subagents, "agent-1.meta.json"), JSON.stringify({ agentType }));
      const { sessionId, context, subagentTranscripts: [agent] } = analyzeClaude(file);
      return [sessionId, context.cwd, context.version, context.model, agent.agentType];
    };
    const normal = { id: SESSION, dir: "/work/shop", version: "2.1.0", model: "model-x", agentType: "Explore" };
    assert.deepStrictEqual(read(normal), Object.values(normal));
    const huge = {
      id: "0".repeat(1e6), dir: `/work/${"d".repeat(1e6)}`, version: "9".repeat(1e6), model: "m".repeat(1e6), agentType: "A".repeat(1e6),
    };
    assert.deepStrictEqual(read(huge), [
      truncated(huge.id, 120), truncated(huge.dir, 480), truncated(huge.version, 120), truncated(huge.model, 120), truncated(huge.agentType, 120),
    ]);
  });
});

describe("the machine's account", () => {
  // The helper pins a generic account before any script loads, and the scripts mask the account wherever it is a whole
  // path segment. A child process stands in for a machine whose account is work, with the helper loaded first and not.
  test("an account named like a fixture path segment changes no evidence", () => {
    const file = transcript([
      human("read the notes", 1),
      use("t1", "Bash", { command: "cat /work/shop/notes.md" }, 2),
      result("t1", "Exit code 1\ncat: /work/shop/notes.md: No such file or directory", 3, true),
      human("audit this session", 4),
    ]);
    const saved = path.join(tempDir(), "report.json");
    const onWork = (helper) => {
      const script = `const os = require("node:os"); os.homedir = () => "/home/work"; os.userInfo = () => ({ username: "work" });`
        + (helper ? `require(${JSON.stringify(require.resolve("./session-transcripts.js"))});` : "")
        + `require("node:fs").writeFileSync(${JSON.stringify(saved)}, JSON.stringify(require(${JSON.stringify(CLI)}).analyzeClaude(${JSON.stringify(file)})));`;
      const done = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
      assert.strictEqual(done.status, 0, done.stderr);
      return JSON.parse(fs.readFileSync(saved, "utf8"));
    };
    const pinned = JSON.parse(JSON.stringify(analyzeClaude(file)));
    assert.match(JSON.stringify(pinned.candidates), /\/work\/shop\/notes\.md/);
    assert.deepStrictEqual(onWork(true), pinned);
    assert.match(JSON.stringify(onWork(false).candidates), /\/<user>\/shop\/notes\.md/);
  });
});

describe("a turn that stopped for a continue", () => {
  // The assistant's text at the end of its turn.
  const says = (text, second) => ({ type: "assistant", timestamp: at(second), message: { id: `msg-text-${second}`, model: "model-x", content: [{ type: "text", text }] } });
  // A turn of work, its final text, the owner's next prompt, and the audit's own prompt as the cutoff.
  const stalled = (ending, next, work = [use("t1", "Bash", { command: "npm test" }, 2), result("t1", "# pass 4", 3)]) => analyzeClaude(transcript([
    human("fix the cart total", 1), ...work, says(ending, 4), human(next, 5), use("t9", "Read", { file_path: "src/cart.js" }, 6), result("t9", "x", 7),
    human("audit this session", 8),
  ]));

  test("an offer to go on, a question and a list of next steps, each followed by a bare continue, are stall candidates", () => {
    const endings = [
      ["The cart total rounds to the cent and the tests pass. Want me to continue with the checkout page?", "continue", "offer"],
      ["Listo el carrito.\n\n¿Quieres que siga con la página de pago?", "sí, continúa por favor", "offer"],
      ["I rounded the cart total. Should the order total round the same way?", "go ahead", "question"],
      ["The cart is done.\n\nNext steps:\n1. Round the order total\n2. Update the checkout test", "Keep going.", "next-steps"],
      ["El carrito ya redondea.\n\nPróximos pasos:\n- Redondear el total del pedido\n- Actualizar la prueba", "sigue", "next-steps"],
      ["The checkout copy is in place.\n\nNext: round the order total.", "Proceed", "next-steps"],
      ["El carrito ya redondea. Con tu sí, hago la página de pago.", "dale", "offer"],
    ];
    for (const [ending, next, shape] of endings) {
      const report = stalled(ending, next);
      assert.deepStrictEqual(report.stallCounts, { [shape]: 1 }, ending);
      const [candidate] = report.stallCandidates;
      assert.deepStrictEqual([candidate.kind, candidate.observed.ending, candidate.scope], ["stall", shape, "machine"], ending);
      assert.deepStrictEqual([candidate.observed.line, candidate.observed.promptLine, candidate.observed.nextPromptLine], [4, 1, 5]);
      assert.strictEqual(candidate.observed.nextPrompt, next);
      assert.deepStrictEqual(candidate.observed.projectCommands, []);
    }
  });

  test("an ending that names a project command routes to the map file", () => {
    const report = stalled("The migration file is ready. Shall I run `npm run db:migrate` next?", "continue");
    const [candidate] = report.stallCandidates;
    assert.deepStrictEqual([candidate.scope, candidate.observed.projectCommands], ["map-file", ["npm run db:migrate"]]);
    const machine = stalled("The notes are ready. Want me to open `README.md` next?", "continue").stallCandidates[0];
    assert.deepStrictEqual([machine.scope, machine.observed.projectCommands], ["machine", []]);
  });

  test("a question the owner answers, a continue after a failed command, a finished result and an ending that asks for a commit, push or release are not", () => {
    const failed = [use("t1", "Bash", { command: "npm test" }, 2), result("t1", "Exit code 1\n1 failing", 3, true)];
    const quiet = [
      stalled("I rounded the cart total. Should the order total round the same way?", "Yes, round it half up too."),
      stalled("The suite fails on the cart total. Want me to look into it?", "continue", failed),
      stalled("All done: the cart total rounds to the cent and the tests pass.", "continue"),
      stalled("Want me to continue with the checkout page?", "continue, but skip the docs"),
      stalled("Want me to continue with the checkout page?", "yes"),
      stalled("The fix is ready. Want me to commit it and push?", "go ahead"),
      stalled("Próximos pasos:\n- Publicar la versión 1.2", "sigue"),
      stalled("El carrito ya redondea. Con tu síntesis armé la página de pago.", "continue"),
    ];
    for (const report of quiet) assert.deepStrictEqual([report.stallCounts, report.stallCandidates], [{}, []]);
  });

  test("an offer earlier in the turn, a prompt with an image and the audit's own prompt are not", () => {
    const earlier = analyzeClaude(transcript([
      human("fix the cart total", 1), says("Want me to continue?", 2), use("t1", "Bash", { command: "npm test" }, 3), result("t1", "# pass 4", 4),
      human("continue", 5), human("audit this session", 6),
    ]));
    assert.deepStrictEqual(earlier.stallCandidates, []);
    const image = { ...human("continue", 5), message: { role: "user", content: [{ type: "text", text: "continue" }, { type: "image", source: {} }] } };
    const pictured = analyzeClaude(transcript([human("fix the cart total", 1), says("Want me to continue?", 4), image, human("audit this session", 6)]));
    assert.deepStrictEqual(pictured.stallCandidates, []);
    const own = analyzeClaude(transcript([human("fix the cart total", 1), says("Want me to continue?", 4), human("continue", 5)]));
    assert.strictEqual(own.boundary.line, 3);
    assert.deepStrictEqual(own.stallCandidates, [], "the latest prompt is the audit's own cutoff");
  });

  test("the ending is redacted and bounded, and only the last candidates within the limit are kept", () => {
    const home = stalled("The cart is done. Want me to continue in /home/quillfen/shop/checkout?", "continue");
    assert.strictEqual(home.stallCandidates[0].observed.endingExcerpt, "The cart is done. Want me to continue in ~/shop/checkout?");
    const long = stalled(`${"The cart work is long. ".repeat(20)}Want me to continue?`, "continue");
    assert.strictEqual(long.stallCandidates[0].observed.endingExcerpt, truncated(`${"The cart work is long. ".repeat(20)}Want me to continue?`, 240));
    const rows = [human("fix the cart total", 1)];
    for (let i = 0; i < 8; i++) rows.push(says("Want me to continue?", 2 + i * 2), human("continue", 3 + i * 2));
    rows.push(human("audit this session", 30));
    const many = analyzeClaude(transcript(rows));
    assert.deepStrictEqual(many.stallCounts, { offer: 8 });
    assert.deepStrictEqual(many.stallCandidates.map((c) => c.observed.nextPromptLine), [7, 9, 11, 13, 15, 17]);
    assert.match(many.warnings.join("\n"), /Only the last 6 stall candidates are shown/);
  });
});
