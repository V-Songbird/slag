"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const engine = require("../scripts/assay.js");

function tmpProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assay-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

test("stripMetadata removes frontmatter, fences, tables, and bare links", () => {
  const content = [
    "---", "paths:", '  - "src/**"', "---",
    "# Heading",
    "- Use Vitest for tests.",
    "```js", "const x = 1;", "```",
    "| a | b |", "|---|---|", "| 1 | 2 |",
    "- [link](./doc.md)",
    "- Never commit secrets.",
  ].join("\n");
  const { lines } = engine.stripMetadata(content);
  const contentLines = lines.filter((l) => l.isContent).map((l) => l.text);
  assert.deepEqual(contentLines, ["- Use Vitest for tests.", "- Never commit secrets."]);
});

test("identifyChunks joins continuation lines into one chunk", () => {
  const { lines } = engine.stripMetadata("- Use Vitest for all tests\n  placed next to the source file.\n");
  const chunks = engine.identifyChunks(lines);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "Use Vitest for all tests placed next to the source file.");
});

test("classifyChunk filters prose, navigation pointers, and description bullets", () => {
  const prose = { text: "These rules load when you're editing API files.", isBullet: false };
  const nav = { text: "`api.md` — request validation conventions", isBullet: true };
  const desc = { text: "**src/primitives/** — Headless behavior hooks", isBullet: true };
  const rule = { text: "Validate request bodies with Zod.", isBullet: true };
  assert.equal(engine.classifyChunk(prose), "prose");
  assert.equal(engine.classifyChunk(nav), "prose");
  assert.equal(engine.classifyChunk(desc), "prose");
  assert.equal(engine.classifyChunk(rule), "rule");
});

test("splitCompound splits semicolon-joined directives, keeps single processes", () => {
  const compound = { text: "Use Vitest for tests; place test files next to the source.", lineStart: 1, lineEnd: 1 };
  assert.equal(engine.splitCompound(compound).length, 2);
  const single = { text: "Edit the grammar file and regenerate the parser.", lineStart: 1, lineEnd: 1 };
  assert.equal(engine.splitCompound(single).length, 1);
});

test("verbless bullets under a heading merge with the heading as context", () => {
  const content = "## Error handling\n\n- All API failures through `handleError`.\n";
  const { lines } = engine.stripMetadata(content);
  const merged = engine.mergeClarifications(engine.identifyChunks(lines));
  const rules = merged.filter(([, cls]) => cls === "rule");
  assert.equal(rules.length, 1);
  assert.match(rules[0][0].text, /^Error handling:/);
});

// ---------------------------------------------------------------------------
// F1 — verb strength
// ---------------------------------------------------------------------------

test("F1 tiers", () => {
  assert.equal(engine.scoreF1("You must validate inputs.").value, 1.0);
  assert.equal(engine.scoreF1("Never commit secrets.").value, 0.95);
  assert.equal(engine.scoreF1("Use Vitest for tests.").value, 0.85);
  assert.equal(engine.scoreF1("Components should be small.").value, 0.7);
  assert.equal(engine.scoreF1("Prefer named exports.").value, 0.5);
});

test("F1 upgrades 'always' + bare imperative to 1.00", () => {
  assert.equal(engine.scoreF1("Always use functional components.").value, 1.0);
});

test("F1 compound hedging takes the lowest hedge", () => {
  assert.equal(engine.scoreF1("Try to prefer functional components where possible.").value, 0.2);
});

test("F1 treats statement forms as implicit imperatives", () => {
  const r = engine.scoreF1("Test files mirror source paths.");
  assert.equal(r.value, 0.7);
  assert.equal(r.method, "implicit_imperative_default");
});

test("F1 noun-verb disambiguation: 'Document headers' is a noun phrase, 'Document the API' is a verb", () => {
  assert.equal(engine.scoreF1("Document headers go at the top.").method, "implicit_imperative_default");
  assert.equal(engine.scoreF1("Document the API endpoints.").matchedVerb, "document");
});

