"use strict";

// Release-commit gate, run by the commit-msg hook. A commit whose subject is
// "Release <plugin> <version>" must carry the whole release, read from the
// index: the marketplace entry and every host manifest the plugin ships read
// that version, <plugin>/.claude-plugin/plugin.json and the Codex index carry
// none, and the plugin changelog has a "## [<version>] — <YYYY-MM-DD>" heading
// with "## [Unreleased]" above it. Any other subject is not judged.

const fs = require("fs");
const { execFileSync } = require("child_process");

const RELEASE = /^Release (\S+) (\S+)$/;

function json(read, p) {
  const text = read(p);
  if (text === null) return { missing: true };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { broken: true };
  }
}

// read(path) returns the file's text in the commit being judged, or null when it is absent.
// Returns null when the subject is not a release, else one line per problem.
function releaseProblems(message, read) {
  const m = RELEASE.exec(String(message).split(/\r?\n/)[0].trim());
  if (!m) return null;
  const [, plugin, version] = m;
  const problems = [];
  const market = json(read, ".claude-plugin/marketplace.json");
  const entry = market.value?.plugins?.find((p) => p.name === plugin);
  if (!entry) problems.push(`.claude-plugin/marketplace.json has no entry named ${plugin}`);
  else if (entry.version !== version) problems.push(`marketplace version ${entry.version} is not ${version}`);
  for (const p of [`${plugin}/.codex-plugin/plugin.json`, `${plugin}/plugin.json`]) {
    const manifest = json(read, p);
    if (manifest.missing) continue;
    if (manifest.broken) problems.push(`${p} is not JSON`);
    else if (manifest.value.version !== version) problems.push(`${p} version ${manifest.value.version} is not ${version}`);
  }
  const claude = json(read, `${plugin}/.claude-plugin/plugin.json`);
  if (claude.value && Object.hasOwn(claude.value, "version")) problems.push(`${plugin}/.claude-plugin/plugin.json carries a version`);
  const index = json(read, ".agents/plugins/marketplace.json");
  if (index.value?.plugins?.some((p) => p.name === plugin && Object.hasOwn(p, "version"))) problems.push(".agents/plugins/marketplace.json carries a version");
  const changelog = `${plugin}/docs/knowledge/changelog.md`;
  const log = read(changelog);
  if (log === null) problems.push(`${changelog} is missing`);
  else {
    const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dated = new RegExp(`^## \\[${esc}\\] — \\d{4}-\\d{2}-\\d{2}\\s*$`, "m").exec(log);
    const unreleased = /^## \[Unreleased\]\s*$/m.exec(log);
    if (!dated) problems.push(`${changelog} has no "## [${version}] — <YYYY-MM-DD>" heading`);
    if (!unreleased) problems.push(`${changelog} has no "## [Unreleased]" heading`);
    else if (dated && unreleased.index > dated.index) problems.push(`${changelog}: [Unreleased] is not above the release heading`);
  }
  return problems;
}

function readStaged(p) {
  try {
    return execFileSync("git", ["show", `:${p}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function main(messageFile) {
  const problems = releaseProblems(fs.readFileSync(messageFile, "utf8"), readStaged);
  if (!problems?.length) return 0;
  for (const p of problems) console.error(`release gate: ${p}`);
  return 1;
}

module.exports = { RELEASE, releaseProblems, main };
