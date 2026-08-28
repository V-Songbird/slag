"use strict";

// The release gates from SCOPE.md, as assertions. A cut of scribe is
// releasable only while every test in this file passes — the gates are code,
// not a checklist someone remembers to read.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const lib = require("../hooks/scribe-lib.js");

const ROOT = path.join(__dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "prompts.json"), "utf-8"));

function runGate(root, payload) {
  const res = spawnSync(process.execPath, [path.join(ROOT, "hooks", "gate.js")], {
    cwd: root,
    input: JSON.stringify({ cwd: root, hook_event_name: "UserPromptSubmit", ...payload }),
    env: { ...process.env, SCRIBE_OFF: "", CLAUDE_PROJECT_DIR: root },
    encoding: "utf-8",
  });
  return { stdout: res.stdout, ledger: lib.readLedger(root) };
}

describe("gate: the labeled fixture", () => {
  test("all three categories exist with at least three prompts each", () => {
    assert.deepStrictEqual(fixture.categories, ["ambiguous", "precise", "near-miss"]);
    for (const cat of fixture.categories) {
      const n = fixture.prompts.filter((p) => p.label === cat).length;
      assert.ok(n >= 3, cat + " has " + n + " prompts, needs 3+");
    }
    for (const p of fixture.prompts) {
      assert.ok(fixture.categories.includes(p.label), "unlabeled prompt: " + p.text);
      assert.ok(p.why, "fixture prompt lacks a why: " + p.text);
    }
  });

  test("the shipped rubric names the fixture's categories and the materiality axes", () => {
    for (const bar of lib.BARS) {
      const text = lib.rubric(bar);
      assert.match(text, /Ambiguous/i, "rubric must name the ambiguous category");
      assert.match(text, /precise/i, "rubric must name the precise category");
      // The near-miss category is defined by the materiality test — the rubric
      // must carry all three axes or near-misses collapse into ambiguous.
      assert.match(text, /files touched/);
      assert.match(text, /definition of done/);
      assert.match(text, /risk/);
      assert.match(text, /same change is precise/, "the near-miss rule itself");
      // The ask must survive a host that also tells the model to stay quiet or
      // act at once — an output style, a brevity rule, a razor. Without this
      // clause those conventions silently outrank the round.
      assert.match(text, /not an interruption/, "the anti-suppression clause");
      // The judgment is a check the model runs, not a feeling it consults:
      // restating the request is what surfaces the word it was about to guess.
      assert.match(text, /Say the request back/, "the say-it-back check");
    }
  });

  test("the mechanical near-misses behave as labeled through the real gate", () => {
    const slash = fixture.prompts.find((p) => p.text.startsWith("/"));
    const wave = fixture.prompts.find((p) => p.text === "just do it");
    assert.ok(slash && wave, "fixture must keep the mechanical near-miss seeds");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-rel-"));
    assert.strictEqual(runGate(root, { session_id: "s", prompt: slash.text }).stdout, "");

    lib.appendLedger(root, { session: "s", kind: "asked", source: "mechanical", count: 1, questions: [] });
    const waved = runGate(root, { session_id: "s", prompt: wave.text });
    assert.strictEqual(waved.stdout, "");
    assert.strictEqual(waved.ledger[waved.ledger.length - 1].kind, "waved-off");
  });
});

describe("gate: the standing tax", () => {
  test("every bar's full emission stays under the declared byte cap", () => {
    for (const bar of lib.BARS) {
      const bytes = Buffer.byteLength(lib.emission(bar), "utf-8");
      assert.ok(bytes <= lib.RUBRIC_CAP, bar + ": " + bytes + " > " + lib.RUBRIC_CAP);
    }
  });

  test("the rubric is static plugin text — no repo content can reach it", () => {
    // The whole injection posture rests on rubric() being
    // a pure function of the shipped constants: same input, same bytes, no
    // reads. Byte-compare two calls and the source's import list.
    for (const bar of lib.BARS) assert.strictEqual(lib.rubric(bar), lib.rubric(bar));
    const src = fs.readFileSync(path.join(ROOT, "hooks", "scribe-lib.js"), "utf-8");
    const requires = [...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(requires, ["fs", "path"], "scribe-lib may require only node built-ins");
  });

  test("zero always-loaded surface beyond the rubric and the skill listings", () => {
    assert.ok(!fs.existsSync(path.join(ROOT, "commands")), "no commands directory");
    assert.ok(!fs.existsSync(path.join(ROOT, "agents")), "no agents directory");
    assert.ok(!fs.existsSync(path.join(ROOT, "CLAUDE.md")), "no plugin CLAUDE.md");
    assert.deepStrictEqual(fs.readdirSync(path.join(ROOT, "skills")).sort(), ["clarify", "review"]);

    // Each skill's frontmatter description rides every session's skill
    // listing; that is always-loaded cost too, so it gets a cap of its own.
    for (const name of ["clarify", "review"]) {
      const skill = fs.readFileSync(path.join(ROOT, "skills", name, "SKILL.md"), "utf-8");
      const fm = /^---\n([\s\S]*?)\n---/.exec(skill);
      assert.ok(fm, name + "/SKILL.md must open with frontmatter");
      assert.ok(Buffer.byteLength(fm[1], "utf-8") <= 1024,
        name + " frontmatter is " + Buffer.byteLength(fm[1], "utf-8") + " bytes, cap 1024");
    }
  });
});

describe("wiring", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf-8"));

  test("exactly two hook events: the gate and the observer", () => {
    assert.deepStrictEqual(Object.keys(hooks.hooks).sort(), ["PostToolUse", "UserPromptSubmit"]);
    assert.strictEqual(hooks.hooks.PostToolUse[0].matcher, "AskUserQuestion");
  });

  test("every hook is shell-free: bare node with an args array", () => {
    for (const event of Object.values(hooks.hooks)) {
      for (const entry of event) {
        for (const h of entry.hooks) {
          assert.strictEqual(h.type, "command");
          assert.strictEqual(h.command, "node", "command must be bare node, no shell string");
          assert.ok(Array.isArray(h.args) && h.args[0].startsWith("${CLAUDE_PLUGIN_ROOT}"));
          assert.ok(h.timeout <= 10, "a scribe hook may not hold a prompt hostage");
        }
      }
    }
  });

  test("plugin.json carries no version — the marketplace owns it", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf-8"));
    assert.strictEqual(manifest.name, "scribe");
    assert.strictEqual(manifest.version, undefined);
  });
});

describe("ledger schema v1", () => {
  test("every kind a hook can write round-trips with the v1 required fields", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-rel-"));
    lib.appendLedger(root, { session: "s", kind: "judged", source: "mechanical", bar: "conservative", prompt: "p" });
    lib.appendLedger(root, { session: "s", kind: "asked", source: "mechanical", count: 1, questions: [] });
    lib.appendLedger(root, { session: "s", kind: "waved-off", source: "mechanical", via: "prompt" });
    const rows = lib.readLedger(root);
    assert.strictEqual(rows.length, 3);
    for (const row of rows) {
      assert.strictEqual(row.schemaVersion, lib.SCHEMA_VERSION);
      assert.ok(row.ts && row.session && row.kind);
      assert.strictEqual(row.source, "mechanical");
    }
  });
});