// ---------------------------------------------------------------------------
// F2 — framing polarity
// ---------------------------------------------------------------------------

test("F2 categories", () => {
  assert.equal(engine.scoreF2("Never use var — use const instead of it.").value, 0.95);
  assert.equal(engine.scoreF2("Never use var, use const instead.").value, 0.95);
  assert.equal(engine.scoreF2("Use const for locals. Never use var.").value, 0.95);
  assert.equal(engine.scoreF2("Prefer composition when possible.").value, 0.35);
  assert.equal(engine.scoreF2("Use `pnpm` instead of `npm`.").value, 0.95);
  assert.equal(engine.scoreF2("Validate request bodies with Zod.").value, 0.85);
});

test("F2 flags a bare prohibition as a stall risk", () => {
  const r = engine.scoreF2("Never use var.");
  assert.equal(r.value, 0.2);
  assert.equal(r.stallRisk, true);
  assert.equal(engine.scoreF2("Never use var — use const instead of it.").stallRisk, undefined);
});

test("F2 backtick contrast counts as an alternative, predicate negation does not", () => {
  assert.equal(engine.scoreF2("Use `getProjectCommands(project)` not `database.commands` here.").value, 0.95);
  assert.equal(engine.scoreF2("Write tests first, this is not optional.").value, 0.85);
});

// ---------------------------------------------------------------------------
// F4 — load-trigger alignment
// ---------------------------------------------------------------------------

const alwaysFile = { alwaysLoaded: true, globs: [], globMatchCount: null };
const apiFile = { alwaysLoaded: false, globs: ["src/api/**/*.ts"], globMatchCount: 3 };
const noStale = { gated: false, missing: [] };

test("F4 always-loaded universal rule scores high", () => {
  const r = engine.scoreF4({ text: "Write commit messages in the imperative mood.", staleness: noStale }, alwaysFile);
  assert.equal(r.value, 0.95);
});

test("F4 subsystem trigger inside an always-loaded file is misaligned", () => {
  const r = engine.scoreF4({ text: "When editing api files, validate request bodies.", staleness: noStale }, alwaysFile);
  assert.equal(r.value, 0.4);
});

test("F4 glob-scoped rule with matching trigger scores high, mismatched low", () => {
  const match = engine.scoreF4({ text: "When editing api files, validate request bodies.", staleness: noStale }, apiFile);
  assert.equal(match.value, 0.95);
  const mismatch = engine.scoreF4({ text: "When editing frontend files, memoize selectors.", staleness: noStale }, apiFile);
  assert.equal(mismatch.value, 0.25);
});

test("F4 lean scoped rule with no trigger text trusts the frontmatter", () => {
  const r = engine.scoreF4({ text: "Return typed errors from every handler.", staleness: noStale }, apiFile);
  assert.equal(r.value, 0.85);
});

test("F4 dead glob and staleness kill the score", () => {
  const dead = engine.scoreF4({ text: "Use Zod.", staleness: noStale }, { alwaysLoaded: false, globs: ["src/nope/**"], globMatchCount: 0 });
  assert.equal(dead.value, 0.05);
  const stale = engine.scoreF4({ text: "Use Zod.", staleness: { gated: true, missing: ["src/x.ts"] } }, alwaysFile);
  assert.equal(stale.value, 0.05);
});

// ---------------------------------------------------------------------------
// F7 — concreteness
// ---------------------------------------------------------------------------

test("F7 all-concrete scores by marker count", () => {
  const r = engine.scoreF7("Validate request bodies at the handler boundary using Zod. Example: `CreateUserSchema.parse(req.body)`");
  assert.ok(r.value >= 0.85, `expected >= 0.85, got ${r.value}`);
});

test("F7 numeric thresholds count as concrete markers", () => {
  const r = engine.scoreF7("Keep functions under 40 lines.");
  assert.ok(r.concrete.some((m) => /40\s*lines/.test(m)));
  assert.ok(r.value >= 0.8);
});

