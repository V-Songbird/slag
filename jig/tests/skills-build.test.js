"use strict";

// The two skill trees are generated from one source per file. These tests hold
// the generated files to their sources and each tree to its own host's surface.

const test = require("node:test");
const assert = require("node:assert/strict");
const build = require("../scripts/build-skills.js");

test("every generated skill file matches its single source", () => {
  assert.deepEqual(build.drift(), [], "edit skill-sources/, then run node jig/scripts/build-skills.js");
});

test("a host block reaches only its host, and shared text reaches both", () => {
  const text = ["shared", "<!-- host: claude -->", "claude only", "<!-- host: codex -->", "codex only",
    "<!-- host: end -->", "tail", ""].join("\n");
  assert.deepEqual(build.render(text), { claude: "shared\nclaude only\ntail\n", codex: "shared\ncodex only\ntail\n" });
  assert.deepEqual(build.render("<!-- host: codex -->\nonly\n<!-- host: end -->\n"), { claude: "", codex: "only\n" });
});

test("a marker that never closes, nests or names another host is refused", () => {
  for (const [text, message] of [
    ["<!-- host: claude -->\nx\n", /never closed/],
    ["<!-- host: codex -->\n<!-- host: claude -->\n<!-- host: end -->\n", /inside an open codex block/],
    ["<!-- host: codex -->\n<!-- host: codex -->\n<!-- host: end -->\n", /inside an open codex block/],
    ["<!-- host: end -->\n", /closes no block/],
    ["<!-- host: cursor -->\n", /unknown host marker/],
  ]) assert.throws(() => build.render(text), message);
});

test("each tree hands out only its own host's invocations", () => {
  const files = build.expected();
  for (const [rel, text] of files.codex) {
    assert.doesNotMatch(text, /\/jig:(?:jig|review|inventory)\b|\$\{CLAUDE_PLUGIN_ROOT\}|AskUserQuestion/, "codex-skills/" + rel);
    // Without the flag the engine plans for Claude Code's instruction and hook files.
    for (const line of text.split("\n").filter((l) => l.includes("scripts/jig.js\" "))) {
      assert.match(line, /scripts\/jig\.js" --runtime codex /, "codex-skills/" + rel + ": " + line);
    }
  }
  for (const [rel, text] of files.claude) {
    assert.doesNotMatch(text, /\$(?:jig|review|inventory)\b|--runtime codex/, "skills/" + rel);
  }
  assert.ok(files.codex.has("jig/references/codex-runtime.md"));
  assert.equal(files.claude.has("jig/references/codex-runtime.md"), false);
});
