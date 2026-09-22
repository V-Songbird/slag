"use strict";

// The session evidence script on synthetic Codex rollouts that carry the host's own records of commands and server
// tool calls: which call a record belongs to, what it settles, and what it never decides.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const { analyzeCodex } = require("../scripts/session-evidence.js");
const { transcript, at, meta, started, turn, item, message, output, script, fn, returned } = require("./session-transcripts.js");

describe("a Codex rollout", () => {
  // The host writes its own record of each command and server tool call, beside the call's result.
  const wrote = (second, what, thread) => ({
    timestamp: at(second), type: "event_msg", payload: { type: "item_completed", item: what, ...(thread ? { thread_id: thread } : {}) },
  });
  const ran = (id, command, code, out, secs = 1) => ({
    id, type: "CommandExecution", command: ["pwsh.exe", "-Command", command], exit_code: code, status: code === 0 ? "completed" : "failed",
    aggregated_output: out, duration: { secs, nanos: 0 }, source: "unified_exec_startup",
  });
  const called = (id, tool, isError) => ({
    id, type: "McpToolCall", server: "node_repl", tool, status: isError ? "failed" : "completed", duration: { secs: 1, nanos: 0 },
    result: { content: [{ type: "text", text: isError ? "ReferenceError: boom is not defined" : "2" }], isError },
  });
  const two = (first, second) => `text(await tools.exec_command({cmd: ${JSON.stringify(first)}}));\nawait tools.exec_command({cmd: ${JSON.stringify(second)}});`;

  test("the host's own record settles a result its text leaves unknown, and reveals a failure the script did not print", () => {
    const completed = "Script completed\nWall time 0.4 seconds\nOutput:\n";
    const exit = (code, text) => `Exit code: ${code}\nWall time: 0.1 seconds\nOutput:\n${text}`;
    const missingFile = (file) => `Process exited with code 1\nOutput:\ncat: ${file}: No such file or directory`;
    const js = (id, code, second) => item(second, { type: "function_call", call_id: id, name: "js", arguments: JSON.stringify({ code }) });
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("build, deploy and try the REPL", 1),
      fn("f1", "exec_command", { cmd: "cat docs/missing.md" }, 2), returned("f1", missingFile("docs/missing.md"), 3),
      // Records that cover the script's calls settle a result the printed exit codes leave unknown.
      script("c1", two("npm run build", "npm test"), 4),
      wrote(5, ran("exec-1", "npm run build", 0, "built")),
      wrote(6, ran("exec-2", "npm test", 0, "# pass 4")),
      output("c1", [completed, exit(0, "built")], 7),
      // The record of a command the script did not print reveals its failure.
      script("c2", two("npm run build", "npm test"), 8),
      wrote(9, ran("exec-3", "npm run build", 0, "built")),
      wrote(10, ran("exec-4", "npm test", 1, "1 failing")),
      output("c2", [completed, exit(0, "built")], 11),
      // With two calls open, no record belongs to either beyond doubt, and the doubt covers what they own already.
      script("c3", 'await tools.exec_command({cmd: "npm run lint"});', 12),
      wrote(13, ran("exec-5", "npm run lint", 0, "0 problems")),
      script("c4", 'await tools.exec_command({cmd: "npm run types"});', 14),
      wrote(15, ran("exec-6", "npm run types", 0, "clean")),
      output("c3", [completed, "checked"], 16),
      output("c4", [completed, "checked"], 17),
      fn("f2", "exec_command", { cmd: "cat docs/deploy.md" }, 18), returned("f2", missingFile("docs/deploy.md"), 19),
      // A candidate the text alone found keeps its place, with what the records say of the call.
      script("c5", 'text(await tools.exec_command({cmd: "npm run deploy"}));', 20),
      wrote(21, ran("exec-7", "npm run deploy", 0, "deployed")),
      output("c5", [completed, exit(0, "Permission denied while writing the cache")], 22),
      // A command that started before the call was open belongs to an earlier run.
      script("c6", 'await tools.exec_command({cmd: "npm run dev"});', 23),
      wrote(27, ran("exec-8", "npm run dev", 1, "EADDRINUSE", 10)),
      output("c6", [completed, "starting"], 28),
      // A record that names its call settles a js call, which prints no exit code of its own.
      js("j1", "1 + 1", 29), wrote(30, called("j1", "js", false)),
      item(31, { type: "function_call_output", call_id: "j1", output: "Wall time: 1 seconds\nOutput:\n2" }),
      js("j2", "boom()", 32), wrote(33, called("j2", "js", true)),
      item(34, { type: "function_call_output", call_id: "j2", output: "Wall time: 1 seconds\nOutput:\nReferenceError" }),
      started(35),
    ]));
    assert.deepStrictEqual(report.navigationCandidates.map((c) => c.observed.next.map((n) => [n.callLine, n.outcome])), [
      [[7, "ok"], [11, "failed"], [15, "unknown"], [17, "unknown"]],
      [[23, "failed"], [26, "unknown"], [29, "ok"], [32, "failed"]],
    ]);
    assert.deepStrictEqual(report.candidates.map((c) => [c.line, c.category, c.evidenceBasis, c.exitCode, c.hostRecord ?? null]), [
      [6, "missing-path", "reported-nonzero-exit", 1, null],
      [14, "nonzero-exit", "host-record", 1, null],
      [22, "missing-path", "reported-nonzero-exit", 1, null],
      [25, "permission-denied", "diagnostic-text-match-only", 0, "For this call the host recorded 1 command that exited 0."],
      [34, "tool-error", "host-record", null, null],
    ]);
    assert.strictEqual(report.candidates[1].diagnosticCandidate, "1 failing");
    assert.strictEqual(report.candidates[4].diagnosticCandidate, "ReferenceError: boom is not defined");
    assert.deepStrictEqual([report.coverage.recordedOutcomes, report.coverage.outcomeUnknown], [4, 3]);
  });

  test("the records a running script left count when a wait completes it", () => {
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("build in the background", 1),
      script("c1", two("npm run build", "npm test"), 2),
      wrote(3, ran("exec-1", "npm run build", 0, "built")),
      output("c1", ["Script running with cell ID 4\nWall time 10.0 seconds\nOutput:\n"], 4),
      fn("w1", "wait", { cell_id: "4" }, 5),
      wrote(6, ran("exec-2", "npm test", 0, "# pass 4")),
      returned("w1", ["Script completed\nWall time 0.4 seconds\nOutput:\n", "done"], 7),
      started(8),
    ]));
    assert.deepStrictEqual([report.coverage.recordedOutcomes, report.coverage.pending, report.coverage.outcomeUnknown], [1, 0, 0]);
  });

  test("records that leave a call of the script unaccounted for settle nothing", () => {
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("build and test", 1),
      script("c1", two("npm run build", "npm test"), 2),
      wrote(3, ran("exec-1", "npm run build", 0, "built")),
      output("c1", ["Script completed\nWall time 0.4 seconds\nOutput:\n", "built"], 4),
      started(5),
    ]));
    assert.deepStrictEqual([report.coverage.recordedOutcomes, report.coverage.outcomeUnknown, report.candidates.length], [0, 1, 0]);
  });

  test("a script that can drop the failure of a call no record covers is not settled by its commands' records", () => {
    const completed = "Script completed\nWall time 0.4 seconds\nOutput:\n";
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("patch and test", 1),
      // apply_patch leaves no record, and the catch hides how it ended.
      script("c1", 'try {\n  await tools.apply_patch(change);\n} catch (error) {\n  text("patch skipped");\n}\n'
        + 'text(await tools.exec_command({cmd: "npm test"}));', 2),
      wrote(3, ran("exec-1", "npm test", 0, "# pass 4")),
      output("c1", [completed, "patch skipped"], 4),
      // The same records settle a script that drops nothing.
      script("c2", 'await tools.apply_patch(change);\ntext(await tools.exec_command({cmd: "npm test"}));', 5),
      wrote(6, ran("exec-2", "npm test", 0, "# pass 4")),
      output("c2", [completed, "patched"], 7),
      started(8),
    ]));
    assert.deepStrictEqual([report.coverage.recordedOutcomes, report.coverage.outcomeUnknown], [1, 1]);
  });

  test("a record settles no call while another cell is running, since the command may be that cell's", () => {
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("watch and test", 1),
      script("c1", 'await tools.exec_command({cmd: "npm test"});', 2),
      output("c1", ["Script running with cell ID 7\nWall time 10.0 seconds\nOutput:\n"], 3),
      script("c2", 'await tools.exec_command({cmd: "npm run watch"});', 4),
      output("c2", ["Script running with cell ID 8\nWall time 10.0 seconds\nOutput:\n"], 5),
      fn("w1", "wait", { cell_id: "7" }, 6),
      wrote(7, ran("exec-1", "npm run watch", 1, "watch crashed")),
      returned("w1", ["Script completed\nWall time 0.4 seconds\nOutput:\n", "done"], 8),
      started(9),
    ]));
    assert.deepStrictEqual([report.coverage.recordedOutcomes, report.coverage.outcomeUnknown, report.candidates.length], [0, 1, 0]);
  });

  test("a record with no call open belongs to the only cell still running when its script spells out what ran", () => {
    const completed = "Script completed\nWall time 0.4 seconds\nOutput:\n";
    const running = (cell) => [`Script running with cell ID ${cell}\nWall time 10.0 seconds\nOutput:\n`];
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("build in the background", 1),
      script("c1", `${two("npm run build", "npm test")}\nawait tools.mcp__node_repl__js({code: "1 + 1"});`, 2),
      output("c1", running(4), 3),
      // No call is open, and the only cell running spells out both commands and calls the server tool.
      wrote(4, ran("exec-1", "npm run build", 0, "built")),
      wrote(5, ran("exec-2", "npm test", 0, "# pass 4")),
      wrote(6, called("t-1", "js", false)),
      fn("w1", "wait", { cell_id: "4" }, 7),
      returned("w1", [completed, "done"], 8),
      // A command the cell's script never spells out belongs to nobody, and leaves its call uncovered.
      script("c2", two("npm run lint", "npm run types"), 9),
      output("c2", running(9), 10),
      wrote(11, ran("exec-3", "rg --files docs", 0, "docs/index.md")),
      wrote(12, ran("exec-4", "npm run lint", 0, "0 problems")),
      fn("w2", "wait", { cell_id: "9" }, 13),
      returned("w2", [completed, "done"], 14),
      // Nor does one the script spells out that began before the script was called.
      script("c3", 'await tools.exec_command({cmd: "npm run dev"});', 15),
      output("c3", running(12), 16),
      wrote(20, ran("exec-5", "npm run dev", 1, "EADDRINUSE", 10)),
      fn("w3", "wait", { cell_id: "12" }, 21),
      returned("w3", [completed, "done"], 22),
      // Nor, with two cells running, one that either script could have run.
      script("c4", 'await tools.exec_command({cmd: "npm run e2e"});', 23),
      output("c4", running(15), 24),
      script("c5", 'await tools.exec_command({cmd: "npm run e2e"});', 25),
      output("c5", running(16), 26),
      wrote(27, ran("exec-6", "npm run e2e", 1, "1 failing")),
      fn("w4", "wait", { cell_id: "15" }, 28),
      returned("w4", [completed, "done"], 29),
      fn("w5", "wait", { cell_id: "16" }, 30),
      returned("w5", [completed, "done"], 31),
      // Nor one that only a shell_command spells out, since that tool leaves no record.
      script("c6", 'text(await tools.shell_command({command: "npm run check"}));', 32),
      output("c6", running(18), 33),
      wrote(35, ran("exec-7", "npm run check", 1, "1 failing")),
      fn("w6", "wait", { cell_id: "18" }, 36),
      returned("w6", [completed, "done"], 37),
      // A wait that finds the script still running leaves its start where it was, so a command begun before the wait
      // is still the script's.
      script("c7", 'await tools.exec_command({cmd: "npm run bench"});', 38),
      output("c7", running(20), 39),
      fn("w7", "wait", { cell_id: "20" }, 40),
      returned("w7", running(20), 42),
      wrote(44, ran("exec-8", "npm run bench", 0, "fast", 5)),
      fn("w8", "wait", { cell_id: "20" }, 45),
      returned("w8", [completed, "done"], 46),
      started(47),
    ]));
    assert.deepStrictEqual([report.coverage.recordedOutcomes, report.coverage.outcomeUnknown, report.candidates.length], [2, 4, 0]);
  });

  test("a record another agent may have run decides nothing: its thread tells, and without one the script must spell it out", () => {
    const completed = "Script completed\nWall time 0.4 seconds\nOutput:\n";
    const agent = (second, kind, thread = "t1") => wrote(second, { id: `sa-${second}`, type: "SubAgentActivity", kind, agent_thread_id: thread, agent_path: "reviewer" });
    const report = analyzeCodex(transcript([
      // A rollout can hold a second session_meta; the records of its own work carry the first one's id.
      meta, { timestamp: at(0), type: "session_meta", payload: { id: "thread-0", cwd: "/work/shop" } },
      started(1), turn(1), message("test while the reviewer works", 1),
      // A record another thread ran is never this session's, even of a command the script spells out.
      script("c0", 'text(await tools.exec_command({cmd: "npm test"}));', 2),
      wrote(3, ran("exec-0", "npm test", 1, "1 failing"), "thread-9"),
      wrote(4, ran("exec-00", "npm test", 0, "# pass 4"), "thread-1"),
      output("c0", [completed, "tested"], 5),
      agent(6, "started"),
      // The reviewer's command falls inside this call's window, names no thread and failed; the script names only its own.
      script("c1", 'text(await tools.exec_command({cmd: "npm test"}));', 7),
      wrote(8, ran("exec-1", "rg --files-with-matches TODO", 1, "no matches")),
      wrote(9, ran("exec-2", "npm test", 0, "# pass 4")),
      output("c1", [completed, "tested"], 10),
      // A record that names the session's own thread is its own, whoever else is at work.
      script("c2", 'await tools.exec_command({cmd: "npm run lint"});', 11),
      wrote(12, ran("exec-3", "rg --files lib", 1, "no matches"), "thread-1"),
      output("c2", [completed, "linting"], 13),
      // Once the reviewer has finished, the window alone settles again, and the candidate names the command.
      agent(14, "completed"),
      script("c3", 'await tools.exec_command({cmd: "npm run build"});', 15),
      wrote(16, ran("exec-4", "rg --files src", 1, "no matches")),
      output("c3", [completed, "building"], 17),
      // A thread the session speaks to is at work, even when the rollout never shows it start.
      agent(18, "interacted", "t5"),
      script("c4", 'await tools.exec_command({cmd: "npm run types"});', 19),
      wrote(20, ran("exec-5", "rg --files tests", 1, "no matches")),
      output("c4", [completed, "checking"], 21),
      // A session that handed work to agents of its own is in the same doubt from then on.
      agent(22, "interrupted", "t5"),
      wrote(23, { id: "cc-1", type: "CollabAgentToolCall", tool: "wait", status: "completed", sender_thread_id: "t2", receiver_thread_ids: ["t3"] }),
      script("c5", 'await tools.exec_command({cmd: "npm run e2e"});', 24),
      wrote(25, ran("exec-6", "rg --files e2e", 1, "no matches")),
      output("c5", [completed, "testing"], 26),
      started(27),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.category, c.evidenceBasis, c.recordedCommand, c.diagnosticCandidate]), [
      ["nonzero-exit", "host-record", "pwsh.exe -Command rg --files lib", "no matches"],
      ["nonzero-exit", "host-record", "pwsh.exe -Command rg --files src", "no matches"],
    ]);
    assert.deepStrictEqual([report.coverage.recordedOutcomes, report.coverage.outcomeUnknown], [4, 2]);
  });

  test("the host's own start time decides whether a run began after its call, where it differs beyond clock rounding", () => {
    const completed = "Script completed\nWall time 0.4 seconds\nOutput:\n";
    const ms = (second) => Date.parse(at(second));
    const timed = (second, what, startedAt) => {
      const row = wrote(second, what);
      row.payload.started_at_ms = startedAt;
      return row;
    };
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("run the checks", 1),
      // The record's time less its duration falls after the call, but the host started the run before it.
      script("c1", 'await tools.exec_command({cmd: "npm run lint"});', 5),
      timed(7, ran("exec-1", "npm run lint", 1, "1 problem"), ms(3)),
      output("c1", [completed, "linting"], 8),
      // A start the host kept after the call still settles the result.
      script("c2", 'await tools.exec_command({cmd: "npm run types"});', 9),
      timed(11, ran("exec-2", "npm run types", 1, "1 error"), ms(9) + 500),
      output("c2", [completed, "checking"], 12),
      // Within clock rounding the record's time less its duration stands, even on the other side of the call.
      script("c3", 'await tools.exec_command({cmd: "npm run e2e"});', 13),
      timed(14, ran("exec-3", "npm run e2e", 1, "1 failing"), ms(13) - 1),
      output("c3", [completed, "testing"], 15),
      started(16),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.evidenceBasis, c.recordedCommand]), [
      ["host-record", "pwsh.exe -Command npm run types"], ["host-record", "pwsh.exe -Command npm run e2e"],
    ]);
    assert.deepStrictEqual([report.coverage.recordedOutcomes, report.coverage.outcomeUnknown], [2, 1]);
  });

  test("a rollout that carries no records reads as it did, and settles nothing by them", () => {
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("build and test", 1),
      script("c1", two("npm run build", "npm test"), 2),
      output("c1", ["Script completed\nWall time 0.4 seconds\nOutput:\n", "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nbuilt"], 3),
      started(4),
    ]));
    assert.deepStrictEqual([report.coverage.recordedOutcomes, report.coverage.outcomeUnknown, report.candidates.length], [0, 1, 0]);
  });
});
