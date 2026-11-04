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
const { check, committedIgnored } = require("../scripts/docs-check.js");

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

function repo(gitignore = GITIGNORE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anneal-repo-docs-templates-"));
  created.push(root);
  execFileSync("git", ["-C", root, "init", "-q"]);
  fs.writeFileSync(path.join(root, ".git", "empty-excludes"), "");
  execFileSync("git", ["-C", root, "config", "core.excludesFile", path.join(root, ".git", "empty-excludes")]);
  fs.writeFileSync(path.join(root, ".gitignore"), gitignore);
  return root;
}

function ignored(root, file) {
  const result = spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-q", "--", file], { encoding: "utf8" });
  assert.ok([0, 1].includes(result.status), result.stderr);
  return result.status === 0;
}

const section = (text, heading) => text.split(/^## /m).find((part) => part.startsWith(heading)) ?? "";
const bullets = (text) => text.split(/\r?\n/).filter((line) => line.startsWith("- ")).map((line) => line.trim());

test("the ignore template hides private records and leaves public product files visible", () => {
  const root = repo();
  const cases = [
    [".private/raw/x.jsonl", true], ["docs/tasks/current.md", true], ["docs/decisions/a.md", true],
    ["docs/knowledge/private/r.md", true], ["docs/knowledge/private/nested/t.md", true], ["docs/apis/private/s.md", true],
    ["pkg/docs/tasks/n.md", true], ["pkg/docs/decisions/d.md", true], ["pkg/docs/knowledge/private/p.md", true],
    ["pkg/docs/apis/private/q.md", true], ["pkg/docs/knowledge/public.md", false], ["pkg/docs/README.md", false],
    ["README.md", false], ["AGENTS.md", false], ["CLAUDE.md", false], ["docs/README.md", false],
    ["docs/knowledge/algorithm.md", false], ["docs/knowledge/current-contract.md", false],
    ["docs/apis/client.md", false], ["docs/apis/current-api.md", false],
    [".claude/rules/documentation.md", false], [".claude/settings.json", false], [".claude/skills/x/SKILL.md", false],
    ["src/main.js", false], [".env.example", false],
  ];
  for (const [file, expected] of cases) assert.strictEqual(ignored(root, file), expected, file);
});

test("a root-only ignore file leaves nested private docs committable until the nested rule is appended", () => {
  // The case adopt's append step probes: root rules present, no nested rule, and a root negation
  // that the template's **/ form would override. The nested-only form it appends instead keeps
  // the negation and hides the nested directory.
  const rootOnly = "docs/tasks/*\n!docs/tasks/README.md\ndocs/decisions/\ndocs/knowledge/private/\ndocs/apis/private/\n.private/\n";
  const before = repo(rootOnly);
  assert.strictEqual(ignored(before, "docs/tasks/probe.md"), true);
  assert.strictEqual(ignored(before, "docs/tasks/README.md"), false);
  assert.strictEqual(committedIgnored(before, "docs/tasks/README.md"), false, "a negated match is not coverage");
  assert.strictEqual(committedIgnored(before, "docs/tasks/probe.md"), true);
  assert.strictEqual(ignored(before, "pkg/docs/tasks/probe.md"), false);
  const after = repo(`${rootOnly}*/**/docs/tasks/\n`);
  assert.strictEqual(ignored(after, "pkg/docs/tasks/probe.md"), true);
  assert.strictEqual(ignored(after, "a/b/docs/tasks/probe.md"), true);
  assert.strictEqual(ignored(after, "docs/tasks/README.md"), false);
  const overridden = repo(`${rootOnly}**/docs/tasks/\n`);
  assert.strictEqual(ignored(overridden, "docs/tasks/README.md"), true, "**/ reaches the root and overrides the negation");
  const nestedNegation = repo(`${rootOnly}packages/a/docs/tasks/*\n!packages/a/docs/tasks/README.md\n*/**/docs/tasks/\n`);
  assert.strictEqual(ignored(nestedNegation, "packages/a/docs/tasks/README.md"), true, "*/**/ reaches nested roots, so a nested negation gets no appended rule");
});

test("docs-check reads the template as the ignored profile with no high finding", () => {
  const report = check(repo());
  assert.strictEqual(report.profile, "ignored");
  assert.strictEqual(report.counts.high, 0);
});

test("adopt and docs-check count only a committed .gitignore as covering a private directory", () => {
  const root = repo("");
  fs.writeFileSync(path.join(root, ".git", "empty-excludes"), "docs/tasks/\n");
  fs.writeFileSync(path.join(root, ".git", "info", "exclude"), "docs/decisions/\n");
  assert.strictEqual(ignored(root, "docs/tasks/probe.md"), true, "a machine-local exclude satisfies a plain check-ignore");
  assert.strictEqual(check(root).profile, "versioned");

  const adopt = section(POLICY, "Adopt");
  const steps = adopt.split(/^(?=\d\. )/m);
  for (const step of [2, 4, 6]) assert.ok(/\bcovered\b/.test(steps.find((s) => s.startsWith(`${step}. `)) ?? ""), `step ${step} probes coverage`);
  assert.ok(adopt.includes("`git -c core.excludesFile= check-ignore --no-index -v") && adopt.includes("`core.excludesFile`") && adopt.includes("`.git/info/exclude`"), "coverage names the committed source");
  assert.ok(!adopt.includes("--no-index -q"), "a plain check-ignore counts machine-local excludes");
});

test("the style for each reader is stated in the contract alone", () => {
  const skill = fs.readFileSync(path.join(__dirname, "..", "skills", "repo-docs", "SKILL.md"), "utf8");
  assert.ok(POLICY.includes("exactness and brevity"));
  assert.ok(!skill.includes("exactness and brevity") && skill.includes("references/policy.md#document-kinds"), "SKILL.md points to the contract");
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
  // The append step and the final probes reach a nested package root, not only the repository root.
  assert.strictEqual((adopt.match(/pkg\/docs\/tasks\/probe\.md/g) ?? []).length, 2, "nested probe in the append step and in the verification");
  assert.ok(adopt.includes("`*/**/docs/tasks/`"), "the nested-only rule that spares a root negation");
  assert.ok(adopt.includes("`!packages/a/docs/tasks/README.md`") && /append no nested rule/.test(adopt), "a nested negation gets no blanket rule");
});