test("F7 all-abstract scores near zero", () => {
  assert.equal(engine.scoreF7("Write clean, maintainable, readable code.").value, 0.1);
  assert.equal(engine.scoreF7("Be sensible.").value, 0.05);
});

// ---------------------------------------------------------------------------
// Composite — the worked example from the quality model is the contract
// ---------------------------------------------------------------------------

test("composite reproduces the worked example: 0.86, grade A", () => {
  const { score } = engine.composeScore({ F1: 0.85, F2: 0.85, F3: 0.8, F4: 0.95, F5: 0.95, F7: 0.8 }, false);
  assert.equal(score, 0.86);
  assert.equal(engine.grade(score), "A");
});

test("soft floor halves the score when F7 is at 0.1", () => {
  const floored = engine.composeScore({ F1: 1, F2: 1, F3: 1, F4: 1, F5: 1, F7: 0.1 }, false);
  assert.equal(floored.floor, 0.5);
});

test("staleness gate multiplies the score by 0.05", () => {
  const stale = engine.composeScore({ F1: 0.85, F2: 0.85, F3: 0.8, F4: 0.95, F5: 0.95, F7: 0.8 }, true);
  assert.equal(stale.floor, 0.05);
  const unstale = engine.composeScore({ F1: 0.85, F2: 0.85, F3: 0.8, F4: 0.95, F5: 0.95, F7: 0.8 }, false);
  assert.equal(stale.score, Math.round(unstale.score * 0.05 * 1000) / 1000);
});

test("dominant weakness is the largest weighted gap", () => {
  const r = engine.composeScore({ F1: 0.9, F2: 0.9, F3: 0.9, F4: 0.9, F5: 0.9, F7: 0.3 }, false);
  assert.equal(r.dominantWeakness, "F7");
});

// ---------------------------------------------------------------------------
// F5 — position
// ---------------------------------------------------------------------------

test("F5 short files never bury, long files bury the bottom", () => {
  assert.equal(engine.scoreF5(45, { lineCount: 48 }).value, 0.95);
  assert.equal(engine.scoreF5(10, { lineCount: 80 }).value, 0.95);
  assert.equal(engine.scoreF5(50, { lineCount: 80 }).value, 0.6);
  assert.equal(engine.scoreF5(75, { lineCount: 80 }).value, 0.4);
});

// ---------------------------------------------------------------------------
// Placement detection
// ---------------------------------------------------------------------------

test("a fully-mechanical pre-commit rule is a hook candidate", () => {
  const p = engine.detectPlacement("Run prettier on modified files before committing.", 0.15);
  assert.ok(p);
  assert.equal(p.bestFit, "hook");
  assert.ok(p.detections.hook.confidence >= 0.6);
});

test("naming an agent to invoke is a subagent candidate on its own", () => {
  const p = engine.detectPlacement("Run the `v2-migration-auditor` agent after migrating.", 0.9);
  assert.ok(p);
  assert.equal(p.bestFit, "subagent");
});

test("a multi-step deployment procedure is a skill candidate", () => {
  const p = engine.detectPlacement("When deploying, first build the bundle, then run the smoke tests, then tag the release.", 0.9);
  assert.ok(p);
  assert.equal(p.bestFit, "skill");
});

test("a keep-file-in-sync duty is a hook candidate", () => {
  const p = engine.detectPlacement("When you change a file under src/, add a bullet to CHANGELOG.md.", 0.3);
  assert.ok(p);
  assert.equal(p.bestFit, "hook");
  assert.ok(p.detections.hook.evidence.includes("distant-file-duty"));
});

test("a plain judgment rule is no placement candidate", () => {
  const p = engine.detectPlacement("Use CachedValuesManager for expensive computations over PSI trees.", 0.9);
  assert.equal(p, null);
});

