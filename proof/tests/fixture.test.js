"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { materialize } = require("../lib/fixture");

const SPEC = {
  claudeMd: "# Project notes\n\nSome context.\n\n{{CONFIG}}\n",
  fixture: {
    "src/num.js": "\"use strict\";\nmodule.exports = {};\n",
    "docs/api.md": "# API\n",
  },
};

test("treatment arm injects the config into CLAUDE.md; fixture files land", () => {
  const dir = materialize(SPEC, "- When you export a new function from src/, list it in docs/api.md.");
  const claudeMd = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8");
  assert.match(claudeMd, /list it in docs\/api\.md/);
  assert.ok(fs.existsSync(path.join(dir, "src/num.js")));
  assert.ok(fs.existsSync(path.join(dir, "docs/api.md")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("baseline arm (null config) leaves no config and no marker", () => {
  const dir = materialize(SPEC, null);
  const claudeMd = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8");
  assert.doesNotMatch(claudeMd, /\{\{CONFIG\}\}/);
  assert.doesNotMatch(claudeMd, /list it in docs/);
  assert.match(claudeMd, /Some context/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("config text with $-sequences is injected literally", () => {
  const dir = materialize(SPEC, "Use $1 and $& literally.");
  assert.match(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf-8"), /Use \$1 and \$& literally\./);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("baseline and treatment differ only by the injected config", () => {
  const base = materialize(SPEC, null);
  const treat = materialize(SPEC, "- a rule.");
  assert.equal(
    fs.readFileSync(path.join(base, "src/num.js"), "utf-8"),
    fs.readFileSync(path.join(treat, "src/num.js"), "utf-8"),
  );
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(treat, { recursive: true, force: true });
});
