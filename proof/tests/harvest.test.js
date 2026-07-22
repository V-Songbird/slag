"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseGitLog, mineCommits, classify, LOG_FORMAT } = require("../lib/harvest");

// Build a raw log the way `git log --format=<LOG_FORMAT> --name-only` would.
const REC = "\x1e";
const UNIT = "\x1f";
function rec(sha, subject, body, files) {
  return `${REC}${sha}${UNIT}${subject}${UNIT}${body}${UNIT}\n${files.join("\n")}\n`;
}

const RAW = [
  rec("aaaaaaaaaaaa1", "Revert \"add rate limiter\"", "This reverts commit deadbeef.", ["src/limiter.js", "src/limiter.test.js"]),
  rec("bbbbbbbbbbbb2", "fix: null deref in parseConfig", "closes #42", ["src/config.js"]),
  rec("cccccccccccc3", "Add dark mode toggle", "feature work", ["src/theme.js"]),
  rec("dddddddddddd4", "hotfix crash on empty input", "", ["src/input.js"]),
].join("");

test("parseGitLog splits records and file lists across newline-bearing bodies", () => {
  const commits = parseGitLog(RAW);
  assert.equal(commits.length, 4);
  assert.equal(commits[0].sha, "aaaaaaaaaaaa1");
  assert.equal(commits[0].subject, 'Revert "add rate limiter"');
  assert.deepEqual(commits[0].files, ["src/limiter.js", "src/limiter.test.js"]);
  assert.deepEqual(commits[1].files, ["src/config.js"]);
});

test("classify recognizes reverts and bug-fixes, skips plain features", () => {
  assert.equal(classify({ subject: 'Revert "x"' }), "revert");
  assert.equal(classify({ subject: "fix: null deref" }), "bugfix");
  assert.equal(classify({ subject: "hotfix crash on empty input" }), "bugfix");
  assert.equal(classify({ subject: "Add dark mode toggle" }), null);
});

test("mineCommits keeps only revert/bugfix commits and drops features", () => {
  const tasks = mineCommits(parseGitLog(RAW));
  assert.equal(tasks.length, 3); // limiter revert, config fix, input hotfix — theme feature dropped
  assert.deepEqual(tasks.map((t) => t.type).sort(), ["bugfix", "bugfix", "revert"]);
});

test("a mined task carries a provisional assertion on a touched code file", () => {
  const tasks = mineCommits(parseGitLog(RAW));
  const fix = tasks.find((t) => t.id.startsWith("bugfix-bbbbbbb"));
  assert.equal(fix.type, "bugfix");
  assert.equal(fix.assert.length, 1);
  assert.equal(fix.assert[0].path, "src/config.js");
  assert.equal(fix.assert[0]._provisional, true);
  assert.equal(fix.assertProvisional, true);
  assert.match(fix.prompt, /parseConfig|fix/i);
});

test("mineCommits honors a limit", () => {
  assert.equal(mineCommits(parseGitLog(RAW), { limit: 1 }).length, 1);
});

test("LOG_FORMAT embeds the record and unit separators", () => {
  assert.ok(LOG_FORMAT.includes(REC) && LOG_FORMAT.includes(UNIT));
});
