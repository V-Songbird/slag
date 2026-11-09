"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { RELEASE, releaseProblems } = require("./release-gate.js");

const ROOT = path.join(__dirname, "..", "..");
const HOOK = path.join(__dirname, "commit-msg");
const DASH = "—";

function files(over = {}) {
  return {
    ".claude-plugin/marketplace.json": JSON.stringify({ plugins: [{ name: "anneal", version: "0.6.0-alpha", source: "./anneal" }] }),
    ".agents/plugins/marketplace.json": JSON.stringify({ plugins: [{ name: "anneal", source: { path: "./anneal" } }] }),
    "anneal/.claude-plugin/plugin.json": JSON.stringify({ name: "anneal" }),
    "anneal/.codex-plugin/plugin.json": JSON.stringify({ name: "anneal", version: "0.6.0-alpha" }),
    "anneal/plugin.json": JSON.stringify({ name: "anneal", version: "0.6.0-alpha" }),
    "anneal/docs/knowledge/changelog.md": `# Changelog\n\n## [Unreleased]\n\n## [0.6.0-alpha] ${DASH} 2026-11-09\n\n### Fixed\n\n- x\n`,
    ...over,
  };
}

function tree(over) {
  const all = files(over);
  return (p) => (Object.hasOwn(all, p) && all[p] !== null ? all[p] : null);
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.strictEqual(r.status, 0, `git ${args.join(" ")}: ${r.error?.message ?? r.stderr}`);
  return r.stdout;
}

test("a whole release passes", () => {
  assert.deepStrictEqual(releaseProblems("Release anneal 0.6.0-alpha", tree()), []);
});

test("a commit that is not a release is not judged", () => {
  assert.strictEqual(releaseProblems("Fix the guard", tree()), null);
  assert.strictEqual(releaseProblems("Release notes for anneal", tree()), null);
  assert.strictEqual(releaseProblems("Release anneal 0.6.0-alpha now", tree()), null);
});

test("a subject that names no marketplace plugin is not judged", () => {
  assert.strictEqual(releaseProblems("Release gate tests", tree()), null);
  assert.strictEqual(releaseProblems("Release anneal 0.6.0-alpha", tree({ ".claude-plugin/marketplace.json": null })), null);
});

test("a host version left behind is named", () => {
  const p = releaseProblems("Release anneal 0.6.0-alpha", tree({ "anneal/plugin.json": JSON.stringify({ name: "anneal", version: "0.5.1-alpha" }) }));
  assert.match(p.join("\n"), /anneal\/plugin.json version 0.5.1-alpha/);
});

test("a version in the Claude manifest or the Codex index is named", () => {
  const p = releaseProblems("Release anneal 0.6.0-alpha", tree({
    "anneal/.claude-plugin/plugin.json": JSON.stringify({ name: "anneal", version: "0.6.0-alpha" }),
    ".agents/plugins/marketplace.json": JSON.stringify({ plugins: [{ name: "anneal", version: "0.6.0-alpha" }] }),
  }));
  assert.match(p.join("\n"), /\.claude-plugin\/plugin.json carries a version/);
  assert.match(p.join("\n"), /\.agents\/plugins\/marketplace.json carries a version/);
});

test("an undated changelog, or one with no Unreleased above the release, is named", () => {
  const undated = releaseProblems("Release anneal 0.6.0-alpha", tree({ "anneal/docs/knowledge/changelog.md": "## [Unreleased]\n\n- x\n" }));
  assert.match(undated.join("\n"), /no "## \[0.6.0-alpha\]/);
  const below = releaseProblems("Release anneal 0.6.0-alpha", tree({ "anneal/docs/knowledge/changelog.md": `## [0.6.0-alpha] ${DASH} 2026-11-09\n\n## [Unreleased]\n` }));
  assert.match(below.join("\n"), /\[Unreleased\] is not above/);
});

test("a version that is a prefix of another does not match it", () => {
  const p = releaseProblems("Release anneal 0.6.0", tree());
  assert.match(p.join("\n"), /marketplace version 0.6.0-alpha is not 0.6.0/);
  assert.match(p.join("\n"), /no "## \[0.6.0\]/);
});

test("a plugin without Codex or Antigravity manifests is judged on what it ships", () => {
  assert.deepStrictEqual(releaseProblems("Release anneal 0.6.0-alpha", tree({ "anneal/.codex-plugin/plugin.json": null, "anneal/plugin.json": null })), []);
});

test("the three most recent release commits in history pass", (t) => {
  const log = spawnSync("git", ["log", "--format=%H %s", "--grep=^Release "], { cwd: ROOT, encoding: "utf8" });
  const judged = [];
  for (const line of log.status === 0 ? log.stdout.split("\n").filter((l) => RELEASE.test(l.slice(41))) : []) {
    const sha = line.slice(0, 40);
    const read = (p) => {
      const r = spawnSync("git", ["show", `${sha}:${p}`], { cwd: ROOT, encoding: "utf8" });
      return r.status === 0 ? r.stdout : null;
    };
    const problems = releaseProblems(line.slice(41), read);
    if (problems !== null) judged.push([line, problems]);
    if (judged.length === 3) break;
  }
  if (judged.length < 3) return t.skip("fewer than three release commits in this checkout's history");
  for (const [line, problems] of judged) assert.deepStrictEqual(problems, [], line);
});

test("the commit-msg hook judges the index, not the working tree", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-gate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q"]);
  const write = (all) => {
    for (const [p, text] of Object.entries(all)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), text);
    }
  };
  const env = { ...process.env };
  delete env.HOUSE_REFERENCE_BLOCKLIST;
  const hook = (subject) => {
    fs.writeFileSync(path.join(dir, "message.txt"), `${subject}\n`);
    return spawnSync(process.execPath, [HOOK, path.join(dir, "message.txt")], { cwd: dir, encoding: "utf8", env });
  };
  const broken = { "anneal/docs/knowledge/changelog.md": "# Changelog\n\n## [Unreleased]\n" };

  write(files());
  git(dir, ["add", "-A"]);
  write(broken);
  let r = hook("Release anneal 0.6.0-alpha");
  assert.strictEqual(r.status, 0, r.stderr);

  git(dir, ["add", "-A"]);
  r = hook("Release anneal 0.6.0-alpha");
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /release gate: anneal\/docs\/knowledge\/changelog.md has no "## \[0.6.0-alpha\]/);

  r = hook("Fix the changelog");
  assert.strictEqual(r.status, 0, r.stderr);
});
