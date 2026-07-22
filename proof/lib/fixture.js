"use strict";

// Fixture manager — materializes one arm's isolated checkout: copies the
// fixture file tree into a throwaway tmpdir and injects the arm's config text
// into the CLAUDE.md template. Baseline and treatment differ ONLY by the
// injected config, which is what makes the pairing mean something.
//
// razor: copy-to-tmpdir isolation only. A/B against a live git repo (a
// worktree per arm, pinned to a SHA) is a later addition — the milestone's
// gold-cell reproduction runs on a synthetic fixture, which a worktree cannot
// check out. Upgrade path: add a `source: <repoPath>` mode that provisions via
// `git worktree add --detach` (confirmed fast/reliable on this host) with a
// copy-clone fallback, selected by a probe.

const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG_MARK = "{{CONFIG}}";

function writeInto(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/**
 * @param {object} spec        the A/B spec (fixture tree + claudeMd template)
 * @param {string|object|null} armConfig  config for this arm:
 *   - null              => no config (baseline): template with an empty slot
 *   - string            => rule text injected into the CLAUDE.md `{{CONFIG}}` slot
 *   - object {rel:body} => per-arm file overrides written over the fixture tree
 *     (a "CLAUDE.md" key replaces the template outright). This is the skill-firing
 *     case, where the A/B varies a `.claude/skills/<name>/SKILL.md` — and, for a
 *     companion-rule arm, both that file and CLAUDE.md.
 * @returns {string} absolute path to the materialized checkout dir
 */
function materialize(spec, armConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-"));
  for (const [rel, content] of Object.entries(spec.fixture || {})) {
    writeInto(dir, rel, content);
  }
  const isObj = armConfig != null && typeof armConfig === "object";
  const template = spec.claudeMd || "# Project notes\n\n{{CONFIG}}\n";
  const configText = isObj || armConfig == null ? "" : String(armConfig);
  // Function replacement so `$`-sequences in the config text are literal, not
  // treated as replacement patterns.
  const claudeMd = template
    .replace(/^.*\{\{CONFIG\}\}.*$/m, () => configText)
    .replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), claudeMd);
  // Object arms write their files last so a "CLAUDE.md" key overrides the template.
  if (isObj) {
    for (const [rel, content] of Object.entries(armConfig)) writeInto(dir, rel, content);
  }
  return dir;
}

module.exports = { materialize, CONFIG_MARK };
