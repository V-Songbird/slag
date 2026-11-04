"use strict";

// The two files repo-docs' adopt mode writes into a project: the ignore template for the
// solo-public profile and the project-local rule, pinned against the contract they come from.

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
require("./temp-root.js");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { check } = require("../scripts/docs-check.js");

process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();

const TEMPLATES = path.join(__dirname, "..", "templates");
const GITIGNORE = fs.readFileSync(path.join(TEMPLATES, "gitignore"), "utf8");
const RULE = fs.readFileSync(path.join(TEMPLATES, "docs-rule.md"), "utf8");
const POLICY = fs.readFileSync(path.join(__dirname, "..", "skills", "repo-docs", "references", "policy.md"), "utf8");
const PRIVATE_RULES = [".private/", "docs/tasks/", "docs/decisions/", "docs/knowledge/private/", "docs/apis/private/"];

const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anneal-repo-docs-templates-"));
  created.push(root);
  execFileSync("git", ["-C", root, "init", "-q"]);
  fs.writeFileSync(path.join(root, ".git", "empty-excludes"), "");
  execFileSync("git", ["-C", root, "config", "core.excludesFile", path.join(root, ".git", "empty-excludes")]);
  fs.writeFileSync(path.join(root, ".gitignore"), GITIGNORE);
  return root;
}

const section = (text, heading) => text.split(/^## /m).find((part) => part.startsWith(heading)) ?? "";
const bullets = (text) => text.split(/\r?\n/).filter((line) => line.startsWith("- ")).map((line) => line.trim());

test("the ignore template hides private records and leaves public product files visible", () => {
  const root = repo();
  const cases = [
    [".private/raw/x.jsonl", true], ["docs/tasks/current.md", true], ["docs/decisions/a.md", true],
    ["docs/knowledge/private/r.md", true], ["docs/knowledge/private/nested/t.md", true], ["docs/apis/private/s.md", true],
    ["README.md", false], ["AGENTS.md", false], ["CLAUDE.md", false], ["docs/README.md", false],
    ["docs/knowledge/algorithm.md", false], ["docs/knowledge/current-contract.md", false],
    ["docs/apis/client.md", false], ["docs/apis/current-api.md", false],
    [".claude/rules/documentation.md", false], [".claude/settings.json", false], [".claude/skills/x/SKILL.md", false],
    ["src/main.js", false], [".env.example", false],
  ];
  for (const [file, expected] of cases) {
    const result = spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-q", "--", file], { encoding: "utf8" });
    assert.ok([0, 1].includes(result.status), result.stderr);
    assert.strictEqual(result.status === 0, expected, file);
  }
});

test("docs-check reads the template as the ignored profile with no high finding", () => {
  const report = check(repo());
  assert.strictEqual(report.profile, "ignored");
  assert.strictEqual(report.counts.high, 0);
});

test("the template ignores each private directory once and never a documentation root", () => {
  const rules = GITIGNORE.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  for (const rule of PRIVATE_RULES) assert.strictEqual(rules.filter((line) => line === rule).length, 1, rule);
  assert.deepStrictEqual(rules.filter((line) => /^\/?docs\/?$|^\/?docs\/(knowledge|apis)\/?$/.test(line)), []);
});

test("the project-local rule repeats the contract's five invariants", () => {
  assert.ok(!RULE.startsWith("---"), "the rule has no frontmatter, so Claude Code loads it every session");
  assert.ok(RULE.length < 1500, `rule is ${RULE.length} characters`);
  assert.strictEqual((RULE.match(/<profile>/g) ?? []).length, 1);
  assert.ok(/never untracks? /.test(RULE));
  for (const dir of ["docs/", "docs/knowledge/", "docs/apis/"]) assert.ok(RULE.includes(`\`${dir}\``), dir);
  const invariants = bullets(section(POLICY, "Invariants"));
  assert.strictEqual(invariants.length, 5);
  assert.deepStrictEqual(bullets(RULE), invariants);
});

test("the adopt procedure never untracks and names the files it writes", () => {
  const adopt = section(POLICY, "Adopt");
  assert.ok(adopt.length > 0);
  // The only mention of git rm is the sentence that forbids it.
  assert.ok(!adopt.replace("Never run `git rm`, `git rm --cached`", "").includes("git rm"), "adopt runs git rm");
  assert.ok(adopt.includes(".claude/rules/documentation.md"));
  assert.ok(adopt.includes("templates/gitignore"));
  assert.ok(adopt.includes("templates/docs-rule.md"));
});
