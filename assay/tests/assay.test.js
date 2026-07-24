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

test("stripMetadata skips <example>-style tag blocks", () => {
  const content = [
    "- Never commit secrets.",
    "",
    "<example>",
    "**Steps**:",
    "1. Place caret on MyHelper",
    "2. Shift+F6 → rename it.",
    "</example>",
    "",
    "- Use Vitest for tests.",
  ].join("\n");
  const { lines } = engine.stripMetadata(content);
  const texts = lines.filter((l) => l.isContent).map((l) => l.text);
  assert.deepEqual(texts, ["- Never commit secrets.", "- Use Vitest for tests."]);
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

test("classifyChunk treats command listings and colon-labelled bullets as reference prose", () => {
  const cmd = { text: "`./gradlew build` — full compile + checks.", isBullet: true };
  const label = { text: "**Grammar Kit:** write `.bnf` grammar and generate the parser.", isBullet: true };
  const conditional = { text: "After editing `.bnf`/`.flex`: run `./gradlew generateLexer`.", isBullet: true };
  const directive = { text: "Run `npm test` before pushing.", isBullet: true };
  assert.equal(engine.classifyChunk(cmd), "prose");
  assert.equal(engine.classifyChunk(label), "prose");
  // a real conditional rule leads with its trigger, not a code span — still a rule
  assert.equal(engine.classifyChunk(conditional), "rule");
  assert.equal(engine.classifyChunk(directive), "rule");
});

test("splitCompound splits semicolon-joined directives, keeps single processes", () => {
  const compound = { text: "Use Vitest for tests; place test files next to the source.", lineStart: 1, lineEnd: 1 };
  assert.equal(engine.splitCompound(compound).length, 2);
  const single = { text: "Edit the grammar file and regenerate the parser.", lineStart: 1, lineEnd: 1 };
  assert.equal(engine.splitCompound(single).length, 1);
});

test("splitCompound keeps a trailing subordinate clause with its sentence", () => {
  // Real audit fallout: this one sentence was graded as two rules, the second
  // being only the tail clause "save the manual steps for ...".
  const sentence = {
    text: "Prefer the fixture-based harness for plugin tests, and save the manual steps for real-IDE-only behavior.",
    lineStart: 45, lineEnd: 45,
  };
  assert.deepEqual(engine.splitCompound(sentence).map((p) => p.text), [sentence.text]);

  // A semicolon part whose verb sits mid-clause is a continuation too.
  const midClause = { text: "Use Vitest for tests; the fixtures they save live next to the source.", lineStart: 1, lineEnd: 1 };
  assert.equal(engine.splitCompound(midClause).length, 1);
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

test("F2 mid-clause negation is a statement, not a prohibition", () => {
  const r = engine.scoreF2("WebStorm APIs don't exist on the platform-base matrix this ships on.");
  assert.equal(r.stallRisk, undefined);
  assert.equal(r.value, 0.85);
});

test("F2 'must not' after a subject is still a prohibition", () => {
  const r = engine.scoreF2("Tests offered in this section must not be runnable with JUnit.");
  assert.equal(r.stallRisk, true);
  assert.equal(r.value, 0.2);
});

test("F2 clause-leading prohibition with a named action is still the strongest framing", () => {
  const r = engine.scoreF2("A bare label signals internal-only content — cut it, don't rename it.");
  assert.equal(r.value, 0.95);
  assert.equal(r.stallRisk, undefined);
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
// Skill descriptions
// ---------------------------------------------------------------------------

const GOOD_DESC = 'Generates a Markdown summary report from a `.csv` file. Use when the user asks to "summarize the data", "make a report from the csv". Do NOT use when the user asks a single specific question — only for full reports.';

test("checkSkillDescription passes a recipe-shaped description", () => {
  assert.deepEqual(engine.checkSkillDescription(GOOD_DESC).missing, []);
});

test("checkSkillDescription flags each missing recipe part", () => {
  const noTrigger = engine.checkSkillDescription('Generates a report from a `.csv` file. Do NOT use for single questions... never use it otherwise.');
  assert.ok(noTrigger.missing.includes("trigger"));
  // a single quoted phrasing is NOT a defect — there is no quote-count floor
  const oneQuote = engine.checkSkillDescription('Generates a report from a `.csv` file. Use when the user asks to "summarize". Do NOT use for single questions.');
  assert.deepEqual(oneQuote.missing, []);
  assert.equal(oneQuote.quotedPhrases, 1);
  const noConcrete = engine.checkSkillDescription('Processes tabular data. Use when the user asks to "summarize data.csv", "make a report". Do NOT use for single questions.');
  assert.ok(noConcrete.missing.includes("concrete"));
  const noExclusion = engine.checkSkillDescription('Generates a report from a `.csv` file. Use when the user asks to "summarize the data", "make a report".');
  assert.deepEqual(noExclusion.missing, ["exclusion"]);
  assert.deepEqual(engine.checkSkillDescription("").missing, ["trigger", "concrete", "exclusion"]);
});

test("a trigger clause with no quoted phrasings is not a defect", () => {
  const noQuotes = engine.checkSkillDescription("Generates a report from a `.csv` file. Use when the user asks for a full summary. Do NOT use for single questions.");
  assert.deepEqual(noQuotes.missing, []);
  assert.equal(noQuotes.quotedPhrases, 0);
});

test("quoted trigger phrases do not count toward concreteness", () => {
  const r = engine.checkSkillDescription('Processes tabular data. Use when the user asks to "summarize data.csv", "report on the `.csv`". Do NOT use for single questions.');
  assert.ok(r.missing.includes("concrete"));
});

test("checkSkillDescription reports combined length and flags over-cap text", () => {
  const ok = engine.checkSkillDescription(GOOD_DESC);
  assert.equal(ok.length, GOOD_DESC.length);
  assert.equal(ok.overCap, false);
  const padded = GOOD_DESC + " It also reads `a.csv`, `b.csv`, and `c.csv`.".repeat(35);
  const big = engine.checkSkillDescription(padded);
  assert.ok(big.length > 1536);
  assert.equal(big.overCap, true);
  assert.deepEqual(big.missing, []); // recipe parts intact — over-cap is its own issue
});

test("checkSkillDescription flags a duplicated trigger, exclusion, or quote", () => {
  const twoTriggers = engine.checkSkillDescription('Generates a report from a `.csv` file. Load when a csv is opened. Use when the user asks to "summarize the data", "make a report". Do NOT use for single questions.');
  assert.equal(twoTriggers.redundant, true);
  assert.deepEqual(twoTriggers.missing, []); // redundancy is its own issue, parts intact
  const twoExclusions = engine.checkSkillDescription('Generates a report from a `.csv` file. Use when the user asks to "summarize the data", "make a report". Do NOT use for single questions. Do NOT trigger on a config file.');
  assert.equal(twoExclusions.redundant, true);
  const dupQuote = engine.checkSkillDescription('Generates a report from a `.csv` file. Use when the user asks to "make a report", "make a report". Do NOT use for single questions.');
  assert.equal(dupQuote.redundant, true);
});

test("the recipe's own 'Do NOT use when' shape is not read as a duplicate trigger", () => {
  assert.equal(engine.checkSkillDescription(GOOD_DESC).redundant, false);
});

test("a same-verb multi-condition enumeration is not flagged redundant", () => {
  // Two "Trigger when" conditions under one verb, no "asks to" recipe clause
  // bolted on — legitimate enumeration, must stay clean.
  const enume = 'Reference for `foo.kt` internals. Trigger when editing `foo.kt`, and trigger when a Baz appears — e.g. "fix foo", "debug bar". Do NOT use for unrelated code.';
  const c = engine.checkSkillDescription(enume);
  assert.deepEqual(c.missing, []);
  assert.equal(c.redundant, false);
});

test("findSkillFiles reads folded descriptions and grades them", () => {
  const root = tmpProject({
    ".claude/skills/summarize/SKILL.md": [
      "---",
      "name: summarize",
      "description: >-",
      "  " + GOOD_DESC,
      "---",
      "",
      "# summarize",
    ].join("\n"),
    ".claude/skills/vague/SKILL.md": [
      "---",
      "name: vague",
      "description: Helps with the codebase.",
      "---",
    ].join("\n"),
  });
  const skills = engine.findSkillFiles(root);
  assert.equal(skills.length, 2);
  assert.deepEqual(skills[0].checks.missing, []);
  assert.equal(skills[0].description, GOOD_DESC);
  assert.deepEqual(skills[1].checks.missing, ["trigger", "concrete", "exclusion"]);
});

test("a prose-heavy corpus gets per-rule advice, not one fix repeated down the table", () => {
  // Every one of these floors F7, the heaviest factor, so the dominant weakness
  // alone made all four rows read "too vague" with one identical fix.
  const root = tmpProject({
    "CLAUDE.md": [
      "# Working agreements",
      "Prefer clarity over cleverness.",
      "Never introduce a change you cannot explain.",
      "Write tests that describe behavior.",
      "Keep functions small.",
    ].join("\n\n") + "\n",
  });
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));

  const rows = report.split("\n").filter((l) => /^\| \[R\d+/.test(l));
  assert.equal(rows.length, 4);
  const fixes = new Set(rows.map((l) => l.split("|")[4].trim()));
  assert.ok(fixes.size > 1, "every weak row carried the same fix: " + [...fixes][0]);
  // the dominant weakness still leads each diagnosis — the secondary one follows
  assert.ok(rows.every((l) => l.split("|")[3].trim().startsWith("too vague, ")));
});

test("weak skill descriptions land in the report as a rewritable fix", () => {
  const root = tmpProject({
    ...FIXTURE,
    ".claude/skills/vague/SKILL.md": "---\nname: vague\ndescription: Helps with the codebase.\n---\n",
  });
  const scanData = engine.scan(root);
  assert.equal(scanData.skills.length, 1);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /## Weak skill descriptions/);
  assert.match(report, /rewrite each one/);
  assert.match(report, /vague/);
});

test("a project with no rules still reports weak skill descriptions", () => {
  const root = tmpProject({
    ".claude/skills/vague/SKILL.md": "---\nname: vague\ndescription: Helps with the codebase.\n---\n",
  });
  const scanData = engine.scan(root);
  assert.equal(scanData.rules.length, 0);
  const report = engine.renderReport(engine.composeAudit(scanData, {}));
  assert.match(report, /No rules found/);
  assert.match(report, /## Weak skill descriptions/);
});

test("assay's own skill descriptions pass the trigger-recipe checks", () => {
  const skillsRoot = path.join(__dirname, "..", "skills");
  for (const name of fs.readdirSync(skillsRoot)) {
    const skillMd = path.join(skillsRoot, name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    const fm = engine.parseFrontmatter(fs.readFileSync(skillMd, "utf-8"));
    const desc = [fm.description, fm.when_to_use].filter(Boolean).join(" ");
    const checks = engine.checkSkillDescription(desc);
    assert.deepEqual(checks.missing, [], name);
    assert.equal(checks.overCap, false, name + " is over the 1,536-char cap");
    assert.equal(checks.redundant, false, name + " carries a duplicated clause");
    const disabled = fm["disable-model-invocation"] === true || fm["disable-model-invocation"] === "true";
    if (!disabled) {
      assert.equal(fm.when_to_use, undefined, name + " is model-invocable but still carries when_to_use");
    }
  }
});

test("a recipe-shaped skill stays out of the report", () => {
  const root = tmpProject({
    ...FIXTURE,
    ".claude/skills/summarize/SKILL.md": "---\nname: summarize\ndescription: " + JSON.stringify(GOOD_DESC) + "\n---\n",
  });
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.doesNotMatch(report, /## Weak skill descriptions/);
});

test("an over-cap skill is flagged even with every recipe part present", () => {
  const big = GOOD_DESC + " It also reads `a.csv`, `b.csv`, and `c.csv`.".repeat(35);
  assert.deepEqual(engine.checkSkillDescription(big).missing, []);
  const root = tmpProject({
    ...FIXTURE,
    ".claude/skills/huge/SKILL.md": "---\nname: huge\ndescription: " + JSON.stringify(big) + "\n---\n",
  });
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /## Weak skill descriptions/);
  assert.match(report, /huge/);
  assert.match(report, /over the 1,536-char listing cap/);
});

test("a redundant but complete skill description is flagged", () => {
  const dupe = 'Generates a report from a `.csv` file. Load when a csv opens. Use when the user asks to "summarize the data", "make a report". Do NOT use for single questions.';
  const checks = engine.checkSkillDescription(dupe);
  assert.deepEqual(checks.missing, []);
  assert.equal(checks.overCap, false);
  const root = tmpProject({
    ...FIXTURE,
    ".claude/skills/dupe/SKILL.md": "---\nname: dupe\ndescription: " + JSON.stringify(dupe) + "\n---\n",
  });
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /## Weak skill descriptions/);
  assert.match(report, /dupe/);
  assert.match(report, /duplicated/);
});

// ---------------------------------------------------------------------------
// Invocation-flag-aware grading
// ---------------------------------------------------------------------------

test("an unflagged skill grades on the recipe (model mode), flags default on", () => {
  const root = tmpProject({
    ".claude/skills/summarize/SKILL.md": "---\nname: summarize\ndescription: " + JSON.stringify(GOOD_DESC) + "\n---\n",
  });
  const s = engine.findSkillFiles(root)[0];
  assert.equal(s.modelInvocable, true);
  assert.equal(s.userInvocable, true);
  assert.equal(s.checks.mode, "model");
  assert.equal(s.checks.hasWhenToUse, false);
  assert.deepEqual(s.checks.missing, engine.checkSkillDescription(GOOD_DESC).missing);
});

test("a model-invocable skill with a lingering when_to_use field is flagged", () => {
  const root = tmpProject({
    ".claude/skills/split/SKILL.md": [
      "---",
      "name: split",
      "description: " + JSON.stringify(GOOD_DESC),
      "when_to_use: Use when the user asks to split things.",
      "---",
    ].join("\n"),
  });
  const s = engine.findSkillFiles(root)[0];
  assert.equal(s.checks.mode, "model");
  assert.equal(s.checks.hasWhenToUse, true);
});

test("report: a model-invocable skill still carrying when_to_use gets the fold-and-drop advice", () => {
  const root = tmpProject({
    ...FIXTURE,
    ".claude/skills/split/SKILL.md": [
      "---",
      "name: split",
      "description: " + JSON.stringify(GOOD_DESC),
      "when_to_use: Use when the user asks to split things.",
      "---",
    ].join("\n"),
  });
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /## Weak skill descriptions/);
  assert.match(report, /split/);
  assert.match(report, /drop when_to_use/);
});

test("a model-disabled skill is graded as a plain summary, not the recipe", () => {
  const root = tmpProject({
    ".claude/skills/cut-release/SKILL.md": "---\nname: cut-release\ndescription: Cuts a release — bumps the version and updates the changelog.\ndisable-model-invocation: true\n---\n",
  });
  const s = engine.findSkillFiles(root)[0];
  assert.equal(s.modelInvocable, false);
  assert.equal(s.checks.mode, "user-only");
  assert.equal(s.checks.overSpecified, false); // short plain summary — recipe not demanded
});

test("a model-disabled skill stuffed with trigger machinery is flagged over-specified", () => {
  const root = tmpProject({
    ".claude/skills/cut/SKILL.md": '---\nname: cut\ndescription: Cuts a release. Use when the user asks to "cut a release", "bump the version".\ndisable-model-invocation: true\n---\n',
  });
  const s = engine.findSkillFiles(root)[0];
  assert.equal(s.checks.mode, "user-only");
  assert.equal(s.checks.overSpecified, true);
});

test("a skill neither model nor user can invoke is graded dead", () => {
  const root = tmpProject({
    ".claude/skills/orphan/SKILL.md": "---\nname: orphan\ndescription: Does a thing.\ndisable-model-invocation: true\nuser-invocable: false\n---\n",
  });
  const s = engine.findSkillFiles(root)[0];
  assert.equal(s.checks.mode, "dead");
});

test("report: a clean user-only summary stays out; an over-specified one gets the model-disabled advice", () => {
  const root = tmpProject({
    ...FIXTURE,
    ".claude/skills/tidy/SKILL.md": "---\nname: tidy\ndescription: Cuts a release and updates the changelog.\ndisable-model-invocation: true\n---\n",
    ".claude/skills/stuffed/SKILL.md": '---\nname: stuffed\ndescription: Cuts a release. Use when the user asks to "cut a release", "ship it".\ndisable-model-invocation: true\n---\n',
  });
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /stuffed/);
  assert.match(report, /model-disabled/);
  assert.doesNotMatch(report, /\| tidy \|/);
});

test("report: a dead skill is flagged for removal", () => {
  const root = tmpProject({
    ...FIXTURE,
    ".claude/skills/orphan/SKILL.md": "---\nname: orphan\ndescription: Does a thing.\ndisable-model-invocation: true\nuser-invocable: false\n---\n",
  });
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /orphan/);
  assert.match(report, /recommend removing/);
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

test("checkStaleness flags missing project-relative paths, ignores globs and URLs", () => {
  const root = tmpProject({ "src/real.ts": "export {};" });
  const bad = engine.checkStaleness("See `src/missing.ts` for details.", root);
  assert.equal(bad.gated, true);
  assert.deepEqual(bad.missing, [{ ref: "src/missing.ts", moved: [] }]);
  const ok = engine.checkStaleness("See `src/real.ts` and `src/**/*.ts` and `https://x.dev/a`.", root);
  assert.equal(ok.gated, false);
});

test("checkStaleness catches a markdown link with a root-relative target", () => {
  const root = tmpProject({ "CLAUDE.md": "x" });
  const r = engine.checkStaleness("Check [example](/example.md) to see how examples are crafted.", root);
  assert.equal(r.gated, true);
  assert.equal(r.missing[0].ref, "example.md");
});

test("checkStaleness passes a markdown link whose target exists", () => {
  const root = tmpProject({ "docs/example.md": "x" });
  const r = engine.checkStaleness("Follow [the example](docs/example.md) exactly.", root);
  assert.equal(r.gated, false);
});

test("checkStaleness names where a referenced file moved to, without gating", () => {
  const root = tmpProject({ "docs/guide/example.md": "x" });
  const r = engine.checkStaleness("See [the example](/example.md) for the format.", root);
  // a moved file is a one-line fix, not a dead reference — no score crush
  assert.equal(r.gated, false);
  assert.deepEqual(r.missing[0].moved, ["docs/guide/example.md"]);
});

test("checkStaleness ignores backtick commands with arguments", () => {
  const root = tmpProject({ "gradlew": "#!/bin/sh" });
  const r = engine.checkStaleness("After editing `.bnf`: run `./gradlew generateLexer generateParser`.", root);
  assert.equal(r.gated, false);
  assert.equal(r.missing.length, 0);
});

test("the report shows where a stale reference likely moved", () => {
  const root = tmpProject({
    "CLAUDE.md": "- Check [the example](/example.md) before writing new ones.\n",
    "docs/example.md": "x",
  });
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /## Stale references/);
  assert.match(report, /likely moved to `docs\/example\.md`/);
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
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: r.text.includes("prettier") ? 0.15 : 0.9 };
  const audit = engine.composeAudit(scanData, judgments);
  assert.ok(audit.corpusScore > 0 && audit.corpusScore < 1);
  const stallRule = audit.rules.find((r) => r.stallRisk);
  assert.ok(stallRule);
  assert.equal(stallRule.grade, "F");
  const report = engine.renderReport(audit);
  assert.match(report, /# Rule audit/);
  assert.match(report, /corpus grade/);
  assert.match(report, /Stall risks/);
  assert.match(report, /Better enforced by a hook/);
  assert.match(report, /prettier/);
  const verbose = engine.renderReport(audit, { verbose: true });
  assert.match(verbose, /## All rules/);
});

test("the report names factors in plain English, never as F-codes", () => {
  const root = tmpProject(FIXTURE);
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: r.text.includes("prettier") ? 0.15 : 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  // no raw factor code (F1, F3, F8…) reaches the reader
  assert.doesNotMatch(report, /\bF[1-9]\b/);
  // the weakest "Write clean, maintainable code" surfaces as a plain-English issue
  assert.match(report, /too vague/);
  assert.match(report, /Main issue/);
  // even the verbose per-rule table uses friendly headers
  const verbose = engine.renderReport(engine.composeAudit(scanData, judgments), { verbose: true });
  assert.doesNotMatch(verbose, /\bF[1-9]\b/);
  assert.match(verbose, /Trigger \| Scope \| Position/);
  // the verbose table's rule cell is the clickable link too
  assert.match(verbose, /\| \[R\d+ "[^\]]*"\]\(CLAUDE\.md:\d+\) \|/);
});

test("a rule at the bottom of a long file is reported as buried", () => {
  const filler = Array.from({ length: 60 }, () => "").join("\n");
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n" + filler + "\n- Always use functional components with TypeScript.\n",
  });
  const scanData = engine.scan(root);
  assert.equal(scanData.rules.length, 1);
  assert.equal(scanData.rules[0].factors.F5.value, 0.4);
  const judgments = { [scanData.rules[0].key]: { F3: 0.8, F8: 0.9 } };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /## Buried rules/);
});

test("scan collects wired hooks and the report never prints the inventory", () => {
  const root = tmpProject({
    ...FIXTURE,
    ".claude/settings.json": JSON.stringify({
      hooks: {
        PostToolUse: [{
          matcher: "Edit|Write",
          hooks: [{ type: "command", command: 'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/auto-regen.py"' }],
        }],
      },
    }),
  });
  const scanData = engine.scan(root);
  assert.deepEqual(scanData.hookInventory[0], {
    event: "PostToolUse", matcher: "Edit|Write", command: "auto-regen.py", source: "project",
  });
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: r.text.includes("prettier") ? 0.15 : 0.9 };
  const audit = engine.composeAudit(scanData, judgments);
  assert.deepEqual(audit.hookInventory, scanData.hookInventory);
  const report = engine.renderReport(audit);
  assert.doesNotMatch(report, /Hooks already wired/);
  assert.doesNotMatch(report, /auto-regen\.py/);
});

test("report locations are clickable markdown links", () => {
  const root = tmpProject(FIXTURE);
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: r.text.includes("prettier") ? 0.15 : 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /\[CLAUDE\.md:\d+\]\(CLAUDE\.md:\d+\)/);
});

test("the weak-rules first column is the clickable link, with no bare line-number column", () => {
  const root = tmpProject(FIXTURE);
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: r.text.includes("prettier") ? 0.15 : 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  // the rule cell itself links to file:line
  assert.match(report, /\| \[R\d+ "[^\]]*"\]\(CLAUDE\.md:\d+\) \|/);
  // the weak-rules header no longer carries a "Where" column
  assert.doesNotMatch(report, /\| Rule \| Where \| Score \|/);
});

test("a rule label with brackets still produces a valid link", () => {
  const root = tmpProject({ "CLAUDE.md": "- Reference `Drops[].Item` fields in the mob schema.\n" });
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments), { verbose: true });
  // brackets are stripped from the label, so the [text](href) link stays intact
  assert.match(report, /\| \[R001 "[^\]]*"\]\(CLAUDE\.md:\d+\) \|/);
});

test("a suppressed entry leaves the report and returns under --verbose with its reason", () => {
  const root = tmpProject({
    "CLAUDE.md": [
      "- Never use `var` — use `const` instead.",
      "",
      "- Keep it clean.",
      "",
    ].join("\n"),
  });
  const scanData = engine.scan(root);
  assert.equal(scanData.rules.length, 2);
  const reason = "Reads as a note to self, not an instruction to follow.";
  const [r1, r2] = scanData.rules;
  const judgments = {
    [r1.key]: { F3: 0.8, F8: 0.9 },
    [r2.key]: { F3: 0.2, F8: 0.9, notRule: reason },
  };
  const audit = engine.composeAudit(scanData, judgments);
  // the entry keeps its own score — suppression may never rescore
  const dropped = audit.rules.find((r) => r.id === "R002");
  assert.equal(dropped.suppressed, true);
  assert.equal(typeof dropped.score, "number");
  // ...but it leaves every count the report averages over
  assert.equal(audit.files[0].ruleCount, 1);

  const report = engine.renderReport(audit);
  assert.match(report, /\*\*1 rules across 1 file\(s\)\*\*/);
  assert.doesNotMatch(report, /R002/);
  assert.doesNotMatch(report, /Suppressed/);

  const verbose = engine.renderReport(audit, { verbose: true });
  assert.match(verbose, /## Suppressed \(1 judged not to be rules\)/);
  assert.ok(verbose.includes(reason), "the model's reason was not quoted");
  assert.match(verbose, /R002 \(\[CLAUDE\.md:\d+\]\(CLAUDE\.md:\d+\)\)/);
});

test("a rule's judgment key survives inserting another rule above it", () => {
  const two = "- Never use `var` — use `const` instead.\n\n- Always write a test for a bug fix.\n";
  const root = tmpProject({ "CLAUDE.md": two });
  const before = engine.scan(root);
  assert.equal(before.rules.length, 2);
  const keptKey = before.rules[1].key; // the second rule
  // insert a new rule at the top — with positional R### ids this rule would
  // become R003 and inherit R002's saved judgment; the content key must not move
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "- Prefer named exports over default exports.\n\n" + two);
  const after = engine.scan(root);
  assert.equal(after.rules.length, 3);
  const same = after.rules.find((r) => r.text === before.rules[1].text);
  assert.equal(same.key, keptKey, "an unchanged rule got a new key after an insert");
  assert.equal(same.id, "R003", "the display id did shift, as expected");
  // the inserted rule is genuinely new — its key was not in the prior scan
  const priorKeys = new Set(before.rules.map((r) => r.key));
  const inserted = after.rules.find((r) => r.text.includes("named exports"));
  assert.equal(priorKeys.has(inserted.key), false);
});

test("loadJudgments rejects a notRule that carries no reason", () => {
  const root = tmpProject({ "CLAUDE.md": "- Never use `var` — use `const` instead.\n" });
  const scanData = engine.scan(root);
  fs.mkdirSync(path.join(root, ".assay-tmp"), { recursive: true });
  const key = scanData.rules[0].key;
  const write = (j) => fs.writeFileSync(path.join(root, ".assay-tmp", "judgments.json"), JSON.stringify(j));

  write({ [key]: { F3: 0.5, F8: 0.5, notRule: "  " } });
  assert.match(engine.loadJudgments(root, scanData.rules).error, /\.notRule/);

  write({ [key]: { F3: 0.5, F8: 0.5, notRule: true } });
  assert.match(engine.loadJudgments(root, scanData.rules).error, /\.notRule/);

  write({ [key]: { F3: 0.5, F8: 0.5, notRule: "Narration, not a directive." } });
  assert.equal(engine.loadJudgments(root, scanData.rules).error, undefined);
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

test("a non-Latin-script rule is flagged and the report says the grade is unreliable", () => {
  const cyrillic = "Перед commit запустите тесты.";
  const root = tmpProject({
    "CLAUDE.md": ["- " + cyrillic, "", "- Never use `var` — use `const` instead.", ""].join("\n"),
  });
  const scanData = engine.scan(root);
  assert.equal(scanData.rules.length, 2);
  assert.equal(scanData.rules[0].nonLatin, true);
  assert.equal(scanData.rules[1].nonLatin, false);

  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.7, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /1 rule\(s\) contain non-Latin script/);
});

test("an all-English corpus carries no non-Latin notice", () => {
  const root = tmpProject({ "CLAUDE.md": "- Never use `var` — use `const` instead.\n" });
  const scanData = engine.scan(root);
  assert.equal(scanData.rules[0].nonLatin, false);
  const report = engine.renderReport(engine.composeAudit(scanData, { [scanData.rules[0].key]: { F3: 0.7, F8: 0.9 } }));
  assert.doesNotMatch(report, /non-Latin script/);
});
