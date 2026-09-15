"use strict";

// The Codex skills as the Codex host loads them. `docs.test.js` holds the Claude
// Code skills; this file holds only what the Codex tree says differently:
// consent without a multi-select tool, a runner resolved from the loaded skill,
// patch-based edit guards, and verification evidence Codex's payloads can give.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const PLUGIN_ROOT = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(PLUGIN_ROOT, "codex-skills", ...parts), "utf-8");
const RUNTIME = ["jig", "references", "codex-runtime.md"];

test("the Codex item tier keeps explicit named consent without a multi-select dependency", () => {
  const skill = read("jig", "SKILL.md");
  const consent = skill.slice(skill.indexOf("Then take consent in two tiers"), skill.indexOf("## 7. Apply"));
  const runtime = read(...RUNTIME);
  assert.ok(consent.includes("consent.item"), "the item consent tier is missing");
  assert.match(consent, /enumerated table/, "consequential changes are not individually enumerated");
  assert.match(consent, /label is the change id/, "a row is not bound to a stable change id");
  assert.match(consent, /exact path, kind and/, "the approval surface omits the path or consequence");
  assert.match(consent, /\*\*Nothing is pre-ticked\.\*\*/, "item consent permits preselection");
  assert.match(consent, /--change <id> --path <rel>/, "approval no longer preserves each exact token pair");
  assert.match(consent, /existing explicit\s+approval only for the same named id, path and consequence/,
    "the workflow does not preserve unchanged prior authorization");
  assert.match(runtime, /conversational approval question/, "mandatory consent has no native fallback");
  assert.match(runtime, /Do not apply\s+unanswered, declined, or implicitly selected rows/,
    "an unanswered or inferred item can silently become consent");
  assert.doesNotMatch(consent + runtime, /AskUserQuestion|multiSelect:/, "the Codex workflow requires an input tool Codex lacks");
});

test("every Codex skill resolves its runner from the loaded skill and keeps host proof separate", () => {
  const runtime = read(...RUNTIME);
  for (const phrase of [/absolute path of the SKILL\.md that Codex loaded/, /two parent directories/,
    /placeholder, not an environment variable/, /\/hooks/, /trusted and enabled/,
    /does not prove Codex dispatched or enforced a\s+real hook/, /Codex supports blocking and continuation at Stop/,
    /Jig requests neither/, /Node\.js 20 or later/, /--runtime codex/]) {
    assert.match(runtime, phrase);
  }
  for (const name of ["jig", "review", "inventory"]) {
    const skill = read(name, "SKILL.md");
    assert.match(skill, /codex-runtime\.md/, name + " has no native runtime or consent reference");
    assert.doesNotMatch(skill, /CLAUDE_PLUGIN_ROOT|AskUserQuestion|multiSelect:|\/jig:/, name + " still requires a Claude Code surface");
    assert.match(skill, /node "<JIG_ROOT>\/scripts\/jig\.js" --runtime codex /, name + " omits its resolved, runtime-tagged invocation");
  }
});

test("the Codex authoring skill describes patch guards and canonical shell names", () => {
  const authoring = read("jig", "SKILL.md");
  for (const phrase of [/canonical hook name `Bash`/, /actual shell\s+can be PowerShell or a POSIX shell/,
    /tool outside that supported set is not evaluated/, /not its shell's semantics/,
    /PreToolUse guard over Codex `apply_patch`/, /exact, `trimEnd`, `trim` and\s+Unicode-normalized matching/,
    /known denial survives another file's gap/, /disclosed coverage gaps/]) {
    assert.match(authoring, phrase);
  }
  const apply = authoring.slice(authoring.indexOf("## 7. Apply"), authoring.indexOf("## 8."));
  assert.match(apply, /declined\s+prerequisite makes an approved config inconsistent/,
    "a declined prerequisite can leave silently broken wiring");
});

test("Codex verification guidance never reads raw stdout as a witnessed exit", () => {
  const runtime = read(...RUNTIME);
  for (const phrase of [/0\.145\.0 and 0\.153\.4/, /stdout without exit status/, /`verify-unknown`/,
    /node \.jig\/checks\/run\.mjs --verify --lane commit --entry <id>/, /requires its `lanes` to include `commit`/,
    /actual zero and nonzero exits/, /not proof a Git commit occurred/]) {
    assert.match(runtime, phrase);
  }
  for (const name of ["review", "inventory"]) {
    assert.match(read(name, "SKILL.md"), /reliable-verification-evidence/, name + " does not expose the reliable verification route");
  }
});
