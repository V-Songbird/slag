"use strict";

// The session evidence script on synthetic Codex rollouts: the cutoff, exit codes and the class of a result
// without one, and what a code-mode script does.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const { transcript, at, truncated, meta, started, turn, item, message, call, output, script, fn, returned } = require("./session-transcripts.js");
const { analyzeCodex } = require("../scripts/session-evidence.js");

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

  test("results pair by call id, a concurrent success is not nearby, and a missing result is counted", () => {
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1),
      { timestamp: at(2), type: "event_msg", payload: { type: "user_message", message: "run the suite" } },
      call("c1", "npm test", 3),
      call("c2", "npm run lint", 3),
      output("c1", ['{"exit_code":1,"output":"1 failing"}'], 4),
      output("c2", ['{"exit_code":0,"output":"clean"}'], 4),
      call("c3", "npm test -- --bail", 5),
      output("c3", ['{"exit_code":0,"output":"# pass 4"}'], 6),
      call("c4", "npm run build", 7),
      started(8),
    ]));
    const [failure] = report.candidates;
    // lint ran beside the failing suite; only the call issued after the failure is nearby.
    assert.deepStrictEqual(failure.nearbyReportedSuccesses.map((s) => s.callLine), [9]);
    assert.deepStrictEqual([failure.actor, failure.callLine, failure.promptLine], ["main", 5, 4]);
    const { calls, answered, unanswered, unansweredCallLines } = report.coverage;
    assert.deepStrictEqual([calls, answered, unanswered, unansweredCallLines], [4, 3, 1, [11]]);
  });

  test("a shell read that exits 0 prints content, and its path comes from the call's working directory", () => {
    const item = (second, payload) => ({ timestamp: at(second), type: "response_item", payload });
    const shell = (id, args, second) => item(second, { type: "function_call", call_id: id, name: "shell", arguments: JSON.stringify(args) });
    const done = (id, text, second) => item(second, { type: "function_call_output", call_id: id, output: text });
    const patch = "*** Begin Patch\n*** Add File: docs/new.md\n+hi\n*** End Patch";
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1),
      shell("c1", { command: ["bash", "-lc", "cat notes.md"], workdir: "/work/shop/docs" }, 2),
      done("c1", "Process exited with code 0\nyesterday: bash: deploy: command not found", 3),
      shell("c2", { command: ["bash", "-lc", "deploy || true"] }, 4),
      done("c2", "Process exited with code 0\nbash: deploy: command not found", 5),
      shell("c3", { command: ["cat", "missing.md"], workdir: "/work/shop/docs" }, 6),
      done("c3", "Process exited with code 1\ncat: missing.md: No such file or directory", 7),
      item(8, { type: "custom_tool_call", call_id: "c4", name: "apply_patch", input: patch }),
      item(9, { type: "custom_tool_call_output", call_id: "c4", output: "Done" }),
      started(10),
    ]));
    // The failed read of a missing file is named for that cause, as its navigation candidate is.
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.operation, c.path, c.category]), [
      [6, "mixed", null, "command-not-found"],
      [8, "read", "/work/shop/docs/missing.md", "missing-path"],
    ]);
    assert.deepStrictEqual([report.coverage.operations.edit, report.coverage.readOnly], [1, false]);
  });

  test("a prompt recorded only as a user message is the prompt, and injected context is not", () => {
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1),
      message("# AGENTS.md instructions for /work/shop\n\n<INSTRUCTIONS>Use pnpm.</INSTRUCTIONS>", 1),
      message("<environment_context>\n  <cwd>/work/shop</cwd>\n</environment_context>", 1),
      message("fix the cart total", 2),
      call("c1", "npm test", 3),
      output("c1", ["Script completed\nOutput:\n", "Exit code: 1\nWall time: 0.4 seconds\nOutput:\n1 failing"], 4),
      message("<recommended_plugins>none</recommended_plugins>", 5),
      call("c2", "npm test -- cart", 6),
      output("c2", ["Script completed\nOutput:\n", "Exit code: 1\nWall time: 0.3 seconds\nOutput:\n1 failing"], 7),
      started(8),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.promptLine, c.exitCode]), [[7, 6, 1], [10, 6, 1]]);
  });

  test("the owner's answer to the agent's question is a prompt, though the host tags it", () => {
    const fn = (id, name, args, second) => item(second, { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("tidy the parser", 1),
      fn("q", "request_user_input_async", { questions: ["pnpm or npm?"] }, 2),
      item(3, { type: "function_call_output", call_id: "q", output: "asked" }),
      message("<send_user_message_question_reply>use pnpm</send_user_message_question_reply>", 4),
      fn("c1", "exec_command", { cmd: "pnpm tset" }, 5),
      item(6, { type: "function_call_output", call_id: "c1", output: "Process exited with code 1\nOutput:\nERR_PNPM_NO_SCRIPT" }),
      started(7),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.promptLine]), [[8, 7]]);
  });

  test("exec scripts and exec_command calls are classified by the shell commands they carry", () => {
    const fn = (id, args, second) => item(second, { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify(args) });
    const done = (id, code, text, second) => item(second, {
      type: "function_call_output", call_id: id,
      output: `Chunk ID: 1a2b\nWall time: 0.1 seconds\nProcess exited with code ${code}\nOriginal token count: 9\nOutput:\n${text}`,
    });
    const script = 'const a = await tools.exec_command({cmd: "rg -n deploy logs", workdir: "/work/shop"});\n'
      + "const b = await tools.exec_command({ cmd: 'cat docs/incident.md', max_output_tokens: 4000 });\ntext(a);\ntext(b);";
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("why did the deploy fail?", 1),
      call("c1", "cat notes.md", 2),
      output("c1", ["Script completed\nOutput:\n", "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nyesterday: bash: deploy: command not found"], 3),
      item(4, { type: "custom_tool_call", call_id: "c2", name: "exec", input: script }),
      output("c2", ["Script completed\nOutput:\n", "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nlogs/ci.log:3: deploy: command not found"], 5),
      item(6, { type: "custom_tool_call", call_id: "c3", name: "exec", input: 'const cmd = "npm test";\ntext(await tools.exec_command({cmd}))' }),
      output("c3", ["Script completed\nOutput:\n", "Exit code: 0\nWall time: 2.0 seconds\nOutput:\n# pass 4"], 7),
      fn("c4", { cmd: "rm -rf build", workdir: "/work/shop" }, 8),
      done("c4", 0, "", 9),
      fn("c5", { cmd: String.raw`Get-Content -LiteralPath 'docs\missing.md'`, workdir: String.raw`D:\work\shop` }, 10),
      done("c5", 1, "Get-Content: Cannot find path", 11),
      started(12),
    ]));
    assert.deepStrictEqual(
      report.candidates.map((c) => [c.callLine, c.operation, c.path, c.exitCode]),
      [[13, "read", "D:/work/shop/docs/missing.md", 1]],
    );
    assert.deepStrictEqual(report.coverage.operations, { read: 2, search: 1, edit: 0, write: 1, command: 1, mixed: 0, other: 0 });
    assert.strictEqual(report.coverage.readOnly, false);
  });

  test("an exit code is an integer: a huge or non-numeric one is copied as null and is no failure", () => {
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1),
      call("c1", "cat results.json", 2),
      output("c1", [JSON.stringify({ exit_code: "x".repeat(200000), output: "ok" })], 3),
      call("c2", "npm test", 4),
      output("c2", [JSON.stringify({ exit_code: "1", output: "1 failing" })], 5),
      call("c3", "npm test", 6),
      output("c3", [JSON.stringify({ exit_code: 1e300, output: "done" })], 7),
      started(8),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.exitCode, c.category]), [[6, 1, "nonzero-exit"]]);
    assert.ok(JSON.stringify(report).length < 20000);
  });

  test("an exit line counts only in a result's header, and one a read quotes in its output is content", () => {
    const fn = (id, cmd, second) => item(second, { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd }) });
    const done = (id, header, content, second) => item(second, {
      type: "function_call_output", call_id: id,
      output: `Chunk ID: 1\nWall time: 0.1 seconds\n${header}\nOriginal token count: 20\nOutput:\n${content}`,
    });
    const quoted = 'runner log:\nExit code: 2\n{"exit_code":3,"output":"quoted"}\n';
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("why did CI fail?", 1),
      fn("c1", "cat logs/ci.log", 2),
      done("c1", "Process exited with code 0", "step build\nProcess exited with code 1\nstep test\n", 3),
      call("c2", "cat logs/ci.log", 4),
      output("c2", ["Script completed\nOutput:\n", `Exit code: 0\nWall time: 0.1 seconds\nOutput:\n${quoted}`], 5),
      fn("c3", "npm test", 6),
      done("c3", "Process exited with code 1", "1 failing\nExit code: 0\n", 7),
      started(8),
    ]));
    assert.deepStrictEqual(
      report.candidates.map((c) => [c.callLine, c.operation, c.exitCode, c.evidenceBasis]),
      [[9, "command", 1, "reported-nonzero-exit"]],
    );
  });

  test("a turn another agent started is not the cutoff, unless the owner prompted in it too", () => {
    const trigger = (second) => ({ timestamp: at(second), type: "inter_agent_communication_metadata", payload: { trigger_turn: true } });
    const rows = [
      meta, started(1), turn(1), message("fix the cart total", 1),
      call("c1", "npm test", 2), output("c1", ['{"exit_code":1,"output":"1 failing"}'], 3),
      started(4), turn(4), message("$session-review", 4),
      call("c2", "node session-evidence.js", 5),
      started(6), turn(6), trigger(6), item(6, { type: "agent_message", message: "the worker finished" }),
    ];
    assert.strictEqual(analyzeCodex(transcript(rows)).boundary.line, 7);
    assert.strictEqual(analyzeCodex(transcript([...rows, message("and the tax?", 7)])).boundary.line, 11);
  });

  test("a rollout with no call before its cutoff says the latest task start may not be this audit", () => {
    const empty = analyzeCodex(transcript([meta, started(1), turn(1), message("$session-review", 1), call("c1", "node x.js", 2)]));
    assert.match(empty.warnings.join("\n"), /No tool calls precede the selected cutoff\. .*; pass --before-line or --before\./);
    const worked = analyzeCodex(transcript([
      meta, started(1), call("c1", "npm test", 2), output("c1", ['{"exit_code":0,"output":"ok"}'], 3), started(4),
    ]));
    assert.doesNotMatch(worked.warnings.join("\n"), /No tool calls precede/);
  });

  test("a huge timestamp or tool name is cut in a rollout too, and a normal one is kept as written", () => {
    const tool = (id, name) => ({ type: "response_item", payload: { type: "custom_tool_call", call_id: id, name, input: "npm test" } });
    const rollout = (stamp, name) => transcript([
      meta, started(1),
      tool("c1", name), output("c1", ['{"exit_code":1,"output":"1 failing"}'], 3),
      tool("c2", name), output("c2", ['{"exit_code":0,"output":"# pass 4"}'], 5),
      started(6),
    ].map((row) => ({ ...row, timestamp: stamp })));
    const normal = analyzeCodex(rollout(at(2), "exec"));
    const [kept] = normal.candidates;
    assert.deepStrictEqual(
      [normal.boundary.before, kept.timestamp, kept.tool, kept.nearbyReportedSuccesses[0].timestamp],
      [at(2), at(2), "exec", at(2)],
    );

    const huge = analyzeCodex(rollout("9".repeat(1e6), "T".repeat(1e6)));
    const [cut] = huge.candidates;
    const stamp = `${"9".repeat(120)} [excerpt truncated]`;
    assert.deepStrictEqual(
      [huge.boundary.before, cut.timestamp, cut.tool, cut.nearbyReportedSuccesses[0].timestamp],
      [stamp, stamp, `${"T".repeat(120)} [excerpt truncated]`, stamp],
    );
  });

  test("a huge thread id, directory, model or effort is cut in a rollout too, and a normal one is kept as written", () => {
    const read = ({ id, dir, model, effort }) => {
      const { sessionId, context } = analyzeCodex(transcript([
        { ...meta, payload: { id, cwd: dir } }, started(1),
        { timestamp: at(1), type: "turn_context", payload: { cwd: dir, model, effort } },
        started(2),
      ]));
      return [sessionId, context.cwd, context.model, context.effort];
    };
    const normal = { id: "thread-1", dir: "/work/shop", model: "model-y", effort: "medium" };
    assert.deepStrictEqual(read(normal), Object.values(normal));
    const huge = { id: "0".repeat(1e6), dir: `/work/${"d".repeat(1e6)}`, model: "m".repeat(1e6), effort: "e".repeat(1e6) };
    assert.deepStrictEqual(read(huge), [truncated(huge.id, 120), truncated(huge.dir, 480), truncated(huge.model, 120), truncated(huge.effort, 120)]);
  });

  test("a sub-agent's rollout names its own thread, the first session_meta, not the thread it was forked from", () => {
    const own = { timestamp: at(0), type: "session_meta", payload: { id: "thread-2", cwd: "/work/shop", forked_from_id: "thread-1", parent_thread_id: "thread-1" } };
    const forked = analyzeCodex(transcript([own, meta, started(1), turn(1), message("review the change", 1), started(2)]));
    const plain = analyzeCodex(transcript([meta, started(1), turn(1), message("review the change", 1), started(2)]));
    assert.deepStrictEqual([forked.sessionId, plain.sessionId], ["thread-2", "thread-1"]);
  });

  test("a fork that copied its parent's history leaves it out, but for the prompt and context the sub-agent was given", () => {
    const missing = (file) => `Process exited with code 1\nOutput:\ncat: ${file}: No such file or directory`;
    // `second` is the row after the fork's own session_meta. `unplaced` gives the copied result no usable ordinal.
    const read = (second, unplaced = false) => {
      const report = analyzeCodex(transcript([
        { timestamp: at(0), type: "session_meta", payload: { id: "thread-2", cwd: "/work/shop", forked_from_id: "thread-1", subagent_history_start_ordinal: 6 } },
        second, started(0), turn(0), message("fix the checkout", 0), returned("p1", missing("docs/old.md"), 0),
        { timestamp: at(1), type: "event_msg", payload: { type: "thread_settings_applied" } },
        started(1), fn("c1", "exec_command", { cmd: "cat docs/missing.md" }, 2), returned("c1", missing("docs/missing.md"), 3),
        started(4),
      ].map((row, ordinal) => ({ ...row, ordinal: unplaced && ordinal === 5 ? null : ordinal }))));
      return [report.candidates.map((c) => [c.callLine, c.promptLine, c.category, c.path]), report.coverage.resultsWithoutCall];
    };
    const own = [9, 5, "missing-path", "/work/shop/docs/missing.md"];
    // Only the copy of the parent's session_meta shows that the rows below ordinal 6 are the parent's history.
    assert.deepStrictEqual(read(meta), [[own], 0]);
    const kept = read({ timestamp: at(0), type: "world_state", payload: {} });
    assert.deepStrictEqual(kept, [[[null, null, "nonzero-exit", null], own], 1]);
    assert.deepStrictEqual(read({ ...meta, payload: { id: "thread-9", cwd: "/work/shop" } }), kept);
    assert.deepStrictEqual(read(meta, true), kept);
  });

  const patch = (file, from, to) => `text(await tools.apply_patch("*** Begin Patch\\n*** Update File: ${file}\\n@@\\n-${from}\\n+${to}\\n*** End Patch"));`;

  test("Script completed is a success only for a script that any failure would have ended", () => {
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("fix the cart total", 1),
      call("c1", "npm test", 2),
      output("c1", ["Script completed\nWall time 1.0 seconds\nOutput:\n", "Exit code: 1\nWall time: 0.9 seconds\nOutput:\n1 failing"], 3),
      // A patch that does not apply throws, so the script would have failed. The patch's text is no code.
      script("c2", patch("src/cart.js", "  return fetchItems();", "  return fetchItems().catch(() => []);"), 4),
      output("c2", ["Script completed\nWall time 0.1 seconds\nOutput:\n", "Success. Updated the following files:\nM src/cart.js"], 5),
      // exec_command returns a nonzero exit instead of throwing, and this script prints no exit line.
      script("c3", 'const run = await tools.exec_command({cmd: "npm run deploy"});\ntext(run.output);', 6),
      output("c3", ["Script completed\nWall time 0.2 seconds\nOutput:\n", "sh: 1: deploy: command not found"], 7),
      // A script that catches a failure completes anyway.
      script("c4", `try {\n  ${patch("src/cart.js", "a", "b")}\n} catch (error) {\n  text(String(error));\n}`, 8),
      output("c4", ["Script completed\nWall time 0.1 seconds\nOutput:\n", "apply_patch verification failed: Failed to find expected lines"], 9),
      // A server's tool may return its failure.
      script("c5", 'text(await tools.mcp__docs__search({query: "cart total"}));', 10),
      output("c5", ["Script completed\nWall time 0.4 seconds\nOutput:\n", "No results"], 11),
      // shell_command throws on a nonzero exit, so its output reads like that of a command that exited 0: a read prints content.
      script("c6", 'text((await tools.shell_command({command: "npm run lint || true"})).output);', 12),
      output("c6", ["Script completed\nWall time 0.6 seconds\nOutput:\n", "sh: 1: eslint: command not found"], 13),
      script("c7", 'text((await tools.shell_command({command: "cat docs/access.md"})).output);', 14),
      output("c7", ["Script completed\nWall time 0.1 seconds\nOutput:\n", "Permission denied until the owner grants access"], 15),
      // A script that runs no command prints content.
      script("c8", 'text("Permission denied is now retried in src/upload.js");', 16),
      output("c8", ["Script completed\nWall time 0.0 seconds\nOutput:\n", "Permission denied is now retried in src/upload.js"], 17),
      // write_stdin returns a nonzero exit, a tool reached another way is none the script names, and allSettled keeps a failure.
      script("c9", 'text((await tools.write_stdin({session_id: 4, chars: "y\\n"})).output);', 18),
      output("c9", ["Script completed\nWall time 0.2 seconds\nOutput:\n", "Overwrite? y"], 19),
      script("c10", 'const run = tools.exec_command;\ntext((await run({cmd: "npm run deploy"})).output);', 20),
      output("c10", ["Script completed\nWall time 0.3 seconds\nOutput:\n", "deployed"], 21),
      script("c11", 'const [shown] = await Promise.allSettled([tools.view_image({path: "docs/cart.png"})]);\ntext(shown.status);', 22),
      output("c11", ["Script completed\nWall time 0.1 seconds\nOutput:\n", "rejected"], 23),
      // A template with a substitution holds code, so the script is read whole.
      script("c12", 'text(`patching ${file}`);\nawait tools.apply_patch(change).catch((error) => text(`${error}`));', 24),
      output("c12", ["Script completed\nWall time 0.1 seconds\nOutput:\n", "patching src/cart.js"], 25),
      started(26),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.line, c.category, c.exitCode, c.evidenceBasis]), [
      [6, "nonzero-exit", 1, "reported-nonzero-exit"],
      [10, "command-not-found", null, "diagnostic-text-match-only"],
      [16, "command-not-found", null, "diagnostic-text-match-only"],
    ]);
    assert.deepStrictEqual(report.candidates.map((c) => c.nearbyReportedSuccesses.map((s) => s.line)), [[8, 18], [18, 20], [18, 20]]);
    assert.deepStrictEqual([report.coverage.outcomeUnknown, report.coverage.pending], [6, 0]);
  });

  test("a name that only contains catch, tools or globalThis is none of them, whatever letters it holds", () => {
    const applied = (id, second) => output(id, ["Script completed\nWall time 0.1 seconds\nOutput:\n", "Success. Updated the following files:\nM src/cart.js"], second);
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("fix the cart total", 1),
      script("c1", `const cañcatch = 1;\n${patch("src/cart.js", "a", "b")}`, 2), applied("c1", 3),
      script("c2", `const $tools = {};\n${patch("src/cart.js", "b", "c")}`, 4), applied("c2", 5),
      script("c3", `const ñglobalThis = 0;\n${patch("src/cart.js", "c", "d")}`, 6), applied("c3", 7),
      // A real catch still keeps the script from vouching for how it ended.
      script("c4", `try {\n  ${patch("src/cart.js", "d", "e")}\n} catch (error) {\n  text(String(error));\n}`, 8), applied("c4", 9),
      started(10),
    ]));
    assert.strictEqual(report.coverage.outcomeUnknown, 1);
  });

  test("a script still running is pending, and a wait on its cell completes it with the script's class", () => {
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("start the dev server and fix the header", 1),
      fn("c1", "exec_command", { cmd: "cat docs/setup.md" }, 2),
      returned("c1", "Process exited with code 1\nOutput:\ncat: docs/setup.md: No such file or directory", 3),
      script("c2", 'const server = await tools.exec_command({cmd: "npm run dev"});\ntext(server.output);', 4),
      output("c2", ["Script running with cell ID 7\nWall time 10.0 seconds\nOutput:\n", "> vite"], 5),
      // What a running script printed is not printed again when it completes, so it is read where it first appears.
      fn("w1", "wait", { cell_id: "7", yield_time_ms: 30000, max_tokens: 4000 }, 6),
      returned("w1", ["Script running with cell ID 7\nWall time 30.0 seconds\nOutput:\n", "Error: listen EADDRINUSE: address already in use :::3000"], 7),
      fn("w2", "wait", { cell_id: "7", yield_time_ms: 30000, max_tokens: 4000 }, 8),
      returned("w2", ["Script completed\nWall time 2.0 seconds\nOutput:\n", "server stopped"], 9),
      script("c3", patch("src/header.js", "<h1>Shop</h1>", "<h1>Cart</h1>"), 10),
      output("c3", ["Script running with cell ID 8\nWall time 10.0 seconds\nOutput:\n"], 11),
      fn("w3", "wait", { cell_id: "8", yield_time_ms: 30000, max_tokens: 4000 }, 12),
      returned("w3", ["Script completed\nWall time 0.5 seconds\nOutput:\n", "Success. Updated the following files:\nM src/header.js"], 13),
      call("c4", "npm run watch", 14),
      output("c4", ["Script running with cell ID 9\nWall time 10.0 seconds\nOutput:\n"], 15),
      call("c5", "npm run e2e", 16),
      output("c5", ["Script running with cell ID 10\nWall time 10.0 seconds\nOutput:\n"], 17),
      fn("w4", "wait", { cell_id: "10", terminate: true }, 18),
      returned("w4", ["Script terminated\nWall time 0.1 seconds\nOutput:\n"], 19),
      started(20),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.line, c.tool, c.category]), [[6, "exec_command", "missing-path"], [10, "wait", "port-in-use"]]);
    assert.deepStrictEqual(report.candidates.map((c) => c.nearbyReportedSuccesses.map((s) => s.line)), [[16], [16]]);
    assert.deepStrictEqual(report.navigationCandidates[0].observed.next.map((n) => [n.callLine, n.tool, n.outcome]), [
      [7, "exec", "pending"], [9, "wait", "failed"], [11, "wait", "unknown"], [13, "exec", "pending"],
    ]);
    // Cell 9 never completed; wait calls completed 7 and 8 and stopped 10.
    assert.deepStrictEqual([report.coverage.pending, report.coverage.outcomeUnknown], [1, 2]);
  });

  test("an empty result or another tool's result is unknown, and the host's own failure text is a failure", () => {
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("ask a reviewer, then push", 1),
      fn("c1", "spawn_agent", { agent_type: "reviewer", message: "review src/cart.js" }, 2),
      returned("c1", "collab spawn failed: agent thread limit reached (6)", 3),
      fn("c2", "send_message", { target: "agent-1", message: "status?" }, 4),
      returned("c2", "", 5),
      fn("c3", "wait_agent", { targets: ["agent-1"], timeout_ms: 30000 }, 6),
      returned("c3", '{"status":{},"timed_out":true}', 7),
      fn("c4", "exec_command", { cmd: "git push --force" }, 8),
      returned("c4", "Command blocked by PreToolUse hook: force pushes need the owner", 9),
      item(10, { type: "custom_tool_call", call_id: "c5", name: "apply_patch", input: "*** Begin Patch\n*** Delete File: src/legacy.js\n*** End Patch" }),
      item(11, { type: "custom_tool_call_output", call_id: "c5", output: "Command blocked by PreToolUse hook: deleting files needs approval" }),
      call("c6", "npm run e2e", 12),
      item(13, { type: "custom_tool_call_output", call_id: "c6", output: "aborted by user after 4.2s" }),
      started(14),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.line, c.tool, c.category]), [
      [6, "spawn_agent", "tool-error"], [12, "exec_command", "blocked"], [14, "apply_patch", "blocked"], [16, "exec", "interrupted"],
    ]);
    assert.strictEqual(report.coverage.outcomeUnknown, 2);
  });

  test("a script that patches files and runs a command is a write, so a file its command does not find is no failed edit", () => {
    const add = 'text(await tools.apply_patch("*** Begin Patch\\n*** Add File: src/basket.js\\n+export const total = 0;\\n*** End Patch"));';
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("rename the cart module", 1),
      script("c1", `${add}\ntext(await tools.exec_command({cmd: "cat docs/cart.md"}));`, 2),
      output("c1", [
        "Script completed\nWall time 0.3 seconds\nOutput:\n", "Success. Updated the following files:\nA src/basket.js",
        "Exit code: 1\nWall time: 0.1 seconds\nOutput:\ncat: docs/cart.md: No such file or directory",
      ], 3),
      // Patches alone are an edit, and a patch that cannot find its file is a missing path in both views.
      script("c2", `${patch("src/gone.js", "a", "b")}\n${patch("src/cart.js", "a", "b")}`, 4),
      output("c2", [
        "Script failed\nWall time 0.1 seconds\nOutput:\n",
        "Script error:\napply_patch verification failed: Failed to read file to update src/gone.js: No such file or directory (os error 2)",
      ], 5),
      started(6),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.line, c.operation, c.category]), [
      [6, "write", "nonzero-exit"], [8, "edit", "tool-script-failure"], [8, "edit", "missing-path"],
    ]);
    assert.deepStrictEqual(report.navigationCandidates.map((c) => [c.kind, c.observed.line, c.observed.operation]), [["missing-path", 8, "edit"]]);
    assert.deepStrictEqual([report.coverage.operations.edit, report.coverage.operations.write], [1, 1]);
  });

  test("a script still running or stopped is no success, whatever exit its finished commands print, and a wait reads as its script", () => {
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("build, test and check access", 1),
      fn("c1", "exec_command", { cmd: "cat docs/setup.md" }, 2),
      returned("c1", "Process exited with code 1\nOutput:\ncat: docs/setup.md: No such file or directory", 3),
      // A command that finished inside a script that runs on, or that was stopped, says nothing of the rest of it.
      script("c2", 'text(await tools.exec_command({cmd: "npm run build"}));\ntext(await tools.exec_command({cmd: "npm run e2e"}));', 4),
      output("c2", ["Script running with cell ID 5\nWall time 10.0 seconds\nOutput:\n", "Exit code: 0\nWall time: 3.0 seconds\nOutput:\nbuilt"], 5),
      fn("w1", "wait", { cell_id: "5", yield_time_ms: 30000 }, 6),
      returned("w1", ["Script completed\nWall time 20.0 seconds\nOutput:\n", "Exit code: 1\nWall time: 19.0 seconds\nOutput:\n2 failing"], 7),
      script("c3", 'text(await tools.exec_command({cmd: "npm run lint"}));\ntext(await tools.exec_command({cmd: "npm run serve"}));', 8),
      output("c3", ["Script running with cell ID 6\nWall time 10.0 seconds\nOutput:\n", "Exit code: 0\nWall time: 1.0 seconds\nOutput:\n0 problems"], 9),
      fn("w2", "wait", { cell_id: "6", terminate: true }, 10),
      returned("w2", ["Script terminated\nWall time 0.1 seconds\nOutput:\n", "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nstopped"], 11),
      // A wait that completes a vouched shell_command read prints that read's content.
      script("c4", 'text((await tools.shell_command({command: "cat docs/access.md"})).output);', 12),
      output("c4", ["Script running with cell ID 7\nWall time 10.0 seconds\nOutput:\n"], 13),
      fn("w3", "wait", { cell_id: "7" }, 14),
      returned("w3", ["Script completed\nWall time 0.1 seconds\nOutput:\n", "Permission denied until the owner grants access"], 15),
      started(16),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.line, c.tool, c.category]), [[6, "exec_command", "missing-path"], [10, "wait", "nonzero-exit"]]);
    assert.deepStrictEqual(report.candidates.map((c) => c.nearbyReportedSuccesses.map((s) => s.line)), [[18], [18]]);
    assert.deepStrictEqual(report.navigationCandidates[0].observed.next.map((n) => [n.callLine, n.tool, n.outcome]), [
      [7, "exec", "pending"], [9, "wait", "failed"], [11, "exec", "pending"], [13, "wait", "unknown"],
    ]);
    assert.deepStrictEqual([report.coverage.pending, report.coverage.outcomeUnknown], [0, 1]);
  });

  test("a script's code is read without its comments and literals, and one that may hide a call or drop a failure is not vouched for", () => {
    const completed = "Script completed\nWall time 0.1 seconds\nOutput:\n";
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("tidy the docs and the cart", 1),
      fn("f1", "exec_command", { cmd: "cat docs/usage.md" }, 2),
      returned("f1", "Process exited with code 1\nOutput:\ncat: docs/usage.md: No such file or directory", 3),
      // A patch's text is no code: a tool, a catch or a ${ inside it does not count, and an array of one string is no key.
      script("c1", `text(await tools.apply_patch("*** Begin Patch\\n*** Add File: docs/usage.md\\n+Run the suite with tools.exec_command({cmd: 'npm test'}).\\n*** End Patch"));`, 4),
      output("c1", [completed, "Success. Updated the following files:\nA docs/usage.md"], 5),
      script("c2", patch("src/cart.js", "  return total;", "  try { return `${total}`; } catch { return ''; }"), 6),
      output("c2", [completed, "Success. Updated the following files:\nM src/cart.js"], 7),
      script("c3", 'for (const change of ["*** Begin Patch\\n*** Delete File: src/old.js\\n*** End Patch"]) text(await tools.apply_patch(change));', 8),
      output("c3", [completed, "Success. Updated the following files:\nD src/old.js"], 9),
      // A quote a regex literal leaves unpaired can hide a catch, and a key in brackets can hide a tool.
      script("c4", `const plain = (s) => s.replace(/'/g, ""); try { text(await tools.apply_patch(change)); } catch (error) { text('patch skipped'); }`, 10),
      output("c4", [completed, "patch skipped"], 11),
      fn("f2", "exec_command", { cmd: "cat docs/deploy.md" }, 12),
      returned("f2", "Process exited with code 1\nOutput:\ncat: docs/deploy.md: No such file or directory", 13),
      script("c5", 'const t = globalThis["tools"];\nconst run = await t.exec_command({cmd: "npm run deploy"});\ntext(run.output);', 14),
      output("c5", [completed, 'npm error Missing script: "deploy"'], 15),
      // Promise.any and Promise.race settle without the failures they drop.
      script("c6", "await Promise.any([tools.apply_patch(first), tools.apply_patch(second)]);", 16),
      output("c6", [completed], 17),
      script("c7", "await Promise.race([tools.apply_patch(first), tools.apply_patch(second)]);", 18),
      output("c7", [completed], 19),
      started(20),
    ]));
    assert.deepStrictEqual(report.navigationCandidates.map((c) => c.observed.next.map((n) => [n.callLine, n.operation, n.outcome])), [
      [[7, "edit", "ok"], [9, "edit", "ok"], [11, "edit", "ok"], [13, "edit", "unknown"]],
      [[17, "other", "unknown"], [19, "edit", "unknown"], [21, "edit", "unknown"]],
    ]);
    assert.deepStrictEqual([report.coverage.operations.edit, report.coverage.operations.write, report.coverage.outcomeUnknown], [6, 0, 4]);
  });

  test("a script that reaches its tools through the global object or Reflect, or whose regex literal opens a comment, is not vouched for", () => {
    const completed = "Script completed\nWall time 0.1 seconds\nOutput:\n";
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("deploy and fix the links", 1),
      fn("f1", "exec_command", { cmd: "cat docs/deploy.md" }, 2),
      returned("f1", "Process exited with code 1\nOutput:\ncat: docs/deploy.md: No such file or directory", 3),
      // A key after a space, or one computed at run time, reaches the tools as surely as a string key does.
      script("c1", 'const t = globalThis ["tools"];\nconst run = await t.exec_command({cmd: "npm run deploy"});\ntext(run.output);', 4),
      output("c1", [completed, 'npm error Missing script: "deploy"'], 5),
      script("c2", 'const key = "tools";\nconst run = await globalThis[key].exec_command({cmd: "npm run deploy"});\ntext(run.output);', 6),
      output("c2", [completed, 'npm error Missing script: "deploy"'], 7),
      script("c3", 'const t = Reflect.get(self, "tools");\ntext((await t.exec_command({cmd: "npm run deploy"})).output);', 8),
      output("c3", [completed, 'npm error Missing script: "deploy"'], 9),
      script("c4", 'const t = self["tools"];\ntext((await t.exec_command({cmd: "npm run deploy"})).output);', 10),
      output("c4", [completed, 'npm error Missing script: "deploy"'], 11),
      fn("f2", "exec_command", { cmd: "cat docs/links.md" }, 12),
      returned("f2", "Process exited with code 1\nOutput:\ncat: docs/links.md: No such file or directory", 13),
      // An escaped slash before a slash or a star opens a comment that would hide the rest of the line.
      script("c5", String.raw`const rel = file.replace(/\//g, "\\"); text((await tools.exec_command({cmd: "npm run deploy"})).output);`, 14),
      output("c5", [completed, 'npm error Missing script: "deploy"'], 15),
      script("c6", 'const re = /\\//; text(`${await tools.apply_patch(change).catch(() => "patch skipped")}`);', 16),
      output("c6", [completed, "patch skipped"], 17),
      script("c7", 'const re = /https?:\\/\\//; try { text(await tools.apply_patch(change)); } catch (error) { text("patch skipped"); }', 18),
      output("c7", [completed, "patch skipped"], 19),
      script("c8", 'const glob = /src\\/*/; text((await tools.exec_command({cmd: "npm run deploy"})).output); const any = /x*/;', 20),
      output("c8", [completed, 'npm error Missing script: "deploy"'], 21),
      started(22),
    ]));
    assert.deepStrictEqual(report.navigationCandidates.map((c) => c.observed.next.map((n) => [n.callLine, n.operation, n.outcome])), [
      [[7, "other", "unknown"], [9, "other", "unknown"], [11, "other", "unknown"], [13, "other", "unknown"]],
      [[17, "command", "unknown"], [19, "edit", "unknown"], [21, "edit", "unknown"], [23, "command", "unknown"]],
    ]);
    assert.deepStrictEqual([report.coverage.outcomeUnknown, report.candidates.length], [8, 2]);
  });

  test("a completed script that prints fewer exit codes than its exec_command and write_stdin calls is unknown, not ok", () => {
    const completed = "Script completed\nWall time 0.4 seconds\nOutput:\n";
    const exit = (code, text) => `Exit code: ${code}\nWall time: 0.1 seconds\nOutput:\n${text}`;
    const missingFile = (file) => `Process exited with code 1\nOutput:\ncat: ${file}: No such file or directory`;
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("build, migrate and release", 1),
      fn("f1", "exec_command", { cmd: "cat docs/release.md" }, 2), returned("f1", missingFile("docs/release.md"), 3),
      // The second command's exit is not printed, so it may have failed.
      script("c1", 'const build = await tools.exec_command({cmd: "npm run build"});\nconst tests = await tools.exec_command({cmd: "npm test"});\ntext(build);', 4),
      output("c1", [completed, exit(0, "built")], 5),
      // A call a string names is no call.
      script("c2", 'text(await tools.exec_command({cmd: "npm run build"}));\ntext(await tools.exec_command({cmd: "npm test"}));\n'
        + "text(\"Release with tools.exec_command({cmd: 'npm run release'}) once both pass.\");", 6),
      output("c2", [completed, exit(0, "built"), exit(0, "# pass 4"), "Release with tools.exec_command({cmd: 'npm run release'}) once both pass."], 7),
      // write_stdin returns the exit of the process it writes to, and this script does not print it.
      script("c3", 'text(await tools.exec_command({cmd: "npm run migrate:status"}));\nawait tools.write_stdin({session_id: 7, chars: "\\u0003"});', 8),
      output("c3", [completed, exit(0, "3 applied")], 9),
      // shell_command throws on a nonzero exit, so a completed script need not print it.
      script("c4", 'text(await tools.exec_command({cmd: "npm run build"}));\nawait tools.shell_command({command: "npm test"});', 10),
      output("c4", [completed, exit(0, "built")], 11),
      fn("f2", "exec_command", { cmd: "cat docs/deploy.md" }, 12), returned("f2", missingFile("docs/deploy.md"), 13),
      // A printed nonzero exit fails the result, whatever else went unprinted.
      script("c5", 'text(await tools.exec_command({cmd: "npm test"}));\nawait tools.exec_command({cmd: "npm run deploy"});', 14),
      output("c5", [completed, exit(1, "1 failing")], 15),
      // The exits a running script printed count with those printed when a wait completes it.
      script("c6", 'text(await tools.exec_command({cmd: "npm run build"}));\ntext(await tools.exec_command({cmd: "npm run e2e"}));', 16),
      output("c6", ["Script running with cell ID 4\nWall time 10.0 seconds\nOutput:\n", exit(0, "built")], 17),
      fn("w1", "wait", { cell_id: "4" }, 18), returned("w1", [completed, exit(0, "3 passing")], 19),
      fn("f3", "exec_command", { cmd: "cat docs/e2e.md" }, 20), returned("f3", missingFile("docs/e2e.md"), 21),
      script("c7", 'text(await tools.exec_command({cmd: "npm run build"}));\nawait tools.exec_command({cmd: "npm run lint"});\n'
        + 'text(await tools.exec_command({cmd: "npm run e2e"}));', 22),
      output("c7", ["Script running with cell ID 5\nWall time 10.0 seconds\nOutput:\n", exit(0, "built")], 23),
      fn("w2", "wait", { cell_id: "5" }, 24), returned("w2", [completed, exit(0, "3 passing")], 25),
      // A failed script is read as before: its failure stands, and a command it printed as exiting 0 is a success.
      script("c8", 'text(await tools.exec_command({cmd: "npm run build"}));\nawait tools.exec_command({cmd: "npm run deploy"});\n'
        + "await tools.apply_patch(change);", 26),
      output("c8", ["Script failed\nWall time 0.3 seconds\nOutput:\n", exit(0, "built"), "Script error:\napply_patch verification failed: Failed to find expected lines"], 27),
      started(28),
    ]));
    assert.deepStrictEqual(report.navigationCandidates.map((c) => c.observed.next.map((n) => [n.callLine, n.outcome])), [
      [[7, "unknown"], [9, "ok"], [11, "unknown"], [13, "ok"]],
      [[17, "failed"], [19, "pending"], [21, "ok"], [23, "failed"]],
      [[25, "pending"], [27, "unknown"], [29, "failed"]],
    ]);
    assert.deepStrictEqual(report.candidates.map((c) => [c.line, c.category, c.nearbyReportedSuccesses.map((s) => s.line)]), [
      [6, "missing-path", [10, 14]], [16, "missing-path", [22, 30]], [18, "nonzero-exit", [22, 30]], [24, "missing-path", [30]],
      [30, "tool-script-failure", []], [30, "tool-script-failure", []],
    ]);
    assert.deepStrictEqual([report.coverage.outcomeUnknown, report.coverage.pending], [3, 0]);
  });

  test("a result that prints several exit codes of 0 is one later success, and its first part stands for it", () => {
    const completed = "Script completed\nWall time 0.4 seconds\nOutput:\n";
    const exit = (text) => `Exit code: 0\nWall time: 0.1 seconds\nOutput:\n${text}`;
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("fix the build", 1),
      call("c1", "npm test", 2),
      output("c1", [completed, "Exit code: 1\nWall time: 0.9 seconds\nOutput:\n1 failing"], 3),
      script("c2", 'text(await tools.exec_command({cmd: "npm run build"}));\ntext(await tools.exec_command({cmd: "npm run lint"}));\n'
        + 'text(await tools.exec_command({cmd: "npm test"}));', 4),
      output("c2", [completed, exit("built"), exit("0 problems"), exit("# pass 4")], 5),
      // A result with one exit of 0 is a later success as it was.
      call("c3", "npm run e2e", 6),
      output("c3", [completed, exit("3 passing")], 7),
      started(8),
    ]));
    assert.deepStrictEqual(report.candidates[0].nearbyReportedSuccesses.map((s) => [s.line, s.callLine, s.outputExcerpt]), [
      [8, 7, exit("built")], [10, 9, exit("3 passing")],
    ]);
  });
});

