"use strict";

// The eval harness's grader verdicts, for tests that grade eval cases without a
// model session. A tool_used grader counts the calls to its tool whose input,
// as JSON text, matches input_match. A regex grader tests its pattern against
// the run's last reply, its trace, the paths it created or a file in its
// directory, where a missing file fails.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// The YAML the case files use: one `key: value` per line, whose value is a
// single-quoted string, a flow sequence or mapping of plain words, or a plain
// scalar. The frontmatter ends where the harness ends it, at the first "---"
// wherever it stands, so a value that holds "---" is cut short there.
function frontmatter(file) {
  const head = /^---\s*\n([\s\S]*?)---\s*\n?/.exec(fs.readFileSync(file, "utf8"));
  assert.ok(head, `${file} opens with frontmatter`);
  return Object.fromEntries(
    head[1].split("\n").filter((line) => line.trim() !== "").map((line) => {
      const pair = /^([a-z_]+): (.+)$/.exec(line);
      assert.ok(pair, `${file}: unsupported frontmatter line ${JSON.stringify(line)}`);
      const value = pair[2];
      if (value.startsWith("'")) {
        assert.ok(value.length > 1 && value.endsWith("'"), `${file}: ${pair[1]} is an unterminated quoted value`);
        return [pair[1], value.slice(1, -1).replaceAll("''", "'")];
      }
      if (value.startsWith("[")) return [pair[1], value.slice(1, -1).split(",").map((item) => item.trim())];
      if (value.startsWith("{")) return [pair[1], Object.fromEntries(value.slice(1, -1).split(",").map((item) => item.split(":").map((part) => part.trim())))];
      return [pair[1], value];
    }),
  );
}

// A case's graders in file order, each named after its file.
function readGraders(caseDir) {
  const folder = path.join(caseDir, "graders");
  return fs.readdirSync(folder).sort().map((file) => ({ name: path.basename(file, ".md"), ...frontmatter(path.join(folder, file)) }));
}

// The keys the harness accepts on each grader type.
const KEYS = {
  tool_used: ["name", "type", "tool", "input_match", "min", "max", "weight", "arm"],
  regex: ["name", "type", "target", "pattern", "flags", "match", "weight", "arm"],
};

// A run has its tool calls as { name, input }, its trace as one serialized
// event per line, its last reply, the paths it created one per line, and its
// directory.
function passes(grader, run) {
  assert.ok(KEYS[grader.type], `${grader.name} is a tool_used or regex grader`);
  const unknown = Object.keys(grader).filter((key) => !KEYS[grader.type].includes(key));
  assert.deepStrictEqual(unknown, [], `${grader.name} uses only keys this test evaluates`);
  if (grader.type === "tool_used") {
    const count = (run.calls ?? []).filter((call) => call.name === grader.tool && (!grader.input_match || new RegExp(grader.input_match).test(JSON.stringify(call.input)))).length;
    return count >= Number(grader.min ?? 1) && count <= Number(grader.max ?? Infinity);
  }
  const { target = "last_message", pattern, flags = "", match = "contains" } = grader;
  let text;
  if (target === "last_message") text = run.reply ?? "";
  else if (target === "trace") text = run.trace ?? "";
  else if (target === "files") text = run.created ?? "";
  else {
    assert.strictEqual(target.source, "file", `${grader.name} reads a known target`);
    const file = path.join(run.dir, target.path);
    if (!fs.existsSync(file)) return false;
    text = fs.readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  }
  if (match === "contains") return new RegExp(pattern, flags).test(text);
  if (match === "not_contains") return !new RegExp(pattern, flags).test(text);
  const count = /^count:(\d+)$/.exec(match);
  assert.ok(count, `${grader.name}: unknown match ${match}`);
  return (text.match(new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`)) ?? []).length === Number(count[1]);
}

// Every file under a run directory, .git included, as the harness lists it
// before and after a run.
function listRunFiles(root) {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join("/"));
}

// The paths a run created, sorted, one per line: what a files target reads.
function createdPaths(before, after) {
  const listed = new Set(before);
  return after.filter((file) => !listed.has(file)).sort().join("\n");
}

module.exports = { frontmatter, readGraders, passes, listRunFiles, createdPaths };
