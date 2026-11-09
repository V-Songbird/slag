"use strict";

// The instruction guard on each host's payload: every hidden character class
// written into every kind of instruction file is refused, and the near misses,
// the repository's own tracked Markdown and files agents do not load as
// instructions pass. Every character is built from its code point.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { tempDir } = require("./session-transcripts.js");
const { decide, isInstructionFile } = require("../hooks/instruction-guard.js");

const HOOK = path.join(__dirname, "..", "hooks", "instruction-guard.js");
const REPOSITORY = path.join(__dirname, "..", "..");
const cp = (...codes) => String.fromCodePoint(...codes);
const isTag = (char) => char.codePointAt(0) >= 0xe0000 && char.codePointAt(0) <= 0xe007f;

// A project root that Git would find, with nothing in it.
function project() {
  const root = tempDir();
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

const HIDDEN = [
  ["a lone zero-width joiner", `a${cp(0x200d)}b`, "U+200D"],
  ["a zero-width space", `a${cp(0x200b)}b`, "U+200B"],
  ["a zero-width non-joiner", `a${cp(0x200c)}b`, "U+200C"],
  ["a word joiner", `a${cp(0x2060)}b`, "U+2060"],
  ["a byte order mark past the start", `a${cp(0xfeff)}b`, "U+FEFF"],
  ["a bidi override", `a${cp(0x202e)}b`, "U+202E"],
  ["a bidi isolate", `a${cp(0x2066)}b${cp(0x2069)}`, "U+2066, U+2069"],
  ["a stray emoji presentation selector", `a${cp(0xfe0f)}`, "U+FE0F"],
  ["a variation selector", `a${cp(0xfe00)}`, "U+FE00"],
  ["a supplementary variation selector", `a${cp(0xe0100)}`, "U+E0100"],
  ["a stray Mongolian selector", `a${cp(0x180b)}`, "U+180B"],
  ["a stray Mongolian vowel separator", `a${cp(0x180e)}`, "U+180E"],
  ["a run of Unicode tags", `ok${cp(0xe0041, 0xe0042, 0xe0043)}`, "3 Unicode tag characters"],
];

const FILES = [
  "AGENTS.md", "CLAUDE.md", "GEMINI.md", "packages/web/AGENTS.md", ".claude/CLAUDE.md", ".claude/rules/testing.md",
  ".agents/skills/release/SKILL.md", ".cursor/rules/style.mdc", ".gemini/GEMINI.md", ".gemini/styleguide.md",
];

// One call per tool shape, each writing `text` into `file` under `root`.
const SHAPES = {
  Write: (root, file, text) => ["claude", { tool_name: "Write", cwd: root, tool_input: { file_path: path.join(root, file), content: text } }],
  Edit: (root, file, text) => ["claude", { tool_name: "Edit", cwd: root, tool_input: { file_path: path.join(root, file), old_string: "x", new_string: text } }],
  MultiEdit: (root, file, text) => ["claude", {
    tool_name: "MultiEdit", cwd: root,
    tool_input: { file_path: path.join(root, file), edits: [{ old_string: "x", new_string: "plain" }, { old_string: "y", new_string: text }] },
  }],
  apply_patch: (root, file, text) => ["claude", {
    tool_name: "apply_patch", cwd: root,
    tool_input: { command: `*** Begin Patch\r\n*** Update File: ${file}\r\n@@\r\n context\r\n-old\r\n+${text}\r\n*** End Patch` },
  }],
  write_to_file: (root, file, text) => ["antigravity", { toolCall: { name: "write_to_file", args: { TargetFile: path.join(root, file), CodeContent: text } } }],
  replace_file_content: (root, file, text) => ["antigravity", {
    workspacePaths: [root], toolCall: { name: "replace_file_content", args: { TargetFile: file, ReplacementChunks: [{ ReplacementContent: text }] } },
  }],
};

const reasonOf = (output) => output?.hookSpecificOutput?.permissionDecisionReason ?? (output?.decision === "deny" ? output.reason : null);
const allowed = (host, output) => (host === "antigravity" ? output?.decision === "allow" : output === null);

describe("a write into an instruction file", () => {
  test("is refused for every hidden character class, file kind and tool shape, naming the file and code points", () => {
    const root = project();
    const misses = [];
    let calls = 0;
    for (const [label, text, named] of HIDDEN) {
      for (const file of FILES) {
        for (const [shape, build] of Object.entries(SHAPES)) {
          const [host, data] = build(root, file, text);
          const reason = reasonOf(decide(host, data));
          calls += 1;
          if (!reason || !reason.includes(file) || !reason.includes(named) || [...reason].some(isTag)) {
            misses.push(`${shape} ${file}: ${label} -> ${reason}`);
          }
        }
      }
    }
    assert.deepStrictEqual(misses, []);
    assert.strictEqual(calls, HIDDEN.length * FILES.length * Object.keys(SHAPES).length);
  });

  test("a patch that adds a file or moves one is read by the file each line lands in", () => {
    const root = project();
    const patch = (command) => decide("claude", { tool_name: "apply_patch", cwd: root, tool_input: { command } });
    assert.match(reasonOf(patch(`*** Begin Patch\n*** Add File: notes.md\n+plain\n*** Add File: AGENTS.md\n+a${cp(0x200b)}\n*** End Patch`)), /AGENTS\.md.*U\+200B/);
    assert.match(reasonOf(patch(`*** Begin Patch\n*** Update File: notes.md\n*** Move to: CLAUDE.md\n@@\n+a${cp(0x2060)}\n*** End Patch`)), /CLAUDE\.md.*U\+2060/);
    assert.strictEqual(patch(`*** Begin Patch\n*** Update File: AGENTS.md\n@@\n-a${cp(0x200b)}\n+a\n*** End Patch`), null);
    assert.match(reasonOf(patch(`*** Begin Patch\n *** Add File: AGENTS.md\n+a${cp(0x200b)}\n*** End Patch`)), /AGENTS\.md.*U\+200B/);
    assert.match(reasonOf(patch(`*** Begin Patch\n*** Update File: notes.md\n\t*** Move to: CLAUDE.md\n@@\n+a${cp(0x2060)}\n*** End Patch`)), /CLAUDE\.md.*U\+2060/);
    assert.match(reasonOf(patch(`*** Begin Patch\n*** Add File: notes.md\n+plain\n *** Add File: AGENTS.md\n+a${cp(0x200b)}\n*** End Patch`)), /AGENTS\.md.*U\+200B/);
  });

  test("a context line of an Update File section that reads like a header stays in that section", () => {
    const root = project();
    const patch = (command) => decide("claude", { tool_name: "apply_patch", cwd: root, tool_input: { command } });
    assert.match(reasonOf(patch(`*** Begin Patch\n*** Update File: AGENTS.md\n@@\n *** Update File: src/app.py\n+evil${cp(0x200b)}\n*** End Patch`)) ?? "", /AGENTS\.md.*U\+200B/);
    assert.match(reasonOf(patch(`*** Begin Patch\n*** Update File: CLAUDE.md\n *** Move to: notes.md\n+evil${cp(0x2060)}\n*** End Patch`)) ?? "", /CLAUDE\.md.*U\+2060/);
    assert.match(reasonOf(patch(`*** Begin Patch\n*** Update File: notes.md\n@@\n x\n*** Delete File: old.md\n *** Add File: AGENTS.md\n+a${cp(0x200b)}\n*** End Patch`)) ?? "", /AGENTS\.md.*U\+200B/);
  });

  test("is refused whatever the letter case of the file or folder name", () => {
    const root = project();
    for (const file of ["agents.md", "Claude.MD", "packages/web/gemini.md", ".Claude/rules/x.md", ".CURSOR/RULES/style.MDC", ".Agents/skills/a/SKILL.md"]) {
      const reason = reasonOf(decide("claude", { tool_name: "Write", cwd: root, tool_input: { file_path: path.join(root, file), content: `a${cp(0x200b)}` } }));
      assert.match(reason ?? "", /U\+200B/, file);
    }
  });
});

describe("the guard stays silent", () => {
  test("on near misses", () => {
    const root = project();
    const write = (file, content) => decide("claude", { tool_name: "Write", cwd: root, tool_input: { file_path: path.join(root, file), content } });
    const nearMisses = [
      ["plain text", "AGENTS.md", "Run `npm run check`."],
      ["an emoji joined by zero-width joiners", "AGENTS.md", `team ${cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)}`],
      ["an emoji presentation selector", "CLAUDE.md", `${cp(0x2764, 0xfe0f)} ok`],
      ["a keycap", "CLAUDE.md", `${cp(0x31, 0xfe0f, 0x20e3)} step`],
      ["a subdivision flag", "AGENTS.md", cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f)],
      ["a Mongolian letter's selector", "GEMINI.md", cp(0x1820, 0x180b)],
      ["a leading byte order mark", "AGENTS.md", `${cp(0xfeff)}# Title`],
      ["a hidden character in a source file", "src/strings.js", `const zw = "${cp(0x200b)}";`],
      ["a hidden character in other Markdown", "docs/guide.md", `a${cp(0x200b)}b`],
      ["an instruction folder below the root", "packages/web/.claude/rules/x.md", `a${cp(0x200b)}b`],
      ["Markdown that is not an instruction file under .cursor", ".cursor/notes.md", `a${cp(0x200b)}b`],
      ["an escape written as text", "AGENTS.md", "write U+200B as \\u200B"],
    ];
    assert.deepStrictEqual(nearMisses.filter(([, file, content]) => write(file, content) !== null).map(([label]) => label), []);
  });

  test("on other tools, unreadable input and payloads without a path", () => {
    const root = project();
    const hidden = `a${cp(0x200b)}`;
    assert.strictEqual(decide("claude", { tool_name: "Bash", cwd: root, tool_input: { command: `echo ${hidden} > AGENTS.md` } }), null);
    assert.strictEqual(decide("claude", { tool_name: "Write", cwd: root, tool_input: { content: hidden } }), null);
    assert.strictEqual(decide("claude", {}), null);
    assert.deepStrictEqual(decide("antigravity", { toolCall: { name: "run_command", args: { CommandLine: hidden } } }), { decision: "allow" });
    assert.deepStrictEqual(decide("antigravity", {}), { decision: "allow" });
  });

  test("on every tracked Markdown file of this repository, written back unchanged", () => {
    const files = execFileSync("git", ["-C", REPOSITORY, "ls-files", "-z", "--", "*.md", "*.mdc"], { encoding: "utf8" })
      .split("\0").filter(Boolean);
    const fired = [];
    let instructions = 0;
    for (const file of files) {
      const absolute = path.join(REPOSITORY, file);
      if (!fs.existsSync(absolute)) continue;
      if (isInstructionFile(absolute, REPOSITORY)) instructions += 1;
      const output = decide("claude", { tool_name: "Write", cwd: REPOSITORY, tool_input: { file_path: absolute, content: fs.readFileSync(absolute, "utf8") } });
      if (output !== null) fired.push(file);
    }
    assert.deepStrictEqual(fired, []);
    assert.ok(instructions >= 5, `${instructions} tracked instruction files`);
  });
});

