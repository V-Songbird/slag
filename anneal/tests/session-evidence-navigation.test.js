"use strict";

// The session evidence script's navigation candidates, on synthetic transcripts of both hosts.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const { transcript, at, human, use, result, typed, meta, started, turn, item, message, call, output } = require("./session-transcripts.js");
const { analyzeClaude, analyzeCodex } = require("../scripts/session-evidence.js");

// Each pair holds the case that supports a change beside the one that must not. The host shapes follow the records
// Claude Code and Codex write; every path, command and text in them is made up.
describe("navigation candidates", () => {
  const MISSING = "<tool_use_error>File does not exist.</tool_use_error>";
  const UNCHANGED = "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.";
  const causes = (report, kind) => report.navigationCandidates.filter((c) => c.kind === kind).map((c) => [c.candidateCause, c.scope]);
  // A call written as its own record under a shared assistant message id, as Claude Code writes parallel calls.
  const from = (messageId, id, name, input, second) => ({
    type: "assistant", timestamp: at(second), message: { id: messageId, model: "model-x", content: [{ type: "tool_use", id, name, input }] },
  });
  // Claude Code's notice that it showed only part of a Read, in the record after the result.
  const truncation = (id, second, banner) => ({
    type: "attachment", timestamp: at(second), attachment: { type: "read_truncation_notice", toolUseID: id, banner },
  });
  // A result Claude Code saved to a file, keeping a 2 KB preview in the transcript.
  const persisted = (kb, saved = "/home/dev/.claude/projects/shop/s1/tool-results/t1.txt", unit = "KB") => `<persisted-output>\n`
    + `Output too large (${kb}${unit}). Full output saved to: ${saved}\n\nPreview (first 2KB):\n${"p".repeat(2000)}\n...\n</persisted-output>`;

  test("a missing path its actor then finds under the same name is a detour, and another actor's or another task's find is not", () => {
    const detour = analyzeClaude(transcript([
      human("fix the cart total", 1),
      use("a", "Read", { file_path: "/work/shop/src/cart.js" }, 2),
      result("a", MISSING, 3, true),
      use("b", "Glob", { pattern: "**/cart.js" }, 4),
      result("b", "/work/shop/lib/cart.js", 5),
      use("c", "Read", { file_path: "/work/shop/lib/cart.js" }, 6),
      result("c", "export const total = 1;", 7),
      human("audit", 8),
    ]));
    const [found] = detour.navigationCandidates;
    // What the transcript shows stays apart from the cause it might have.
    assert.deepStrictEqual(Object.keys(found), ["kind", "observed", "candidateCause", "scope", "intervention", "verification"]);
    assert.deepStrictEqual([found.kind, found.candidateCause, found.scope], ["missing-path", "wrong-location", "map-file"]);
    const { observed } = found;
    assert.deepStrictEqual([observed.line, observed.callLine, observed.promptLine, observed.phase, observed.path, observed.resultExcerpt], [
      3, 2, 1, "orientation", "/work/shop/src/cart.js", MISSING,
    ]);
    assert.deepStrictEqual(observed.next.map((n) => [n.line, n.callLine, n.tool, n.operation, n.path, n.outcome]), [
      [5, 4, "Glob", "search", "/work/shop", "ok"], [7, 6, "Read", "read", "/work/shop/lib/cart.js", "ok"],
    ]);
    assert.ok(found.intervention.includes("path hint") && found.verification.length > 0);

    const agent = { isSidechain: true, agentId: "agent-7" };
    const elsewhere = analyzeClaude(transcript([
      typed("fix the cart total", 1),
      use("a", "Read", { file_path: "/work/shop/src/cart.js" }, 2),
      result("a", MISSING, 3, true),
      typed("Find the cart module", 4, agent),
      use("b", "Read", { file_path: "/work/shop/lib/cart.js" }, 5, agent),
      result("b", "export const total = 1;", 6, false, agent),
      typed("now check the tax", 7),
      use("c", "Read", { file_path: "/work/shop/lib/cart.js" }, 8),
      result("c", "export const total = 1;", 9),
      typed("audit", 10),
    ]));
    const [lost] = elsewhere.navigationCandidates;
    assert.deepStrictEqual([lost.kind, lost.candidateCause, lost.scope, lost.observed.next], ["missing-path", "unknown", "none", []]);
    assert.match(lost.intervention, /^No change/);

    // With no prompt on either side, the actor alone tells the work apart.
    const unprompted = analyzeClaude(transcript([
      use("a", "Read", { file_path: "/work/shop/src/cart.js" }, 1),
      result("a", MISSING, 2, true),
      use("b", "Read", { file_path: "/work/shop/lib/cart.js" }, 3, agent),
      result("b", "export const total = 1;", 4, false, agent),
    ]), new Date(at(30)));
    assert.deepStrictEqual(causes(unprompted, "missing-path"), [["unknown", "none"]]);
  });

  test("a call issued beside a missing read did not follow it, and one issued after its result did", () => {
    const rows = (parallel) => [
      human("check the cart", 1),
      use("a", "Read", { file_path: "/work/shop/src/cart.js" }, 2),
      ...(parallel ? [use("b", "Read", { file_path: "/work/shop/lib/cart.js" }, 2)] : []),
      result("a", MISSING, 3, true),
      ...(parallel ? [] : [use("b", "Read", { file_path: "/work/shop/lib/cart.js" }, 4)]),
      result("b", "export const cart = [];", 5),
      human("audit", 6),
    ];
    assert.deepStrictEqual(causes(analyzeClaude(transcript(rows(true))), "missing-path"), [["unknown", "none"]]);
    assert.deepStrictEqual(causes(analyzeClaude(transcript(rows(false))), "missing-path"), [["wrong-location", "map-file"]]);
  });

  test("an empty search is a negative check, and a search of a path that does not exist is a missing path", () => {
    const report = analyzeClaude(transcript([
      human("rename calcTot to calculateOrderTotal", 1),
      use("t1", "Grep", { pattern: "calcTot", path: "src" }, 2),
      result("t1", "No matches found", 3),
      use("t2", "Bash", { command: "rg -n calcTot src" }, 4),
      result("t2", "Exit code 1", 5, true),
      use("t3", "Bash", { command: "rg -n calcTot srcs" }, 6),
      result("t3", "Exit code 2\nrg: srcs: No such file or directory (os error 2)", 7, true),
      human("audit", 8),
    ]));
    assert.deepStrictEqual(report.navigationCandidates.map((c) => [c.kind, c.observed.callLine, c.observed.operation, c.observed.path]), [
      ["missing-path", 6, "search", "/work/shop/srcs"],
    ]);
    assert.deepStrictEqual(report.navigationCounts, { "missing-path": 1 });
  });

  test("a guard block and an interrupt are the harness working, and a read of a missing file is not", () => {
    const report = (text) => analyzeClaude(transcript([
      human("load the settings", 1),
      use("t1", "Read", { file_path: "/work/shop/config/settings.json" }, 2),
      result("t1", text, 3, true),
      use("t2", "Read", { file_path: "/work/shop/settings.json" }, 4),
      result("t2", "{}", 5),
      human("audit", 6),
    ]));
    const blocked = report("PreToolUse:Read hook error: [guard]: reading config/ is blocked by policy");
    const declined = report("The user doesn't want to proceed with this tool use. The tool use was rejected.");
    assert.deepStrictEqual([blocked.navigationCandidates, declined.navigationCandidates], [[], []]);
    assert.deepStrictEqual([blocked.candidates[0].category, declined.candidates[0].category], ["blocked", "user-declined"]);
    assert.deepStrictEqual(causes(report(MISSING), "missing-path"), [["wrong-location", "map-file"]]);
  });

  test("a successful read that quotes a missing-file error is content, and a failed read is a missing path", () => {
    const report = analyzeClaude(transcript([
      human("why did the build fail?", 1),
      use("t1", "Read", { file_path: "/work/shop/notes/build.md" }, 2),
      result("t1", "the build said: cat: dist/app.js: No such file or directory", 3),
      use("t2", "Bash", { command: "cat /work/shop/dist/app.js" }, 4),
      result("t2", "Exit code 1\ncat: /work/shop/dist/app.js: No such file or directory", 5, true),
      human("audit", 6),
    ]));
    assert.deepStrictEqual(report.navigationCandidates.map((c) => [c.kind, c.observed.callLine, c.observed.resultExcerpt]), [
      ["missing-path", 4, "cat: /work/shop/dist/app.js: No such file or directory"],
    ]);
  });

  test("a later read of a file with another name is not where the missing file was found, and a mixed command between stays in view", () => {
    const report = (then, text = "text") => analyzeClaude(transcript([
      human("fix the cart total", 1),
      use("a", "Read", { file_path: "/work/shop/src/cart.js" }, 2),
      result("a", MISSING, 3, true),
      use("b", "Bash", { command: "git ls-files | grep cart" }, 4),
      result("b", "lib/cart.js", 5),
      use("c", "Read", { file_path: then }, 6),
      result("c", text, 7, text === MISSING),
      human("audit", 8),
    ]));
    assert.deepStrictEqual(causes(report("/work/shop/README.md"), "missing-path"), [["unknown", "none"]]);
    // A second miss under the same name found nothing.
    assert.deepStrictEqual(causes(report("/work/shop/lib/cart.js", MISSING), "missing-path"), [["unknown", "none"], ["unknown", "none"]]);
    const found = report("/work/shop/lib/cart.js");
    assert.deepStrictEqual(causes(found, "missing-path"), [["wrong-location", "map-file"]]);
    assert.deepStrictEqual(found.navigationCandidates[0].observed.next.map((n) => [n.operation, n.commandOrArguments, n.outcome]), [
      ["mixed", "git ls-files | grep cart", "ok"], ["read", '{"file_path":"/work/shop/lib/cart.js"}', "ok"],
    ]);
  });

  test("a file checked before the session creates it is no detour, and temporary output or a file outside the project is not the map file's", () => {
    const report = analyzeClaude(transcript([
      human("add a changelog and check the tool settings", 1),
      use("t1", "Read", { file_path: "/work/shop/CHANGELOG.md" }, 2),
      result("t1", MISSING, 3, true),
      use("t2", "Write", { file_path: "/work/shop/CHANGELOG.md", content: "# Changes\n" }, 4),
      result("t2", "File created successfully at: /work/shop/CHANGELOG.md", 5),
      use("t3", "Read", { file_path: "/tmp/build-output.log" }, 6),
      result("t3", MISSING, 7, true),
      use("t4", "Read", { file_path: "/work/shop/.toolrc" }, 8),
      result("t4", MISSING, 9, true),
      use("t5", "Read", { file_path: "/home/dev/.toolrc" }, 10),
      result("t5", "color = true", 11),
      human("audit", 12),
    ]));
    assert.deepStrictEqual(causes(report, "missing-path"), [
      ["not-yet-created", "none"], ["temporary-output", "transient"], ["outside-project", "machine"],
    ]);
  });

  test("an unchanged long document read whole again points at section navigation, and pagination, a change, a new task or a compaction do not", () => {
    const guide = "g".repeat(25000);
    const read = (id, second, range = {}) => [
      use(id, "Read", { file_path: "/work/shop/docs/guide.md", ...range }, second), result(id, guide, second + 1),
    ];
    const again = analyzeClaude(transcript([human("follow the guide", 1), ...read("a", 2), ...read("b", 4), human("audit", 6)]));
    assert.deepStrictEqual(again.navigationCandidates.map((c) => [c.kind, c.candidateCause, c.scope, c.observed.earlierLine, c.observed.line]), [
      ["repeated-read", "long-document", "documentation", 3, 5],
    ]);
    const paged = analyzeClaude(transcript([
      human("follow the guide", 1), ...read("a", 2, { offset: 1, limit: 400 }), ...read("b", 4, { offset: 401, limit: 400 }), human("audit", 6),
    ]));
    const edited = analyzeClaude(transcript([
      human("follow the guide", 1), ...read("a", 2),
      use("e", "Edit", { file_path: "/work/shop/docs/guide.md", old_string: "g", new_string: "h" }, 4), result("e", "ok", 5),
      ...read("b", 6), human("audit", 8),
    ]));
    const task = analyzeClaude(transcript([human("follow the guide", 1), ...read("a", 2), human("now the next part", 4), ...read("b", 5), human("audit", 7)]));
    const compacted = analyzeClaude(transcript([
      human("follow the guide", 1), ...read("a", 2),
      { type: "user", isCompactSummary: true, timestamp: at(4), message: { content: "Summary of the conversation so far" } },
      ...read("b", 5), human("audit", 7),
    ]));
    for (const report of [paged, edited, task, compacted]) assert.deepStrictEqual(report.navigationCandidates, []);
  });

  test("a short file read again is ordinary, and a read after a command of unknown effect may check it", () => {
    const report = analyzeClaude(transcript([
      human("tidy the cart", 1),
      use("a", "Read", { file_path: "/work/shop/src/cart.js" }, 2), result("a", "export const cart = [];", 3),
      use("b", "Read", { file_path: "/work/shop/src/cart.js" }, 4), result("b", "export const cart = [];", 5),
      use("c", "Bash", { command: "npm run format" }, 6), result("c", "formatted 1 file", 7),
      use("d", "Read", { file_path: "/work/shop/src/cart.js" }, 8), result("d", "export const cart = [];", 9),
      human("audit", 10),
    ]));
    assert.deepStrictEqual(causes(report, "repeated-read"), [["re-read", "none"], ["possible-change", "none"]]);
    assert.deepStrictEqual(report.navigationCandidates.map((c) => c.observed.unknownEffectsBetween), [0, 1]);
  });

  test("a Read over the tool's limit that the actor then pages through is pagination, and one it does not is a candidate", () => {
    const tokens = "<tool_use_error>File content (31000 tokens) exceeds maximum allowed tokens (25000). "
      + "Use offset and limit parameters to read part of the file.</tool_use_error>";
    const paged = analyzeClaude(transcript([
      human("follow the guide", 1),
      use("a", "Read", { file_path: "/work/shop/docs/guide.md" }, 2), result("a", tokens, 3, true),
      use("b", "Read", { file_path: "/work/shop/docs/guide.md", offset: 1, limit: 300 }, 4), result("b", "# Guide", 5),
      human("audit", 6),
    ]));
    assert.deepStrictEqual(causes(paged, "truncated-read"), [["paged", "none"]]);
    assert.strictEqual(paged.candidates[0].category, "output-too-large");

    // The size limit refuses a file the same way.
    const size = analyzeClaude(transcript([
      human("read the release notes", 1),
      use("a", "Read", { file_path: "/work/shop/docs/releases.md" }, 2),
      result("a", "<tool_use_error>File content (312KB) exceeds maximum allowed size (256KB). Use offset and limit parameters to read part of the file.</tool_use_error>", 3, true),
      human("audit", 4),
    ]));
    assert.deepStrictEqual(causes(size, "truncated-read"), [["long-document", "documentation"]]);
    // Both views name one cause for either limit: the failure is output-too-large, the navigation candidate a cut read.
    assert.deepStrictEqual([paged.candidates[0].category, size.candidates[0].category], ["output-too-large", "output-too-large"]);
  });

  test("a failed read of a missing file is a missing path in both views, whatever its spelling", () => {
    // Each form as a file tool, a shell, PowerShell or Windows writes it.
    const forms = [
      ["Read", { file_path: "/work/shop/docs/gone.md" }, "<tool_use_error>File does not exist.</tool_use_error>"],
      ["Grep", { pattern: "total", path: "/work/shop/srcs" }, "<tool_use_error>Path does not exist: /work/shop/srcs</tool_use_error>"],
      ["Glob", { pattern: "*.js", path: "/work/shop/gone" }, "<tool_use_error>Directory does not exist: /work/shop/gone</tool_use_error>"],
      ["Edit", { file_path: "/work/shop/src/gone.js", old_string: "a", new_string: "b" }, "<tool_use_error>File does not exist.</tool_use_error>"],
      ["Bash", { command: "cat docs/gone.md" }, "Exit code 1\ncat: docs/gone.md: No such file or directory"],
      ["Bash", { command: "rg -n total srcs" }, "Exit code 2\nrg: srcs: No such file or directory (os error 2)"],
      ["PowerShell", { command: String.raw`Get-Content docs\gone.md` }, String.raw`Exit code 1
Get-Content: Cannot find path 'D:\work\shop\docs\gone.md' because it does not exist.`],
      ["PowerShell", { command: "rg -n total srcs" }, "Exit code 2\nrg: srcs: The system cannot find the file specified. (os error 2)"],
      // A missing file names the cause even beside another error the output reports.
      ["Bash", { command: "cat notes/a.md notes/b.md" }, "Exit code 1\ncat: notes/a.md: Permission denied\ncat: notes/b.md: No such file or directory"],
      // The excerpt shows the line that names the cause, however much output comes before it.
      ["Bash", { command: "ls -la && cat docs/gone.md" }, `Exit code 1\n${"-rw-r--r-- 1 dev dev 120 notes.md\n".repeat(20)}cat: docs/gone.md: No such file or directory`],
    ];
    const rows = [human("find the totals", 1)];
    forms.forEach(([tool, input, text], i) => rows.push(use(`f${i}`, tool, input, 2), result(`f${i}`, text, 3, true)));
    const report = analyzeClaude(transcript([...rows, human("audit", 4)]), null, 10);
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.category]), forms.map((_, i) => [2 + 2 * i, "missing-path"]));
    assert.deepStrictEqual(report.navigationCandidates.map((c) => [c.kind, c.observed.callLine]), forms.map((_, i) => ["missing-path", 2 + 2 * i]));
    assert.deepStrictEqual(report.candidateCounts, { "missing-path": forms.length });
    assert.match(report.candidates[forms.length - 1].diagnosticCandidate, /cat: docs\/gone\.md: No such file or directory/);
  });

  test("a failure that says nothing of a missing file keeps its category, and so does a failed command that is no read", () => {
    const report = analyzeClaude(transcript([
      human("look at the docs", 1),
      use("a", "Bash", { command: "cat docs" }, 2), result("a", "Exit code 1\ncat: docs: Is a directory", 3, true),
      use("b", "Bash", { command: "rg -n calcTot src" }, 4), result("b", "Exit code 1", 5, true),
      use("c", "Bash", { command: "cp notes.md backup/notes.md" }, 6),
      result("c", "Exit code 1\ncp: cannot create regular file 'backup/notes.md': No such file or directory", 7, true),
      use("d", "Bash", { command: "npm test" }, 8), result("d", "Exit code 1\n1 failing", 9, true),
      human("audit", 10),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.operation, c.category]), [
      [2, "read", "nonzero-exit"], [4, "search", "nonzero-exit"], [6, "write", "nonzero-exit"], [8, "command", "nonzero-exit"],
    ]);
    assert.deepStrictEqual(report.navigationCandidates, []);
  });

  test("a Codex read or search of a missing file is a missing path in both views, also when its script failed", () => {
    const fn = (id, cmd, second) => item(second, { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd }) });
    const done = (id, code, text, second) => item(second, {
      type: "function_call_output", call_id: id, output: `Process exited with code ${code}\nOutput:\n${text}`,
    });
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("find the totals", 1),
      fn("c1", "cat gone.md", 2), done("c1", 1, "cat: gone.md: No such file or directory", 3),
      fn("c2", String.raw`Get-Content -LiteralPath docs\gone.md`, 4),
      done("c2", 1, String.raw`Get-Content: Cannot find path 'D:\work\shop\docs\gone.md' because it does not exist.`, 5),
      fn("c3", "rg -n total srcs", 6), done("c3", 2, "rg: srcs: The system cannot find the file specified. (os error 2)", 7),
      call("c4", "cat notes/gone.md", 8),
      output("c4", ["Script failed\nWall time 0.1 seconds\nOutput:\n", "Script error:\ncat: notes/gone.md: No such file or directory"], 9),
      fn("c5", "cat docs", 10), done("c5", 1, "cat: docs: Is a directory", 11),
      fn("c6", "npm test", 12), done("c6", 1, "1 failing", 13),
      started(14),
    ]), null, 10);
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.category]), [
      [5, "missing-path"], [7, "missing-path"], [9, "missing-path"],
      [11, "tool-script-failure"], [11, "missing-path"],
      [13, "nonzero-exit"], [15, "nonzero-exit"],
    ]);
    assert.deepStrictEqual(report.navigationCandidates.map((c) => [c.kind, c.observed.callLine]), [
      ["missing-path", 5], ["missing-path", 7], ["missing-path", 9], ["missing-path", 11],
    ]);
  });

  test("Claude Code's notice of a partial Read, in the record after its result, is a cut read; ranged reads after it are pagination", () => {
    const banner = "[Truncated: PARTIAL view — /work/shop/docs/guide.md: showing lines 1-2000 of 3400 total (25000 tokens, cap 25000). "
      + "Call Read with offset and limit for the rest.]";
    const shown = (...then) => analyzeClaude(transcript([
      human("follow the guide", 1),
      use("a", "Read", { file_path: "/work/shop/docs/guide.md" }, 2), result("a", "     1\t# Guide", 3), truncation("a", 3, banner),
      ...then,
      human("audit", 9),
    ]));
    // Reading the whole file again is not reading the rest, and a cut read is no whole read for a repeat.
    const again = shown(use("b", "Read", { file_path: "/work/shop/docs/guide.md" }, 5), result("b", "     1\t# Guide", 6));
    assert.deepStrictEqual(again.navigationCandidates.map((c) => [c.kind, c.candidateCause, c.scope, c.observed.line, c.observed.noticeLine]), [
      ["truncated-read", "long-document", "documentation", 3, 4],
    ]);
    assert.strictEqual(again.navigationCandidates[0].observed.resultExcerpt, banner);
    const ranged = shown(use("b", "Read", { file_path: "/work/shop/docs/guide.md", offset: 2001, limit: 1400 }, 5), result("b", "  2001\t## Part two", 6));
    assert.deepStrictEqual(causes(ranged, "truncated-read"), [["paged", "none"]]);

    // A whole read that looked like a repeat until its notice arrived is a cut read and no repeat.
    const cutRepeat = analyzeClaude(transcript([
      human("follow the guide", 1),
      use("a", "Read", { file_path: "/work/shop/docs/guide.md" }, 2), result("a", "     1\t# Guide", 3),
      use("b", "Read", { file_path: "/work/shop/docs/guide.md" }, 4), result("b", "     1\t# Guide", 5), truncation("b", 5, banner),
      human("audit", 6),
    ]));
    assert.deepStrictEqual(cutRepeat.navigationCounts, { "truncated-read": 1 });
    assert.deepStrictEqual(cutRepeat.navigationCandidates.map((c) => [c.kind, c.observed.callLine]), [["truncated-read", 4]]);

    // A file that quotes a host's truncation marks is content.
    const quoted = analyzeClaude(transcript([
      human("read the notes", 1),
      use("a", "Read", { file_path: "/work/shop/docs/notes.md" }, 2),
      result("a", "     1\tA cut Read shows [Truncated: PARTIAL view — a.md], Codex prints …120 tokens truncated…, and a shell "
        + "line reads ... [3 lines truncated] ...", 3),
      human("audit", 4),
    ]));
    assert.deepStrictEqual(quoted.navigationCandidates, []);
  });

  test("a persisted shell read is a cut read measured by the size it states, and reading the saved output is reading the rest", () => {
    const saved = "/home/dev/.claude/projects/shop/s1/tool-results/t1.txt";
    const read = (...then) => analyzeClaude(transcript([
      human("read the partner contract", 1),
      use("a", "Bash", { command: "cat docs/partner-api.md" }, 2), result("a", persisted(58.1, saved), 3),
      ...then,
      human("audit", 8),
    ]));
    const preview = read();
    assert.deepStrictEqual(
      preview.navigationCandidates.map((c) => [c.kind, c.candidateCause, c.scope, c.observed.characters, c.observed.persisted]),
      [["truncated-read", "long-document", "documentation", 59494, true]],
    );
    assert.match(preview.navigationCandidates[0].observed.resultExcerpt, /^Output too large \(58\.1KB\)\. Full output saved to: /);
    assert.deepStrictEqual(causes(read(use("b", "Read", { file_path: saved }, 4), result("b", "     1\t# Partner API", 5)), "truncated-read"), [
      ["paged", "none"],
    ]);
  });

  test("the host's notice that a re-read file is unchanged is a host notice, never a content read or a repeat", () => {
    const report = analyzeClaude(transcript([
      human("look at the cart", 1),
      use("a", "Read", { file_path: "/work/shop/src/cart.js" }, 2), result("a", "     1\texport const cart = [];", 3),
      use("b", "Read", { file_path: "/work/shop/src/cart.js" }, 4), result("b", UNCHANGED, 5),
      use("c", "Read", { file_path: "/work/shop/src/steps.js" }, 6), result("c", "     1\t// File unchanged since your last Read? This file explains.", 7),
      human("audit", 8),
    ]));
    assert.deepStrictEqual(
      report.navigationCandidates.map((c) => [c.kind, c.observed.notice, c.observed.earlierLine, c.candidateCause, c.scope]),
      [["host-notice", "unchanged-since-read", 3, "re-read", "none"]],
    );
  });

  test("a call from the failed call's own assistant message ran beside it, even when the host wrote it after the result", () => {
    const report = (messageId) => analyzeClaude(transcript([
      human("fix the cart total", 1),
      from("m1", "a", "Read", { file_path: "/work/shop/src/cart.js" }, 2),
      result("a", MISSING, 3, true),
      from(messageId, "b", "Read", { file_path: "/work/shop/lib/cart.js" }, 2),
      result("b", "export const cart = [];", 4),
      human("audit", 5),
    ]));
    const sibling = report("m1");
    assert.deepStrictEqual(causes(sibling, "missing-path"), [["unknown", "none"]]);
    assert.deepStrictEqual(sibling.navigationCandidates[0].observed.next, []);
    // Nor is it a later success of the failure.
    assert.deepStrictEqual(sibling.candidates[0].laterSameToolSuccesses, []);
    const later = report("m2");
    assert.deepStrictEqual(causes(later, "missing-path"), [["wrong-location", "map-file"]]);
    assert.deepStrictEqual(later.candidates[0].laterSameToolSuccesses.map((s) => s.callLine), [4]);
  });

  test("the calls of one assistant message share its phase, and two reads of one file in a message are no repeat", () => {
    const report = analyzeClaude(transcript([
      human("tidy the cart", 1),
      from("m1", "w", "Write", { file_path: "/work/shop/src/new.js", content: "" }, 2),
      from("m1", "a", "Read", { file_path: "/work/shop/src/a.js" }, 2),
      result("w", "ok", 3), result("a", MISSING, 3, true),
      from("m2", "b", "Read", { file_path: "/work/shop/src/b.js" }, 4), result("b", MISSING, 5, true),
      from("m3", "c", "Read", { file_path: "/work/shop/src/cart.js" }, 6), from("m3", "d", "Read", { file_path: "/work/shop/src/cart.js" }, 6),
      result("c", "     1\texport {};", 7), result("d", "     1\texport {};", 7),
      human("audit", 8),
    ]));
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.phase]), [[3, "orientation"], [6, "change"]]);
    assert.deepStrictEqual(report.navigationCounts, { "missing-path": 2 });
  });

  test("a persisted output counts at the size the host states, and routes by what printed it", () => {
    const report = analyzeClaude(transcript([
      human("check the build", 1),
      use("a", "Bash", { command: "cat docs/partner-api.md" }, 2), result("a", persisted(58.1), 3),
      use("b", "Bash", { command: "npm test" }, 4), result("b", persisted(120.4), 5),
      use("c", "Grep", { pattern: "total", path: "src" }, 6), result("c", persisted(1.2, undefined, "MB"), 7),
      use("d", "Bash", { command: "git log -p" }, 8), result("d", persisted(80), 9),
      use("e", "Bash", { command: "npm run lint" }, 10), result("e", persisted(9.5), 11),
      human("audit", 12),
    ]), null, 10);
    assert.deepStrictEqual(report.navigationCandidates.map((c) => [c.observed.callLine, c.kind, c.candidateCause, c.scope, c.observed.characters]), [
      [2, "truncated-read", "long-document", "documentation", 59494],
      [4, "large-output", "verbose-command", "reporter", 123290],
      [6, "large-output", "broad-search", "layout", 1258291],
      [8, "large-output", "command-output", "none", 81920],
    ]);
    assert.ok(report.navigationCandidates.every((c) => c.observed.persisted));
    assert.deepStrictEqual(report.largestToolTexts.map((e) => [e.callLine, e.characters, e.persisted]), [
      [6, 1258291, true], [4, 123290, true], [8, 81920, true],
    ]);
  });

  test("a Codex read pipeline or a read a script computes prints content, not a verbose command, and a project tool does", () => {
    const script = (id, input, second) => item(second, { type: "custom_tool_call", call_id: id, name: "exec", input });
    const exec = (cmd) => `text(await tools.exec_command({cmd: ${JSON.stringify(cmd)}}))`;
    const big = (id, second) => output(id, ["Script completed\nOutput:\n", `Exit code: 0\nWall time: 0.2 seconds\nOutput:\n${"contract text\n".repeat(2000)}`], second);
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("summarize the contract", 1),
      script("c1", exec(String.raw`Get-Content -LiteralPath docs\api.md | ForEach-Object { $_ }`), 2), big("c1", 3),
      script("c2", 'for (const f of ["api.md", "faq.md"]) text(await tools.exec_command({cmd: `Get-Content docs/${f}`}));', 4), big("c2", 5),
      script("c3", exec("npm test"), 6), big("c3", 7),
      // A variable holding a relative path, a quoted path in a list, or a source file named on a line is no script run.
      script("c4", exec(String.raw`$p='src\Program.cs'; Get-Content -LiteralPath $p`), 8), big("c4", 9),
      script("c5", exec("$files = @(\n  'src\\Program.cs',\n  '.\\gradlew'\n)\nforeach ($f in $files) { Get-Content $f }"), 10), big("c5", 11),
      // A script run by its relative path, or a project tool after an assignment, is.
      script("c6", exec(String.raw`.\scripts\check.ps1 -Verbose`), 12), big("c6", 13),
      script("c7", exec("$out = npm test"), 14), big("c7", 15),
      script("c8", exec('files=(\n  src/app.ts\n  src/util.ts\n)\nfor f in "${files[@]}"; do cat "$f"; done'), 16), big("c8", 17),
      script("c9", exec("CI=1 npm test"), 18), big("c9", 19),
      // An array of paths piped on is no script, whatever its last element looks like.
      script("c10", exec(String.raw`@('C:\work\a.md','C:\work\docs') | ForEach-Object { Get-ChildItem $_ }`), 20), big("c10", 21),
      started(22),
    ]), null, 10);
    assert.deepStrictEqual(report.navigationCandidates.map((c) => [c.observed.callLine, c.observed.operation, c.candidateCause, c.scope]), [
      [5, "mixed", "command-output", "none"], [7, "command", "command-output", "none"], [9, "command", "verbose-command", "reporter"],
      [11, "mixed", "command-output", "none"], [13, "mixed", "command-output", "none"],
      [15, "command", "verbose-command", "reporter"], [17, "command", "verbose-command", "reporter"],
      [19, "mixed", "command-output", "none"], [21, "command", "verbose-command", "reporter"], [23, "mixed", "command-output", "none"],
    ]);
  });

  test("a language tool's output is the project's only when its script is, and a script from outside the project is reported against its source", () => {
    const big = "x".repeat(25000);
    const commands = [
      "node scripts/build.js", "node /work/shop/scripts/build.js", "node --test", "python -m pytest -q",
      // A line the recognizer cannot split, here a PowerShell continuation, still shows the tool it runs.
      "npm test -- --reporter=spec `\n  --bail",
      'node "/home/dev/.claude/plugins/cache/tools/1.0.0/scripts/report.js" status', 'node "${CLAUDE_PLUGIN_ROOT}/scripts/report.js"',
      'node "/home/dev/.claude/plugins/cache/tools/1.0.0/scripts/report.js" update < payload.json',
      'node -e "console.log(1)"', "node /tmp/probe.js",
    ];
    const rows = [human("run the scripts", 1)];
    commands.forEach((command, i) => rows.push(use(`b${i}`, i === 4 ? "PowerShell" : "Bash", { command }, 2), result(`b${i}`, big, 3)));
    const claude = analyzeClaude(transcript([...rows, human("audit", 4)]), null, 10);
    assert.deepStrictEqual(claude.navigationCandidates.map((c) => [c.observed.commandOrArguments, c.candidateCause, c.scope]), [
      [commands[0], "verbose-command", "reporter"], [commands[1], "verbose-command", "reporter"],
      [commands[2], "verbose-command", "reporter"], [commands[3], "verbose-command", "reporter"], [commands[4], "verbose-command", "reporter"],
      [commands[5], "outside-script", "source"], [commands[6], "outside-script", "source"], [commands[7], "outside-script", "source"],
      [commands[8], "command-output", "none"], [commands[9], "command-output", "none"],
    ]);

    // Code on standard input and text a command carries as data run no project tool; a tool after that text still does.
    const data = [
      ["Bash", "python - data/report.csv <<'EOF'\nimport sys\nprint(open(sys.argv[1]).read())\nEOF"],
      ["Bash", "node <<'EOF'\nconsole.log(require('fs').readFileSync('big.txt', 'utf8'))\nEOF"],
      ["Bash", "cat <<'EOF' > CONTRIBUTING.md\nnpm test runs every suite.\nEOF\ncat CONTRIBUTING.md"],
      ["PowerShell", "@'\nDon't skip the checks:\nnpm test\n'@ | Set-Content notes.md; Get-Content notes.md"],
      ["PowerShell", "<#\nnpm test runs the suite\n#>\nGet-Content notes.md"],
      ["Bash", "node - <<'EOF'\nconsole.log(1)\nEOF\nnpm test"],
    ];
    const carried = [human("write the notes", 1)];
    data.forEach(([tool, command], i) => carried.push(use(`d${i}`, tool, { command }, 2), result(`d${i}`, big, 3)));
    assert.deepStrictEqual(analyzeClaude(transcript([...carried, human("audit", 4)]), null, 10).navigationCandidates.map((c) => c.candidateCause), [
      "command-output", "command-output", "command-output", "command-output", "command-output", "verbose-command",
    ]);

    // On Codex, a relative script under a working directory outside the session's is outside the project too.
    const fn = (id, args, second) => item(second, { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify(args) });
    const done = (id, second) => item(second, { type: "function_call_output", call_id: id, output: `Process exited with code 0\nOutput:\n${big}` });
    const codex = analyzeCodex(transcript([
      meta, started(1), turn(1), message("run the scripts", 1),
      fn("c1", { cmd: "node scripts/build.js" }, 2), done("c1", 3),
      fn("c2", { cmd: "node scripts/run.js", workdir: "/home/dev/.codex/skills/report" }, 4), done("c2", 5),
      fn("c3", { cmd: "node /home/dev/.codex/skills/report/scripts/run.js" }, 6), done("c3", 7),
      started(8),
    ]));
    assert.deepStrictEqual(codex.navigationCandidates.map((c) => [c.observed.callLine, c.candidateCause, c.scope]), [
      [5, "verbose-command", "reporter"], [7, "outside-script", "source"], [9, "outside-script", "source"],
    ]);
  });

  test("a background task's output routes by the command that started it, and a plan is the agent's own text", () => {
    const report = analyzeClaude(transcript([
      human("run the suite in the background", 1),
      use("s", "Bash", { command: "npm test", run_in_background: true }, 2),
      result("s", "Command running in background with ID: bg1. Output is being written to: /tmp/tasks/bg1.output", 3),
      use("o", "TaskOutput", { task_id: "bg1" }, 4), result("o", `# tests 400\n${"ok 1 - passes\n".repeat(2000)}`, 5),
      use("u", "TaskOutput", { task_id: "bg9" }, 6), result("u", "line\n".repeat(5000), 7),
      use("p", "ExitPlanMode", { plan: "1. Fix the total" }, 8), result("p", `User has approved your plan.\n${"plan line\n".repeat(2500)}`, 9),
      human("audit", 10),
    ]));
    assert.deepStrictEqual(report.navigationCandidates.map((c) => [c.observed.tool, c.candidateCause, c.scope, c.observed.startedBy]), [
      ["TaskOutput", "verbose-command", "reporter", 2], ["TaskOutput", "background-output", "none", null],
    ]);
  });

  test("candidates that mean no change leave the bounded list first, and reading an image again or polling a temporary file is no repeat", () => {
    const rows = [
      human("fix the cart total", 1),
      use("a", "Read", { file_path: "/work/shop/src/cart.js" }, 2), result("a", MISSING, 3, true),
      use("b", "Read", { file_path: "/work/shop/lib/cart.js" }, 4), result("b", "     1\texport {};", 5),
    ];
    for (let i = 0; i < 8; i++) rows.push(use(`r${i}`, "Read", { file_path: "/work/shop/lib/cart.js" }, 6), result(`r${i}`, "     1\texport {};", 7));
    const crowded = analyzeClaude(transcript([...rows, human("audit", 8)]));
    assert.deepStrictEqual(crowded.navigationCounts, { "missing-path": 1, "repeated-read": 8 });
    assert.deepStrictEqual(crowded.navigationCandidates.map((c) => [c.kind, c.candidateCause]), [
      ["missing-path", "wrong-location"], ...Array(5).fill(["repeated-read", "re-read"]),
    ]);
    assert.match(crowded.warnings.join("\n"), /Only 6 navigation candidates are shown, those that mean no change leaving first/);

    // A cut read the actor then paged through has settled on no change, so it leaves before a reporter candidate.
    const tokens = "<tool_use_error>File content (40000 tokens) exceeds maximum allowed tokens (25000). "
      + "Use offset and limit parameters to read part of the file.</tool_use_error>";
    const logs = [human("run the suite, then read the logs", 1), use("v", "Bash", { command: "npm test" }, 2), result("v", "ok\n".repeat(12000), 3)];
    for (let i = 0; i < 7; i++) {
      logs.push(
        use(`r${i}`, "Read", { file_path: `/work/shop/logs/l${i}.log` }, 4), result(`r${i}`, tokens, 5, true),
        use(`p${i}`, "Read", { file_path: `/work/shop/logs/l${i}.log`, offset: 1, limit: 100 }, 6), result(`p${i}`, "     1\tline", 7),
      );
    }
    const paged = analyzeClaude(transcript([...logs, human("audit", 8)]));
    assert.deepStrictEqual(paged.navigationCounts, { "large-output": 1, "truncated-read": 7 });
    assert.deepStrictEqual(paged.navigationCandidates.map((c) => `${c.kind}:${c.candidateCause}`), [
      "large-output:verbose-command", ...Array(5).fill("truncated-read:paged"),
    ]);

    // A cut read of a log means no change whatever follows, so it leaves before an older reporter candidate even while
    // its later calls are still to come.
    const agent = { isSidechain: true, agentId: "agent-7" };
    const suites = [
      human("check the log", 1), use("v", "Bash", { command: "npm test" }, 2), result("v", "ok\n".repeat(12000), 3),
      use("l", "Read", { file_path: "/work/shop/logs/app.log" }, 4), result("l", tokens, 5, true), typed("Run the other suites", 6, agent),
    ];
    for (let i = 0; i < 5; i++) {
      suites.push(use(`t${i}`, "Bash", { command: `npm test -- suite${i}` }, 7, agent), result(`t${i}`, "ok\n".repeat(12000), 8, false, agent));
    }
    const logCut = analyzeClaude(transcript([...suites, human("audit", 9)]));
    assert.deepStrictEqual(logCut.navigationCounts, { "large-output": 6, "truncated-read": 1 });
    assert.deepStrictEqual(logCut.navigationCandidates.map((c) => [c.observed.actor, c.candidateCause]), [
      ["main", "verbose-command"], ...Array(5).fill(["agent-7", "verbose-command"]),
    ]);

    // A miss whose four later calls are all in and found nothing has settled on no change as well.
    const found = [
      human("check the cart", 1), use("v", "Bash", { command: "npm test" }, 2), result("v", "ok\n".repeat(12000), 3),
      use("m", "Read", { file_path: "/work/shop/src/cart.js" }, 4), result("m", MISSING, 5, true),
    ];
    for (let i = 0; i < 4; i++) found.push(use(`q${i}`, "Read", { file_path: `/work/shop/src/q${i}.js` }, 6), result(`q${i}`, "     1\texport {};", 7));
    for (let i = 0; i < 5; i++) found.push(use(`t${i}`, "Bash", { command: `npm test -- suite${i}` }, 8), result(`t${i}`, "ok\n".repeat(12000), 9));
    assert.deepStrictEqual(analyzeClaude(transcript([...found, human("audit", 10)])).navigationCandidates.map((c) => c.kind), Array(6).fill("large-output"));

    // Once its actor works on a later prompt, a miss can gain no later calls, so with those it has answered it has settled.
    const stale = [
      human("check the cart", 1), use("v", "Bash", { command: "npm test" }, 2), result("v", "ok\n".repeat(12000), 3),
      use("m", "Read", { file_path: "/work/shop/src/cart.js" }, 4), result("m", MISSING, 5, true),
      use("q", "Read", { file_path: "/work/shop/src/q.js" }, 6), result("q", "     1\texport {};", 7),
      human("now run the other suites", 8),
    ];
    for (let i = 0; i < 5; i++) stale.push(use(`t${i}`, "Bash", { command: `npm test -- suite${i}` }, 9), result(`t${i}`, "ok\n".repeat(12000), 10));
    assert.deepStrictEqual(analyzeClaude(transcript([...stale, human("audit", 11)])).navigationCandidates.map((c) => c.kind), Array(6).fill("large-output"));

    // A miss whose later calls are still to come may yet find its file, so it stays while settled ones leave.
    const waiting = [
      human("fix the cart total", 1), use("a", "Read", { file_path: "/work/shop/src/cart.js" }, 2), result("a", MISSING, 3, true),
      typed("Check the notes", 4, agent),
    ];
    for (let i = 0; i < 7; i++) {
      waiting.push(use(`n${i}`, "Read", { file_path: "/work/shop/docs/notes.md" }, 5, agent), result(`n${i}`, "     1\t# Notes", 6, false, agent));
    }
    waiting.push(use("b", "Read", { file_path: "/work/shop/lib/cart.js" }, 7), result("b", "     1\texport {};", 8), human("audit", 9));
    assert.deepStrictEqual(analyzeClaude(transcript(waiting)).navigationCandidates.map((c) => [c.kind, c.candidateCause]), [
      ["missing-path", "wrong-location"], ...Array(5).fill(["repeated-read", "re-read"]),
    ]);

    const polled = analyzeClaude(transcript([
      human("check the screenshot and the task", 1),
      use("a", "Read", { file_path: "/work/shop/shots/home.png" }, 2), result("a", "[image]", 3),
      use("b", "Read", { file_path: "/work/shop/shots/home.png" }, 4), result("b", "[image]", 5),
      use("c", "Read", { file_path: "/tmp/claude/tasks/bg1.output" }, 6), result("c", "running", 7),
      use("d", "Read", { file_path: "/tmp/claude/tasks/bg1.output" }, 8), result("d", "done", 9),
      human("audit", 10),
    ]));
    assert.deepStrictEqual(polled.navigationCandidates, []);
  });

  test("a large output points at its source, and a large failure or a large read at no change", () => {
    const big = "x".repeat(25000);
    const report = analyzeClaude(transcript([
      human("run the checks", 1),
      use("t1", "Bash", { command: "npm test" }, 2), result("t1", big, 3),
      use("t2", "Bash", { command: "npm run lint" }, 4), result("t2", `Exit code 1\n${big}`, 5, true),
      use("t3", "Bash", { command: "rg -n total" }, 6), result("t3", big, 7),
      use("t4", "mcp__docs__fetch", { url: "https://example.invalid/guide" }, 8), result("t4", big, 9),
      use("t5", "Read", { file_path: "/work/shop/src/big.js" }, 10), result("t5", big, 11),
      use("t6", "Read", { file_path: "/work/shop/src/small.js" }, 12), result("t6", `export {};\n<system-reminder>${big}</system-reminder>`, 13),
      human("audit", 14),
    ]));
    assert.deepStrictEqual(report.navigationCandidates.map((c) => [c.observed.callLine, c.candidateCause, c.scope]), [
      [2, "verbose-command", "reporter"], [4, "failure-output", "none"], [6, "broad-search", "layout"],
      [8, "tool-output", "source"], [12, "appended-text", "source"],
    ]);
    assert.deepStrictEqual(report.navigationCounts, { "large-output": 5 });
    assert.deepStrictEqual(report.navigationCandidates.map((c) => [c.observed.characters, c.observed.appendedCharacters > 25000]), [
      [25000, false], [25012, false], [25000, false], [25000, false], [10, true],
    ]);
    assert.ok(!JSON.stringify(report.navigationCandidates).includes("xxx"));
    for (const c of report.navigationCandidates) assert.ok(c.intervention.length > 0 && c.verification.length > 0);
  });

  test("every call names its task phase: orientation until a change, change after a write, unknown after a command or before any prompt", () => {
    const report = analyzeClaude(transcript([
      use("t0", "Read", { file_path: "/work/shop/a.js" }, 1), result("t0", MISSING, 2, true),
      human("fix the cart", 3),
      use("t1", "Read", { file_path: "/work/shop/b.js" }, 4), result("t1", MISSING, 5, true),
      use("t2", "Bash", { command: "npm test" }, 6), result("t2", "ok", 7),
      use("t3", "Read", { file_path: "/work/shop/c.js" }, 8), result("t3", MISSING, 9, true),
      use("t4", "Write", { file_path: "/work/shop/d.js", content: "" }, 10), result("t4", "ok", 11),
      use("t5", "Read", { file_path: "/work/shop/e.js" }, 12), result("t5", MISSING, 13, true),
      human("next task", 14),
      use("t6", "Read", { file_path: "/work/shop/f.js" }, 15), result("t6", MISSING, 16, true),
      human("audit", 17),
    ]), null, 10);
    const phases = [[1, "unknown"], [4, "orientation"], [8, "unknown"], [12, "change"], [15, "orientation"]];
    assert.deepStrictEqual(report.candidates.map((c) => [c.callLine, c.phase]), phases);
    assert.deepStrictEqual(report.navigationCandidates.map((c) => [c.observed.callLine, c.observed.phase]), phases);
  });

  test("a Codex rollout's missing path, empty search and cut read are read the same way", () => {
    const fn = (id, cmd, second) => item(second, {
      type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd, workdir: "/work/shop" }),
    });
    const done = (id, code, text, second) => item(second, {
      type: "function_call_output", call_id: id, output: `Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code ${code}\nOutput:\n${text}`,
    });
    const report = analyzeCodex(transcript([
      meta, started(1), turn(1), message("fix the cart total", 1),
      fn("c1", "cat src/cart.js", 2), done("c1", 1, "cat: src/cart.js: No such file or directory", 3),
      fn("c2", "rg -n calcTot src", 4), done("c2", 1, "", 5),
      fn("c3", "cat lib/cart.js", 6), done("c3", 0, "export const total = 1;", 7),
      fn("c4", "cat docs/guide.md", 8), done("c4", 0, "# Guide\nThe first part…700 tokens truncated…the last part", 9),
      started(10),
    ]));
    assert.deepStrictEqual(report.navigationCandidates.map((c) => [c.kind, c.observed.callLine, c.observed.phase, c.candidateCause, c.scope]), [
      ["missing-path", 5, "orientation", "wrong-location", "map-file"],
      ["truncated-read", 11, "orientation", "long-document", "documentation"],
    ]);
    assert.deepStrictEqual(report.navigationCandidates[0].observed.next.map((n) => [n.callLine, n.operation, n.outcome]), [
      [7, "search", "failed"], [9, "read", "ok"], [11, "read", "ok"],
    ]);
  });

  test("navigation candidates are bounded, so the evidence does not grow with the transcript", () => {
    const size = (steps) => {
      const rows = [human("loop", 1)];
      for (let i = 0; i < steps; i++) {
        const dir = `/work/shop/${"d".repeat(300)}/${i}`;
        rows.push(
          use(`m${i}`, "Read", { file_path: `${dir}/a/cart.js` }, 2),
          result(`m${i}`, `<tool_use_error>File does not exist. ${"e".repeat(2000)}</tool_use_error>`, 3, true),
          // The third read finds the missing file elsewhere, so each miss may call for a change and stays in view.
          ...[1, 2, 3, 4, 5].flatMap((k) => [
            use(`x${i}-${k}`, "Read", { file_path: k === 3 ? `${dir}/c/cart.js` : `${dir}/x${k}.js` }, 4), result(`x${i}-${k}`, "export {};", 4),
          ]),
          use(`s${i}`, "Bash", { command: `npm run build -- ${"c".repeat(2000)}` }, 4),
          result(`s${i}`, "y".repeat(20000), 5),
          use(`r${i}`, "Read", { file_path: `${dir}/b/cart.js` }, 6),
          result(`r${i}`, "export {};", 7),
          use(`g${i}`, "Read", { file_path: `${dir}/b/cart.js` }, 8),
          result(`g${i}`, "export {};", 9),
        );
      }
      rows.push(human("audit", 10));
      const report = analyzeClaude(transcript(rows), null, 30);
      assert.deepStrictEqual(report.navigationCounts, { "missing-path": steps, "large-output": steps, "repeated-read": steps });
      // The repeats mean no change, so they leave first and the last 15 misses and outputs stay.
      assert.deepStrictEqual(report.navigationCandidates.map((c) => c.kind), Array(15).fill(["missing-path", "large-output"]).flat());
      assert.ok(report.navigationCandidates.every((c) => c.scope === (c.kind === "missing-path" ? "map-file" : "reporter")));
      // Each miss keeps only the four calls that came next.
      const kept = report.navigationCandidates.filter((c) => c.kind === "missing-path").map((c) => c.observed.next.map((n) => n.callLine - c.observed.line));
      assert.deepStrictEqual(kept, Array(15).fill([1, 3, 5, 7]));
      return JSON.stringify(report).length;
    };
    const short = size(40);
    const long = size(300);
    assert.ok(long - short < 2000, `grew from ${short} to ${long} characters`);
  });
});