describe("a Codex turn that stopped for a continue", () => {
  // The assistant's message, and the event Codex writes beside it with the same text.
  const says = (text, second) => item(second, { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  const event = (text, second) => ({ timestamp: at(second), type: "event_msg", payload: { type: "agent_message", message: text } });
  const typed = (text, second) => ({ timestamp: at(second), type: "event_msg", payload: { type: "user_message", message: text } });
  // A task of work, its final text, a task the owner's next prompt starts, and the audit's own task as the cutoff.
  const stalled = (ending, next, work = [call("c1", "npm test", 3), output("c1", ["Exit code: 0\nOutput:\n# pass 4"], 4)]) => analyzeCodex(transcript([
    meta, started(1), turn(1), message("fix the cart total", 2), ...work, says(ending, 5), event(ending, 5),
    started(6), message(next, 6), typed(next, 6), call("c9", "npm test", 7), output("c9", ["Exit code: 0\nOutput:\n# pass 4"], 8),
    started(9), message("audit this session", 9),
  ]));

  test("an offer to go on, a question and a list of next steps, each followed by a bare continue, are stall candidates", () => {
    const endings = [
      ["The cart total rounds to the cent. Want me to continue with the checkout page?", "continue", "offer"],
      ["I rounded the cart total. ¿Redondeo también el total del pedido?", "dale, sigue", "question"],
      ["The cart is done.\n\nRemaining:\n- Round the order total\n- Update the checkout test", "proceed", "next-steps"],
    ];
    for (const [ending, next, shape] of endings) {
      const report = stalled(ending, next);
      assert.deepStrictEqual(report.stallCounts, { [shape]: 1 }, ending);
      const [candidate] = report.stallCandidates;
      assert.deepStrictEqual([candidate.observed.ending, candidate.scope, candidate.observed.line, candidate.observed.promptLine], [shape, "machine", 7, 4]);
      assert.strictEqual(candidate.observed.nextPromptLine, 10, "the first of the prompt's two records");
    }
    const command = stalled("Want me to run `cargo test --workspace` now?", "go on").stallCandidates[0];
    assert.deepStrictEqual([command.scope, command.observed.projectCommands], ["map-file", ["cargo test --workspace"]]);
  });

  test("a question the owner answers, a continue after a failed command and a task that ends on a finished result are not", () => {
    const failed = [call("c1", "npm test", 3), output("c1", ["Exit code: 1\nOutput:\n1 failing"], 4)];
    const quiet = [
      stalled("I rounded the cart total. Should the order total round the same way?", "No, leave the order total alone."),
      stalled("The suite fails on the cart total. Want me to look into it?", "continue", failed),
      stalled("Done: the cart total rounds to the cent and the tests pass.", "continue"),
    ];
    for (const report of quiet) assert.deepStrictEqual([report.stallCounts, report.stallCandidates], [{}, []]);
  });
});