test("a mechanical half conjoined with a judgment half is compound", () => {
  const p = engine.detectPlacement("Never push without running the tests, and make sure the suite covers the change.", 0.3);
  assert.ok(p);
  assert.equal(p.bestFit, "compound");
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

test("checkStaleness flags missing project-relative paths, ignores globs and URLs", () => {
  const root = tmpProject({ "src/real.ts": "export {};" });
  const bad = engine.checkStaleness("See `src/missing.ts` for details.", root);
  assert.equal(bad.gated, true);
  assert.deepEqual(bad.missing, ["src/missing.ts"]);
  const ok = engine.checkStaleness("See `src/real.ts` and `src/**/*.ts` and `https://x.dev/a`.", root);
  assert.equal(ok.gated, false);
});

// ---------------------------------------------------------------------------
// scan + report end to end
// ---------------------------------------------------------------------------

const FIXTURE = {
  "CLAUDE.md": [
    "# Project rules",
    "",
    "- Always use functional components with TypeScript.",
    "",
    "- Write clean, maintainable code.",
    "",
    "- Run prettier on modified files before committing.",
    "",
    "- Never commit directly to main.",
    "",
  ].join("\n"),
  ".claude/rules/api.md": [
    "---",
    "paths:",
    '  - "src/api/**/*.ts"',
    "---",
    "",
    "- Validate request bodies at the handler boundary using Zod.",
    "",
  ].join("\n"),
  "src/api/handler.ts": "export {};",
};

test("scan discovers files, extracts rules, and scores mechanical factors", () => {
  const root = tmpProject(FIXTURE);
  const result = engine.scan(root);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].path, "CLAUDE.md");
  assert.equal(result.files[1].globs.length, 1);
  assert.ok(result.rules.length >= 4);
  for (const r of result.rules) {
    assert.ok(r.factors.F2.value !== undefined);
    assert.ok(r.factors.F7.value !== undefined);
  }
});

test("composeAudit + renderReport produce a graded markdown report", () => {
  const root = tmpProject(FIXTURE);
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.id] = { F3: 0.5, F8: r.text.includes("prettier") ? 0.15 : 0.9 };
  const audit = engine.composeAudit(scanData, judgments);
  assert.ok(audit.corpusScore > 0 && audit.corpusScore < 1);
  const stallRule = audit.rules.find((r) => r.stallRisk);
  assert.ok(stallRule);
  assert.equal(stallRule.grade, "F");
  const report = engine.renderReport(audit);
  assert.match(report, /# Rule audit/);
  assert.match(report, /corpus grade/);
  assert.match(report, /Stall risks/);
  assert.match(report, /Hook opportunities/);
  assert.match(report, /prettier/);
  const verbose = engine.renderReport(audit, { verbose: true });
  assert.match(verbose, /## All rules/);
});

test("a rule at the bottom of a long file is reported as buried", () => {
  const filler = Array.from({ length: 60 }, () => "").join("\n");
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n" + filler + "\n- Always use functional components with TypeScript.\n",
  });
  const scanData = engine.scan(root);
  assert.equal(scanData.rules.length, 1);
  assert.equal(scanData.rules[0].factors.F5.value, 0.4);
  const judgments = { [scanData.rules[0].id]: { F3: 0.8, F8: 0.9 } };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /## Buried rules/);
});

test("loadJudgments rejects missing or out-of-range entries", () => {
  const root = tmpProject(FIXTURE);
  const scanData = engine.scan(root);
  fs.mkdirSync(path.join(root, ".assay-tmp"), { recursive: true });
  fs.writeFileSync(path.join(root, ".assay-tmp", "judgments.json"), JSON.stringify({ R001: { F3: 1.5, F8: 0.2 } }));
  const { error } = engine.loadJudgments(root, scanData.rules);
  assert.ok(error);
});

test("assay-ignore comment and category annotation are honored", () => {
  const root = tmpProject({
    "CLAUDE.md": [
      "<!-- assay-ignore -->",
      "- Never audit this rule.",
      "",
      "<!-- category: preference -->",
      "- Prefer named exports.",
      "",
    ].join("\n"),
  });
  const result = engine.scan(root);
  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].category, "preference");
});