describe("the hook process", () => {
  const run = (host, data) => spawnSync(process.execPath, [HOOK, host], { input: JSON.stringify(data), encoding: "utf8" });

  test("answers each host on its wire", () => {
    const root = project();
    for (const [shape, build] of Object.entries(SHAPES)) {
      const [host, data] = build(root, "AGENTS.md", `a${cp(0x200b)}`);
      const denied = run(host, data);
      assert.strictEqual(denied.status, 0, shape);
      const output = JSON.parse(denied.stdout);
      if (host === "antigravity") assert.strictEqual(output.decision, "deny", shape);
      else assert.strictEqual(output.hookSpecificOutput.permissionDecision, "deny", shape);
      assert.match(reasonOf(output), /AGENTS\.md.*U\+200B/, shape);
      const [, plain] = build(root, "AGENTS.md", "plain");
      const passed = run(host, plain);
      assert.ok(allowed(host, passed.stdout ? JSON.parse(passed.stdout) : null), shape);
    }
  });

  test("allows a payload that is not JSON", () => {
    const claude = spawnSync(process.execPath, [HOOK, "claude"], { input: "{not json", encoding: "utf8" });
    assert.strictEqual(claude.status, 0);
    assert.strictEqual(claude.stdout, "");
    const antigravity = spawnSync(process.execPath, [HOOK, "antigravity"], { input: "{not json", encoding: "utf8" });
    assert.deepStrictEqual(JSON.parse(antigravity.stdout), { decision: "allow" });
  });
});
