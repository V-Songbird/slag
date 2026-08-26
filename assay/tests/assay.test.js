"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const engine = require("../scripts/assay.js");

// [Foreman: 074] The engine now discovers user-scope instruction files too, so
// every fixture below must see an EMPTY user directory — otherwise whatever is
// in the developer's own ~/.claude leaks into the fixtures and the suite becomes
// machine-dependent. Set once, before any scan runs; spawned CLI processes
// inherit it through process.env. Tests that want a populated user dir override
// it explicitly.
const EMPTY_USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "assay-userdir-"));
process.env.ASSAY_USER_DIR = EMPTY_USER_DIR;

// [Foreman: 093] The same fence for the above-root walk: fixtures live directly
// under os.tmpdir(), so stopping the ancestor climb there (exclusive) means no
// fixture ever reads a CLAUDE.md that happens to sit above the temp directory
// on the developer's machine. Ancestor tests build a nested root and pass their
// own `ancestorStop` explicitly.
process.env.ASSAY_ANCESTOR_STOP = os.tmpdir();

// [Foreman: 079] The same seam for the Codex profile: CODEX_HOME is the host's
// own documented variable for its configuration and global instruction file, so
// pointing it at an empty directory keeps the developer's real ~/.codex out of
// every fixture. Tests that want a populated one pass `codexHome` explicitly.
const EMPTY_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "assay-codexhome-"));
process.env.CODEX_HOME = EMPTY_CODEX_HOME;

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

// [Foreman: 069]
test("an inline YAML array in frontmatter yields its elements", () => {
  const inline = engine.parseFrontmatter(["---", "paths: [\"src/**/*.ts\", 'test/**', lib/**]", "---"].join("\n"));
  assert.deepEqual(inline.paths, ["src/**/*.ts", "test/**", "lib/**"]);
  // block-style lists keep working
  const block = engine.parseFrontmatter(["---", "paths:", '  - "src/**"', "  - test/**", "---"].join("\n"));
  assert.deepEqual(block.paths, ["src/**", "test/**"]);
  // and the scan sees separate patterns, not one literal that matches nothing
  const root = tmpProject({
    "CLAUDE.md": "# Project rules\n",
    ".claude/rules/ts.md": '---\npaths: ["src/**/*.ts", "test/**"]\n---\n\n- Return typed errors from every handler.\n',
    "src/api/handler.ts": "export {};",
  });
  const scanData = engine.scan(root);
  assert.deepEqual(scanData.files[1].globs, ["src/**/*.ts", "test/**"]);
  assert.notEqual(scanData.rules[0].factors.F4.method, "dead_glob");
});

// [Foreman: 069]
test("directives in table body cells are graded, header and separator rows are not", () => {
  const root = tmpProject({
    "CLAUDE.md": [
      "# Conventions",
      "",
      "| Do | Don't |",
      "|---|---|",
      "| Use `const` for locals | Never use `var` |",
      "| `src/api/` | the handler layer |",
      "",
    ].join("\n"),
  });
  const rules = engine.scan(root).rules;
  // one graded rule per directive cell, at the row's own line
  assert.deepEqual(rules.map((r) => r.text), ["Use `const` for locals", "Never use `var`"]);
  assert.deepEqual(rules.map((r) => r.lineStart), [5, 5]);
  // the "Don't" header cell reads as a directive but is layout, and neither
  // non-directive cell of the second row becomes a rule
  assert.equal(rules.length, 2);
});

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

test("stripMetadata removes tilde and long-backtick fenced examples", () => {
  const content = [
    "~~~md",
    "- Always run `npm test`.",
    "~~~",
    "````md",
    "```",
    "- Never commit `secrets.env`.",
    "```",
    "````",
    "- Use `const` for local bindings.",
  ].join("\n");
  const { lines } = engine.stripMetadata(content);
  const contentLines = lines.filter((l) => l.isContent).map((l) => l.text);
  assert.deepEqual(contentLines, ["- Use `const` for local bindings."]);
});

test("stripMetadata removes HTML comments Claude never receives", () => {
  const content = [
    "<!--",
    "```",
    "",
    "- Always run `npm test` before committing.",
    "-->",
    "- Use `const` for local bindings. <!-- maintainer-only explanation -->",
    "<!-- note --> - Never use `var` — use `let` instead.",
  ].join("\n");
  const { lines, excluded } = engine.stripMetadata(content);
  const contentLines = lines.filter((l) => l.isContent).map((l) => l.text);
  assert.deepEqual(contentLines, [
    "- Use `const` for local bindings.",
    "- Never use `var` — use `let` instead.",
  ]);
  assert.ok(excluded.has(1) && excluded.has(2) && excluded.has(3) && excluded.has(4));
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

test("an assay-ignore-start/end span drops narrative that reads like rules", () => {
  const root = tmpProject({
    "CLAUDE.md": [
      "- Never commit a secret.",
      "",
      "<!-- assay-ignore-start -->",
      "- We once shipped a stale lockfile and lost two days.",
      "- Always ask before deleting a migration, we learned that the hard way.",
      "<!-- assay-ignore-end -->",
      "",
      "- Run the tests before every commit.",
    ].join("\n"),
  });
  const scanData = engine.scan(root);
  const texts = scanData.rules.map((r) => r.text);
  assert.equal(scanData.rules.length, 2);
  assert.ok(!texts.some((t) => t.includes("stale lockfile")), "a fenced-off line was still graded");
  assert.ok(!texts.some((t) => t.includes("the hard way")), "a fenced-off line was still graded");
});

test("a rule below a large assay-ignore span is not scored as buried", () => {
  const narrative = Array.from({ length: 60 }, (_, i) => `- historical note ${i} that reads like an instruction.`).join("\n");
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n\n<!-- assay-ignore-start -->\n" + narrative + "\n<!-- assay-ignore-end -->\n\n- Always use functional components with TypeScript.\n",
  });
  const scanData = engine.scan(root);
  assert.equal(scanData.rules.length, 1);
  // physically at the bottom of a 60+-line file, but the excluded narrative
  // leaves the F5 denominator, so the only graded rule reads as near the top
  assert.equal(scanData.rules[0].factors.F5.value, 0.95);
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

// [Foreman: 069]
test("two directive sentences in one paragraph are two rules", () => {
  const root = tmpProject({
    "CLAUDE.md": "Run the tests before every commit. Update the changelog with every user-facing change.\n",
  });
  const rules = engine.scan(root).rules;
  assert.deepEqual(rules.map((r) => r.text), [
    "Run the tests before every commit.",
    "Update the changelog with every user-facing change.",
  ]);
});

// [Foreman: 069]
test("a prohibition and its alternative, and a directive and its clarification, stay one rule", () => {
  const pair = { text: "Never commit secrets. Use the vault instead.", lineStart: 1, lineEnd: 1 };
  assert.equal(engine.splitCompound(pair).length, 1);
  const clarified = { text: "Never use `var`. This means `let` or `const` everywhere.", lineStart: 1, lineEnd: 1 };
  assert.equal(engine.splitCompound(clarified).length, 1);
});

test("verbless bullets retain exact source text and carry heading context separately", () => {
  const content = "## Error handling\n\n- All API failures through `handleError`.\n- Validation failures: status `400`.\n";
  const { lines } = engine.stripMetadata(content);
  const merged = engine.mergeClarifications(engine.identifyChunks(lines));
  const rules = merged.filter(([, cls]) => cls === "rule");
  assert.equal(rules.length, 2);
  assert.match(rules[0][0].text, /^Error handling:/);
  assert.equal(rules[0][0].sourceText, "All API failures through `handleError`.");
  assert.equal(rules[0][0].lineStart, 3);
  assert.equal(rules[1][0].sourceText, "Validation failures: status `400`.");
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

// [Foreman: 075] One hedge governs the force of the sentence, downward, and no
// upgrade climbs back over it. This used to score 1.00: the always+imperative
// upgrade beat a weakest-hedge branch that needed two hedges to fire.
test("F1 scores a hedged sentence by its weakest hedge, upgrades included", () => {
  const hedged = engine.scoreF1("Always try to use functional components.");
  assert.equal(hedged.value, 0.2);
  assert.equal(hedged.matchedVerb, "try to");
  assert.equal(hedged.hedged, true);
  // a single hedge beside a bare imperative governs too
  assert.equal(engine.scoreF1("Where possible, use `pnpm`.").value, 0.2);
  // a genuine strong imperative is untouched and carries no hedge flag
  const strong = engine.scoreF1("You must validate inputs.");
  assert.equal(strong.value, 1.0);
  assert.equal(strong.hedged, undefined);
  assert.equal(engine.scoreF1("Always use functional components.").hedged, undefined);
  // and the two-hedge case still resolves to the weakest of them
  assert.equal(engine.scoreF1("Try to prefer functional components where possible.").hedged, true);
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

// [Foreman: 069]
test("an unrelated neighbouring directive no longer excuses a bare prohibition", () => {
  const unrelated = engine.scoreF2("Never commit secrets to the repository. Run the formatter before pushing.");
  assert.equal(unrelated.value, 0.2);
  assert.equal(unrelated.stallRisk, true);
  // a same-topic replacement is still the escape hatch
  const genuine = engine.scoreF2("Never store tokens in the repository. Store tokens in the secrets manager.");
  assert.equal(genuine.value, 0.95);
  assert.equal(genuine.stallRisk, undefined);
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

// [Foreman: 069]
test("a language name matches its extension globs", () => {
  const tsFile = { alwaysLoaded: false, globs: ["**/*.ts", "**/*.tsx"], globMatchCount: 4 };
  const match = engine.scoreF4({ text: "When editing typescript files, enable strict mode.", staleness: noStale }, tsFile);
  assert.equal(match.value, 0.95);
  // a different language is still a mismatch — the table is the whole of it
  const wrong = engine.scoreF4({ text: "When editing python files, pin the version.", staleness: noStale }, tsFile);
  assert.equal(wrong.value, 0.25);
  // the keyword branch reads the language name too
  const pyFile = { alwaysLoaded: false, globs: ["**/*.py"], globMatchCount: 2 };
  const keyword = engine.scoreF4({ text: "Type every python helper with annotations.", staleness: noStale }, pyFile);
  assert.equal(keyword.value, 0.9);
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

// [Foreman: 069]
test("a lone generic backticked word is not concreteness on its own", () => {
  assert.deepEqual(engine.scoreF7("Keep the `code` tidy.").concrete, []);
  assert.deepEqual(engine.scoreF7("Keep `it` short.").concrete, []);
  // paths, commands, flags, casing and real identifiers still count
  for (const t of [
    "Put helpers in `src/utils/format.ts`.",
    "Run `npm test` first.",
    "Wrap it in `CreateUserSchema`.",
    "Pass `--force` only on a rerun.",
    "Use `const` for locals.",
  ]) {
    assert.equal(engine.scoreF7(t).concrete.length, 1, t);
  }
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

// [ADR 2026-08-05 D6] The workflows docs' own phrasing — "adversarially verify"
// — is the independent-check intent the subagent signal exists to catch. Before
// this it scored 0 and a rule written against current docs missed the signal.
test("adversarial verification vocabulary is a subagent independence signal", () => {
  const p = engine.detectPlacement("Review the diff, and adversarially verify each finding before reporting it.", 0.9);
  assert.ok(p);
  assert.ok(p.detections.subagent.evidence.includes("bias-independence-language"), "adversarial vocab did not fire the signal");
  assert.equal(p.bestFit, "subagent");
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
  // [Foreman: 097] columns are Rule | Evidence | Score | Main issue | Fix — the
  // State column left, because a rule with no finding of its own printed as
  // "healthy" inside a table headed "Weak rules"
  const fixes = new Set(rows.map((l) => l.split("|")[5].trim()));
  assert.ok(fixes.size > 1, "every weak row carried the same fix: " + [...fixes][0]);
  // the dominant weakness still leads each diagnosis — the secondary one follows
  assert.ok(rows.every((l) => /^(too vague to act on|“)/.test(l.split("|")[4].trim())),
    "the diagnosis no longer leads with the dominant weakness:\n" + rows.join("\n"));
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
  assert.deepEqual(bad.missing, [{ ref: "src/missing.ts", resolved: "src/missing.ts", moved: [] }]);
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

test("checkStaleness resolves markdown links relative to a nested rule file", () => {
  const root = tmpProject({ ".claude/rules/backend/example.md": "x" });
  const r = engine.checkStaleness(
    "Follow [the example](example.md) exactly.",
    root,
    undefined,
    ".claude/rules/backend/security.md"
  );
  assert.equal(r.gated, false);
  assert.equal(r.missing.length, 0);
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

test("scan discovers nested rule files recursively", () => {
  const root = tmpProject({
    "CLAUDE.md": "# Project rules\n",
    ".claude/rules/backend/security.md": "- Never log `password` — redact it instead.\n",
    ".claude/rules/frontend/components/react.md": "- Use functional components in `.tsx` files.\n",
    ".claude/rules/frontend/notes.txt": "- Never grade this file.\n",
  });
  const result = engine.scan(root);
  assert.deepEqual(result.files.map((f) => f.path), [
    "CLAUDE.md",
    ".claude/rules/backend/security.md",
    ".claude/rules/frontend/components/react.md",
  ]);
  assert.equal(result.rules.length, 2);
});

test("scan keeps source text and source line separate from heading context", () => {
  const root = tmpProject({
    "CLAUDE.md": "# Error handling\n\n- All API failures through `handleError`.\n",
  });
  const result = engine.scan(root);
  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].text, "All API failures through `handleError`.");
  assert.equal(result.rules[0].contextText, "Error handling: All API failures through `handleError`.");
  assert.equal(result.rules[0].lineStart, 3);

  const audit = engine.composeAudit(result, {
    [result.rules[0].key]: { F1: 0.7, F3: 0.8, F8: 0.9 },
  });
  const report = engine.renderReport(audit, { verbose: true });
  assert.match(report, /\[R001 "All API failures through `handleError`\."]\(CLAUDE\.md:3\)/);
  assert.doesNotMatch(report, /R001 "Error handling:/);
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

// [Foreman: 062]
test("scan measures each file's narrative share of the graded content", () => {
  const root = tmpProject({
    "CLAUDE.md": [
      "# Overview",
      "",
      "Background: this repository is a personal experiment.",
      "It carries no runtime dependencies whatsoever.",
      "The whole tool is plain standard library code.",
      "The history behind this file is long and winding.",
      "",
      "- Run the tests before every commit.",
    ].join("\n"),
  });
  const scanData = engine.scan(root);
  const file = scanData.files[0];
  // four prose lines, one rule line — most of the graded content is narrative
  assert.ok(file.narrativeShare >= 0.6, `narrativeShare was ${file.narrativeShare}`);
});

// [Foreman: 062] [ADR 2026-08-05 D2] The narrative reason is gated on file
// length now, like the below-midpoint reason — so a mostly-narrative file only
// restructures once it is long enough for the prose to be a real cost.
test("a long mostly-narrative file is a restructure candidate, not a per-rule fix", () => {
  const root = tmpProject({
    "CLAUDE.md": [
      "# Overview",
      "",
      ...new Array(55).fill("Background prose about why this repository exists and how it grew."),
      "",
      "- Run the tests before every commit.",
    ].join("\n"),
  });
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.8, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /## Restructure candidates/);
  assert.match(report, /narrative/);
  assert.match(report, /assay-ignore/);
});

// [ADR 2026-08-05 D2] The labeled fixture the gate is backed by: a short,
// mostly-prose CLAUDE.md is a fine repo description, not a restructure, so it no
// longer flags. This is assay's own threshold call — no host doc is cited.
test("a short mostly-prose file is not a restructure candidate", () => {
  const root = tmpProject({
    "CLAUDE.md": [
      "# Overview",
      "",
      "Background: this repository is a personal experiment.",
      "It carries no runtime dependencies whatsoever.",
      "The whole tool is plain standard library code.",
      "The history behind this file is long and winding.",
      "",
      "- Run the tests before every commit.",
    ].join("\n"),
  });
  const scanData = engine.scan(root);
  assert.ok(scanData.files[0].narrativeShare >= 0.6, "fixture lost its prose majority");
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.8, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.doesNotMatch(report, /## Restructure candidates/);
});

// [Foreman: 062]
test("a long file that buries half its rules is flagged to restructure", () => {
  const filler = Array.from({ length: 60 }, () => "").join("\n");
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n\n- Always use functional components with TypeScript.\n" +
      filler + "\n- Never commit a secret — run the scanner first.\n",
  });
  const scanData = engine.scan(root);
  assert.equal(scanData.rules.length, 2);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.8, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /## Restructure candidates/);
  assert.match(report, /rules below the midpoint/);
});

// [Foreman: 062]
test("a short, rule-dense file is not a restructure candidate", () => {
  const root = tmpProject({
    "CLAUDE.md": [
      "# Rules",
      "",
      "- Run the tests before every commit.",
      "- Never force-push to main — open a pull request instead.",
      "- Format with prettier before staging changes.",
    ].join("\n"),
  });
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.8, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.doesNotMatch(report, /## Restructure candidates/);
});

// [Foreman: 066]
const DUP_RULE = "- Always run the full test suite before every commit.";

function duplicateFindings(audit) {
  return audit.findings.filter((f) => f.type === "duplicate");
}

test("the same rule in CLAUDE.md and a rules file is reported as one exact duplicate", () => {
  const audit = auditOf({
    "CLAUDE.md": "# Rules\n\n" + DUP_RULE + "\n",
    ".claude/rules/testing.md": "# Testing\n\n" + DUP_RULE + "\n",
  });
  const dups = duplicateFindings(audit);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].severity, "medium");
  assert.equal(dups[0].evidence.level, "mechanical");
  assert.match(dups[0].summary, /CLAUDE\.md:3 and at \.claude\/rules\/testing\.md:3/);
  assert.deepEqual(dups[0].sources, [
    { path: "CLAUDE.md", lineStart: 3, lineEnd: 3 },
    { path: ".claude/rules/testing.md", lineStart: 3, lineEnd: 3 },
  ]);
  // neither rule loses its own state to the pair
  assert.equal(audit.findings.filter((f) => f.state).length, 2);

  const report = engine.renderReport(audit);
  assert.match(report, /### Duplicates/);
  assert.match(report, /exact copy \[mechanical\]/);
  // the scoped rules file is the more specific home, so it is the keeper
  assert.match(report, /consider keeping \[\.claude\/rules\/testing\.md:3\]\(\.claude\/rules\/testing\.md:3\) \(a scoped rules file\); \[CLAUDE\.md:3\]\(CLAUDE\.md:3\) is the removal candidate/);
});

test("reworded copies above the overlap threshold are a near duplicate, below it nothing", () => {
  const above = auditOf({
    "CLAUDE.md": "# Rules\n\n- Always validate request bodies at the handler boundary using Zod schemas.\n",
    ".claude/rules/api.md": "# API\n\n- Always check request bodies at the handler boundary against Zod schemas.\n",
  });
  const dups = duplicateFindings(above);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].severity, "low");
  assert.equal(dups[0].evidence.level, "heuristic");
  assert.match(engine.renderReport(above), /near copy \[heuristic\]/);

  const below = auditOf({
    "CLAUDE.md": "# Rules\n\n- Always validate request bodies at the handler boundary using Zod schemas.\n",
    ".claude/rules/api.md": "# API\n\n- Always validate request bodies at the handler boundary before the database call.\n",
  });
  assert.deepEqual(duplicateFindings(below), []);
  assert.doesNotMatch(engine.renderReport(below), /### Duplicates/);
});

test("two short rules that share every content word are not a near duplicate", () => {
  const audit = auditOf({
    "CLAUDE.md": "# Rules\n\n- Always pin the Docker base image.\n",
    ".claude/rules/docker.md": "# Docker\n\n- Never float the Docker base image.\n",
  });
  assert.deepEqual(duplicateFindings(audit), []);
});

test("the same rule twice in one file is a duplicate, and the first copy is the keeper", () => {
  const audit = auditOf({
    "CLAUDE.md": "# Rules\n\n" + DUP_RULE + "\n\n## Also\n\n" + DUP_RULE + "\n",
  });
  const dups = duplicateFindings(audit);
  assert.equal(dups.length, 1);
  assert.deepEqual(dups[0].sources.map((s) => s.lineStart), [3, 7]);
  assert.deepEqual(dups[0].safeActions, ["keep CLAUDE.md:3", "retire CLAUDE.md:7"]);
});

test("a duplicate across user and project scope says the duty is stated in both", () => {
  const userDir = tmpUserDir({ "CLAUDE.md": "# Mine\n\n" + DUP_RULE + "\n" });
  const scanData = engine.scan(tmpProject({ "CLAUDE.md": "# Rules\n\n" + DUP_RULE + "\n" }), { userDir });
  const dups = duplicateFindings(engine.composeAudit(scanData, judgeEvery(scanData)));
  assert.equal(dups.length, 1);
  assert.match(dups[0].explanation, /different scopes/);
  assert.match(dups[0].explanation, /your own setup and in this project/);
});

test("a suppressed entry is not paired with anything", () => {
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n\n" + DUP_RULE + "\n",
    ".claude/rules/testing.md": "# Testing\n\n" + DUP_RULE + "\n",
  });
  const scanData = engine.scan(root, { projectOnly: true });
  const judgments = judgeEvery(scanData);
  judgments[scanData.rules[1].key] = { F3: 0.7, F8: 0.9, notRule: "Narration, not a directive." };
  const audit = engine.composeAudit(scanData, judgments);
  assert.equal(audit.rules.filter((r) => r.suppressed).length, 1);
  assert.deepEqual(duplicateFindings(audit), []);
});

test("a duplicate never moves a rule's score or the corpus grade", () => {
  const withDup = auditOf({
    "CLAUDE.md": "# Rules\n\n" + DUP_RULE + "\n",
    ".claude/rules/style.md": "# Style\n\n" + DUP_RULE + "\n",
  });
  const without = auditOf({
    "CLAUDE.md": "# Rules\n\n" + DUP_RULE + "\n",
    ".claude/rules/style.md": "# Style\n\n- Always sort import statements alphabetically inside each group.\n",
  });
  assert.equal(duplicateFindings(withDup).length, 1);
  assert.equal(withDup.rules[0].score, without.rules[0].score, "being a duplicate costs the rule nothing");
  // the corpus grade is still the plain mean of the mandate scores — no penalty
  const mean = (withDup.rules[0].score + withDup.rules[1].score) / 2;
  assert.equal(withDup.corpusScore, Math.round(mean * 1000) / 1000);
});

test("scan collects wired hooks; the report names them on the ladder, never as a raw inventory", () => {
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
  // [Foreman: 091] The record keeps the full command line — it is what secret
  // redaction and target checks read — and `label` carries the display name.
  assert.deepEqual(scanData.hookInventory[0], {
    event: "PostToolUse", matcher: "Edit|Write", source: "project",
    command: 'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/auto-regen.py"',
    label: "auto-regen.py",
  });
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: r.text.includes("prettier") ? 0.15 : 0.9 };
  const audit = engine.composeAudit(scanData, judgments);
  assert.deepEqual(audit.hookInventory, scanData.hookInventory);
  const report = engine.renderReport(audit);
  assert.doesNotMatch(report, /Hooks already wired/);
  // [Foreman: 077] The hook is named once, on the ladder, with its level and the
  // standing not-verified clause — never as a bare inventory dump.
  assert.match(report, /\*\*Level 3 — agent lifecycle guardrails\*\*: 1 hook \(PostToolUse: auto-regen\.py\) — configured, not verified/);
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

  // [Foreman: 097] the error groups by cause now, so the check is the cause
  write({ [key]: { F3: 0.5, F8: 0.5, notRule: "  " } });
  assert.match(engine.loadJudgments(root, scanData.rules).error, /suppression\(s\) carry no reason/);

  write({ [key]: { F3: 0.5, F8: 0.5, notRule: true } });
  assert.match(engine.loadJudgments(root, scanData.rules).error, /suppression\(s\) carry no reason/);

  write({ [key]: { F3: 0.5, F8: 0.5, notRule: "Narration, not a directive." } });
  assert.equal(engine.loadJudgments(root, scanData.rules).error, undefined);
});

test("remeasure report leads with a before/after section when handed the prior audit", () => {
  const root = tmpProject({ "CLAUDE.md": "- Always use functional components with TypeScript.\n\n- Never commit a secret.\n" });
  const scanData = engine.scan(root);
  const judge = (f3) => {
    const j = {};
    for (const r of scanData.rules) j[r.key] = { F3: f3, F8: 0.9 };
    return engine.composeAudit(scanData, j);
  };
  const prev = judge(0.1); // weak first pass
  const now = judge(0.9);  // after fixes
  assert.ok(now.corpusScore > prev.corpusScore, "fixture did not move; pick sharper judgments");

  const plain = engine.renderReport(now);
  assert.doesNotMatch(plain, /Since last audit/);

  const report = engine.renderReport(now, { prev });
  assert.match(report, /## Since last audit/);
  assert.match(report, new RegExp(`Corpus grade .*\\(${prev.corpusScore.toFixed(2)}\\).*→.*\\(${now.corpusScore.toFixed(2)}\\)`));
  assert.match(report, /\| CLAUDE\.md \| [A-F] \(0\.\d\d\) \| [A-F] \(0\.\d\d\) \|/);
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

// [Foreman: 069]
test("a misspelled category annotation is reported, not silently accepted", () => {
  const root = tmpProject({
    "CLAUDE.md": [
      "<!-- category: preferance -->",
      "- Prefer named exports.",
      "",
      "<!-- category: preference -->",
      "- Prefer arrow functions.",
      "",
    ].join("\n"),
  });
  const scanData = engine.scan(root);
  const [typo, good] = scanData.rules;
  // still graded, and under a category the corpus actually counts
  assert.equal(typo.category, "mandate");
  assert.deepEqual(typo.invalidCategory, { value: "preferance", line: 1 });
  assert.equal(good.category, "preference");
  assert.equal(good.invalidCategory, null);

  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.5, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /## Unknown category annotations/);
  assert.match(report, /category: preferance/);
  assert.match(report, /\(\[CLAUDE\.md:1\]\(CLAUDE\.md:1\)\)/);
});

test("a non-Latin-script rule is flagged and the report says the grade never applied", () => {
  const cyrillic = "Перед commit запустите тесты.";
  const root = tmpProject({
    "CLAUDE.md": ["- " + cyrillic, "", "- Never use `var` — use `const` instead.", ""].join("\n"),
  });
  const scanData = engine.scan(root);
  assert.equal(scanData.rules.length, 2);
  assert.equal(scanData.rules[0].languageMode, "non-latin-script");
  assert.equal(scanData.rules[1].languageMode, "english");

  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.7, F8: 0.9 };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /1 rule\(s\) or skill description\(s\) read as a non-Latin script/);
});

test("an all-English corpus carries no unsupported-language notice", () => {
  const root = tmpProject({ "CLAUDE.md": "- Never use `var` — use `const` instead.\n" });
  const scanData = engine.scan(root);
  assert.equal(scanData.rules[0].languageMode, "english");
  const report = engine.renderReport(engine.composeAudit(scanData, { [scanData.rules[0].key]: { F3: 0.7, F8: 0.9 } }));
  assert.doesNotMatch(report, /read as a non-Latin script/);
});

// ---------------------------------------------------------------------------
// Findings — the primary output — [Foreman: 075]
// ---------------------------------------------------------------------------

// One audit over a fixture project, with a judgment per rule. `judge` receives
// the scanned rule so a fixture can aim F3/F8 at the state it is checking.
function auditOf(files, judge = () => ({ F3: 0.7, F8: 0.7 })) {
  const scanData = engine.scan(tmpProject(files), { projectOnly: true });
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = judge(r);
  return engine.composeAudit(scanData, judgments);
}

// The primary state of the audit's first (or named) rule.
function primaryState(audit, id = "R001") {
  return audit.findings.find((f) => f.rule === id && f.state);
}

const FILLER = Array.from({ length: 60 }, () => "").join("\n");

test("every derivation row produces its state, severity, and evidence level", () => {
  const cases = [
    ["inactive", "high", "mechanical", {
      ".claude/rules/dead.md": '---\npaths: ["nope/**/*.ts"]\n---\n\n- Return typed errors from every handler.\n',
    }, () => ({ F3: 0.7, F8: 0.7 })],

    ["blocked", "high", "mechanical", {
      "CLAUDE.md": "- Follow [the guide](docs/missing-guide.md) when editing handlers.\n",
    }, () => ({ F3: 0.7, F8: 0.7 })],

    // F1 could not read an action out of the wording — a deterministic
    // approximation, so heuristic
    ["ambiguous", "medium", "heuristic", {
      "CLAUDE.md": "Only `.ts` here.\n",
    }, () => ({ F3: 0.7, F8: 0.7 })],

    // the trigger has more than one reading — the model said so, so model-inferred
    ["ambiguous", "medium", "model-inferred", {
      "CLAUDE.md": "- Validate every request body at the handler boundary.\n",
    }, () => ({ F3: 0.2, F8: 0.7 })],

    ["at-risk", "high", "experiment-supported", {
      "CLAUDE.md": "- Never use `var`.\n",
    }, () => ({ F3: 0.7, F8: 0.7 })],

    ["at-risk", "medium", "heuristic", {
      "CLAUDE.md": "- Always try to use functional components.\n",
    }, () => ({ F3: 0.7, F8: 0.7 })],

    ["at-risk", "low", "heuristic", {
      "CLAUDE.md": "# Rules\n" + FILLER + "\n- Validate every request body at the handler boundary.\n",
    }, () => ({ F3: 0.7, F8: 0.7 })],

    ["mechanical-candidate", "low", "heuristic", {
      "CLAUDE.md": "- Record every release in `docs/releases.md` before publishing.\n",
      "docs/releases.md": "# Releases\n",
    }, () => ({ F3: 0.7, F8: 0.7 })],

    ["mechanical-candidate", "low", "model-inferred", {
      "CLAUDE.md": "- Keep every line under 100 characters.\n",
    }, () => ({ F3: 0.7, F8: 0.15 })],

    ["advisory", "info", "mechanical", {
      "CLAUDE.md": "<!-- category: preference -->\n- Use named exports for shared modules.\n",
    }, () => ({ F3: 0.7, F8: 0.7 })],

    ["advisory", "info", "model-inferred", {
      "CLAUDE.md": "- Validate every request body at the handler boundary.\n",
    }, () => ({ F3: 0.7, F8: 0.95 })],

    ["healthy", "info", "mechanical", {
      "CLAUDE.md": "- Validate every request body at the handler boundary.\n",
    }, () => ({ F3: 0.7, F8: 0.7 })],
  ];

  for (const [state, severity, level, files, judge] of cases) {
    const label = state + "/" + level;
    const audit = auditOf(files, judge);
    const finding = primaryState(audit);
    assert.ok(finding, label + ": no primary state emitted");
    assert.equal(finding.state, state, label);
    assert.equal(finding.severity, severity, label);
    assert.equal(finding.evidence.level, level, label);
    assert.ok(finding.analyzer, label + ": no analyzer named");
    assert.ok(finding.evidence.basis, label + ": no evidence basis");
  }
});

// An experiment-supported finding must say what it was measured on, and that it
// does not carry beyond that — a Claude-profile signal, never a cross-agent law.
test("the experiment-supported finding discloses its tier and its limits", () => {
  const audit = auditOf({ "CLAUDE.md": "- Never use `var`.\n" });
  const finding = primaryState(audit);
  assert.equal(finding.evidence.level, "experiment-supported");
  assert.equal(finding.evidence.tier, "small-model tier (haiku 4.5)");
  assert.match(finding.evidence.limits, /does not carry to other agents/);
  assert.match(finding.evidence.limits, /pre-Claude-5 model tiers/);
  assert.equal(engine.evidenceTag(finding.evidence), "[experiment-supported: small-model tier (haiku 4.5)]");
  assert.equal(engine.evidenceTag({ level: "heuristic" }), "[heuristic]");
});

test("a rule with two problems takes the higher-precedence state", () => {
  // dead glob AND a dead reference: the host never loads it at all, so being
  // blocked on a missing target is not the finding to lead with
  const audit = auditOf({
    ".claude/rules/dead.md": '---\npaths: ["nope/**/*.ts"]\n---\n\n- Follow [the guide](docs/missing-guide.md) when editing handlers.\n',
  });
  const rule = audit.rules[0];
  assert.equal(rule.staleness.gated, true, "fixture lost its stale reference");
  assert.equal(primaryState(audit).state, "inactive");
  // and precedence is the declared order, not incidental
  assert.deepEqual(engine.FINDING_STATES.slice(0, 4), ["inactive", "shadowed", "blocked", "conflicting"]);
});

test("a hard gate is reported as its state, never softened into a grade", () => {
  const audit = auditOf({
    ".claude/rules/dead.md": '---\npaths: ["nope/**/*.ts"]\n---\n\n- Never use `var` in `src/api/handler.ts` — use `const` instead.\n',
  });
  const finding = primaryState(audit);
  assert.equal(finding.state, "inactive");
  assert.equal(finding.severity, "high");
  // the wording is strong — F1, F2 and F7 are all high — and it changes nothing
  assert.equal(audit.rules[0].factorValues.F1, 0.95);
  assert.equal(audit.rules[0].factorValues.F2, 0.95);

  const report = engine.renderReport(audit);
  const gates = report.slice(report.indexOf("## Hard gates"), report.indexOf("## Operational findings"));
  assert.match(gates, /\*\*inactive\*\*/);
  assert.match(gates, /\[mechanical\]/);
  // its score lives in the hygiene section, never beside the gate
  assert.doesNotMatch(gates, /\b[A-F] \(0\.\d\d\)/);
  assert.match(report, /## Structural hygiene \(secondary\)/);
});

test("every finding is schema-valid and source-linked to a path in the record", () => {
  const audit = auditOf({
    "CLAUDE.md": [
      "# Rules",
      "",
      "<!-- category: preferance -->",
      "- Prefer named exports.",
      "",
      "- Перед commit запустите тесты.",
      "",
      "```js",
      "const unclosed = true;",
    ].join("\n") + "\n",
    ".claude/rules/dead.md": '---\npaths: ["nope/**/*.ts"]\n---\n\n- Return typed errors from every handler.\n',
  });
  const severities = new Set(["info", "low", "medium", "high"]);
  const levels = new Set(["mechanical", "documented", "experiment-supported", "heuristic", "model-inferred"]);
  const known = new Set([
    ...audit.files.map((f) => f.path),
    ...(audit.sources || []).map((s) => s.path),
    ...((audit.coverage || {}).inaccessible || []).map((s) => s.path),
  ]);

  assert.ok(audit.findings.length >= 4, "fixture produced too few findings");
  const types = new Set(audit.findings.map((f) => f.type).filter(Boolean));
  assert.ok(types.has("unknown-category"), "no unknown-category finding");
  assert.ok(types.has("unsupported-language"), "no unsupported-language finding");
  assert.ok(types.has("unsupported-construct"), "no unsupported-construct finding");

  const ids = new Set();
  for (const f of audit.findings) {
    const label = f.id + " " + (f.state || f.type);
    assert.match(f.id, /^F\d{3}$/, label);
    assert.equal(ids.has(f.id), false, "duplicate finding id " + f.id);
    ids.add(f.id);
    assert.ok(Boolean(f.state) !== Boolean(f.type), label + " must carry exactly one of state/type");
    assert.ok(severities.has(f.severity), label + " severity: " + f.severity);
    assert.ok(f.summary && f.explanation, label + " is missing prose");
    assert.ok(levels.has(f.evidence.level), label + " evidence: " + f.evidence.level);
    assert.ok(f.evidence.basis, label + " has no evidence basis");
    assert.ok(Array.isArray(f.safeActions), label + " has no safeActions array");
    assert.ok(typeof f.analyzer === "string" && f.analyzer, label + " names no analyzer");
    assert.ok(Array.isArray(f.sources) && f.sources.length, label + " is not source-linked");
    for (const s of f.sources) {
      assert.ok(known.has(s.path), label + " cites a path outside the record: " + s.path);
      assert.ok(Number.isInteger(s.lineStart) && s.lineStart >= 1, label + " has no start line");
      assert.ok(Number.isInteger(s.lineEnd) && s.lineEnd >= s.lineStart, label + " has no end line");
    }
  }
});

test("a suppressed entry becomes a finding of its own, and loses its state", () => {
  const scanData = engine.scan(tmpProject({
    "CLAUDE.md": "- Never use `var` — use `const` instead.\n\n- Keep it clean.\n",
  }), { projectOnly: true });
  const [r1, r2] = scanData.rules;
  const audit = engine.composeAudit(scanData, {
    [r1.key]: { F3: 0.7, F8: 0.7 },
    [r2.key]: { F3: 0.7, F8: 0.7, notRule: "Reads as a note to self." },
  });
  assert.equal(primaryState(audit, "R002"), undefined);
  const dropped = audit.findings.find((f) => f.type === "suppressed-entry");
  assert.equal(dropped.rule, "R002");
  assert.equal(dropped.evidence.level, "model-inferred");
  assert.match(dropped.summary, /Reads as a note to self\./);
});

test("the report leads with the risk topology and carries an evidence tag on every finding line", () => {
  const audit = auditOf({
    "CLAUDE.md": "- Never use `var`.\n\n- Validate every request body at the handler boundary.\n",
  });
  const report = engine.renderReport(audit);
  assert.match(report, /\*\*1 at-risk, 1 healthy\*\* across 1 file\(s\)\./);
  // the four findings-first sections, in order
  const order = ["## Hard gates", "## Operational findings", "## Policy placement", "## Structural hygiene (secondary)"];
  let at = -1;
  for (const header of order) {
    const next = report.indexOf(header);
    assert.ok(next > at, header + " is missing or out of order");
    at = next;
  }
  // Coverage still opens the report, and the grade is now below the findings
  assert.ok(report.indexOf("## Coverage") < report.indexOf("## Hard gates"));
  assert.ok(report.indexOf("corpus grade") > report.indexOf("## Policy placement"));
  assert.match(report, /None — every rule the audit found can load in this context\./);
  assert.match(report, /\[experiment-supported: small-model tier \(haiku 4\.5\)\]/);
});

// ---------------------------------------------------------------------------
// Corpus relationships — [Foreman: 076]
// ---------------------------------------------------------------------------

const PIN_YES = "- Always pin dependencies to exact versions in `package.json`.";
const PIN_NO = "- Never pin dependencies to exact versions in `package.json`.";

const findingsOfType = (audit, type) => audit.findings.filter((f) => f.type === type);
const relsOfKind = (audit, kind) => (audit.relationships || []).filter((r) => r.kind === kind);

test("two rules that ban and command the same action are a conflict, and both say so", () => {
  const audit = auditOf({
    "CLAUDE.md": "# Rules\n\n" + PIN_YES + "\n",
    ".claude/rules/deps.md": "# Deps\n\n" + PIN_NO + "\n",
  });
  // both rules take the state — neither is the winner
  const states = audit.findings.filter((f) => f.state).map((f) => f.state);
  assert.deepEqual(states, ["conflicting", "conflicting"]);
  assert.equal(primaryState(audit).severity, "high");
  assert.equal(primaryState(audit).evidence.level, "heuristic");
  assert.match(primaryState(audit).evidence.basis, /opposite-polarity wording on one topic/);

  // one corpus finding names the pair with both spans
  const conflicts = findingsOfType(audit, "conflict");
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].sources, [
    { path: "CLAUDE.md", lineStart: 3, lineEnd: 3 },
    { path: ".claude/rules/deps.md", lineStart: 3, lineEnd: 3 },
  ]);
  assert.match(conflicts[0].summary, /bans `pin`/);
  assert.match(conflicts[0].explanation, /does not decide which policy is correct/);
  // these two sources load at the same documented priority, so no order is named
  assert.doesNotMatch(conflicts[0].explanation, /load order/);

  // the pair is a conflict OR a duplicate, never both
  assert.deepEqual(findingsOfType(audit, "duplicate"), []);
  assert.equal(relsOfKind(audit, "conflict").length, 1);
  assert.equal(relsOfKind(audit, "duplicate").length, 0);

  const report = engine.renderReport(audit);
  assert.match(report, /### Conflicts/);
  assert.match(report, /neither rule is edited and neither is called the winner/);
  assert.match(report, /\[CLAUDE\.md:3\]\(CLAUDE\.md:3\) ↔ \[\.claude\/rules\/deps\.md:3\]\(\.claude\/rules\/deps\.md:3\)/);
});

test("a conflict across two precedence levels names the load order, and calls it nothing more", () => {
  const audit = auditOf({
    "CLAUDE.md": "# Rules\n\n" + PIN_YES + "\n",
    "CLAUDE.local.md": "# Local\n\n" + PIN_NO + "\n",
  });
  const conflict = findingsOfType(audit, "conflict")[0];
  assert.ok(conflict, "no conflict across precedence levels");
  assert.match(conflict.explanation, /The host reads `CLAUDE\.md` before `CLAUDE\.local\.md`/);
  assert.match(conflict.explanation, /that is the order, not a decision about which policy is correct/);
  assert.match(conflict.explanation, /assay does not decide which policy is correct/);
});

test("conflicting outranks the state the same rule would take on its own", () => {
  const alone = auditOf({ ".claude/rules/deps.md": "# Deps\n\n" + PIN_NO + "\n" });
  // a bare prohibition on its own is a stall risk
  assert.equal(primaryState(alone).state, "at-risk");

  const paired = auditOf({
    "CLAUDE.md": "# Rules\n\n" + PIN_YES + "\n",
    ".claude/rules/deps.md": "# Deps\n\n" + PIN_NO + "\n",
  });
  assert.equal(primaryState(paired, "R002").state, "conflicting");
  assert.ok(engine.FINDING_STATES.indexOf("conflicting") < engine.FINDING_STATES.indexOf("at-risk"));
});

test("a prohibition beside its named alternative is not a conflict", () => {
  // the ALTERNATIVE pattern spelled out: the ban names what to do instead
  const spelled = auditOf({
    "CLAUDE.md": "# Rules\n\n" + PIN_YES + "\n",
    ".claude/rules/deps.md": "# Deps\n\n- Never pin dependencies to exact versions in `package.json` — use a caret range instead.\n",
  });
  assert.deepEqual(findingsOfType(spelled, "conflict"), []);
  assert.deepEqual(relsOfKind(spelled, "conflict"), []);

  // and the pattern without the marker: same subject, a DIFFERENT action, so the
  // second rule is the replacement for the first rather than an argument with it
  const replacement = auditOf({
    "CLAUDE.md": "# Rules\n\n- Always pin the Docker base image digest in every Dockerfile.\n",
    ".claude/rules/docker.md": "# Docker\n\n- Never float the Docker base image digest in any Dockerfile.\n",
  });
  assert.deepEqual(findingsOfType(replacement, "conflict"), []);
});

test("a variant the host never selected is shadowed, not graded as live policy", () => {
  const files = {
    "CLAUDE.md": "# Rules\n\n- Validate every request body at the handler boundary.\n",
    ".claude/CLAUDE.md": "# Older rules\n\n- Write clean, maintainable code.\n",
  };
  const scanData = engine.scan(tmpProject(files), { projectOnly: true });
  // the adapter returns the loser, marked unselected, and it is parsed
  const shadowed = scanData.files.find((f) => f.path === ".claude/CLAUDE.md");
  assert.equal(shadowed.selected, false);
  assert.equal(shadowed.alwaysLoaded, false);
  assert.equal(shadowed.shadowedBy, "CLAUDE.md");
  assert.match(shadowed.selectionReason, /same-level variant — CLAUDE\.md was selected/);

  const audit = engine.composeAudit(scanData, judgeEvery(scanData));
  const finding = primaryState(audit, "R002");
  assert.equal(finding.state, "shadowed");
  assert.equal(finding.severity, "medium");
  assert.equal(finding.evidence.level, "mechanical");
  assert.equal(finding.evidence.basis, "same-level source selection");

  // out of the corpus grade: it grades exactly as it would without the file
  const live = engine.composeAudit(
    engine.scan(tmpProject({ "CLAUDE.md": files["CLAUDE.md"] }), { projectOnly: true }),
    { ...judgeEvery(scanData) },
  );
  assert.equal(audit.corpusScore, live.corpusScore);
  // and its bytes are not always-loaded bytes
  assert.equal(audit.sources.find((s) => s.path === ".claude/CLAUDE.md").alwaysLoaded, false);

  assert.deepEqual(relsOfKind(audit, "shadows").map((r) => r.between), [["CLAUDE.md", ".claude/CLAUDE.md"]]);

  const report = engine.renderReport(audit);
  const gates = report.slice(report.indexOf("## Hard gates"), report.indexOf("## Operational findings"));
  assert.match(gates, /\*\*shadowed\*\*/);
  assert.match(gates, /same-level variant — CLAUDE\.md was selected/);
  // the weak rule inside it never reaches the weak-rules table
  assert.doesNotMatch(report, /### Weak rules/);
  // [Foreman: 097] the Files table links its paths through the one shared helper
  assert.match(report, /\| \[\.claude\/CLAUDE\.md\]\([^)]*\) \| 1 \| [^|]+ \| not loaded — shadowed \|/);
});

test("a shadowed rule is never paired with a live one", () => {
  const audit = auditOf({
    "CLAUDE.md": "# Rules\n\n" + DUP_RULE + "\n",
    ".claude/CLAUDE.md": "# Older\n\n" + DUP_RULE + "\n",
  });
  assert.deepEqual(duplicateFindings(audit), []);
  assert.deepEqual(findingsOfType(audit, "conflict"), []);
});

test("overlapping scopes are silent until the two files already collide", () => {
  const shared = {
    "src/api/handler.ts": "export {};\n",
    ".claude/rules/api.md": '---\npaths: ["src/**/*.ts"]\n---\n\n',
    ".claude/rules/ts.md": '---\npaths: ["src/api/*.ts"]\n---\n\n',
  };
  const quiet = auditOf({
    ...shared,
    ".claude/rules/api.md": shared[".claude/rules/api.md"] + DUP_RULE + "\n",
    ".claude/rules/ts.md": shared[".claude/rules/ts.md"] + "- Validate every request body at the handler boundary.\n",
  });
  // the globs DO overlap — bare overlap is normal and reports nothing
  assert.equal(quiet.scopeOverlaps.length, 1);
  assert.deepEqual(findingsOfType(quiet, "scope-overlap"), []);
  assert.doesNotMatch(engine.renderReport(quiet), /### Scope overlap/);

  const colliding = auditOf({
    ...shared,
    ".claude/rules/api.md": shared[".claude/rules/api.md"] + DUP_RULE + "\n",
    ".claude/rules/ts.md": shared[".claude/rules/ts.md"] + DUP_RULE + "\n",
  });
  const overlaps = findingsOfType(colliding, "scope-overlap");
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].severity, "info");
  assert.equal(overlaps[0].evidence.level, "mechanical");
  assert.match(overlaps[0].summary, /src\/\*\*\/\*\.ts.*src\/api\/\*\.ts.*1 shared file\(s\)/);
  assert.match(engine.renderReport(colliding), /### Scope overlap/);
});

test("a rule whose moment a wired hook already fires on is named, and only then", () => {
  const wired = (event, matcher) => JSON.stringify({
    hooks: { [event]: [{ matcher, hooks: [{ type: "command", command: "node .claude/hooks/pretest.js" }] }] },
  });
  const mechanical = () => ({ F3: 0.7, F8: 0.15 });
  const NAMED_EVENT = "# Rules\n\n- Always run the full test suite before committing.\n";

  const covered = auditOf({ "CLAUDE.md": NAMED_EVENT, ".claude/settings.json": wired("PreToolUse", "Bash") }, mechanical);
  const hits = findingsOfType(covered, "redundant-enforcement");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, "low");
  assert.equal(hits[0].evidence.level, "heuristic");
  assert.match(hits[0].evidence.limits, /configured, not observed/);
  assert.match(hits[0].summary, /`PreToolUse` hook \(`pretest\.js`, project\) is already wired/);
  assert.deepEqual(relsOfKind(covered, "covers").map((r) => r.between[0]), ["project:pretest.js"]);
  assert.match(engine.renderReport(covered), /### Already wired/);

  // a hook on another event covers nothing
  const other = auditOf({ "CLAUDE.md": NAMED_EVENT, ".claude/settings.json": wired("PostToolUse", "Edit|Write") }, mechanical);
  assert.deepEqual(findingsOfType(other, "redundant-enforcement"), []);

  // a rule naming no moment infers no event, so the check stays silent
  const eventless = auditOf({
    "CLAUDE.md": "# Rules\n\n- Record every release in `docs/releases.md`.\n",
    "docs/releases.md": "# Releases\n",
    ".claude/settings.json": wired("PostToolUse", "Edit|Write"),
  }, mechanical);
  assert.equal(eventless.rules[0].placement.hookEvent, null);
  assert.deepEqual(findingsOfType(eventless, "redundant-enforcement"), []);
});

test("the always-loaded byte count always prints; only real heft is a finding", () => {
  const small = auditOf({ "CLAUDE.md": "# Rules\n\n- Validate every request body at the handler boundary.\n" });
  assert.match(engine.renderReport(small), /- \d+ bytes of always-loaded instructions \(user, above-root and project memory, unscoped rules\)/);
  assert.deepEqual(findingsOfType(small, "context-pressure"), []);

  const bulk = "# Big\n\n" + Array.from({ length: 900 }, (_, i) =>
    "- Validate every request body at the handler boundary number " + i + ".").join("\n") + "\n";
  assert.ok(Buffer.byteLength(bulk) > engine.CONTEXT_PRESSURE_BYTES, "fixture is under the threshold");
  const heavy = auditOf({ "CLAUDE.md": bulk });
  const pressure = findingsOfType(heavy, "context-pressure");
  assert.equal(pressure.length, 1);
  assert.equal(pressure[0].severity, "low");
  assert.equal(pressure[0].evidence.level, "heuristic");
  assert.match(pressure[0].evidence.limits, /neither sets nor confirms this figure — the 40k line stays assay's own/);
  assert.match(pressure[0].summary, /largest: `CLAUDE\.md`/);
  assert.ok(pressure[0].sources.length <= 3);
  assert.match(engine.renderReport(heavy), /bytes of instructions load before every session/);
});

// [Foreman: 085] The pairwise walks are O(n²) in comparable rules. Past the cap
// they do not run, and the corpus is told so — the alternative was an audit
// record too large for JSON.stringify, which crashed the report outright.

// Rules that pair with nothing: every content token carries its own index, so
// the filler never becomes a duplicate of itself 100,000 times over.
const fillerRules = (n) => Array.from({ length: n },
  (_, i) => `- Always run \`task-${i}\` before \`stage-${i}\` when editing \`module-${i}\`.`);

test("a corpus past the pairwise cap says so instead of failing", () => {
  const root = tmpProject({
    "CLAUDE.md": ["# Rules", "", ...fillerRules(engine.PAIRWISE_RULE_CAP + 400), ""].join("\n"),
  });

  // it completes, through the public surface, with no record too large to write
  const scanned = cli(root, "scan");
  assert.equal(scanned.code, 0, scanned.err);
  const reported = cli(root, "report", "--verbose");
  assert.equal(reported.code, 0, reported.err);
  assert.equal(reported.err, "");

  const disclosure = new RegExp(`\\d+ rules exceed the pairwise-analysis cap of ${engine.PAIRWISE_RULE_CAP} — duplicate and conflict detection did not run`);
  assert.match(reported.out, disclosure);

  const audit = readJson(root, "audit.json");
  assert.equal(audit.coverage.pairwiseSkipped, audit.rules.length);
  assert.equal(engine.validateRecord(audit, "audit"), null);
  // nothing was reported that the skipped walk would have decided
  assert.deepEqual(findingsOfType(audit, "duplicate"), []);
  assert.deepEqual(findingsOfType(audit, "conflict"), []);
  assert.deepEqual(audit.relationships.filter((r) => ["duplicate", "conflict"].includes(r.kind)), []);
});

test("a corpus at the cap still gets the real pairwise analysis", () => {
  const root = tmpProject({
    "CLAUDE.md": ["# Rules", "",
      ...fillerRules(engine.PAIRWISE_RULE_CAP - 4),
      PIN_YES,
      PIN_NO,
      "- Never use `var` — use `const` instead.",
      ""].join("\n"),
    ".claude/rules/dupe.md": "# Dupe\n\n- Never use `var` — use `const` instead.\n",
  });
  const audit = engine.composeAudit(engine.scan(root, { projectOnly: true }), null);

  assert.equal(audit.rules.length, engine.PAIRWISE_RULE_CAP, "the fixture must sit exactly on the line");
  assert.equal(audit.coverage.pairwiseSkipped, undefined, "the cap fired one rule early");
  assert.equal(findingsOfType(audit, "conflict").length, 1);
  assert.equal(findingsOfType(audit, "duplicate").length, 1);
});

test("the pairwise disclosure is coverage, never a gate", () => {
  const root = tmpProject({
    "CLAUDE.md": ["# Rules", "", ...fillerRules(engine.PAIRWISE_RULE_CAP + 1), ""].join("\n"),
  });
  const run = cli(root, "ci", "--json");
  assert.equal(run.code, 0, run.out);
  const result = JSON.parse(run.out);
  assert.deepEqual(result.failed, []);
  // it is not a finding at all, so no gate could select it even by name
  assert.equal(Object.keys(result.advisory).some((k) => /pairwise/.test(k)), false);
});

// [Foreman: 076] The proposal channel is additive: it renders, and it moves
// nothing the deterministic layer decided.
test("model-proposed relationships render, labelled, and change nothing", () => {
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n\n- Validate every request body at the handler boundary.\n",
    ".claude/rules/api.md": "# API\n\n- Check incoming payloads before the controller runs.\n",
  });
  const scanData = engine.scan(root, { projectOnly: true });
  const base = judgeEvery(scanData);
  const withCandidates = {
    ...base,
    _candidates: [
      { kind: "paraphrase-duplicate", keys: scanData.rules.map((r) => r.key), summary: "Both ask for input validation at the edge.", reason: "Different words, one duty.", accepted: null },
      { kind: "indirect-conflict", keys: [scanData.rules[0].key], summary: "Reads against the payload rule.", reason: "Only in combination.", accepted: false },
      { kind: "ambiguous-meaning", keys: [scanData.rules[1].key], summary: "Two readings of `payloads`.", reason: "Confirmed in conversation.", accepted: true },
    ],
  };
  const proposed = engine.composeAudit(scanData, withCandidates);
  const plain = engine.composeAudit(scanData, base);

  // the invariant: states, scores, grade, and the deterministic graph are untouched
  assert.deepEqual(proposed.findings, plain.findings);
  assert.deepEqual(proposed.relationships, plain.relationships);
  assert.equal(proposed.corpusScore, plain.corpusScore);
  assert.deepEqual(proposed.rules.map((r) => r.score), plain.rules.map((r) => r.score));
  // proposals land in the semantic block, never in relationships[]
  assert.equal(proposed.semantic.candidates.length, 3);
  assert.equal(plain.semantic.candidates.length, 0);
  assert.equal((proposed.relationships || []).some((r) => r.kind === "paraphrase-duplicate"), false);

  const report = engine.renderReport(proposed);
  assert.match(report, /### Proposed relationships/);
  assert.match(report, /\[model-inferred\]/);
  // [Foreman: 140] Two channels fill this section now, so every row says which
  // one it came from — a script's near miss carries less weight than the
  // model's read of two rules, and the reader has to be able to tell.
  assert.match(report, /\*\*paraphrase-duplicate\*\* — proposed by the model — \[CLAUDE\.md:3\]\(CLAUDE\.md:3\) ↔ \[\.claude\/rules\/api\.md:3\]\(\.claude\/rules\/api\.md:3\)/);
  assert.match(report, /\*\*ambiguous-meaning\*\* — accepted by the model —/);
  // a rejected proposal is verbose-only
  assert.doesNotMatch(report, /Reads against the payload rule/);
  assert.match(engine.renderReport(proposed, { verbose: true }), /\*\*indirect-conflict\*\* — rejected by the model —/);
});

test("a candidate naming an unknown kind is a malformed judgments file", () => {
  const root = cliFixture();
  judgeAll(root);
  const judgeFile = path.join(root, ".assay-tmp", "judgments.json");
  const judgments = JSON.parse(fs.readFileSync(judgeFile, "utf-8"));

  fs.writeFileSync(judgeFile, JSON.stringify({
    ...judgments,
    _candidates: [{ kind: "vibes", keys: [], summary: "x", reason: "y", accepted: null }],
  }));
  const bad = cli(root, "report", "--verbose");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /_candidates\[0\]\.kind \(unknown kind: vibes\)/);

  // every documented kind is accepted, and so is an absent channel
  fs.writeFileSync(judgeFile, JSON.stringify({
    ...judgments,
    _candidates: engine.SEMANTIC_CANDIDATE_KINDS.map((kind) => ({ kind, keys: [], summary: "s", reason: "r", accepted: null })),
  }));
  assert.equal(cli(root, "report", "--verbose").code, 0);
});

test("relationships are emitted, sorted by kind, and schema-shaped", () => {
  const audit = auditOf({
    "CLAUDE.md": "# Rules\n\n" + PIN_YES + "\n\n" + DUP_RULE + "\n",
    ".claude/rules/deps.md": "# Deps\n\n" + PIN_NO + "\n\n" + DUP_RULE + "\n",
    ".claude/CLAUDE.md": "# Older\n\n- Write clean, maintainable code.\n",
  });
  const rels = audit.relationships;
  assert.ok(rels.length >= 3, "fixture produced too few relationships");
  assert.deepEqual(rels.map((r) => r.kind), [...rels.map((r) => r.kind)].sort());
  const ids = new Set();
  const byKey = new Map(audit.rules.map((r) => [r.key, r]));
  const paths = new Set(audit.files.map((f) => f.path));
  for (const rel of rels) {
    assert.match(rel.id, /^REL\d{3}$/);
    assert.equal(ids.has(rel.id), false, "duplicate relationship id " + rel.id);
    ids.add(rel.id);
    assert.ok(["duplicate", "conflict", "shadows", "covers"].includes(rel.kind), rel.kind);
    assert.equal(rel.between.length, 2);
    for (const site of rel.between) {
      assert.equal(typeof site, "string");
      assert.ok(byKey.has(site) || paths.has(site) || site.includes(":"), "site names nothing in the record: " + site);
    }
    assert.ok(rel.explanation && rel.evidence && rel.evidence.level && rel.evidence.basis);
  }
  // 066's duplicate pairs each emit a relationship as well as their finding
  assert.equal(relsOfKind(audit, "duplicate").length, duplicateFindings(audit).length);
  assert.equal(relsOfKind(audit, "conflict").length, findingsOfType(audit, "conflict").length);
});

test("two audits of one corpus derive the same relationships and findings", () => {
  const files = {
    "CLAUDE.md": "# Rules\n\n" + PIN_YES + "\n\n" + DUP_RULE + "\n",
    ".claude/rules/deps.md": "# Deps\n\n" + PIN_NO + "\n\n" + DUP_RULE + "\n",
    ".claude/CLAUDE.md": "# Older\n\n- Write clean, maintainable code.\n",
  };
  const root = tmpProject(files);
  const first = engine.scan(root, { projectOnly: true });
  const second = engine.scan(root, { projectOnly: true });
  const a = engine.composeAudit(first, judgeEvery(first));
  const b = engine.composeAudit(second, judgeEvery(second));
  assert.deepEqual(a.relationships, b.relationships);
  assert.deepEqual(a.findings, b.findings);
  assert.deepEqual(a.scopeOverlaps, b.scopeOverlaps);
  // [Foreman: 077] the ladder is derived, so it is identical too
  assert.deepEqual(a.mechanisms, b.mechanisms);
  assert.equal(engine.renderReport(a), engine.renderReport(b));
});

// ---------------------------------------------------------------------------
// [Foreman: 077] mechanisms — the enforcement ladder
// ---------------------------------------------------------------------------

// A fixture with something at every level. `userDir` is passed explicitly (never
// --project-only) because the hook inventory falls back to the real ~/.claude
// when no user directory is fixed — which would make every count below depend on
// the developer's own machine.
const LADDER_RULES = "# Rules\n\n- Always run the full test suite before committing.\n- Use `const` for locals.\n";
const LADDER_HOOKS = JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node .claude/hooks/check-tests.js" }] }],
    Stop: [{ hooks: [{ type: "command", command: "node .claude/hooks/gate.js" }] }],
  },
});

function ladderAudit(extra = {}, userFiles = {}, judge) {
  const userDir = tmpProject(userFiles);
  const scanData = engine.scan(tmpProject({ "CLAUDE.md": LADDER_RULES, ...extra }), { userDir });
  return engine.composeAudit(scanData, judge ? judgeEvery(scanData, judge) : judgeEvery(scanData));
}

const mechsOfType = (audit, type) => audit.mechanisms.filter((m) => m.type === type);

test("every mechanism carries the state chain its type honestly supports", () => {
  const audit = ladderAudit({
    ".claude/settings.json": LADDER_HOOKS,
    ".claude/skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Deploys the app when the user says \"deploy\".\n---\n\nbody\n",
    ".claude/agents/reviewer.md": "---\nname: reviewer\n---\n\nbody\n",
    "package.json": JSON.stringify({ name: "x", scripts: { test: "node --test", lint: "eslint .", build: "tsc" } }),
    ".pre-commit-config.yaml": "repos: []\n",
    ".git/config": "[core]\n\thooksPath = scripts/git-hooks\n",
    ".github/workflows/ci.yml": "on: push\n",
  }, { "skills/other/SKILL.md": "---\nname: other\ndescription: Something personal.\n---\n\nbody\n" });

  // ids are sequential and the ladder is emitted level-first
  assert.deepEqual(audit.mechanisms.map((m) => m.id), audit.mechanisms.map((_, i) => "M" + String(i + 1).padStart(3, "0")));
  assert.deepEqual(audit.mechanisms.map((m) => m.level), [...audit.mechanisms.map((m) => m.level)].sort((a, b) => a - b));
  // nothing, anywhere, is verified
  for (const m of audit.mechanisms) assert.equal(m.states.verified, false, m.name);

  // level 2 — skills carry no trust gate, and no guarantee of invocation
  assert.deepEqual(mechsOfType(audit, "skill").map((m) => m.name), ["deploy", "other"]);
  const skill = mechsOfType(audit, "skill")[0];
  assert.equal(skill.level, 2);
  assert.deepEqual(skill.states, { verified: false, configured: true, enabled: true, trusted: true, applicable: "unknown" });
  assert.ok(skill.coverage.limits.includes(engine.MECHANISM_LIMITS.routing));
  assert.equal(mechsOfType(audit, "skill")[1].source, "user scope");
  const agent = mechsOfType(audit, "subagent")[0];
  assert.equal(agent.level, 2);
  assert.deepEqual(agent.states, skill.states);

  // level 3 — a hook is wired and loads; workspace trust is not readable here
  const hooks = mechsOfType(audit, "hook");
  assert.deepEqual(hooks.map((m) => m.name), ["check-tests.js", "gate.js"]);
  assert.deepEqual(hooks[0].states, { verified: false, configured: true, enabled: true, trusted: "unknown", applicable: true });
  assert.deepEqual(hooks[0].coverage.events, ["PreToolUse"]);
  assert.deepEqual(hooks[0].coverage.tools, ["Bash"]);
  assert.match(hooks[0].coverage.limits[0], /`Bash` matcher is the whole of this hook's reach/);
  assert.ok(hooks[0].coverage.limits.includes(engine.MECHANISM_LIMITS.trust));
  // an absent matcher covers the event broadly, so no restriction sentence
  assert.deepEqual(hooks[1].coverage.matchers, ["*"]);
  assert.equal(hooks[1].coverage.tools, undefined);
  assert.deepEqual(hooks[1].coverage.limits, [engine.MECHANISM_LIMITS.trust, engine.MECHANISM_LIMITS.notExecuted]);

  // level 4 — only the four named scripts, one entry each; `build` is not one
  assert.deepEqual(mechsOfType(audit, "repo-check").map((m) => m.name),
    ["npm script: lint", "npm script: test", ".pre-commit-config.yaml", "git hooks: scripts/git-hooks"]);
  const repo = mechsOfType(audit, "repo-check")[0];
  assert.equal(repo.level, 4);
  assert.deepEqual(repo.states, { verified: false, configured: true, enabled: "unknown", trusted: "unknown", applicable: "unknown" });
  assert.ok(repo.coverage.limits.includes(engine.MECHANISM_LIMITS.repo));

  // level 5 — the workflow file, and nothing read out of it
  const remote = mechsOfType(audit, "remote-gate")[0];
  assert.deepEqual([remote.name, remote.level, remote.source], ["ci.yml", 5, ".github/workflows/ci.yml"]);
  assert.deepEqual(remote.states, repo.states);
  assert.ok(remote.coverage.limits.includes(engine.MECHANISM_LIMITS.remote));

  // the record still validates, and an audit written before 077 still does
  const record = engine.makeRecord("audit", audit, audit.root);
  assert.equal(engine.validateRecord(record, "audit"), null);
  delete record.mechanisms;
  assert.equal(engine.validateRecord(record, "audit"), null);
});

test("repository and remote detection fails open on everything missing or malformed", () => {
  const bare = ladderAudit();
  assert.deepEqual(mechsOfType(bare, "repo-check"), []);
  assert.deepEqual(mechsOfType(bare, "remote-gate"), []);

  const junk = ladderAudit({
    "package.json": "{ not json",
    ".git/config": "[core]\n\tbare = false\n",
    ".github/workflows/README.md": "not a workflow\n",
  });
  assert.deepEqual(junk.mechanisms, []);
});

test("the ladder renders the levels present, skips the empty ones, and never says enforced", () => {
  const full = engine.renderReport(ladderAudit({
    ".claude/settings.json": LADDER_HOOKS,
    ".claude/skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Deploys the app when the user says \"deploy\".\n---\n\nbody\n",
    ".claude/agents/reviewer.md": "---\nname: reviewer\n---\n\nbody\n",
    "package.json": JSON.stringify({ name: "x", scripts: { lint: "eslint ." } }),
    ".github/workflows/ci.yml": "on: push\n",
    // a mechanical rule, so the placement-candidate section renders and can
    // carry the contextual clause
  }, {}, { F3: 0.7, F8: 0.15 }));
  assert.match(full, /### Enforcement ladder/);
  assert.match(full, /A mechanism listed here is configured\. Only validation can show it runs — assay never infers execution from presence\./);
  assert.match(full, /- \*\*Level 1 — the rules themselves\*\*: 2 active rule\(s\)/);
  assert.match(full, /- \*\*Level 2 — skill and subagent workflows\*\*: 1 skill, 1 subagent \(deploy, reviewer\) — configured, not verified/);
  assert.match(full, /- \*\*Level 3 — agent lifecycle guardrails\*\*: 2 hooks \(PreToolUse: check-tests\.js, Stop: gate\.js\) — configured, not verified/);
  assert.match(full, /- \*\*Level 4 — repository enforcement\*\*: 1 repository check \(npm script: lint\) — configured, not verified/);
  assert.match(full, /- \*\*Level 5 — remote enforcement\*\*: 1 remote gate \(ci\.yml\) — configured, not verified/);
  // nothing in the ladder itself claims enforcement
  const block = full.slice(full.indexOf("### Enforcement ladder"), full.indexOf("### Already wired"));
  assert.doesNotMatch(block, /enforc(ed|es)\b/);
  // the contextual clause is said once, in the placement intro, because a level
  // 4/5 mechanism exists here
  assert.match(full, /Repository and remote gates exist in this project; a policy that must be impossible to merge belongs there/);

  // a project with only hooks shows only the levels it has
  const hooksOnly = engine.renderReport(ladderAudit({ ".claude/settings.json": LADDER_HOOKS }));
  assert.match(hooksOnly, /- \*\*Level 3 — agent lifecycle guardrails\*\*: 2 hooks/);
  for (const level of [2, 4, 5]) assert.doesNotMatch(hooksOnly, new RegExp("Level " + level + " — "));
  assert.doesNotMatch(hooksOnly, /Repository and remote gates exist/);

  // nothing wired at all: no ladder at all, and the section keeps its old shape
  const nothing = engine.renderReport(ladderAudit());
  assert.doesNotMatch(nothing, /### Enforcement ladder/);
  assert.match(nothing, /## Policy placement\n\nWhere each policy belongs/);
});

test("--verbose prints each mechanism's state chain and its coverage limits", () => {
  const audit = ladderAudit({ ".claude/settings.json": LADDER_HOOKS });
  const verbose = engine.renderReport(audit, { verbose: true });
  // [Foreman: 097] One line per mechanism, carrying what it reaches. The two
  // sentences true of every hook are the section's preamble, not 64 repeats.
  assert.match(verbose, /- M001 `check-tests\.js` \(project\) — PreToolUse on `Bash`/);
  assert.match(verbose, /Nothing below was watched running/);
  assert.match(verbose, /trusted workspace, which no static read can confirm/);
  assert.equal(verbose.split("workspace trust is not introspectable").length - 1, 0,
    "the blanket limit is being repeated under every mechanism again");
  // the default report lists the levels only and points at the flag
  const plain = engine.renderReport(audit);
  assert.doesNotMatch(plain, /- M001 /);
  assert.match(plain, /Rerun with `--verbose` to list every mechanism, with what each one reaches\./);
});

test("a skill defined in both project and user scope is flagged, and only then", () => {
  const SKILL = (name) => "---\nname: " + name + "\ndescription: Deploys the app when the user says \"deploy\".\n---\n\nbody\n";
  const clash = ladderAudit(
    { ".claude/skills/deploy/SKILL.md": SKILL("deploy") },
    { "skills/deploy/SKILL.md": SKILL("deploy") },
  );
  const hits = findingsOfType(clash, "mechanism-overlap");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, "low");
  assert.equal(hits[0].evidence.level, "mechanical");
  assert.match(hits[0].summary, /the project and user scopes both define skill `deploy`/);
  assert.match(hits[0].evidence.limits, /names only/);
  // 077 adds a finding, not a relationship kind
  assert.deepEqual(relsOfKind(clash, "covers"), []);

  const distinct = ladderAudit(
    { ".claude/skills/deploy/SKILL.md": SKILL("deploy") },
    { "skills/release/SKILL.md": SKILL("release") },
  );
  assert.deepEqual(findingsOfType(distinct, "mechanism-overlap"), []);
});

// ---------------------------------------------------------------------------
// Output contract — one record, every renderer — [Foreman: 078]
// ---------------------------------------------------------------------------

// One composed audit rich enough to reach every section both renderers have: a
// hard gate, weak rules, a duplicate pair, a conflict pair, a suppressed entry,
// mechanisms at three ladder levels, a semantic candidate, and a user-scope file.
function richAudit() {
  const userDir = tmpProject({
    "CLAUDE.md": "# Mine\n\n- Always answer in English.\n",
    "skills/deploy/SKILL.md": "---\nname: deploy\ndescription: short\n---\n\nbody\n",
  });
  const root = tmpProject({
    "CLAUDE.md": [
      "# Rules",
      "",
      PIN_YES,
      "- Always run the full test suite before every commit.",
      "- Write clean, maintainable code.",
      "- Read the notes in `docs/gone.md` before starting.",
      "",
      "This paragraph is background for the reader, not a rule.",
      "",
    ].join("\n"),
    ".claude/rules/deps.md": "# Deps\n\n" + PIN_NO + "\n",
    ".claude/rules/testing.md": "# Testing\n\n- Always run the full test suite before every commit.\n",
    ".claude/rules/dead.md": '---\npaths: ["nope/**/*.ts"]\n---\n\n- Return typed errors from every handler.\n',
    ".claude/skills/deploy/SKILL.md": "---\nname: deploy\ndescription: short\n---\n\nbody\n",
    ".claude/agents/reviewer.md": "---\nname: reviewer\n---\n\nbody\n",
    "package.json": JSON.stringify({ name: "x", scripts: { test: "node --test" } }),
  });
  const scanData = engine.scan(root, { userDir });
  // A host whose hook label keeps the argument list: the record then carries a
  // credential, which is exactly what render-time redaction exists for.
  scanData.hookInventory = [{
    event: "PreToolUse", matcher: "*", source: "project",
    command: "secret-scan.js --token=abc123SECRETxyz789",
  }];
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.4, F8: 0.4 };
  const prose = scanData.rules.find((r) => /clean, maintainable/.test(r.text));
  judgments[prose.key] = { F3: 0.4, F8: 0.4, notRule: "Describes a preference; asks for nothing." };
  judgments._candidates = [
    { kind: "paraphrase-duplicate", keys: [scanData.rules[0].key], summary: "Reads like the deps rule.", reason: "Different words, one duty.", accepted: null },
  ];
  return engine.composeAudit(scanData, judgments);
}

// The fixture is only worth its parity claim if it actually reaches every part
// of the record the renderers read.
test("the parity fixture carries a gate, a conflict, a duplicate, a mechanism and a suppressed entry", () => {
  const audit = richAudit();
  const types = new Set(audit.findings.map((f) => f.type));
  for (const type of ["conflict", "duplicate", "suppressed-entry"]) {
    assert.ok(types.has(type), "fixture is missing a " + type + " finding");
  }
  assert.ok(audit.findings.some((f) => f.state === "inactive"), "fixture is missing a hard gate");
  assert.ok(audit.mechanisms.length >= 2, "fixture is missing its ladder");
  assert.ok(audit.relationships.length >= 2, "fixture is missing its relationships");
  assert.ok(audit.files.some((f) => f.scope === "user"), "fixture is missing user scope");
  assert.ok(audit.semantic.candidates.length, "fixture is missing its semantic candidate");
});

test("every finding in the record is named in the markdown report", () => {
  const audit = richAudit();
  const md = engine.renderReport(audit, { verbose: true });
  for (const f of audit.findings) {
    const spans = (f.sources || []).map((s) => s.path + ":" + s.lineStart);
    const named = md.includes(f.summary) || (f.rule && md.includes(f.rule)) ||
      spans.some((s) => md.includes(s));
    assert.ok(named, "markdown never names finding " + f.id + " (" + f.type + ")");
  }
});

test("every mechanism and every relationship reaches the report", () => {
  const audit = richAudit();
  const md = engine.renderReport(audit, { verbose: true });
  for (const m of audit.mechanisms) {
    assert.ok(md.includes(engine.redactSecrets(m.name)), "markdown drops mechanism " + m.id);
  }
  // relationships are the edges behind the conflict, duplicate and shadow
  // findings — each is present wherever its finding is
  for (const rel of audit.relationships) {
    assert.ok(["conflict", "duplicate", "covers", "shadows"].includes(rel.kind));
  }
  const kinds = new Set(audit.relationships.map((r) => r.kind));
  if (kinds.has("conflict")) assert.match(md, /### Conflicts/);
  if (kinds.has("duplicate")) assert.match(md, /### Duplicates/);
});

// [Foreman: 078] The contract in one test: a renderer reads the record. Poison
// the record and the output carries the poison — if it recomputed anything, the
// original text would come back instead.
test("the renderer never recomputes: an edited record renders exactly as edited", () => {
  const audit = richAudit();
  // a state-carrying finding, whose summary the report prints as its own line
  const finding = audit.findings.find((f) => f.state === "inactive");
  finding.summary = "POISONED-SUMMARY-MARKER";
  const mechanism = audit.mechanisms[0];
  mechanism.name = "POISONED-MECHANISM-MARKER";

  const md = engine.renderReport(audit, { verbose: true });
  assert.match(md, /POISONED-MECHANISM-MARKER/);
  assert.match(md, /POISONED-SUMMARY-MARKER/);

  // and dropping the derived arrays empties the renderer rather than making it
  // derive a second, differently-timed analysis
  const bare = { ...audit, findings: [], mechanisms: [] };
  const bareMd = engine.renderReport(bare, { verbose: true });
  assert.doesNotMatch(bareMd, /POISONED-MECHANISM-MARKER/);
  assert.doesNotMatch(bareMd, /### Duplicates|### Conflicts|Enforcement ladder/);
});

test("a secret in a hook command is masked in the report and kept in the record", () => {
  const audit = richAudit();
  const md = engine.renderReport(audit, { verbose: true });
  // the record keeps the raw value — redaction is a render concern
  assert.ok(audit.mechanisms.some((m) => m.name.includes("abc123SECRETxyz789")));
  assert.doesNotMatch(md, /abc123SECRETxyz789/, "markdown leaked the token");
  assert.match(md, /--token=\[redacted\]/, "markdown never masked the token");
  // the mechanism itself is still there — redaction hides the value, never the
  // existence of the finding
  assert.match(md, /secret-scan\.js/, "markdown dropped the hook entirely");
});

test("redactSecrets masks the known credential shapes and leaves prose alone", () => {
  const cases = [
    ["deploy --token=abc123SECRETxyz789", "deploy --token=[redacted]"],
    ["api_key: 9f8e7d6c5b4a3928", "api_key: [redacted]"],
    // the token run is non-whitespace to its end, so a hugging quote goes with it
    ["curl -H 'Bearer aaaaaaaaaaaaaaaaaaaa'", "curl -H '[redacted]"],
    ["sk-abcdefghijklmnopqrstuvwx", "[redacted]"],
    ["ghp_abcdefghijklmnopqrstuvwxyz", "[redacted]"],
    ["AKIAABCDEFGHIJKLMNOP", "[redacted]"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(engine.redactSecrets(input), expected);
  }
  // a commit sha, a path and ordinary rule prose are not credentials
  for (const safe of [
    "run tests at 146811bfae2c9d0e1f",
    "see .claude/rules/testing.md",
    "Never commit a secret — run the scanner first.",
  ]) {
    assert.equal(engine.redactSecrets(safe), safe);
  }
});

// ---------------------------------------------------------------------------
// Command-level CLI — [Foreman: 070]
// ---------------------------------------------------------------------------

const CLI = path.join(__dirname, "..", "scripts", "assay.js");

function cli(root, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf-8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// One strong rule, one weak rule, and a paragraph of prose, so every count in
// the Coverage block has something to report.
const FIXTURE_CLAUDE = [
  "# Project rules",
  "",
  "- Never use `var` — use `const` instead.",
  "- Write clean, maintainable code.",
  "",
  "This paragraph is background for the reader, not a rule.",
  "",
].join("\n");

function cliFixture(extra) {
  return tmpProject({ "CLAUDE.md": FIXTURE_CLAUDE, ...(extra || {}) });
}

// scan, then write a judgment for every scanned key — the state `report` needs
function judgeAll(root) {
  const scanned = cli(root, "scan");
  assert.equal(scanned.code, 0, scanned.err);
  const summary = JSON.parse(scanned.out);
  const judgments = {};
  for (const j of summary.judge) judgments[j.key] = { F3: 0.7, F8: 0.9 };
  fs.writeFileSync(path.join(root, ".assay-tmp", "judgments.json"), JSON.stringify(judgments));
  return summary;
}

// Content hash + mtime of every file outside .assay-tmp, for the read-only check
function snapshotTree(root) {
  const snap = {};
  const stack = ["."];
  while (stack.length) {
    const rel = stack.pop();
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel === "." ? e.name : rel + "/" + e.name;
      if (e.isDirectory()) {
        if (e.name !== ".assay-tmp") stack.push(child);
      } else if (e.isFile()) {
        const full = path.join(root, child);
        snap[child] = crypto.createHash("sha1").update(fs.readFileSync(full)).digest("hex") +
          ":" + fs.statSync(full).mtimeMs;
      }
    }
  }
  return snap;
}

test("scan exits 0 and writes a parseable scan.json carrying coverage", () => {
  const root = cliFixture();
  const { code, out } = cli(root, "scan");
  assert.equal(code, 0);
  const summary = JSON.parse(out);
  assert.equal(summary.ruleCount, 2);
  assert.equal(summary.judge.length, 2);
  const scanFile = path.join(root, ".assay-tmp", "scan.json");
  assert.ok(fs.existsSync(scanFile));
  const scanData = JSON.parse(fs.readFileSync(scanFile, "utf-8"));
  assert.deepEqual(scanData.coverage, {
    filesDiscovered: 1, filesParsed: 1, inaccessible: [], proseChunks: 1, excludedLines: 0,
    // [Foreman: 074] what the audit saw and did not grade
    userFilesIncluded: false, userSkills: [], agents: [],
    // [ADR 2026-08-05 B5] the Claude adapter discloses its residual coverage —
    // [Foreman: 097] and only about surfaces this project actually has, so a
    // fixture with no auto memory and no saved workflows carries no note and the
    // key is absent entirely.
  });
});

test("scan on a project with no instruction files reports zero and still exits 0", () => {
  const root = tmpProject({ "README.md": "# Not an instruction file\n" });
  const { code, out } = cli(root, "scan");
  assert.equal(code, 0);
  const summary = JSON.parse(out);
  assert.equal(summary.ruleCount, 0);
  assert.equal(summary.skillCount, 0);
  assert.equal(summary.fileCount, 0);
  assert.deepEqual(summary.judge, []);
  // the scan file is still written, so `report` has something to read
  assert.ok(fs.existsSync(path.join(root, ".assay-tmp", "scan.json")));
});

test("report exits 0 and prints the header and the Coverage block", () => {
  const root = cliFixture();
  judgeAll(root);
  const { code, out } = cli(root, "report", "--verbose");
  assert.equal(code, 0);
  assert.match(out, /^# Rule audit — /m);
  assert.match(out, /## Coverage/);
  assert.match(out, /1 of 1 instruction file\(s\) parsed, 2 rule\(s\) graded, 1 prose chunk\(s\) set aside/);
  assert.match(out, /0 line\(s\) excluded from grading/);
  assert.ok(fs.existsSync(path.join(root, ".assay-tmp", "audit.json")));
});

// [Foreman: 075]
test("the report prints the four findings-first sections and the headline counts", () => {
  const root = cliFixture();
  judgeAll(root);
  const { code, out } = cli(root, "report", "--verbose");
  assert.equal(code, 0);
  for (const header of ["## Hard gates", "## Operational findings", "## Policy placement", "## Structural hygiene (secondary)"]) {
    assert.ok(out.includes(header), "missing " + header);
  }
  // the headline is a count by state, not a mean
  assert.match(out, /^\*\*\d+ [a-z-]+(?:, \d+ [a-z- ]+)*\*\* across \d+ file\(s\)\.$/m);
  assert.match(out, /Findings are this report's primary output/);
  // the audit record emits its findings; the scan record has none to emit yet
  const audit = readJson(root, "audit.json");
  assert.ok(Array.isArray(audit.findings) && audit.findings.length);
  assert.equal("findings" in readJson(root, "scan.json"), false);
});

// [Foreman: 075]
test("remeasure prints finding deltas beside the grade movement", () => {
  const root = cliFixture();
  judgeAll(root);
  assert.equal(cli(root, "report", "--verbose").code, 0);

  // the rewrite trades an advisory rule for a bare prohibition, so a state
  // count moves in both directions
  fs.writeFileSync(
    path.join(root, "CLAUDE.md"),
    FIXTURE_CLAUDE.replace("Write clean, maintainable code.", "Never skip the tests.")
  );
  const pending = JSON.parse(cli(root, "remeasure").out);
  const judgeFile = path.join(root, ".assay-tmp", "judgments.json");
  const judgments = JSON.parse(fs.readFileSync(judgeFile, "utf-8"));
  for (const j of pending.judge) judgments[j.key] = { F3: 0.7, F8: 0.9 };
  fs.writeFileSync(judgeFile, JSON.stringify(judgments));

  const { code, out } = cli(root, "remeasure");
  assert.equal(code, 0);
  assert.match(out, /## Since last audit/);
  assert.match(out, /\| Finding \| Before \| After \|/);
  assert.match(out, /\| at-risk \| 0 \| 1 \|/);
  assert.match(out, /\| advisory \| 2 \| 1 \|/);
  // the grade comparison still follows the findings
  assert.ok(out.indexOf("| Finding | Before | After |") < out.indexOf("Corpus grade"));
});

test("the Coverage block counts suppressed entries even though the rows stay verbose-only", () => {
  const root = cliFixture();
  const summary = judgeAll(root);
  const judgments = {};
  for (const j of summary.judge) judgments[j.key] = { F3: 0.7, F8: 0.9 };
  judgments[summary.judge[1].key].notRule = "Describes an aspiration; asks for nothing.";
  fs.writeFileSync(path.join(root, ".assay-tmp", "judgments.json"), JSON.stringify(judgments));
  const verbose = cli(root, "report", "--verbose");
  assert.equal(verbose.code, 0);
  assert.match(verbose.out, /## Suppressed/);
  assert.match(verbose.out, /asks for nothing/);
  // [Foreman: 095] --verbose is the CLI's only door to the full report now, so
  // the plain/verbose split inside it is exercised at the function level. The
  // subject is unchanged: Coverage counts the drop, the rows stay verbose-only.
  const audit = JSON.parse(fs.readFileSync(path.join(root, ".assay-tmp", "audit.json"), "utf-8"));
  const plain = engine.renderReport(audit, {});
  assert.match(plain, /1 entry suppressed by the verification pass/);
  assert.doesNotMatch(plain, /## Suppressed/);
});

// [Foreman: 071]
test("report without a judgments file lands a deterministic-only audit", () => {
  const root = cliFixture();
  assert.equal(cli(root, "scan").code, 0);
  const { code, out } = cli(root, "report", "--verbose");
  assert.equal(code, 0);
  // the banner, the coverage gap, and the score's evidence mix all say it
  assert.match(out, /· deterministic only$/m);
  assert.match(out, /- model-judged checks did not run \(trigger clarity, enforceability, rule-verification\); deterministic findings only/);
  assert.match(out, /No model judged anything in this run/);
  // it is a real report, not a stub: the findings-first sections all print
  for (const header of ["## Coverage", "## Hard gates", "## Operational findings", "## Policy placement", "## Structural hygiene (secondary)"]) {
    assert.ok(out.includes(header), "missing " + header);
  }
  // and the record claims no semantic pass it never had
  const audit = readJson(root, "audit.json");
  assert.equal("semantic" in audit, false);
  assert.equal(engine.validateRecord(audit, "audit"), null);
  assert.ok(audit.rules.every((r) => r.factorValues.F3 === null && r.f8 === null));
  // --verbose prints the unjudged columns as dashes, never as invented numbers
  const verbose = cli(root, "report", "--verbose");
  assert.equal(verbose.code, 0);
  assert.match(verbose.out, /^\| \[R001[^|]*\| mandate \| [\d.]+ \| [\d.]+ \| — \| [\d.]+ \| [\d.]+ \| [\d.]+ \| — \|/m);
});

test("report on malformed judgments exits 1 and names the problem", () => {
  const root = cliFixture();
  const summary = judgeAll(root);
  const judgeFile = path.join(root, ".assay-tmp", "judgments.json");

  fs.writeFileSync(judgeFile, "{ not json");
  const broken = cli(root, "report", "--verbose");
  assert.equal(broken.code, 1);
  assert.match(broken.err, /judgments\.json is not valid JSON/);

  // schema-invalid: a score outside [0,1]
  fs.writeFileSync(judgeFile, JSON.stringify({ [summary.judge[0].key]: { F3: 5, F8: 0.9 } }));
  const outOfRange = cli(root, "report", "--verbose");
  assert.equal(outOfRange.code, 1);
  assert.match(outOfRange.err, /value\(s\) outside the 0–1 range/);
  assert.match(outOfRange.err, /F3 = 5/);
  // and the recovery that needs no model at all is named
  assert.match(outOfRange.err, /delete \.assay-tmp\/judgments\.json/);

  // schema-invalid: notRule present but not a non-empty string
  fs.writeFileSync(judgeFile, JSON.stringify({
    [summary.judge[0].key]: { F3: 0.7, F8: 0.9, notRule: "" },
    [summary.judge[1].key]: { F3: 0.7, F8: 0.9 },
  }));
  const badNotRule = cli(root, "report", "--verbose");
  assert.equal(badNotRule.code, 1);
  assert.match(badNotRule.err, /suppression\(s\) carry no reason/);
});

test("report before scan exits 1 and says to run scan first", () => {
  const root = cliFixture();
  const { code, err } = cli(root, "report", "--verbose");
  assert.equal(code, 1);
  assert.match(err, /No \.assay-tmp\/scan\.json to report from — run `assay\.js scan` here first/);
  // [Foreman: 097] and it names the door a person actually goes through
  assert.match(err, /\/assay:opus5/);
});

test("remeasure lists reworded rules first, then composes a before/after report", () => {
  const root = cliFixture();
  judgeAll(root);
  assert.equal(cli(root, "report", "--verbose").code, 0);

  // rewording a rule changes its content hash, so its cached judgment is gone
  fs.writeFileSync(
    path.join(root, "CLAUDE.md"),
    FIXTURE_CLAUDE.replace("Write clean, maintainable code.", "Write typed handlers in `src/api/handler.ts`.")
  );
  const pending = cli(root, "remeasure");
  assert.equal(pending.code, 0);
  const worklist = JSON.parse(pending.out);
  assert.equal(worklist.remeasure, true);
  assert.equal(worklist.pending, 1);
  assert.match(worklist.judge[0].text, /typed handlers/);

  const judgeFile = path.join(root, ".assay-tmp", "judgments.json");
  const judgments = JSON.parse(fs.readFileSync(judgeFile, "utf-8"));
  judgments[worklist.judge[0].key] = { F3: 0.7, F8: 0.9 };
  fs.writeFileSync(judgeFile, JSON.stringify(judgments));

  const composed = cli(root, "remeasure");
  assert.equal(composed.code, 0);
  assert.match(composed.out, /## Since last audit/);
  assert.match(composed.out, /Corpus grade .* → /);
  assert.match(composed.out, /## Coverage/);
});

// [Foreman: 071]
test("remeasure without judgments stays deterministic instead of demanding a model pass", () => {
  const root = cliFixture();
  assert.equal(cli(root, "scan").code, 0);
  const first = cli(root, "report", "--verbose");
  assert.equal(first.code, 0);

  fs.writeFileSync(
    path.join(root, "CLAUDE.md"),
    FIXTURE_CLAUDE.replace("Write clean, maintainable code.", "Write typed handlers in `src/api/handler.ts`.")
  );
  // no judgments file means nothing to re-judge: no worklist, straight to the
  // report, with the before/after the prior audit makes possible
  const { code, out } = cli(root, "remeasure");
  assert.equal(code, 0);
  assert.doesNotMatch(out, /"remeasure": true/);
  assert.match(out, /· deterministic only$/m);
  assert.match(out, /## Since last audit/);
  assert.equal("semantic" in readJson(root, "audit.json"), false);
});

// [Foreman: 094]
test("remeasure on a project with no .assay-tmp/ runs instead of throwing ENOENT", () => {
  const root = cliFixture();
  const { code, out, err } = cli(root, "remeasure");
  assert.equal(code, 0, err);
  assert.doesNotMatch(err, /ENOENT/);
  assert.match(out, /· deterministic only$/m);
});

// [Foreman: 071]
// The renormalization contract: a factor nobody measured leaves the numerator
// AND the denominator, so the composite stays a weighted mean over the factors
// that have evidence. A default value would be a number assay invented.
test("an unjudged factor drops its weight from the score instead of taking a default", () => {
  const root = tmpProject({ "CLAUDE.md": "- Never use `var` — use `const` instead.\n" });
  const scanData = engine.scan(root);
  const key = scanData.rules[0].key;
  const compose = (j) => engine.composeAudit(scanData, j).rules[0];

  const WEIGHTS = { F1: 1.5, F2: 1.0, F3: 1.3, F4: 1.0, F5: 1.5, F7: 2.0 };
  const formula = (values) => {
    let num = 0, den = 0;
    for (const [name, weight] of Object.entries(WEIGHTS)) {
      if (values[name] == null) continue;
      num += weight * values[name];
      den += weight;
    }
    return Math.round((num / den) * 1000) / 1000;
  };

  const bare = compose(null);
  assert.equal(bare.factorValues.F3, null, "F3 must stay unmeasured, not defaulted");
  assert.equal(bare.f8, null);
  assert.equal(bare.preFloor, formula(bare.factorValues));
  // the denominator really shrank by F3's weight: 8.3 → 7.0
  const deterministicMean = bare.preFloor;

  const judged = compose({ [key]: { F3: 0.75, F8: 0.7 } });
  assert.equal(judged.preFloor, formula(judged.factorValues));

  // the giveaway that the weight was dropped and not defaulted: judging F3 at
  // exactly the deterministic mean moves the score nowhere at all, while judging
  // it above or below moves it in that direction
  assert.equal(compose({ [key]: { F3: deterministicMean, F8: 0.7 } }).preFloor, deterministicMean);
  assert.ok(compose({ [key]: { F3: 1, F8: 0.7 } }).preFloor > deterministicMean);
  assert.ok(compose({ [key]: { F3: 0, F8: 0.7 } }).preFloor < deterministicMean);
  // and an unmeasured factor can never be the dominant weakness
  assert.notEqual(bare.dominantWeakness, "F3");
});

// [Foreman: 071]
test("judgments carry provenance, which the record embeds and per-key validation ignores", () => {
  const root = cliFixture();
  const summary = judgeAll(root);
  const judgeFile = path.join(root, ".assay-tmp", "judgments.json");
  const judgments = JSON.parse(fs.readFileSync(judgeFile, "utf-8"));
  const provenance = {
    model: "claude-sonnet-4-5",
    promptVersion: engine.RUBRIC_VERSION,
    judgedAt: "2026-07-28T10:00:00.000Z",
    pass: "F3/F8+verify",
  };
  fs.writeFileSync(judgeFile, JSON.stringify({ _provenance: provenance, ...judgments }));

  // _provenance is not a rule key, so per-key validation never trips on it
  const scanData = engine.scan(root);
  assert.equal(engine.loadJudgments(root, scanData.rules).error, undefined);

  const { code, out } = cli(root, "report", "--verbose");
  assert.equal(code, 0);
  const audit = readJson(root, "audit.json");
  assert.deepEqual(audit.semantic, {
    provenance,
    judged: summary.judge.length,
    suppressed: 0,
    // [Foreman: 076] no `_candidates` in this file, so the proposal channel is empty
    candidates: [],
  });
  // a model-judged run is never labelled deterministic
  assert.doesNotMatch(out, /deterministic only/);
  assert.doesNotMatch(out, /model-judged checks did not run/);
  // matching rubric versions print no warning
  assert.doesNotMatch(out, /rerun step 2 to refresh/);

  // judgments with no provenance still compose; the field is simply null
  fs.writeFileSync(judgeFile, JSON.stringify(judgments));
  assert.equal(cli(root, "report", "--verbose").code, 0);
  assert.equal(readJson(root, "audit.json").semantic.provenance, null);

  // a provenance of the wrong shape is a malformed file, which stays fatal
  fs.writeFileSync(judgeFile, JSON.stringify({ _provenance: { model: 7 }, ...judgments }));
  const bad = cli(root, "report", "--verbose");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /_provenance\.model/);
});

// [Foreman: 071]
// The judgment cache invalidates structurally on an edited rule — the key is a
// content hash — but a rewritten rubric is the axis a hash cannot see.
test("the report warns when the judgments predate the engine's rubric version", () => {
  const root = cliFixture();
  judgeAll(root);
  const judgeFile = path.join(root, ".assay-tmp", "judgments.json");
  const judgments = JSON.parse(fs.readFileSync(judgeFile, "utf-8"));
  fs.writeFileSync(judgeFile, JSON.stringify({ _provenance: { promptVersion: "1" }, ...judgments }));

  const { code, out } = cli(root, "report", "--verbose");
  assert.equal(code, 0);
  assert.match(out, new RegExp(`Judgments were made under rubric v1; this engine ships rubric v${engine.RUBRIC_VERSION} — rerun step 2 to refresh\\.`));
  // it is a warning, not a gate: the report is complete underneath it
  assert.match(out, /## Structural hygiene \(secondary\)/);

  // the rubric file's own header is what the skill copies into promptVersion —
  // the two must not drift apart
  const rubrics = fs.readFileSync(path.join(__dirname, "..", "references", "rubrics.md"), "utf-8");
  assert.equal(rubrics.split("\n")[0], "Rubric version: " + engine.RUBRIC_VERSION);
});

// [Foreman: 071]
// Additivity, invariant 1: a model may regroup the report and may never remove a
// source span. A suppressed entry leaves the counts the report averages over —
// and nothing else.
test("suppressing an entry regroups the report without touching the inventory", () => {
  const root = tmpProject({
    "CLAUDE.md": "- Never use `var` — use `const` instead.\n\n- The team migrated to pnpm last quarter.\n",
  });
  const scanData = engine.scan(root);
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.7, F8: 0.7 };
  const kept = engine.composeAudit(scanData, JSON.parse(JSON.stringify(judgments)));
  judgments[scanData.rules[1].key].notRule = "Records what the team did; it asks for nothing.";
  const dropped = engine.composeAudit(scanData, judgments);

  // the line inventory is byte-identical: same span classes, same counts
  assert.deepEqual(dropped.sources, kept.sources);
  assert.equal(dropped.sources[0].spans.instruction, kept.sources[0].spans.instruction);
  // the entry is still in the record, still scored, only regrouped
  assert.equal(dropped.rules.length, kept.rules.length);
  assert.equal(dropped.rules[1].score, kept.rules[1].score);
  assert.deepEqual(dropped.rules[1].factorValues, kept.rules[1].factorValues);
  assert.equal(dropped.rules[1].suppressed, true);
  // what changed is membership in the counts, and the finding it now carries
  assert.equal(dropped.files[0].ruleCount, kept.files[0].ruleCount - 1);
  assert.equal(dropped.findings.filter((f) => f.type === "suppressed-entry").length, 1);
  assert.equal(dropped.semantic.suppressed, 1);
});

// [Foreman: 071]
// Additivity, invariant 2: the semantic pass adds findings; it never alters one
// the deterministic layer already produced. Judged at values that derive no
// model-inferred state, the two runs must agree finding for finding.
test("deterministic findings are identical with and without judgments", () => {
  const root = tmpProject({
    "CLAUDE.md": [
      "# Project rules",
      "",
      "- Never use `var` — use `const` instead.",
      "- Write clean, maintainable code.",
      "- Always read `docs/missing-guide.md` before editing the parser.",
      "",
    ].join("\n"),
  });
  const scanData = engine.scan(root);
  const judgments = {};
  // F3 above the ambiguity threshold, F8 between the hook and advisory ones, so
  // no rule takes a model-inferred state and only deterministic signals speak
  for (const r of scanData.rules) judgments[r.key] = { F3: 0.7, F8: 0.7 };

  const judged = engine.composeAudit(scanData, judgments);
  const bare = engine.composeAudit(scanData, null);
  assert.deepEqual(bare.findings, judged.findings);
  assert.ok(judged.findings.some((f) => f.state === "blocked"), "fixture lost its hard gate");

  // the model layer is what is absent, not the analysis: the deterministic
  // report still names the same gate at the same line
  const report = engine.renderReport(bare);
  assert.match(report, /## Hard gates/);
  assert.match(report, /docs\/missing-guide\.md/);
});

// [Foreman: 071]
test("semantic is optional payload: an audit without it stays schema-valid", () => {
  const root = cliFixture();
  assert.equal(cli(root, "scan").code, 0);
  assert.equal(cli(root, "report", "--verbose").code, 0);
  const deterministic = readJson(root, "audit.json");
  assert.equal("semantic" in deterministic, false);
  assert.equal(engine.validateRecord(deterministic, "audit"), null);
  // adding it keeps the record valid, and it is not a reserved field any more
  assert.equal(engine.RECORD_SCHEMA.reserved.includes("semantic"), false);
  assert.equal(engine.RECORD_SCHEMA.payload.audit.includes("semantic"), false);
  assert.equal(
    engine.validateRecord({ ...deterministic, semantic: { provenance: null, judged: 0, suppressed: 0 } }, "audit"),
    null
  );
  // the candidate kinds are a contract only — nothing emits one yet
  assert.deepEqual(engine.SEMANTIC_CANDIDATE_KINDS, [
    "paraphrase-duplicate", "indirect-conflict", "ambiguous-meaning", "placement", "rewrite",
  ]);
  assert.equal(deterministic.rules.some((r) => r.candidates), false);
});

test("clean removes .assay-tmp and exits 0", () => {
  const root = cliFixture();
  judgeAll(root);
  assert.ok(fs.existsSync(path.join(root, ".assay-tmp")));
  const { code } = cli(root, "clean");
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(root, ".assay-tmp")), false);
  // and cleaning twice is not an error
  assert.equal(cli(root, "clean").code, 0);
});

test("an unknown command, an unknown flag, or a bare --root prints usage and exits 1", () => {
  const root = cliFixture();
  const noCommand = cli(root);
  assert.equal(noCommand.code, 1);
  assert.match(noCommand.err, /No command given\./);
  assert.match(noCommand.err, /Usage: assay\.js <command>/);
  // [Foreman: 097] the block says which commands a person runs and which the
  // skill drives, and asking for help is not an error
  assert.match(noCommand.err, /Commands to run yourself:/);
  assert.match(noCommand.err, /Driven by the skill, not by hand/);
  for (const flag of ["--help", "-h", "help"]) {
    const helped = cli(root, flag);
    assert.equal(helped.code, 0, flag + ": " + helped.err);
    assert.match(helped.out, /Usage: assay\.js <command>/);
  }

  const badCommand = cli(root, "frobnicate");
  assert.equal(badCommand.code, 1);
  assert.match(badCommand.err, /Unknown command: frobnicate/);
  assert.match(badCommand.err, /Usage: assay\.js/);

  const badFlag = cli(root, "scan", "--verbse");
  assert.equal(badFlag.code, 1);
  assert.match(badFlag.err, /Unknown flag: --verbse/);
  assert.equal(fs.existsSync(path.join(root, ".assay-tmp")), false);

  const bareRoot = cli(root, "scan", "--root");
  assert.equal(bareRoot.code, 1);
  assert.match(bareRoot.err, /--root needs a path/);
});

test("installation to report: a fresh project runs scan, judge and report", () => {
  const root = tmpProject({
    "CLAUDE.md": FIXTURE_CLAUDE,
    ".claude/rules/api.md": '---\npaths: ["src/**/*.ts"]\n---\n\n- Validate every request body at the handler boundary.\n',
    "src/api/handler.ts": "export {};",
  });

  const scanned = cli(root, "scan");
  assert.equal(scanned.code, 0, scanned.err);
  const summary = JSON.parse(scanned.out);
  assert.equal(summary.fileCount, 2);
  assert.equal(summary.judge.length, 3);
  assert.ok(fs.existsSync(path.join(root, ".assay-tmp", "scan.json")));

  const judgments = {};
  for (const j of summary.judge) judgments[j.key] = { F3: 0.7, F8: 0.9 };
  fs.writeFileSync(path.join(root, ".assay-tmp", "judgments.json"), JSON.stringify(judgments));

  const reported = cli(root, "report", "--verbose");
  assert.equal(reported.code, 0, reported.err);
  assert.match(reported.out, /# Rule audit — /);
  assert.match(reported.out, /2 of 2 instruction file\(s\) parsed, 3 rule\(s\) graded/);
  // the report names the fixture's own weak rule, at its line
  assert.match(reported.out, /Write clean, maintainable code\./);
  assert.match(reported.out, /\(CLAUDE\.md:4\)/);
  assert.ok(fs.existsSync(path.join(root, ".assay-tmp", "audit.json")));
});

test("scan, report and remeasure write nothing outside .assay-tmp", () => {
  const root = tmpProject({
    "CLAUDE.md": FIXTURE_CLAUDE,
    ".claude/rules/api.md": "- Validate every request body at the handler boundary.\n",
    ".claude/settings.json": '{ "hooks": {} }\n',
    "src/api/handler.ts": "export {};",
  });
  const before = snapshotTree(root);
  judgeAll(root);
  assert.equal(cli(root, "report", "--verbose").code, 0);
  assert.equal(cli(root, "remeasure").code, 0);
  assert.deepEqual(snapshotTree(root), before);
  // no policy file was invented either, and no transaction state — [Foreman: 081]
  // read-only analysis never opens the change journal
  assert.equal(fs.existsSync(path.join(root, ".claude", "assay-promotions.md")), false);
  assert.equal(fs.existsSync(path.join(root, engine.STATE_DIR)), false);
});

test("a discovered file that cannot be read is counted and named, not dropped silently", () => {
  const root = tmpProject({ ".claude/rules/basics.md": "- Run `npm test` before committing.\n" });
  // a directory where CLAUDE.md should be: discovered, then unreadable
  fs.mkdirSync(path.join(root, "CLAUDE.md"));
  const scanData = engine.scan(root);
  assert.equal(scanData.coverage.filesDiscovered, 2);
  assert.equal(scanData.coverage.filesParsed, 1);
  assert.equal(scanData.coverage.inaccessible.length, 1);
  assert.equal(scanData.coverage.inaccessible[0].path, "CLAUDE.md");
  assert.ok(scanData.coverage.inaccessible[0].reason);
  // the readable file still grades, and the report says what it never saw
  assert.equal(scanData.rules.length, 1);
  const judgments = { [scanData.rules[0].key]: { F3: 0.7, F8: 0.9 } };
  const report = engine.renderReport(engine.composeAudit(scanData, judgments));
  assert.match(report, /1 of 2 instruction file\(s\) parsed/);
  assert.match(report, /could not read `CLAUDE\.md`/);
});

// ---------------------------------------------------------------------------
// Instruction System record — [Foreman: 072]
// ---------------------------------------------------------------------------

function readJson(root, name) {
  return JSON.parse(fs.readFileSync(path.join(root, ".assay-tmp", name), "utf-8"));
}

// the pre-072 file shape: the payload with no envelope around it
function stripEnvelope(record) {
  const { schemaVersion, analyzer, parser, profile, context, ...payload } = record;
  return payload;
}

test("validateRecord accepts a record and names what a broken one is missing", () => {
  const root = cliFixture();
  assert.equal(cli(root, "scan").code, 0);
  const record = readJson(root, "scan.json");
  assert.equal(engine.validateRecord(record, "scan"), null);

  assert.match(engine.validateRecord(record, "inventory"), /unknown record kind: inventory/);
  assert.equal(engine.validateRecord(null, "scan"), "not a JSON object");
  assert.equal(engine.validateRecord(stripEnvelope(record), "scan"), "found schema pre-1");
  assert.equal(engine.validateRecord({ ...record, schemaVersion: "1" }, "scan"), "found schema pre-1");
  assert.equal(engine.validateRecord({ ...record, schemaVersion: 99 }, "scan"), "found schema 99");
  assert.match(engine.validateRecord({ ...record, analyzer: undefined }, "scan"), /analyzer is missing/);
  assert.match(engine.validateRecord({ ...record, coverage: null }, "scan"), /coverage is missing/);
  assert.match(engine.validateRecord({ ...record, parser: { name: "x", version: "1" } }, "scan"), /parser is missing/);
  assert.match(engine.validateRecord({ ...record, profile: { host: "claude-code" } }, "scan"), /profile is missing/);
  assert.match(
    engine.validateRecord({ ...record, context: { ...record.context, analysisTime: 0 } }, "scan"),
    /context\.analysisTime is missing or not a string/
  );
  assert.match(engine.validateRecord({ ...record, rules: {} }, "scan"), /rules is missing or not an array/);
});

test("every artifact the CLI writes is a schema 1 record, and the report says so", () => {
  const root = cliFixture();
  judgeAll(root);
  const reported = cli(root, "report", "--verbose");
  assert.equal(reported.code, 0, reported.err);
  assert.match(reported.out, /^assay \S+ · claude-code profile · schema 1$/m);

  for (const [name, kind] of [["scan.json", "scan"], ["audit.json", "audit"]]) {
    const record = readJson(root, name);
    assert.equal(engine.validateRecord(record, kind), null, name);
    assert.equal(record.schemaVersion, engine.SCHEMA_VERSION);
    assert.deepEqual(record.analyzer, { name: "assay", version: engine.ANALYZER_VERSION });
    assert.equal(record.profile.host, "claude-code");
    assert.equal(record.context.startupDirectory, record.context.projectRoot);
    assert.equal(path.basename(record.context.projectRoot), path.basename(root));
    assert.ok(!Number.isNaN(Date.parse(record.context.analysisTime)));
    // reserved fields are documented, not emitted
    for (const key of engine.RECORD_SCHEMA.reserved) assert.equal(key in record, false, key);
  }
});

test("report rejects a pre-schema artifact and says to rerun scan", () => {
  const root = cliFixture();
  judgeAll(root);
  assert.equal(cli(root, "report", "--verbose").code, 0);

  const scanFile = path.join(root, ".assay-tmp", "scan.json");
  fs.writeFileSync(scanFile, JSON.stringify(stripEnvelope(readJson(root, "scan.json"))));
  const stale = cli(root, "report", "--verbose");
  assert.equal(stale.code, 1);
  assert.match(stale.err, /scan\.json is not a schema 1 scan record \(found schema pre-1\) — rerun `assay\.js scan` to replace it\./);

  // a future schema is named by the version found, not silently misread
  fs.writeFileSync(scanFile, JSON.stringify({ ...readJson(root, "scan.json"), schemaVersion: 2 }));
  const future = cli(root, "report", "--verbose");
  assert.equal(future.code, 1);
  assert.match(future.err, /found schema 2/);
});

test("remeasure discards a prior audit from an older assay and still reports", () => {
  const root = cliFixture();
  judgeAll(root);
  assert.equal(cli(root, "report", "--verbose").code, 0);
  const auditFile = path.join(root, ".assay-tmp", "audit.json");
  fs.writeFileSync(auditFile, JSON.stringify(stripEnvelope(readJson(root, "audit.json"))));

  const { code, out, err } = cli(root, "remeasure");
  assert.equal(code, 0, err);
  assert.match(err, /Ignoring \.assay-tmp\/audit\.json from an older assay \(found schema pre-1\)/);
  assert.match(err, /before\/after comparison is skipped/);
  // the re-scan still ran and reported; only the comparison was dropped
  assert.match(out, /## Coverage/);
  assert.doesNotMatch(out, /## Since last audit/);
  assert.equal(engine.validateRecord(readJson(root, "audit.json"), "audit"), null);
});

// [Foreman: 074] hostVersion joins analysisTime as environmental: it is probed
// from whatever `claude` the machine has on PATH, so it is not a function of the
// project. Everything else still has to be byte-identical.
test("two scans of an unchanged project differ only in analysisTime and hostVersion", () => {
  const root = cliFixture();
  assert.equal(cli(root, "scan").code, 0);
  const first = readJson(root, "scan.json");
  assert.equal(cli(root, "scan").code, 0);
  const second = readJson(root, "scan.json");
  assert.ok(!Number.isNaN(Date.parse(first.context.analysisTime)));
  for (const record of [first, second]) {
    delete record.context.analysisTime;
    delete record.context.hostVersion;
  }
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("findRuleMarkdownFiles records a directory it cannot walk", () => {
  const root = tmpProject({ ".claude/rules": "not a directory\n" });
  const inaccessible = [];
  const found = engine.findRuleMarkdownFiles(path.join(root, ".claude", "rules"), inaccessible);
  assert.deepEqual(found, []);
  assert.equal(inaccessible.length, 1);
  assert.equal(inaccessible[0].path, ".");
  assert.ok(inaccessible[0].reason);
});

// ---------------------------------------------------------------------------
// Parser and inventory — [Foreman: 073]
// ---------------------------------------------------------------------------

// One file carrying every construct the parser has to place: frontmatter in
// four YAML shapes, ATX and setext headings, a paragraph, a nested list, a GFM
// table with a non-Latin cell, a block quote, a bare link, a block comment, an
// inline comment, three fence styles, an assay-ignore span and a tag body.
const GOLDEN = [
  /*  1 */ "---",
  /*  2 */ "name: golden",
  /*  3 */ "default-category: mandate",
  /*  4 */ "paths: [\"docs/**/*.md\", 'src/**']",
  /*  5 */ "tags:",
  /*  6 */ "  - alpha",
  /*  7 */ "  - beta",
  /*  8 */ "summary: >-",
  /*  9 */ "  A folded scalar that wraps",
  /* 10 */ "  across two lines.",
  /* 11 */ "---",
  /* 12 */ "",
  /* 13 */ "# Golden fixture",
  /* 14 */ "",
  /* 15 */ "Setext heading",
  /* 16 */ "--------------",
  /* 17 */ "",
  /* 18 */ "This paragraph is background for the reader, not a rule.",
  /* 19 */ "",
  /* 20 */ "- Use `const` for local bindings.",
  /* 21 */ "  - Never use `var` — use `let` instead.",
  /* 22 */ "",
  /* 23 */ "| Do | Don't |",
  /* 24 */ "|---|---|",
  /* 25 */ "| Run `npm test` before pushing | Никогда |",
  /* 26 */ "",
  /* 27 */ "> Quoted context, still inventoried.",
  /* 28 */ "",
  /* 29 */ "- [the style guide](./style.md)",
  /* 30 */ "",
  /* 31 */ "<!-- a block comment Claude never receives -->",
  /* 32 */ "",
  /* 33 */ "```js",
  /* 34 */ "const x = 1;",
  /* 35 */ "```",
  /* 36 */ "",
  /* 37 */ "~~~md",
  /* 38 */ "- Always run `npm test`.",
  /* 39 */ "~~~",
  /* 40 */ "",
  /* 41 */ "````md",
  /* 42 */ "```",
  /* 43 */ "- Never commit `secrets.env`.",
  /* 44 */ "```",
  /* 45 */ "````",
  /* 46 */ "",
  /* 47 */ "- Validate request bodies with Zod. <!-- inline note -->",
  /* 48 */ "",
  /* 49 */ "<!-- assay-ignore-start -->",
  /* 50 */ "- We once shipped a stale lockfile.",
  /* 51 */ "<!-- assay-ignore-end -->",
  /* 52 */ "",
  /* 53 */ "<example>",
  /* 54 */ "1. Place the caret on MyHelper",
  /* 55 */ "</example>",
  /* 56 */ "",
].join("\n");

const MIXED_LANGUAGE = [
  "# Правила",
  "",
  "- Перед commit запустите тесты.",
  "- コードレビューを必ず実行する。",
  "",
  "| Правило | Заметка |",
  "|---|---|",
  "| Never коммитить `secrets.env` | 3 |",
  "",
].join("\n");

// The governing invariant: every physical line of every parsed file is counted
// exactly once, as instruction, content, ignored, excluded, or unsupported.
function assertLossless(scanData) {
  assert.equal(scanData.sources.length, scanData.files.length);
  scanData.sources.forEach((source, i) => {
    assert.equal(source.path, scanData.files[i].path);
    assert.equal(source.lineCount, scanData.files[i].lineCount);
    assert.match(source.sourceHash, /^[0-9a-f]{40}$/);
    let total = 0;
    for (const [cls, count] of Object.entries(source.spans)) {
      assert.ok(Number.isInteger(count) && count >= 0, `${source.path}: ${cls} = ${count}`);
      total += count;
    }
    assert.equal(total, source.lineCount, `${source.path}: spans sum to ${total}, file has ${source.lineCount} lines`);
  });
}

test("the golden fixture is inventoried construct by construct", () => {
  const root = tmpProject({ "CLAUDE.md": GOLDEN, "docs/style.md": "x\n", "src/app.ts": "export {};" });
  const scanData = engine.scan(root);
  assertLossless(scanData);

  assert.deepEqual(scanData.sources[0].spans, {
    instruction: 4, content: 45, ignored: 3, excluded: 4, unsupported: 0,
  });
  assert.deepEqual(scanData.sources[0].unsupported, []);

  // the four graded rules: two list items, one table body cell, one line whose
  // inline comment was stripped — nothing recovered from a fence or a tag body
  assert.deepEqual(scanData.rules.map((r) => [r.lineStart, r.text]), [
    [20, "Use `const` for local bindings."],
    [21, "Never use `var` — use `let` instead."],
    [25, "Run `npm test` before pushing"],
    [47, "Validate request bodies with Zod."],
  ]);

  const classes = engine.stripMetadata(GOLDEN).classes;
  const at = (line) => classes[line - 1];
  assert.equal(at(31), "excluded", "a block comment");
  assert.equal(at(49), "ignored", "the assay-ignore span opener");
  assert.equal(at(50), "ignored", "narrative inside the span");
  assert.equal(at(54), "excluded", "a tag body");
  assert.equal(at(34), "content", "fenced code is content, never lost");
  assert.equal(at(25), "content", "a table row is content until scan marks its rule");
});

// [Foreman: 085] The same fixture, asserted line by line rather than in totals:
// a count can be right while two lines swapped classes. The table tiles the file
// exactly once — that tiling IS the inventory invariant, so it is checked before
// it is used.
const GOLDEN_INVENTORY = [
  [1, 19, "content"], //      frontmatter, ATX heading, setext heading, paragraph
  [20, 21, "instruction"], // the nested list, both levels
  [22, 24, "content"], //     blank, table header, separator
  [25, 25, "instruction"], // the table body cell
  [26, 30, "content"], //     quote, bare link, blanks
  [31, 31, "excluded"], //    a block comment the host never receives
  [32, 46, "content"], //     three fence styles and everything inside them
  [47, 47, "instruction"], // the rule whose inline comment was stripped
  [48, 48, "content"],
  [49, 51, "ignored"], //     the assay-ignore span, markers included
  [52, 52, "content"],
  [53, 55, "excluded"], //    a tag body
  [56, 56, "content"],
];

test("every line of the golden fixture is inventoried, one class each", () => {
  const lines = GOLDEN.split("\n");

  // the table covers every line exactly once, with no gap and no overlap
  const covered = new Array(lines.length).fill(0);
  for (const [from, to, cls] of GOLDEN_INVENTORY) {
    assert.ok(["instruction", "content", "ignored", "excluded", "unsupported"].includes(cls), cls);
    for (let n = from; n <= to; n++) covered[n - 1]++;
  }
  assert.deepEqual(covered, new Array(lines.length).fill(1), "the expected inventory is not a partition");

  const root = tmpProject({ "CLAUDE.md": GOLDEN, "docs/style.md": "x\n", "src/app.ts": "export {};" });
  const scanData = engine.scan(root);
  const classes = engine.stripMetadata(GOLDEN).classes;
  // instruction is the class scan assigns, not the parser: a table cell is
  // content until a rule is recovered from it
  const ruleLines = new Set();
  for (const r of scanData.rules) {
    for (let n = r.lineStart; n <= r.lineEnd; n++) ruleLines.add(n);
  }

  for (const [from, to, expected] of GOLDEN_INVENTORY) {
    for (let n = from; n <= to; n++) {
      const actual = ruleLines.has(n) ? "instruction" : classes[n - 1];
      assert.equal(actual, expected, `line ${n} (${JSON.stringify(lines[n - 1])})`);
    }
  }
  assert.equal(classes.length, lines.length, "the parser lost or invented a line");
});

test("a rule's source range slices the file back to its own text", () => {
  const root = tmpProject({ "CLAUDE.md": GOLDEN, "docs/style.md": "x\n", "src/app.ts": "export {};" });
  const rules = engine.scan(root).rules;
  for (const r of rules) {
    assert.equal(r.sourceRange.startLine, r.lineStart);
    assert.equal(r.sourceRange.endLine, r.lineEnd);
    assert.equal(GOLDEN.slice(r.sourceRange.startOffset, r.sourceRange.endOffset), r.text, r.id);
  }
  // three exact ranges, columns included
  assert.deepEqual(rules[0].sourceRange, {
    startLine: 20, startCol: 2, endLine: 20, endCol: 33, startOffset: 277, endOffset: 308,
  });
  assert.deepEqual(rules[2].sourceRange, {
    startLine: 25, startCol: 2, endLine: 25, endCol: 31, startOffset: 378, endOffset: 407,
  });
  // the inline comment is gone from the text but the range still lands on the
  // rule itself, not on the comment after it
  assert.deepEqual(rules[3].sourceRange, {
    startLine: 47, startCol: 2, endLine: 47, endCol: 35, startOffset: 653, endOffset: 686,
  });

  // a rule assembled from two lines spans both of them in full — its analysis
  // text joins the lines with a space, so the slice is the source, bullet
  // marker included, not that joined string
  const multi = "- Use Vitest for all tests\n  placed next to the source file.\n";
  const multiRoot = tmpProject({ "CLAUDE.md": multi });
  const [joined] = engine.scan(multiRoot).rules;
  assert.equal(joined.sourceRange.startLine, 1);
  assert.equal(joined.sourceRange.endLine, 2);
  assert.equal(multi.slice(joined.sourceRange.startOffset, joined.sourceRange.endOffset),
    "- Use Vitest for all tests\n  placed next to the source file.");
});

test("real YAML reads every frontmatter form", () => {
  const fm = engine.parseFrontmatter(GOLDEN);
  assert.equal(fm.name, "golden");
  assert.equal(fm["default-category"], "mandate");
  assert.deepEqual(fm.paths, ["docs/**/*.md", "src/**"]);
  assert.deepEqual(fm.tags, ["alpha", "beta"]);
  assert.equal(fm.summary, "A folded scalar that wraps across two lines.");

  // literal blocks, quoted scalars carrying colons, numbers and booleans
  const block = engine.parseFrontmatter([
    "---",
    "description: \"Use when: the user asks, e.g. 'grade my rules'\"",
    "notes: |-",
    "  first line",
    "  second line",
    "disable-model-invocation: true",
    "user-invocable: false",
    "limit: 42",
    "---",
  ].join("\n"));
  assert.equal(block.description, "Use when: the user asks, e.g. 'grade my rules'");
  assert.equal(block.notes, "first line\nsecond line");
  assert.equal(block["disable-model-invocation"], "true");
  assert.equal(block["user-invocable"], "false");
  assert.equal(block.limit, "42");

  // a flow sequence wrapped across lines used to come back as the literal "[",
  // which made every rule in the file score as a dead glob
  const wrapped = engine.parseFrontmatter("---\npaths: [\n  \"src/**\",\n  \"test/**\"\n]\n---\n");
  assert.deepEqual(wrapped.paths, ["src/**", "test/**"]);
});

test("malformed frontmatter is inventoried as unsupported, and the file is still graded", () => {
  const broken = ["---", "description: Use when: the user asks", "---", "", "- Run the tests before every commit.", ""].join("\n");
  const root = tmpProject({ "CLAUDE.md": broken });

  // nothing throws, and the metadata is empty rather than guessed at
  assert.deepEqual(engine.parseFrontmatter(broken), {});
  const scanData = engine.scan(root);
  assertLossless(scanData);
  assert.equal(scanData.rules.length, 1);
  assert.equal(scanData.rules[0].text, "Run the tests before every commit.");

  const [source] = scanData.sources;
  assert.equal(source.unsupported.length, 1);
  assert.match(source.unsupported[0].reason, /^malformed frontmatter: /);
  assert.deepEqual([source.unsupported[0].startLine, source.unsupported[0].endLine], [1, 3]);
  assert.equal(source.spans.unsupported, 3);

  const report = engine.renderReport(engine.composeAudit(scanData, {
    [scanData.rules[0].key]: { F3: 0.7, F8: 0.9 },
  }));
  assert.match(report, /- 1 unsupported construct\(s\) — inventoried, not graded/);
});

test("an unclosed fence and an unclosed comment are named, not silently swallowed", () => {
  const fence = engine.stripMetadata("- Run the tests.\n\n```js\nconst x = 1;\n");
  assert.equal(fence.unsupported.length, 1);
  assert.match(fence.unsupported[0].reason, /unclosed code fence/);
  assert.deepEqual([fence.unsupported[0].startLine, fence.unsupported[0].endLine], [3, 4]);

  const comment = engine.stripMetadata("- Run the tests.\n\n<!-- a note that never closes\nmore\n");
  assert.equal(comment.unsupported.length, 1);
  assert.match(comment.unsupported[0].reason, /unclosed HTML comment/);
  assert.equal(comment.unsupported[0].startLine, 3);

  // [Foreman: 097] A one-level nested map is read as `key.subkey`, not reported
  // as a construct the parser gave up on — a file that declares its own kind in
  // `metadata: { node_type: … }` used to be flagged for the block that answers
  // the question.
  const flat = engine.stripMetadata("---\nname: x\nmetadata:\n  node_type: memory\n---\n\n- Run the tests.\n");
  assert.deepEqual(flat.unsupported, []);
  assert.equal(engine.parseFrontmatter("---\nmetadata:\n  node_type: memory\n---\n")["metadata.node_type"], "memory");

  // deeper than one level still has no faithful flat form, and is still named
  const nested = engine.stripMetadata("---\nname: x\nhooks:\n  pre:\n    run: true\n---\n\n- Run the tests.\n");
  assert.equal(nested.unsupported.length, 1);
  assert.match(nested.unsupported[0].reason, /`hooks` holds a nested map/);
});

test("every line of every fixture lands in exactly one class", () => {
  const projects = [
    { "CLAUDE.md": GOLDEN, "docs/style.md": "x\n", "src/app.ts": "export {};" },
    { "CLAUDE.md": MIXED_LANGUAGE },
    FIXTURE,
    { "CLAUDE.md": FIXTURE_CLAUDE },
    { "CLAUDE.md": "", ".claude/rules/empty.md": "" },
    { "CLAUDE.md": "- Never commit a secret.\n\n<!-- assay-ignore-start -->\n- narrative\n" },
  ];
  for (const files of projects) {
    assertLossless(engine.scan(tmpProject(files)));
  }
});

// Deterministic mangling: a fixed seed sequence over a fixed transformation
// table, so the same 50 broken files are produced on every run.
function mangle(source, seed) {
  let state = seed >>> 0 || 1;
  const rand = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const kinds = [
    (l) => l.slice(0, Math.floor(l.length / 2)),
    (l) => l.replace(/-->/g, ""),
    (l) => l.replace(/```/g, "``"),
    (l) => l.replace(/~~~/g, "~"),
    (l) => l.replace(/\|/g, ""),
    (l) => l + " |",
    (l) => "\t" + l,
    (l) => l + " ",
    (l) => l.replace(/:/g, ": : "),
    () => "---",
    () => "",
    (l) => l.repeat(3),
  ];
  const lines = source.split("\n");
  const edits = 1 + Math.floor(rand() * 4);
  for (let n = 0; n < edits; n++) {
    const line = Math.floor(rand() * lines.length);
    lines[line] = kinds[Math.floor(rand() * kinds.length)](lines[line]);
  }
  return lines.join("\n");
}

test("a mangled fixture never throws and never loses a line", () => {
  const root = tmpProject({ "CLAUDE.md": GOLDEN });
  const target = path.join(root, "CLAUDE.md");
  for (let seed = 1; seed <= 50; seed++) {
    const broken = mangle(GOLDEN, seed);
    fs.writeFileSync(target, broken);
    let scanData;
    assert.doesNotThrow(() => { scanData = engine.scan(root); }, "seed " + seed);
    assertLossless(scanData);
    assert.equal(scanData.sources[0].lineCount, broken.split("\n").length, "seed " + seed);
  }
});

// [Foreman: 085] A property test over generated corpora, not one hand-written
// file. The generator is a plain LCG on a FIXED literal seed, so the same 200
// files are produced on this machine, on CI, and next year — a fuzz test whose
// failures cannot be reproduced is a rumour, not a test.
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const LINE_SHAPES = [
  () => "- Always run `npm test` before committing.",
  () => "  - Never use `var` — use `const` instead.",
  () => "1. Validate every request body at the handler boundary.",
  () => "* Use `const` for local bindings.",
  () => "> Quoted context, still inventoried.",
  () => "# A heading",
  () => "Setext heading",
  () => "--------------",
  () => "| Do | Don't |",
  () => "|---|---|",
  () => "| Run `npm test` | Never use `var` |",
  () => "This paragraph is background for the reader, not a rule.",
  () => "```js",
  () => "const x = 1;",
  () => "```",
  () => "<!-- a comment -->",
  () => "<!-- assay-ignore-start -->",
  () => "<!-- assay-ignore-end -->",
  () => "<example>",
  () => "</example>",
  () => "- Follow [the guide](docs/guide.md) when editing handlers.",
  () => "",
  () => "---",
];

test("generated rule-ish files keep every line in exactly one class", () => {
  const rand = lcg(20260728);
  const root = tmpProject({ "CLAUDE.md": "" });
  const target = path.join(root, "CLAUDE.md");
  for (let n = 0; n < 200; n++) {
    const lineCount = 1 + Math.floor(rand() * 40);
    const lines = [];
    for (let i = 0; i < lineCount; i++) lines.push(LINE_SHAPES[Math.floor(rand() * LINE_SHAPES.length)]());
    const generated = lines.join("\n");
    fs.writeFileSync(target, generated);

    let scanData;
    assert.doesNotThrow(() => { scanData = engine.scan(root); }, "case " + n + ":\n" + generated);
    assertLossless(scanData);
    assert.equal(scanData.sources[0].lineCount, generated.split("\n").length, "case " + n);
    // and every recovered rule still points at real lines of the file it came from
    for (const r of scanData.rules) {
      assert.ok(r.lineStart >= 1 && r.lineEnd <= scanData.sources[0].lineCount, "case " + n + ": " + r.id);
    }
  }
});

// [Foreman: 085] Two languages in ONE file: the mode is a property of each rule,
// not of the file it sits in, and the inventory has to survive the split.
test("an English and Spanish file splits by mode and still loses no line", () => {
  const mixed = [
    "# House rules",
    "",
    "- Never use `var` — use `const` instead.",
    "- Antes de hacer commit, ejecuta las pruebas y revisa el archivo de configuracion.",
    "- Always run `npm test` before committing.",
    "- Nunca uses variables globales; usa el contenedor de dependencias para cada modulo.",
    "",
  ].join("\n");
  const scanData = engine.scan(tmpProject({ "CLAUDE.md": mixed }));
  assertLossless(scanData);

  // the split is per rule, in one file, and neither side is dropped
  assert.deepEqual(scanData.rules.map((r) => r.languageMode),
    ["english", "latin-unsupported:es", "english", "latin-unsupported:es"]);
  assert.equal(scanData.sources[0].spans.instruction, 4);

  const audit = engine.composeAudit(scanData, null);
  const spanish = audit.rules.filter((r) => r.languageMode === "latin-unsupported:es");
  assert.equal(spanish.length, 2);
  for (const r of spanish) assert.equal(r.score, null, "a set-aside rule kept a wording score");
  assert.equal(findingsOfType(audit, "unsupported-language").length, 2);
  // the English half is graded exactly as it would be on its own
  const englishOnly = auditOf({
    "CLAUDE.md": ["# House rules", "", "- Never use `var` — use `const` instead.",
      "- Always run `npm test` before committing.", ""].join("\n"),
  }, () => ({}));
  assert.deepEqual(
    audit.rules.filter((r) => r.languageMode === "english").map((r) => r.grade),
    englishOnly.rules.map((r) => r.grade)
  );
});

test("non-Latin rules stay inventoried and flagged, table cells included", () => {
  const root = tmpProject({ "CLAUDE.md": MIXED_LANGUAGE });
  const scanData = engine.scan(root);
  assertLossless(scanData);

  const texts = scanData.rules.map((r) => r.text);
  // the Cyrillic bullet, the CJK bullet, and the mixed-script table cell
  assert.ok(texts.includes("Перед commit запустите тесты."));
  assert.ok(texts.includes("コードレビューを必ず実行する。"));
  assert.ok(texts.includes("Never коммитить `secrets.env`"), "a non-Latin table cell vanished");
  assert.ok(scanData.rules.every((r) => r.languageMode === "non-latin-script"));
  // the letter-free cell is layout, not a lost rule
  assert.ok(!texts.includes("3"));
});

test("setext headings and pipe-less tables are recognized", () => {
  // [Foreman: 073] Both are CommonMark/GFM constructs the line scanner missed:
  // a setext heading read as a paragraph plus a horizontal rule, and a table
  // with no leading pipe read as three paragraphs.
  const setext = engine.stripMetadata("Error handling\n==============\n\n- All API failures through `handleError`.\n");
  const merged = engine.mergeClarifications(engine.identifyChunks(setext.lines));
  assert.equal(merged.length, 1);
  assert.match(merged[0][0].text, /^Error handling: /);

  const table = engine.stripMetadata("Do | Don't\n--- | ---\nUse `const` | Never use `var`\n");
  assert.deepEqual(table.lines.filter((l) => l.isContent).map((l) => l.text), ["Use `const`", "Never use `var`"]);
});

// ---------------------------------------------------------------------------
// Host adapter — [Foreman: 074]
// ---------------------------------------------------------------------------

const adapter = engine.adapter;

// A user directory of its own, so these tests are not reading EMPTY_USER_DIR.
function tmpUserDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assay-user-"));
  for (const [rel, content] of Object.entries(files || {})) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test("detectContext fixes the context from overrides and never probes the host by default", () => {
  const root = tmpProject({ "CLAUDE.md": "# rules\n" });
  const userDir = tmpUserDir({});

  const ctx = adapter.detectContext({ root, userDir });
  assert.equal(ctx.projectRoot, path.resolve(root));
  assert.equal(ctx.startupDirectory, ctx.projectRoot);
  assert.equal(ctx.userDir, path.resolve(userDir));
  assert.equal(ctx.hostVersion, null, "probeHost defaults off");

  // --project-only drops user scope entirely, even with an explicit userDir
  assert.equal(adapter.detectContext({ root, userDir, projectOnly: true }).userDir, null);
  // ASSAY_USER_DIR is the fallback when no explicit dir is passed
  assert.equal(adapter.detectContext({ root }).userDir, path.resolve(process.env.ASSAY_USER_DIR));
});

// ---------------------------------------------------------------------------
// Auto memory — [ADR 2026-08-05 B1/B2/B6]
// ---------------------------------------------------------------------------

// The host derives the memory directory from the project path with the observed
// dash encoding; the adapter and this fixture must agree on it, so it is the one
// place the test replicates the rule.
function writeAutoMemory(userDir, root, files) {
  const slug = path.resolve(root).replace(/[\\/:]/g, "-");
  const dir = path.join(userDir, "projects", slug, "memory");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test("auto memory is discovered as an always-loaded user surface, topic files on demand", () => {
  const root = tmpProject({ "CLAUDE.md": "- Use `const`.\n" });
  const userDir = tmpUserDir({});
  writeAutoMemory(userDir, root, {
    "MEMORY.md": "# Memory index\n\n- Always run `npm test` before committing.\n",
    "debugging.md": "# Debugging\n\n- The API tests need a local Redis.\n",
  });
  const { sources } = adapter.discoverSources(adapter.detectContext({ root, userDir }));
  const index = sources.find((s) => s.path.endsWith("MEMORY.md"));
  assert.ok(index, "MEMORY.md was not discovered");
  assert.equal(index.scope, "user");
  assert.equal(index.kind, "memory");
  assert.equal(index.autoMemory, true);
  assert.equal(index.alwaysLoaded, true);
  assert.equal(index.docCap.lines, 200);
  const topic = sources.find((s) => s.path.endsWith("debugging.md"));
  assert.ok(topic, "the topic file was not discovered");
  assert.equal(topic.alwaysLoaded, false, "a topic file must not count as always-loaded");
  // --project-only drops it with the rest of user scope
  const projectOnly = adapter.discoverSources(adapter.detectContext({ root, userDir, projectOnly: true })).sources;
  assert.equal(projectOnly.some((s) => s.autoMemory), false);
});

test("auto memory switched off is emitted not-loaded, never a false always-loaded claim", () => {
  const root = tmpProject({
    "CLAUDE.md": "- Use `const`.\n",
    ".claude/settings.json": JSON.stringify({ autoMemoryEnabled: false }),
  });
  const userDir = tmpUserDir({});
  writeAutoMemory(userDir, root, { "MEMORY.md": "- Always run `npm test` before committing.\n" });
  const { sources } = adapter.discoverSources(adapter.detectContext({ root, userDir }));
  const index = sources.find((s) => s.autoMemory);
  assert.ok(index);
  assert.equal(index.alwaysLoaded, false);
  assert.equal(index.selected, false);

  // and the environment off-switch reaches the same state
  const prev = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  try {
    const on = tmpProject({ "CLAUDE.md": "- Use `const`.\n" });
    const onUser = tmpUserDir({});
    writeAutoMemory(onUser, on, { "MEMORY.md": "- Always run `npm test`.\n" });
    const s = adapter.discoverSources(adapter.detectContext({ root: on, userDir: onUser })).sources.find((x) => x.autoMemory);
    assert.equal(s.alwaysLoaded, false);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
    else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = prev;
  }
});

test("a rule past the documented MEMORY.md read cap is inactive, definitively unread", () => {
  const root = tmpProject({ "CLAUDE.md": "- Use `const`.\n" });
  const userDir = tmpUserDir({});
  const filler = Array.from({ length: 205 }, (_, i) => "- memory note number " + i + ".").join("\n");
  writeAutoMemory(userDir, root, {
    "MEMORY.md": filler + "\n- Always run `npm test` before committing.\n",
  });
  const audit = engine.composeAudit(engine.scan(root, { userDir }), {});
  const memFile = audit.files.find((f) => f.path.endsWith("MEMORY.md"));
  assert.equal(memFile.docCapLine, 200);
  const capped = audit.findings.find((f) => f.analyzer === "memory-index-cap" && f.state === "inactive");
  assert.ok(capped, "no memory-index-cap finding fired");
  assert.equal(capped.evidence.level, "documented");
  assert.ok(capped.sources[0].lineStart > 200, "the cap finding points before the boundary");
});

test("the MEMORY.md cap measures only the content that loads: frontmatter and comments are stripped", () => {
  const root = tmpProject({ "CLAUDE.md": "- Use `const`.\n" });
  const userDir = tmpUserDir({});
  const bigComment = ["<!--", ...Array.from({ length: 250 }, (_, i) => "note " + i), "-->"].join("\n");
  writeAutoMemory(userDir, root, {
    // frontmatter + a 250-line block comment push the raw line count past 200,
    // but the measured content is a handful of lines, so nothing is past the cap
    "MEMORY.md": "---\nmodified: 2026-08-05\n---\n\n" + bigComment + "\n\n- Always run `npm test` before committing.\n",
  });
  const audit = engine.composeAudit(engine.scan(root, { userDir }), {});
  const memFile = audit.files.find((f) => f.path.endsWith("MEMORY.md"));
  assert.equal("docCapLine" in memFile, false, "the cap fired even though the loaded content fits");
  assert.equal(audit.findings.some((f) => f.analyzer === "memory-index-cap"), false);
});

test("a duplicate across a project rule and an auto-memory note keeps the checked-in project copy", () => {
  const rule = "- Always run `npm test` before committing.";
  const root = tmpProject({ "CLAUDE.md": "# Rules\n\n" + rule + "\n" });
  const userDir = tmpUserDir({});
  writeAutoMemory(userDir, root, { "MEMORY.md": "# Memory\n\n" + rule + "\n" });
  const audit = engine.composeAudit(engine.scan(root, { userDir }), {});
  const dup = audit.findings.find((f) => f.type === "duplicate");
  assert.ok(dup, "the cross-scope duplicate was not detected");
  assert.equal(dup.keepWhy, "the checked-in project copy");
  assert.equal(dup.keep.path, "CLAUDE.md");
});

test("discoverSources returns the documented Claude surface in load order with precedence", () => {
  const root = tmpProject({
    "CLAUDE.md": "- Use `const`.\n",
    "CLAUDE.local.md": "- Use the staging URL.\n",
    ".claude/rules/style.md": "- Keep lines short.\n",
    ".claude/rules/api/errors.md": '---\npaths: ["src/**"]\n---\n\n- Return typed errors.\n',
  });
  const userDir = tmpUserDir({ "CLAUDE.md": "- Prefer pnpm.\n" });
  const { sources, inaccessible } = adapter.discoverSources(adapter.detectContext({ root, userDir }));

  assert.deepEqual(inaccessible, []);
  assert.deepEqual(sources.map((s) => s.path), [
    path.join(userDir, "CLAUDE.md"),
    "CLAUDE.md",
    "CLAUDE.local.md",
    ".claude/rules/api/errors.md",
    ".claude/rules/style.md",
  ]);
  assert.deepEqual(sources.map((s) => s.scope), ["user", "project", "project", "project", "project"]);
  assert.deepEqual(sources.map((s) => s.kind), ["memory", "memory", "memory", "rules", "rules"]);
  // user memory is read first and outranked by everything in the project
  assert.deepEqual(sources.map((s) => s.precedence), [1, 3, 4, 3, 3]);
  assert.ok(sources.every((s) => typeof s.selectionReason === "string" && s.selectionReason));

  // the same-level choice between ./CLAUDE.md and ./.claude/CLAUDE.md says which won
  const alt = adapter.discoverSources(adapter.detectContext({
    root: tmpProject({ ".claude/CLAUDE.md": "- Use `const`.\n" }), projectOnly: true,
  }));
  assert.equal(alt.sources[0].path, ".claude/CLAUDE.md");
  assert.match(alt.sources[0].selectionReason, /\.\/CLAUDE\.md absent/);
});

test("loadsAlways asks the declared scope, not the filename", () => {
  const memory = { kind: "memory", alwaysLoaded: true };
  const rules = { kind: "rules", alwaysLoaded: false };
  assert.equal(adapter.loadsAlways(memory, []), true);
  assert.equal(adapter.loadsAlways(rules, []), true, "an unscoped rules file loads every session");
  assert.equal(adapter.loadsAlways(rules, ["src/**"]), false);
});

test("a user memory file that cannot be read becomes a coverage gap, not a throw", () => {
  const userDir = tmpUserDir({});
  // a directory where the user CLAUDE.md should be: discovered, then unreadable
  fs.mkdirSync(path.join(userDir, "CLAUDE.md"));
  const root = tmpProject({ "CLAUDE.md": "- Use `const`.\n" });

  const scanData = engine.scan(root, { userDir });
  assert.equal(scanData.coverage.filesParsed, 1);
  assert.equal(scanData.coverage.inaccessible.length, 1);
  assert.equal(scanData.coverage.inaccessible[0].path, path.join(userDir, "CLAUDE.md"));
  assert.ok(scanData.coverage.inaccessible[0].reason);
  assert.equal(scanData.coverage.userFilesIncluded, false);
});

test("user skills are inventoried; project subagent descriptions are graded", () => {
  const root = tmpProject({
    "CLAUDE.md": "- Use `const`.\n",
    ".claude/agents/reviewer.md": "---\nname: reviewer\n---\n",
    ".claude/skills/audit/SKILL.md": "---\nname: audit\ndescription: Use when the user asks to audit `CLAUDE.md`. Do NOT use for code review.\n---\n",
  });
  const userDir = tmpUserDir({
    "skills/mine/SKILL.md": "---\nname: mine\ndescription: personal helper\n---\n",
    "skills/bare/SKILL.md": "---\nname: bare\n---\n",
  });

  const scanData = engine.scan(root, { userDir });
  assert.equal(scanData.skills.length, 1, "only project skills are graded");
  assert.equal(scanData.skills[0].name, "audit");
  assert.deepEqual(scanData.coverage.userSkills, [
    { name: "bare", hasDescription: false },
    { name: "mine", hasDescription: true },
  ]);
  // [Foreman: 091] Subagent descriptions are graded on the skill trigger
  // recipe; this one has no description at all, which is the first finding.
  assert.deepEqual(scanData.coverage.agents.map((a) => a.name), ["reviewer"]);
  assert.deepEqual(scanData.coverage.agents[0].checks.missing, ["description"]);

  const report = engine.renderReport(engine.composeAudit(scanData, judgeEvery(scanData)));
  assert.match(report, /2 user skill\(s\) present — not graded/);
  assert.match(report, /1 subagent\(s\) defined in `\.claude\/agents\/`/);
});

// judgments for every rule in a scan, so a report can be rendered from it
function judgeEvery(scanData, j = { F3: 0.7, F8: 0.9 }) {
  const judgments = {};
  for (const r of scanData.rules) judgments[r.key] = { ...j };
  return judgments;
}

test("user rules are graded in their own section and never move the project grade", () => {
  const project = { "CLAUDE.md": FIXTURE_CLAUDE };
  const userDir = tmpUserDir({ "CLAUDE.md": "# Mine\n\n- Write good code.\n- Be careful.\n" });

  const withUser = engine.scan(tmpProject(project), { userDir });
  const withoutUser = engine.scan(tmpProject(project), { projectOnly: true });
  const auditWith = engine.composeAudit(withUser, judgeEvery(withUser));
  const auditWithout = engine.composeAudit(withoutUser, judgeEvery(withoutUser));

  // the user file's rules ARE graded
  assert.ok(withUser.rules.length > withoutUser.rules.length);
  assert.equal(auditWith.files.filter((f) => f.scope === "user").length, 1);
  assert.ok(auditWith.files.find((f) => f.scope === "user").grade);
  // and the project grade is untouched by them
  assert.equal(auditWith.corpusScore, auditWithout.corpusScore);
  assert.equal(auditWith.corpusGrade, auditWithout.corpusGrade);

  const report = engine.renderReport(auditWith);
  assert.match(report, /## User scope/);
  assert.match(report, /never move the project grade/);
  // the user file is out of the project Files table
  const filesTable = report.slice(report.indexOf("## Files"), report.indexOf("## User scope"));
  assert.doesNotMatch(filesTable, /Mine|assay-user-/);
  assert.doesNotMatch(engine.renderReport(auditWithout), /## User scope/);
});

test("--project-only keeps the audit inside the repo", () => {
  const userDir = tmpUserDir({ "CLAUDE.md": "# Mine\n\n- Write good code.\n" });
  const root = cliFixture();
  const env = { ...process.env, ASSAY_USER_DIR: userDir };
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf-8", env });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  assert.equal(run("scan", "--project-only").code, 0);
  const scoped = readJson(root, "scan.json");
  assert.equal(scoped.context.userDir, null);
  assert.equal(scoped.coverage.userFilesIncluded, false);
  assert.deepEqual(scoped.files.map((f) => f.path), ["CLAUDE.md"]);

  assert.equal(run("scan").code, 0);
  const wide = readJson(root, "scan.json");
  assert.equal(wide.context.userDir, path.resolve(userDir));
  assert.equal(wide.coverage.userFilesIncluded, true);
  assert.deepEqual(wide.files.map((f) => f.scope), ["user", "project"]);

  // and the flag survives to the report, which groups what it graded
  const judgments = {};
  for (const r of wide.rules) judgments[r.key] = { F3: 0.7, F8: 0.9 };
  fs.writeFileSync(path.join(root, ".assay-tmp", "judgments.json"), JSON.stringify(judgments));
  assert.match(run("report", "--verbose").out, /## User scope/);

  assert.equal(cli(root, "scan", "--nope").code, 1);
});

// The seam itself: scan() must work against an adapter describing a surface
// this engine has never heard of. Nothing below the adapter may recognize a
// filename — if something did, "AGENTS.override.md" would grade as zero rules.
test("scan runs on a stub adapter describing a made-up host surface", () => {
  const root = tmpProject({ "AGENTS.override.md": "# House rules\n\n- Never use `var` — use `const` instead.\n" });
  const stub = {
    name: "made-up", profileVersion: 9,
    detectContext: ({ root: r }) => ({ projectRoot: path.resolve(r), startupDirectory: path.resolve(r), userDir: null, hostVersion: "1.2.3" }),
    discoverSources: (ctx) => ({
      sources: [{
        path: "AGENTS.override.md",
        absPath: path.join(ctx.projectRoot, "AGENTS.override.md"),
        scope: "project", kind: "memory", alwaysLoaded: true,
        precedence: 7, selectionReason: "override file wins at this level",
      }],
      inaccessible: [],
    }),
    loadsAlways: () => true,
    discoverSkills: () => ({ project: [], user: [] }),
    discoverAgents: () => [],
    discoverHooks: () => [],
  };

  const scanData = engine.scan(root, { adapter: stub });
  assert.equal(scanData.context.hostVersion, "1.2.3");
  assert.deepEqual(scanData.files.map((f) => f.path), ["AGENTS.override.md"]);
  assert.equal(scanData.sources[0].precedence, 7);
  assert.equal(scanData.sources[0].selectionReason, "override file wins at this level");
  assert.equal(scanData.rules.length, 1);
  assert.match(scanData.rules[0].text, /Never use `var`/);

  const report = engine.renderReport(engine.composeAudit(scanData, judgeEvery(scanData)));
  assert.match(report, /AGENTS\.override\.md/);
});

test("the adapter reports no documented byte budget and cites its sources", () => {
  assert.deepEqual(adapter.budgets(), { documented: null });
  const provenance = adapter.docs();
  assert.ok(provenance.length >= 4);
  for (const d of provenance) {
    assert.ok(d.claim && /^https:\/\//.test(d.url), d.claim);
    assert.match(d.verified, /^\d{4}-\d{2}-\d{2}$/);
  }
});

// ---------------------------------------------------------------------------
// Codex host profile — [Foreman: 079]
// ---------------------------------------------------------------------------

const codex = engine.ADAPTERS.codex;

// A Codex home of its own — a config.toml here is the host configuration the
// adapter reads, not an instruction source.
function tmpCodexHome(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assay-codex-"));
  for (const [rel, content] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function codexContext(root, extra) {
  return codex.detectContext({ root, projectOnly: true, codexHome: EMPTY_CODEX_HOME, ...extra });
}

// One rule per file, so a chain's shape is readable off the rule list.
const AGENTS_ROOT = "# House rules\n\n- Never use `var` — use `const` instead.\n";

test("AGENTS.override.md wins its directory, and the file it beat reports as shadowed", () => {
  const root = tmpProject({
    "AGENTS.override.md": "# Override\n\n- Always run `npm test` before committing.\n",
    "AGENTS.md": AGENTS_ROOT,
  });
  const { sources } = codex.discoverSources(codexContext(root));

  assert.deepEqual(sources.map((s) => s.path), ["AGENTS.override.md", "AGENTS.md"]);
  assert.equal(sources[0].alwaysLoaded, true);
  assert.equal(sources[0].selected, undefined, "the selected file carries no selection flag");
  assert.equal(sources[1].selected, false);
  assert.equal(sources[1].shadowedBy, "AGENTS.override.md");
  assert.equal(sources[1].alwaysLoaded, false);
  assert.match(sources[1].selectionReason, /`AGENTS\.override\.md` was selected here/);
  // the loser is not part of the byte accounting: the host never opens it
  assert.equal(sources[1].startsAtByte, undefined);

  // and its rules are reported, as shadowed rather than as live policy
  const audit = engine.composeAudit(engine.scan(root, { adapter: codex, projectOnly: true }), null);
  const shadowed = audit.findings.filter((f) => f.state === "shadowed");
  assert.equal(shadowed.length, 1);
  assert.match(shadowed[0].summary, /^`AGENTS\.md` is not the variant the host selected/);
  assert.deepEqual(audit.relationships.filter((r) => r.kind === "shadows").map((r) => r.between),
    [["AGENTS.override.md", "AGENTS.md"]]);
});

test("a configured fallback name is selected in configured order; an unconfigured one is never read", () => {
  const home = tmpCodexHome({ "config.toml": 'project_doc_fallback_filenames = ["TEAM_GUIDE.md", ".agents.md"]\n' });
  const files = {
    "TEAM_GUIDE.md": "- Use `const` for locals.\n",
    ".agents.md": "- Always run `npm test` before committing.\n",
    "HOUSE_RULES.md": "- Never use `var`.\n",
  };
  const root = tmpProject(files);
  const ctx = codexContext(root, { codexHome: home });
  assert.deepEqual(ctx.config.fallbackFilenames, ["TEAM_GUIDE.md", ".agents.md"]);
  assert.equal(ctx.config.fallbackFilenamesSource, "configured");

  const { sources } = codex.discoverSources(ctx);
  // configured order decides the winner, and HOUSE_RULES.md is not a candidate
  assert.deepEqual(sources.map((s) => s.path), ["TEAM_GUIDE.md", ".agents.md"]);
  assert.equal(sources[1].selected, false);

  // with no config the doc documents no default list, so no fallback is a
  // candidate at all — assay does not invent one
  const bare = codexContext(tmpProject(files));
  assert.deepEqual(bare.config.fallbackFilenames, []);
  assert.equal(bare.config.fallbackFilenamesSource, "default");
  assert.deepEqual(codex.discoverSources(bare).sources, []);
});

test("the chain runs from the project root down to the startup directory, later files outranking earlier", () => {
  const root = tmpProject({
    "AGENTS.md": AGENTS_ROOT,
    "svc/AGENTS.md": "# Service\n\n- Always run `npm test` before committing.\n",
    "svc/api/AGENTS.md": "# API\n\n- Return typed errors from every handler.\n",
    "other/AGENTS.md": "# Off the chain\n\n- Use two-space indentation.\n",
  });
  const startup = path.join(root, "svc", "api");
  const { sources } = codex.discoverSources(codexContext(root, { startup }));

  assert.deepEqual(sources.map((s) => s.path), ["AGENTS.md", "svc/AGENTS.md", "svc/api/AGENTS.md"]);
  // read order is emission order; precedence rises with it, so the file nearest
  // the startup directory is the later word
  assert.deepEqual(sources.map((s) => s.precedence), [2, 3, 4]);
  assert.match(sources[1].selectionReason, /chain position 2 of 3 \(`svc`\)/);
  // the byte accounting is cumulative in that same order
  let at = 0;
  for (const s of sources) {
    assert.equal(s.startsAtByte, at);
    assert.equal(s.loaded, true);
    at += s.bytes;
  }

  // a directory beside the chain is not discovered — that is what a chain means
  assert.equal(sources.some((s) => s.path.startsWith("other/")), false);
  // and equal endpoints are a chain of one
  assert.deepEqual(codex.discoverSources(codexContext(root)).sources.map((s) => s.path), ["AGENTS.md"]);

  // the resolved chain reaches the report, with each directory and why it won
  const audit = engine.composeAudit(engine.scan(root, { adapter: codex, projectOnly: true, startup }), null);
  const report = engine.renderReport(audit);
  const trace = report.slice(report.indexOf("## Instruction chain"), report.indexOf("## Operational findings"));
  for (const p of ["AGENTS.md", "svc/AGENTS.md", "svc/api/AGENTS.md"]) assert.ok(trace.includes(p), "chain is missing " + p);
  assert.match(trace, /chain position 3 of 3/);
  assert.match(trace, /Chain total \d+ bytes against a documented 32768-byte cap \(default\)/);
});

// A file big enough to move a small cap, with one rule per line so the
// truncation boundary lands between rules that can be named.
function agentsFile(label, lines) {
  return `# ${label}\n\n` + Array.from({ length: lines }, (_, i) =>
    `- Always run step ${i} of the ${label} checklist before committing.`).join("\n") + "\n";
}

test("the combined byte cap truncates the source it lands in and drops every source past it", () => {
  const home = tmpCodexHome({ "config.toml": "# codex\nproject_doc_max_bytes = 400\n" });
  const root = tmpProject({
    "AGENTS.md": agentsFile("root", 10),
    "svc/AGENTS.md": agentsFile("service", 10),
    "svc/api/AGENTS.md": "# API\n\n- Return typed errors from every handler.\n",
  });
  const startup = path.join(root, "svc", "api");
  const ctx = codexContext(root, { codexHome: home, startup });
  assert.equal(ctx.config.maxBytes, 400);
  assert.equal(ctx.config.maxBytesSource, "configured");
  assert.deepEqual(codex.budgets(ctx).documented.amount, 400);

  // `userDir` is the Codex home to this adapter — the engine passes one option
  // for "the host's own directory" and each profile says what lives in it.
  const scanData = engine.scan(root, { adapter: codex, projectOnly: true, startup, userDir: home });
  const [first, second, third] = scanData.files;
  // the cap is combined across the chain, so where it lands depends on what was
  // read before it: inside the first file, and past the two after it
  assert.equal(first.loaded, true);
  assert.equal(first.truncated, true);
  assert.equal(first.truncatedAtByte, 400);
  assert.ok(first.truncatedAtLine > 1 && first.truncatedAtLine < first.lineCount);
  assert.equal(second.loaded, false);
  assert.equal(second.alwaysLoaded, false, "a source past the cap never loads");
  assert.equal(third.loaded, false);

  const audit = engine.composeAudit(scanData, null);
  const truncation = audit.findings.find((f) => f.type === "budget-truncation");
  assert.match(truncation.summary, /the cap lands inside `AGENTS\.md`, at byte 400 of it \(line \d+\)/);
  assert.match(truncation.summary, /the chain is \d+ bytes, the cap is 400 \(configured\)/);
  assert.equal(truncation.evidence.level, "documented");

  const dropped = audit.findings.filter((f) => f.type === "budget-exceeded");
  assert.deepEqual(dropped.map((f) => f.sources[0].path), ["svc/AGENTS.md", "svc/api/AGENTS.md"]);
  assert.match(dropped[0].summary, /starts at byte \d+ of the instruction chain and is never read/);

  // a file that begins past the cap is never added under any reading of the doc,
  // so its rules are inactive — and only its rules are
  const byId = new Map(audit.rules.map((r) => [r.id, r]));
  const inactive = audit.findings.filter((f) => f.state === "inactive");
  assert.ok(inactive.length >= 2);
  assert.deepEqual([...new Set(inactive.map((f) => byId.get(f.rule).file))], ["svc/AGENTS.md", "svc/api/AGENTS.md"]);

  // the tail of the file the cap lands INSIDE is at-risk, not inactive: the doc
  // stops adding files at that point and does not say whether this one arrives
  // whole, so assay names the risk instead of claiming non-delivery
  const tail = audit.findings.filter((f) => f.state && f.analyzer === "byte-budget" &&
    byId.get(f.rule).file === "AGENTS.md");
  assert.ok(tail.length >= 1);
  for (const f of tail) {
    assert.equal(f.state, "at-risk");
    assert.ok(byId.get(f.rule).lineStart > first.truncatedAtLine, f.rule);
  }
  assert.match(tail[0].summary, /the host's documented cap lands at line \d+ of `AGENTS\.md`, above this rule/);
  assert.match(tail[0].explanation, /it does not say whether this file arrives whole or is cut at the boundary/);
  assert.match(tail[0].evidence.limits, /the fate of the crossing file's remainder is not/);
  assert.match(engine.renderReport(audit), /crosses the host's byte cap at byte 400/);
});

test("the cap defaults to 32768 with no config, and a malformed config falls back without throwing", () => {
  const root = tmpProject({ "AGENTS.md": AGENTS_ROOT });
  assert.equal(codexContext(root).config.maxBytes, 32768);
  assert.equal(codexContext(root).config.maxBytesSource, "default");
  assert.equal(codexContext(root).configIssue, null);
  assert.equal(codex.budgets().documented.amount, codex.DEFAULT_MAX_BYTES);

  const broken = tmpCodexHome({ "config.toml": 'project_doc_max_bytes = "lots"\nproject_doc_fallback_filenames = 3\n' });
  const ctx = codexContext(root, { codexHome: broken });
  assert.equal(ctx.config.maxBytes, 32768, "a value assay cannot read is not a value it guesses at");
  assert.deepEqual(ctx.config.fallbackFilenames, []);
  assert.match(ctx.configIssue.reason, /unreadable value for project_doc_max_bytes, project_doc_fallback_filenames/);

  // and the malformed file is a coverage gap the report names, not a crash
  const scanData = engine.scan(root, { adapter: codex, projectOnly: true, userDir: broken });
  assert.equal(scanData.coverage.inaccessible.length, 1);
  assert.match(engine.renderReport(engine.composeAudit(scanData, null)), /could not read `.*config\.toml`/);

  // [Foreman: 080] the reader is a real TOML parser now, so a table header no
  // longer ends the read — and a root key is still a root key
  assert.deepEqual(codex.parseToml('a = 1\n[hooks]\nb = 9\n'), { a: 1, hooks: { b: 9 } });
});

test("--host names the profile discovery runs under, and an unknown one is a usage error", () => {
  const root = tmpProject({ "AGENTS.md": AGENTS_ROOT });

  const unknown = cli(root, "scan", "--host", "gemini");
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /Unknown host: gemini — valid hosts are claude-code, codex\./);
  assert.match(unknown.err, /--host <claude-code\|codex>/);
  assert.equal(cli(root, "scan", "--host").code, 1, "--host needs a value");

  const scanned = cli(root, "scan", "--host", "codex");
  assert.equal(scanned.code, 0, scanned.err);
  const record = readJson(root, "scan.json");
  assert.equal(engine.validateRecord(record, "scan"), null);
  // [Foreman: 082] `targets` joined the declaration; its content is asserted in
  // the authoring section, so what this test still owns is that nothing ELSE
  // rides the profile block.
  const { targets, ...profile } = record.profile;
  assert.deepEqual(profile, {
    host: "codex", version: 2,
    policy: { wordingRubric: false, skillRecipe: false },
    // [ADR 2026-08-05 D3] doctorRemedy is nulled so the file-shape finding never
    // offers a `/doctor` Codex has no equivalent of.
    nouns: { primitive: "Codex primitive", scopedRules: "narrower `AGENTS.md` files further down the chain", doctorRemedy: null },
  });
  assert.equal(targets.skill.dir, ".agents/skills/<name>/");
  assert.deepEqual(record.files.map((f) => f.path), ["AGENTS.md"]);
  assert.equal(record.coverage.budget.amount, 32768);
  assert.equal(record.coverage.skillBudget.amount, 8000);
  assert.ok(record.coverage.profileNotes.some((n) => /no live Codex host was probed/.test(n)));

  // [Foreman: 097] `report` composes from the record, which already names the
  // profile — so it reads the host off the scan and REFUSES the flag rather than
  // accepting a label it would never honor.
  const reported = cli(root, "report", "--verbose");
  assert.equal(reported.code, 0, reported.err);
  assert.match(reported.out, /codex profile · schema 1/);

  const misplaced = cli(root, "report", "--host", "codex");
  assert.equal(misplaced.code, 1);
  assert.match(misplaced.err, /--host belongs to the commands that scan/);
});

test("no --host is the Claude profile, and the record it writes is the one it always wrote", () => {
  const root = cliFixture();
  assert.equal(cli(root, "scan").code, 0);
  const implicit = readJson(root, "scan.json");
  assert.equal(cli(root, "scan", "--host", "claude-code").code, 0);
  const explicit = readJson(root, "scan.json");

  // the profile that declares no policy adds no policy key: same envelope, same
  // context, same coverage as before the registry existed. [Foreman: 082]
  // `targets` is declared by every profile and is checked separately.
  const { targets, ...profile } = implicit.profile;
  assert.deepEqual(profile, { host: "claude-code", version: 3 });
  assert.equal(targets.rule.places[0].path, "CLAUDE.md");
  assert.deepEqual(Object.keys(implicit.context), ["projectRoot", "startupDirectory", "userDir", "projectOnly", "ancestorStop", "hostVersion", "analysisTime"]);
  assert.equal("budget" in implicit.coverage, false);
  // [ADR 2026-08-05 B5] the Claude adapter now discloses residual coverage
  // [Foreman: 097] Gated on the surface existing: this fixture has no auto memory
  // and no saved workflows, so the profile has nothing to disclose about it.
  assert.equal("profileNotes" in implicit.coverage, false);
  assert.deepEqual(engine.ADAPTERS["claude-code"].coverageNotes({ sources: [{ autoMemory: true }] }).length, 3);
  assert.equal(implicit.files.some((f) => "startsAtByte" in f || "loaded" in f), false);

  for (const r of [implicit, explicit]) {
    delete r.context.analysisTime;
    delete r.context.hostVersion;
  }
  assert.deepEqual(explicit, implicit, "--host claude-code is the default, spelled out");
});

// The rubric levers, live under the profile they were measured on and withdrawn
// under the one they were not. Same corpus text both times, so the difference is
// the profile and nothing else.
const RUBRIC_FIXTURE = [
  "# House rules",
  "",
  "- Try to prefer functional components where possible.",
  "- Never pin dependencies to exact versions in `package.json`.",
  "- Always pin dependencies to exact versions in `package.json`.",
  "- Never use `var`.",
  "- Read the notes in `docs/gone.md` before starting.",
  "- Only `snake_case` for column names.",
  "",
]
  .concat(Array.from({ length: 50 }, (_, i) => "Background paragraph line " + i + " for padding.\n"))
  .concat(["- Always run `npm test` before committing.", ""]).join("\n");

test("the Claude wording rubric is not applied to a profile it was never measured on", () => {
  const codexAudit = engine.composeAudit(
    engine.scan(tmpProject({ "AGENTS.md": RUBRIC_FIXTURE }), { adapter: codex, projectOnly: true }), null);
  const claudeAudit = engine.composeAudit(
    engine.scan(tmpProject({ "CLAUDE.md": RUBRIC_FIXTURE }), { projectOnly: true }), null);

  // the levers are live on the profile that owns them — otherwise this test
  // would pass on a corpus the rubric never had anything to say about
  const claudeAnalyzers = new Set(claudeAudit.findings.filter((f) => f.state).map((f) => f.analyzer));
  for (const lever of ["verb-strength", "position"]) {
    assert.ok(claudeAnalyzers.has(lever), "the Claude profile stopped deriving " + lever);
  }
  assert.ok(claudeAudit.corpusGrade, "the Claude profile stopped grading");

  // and none of them reaches the Codex profile
  const states = codexAudit.findings.filter((f) => f.state);
  assert.deepEqual(states.filter((f) => f.analyzer === "position"), []);
  assert.deepEqual(states.filter((f) => f.analyzer === "trigger-distance"), []);
  assert.deepEqual(states.filter((f) => f.state === "ambiguous"), []);
  assert.deepEqual(states.filter((f) => f.state === "at-risk" && f.analyzer === "verb-strength"), []);
  assert.deepEqual(states.filter((f) => f.state === "advisory"), []);

  // no grade anywhere: not on the corpus, not on a file, not on a rule
  assert.equal(codexAudit.corpusScore, null);
  assert.equal(codexAudit.corpusGrade, null);
  assert.deepEqual(codexAudit.files.map((f) => f.grade), [null]);
  assert.deepEqual([...new Set(codexAudit.rules.map((r) => r.score))], [null]);

  // the host-neutral analyses all still run
  const byState = (s) => codexAudit.findings.filter((f) => f.state === s);
  assert.equal(byState("blocked").length, 1, "a stale reference is still a hard gate");
  assert.match(byState("blocked")[0].summary, /docs\/gone\.md/);
  assert.equal(byState("conflicting").length, 2, "both sides of the conflict pair");
  assert.equal(codexAudit.findings.filter((f) => f.type === "conflict").length, 1);
  const stall = byState("at-risk").filter((f) => f.analyzer === "framing-polarity");
  assert.equal(stall.length, 1, "a prohibition with no alternative is still named");
  assert.equal(stall[0].evidence.level, "heuristic", "the experiment's tier does not travel to a host it never covered");
  // an unreadable action is a maintainability item here, not a reliability state
  const clarity = codexAudit.findings.filter((f) => f.type === "action-clarity");
  assert.equal(clarity.length, 1);
  assert.equal(clarity[0].tier, "maintainability");

  const report = engine.renderReport(codexAudit, { verbose: true });
  assert.doesNotMatch(report, /corpus grade/);
  assert.doesNotMatch(report, /## All rules/);
  assert.match(report, /\*\*7 rules across 1 file\(s\)\*\* — no grade\./);
  // [Foreman: 097] Host-neutral: a Codex session is told to print this markdown
  // verbatim, so the sentence may not name the other host.
  assert.match(report, /The structural-hygiene rubric is measured on one host profile and carries no evidence for this one\./);
  assert.doesNotMatch(report, /experiment-supported/, "no Claude-tier evidence tag survives into a Codex report");
  // maintainability is reported apart from the reliability findings
  const maintainability = report.slice(report.indexOf("## Maintainability"), report.indexOf("## Policy placement"));
  assert.match(maintainability, /None of these is a reliability failure/);
  assert.match(maintainability, /no directive verb could be read out of it/);
  assert.match(maintainability, /### Restructure candidates/);
  assert.match(report, /## Instruction chain/);
});

test("two scans of one Codex project differ only in analysisTime", () => {
  const root = tmpProject({
    "AGENTS.override.md": "# Override\n\n- Always run `npm test` before committing.\n",
    "AGENTS.md": AGENTS_ROOT,
    "svc/AGENTS.md": "# Service\n\n- Return typed errors from every handler.\n",
  });
  const startup = path.join(root, "svc");
  const once = engine.makeRecord("scan", engine.scan(root, { adapter: codex, projectOnly: true, startup }), root);
  const twice = engine.makeRecord("scan", engine.scan(root, { adapter: codex, projectOnly: true, startup }), root);
  for (const r of [once, twice]) delete r.context.analysisTime;
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
});

test("the Codex adapter reports the documented cap and cites a source for every behavior it encodes", () => {
  const documented = codex.budgets().documented;
  assert.equal(documented.amount, 32768);
  assert.equal(documented.unit, "bytes");
  assert.match(documented.scope, /combined/);
  assert.match(documented.url, /^https:\/\/learn\.chatgpt\.com\//);

  const provenance = codex.docs();
  assert.ok(provenance.length >= 6);
  for (const d of provenance) {
    assert.ok(d.claim && /^https:\/\//.test(d.url), d.claim);
    assert.equal(d.verified, "2026-07-28");
  }
  // the profile declares what it does not cover, and the report prints it
  assert.ok(codex.coverageNotes().some((n) => /no live Codex host was probed/.test(n)));
  // and it never probes the host unless asked
  assert.equal(codexContext(tmpProject({})).hostVersion, null);
  // an empty project has nothing at any rung, and says so with the right shapes
  const bare = codexContext(tmpProject({}));
  assert.deepEqual(codex.discoverSkills(bare), { project: [], user: [] });
  assert.deepEqual(codex.discoverHooks(bare), { hooks: [], inaccessible: [] });
  assert.deepEqual(codex.discoverAgents(bare), []);
});

// ---------------------------------------------------------------------------
// Codex skills, hooks, trust, and packaging — [Foreman: 080]
// ---------------------------------------------------------------------------

// The documented skill shape: a directory holding a SKILL.md whose frontmatter
// carries the two required fields.
function skillMd(name, description) {
  return "---\n" +
    (name === null ? "" : `name: ${name}\n`) +
    (description === null ? "" : `description: ${description}\n`) +
    "---\n\nSteps for " + (name || "this skill") + ".\n";
}

test("`.agents/skills` is scanned along the chain, and one name at two levels stays two skills", () => {
  const root = tmpProject({
    "AGENTS.md": AGENTS_ROOT,
    ".agents/skills/deploy/SKILL.md": skillMd("deploy", "Ships the service. Use when the user asks to deploy."),
    ".agents/skills/lint/SKILL.md": skillMd("lint", "Runs the linters. Use when the user asks to lint."),
    "svc/AGENTS.md": "# Service\n\n- Return typed errors from every handler.\n",
    "svc/.agents/skills/deploy/SKILL.md": skillMd("deploy", "Ships this one service instead."),
    "other/.agents/skills/nope/SKILL.md": skillMd("nope", "Off the chain entirely."),
  });
  const startup = path.join(root, "svc");
  const found = codex.discoverSkills(codexContext(root, { startup }));

  // root-first along the chain, and a directory beside the chain is not scanned
  assert.deepEqual(found.project.map((s) => s.path), [
    ".agents/skills/deploy/SKILL.md",
    ".agents/skills/lint/SKILL.md",
    "svc/.agents/skills/deploy/SKILL.md",
  ]);
  assert.deepEqual(found.user, [], "--project-only leaves the machine-wide scopes alone");

  // the duplicate is a fact, not a merge: the doc says both stay listed
  const audit = engine.composeAudit(engine.scan(root, { adapter: codex, projectOnly: true, startup }), null);
  const collision = audit.findings.find((f) => f.type === "skill-name-collision");
  assert.match(collision.summary, /2 skills are named `deploy`/);
  assert.match(collision.summary, /`\.agents\/skills\/deploy\/SKILL\.md`, `svc\/\.agents\/skills\/deploy\/SKILL\.md`/);
  assert.equal(collision.evidence.level, "documented");
  assert.match(collision.explanation, /does not merge two skills that share a name/);
  assert.equal(collision.sources.length, 2);
  // and every discovered skill is a level-2 rung on the ladder
  assert.equal(audit.mechanisms.filter((m) => m.type === "skill").length, 3);
});

test("a Codex skill missing a required field is a finding; the Claude recipe never grades it", () => {
  const root = tmpProject({
    "AGENTS.md": AGENTS_ROOT,
    // no description at all
    ".agents/skills/bare/SKILL.md": skillMd("bare", null),
    // a description written as documentation, which the trigger recipe would
    // fail on three counts and this profile has nothing to say about
    ".agents/skills/plain/SKILL.md": skillMd("plain", "Handles the release paperwork."),
  });
  const scanData = engine.scan(root, { adapter: codex, projectOnly: true });
  assert.deepEqual(scanData.skills.map((s) => s.checks.mode), ["required-metadata", "required-metadata"]);
  assert.deepEqual(scanData.skills[0].checks.missing, ["description"]);
  assert.deepEqual(scanData.skills[1].checks.missing, []);

  const audit = engine.composeAudit(scanData, null);
  const missing = audit.findings.filter((f) => f.type === "skill-metadata");
  assert.equal(missing.length, 1);
  assert.match(missing[0].summary, /`\.agents\/skills\/bare\/SKILL\.md` declares no description — the host documents it as required/);
  assert.equal(missing[0].evidence.level, "documented");
  assert.equal(missing[0].severity, "high");
  assert.deepEqual(missing[0].sources, [{ path: ".agents/skills/bare/SKILL.md", lineStart: 1, lineEnd: 1 }]);

  const report = engine.renderReport(audit, { verbose: true });
  assert.match(report, /### Skills/);
  assert.match(report, /declares no description/);
  // none of the recipe's verdicts appears anywhere: no cap, no weak-skill table
  assert.doesNotMatch(report, /Weak skill descriptions/);
  assert.doesNotMatch(report, /\/1536/);
  assert.doesNotMatch(report, /trigger recipe/);
  for (const s of scanData.skills) {
    assert.equal("overCap" in s.checks, false, "no per-description cap is applied to a Codex skill");
    assert.equal("quotedPhrases" in s.checks, false);
    assert.equal("redundant" in s.checks, false);
  }
  // and the same description under the Claude profile IS recipe-graded, so the
  // difference above is the policy flag and not an empty corpus
  const claudeRoot = tmpProject({
    "CLAUDE.md": FIXTURE_CLAUDE,
    ".claude/skills/plain/SKILL.md": skillMd("plain", "Handles the release paperwork."),
  });
  const claude = engine.scan(claudeRoot, { projectOnly: true });
  assert.equal(claude.skills[0].checks.mode, "model");
  assert.ok(claude.skills[0].checks.missing.includes("trigger"));
});

test("agents/openai.yaml reaches the record, and a malformed one is reported rather than thrown", () => {
  const root = tmpProject({
    "AGENTS.md": AGENTS_ROOT,
    ".agents/skills/quiet/SKILL.md": skillMd("quiet", "Only ever run when named."),
    ".agents/skills/quiet/agents/openai.yaml": [
      "interface:",
      '  display_name: "Quiet Runner"',
      '  short_description: "Never routes itself"',
      "policy:",
      "  allow_implicit_invocation: false",
      "dependencies:",
      "  tools:",
      '    - type: "mcp"',
      '      value: "serverName"',
      "",
    ].join("\n"),
    ".agents/skills/broken/SKILL.md": skillMd("broken", "Has a sidecar that will not parse."),
    ".agents/skills/broken/agents/openai.yaml": 'interface:\n  display_name: "unterminated\n',
  });
  const scanData = engine.scan(root, { adapter: codex, projectOnly: true });
  const [broken, quiet] = scanData.skills;

  assert.equal(quiet.metadataPath, ".agents/skills/quiet/agents/openai.yaml");
  assert.deepEqual(quiet.metadata, {
    displayName: "Quiet Runner",
    shortDescription: "Never routes itself",
    allowImplicitInvocation: false,
    toolDependencies: [{ type: "mcp", value: "serverName" }],
  });
  // the sidecar that will not parse is named, never thrown, and the skill keeps
  // the documented default — implicit routing stays on
  assert.equal(broken.metadata, undefined);
  assert.ok(broken.metadataIssue);

  const audit = engine.composeAudit(scanData, null);
  const unreadable = audit.findings.find((f) => f.type === "skill-metadata-unreadable");
  assert.match(unreadable.summary, /`\.agents\/skills\/broken\/agents\/openai\.yaml` could not be parsed/);
  assert.equal(unreadable.evidence.level, "mechanical");

  // explicit invocation and implicit routing are told apart wherever the report
  // says how a skill fires
  const report = engine.renderReport(audit, { verbose: true });
  assert.match(report, /1 skill\(s\) set `allow_implicit_invocation: false` — `quiet`/);
  assert.match(report, /a session reaches them by naming them/);
  const quietMech = audit.mechanisms.find((m) => m.name === "quiet");
  assert.ok(quietMech.coverage.limits.some((l) => /implicit routing is switched off/.test(l)));
  const brokenMech = audit.mechanisms.find((m) => m.name === "broken");
  assert.ok(brokenMech.coverage.limits.some((l) => /invocation is probabilistic/.test(l)));
  // a sidecar assay can read is still not a sidecar assay ran
  assert.equal(quietMech.states.verified, false);
});

test("the collective skill listing budget is reported, and no Claude per-description cap is", () => {
  const files = { "AGENTS.md": AGENTS_ROOT };
  // eight skills, each with a description long enough that the list overruns the
  // documented 8,000-character budget together and none of them does alone
  for (let i = 0; i < 8; i++) {
    files[`.agents/skills/step-${i}/SKILL.md`] = skillMd(`step-${i}`, ">-\n  " + `Runs step ${i} of the release. `.repeat(45));
  }
  const root = tmpProject(files);
  const audit = engine.composeAudit(engine.scan(root, { adapter: codex, projectOnly: true }), null);

  const budget = audit.findings.find((f) => f.type === "skill-listing-budget");
  assert.match(budget.summary, /8 skills list for about \d+ characters against a documented 8000-character budget/);
  assert.match(budget.summary, /largest: `step-\d` \(\d+\)/);
  assert.match(budget.explanation, /descriptions are shortened first and skills can be dropped/);
  assert.equal(budget.evidence.level, "heuristic");
  assert.match(budget.evidence.limits, /the exact listing serialization is not/);
  // one finding for the whole list: the budget is one pool
  assert.equal(audit.findings.filter((f) => f.type === "skill-listing-budget").length, 1);
  // and every skill is under the Claude cap individually, so nothing here is
  // that cap firing under another name
  for (const s of audit.skills) assert.ok(s.listingChars < 1536, s.name);

  const report = engine.renderReport(audit);
  assert.match(report, /against a documented 8000-character budget/);
  assert.doesNotMatch(report, /Weak skill descriptions/);
});

// Every documented hook surface at once: a project hooks.json, an inline
// config.toml table in the same layer, a user-scope hooks.json, an enterprise
// requirements.toml, and a plugin bundle.
function hooksFixture(extra) {
  const home = tmpCodexHome({
    "hooks.json": JSON.stringify({
      hooks: { SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "python3 ~/.codex/hooks/session_start.py" }] }] },
    }),
    ...(extra || {}),
  });
  const root = tmpProject({
    "AGENTS.md": AGENTS_ROOT,
    ".codex/hooks.json": JSON.stringify({
      description: "Optional lifecycle hooks for this workspace.",
      hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "python3 .codex/hooks/format.py", timeout: 30 }] }] },
    }),
    ".codex/config.toml": [
      "[[hooks.PreToolUse]]",
      'matcher = "^Bash$"',
      "",
      "[[hooks.PreToolUse.hooks]]",
      'type = "command"',
      "command = '/usr/bin/python3 .codex/hooks/pre_tool_use_policy.py'",
      "timeout = 30",
      'statusMessage = "Checking Bash command"',
      "",
    ].join("\n"),
    ".codex-plugin/plugin.json": JSON.stringify({ name: "repo-policy", version: "1.0.0", description: "x", hooks: "./hooks/hooks.json" }),
    "hooks/hooks.json": JSON.stringify({
      hooks: { PreCompact: [{ matcher: "auto", hooks: [{ type: "command", command: "node hooks/save_notes.js" }] }] },
    }),
  });
  return { root, home };
}

test("every hook source is retained side by side — no layer replaces another", () => {
  const { root, home } = hooksFixture({
    "requirements.toml": [
      "[features]",
      "hooks = true",
      "",
      "[[hooks.PreToolUse]]",
      'matcher = "^Bash$"',
      "",
      "[[hooks.PreToolUse.hooks]]",
      'type = "command"',
      'command = "python3 /enterprise/hooks/pre_tool_use_policy.py"',
      "timeout = 30",
      "",
    ].join("\n"),
  });
  const { hooks, inaccessible } = codex.discoverHooks(codexContext(root, { codexHome: home }));
  assert.deepEqual(inaccessible, []);

  // one entry per definition, from all five surfaces, in documented load order
  assert.deepEqual(hooks.map((h) => [h.source, h.event, h.command]), [
    ["user", "SessionStart", "session_start.py"],
    ["project", "PostToolUse", "format.py"],
    ["project", "PreToolUse", "pre_tool_use_policy.py"],
    ["managed", "PreToolUse", "pre_tool_use_policy.py"],
    ["plugin: repo-policy", "PreCompact", "save_notes.js"],
  ]);
  // the project layer configures hooks in BOTH representations, which the host
  // merges and warns about — retained, not collapsed
  assert.equal(hooks.filter((h) => h.source === "project").length, 2);
  assert.ok(hooks.filter((h) => h.source === "project").every((h) => h.limitKeys.includes("mergedRepresentations")));
  // the same command from two layers is two hooks, not one
  const policy = hooks.filter((h) => h.command === "pre_tool_use_policy.py");
  assert.deepEqual(policy.map((h) => h.scope), ["project", "managed"]);

  // matchers, events and the field each event filters on all reach the ladder
  const audit = engine.composeAudit(engine.scan(root, { adapter: codex, projectOnly: true, userDir: home }), null);
  const mechs = audit.mechanisms.filter((m) => m.type === "hook");
  assert.deepEqual(mechs.map((m) => m.coverage.events[0]).sort(),
    ["PostToolUse", "PreCompact", "PreToolUse", "PreToolUse", "SessionStart"]);
  const sessionStart = mechs.find((m) => m.coverage.events[0] === "SessionStart");
  assert.ok(sessionStart.coverage.limits.some((l) => /matches on `source`/.test(l)),
    "a SessionStart matcher filters the session source, not a tool name");
  const preTool = mechs.find((m) => m.coverage.events[0] === "PreToolUse");
  assert.ok(preTool.coverage.limits.some((l) => /matches on `tool_name`/.test(l)));
  assert.match(engine.renderReport(audit, { verbose: true }), /Level 3 — agent lifecycle guardrails\*\*: 5 hooks/);
});

test("Codex trust: nothing beyond configured is assumed, and a managed-only policy disables the rest", () => {
  const { root, home } = hooksFixture();
  const open = codex.discoverHooks(codexContext(root, { codexHome: home })).hooks;
  const byScope = (list, scope) => list.find((h) => h.scope === scope);

  // a user or plugin hook loads; whether its DEFINITION is trusted is a hash in
  // the host's own store, which no file read reaches
  assert.deepEqual(byScope(open, "user").states, { configured: true, enabled: true, trusted: "unknown", applicable: "unknown" });
  assert.deepEqual(byScope(open, "plugin").states, { configured: true, enabled: true, trusted: "unknown", applicable: "unknown" });
  // a project hook has a SECOND unconfirmed axis: the project `.codex/` layer's
  // own trust decides whether the layer loads at all
  assert.deepEqual(byScope(open, "project").states, { configured: true, enabled: "unknown", trusted: "unknown", applicable: "unknown" });
  assert.ok(byScope(open, "project").limitKeys.includes("projectTrust"));
  assert.ok(byScope(open, "user").limitKeys.includes("hookHashTrust"));

  const audit = engine.composeAudit(engine.scan(root, { adapter: codex, projectOnly: true, userDir: home }), null);
  const report = engine.renderReport(audit, { verbose: true });
  // [Foreman: 097] The chain is no longer spelled out per mechanism; what the
  // record says about trust still reaches the reader through the limits, which
  // are the part that names an actual consequence.
  assert.match(report, /trust is recorded against this definition's hash — editing the command marks it for review again/);
  assert.match(report, /project-local hooks load only when the project `\.codex\/` layer is trusted/);
  // verified is never true anywhere, on any mechanism, under any source
  assert.deepEqual([...new Set(audit.mechanisms.map((m) => m.states.verified))], [false]);

  // and with the policy in force, every non-managed source is off
  const locked = hooksFixture({
    "requirements.toml": [
      "allow_managed_hooks_only = true",
      "",
      "[[hooks.PreToolUse]]",
      'matcher = "^Bash$"',
      "",
      "[[hooks.PreToolUse.hooks]]",
      'type = "command"',
      'command = "python3 /enterprise/hooks/policy.py"',
      "",
    ].join("\n"),
  });
  const managedOnly = codex.discoverHooks(codexContext(locked.root, { codexHome: locked.home })).hooks;
  for (const h of managedOnly) {
    if (h.scope === "managed") {
      assert.deepEqual(h.states, { configured: true, enabled: true, trusted: true, applicable: true }, h.command);
      assert.ok(h.limitKeys.includes("managedTrust"));
    } else {
      assert.deepEqual(h.states, { configured: true, enabled: false, trusted: "unknown", applicable: false }, h.command);
      assert.ok(h.limitKeys.includes("managedOnly"));
    }
  }
  const lockedReport = engine.renderReport(
    engine.composeAudit(engine.scan(locked.root, { adapter: codex, projectOnly: true, userDir: locked.home }), null),
    { verbose: true });
  assert.match(lockedReport, /an `allow_managed_hooks_only` policy is in force, so this source is skipped whatever it says/);
  // [Foreman: 097] A state that is FALSE is the one worth a word, and it is the
  // only part of the chain the report still spells out.
  assert.match(lockedReport, /— not enabled, not applicable/);
  // managed by policy is trusted by policy — and still never observed
  assert.match(lockedReport, /trusted without review and not disableable from the hook browser — assay still never saw it run/);
});

test("a hook layer that will not parse is a hole in the ladder, not a silent zero", () => {
  const home = tmpCodexHome({ "hooks.json": "{ not json" });
  const root = tmpProject({ "AGENTS.md": AGENTS_ROOT, ".codex/config.toml": "[unterminated\n" });
  const { hooks, inaccessible } = codex.discoverHooks(codexContext(root, { codexHome: home }));
  assert.deepEqual(hooks, []);
  assert.equal(inaccessible.length, 2, JSON.stringify(inaccessible));
  assert.ok(inaccessible.every((i) => /unreadable hook configuration/.test(i.reason)), JSON.stringify(inaccessible));

  const report = engine.renderReport(
    engine.composeAudit(engine.scan(root, { adapter: codex, projectOnly: true, userDir: home }), null), {});
  assert.match(report, /could not read `[^`]*config\.toml` \(unreadable hook configuration[^)]*\) — any gate there is missing from this ladder/);
});

test("a hook a policy switched off never marks a rule already covered", () => {
  const rule = "# Rules\n\n- Always run the full test suite before committing.\n";
  const wired = JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 .codex/hooks/gate.py" }] }] },
  });
  // the hook-placement signal is model-judged, so the coverage check only has
  // something to suppress once a judgment exists — same setup the Claude test uses
  const auditWith = (home) => {
    const root = tmpProject({ "AGENTS.md": rule, ".codex/hooks.json": wired });
    const scanData = engine.scan(root, { adapter: codex, projectOnly: true, ...(home ? { userDir: home } : {}) });
    const judgments = {};
    for (const r of scanData.rules) judgments[r.key] = { F3: 0.7, F8: 0.15 };
    return engine.composeAudit(scanData, judgments);
  };

  const live = auditWith(null);
  assert.equal(live.findings.filter((f) => f.type === "redundant-enforcement").length, 1);
  assert.match(live.findings.find((f) => f.type === "redundant-enforcement").summary, /`gate\.py`, project/);

  const home = tmpCodexHome({ "requirements.toml": "allow_managed_hooks_only = true\n" });
  const off = auditWith(home);
  assert.equal(off.hookInventory.length, 1, "the hook is still inventoried — it is disabled, not invisible");
  assert.equal(off.hookInventory[0].states.enabled, false);
  assert.deepEqual(off.findings.filter((f) => f.type === "redundant-enforcement"), [],
    "a hook the host skips covers nothing");
});

test("the vendored TOML parser reads the documented [[hooks.Event]] shape", () => {
  const doc = codex.parseToml([
    "allow_managed_hooks_only = true",
    "",
    "[hooks]",
    'managed_dir = "/enterprise/hooks"',
    "",
    "[[hooks.PreToolUse]]",
    'matcher = "^Bash$"',
    "",
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    'command = "python3 /enterprise/hooks/pre_tool_use_policy.py"',
    "timeout = 30",
    'statusMessage = "Checking managed Bash command"',
    "",
  ].join("\n"));

  assert.equal(doc.allow_managed_hooks_only, true);
  assert.equal(doc.hooks.managed_dir, "/enterprise/hooks");
  assert.equal(doc.hooks.PreToolUse[0].matcher, "^Bash$");
  assert.deepEqual(doc.hooks.PreToolUse[0].hooks, [{
    type: "command",
    command: "python3 /enterprise/hooks/pre_tool_use_policy.py",
    timeout: 30,
    statusMessage: "Checking managed Bash command",
  }]);
  // the 079 keys the subset reader used to serve still read the same
  const config = codex.parseToml('project_doc_max_bytes = 400\nproject_doc_fallback_filenames = ["TEAM_GUIDE.md", ".agents.md"]\n');
  assert.equal(config.project_doc_max_bytes, 400);
  assert.deepEqual(config.project_doc_fallback_filenames, ["TEAM_GUIDE.md", ".agents.md"]);
  // and a document it cannot read throws where the callers catch it
  assert.throws(() => codex.parseToml("[unterminated\n"));
});

test("assay's own .codex-plugin/plugin.json carries every documented required field", () => {
  const pluginRoot = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf-8"));

  // required by the documented schema
  assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, "name must be kebab-case");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(-[\w.]+)?$/);
  assert.ok(manifest.description && manifest.description.length > 0);

  // every component path resolves relative to the plugin root, starts with "./",
  // stays inside that root, and points at something that exists
  for (const key of ["skills", "hooks", "mcpServers", "apps"]) {
    if (manifest[key] === undefined) continue;
    assert.match(manifest[key], /^\.\//, `${key} must be a "./" path`);
    const abs = path.resolve(pluginRoot, manifest[key]);
    assert.equal(path.relative(pluginRoot, abs).startsWith(".."), false, `${key} escapes the plugin root`);
    assert.ok(fs.existsSync(abs), `${key} points at ${manifest[key]}, which does not exist`);
  }
  for (const key of ["composerIcon", "logo"]) {
    const asset = (manifest.interface || {})[key];
    if (asset === undefined) continue;
    assert.match(asset, /^\.\//);
    assert.ok(fs.existsSync(path.resolve(pluginRoot, asset)), `${key} points at ${asset}, which does not exist`);
  }
  // This manifest advertises ONLY the Codex-native skill directory. The Claude
  // skills stay unadvertised here — they are written against the other host's
  // tooling and could not run — while codex-skills/ carries the door that can.
  assert.equal(manifest.skills, "./codex-skills/");
  // the Claude manifest still owns no version — the marketplace does
  assert.equal(JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf-8")).version, undefined);

  // and a plugin manifest is a discovery surface too: pointed at this directory,
  // the adapter finds exactly the advertised skill through it, and nothing else
  const found = codex.discoverSkills(codexContext(pluginRoot));
  const pluginSkills = found.project.filter((s) => s.scope === "plugin");
  assert.equal(pluginSkills.length, 1, JSON.stringify(found.project.map((s) => s.path)));
  assert.ok(pluginSkills[0].path.endsWith("codex-skills/assay/SKILL.md"), pluginSkills[0].path);
});

test("repository checks come from one place, and both profiles return what they returned", () => {
  const root = tmpProject({
    "CLAUDE.md": FIXTURE_CLAUDE,
    "AGENTS.md": AGENTS_ROOT,
    "package.json": JSON.stringify({ name: "x", scripts: { test: "node --test", lint: "eslint .", build: "tsc" } }),
    ".pre-commit-config.yaml": "repos: []\n",
    ".git/config": "[core]\n\thooksPath = scripts/git-hooks\n",
    ".github/workflows/ci.yml": "on: push\n",
    ".github/workflows/release.yaml": "on: release\n",
  });
  const expected = [
    { type: "repo-check", name: "npm script: lint", path: "package.json" },
    { type: "repo-check", name: "npm script: test", path: "package.json" },
    { type: "repo-check", name: ".pre-commit-config.yaml", path: ".pre-commit-config.yaml" },
    { type: "repo-check", name: "git hooks: scripts/git-hooks", path: ".git/config" },
    { type: "remote-gate", name: "ci.yml", path: ".github/workflows/ci.yml" },
    { type: "remote-gate", name: "release.yaml", path: ".github/workflows/release.yaml" },
  ];
  const claudeAdapter = engine.ADAPTERS["claude-code"];
  assert.deepEqual(claudeAdapter.discoverRepoChecks(claudeAdapter.detectContext({ root, projectOnly: true })),
    { checks: expected, inaccessible: [] });
  // the second profile gets the identical rungs from the identical code
  assert.deepEqual(codex.discoverRepoChecks(codexContext(root)), { checks: expected, inaccessible: [] });
  // "build" is not one of the four names either profile looks for
  assert.equal(expected.some((c) => c.name.includes("build")), false);
});

test("mechanism nouns follow the profile, and the Claude report keeps the words it had", () => {
  const long = ["# House rules", ""]
    .concat(Array.from({ length: 240 }, (_, i) => `- Always run step ${i} of the release checklist before committing.`))
    .concat([""]).join("\n");

  const claudeAudit = engine.composeAudit(engine.scan(tmpProject({ "CLAUDE.md": long }), { projectOnly: true }), null);
  const claudeReport = engine.renderReport(claudeAudit, { verbose: true });
  assert.match(claudeReport, /Split into scoped `\.claude\/rules\/` files by topic\./);
  assert.deepEqual(engine.profileNouns(claudeAudit), engine.DEFAULT_NOUNS);
  assert.equal("nouns" in claudeAudit.profile, false, "the Claude profile declares none, so its record grows no key");

  const codexAudit = engine.composeAudit(
    engine.scan(tmpProject({ "AGENTS.md": long }), { adapter: codex, projectOnly: true }), null);
  const codexReport = engine.renderReport(codexAudit, { verbose: true });
  assert.match(codexReport, /Split into narrower `AGENTS\.md` files further down the chain by topic\./);
  assert.doesNotMatch(codexReport, /\.claude\/rules\//);
  assert.doesNotMatch(codexReport, /Claude Code primitive/);
});

test("two scans of one Codex project with skills and hooks differ only in analysisTime", () => {
  const { root, home } = hooksFixture({ "requirements.toml": "allow_managed_hooks_only = false\n" });
  fs.mkdirSync(path.join(root, ".agents", "skills", "deploy", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agents", "skills", "deploy", "SKILL.md"), skillMd("deploy", "Ships the service."));
  fs.writeFileSync(path.join(root, ".agents", "skills", "deploy", "agents", "openai.yaml"),
    "policy:\n  allow_implicit_invocation: false\n");

  const opts = { adapter: codex, projectOnly: true, userDir: home };
  const once = engine.makeRecord("scan", engine.scan(root, opts), root);
  const twice = engine.makeRecord("scan", engine.scan(root, opts), root);
  for (const r of [once, twice]) delete r.context.analysisTime;
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
  assert.ok(once.skills.length && once.hookInventory.length, "the fixture has to have both to prove anything");
});

// ---------------------------------------------------------------------------
// The safe-change transaction — [Foreman: 081]
// ---------------------------------------------------------------------------

const TX_CLAUDE = [
  "# Project rules",
  "",
  "- Never use `var` — use `const` instead.",
  "- Run prettier before committing.",
  "- Always update the changelog when you touch a public API.",
  "",
].join("\n");

function txProject(extra) {
  return tmpProject({ "CLAUDE.md": TX_CLAUDE, ...(extra || {}) });
}

// Write a draft and run `plan` over it; returns the parsed plan summary.
function planDraft(root, draft, name = "draft.json") {
  fs.writeFileSync(path.join(root, name), JSON.stringify(draft, null, 2));
  const r = cli(root, "plan", "--from", name);
  return { ...r, summary: r.code === 0 ? JSON.parse(r.out) : null };
}

const REWRITE_CHANGE = {
  id: "c-rewrite",
  kind: "rule-rewrite",
  rationale: "The rule names no firing moment, so the duty is skipped.",
  patches: [{
    path: "CLAUDE.md",
    old: "- Run prettier before committing.",
    new: "- Before committing, run `npx prettier --write .` over every staged file.",
  }],
  predicted: "resolves the trigger-distance finding on this rule",
  limitations: ["wording only — compliance is not measured here"],
};

// A promotion that builds a real skill beside the prose. The prose stays: no
// command in this engine deactivates a rule on the author's behalf.
const PROMOTE_CHANGE = {
  id: "c-skill",
  kind: "placement-promotion",
  rationale: "A multi-step changelog duty is a workflow, not a sentence.",
  mechanism: { type: "skill", name: "changelog" },
  provenance: [{ claim: "SKILL.md frontmatter", url: "https://code.claude.com/docs/en/skills.md", verified: "2026-07-28" }],
  patches: [{
    path: ".claude/skills/changelog/SKILL.md",
    old: null,
    new: ["---", "name: changelog",
      'description: Updates CHANGELOG.md when a public API changes. Use when "update the changelog". Do NOT use for internal refactors.',
      "---", "", "# changelog", "", "Always update the changelog when you touch a public API.", ""].join("\n"),
  }],
};

function journalRows(root) {
  return engine.readJournal(root);
}

test("plan canonicalizes a draft, stamps every fingerprint, and validates as a plan record", () => {
  const root = txProject();
  const { code, summary } = planDraft(root, {
    changes: [PROMOTE_CHANGE, REWRITE_CHANGE],
    batches: { "all-rewrites": ["c-rewrite"] },
  });
  assert.equal(code, 0);
  // canonical order is by change id, not draft order
  assert.deepEqual(summary.changes.map((c) => c.id), ["c-rewrite", "c-skill"]);

  const record = JSON.parse(fs.readFileSync(path.join(root, ".assay", "plan-" + summary.planId + ".json"), "utf-8"));
  // the third record kind rides the same envelope as scan and audit
  assert.equal(engine.validateRecord(record, "plan"), null);
  assert.equal(record.schemaVersion, engine.SCHEMA_VERSION);
  assert.equal(record.analyzer.name, "assay");
  assert.ok(record.context.projectRoot && record.context.analysisTime);
  // and the additive extension leaves the other two kinds alone
  assert.equal(engine.validateRecord(record, "scan"), "files is missing or not an array");

  const rewrite = record.changes.find((c) => c.id === "c-rewrite");
  // the engine took the fingerprint; the draft never stated one
  assert.equal(rewrite.patches[0].sourceHash, engine.hashContent(TX_CLAUDE));
  assert.deepEqual(rewrite.files, ["CLAUDE.md"]);
  // validation steps are filled proportionally to the kind
  assert.deepEqual(rewrite.validation, ["reparse", "static-reanalysis"]);
  assert.ok(rewrite.rollback.length);
  // a created file plans with a null fingerprint — "this file must not exist yet"
  const promo = record.changes.find((c) => c.id === "c-skill");
  assert.equal(promo.patches[0].sourceHash, null);
  assert.deepEqual(promo.validation, ["host-discovery", "reparse", "static-reanalysis"]);

  // the plan id is a content hash: the same draft re-plans to the same artifact
  const again = planDraft(root, { changes: [PROMOTE_CHANGE, REWRITE_CHANGE], batches: { "all-rewrites": ["c-rewrite"] } }, "draft2.json");
  assert.equal(again.summary.planId, summary.planId);
});

test("a draft with no patch, an unfindable anchor, or an escaping path is rejected with exit 1", () => {
  const root = txProject();
  const noPatch = planDraft(root, { changes: [{ id: "c1", kind: "rule-rewrite", rationale: "why", patches: [] }] });
  assert.equal(noPatch.code, 1);
  assert.match(noPatch.err, /change c1: no patch — a change that writes nothing is a park/);

  const missingAnchor = planDraft(root, {
    changes: [{ id: "c1", kind: "rule-rewrite", rationale: "why", patches: [{ path: "CLAUDE.md", old: "- Not in the file.", new: "x" }] }],
  });
  assert.equal(missingAnchor.code, 1);
  assert.match(missingAnchor.err, /the `old` text is not in CLAUDE\.md/);

  const ambiguous = planDraft(tmpProject({ "CLAUDE.md": "- Do it.\n- Do it.\n" }), {
    changes: [{ id: "c1", kind: "rule-rewrite", rationale: "why", patches: [{ path: "CLAUDE.md", old: "- Do it.", new: "- Do it now." }] }],
  });
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.err, /occurs 2 times[\s\S]*extend it with surrounding context/);

  const escaping = planDraft(root, {
    changes: [{ id: "c1", kind: "rule-rewrite", rationale: "why", patches: [{ path: "../outside.md", old: null, new: "x" }] }],
  });
  assert.equal(escaping.code, 1);
  assert.match(escaping.err, /is not a project-relative path/);
  assert.equal(fs.existsSync(path.join(root, "..", "outside.md")), false);

  // and a hand-edited plan record missing a fingerprint fails at the read boundary
  assert.match(engine.validatePlanChanges([{
    id: "c1", kind: "rule-rewrite", rationale: "why", files: ["CLAUDE.md"],
    patches: [{ path: "CLAUDE.md", old: "a", new: "b" }],
    validation: ["reparse"], rollback: "restore",
  }]), /is missing its source fingerprint/);
});

test("apply mutates the file exactly, journals intent then outcome, and leaves the prose active", () => {
  const root = txProject();
  planDraft(root, { changes: [PROMOTE_CHANGE] });
  const { code, out } = cli(root, "apply", "--change", "c-skill");
  assert.equal(code, 0);
  const applied = JSON.parse(out);
  assert.deepEqual(applied.applied[0].files, [".claude/skills/changelog/SKILL.md"]);

  const built = fs.readFileSync(path.join(root, ".claude", "skills", "changelog", "SKILL.md"), "utf-8");
  assert.equal(built, PROMOTE_CHANGE.patches[0].new);
  // a promotion adds the mechanism BESIDE the prose; the rule is untouched
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), TX_CLAUDE);
  assert.match(applied.note, /source instruction is still active/);

  const rows = journalRows(root);
  assert.deepEqual(rows.map((r) => r.event), ["intent", "outcome"]);
  // the intent carries the pre-image verbatim and precedes the write
  assert.equal(rows[0].preImage, null, "the file did not exist, so there is no pre-image");
  assert.equal(rows[0].patch.new, PROMOTE_CHANGE.patches[0].new);
  assert.equal(rows[1].hashAfter, engine.hashContent(built));
  assert.equal(rows[0].transaction, rows[1].transaction);
});

test("a file touched after planning makes apply exit 1, naming both hashes, and writes nothing", () => {
  const root = txProject();
  planDraft(root, { changes: [REWRITE_CHANGE] });
  const edited = TX_CLAUDE.replace("# Project rules", "# Project rules (edited elsewhere)");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), edited);

  const { code, err } = cli(root, "apply", "--change", "c-rewrite");
  assert.equal(code, 1);
  assert.match(err, /Stale plan: CLAUDE\.md changed since change c-rewrite was planned/);
  assert.ok(err.includes(engine.hashContent(TX_CLAUDE)), "the planned fingerprint is named");
  assert.ok(err.includes(engine.hashContent(edited)), "the current fingerprint is named");
  assert.match(err, /assay\.js plan --from/);
  // the file is exactly as the third party left it
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), edited);
  const rows = journalRows(root);
  assert.deepEqual(rows.map((r) => r.event), ["reject"]);
  assert.equal(rows[0].reason, "stale-fingerprint");
});

test("apply writes only the change ids named on the command line", () => {
  const root = txProject();
  planDraft(root, { changes: [REWRITE_CHANGE, PROMOTE_CHANGE], batches: { "all-rewrites": ["c-rewrite"] } });
  assert.equal(cli(root, "apply", "--change", "c-rewrite").code, 0);

  // c-skill is in the same plan and in no batch that ran, so it did not happen
  assert.equal(fs.existsSync(path.join(root, ".claude", "skills", "changelog", "SKILL.md")), false);
  assert.deepEqual([...new Set(journalRows(root).map((r) => r.change))], ["c-rewrite"]);
  assert.match(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), /npx prettier --write/);

  // the batch is the other recorded boundary — named explicitly, defined in the
  // plan, and it is what keeps `--fix` an approval rather than a default
  const noArgs = cli(root, "apply");
  assert.equal(noArgs.code, 1);
  assert.match(noArgs.err, /no apply-everything default/);
  assert.match(cli(root, "apply", "--batch", "not-a-batch").err, /no plan in \.assay\/ defines batch not-a-batch/);

  const batched = txProject();
  planDraft(batched, { changes: [REWRITE_CHANGE, PROMOTE_CHANGE], batches: { "fix-batch": ["c-rewrite"] } });
  assert.equal(cli(batched, "apply", "--batch", "fix-batch").code, 0);
  assert.deepEqual([...new Set(journalRows(batched).map((r) => r.change))], ["c-rewrite"]);
});

test("an interrupted apply is an intent with no outcome, and rollback resolves it", () => {
  const root = txProject();
  planDraft(root, { changes: [REWRITE_CHANGE] });
  assert.equal(cli(root, "apply", "--change", "c-rewrite").code, 0);

  // simulate the crash: the write landed, the outcome row never got appended
  const journal = path.join(root, ".assay", "journal.jsonl");
  const rows = fs.readFileSync(journal, "utf-8").split("\n").filter(Boolean);
  assert.equal(JSON.parse(rows[1]).event, "outcome");
  fs.writeFileSync(journal, rows[0] + "\n");
  assert.deepEqual(engine.openChangeIds(journalRows(root)), ["c-rewrite"]);

  const { code, out } = cli(root, "rollback", "--change", "c-rewrite");
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).rolledBack[0].outcome, "interrupted apply resolved");
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), TX_CLAUDE);
  assert.equal(journalRows(root).at(-1).cause, "interrupted-apply");
});

test("a patch producing invalid YAML frontmatter is restored automatically, exit 1, both rows journalled", () => {
  const root = txProject();
  planDraft(root, {
    changes: [{
      ...PROMOTE_CHANGE, id: "c-broken", mechanism: { type: "skill", name: "broken" },
      patches: [{ path: ".claude/skills/broken/SKILL.md", old: null, new: "---\nname: [unclosed\n---\n\n# broken\n" }],
    }],
  });
  const { code, err } = cli(root, "apply", "--change", "c-broken");
  assert.equal(code, 1);
  assert.match(err, /Change c-broken was restored: what it wrote does not parse/);
  assert.match(err, /frontmatter is not valid YAML/);
  // the file is gone again, and so is the directory the write created
  assert.equal(fs.existsSync(path.join(root, ".claude", "skills", "broken")), false);
  const events = journalRows(root).map((r) => r.event);
  assert.deepEqual(events, ["intent", "outcome", "restore"]);
  assert.equal(journalRows(root).at(-1).cause, "post-write-validation");
});

test("validate records mechanical evidence and external attestations, each at its own level", () => {
  const root = txProject();
  planDraft(root, { changes: [PROMOTE_CHANGE] });
  assert.equal(cli(root, "apply", "--change", "c-skill").code, 0);

  const { code, out } = cli(root, "validate", "--change", "c-skill",
    "--external", "repo tests: pass");
  assert.equal(code, 0);
  const evidence = JSON.parse(out).evidence;
  const byKind = Object.fromEntries(evidence.map((e) => [e.kind, e]));
  assert.equal(byKind.reparse.level, "mechanical");
  assert.equal(byKind["host-discovery"].result, "pass");
  // the state chain stops where the evidence stops
  assert.match(byKind["host-discovery"].detail, /configured, not enabled, trusted or verified/);
  assert.equal(byKind["static-reanalysis"].result, "pass");
  // assay never runs the repository's own commands: an external result is attested
  assert.equal(byKind["repo tests"].level, "attested");
  assert.match(byKind["repo tests"].detail, /assay did not run this/);
  assert.equal(journalRows(root).filter((r) => r.event === "evidence").length, evidence.length);
});

test("rollback restores a validated change, and refuses while a later change still holds the file", () => {
  const root = txProject();
  planDraft(root, { changes: [REWRITE_CHANGE] });
  assert.equal(cli(root, "apply", "--change", "c-rewrite").code, 0);
  assert.equal(cli(root, "validate", "--change", "c-rewrite").code, 0);

  // a second, separately planned change lands on the same file afterwards
  planDraft(root, {
    changes: [{
      id: "c-later", kind: "stale-reference-repair", rationale: "the referenced path moved",
      patches: [{ path: "CLAUDE.md", old: "- Never use `var` — use `const` instead.", new: "- Never use `var` — use `const` instead. See `docs/style.md`." }],
    }],
  }, "later.json");
  assert.equal(cli(root, "apply", "--change", "c-later").code, 0);

  const refused = cli(root, "rollback", "--change", "c-rewrite");
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Cannot roll back change c-rewrite: change c-later wrote CLAUDE\.md afterwards/);

  assert.equal(cli(root, "rollback", "--change", "c-later").code, 0);
  const undone = cli(root, "rollback", "--change", "c-rewrite");
  assert.equal(undone.code, 0);
  assert.equal(JSON.parse(undone.out).rolledBack[0].outcome, "restored");
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), TX_CLAUDE);
  // rolling back twice says so rather than restoring a stale pre-image
  assert.match(JSON.parse(cli(root, "rollback", "--change", "c-rewrite").out).rolledBack[0].outcome, /already restored/);
});

test("rollback after a stale rejection says there is nothing to undo", () => {
  const root = txProject();
  planDraft(root, { changes: [REWRITE_CHANGE] });
  fs.writeFileSync(path.join(root, "CLAUDE.md"), TX_CLAUDE + "- One more rule.\n");
  assert.equal(cli(root, "apply", "--change", "c-rewrite").code, 1);
  const { code, out } = cli(root, "rollback", "--change", "c-rewrite");
  assert.equal(code, 0);
  assert.match(JSON.parse(out).rolledBack[0].outcome, /nothing to roll back — the change was rejected as stale/);
});

// A promotion adds the mechanism beside the rule. Taking the prose out
// afterwards is the author's own edit, not a command this engine offers — so
// the whole transaction leaves the source instruction exactly where it was.
test("no command deactivates the prose a validated mechanism replaced", () => {
  const root = txProject();
  planDraft(root, { changes: [PROMOTE_CHANGE] });
  assert.equal(cli(root, "apply", "--change", "c-skill").code, 0);
  const validated = cli(root, "validate", "--change", "c-skill");
  assert.equal(validated.code, 0);
  assert.match(JSON.parse(validated.out).note, /source instruction is still active/);
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), TX_CLAUDE);
  // every journalled write belongs to the apply stage — there is no second one
  assert.deepEqual([...new Set(journalRows(root).filter((r) => r.path).map((r) => r.stage))], ["apply"]);
});

test("clean keeps a journal with an open change and removes a closed one, keeping the plan artifacts", () => {
  const root = txProject();
  planDraft(root, { changes: [REWRITE_CHANGE] });
  assert.equal(cli(root, "scan").code, 0);
  assert.equal(cli(root, "apply", "--change", "c-rewrite").code, 0);

  const open = cli(root, "clean");
  assert.equal(open.code, 1);
  assert.match(open.err, /kept \.assay\/journal\.jsonl: 1 open change\(s\) — c-rewrite/);
  assert.ok(fs.existsSync(path.join(root, ".assay", "journal.jsonl")), "the pre-image survives a clean");
  assert.equal(fs.existsSync(path.join(root, ".assay-tmp")), false, "the disposable directory still goes");

  assert.equal(cli(root, "validate", "--change", "c-rewrite").code, 0);
  const closed = cli(root, "clean");
  assert.equal(closed.code, 0);
  // [Foreman: 097] `clean` says what it destroyed and names what it kept — a
  // parked plan the user cannot find is a plan they cannot act on
  assert.match(closed.out, /Removed \.assay-tmp\/ and the change journal — the undo history is gone/);
  assert.match(closed.out, /Kept the parked plan\(s\): \.assay\/plan-[0-9a-f]+\.json\./);
  assert.equal(fs.existsSync(path.join(root, ".assay", "journal.jsonl")), false);
  // [Foreman: 162] The plan artifact is the park record, so cleaning never
  // takes it — and neither the transaction log nor the no-repo backup goes
  // either. Those three ARE the undo once the journal is gone.
  const survived = fs.readdirSync(path.join(root, ".assay")).sort();
  assert.equal(survived.filter((f) => /^plan-[0-9a-f]+\.json$/.test(f)).length, 1);
  assert.ok(survived.includes("transactions.jsonl"), "the transaction log survives clean");
  assert.equal(survived.filter((f) => f.startsWith("backup-")).length, 1, "the backup survives clean");
});

// ---------------------------------------------------------------------------
// Durable state, git preflight, transaction rows — [Foreman: 162]
// ---------------------------------------------------------------------------

const safety = require("../scripts/safety.js");

// A project that IS a repository, with one commit, so HEAD exists and the tree
// starts clean. Everything about the preflight is a property of git's answer,
// so nothing here can be faked with a fixture directory.
function gitProject(extra) {
  const root = txProject(extra);
  const run = (...args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
    assert.equal(r.status, 0, "git " + args.join(" ") + ": " + (r.stderr || r.error));
    return r.stdout;
  };
  run("init", "-q");
  run("config", "user.email", "test@example.invalid");
  run("config", "user.name", "assay test");
  run("config", "commit.gpgsign", "false");
  run("add", "-A");
  run("commit", "-q", "-m", "fixture");
  // the real flow writes its draft into the disposable directory, which the
  // preflight excludes as assay's own state rather than the owner's work
  fs.mkdirSync(path.join(root, ".assay-tmp"), { recursive: true });
  return { root, run };
}

function transactionRows(root) {
  return safety.readTransactions(root);
}

test("apply outside a repository copies every file it will touch, with a sha256 manifest", () => {
  const root = txProject();
  planDraft(root, { changes: [REWRITE_CHANGE, PROMOTE_CHANGE] });
  const before = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8");

  const applied = cli(root, "apply", "--change", "c-rewrite", "--change", "c-skill");
  assert.equal(applied.code, 0, applied.err);
  const summary = JSON.parse(applied.out);
  const backupDir = path.join(root, summary.backupDir);
  assert.match(summary.backupDir, /^\.assay\/backup-t[0-9a-f]{10}$/);

  // the copy is the pre-image, byte for byte
  assert.equal(fs.readFileSync(path.join(backupDir, "CLAUDE.md"), "utf-8"), before);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf-8"));
  const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), [".claude/skills/changelog/SKILL.md", "CLAUDE.md"]);
  assert.equal(byPath["CLAUDE.md"].sha256, crypto.createHash("sha256").update(before).digest("hex"));
  assert.equal(byPath["CLAUDE.md"].bytes, Buffer.byteLength(before));
  // the promotion CREATES its file, so there is nothing to copy — and the null
  // digest is what tells a revert to delete it again rather than restore it
  assert.equal(byPath[".claude/skills/changelog/SKILL.md"].sha256, null);
  assert.equal(fs.existsSync(path.join(backupDir, ".claude", "skills", "changelog", "SKILL.md")), false);
});

test("every run appends exactly one transaction row naming its id, model, files and kinds", () => {
  const root = txProject();
  planDraft(root, { changes: [REWRITE_CHANGE, PROMOTE_CHANGE] });
  assert.equal(cli(root, "apply", "--change", "c-rewrite").code, 0);
  assert.equal(cli(root, "apply", "--change", "c-skill").code, 0);

  const rows = transactionRows(root);
  assert.equal(rows.length, 2, "one row per run, not one per change");
  assert.deepEqual(rows.map((r) => r.files), [["CLAUDE.md"], [".claude/skills/changelog/SKILL.md"]]);
  assert.deepEqual(rows.map((r) => r.changes.map((c) => c.kind)), [["rule-rewrite"], ["placement-promotion"]]);
  assert.notEqual(rows[0].txId, rows[1].txId);
  for (const row of rows) {
    assert.match(row.txId, /^t[0-9a-f]{10}$/);
    assert.equal(row.model, "haiku45", "the row records which model the run optimized for");
    assert.equal(row.assayVersion, engine.ANALYZER_VERSION);
    assert.equal(row.gitHead, null, "no repository, so there is no commit to point at");
    assert.match(row.startedAt, /^\d{4}-\d\d-\d\dT/);
  }
});

test("in a clean repository the row carries gitHead and no files are copied", () => {
  const { root } = gitProject();
  planDraft(root, { changes: [REWRITE_CHANGE] }, ".assay-tmp/draft.json");
  // assay's own state is not the owner's uncommitted work, so the plan
  // artifact and the draft written before the apply leave the tree clean
  assert.deepEqual(safety.preflight(root).dirty, []);

  const applied = cli(root, "apply", "--change", "c-rewrite");
  assert.equal(applied.code, 0, applied.err);

  const [row] = transactionRows(root);
  assert.match(row.gitHead, /^[0-9a-f]{40}$/);
  assert.equal(row.backupDir, null, "git IS the backup — the row is a pointer, not a copy");
  assert.equal(JSON.parse(applied.out).backupDir, null);
  assert.deepEqual(fs.readdirSync(path.join(root, ".assay")).filter((f) => f.startsWith("backup-")), []);
});

test("a dirty repository stops apply before any write, names the paths, and never stashes", () => {
  const { root } = gitProject();
  planDraft(root, { changes: [REWRITE_CHANGE] }, ".assay-tmp/draft.json");
  const before = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8");
  fs.writeFileSync(path.join(root, "notes.md"), "the owner's own uncommitted work\n");

  const refused = cli(root, "apply", "--change", "c-rewrite");
  assert.equal(refused.code, 1);
  assert.match(refused.err, /uncommitted changes/);
  assert.match(refused.err, /notes\.md/, "the refusal names the work it is refusing over");
  assert.doesNotMatch(refused.err, /git stash/, "assay never offers to move the owner's work");

  // nothing was written, journalled or recorded
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), before);
  assert.equal(fs.readFileSync(path.join(root, "notes.md"), "utf-8"), "the owner's own uncommitted work\n");
  assert.equal(fs.existsSync(path.join(root, ".assay", "journal.jsonl")), false);
  assert.deepEqual(transactionRows(root), []);
});

test("a park is recorded in the plan and refused by apply", () => {
  const root = txProject();
  const { code, summary } = planDraft(root, {
    changes: [{ id: "c-park", kind: "park", rationale: "Deferred: this belongs in a pre-commit gate.", patches: [] }],
  });
  assert.equal(code, 0);
  assert.deepEqual(summary.changes[0].files, []);
  const refused = cli(root, "apply", "--change", "c-park");
  assert.equal(refused.code, 1);
  assert.match(refused.err, /is a park: a recorded deferral with nothing to apply/);
  assert.equal(journalRows(root).length, 0);
});

test("every transaction command exits 1 on an unknown change id, a missing plan, or a malformed draft", () => {
  const root = txProject();
  for (const args of [["apply", "--change", "nope"], ["validate", "--change", "nope"]]) {
    const r = cli(root, ...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.err, /no plan in \.assay\/ defines change nope/);
  }
  const rolled = cli(root, "rollback", "--change", "nope");
  assert.equal(rolled.code, 1);
  assert.match(rolled.err, /No change nope in \.assay\/journal\.jsonl/);

  const noDraft = cli(root, "plan", "--from", "absent.json");
  assert.equal(noDraft.code, 1);
  assert.match(noDraft.err, /No draft plan at absent\.json/);

  assert.equal(cli(root, "plan").code, 1);
  fs.writeFileSync(path.join(root, "bad.json"), "{not json");
  const malformed = cli(root, "plan", "--from", "bad.json");
  assert.equal(malformed.code, 1);
  assert.match(malformed.err, /bad\.json is not valid JSON/);

  // validate needs a write to validate, not just a planned change
  planDraft(root, { changes: [REWRITE_CHANGE] });
  const unapplied = cli(root, "validate", "--change", "c-rewrite");
  assert.equal(unapplied.code, 1);
  assert.match(unapplied.err, /has not been applied/);
});

// ---------------------------------------------------------------------------
// Host-aware authoring — [Foreman: 082]
// ---------------------------------------------------------------------------

// What can be tested mechanically about an interview is not the interview: it
// is the contract around it. These check that both craft skills still pass the
// audit assay runs on everyone else's skills, that every file they point at
// exists, that their write path is the transaction and nothing else, and that
// the one engine seam they lean on is real.

const SKILLS_ROOT = path.join(__dirname, "..", "skills");
const CRAFT_SKILLS = ["craft-rules", "craft-skill"];

function skillSource(name) {
  return fs.readFileSync(path.join(SKILLS_ROOT, name, "SKILL.md"), "utf-8");
}

// Everything after the frontmatter block. The description legitimately names
// host paths as examples of what the skill builds; the INSTRUCTIONS may not.
function skillBody(text) {
  const parts = text.split(/^---$/m);
  return parts.slice(2).join("---");
}

test("both craft skills still pass the trigger recipe their own audit applies", () => {
  for (const name of CRAFT_SKILLS) {
    const fm = engine.parseFrontmatter(skillSource(name));
    assert.equal(fm.name, name);
    const checks = engine.checkSkillDescription(fm.description || "");
    assert.deepEqual(checks.missing, [], name + " is missing a recipe part");
    assert.equal(checks.redundant, false, name + " carries a duplicated clause");
    assert.equal(checks.overCap, false, name + " is over the listing cap");
    assert.equal(fm.when_to_use, undefined, name + " is model-invocable and must not carry when_to_use");
    // [1.7.0] The host flag left the user-facing surface. These two skills are
    // Claude Code's, the audit commands name their own host, and a hint that
    // still offered --host would be advertising a choice nobody has.
    assert.doesNotMatch(String(fm["argument-hint"]), /--host|--startup/, name);
    // no in-place editing tool at all: the write path is the transaction, and
    // this is the structural half of that promise
    assert.doesNotMatch(String(fm["allowed-tools"]), /\bEdit\b/, name + " still allows Edit");
    assert.match(String(fm["allowed-tools"]), /\bBash\b/, name + " needs Bash to reach the engine");
  }
});

test("every file the craft skills point at exists", () => {
  for (const name of CRAFT_SKILLS) {
    const text = skillSource(name);
    const referenced = [
      // in-skill markdown links, e.g. [references/recipe.md](references/recipe.md)
      ...[...text.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => path.join(SKILLS_ROOT, name, m[1])),
      // cross-skill paths written the way the plugin writes them
      ...[...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/([\w./-]+\.md)/g)]
        .map((m) => path.join(SKILLS_ROOT, m[1])),
    ];
    assert.ok(referenced.length, name + " points at nothing, which cannot be right");
    for (const file of referenced) {
      assert.ok(fs.existsSync(file), name + " points at a missing file: " + file);
    }
    // and every reference file the skill ships is actually pointed at
    for (const ref of fs.readdirSync(path.join(SKILLS_ROOT, name, "references"))) {
      assert.ok(text.includes("references/" + ref), name + " ships an unreferenced " + ref);
    }
  }
});

test("the craft skills write only through the transaction, never a host path of their own", () => {
  for (const name of CRAFT_SKILLS) {
    const body = skillBody(skillSource(name));
    for (const command of [/plan --from \.assay-tmp\/draft-plan\.json/, /apply --change/, /validate --change/, /rollback --change/]) {
      assert.match(body, command, name + " is missing " + command);
    }
    // every host write target comes off the record, so none is spelled out in
    // the instructions
    for (const hardcoded of [/\.claude\/rules\//, /\.claude\/skills\//, /\.agents\/skills/, /AGENTS\.md/]) {
      assert.doesNotMatch(body, hardcoded, name + " hardcodes a host write target: " + hardcoded);
    }
    // the record is where the target menu comes from
    assert.match(body, /profile\.targets/, name);
    // and the promise is stated, not merely implied by the tool list
    assert.match(body, /[Nn]ever write or edit/, name);
  }
});

test("the craft skills are Claude Code's alone, with no host branch left in them", () => {
  // [1.7.0] Both were written to run under either profile and carried the policy
  // branches that made that honest: no wording grade where the rubric is
  // withdrawn, no recipe score where the recipe is. The split retired the branch
  // rather than the guarantee — these two build for one host now, so a surviving
  // --host, or a fork on a policy key this host never sets, would be an
  // instruction for a run that cannot happen.
  for (const name of CRAFT_SKILLS) {
    const body = skillBody(skillSource(name));
    assert.doesNotMatch(body, /--host|--startup/, name + " still offers a host flag");
    assert.doesNotMatch(body, /policy\.wordingRubric|policy\.skillRecipe/, name + " still branches on host policy");
  }
  // and the recipes they load say where they were measured
  assert.match(fs.readFileSync(path.join(SKILLS_ROOT, "craft-rules", "references", "recipe.md"), "utf-8"),
    /policy\.wordingRubric/);
  assert.match(fs.readFileSync(path.join(SKILLS_ROOT, "craft-skill", "references", "recipe.md"), "utf-8"),
    /policy\.skillRecipe/);
});

test("every profile declares its supported mutation targets, and they ride the record", () => {
  for (const [host, adapter] of Object.entries(engine.ADAPTERS)) {
    const t = adapter.targets;
    assert.ok(t, host + " declares no mutation targets");
    assert.ok(t.rule.places.length, host + " names no place a rule may go");
    for (const place of t.rule.places) {
      for (const key of ["path", "scope", "kind", "scoping"]) {
        assert.equal(typeof place[key], "string", host + " place is missing " + key);
        assert.ok(place[key].length, host + " place has an empty " + key);
      }
    }
    for (const [group, keys] of [["rule", ["docs"]], ["skill", ["docs", "dir", "file"]], ["hook", ["docs", "path"]]]) {
      for (const key of keys) assert.ok(t[group][key], host + "." + group + "." + key);
    }
    assert.ok(t.skill.requires.includes("description"), host + " must require a description");
    assert.ok(Array.isArray(t.skill.metadata), host + ".skill.metadata");
    for (const url of [t.rule.docs, t.skill.docs, t.hook.docs]) assert.match(url, /^https:\/\//);
  }

  // the two profiles answer differently, which is the whole reason this is not
  // a constant in a skill file
  const claude = engine.ADAPTERS["claude-code"].targets;
  const codex = engine.ADAPTERS.codex.targets;
  assert.equal(claude.skill.dir, ".claude/skills/<name>/");
  assert.equal(codex.skill.dir, ".agents/skills/<name>/");
  assert.deepEqual(claude.skill.metadata, []);
  assert.deepEqual(codex.skill.metadata, ["agents/openai.yaml"]);
  assert.deepEqual(codex.skill.requires, ["name", "description"]);
  assert.ok(claude.rule.places.some((p) => p.path === "CLAUDE.md"));
  assert.ok(codex.rule.places.some((p) => p.path === "AGENTS.md"));
  assert.ok(codex.rule.places.some((p) => p.path === "AGENTS.override.md"));

  // and a scan record carries the declaration, which is how a skill reads it
  const root = tmpProject({ "CLAUDE.md": "# Rules\n\n- Never use `var` — use `const` instead.\n" });
  assert.equal(cli(root, "scan").code, 0);
  const record = readJson(root, "scan.json");
  assert.deepEqual(engine.profileTargets(record), claude);
  assert.equal(engine.validateRecord(record, "scan"), null);

  assert.equal(cli(root, "scan", "--host", "codex").code, 0);
  assert.deepEqual(engine.profileTargets(readJson(root, "scan.json")), codex);

  // a profile that declares none gets null, not a guessed filename
  assert.equal(engine.profileTargets({ profile: { host: "x", version: 1 } }), null);
  assert.equal(engine.profileTargets(null), null);
});

// A crafted Codex skill writes agents/openai.yaml beside its SKILL.md, and that
// sidecar is where implicit invocation and the tool dependencies live. It gets
// the same post-write parse — and therefore the same automatic restore — that
// SKILL.md frontmatter has had since 081.
const CODEX_SKILL_MD = [
  "---", "name: deploy", "description: Ships the service.", "---", "", "# deploy", "",
].join("\n");

function codexSkillPromotion(sidecar) {
  return {
    id: "c-codex-skill",
    kind: "placement-promotion",
    rationale: "A multi-step deploy is a workflow, not a sentence.",
    mechanism: { type: "skill", name: "deploy" },
    provenance: [{ claim: "SKILL.md frontmatter and the openai.yaml sidecar", url: "https://learn.chatgpt.com/docs/build-skills", verified: "2026-07-28" }],
    patches: [
      { path: ".agents/skills/deploy/SKILL.md", old: null, new: CODEX_SKILL_MD },
      { path: ".agents/skills/deploy/agents/openai.yaml", old: null, new: sidecar },
    ],
  };
}

test("a skill metadata sidecar that is not valid YAML is restored, and a valid one validates", () => {
  const broken = tmpProject({ "AGENTS.md": "# Rules\n\n- Never use `var` — use `const` instead.\n" });
  assert.equal(planDraft(broken, { changes: [codexSkillPromotion("policy: [unclosed\n")] }).code, 0);
  const refused = cli(broken, "apply", "--change", "c-codex-skill");
  assert.equal(refused.code, 1);
  assert.match(refused.err, /agents\/openai\.yaml is not valid YAML/);
  assert.match(refused.err, /was restored/);
  // both patches go back, so a half-written skill is never left behind
  assert.equal(fs.existsSync(path.join(broken, ".agents", "skills", "deploy", "SKILL.md")), false);
  assert.equal(fs.existsSync(path.join(broken, ".agents", "skills", "deploy")), false);

  const ok = tmpProject({ "AGENTS.md": "# Rules\n\n- Never use `var` — use `const` instead.\n" });
  const sidecar = ["interface:", "  display_name: Deploy", "policy:", "  allow_implicit_invocation: false",
    "dependencies:", "  tools:", "    - type: command", "      value: kubectl", ""].join("\n");
  assert.equal(planDraft(ok, { changes: [codexSkillPromotion(sidecar)] }).code, 0);
  assert.equal(cli(ok, "apply", "--change", "c-codex-skill").code, 0);

  // validate under the SELECTED profile: reparse covers both files, and
  // host-discovery asks the Codex profile whether it finds the skill at all
  const validated = cli(ok, "validate", "--change", "c-codex-skill", "--host", "codex");
  assert.equal(validated.code, 0, validated.err);
  const evidence = JSON.parse(validated.out).evidence;
  const discovery = evidence.find((e) => e.kind === "host-discovery");
  assert.equal(discovery.result, "pass");
  assert.match(discovery.detail, /configured, not enabled, trusted or verified/);

  // and what the skill reads back afterwards: required metadata, no recipe score
  assert.equal(cli(ok, "scan", "--host", "codex").code, 0);
  const entry = readJson(ok, "scan.json").skills.find((s) => s.name === "deploy");
  assert.equal(entry.checks.mode, "required-metadata");
  assert.deepEqual(entry.checks.missing, []);
  assert.equal(entry.metadata.allowImplicitInvocation, false);
  assert.deepEqual(entry.metadata.toolDependencies, [{ type: "command", value: "kubectl" }]);
  assert.equal("metadataIssue" in entry, false);
  assert.equal("quotedPhrases" in entry.checks, false, "no trigger-recipe grade belongs on this profile");
});

// ---------------------------------------------------------------------------
// Language modes — [Foreman: 084]
// ---------------------------------------------------------------------------

const SPANISH_STALE = "- Antes de hacer commit, revisa el archivo `docs/guia-perdida.md` y ejecuta las pruebas.";
const ENGLISH_RULE = "- Never use `var` — use `const` instead.";

test("a Spanish-prose rule is named its mode, ungraded, and still carries its mechanical finding", () => {
  const audit = auditOf({ "CLAUDE.md": ["# Reglas", "", SPANISH_STALE, "", ENGLISH_RULE, ""].join("\n") });
  const [spanish, english] = audit.rules;

  assert.equal(spanish.languageMode, "latin-unsupported:es");
  assert.equal(english.languageMode, "english");

  // English scoring withdrew entirely — and every English PATTERN with it
  assert.equal(spanish.score, null);
  assert.equal(spanish.grade, null);
  assert.equal(spanish.weak, false);
  assert.equal(spanish.placement, null);
  assert.equal(spanish.stallRisk, false);

  // the mechanical half still ran: the dead path is still a blocked state
  assert.equal(primaryState(audit, spanish.id).state, "blocked");
  assert.match(primaryState(audit, spanish.id).summary, /docs\/guia-perdida\.md/);
  assert.equal(primaryState(audit, spanish.id).evidence.level, "mechanical");

  // and it is disclosed rather than silently dropped
  const unsupported = findingsOfType(audit, "unsupported-language");
  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0].mode, "latin-unsupported:es");
  assert.match(unsupported[0].summary, /wording checks need English — this reads as Spanish/);
  assert.match(unsupported[0].summary, /the mechanical findings still apply/);
  assert.deepEqual(unsupported[0].sources, [{ path: "CLAUDE.md", lineStart: 3, lineEnd: 3 }]);
  // the language guess is a guess and the evidence says so
  assert.equal(unsupported[0].evidence.level, "heuristic");
  assert.match(unsupported[0].evidence.limits, /not English/);
});

test("an unsupported-language rule does not drag the file grade or the corpus grade", () => {
  const withSpanish = auditOf({ "CLAUDE.md": ["# Reglas", "", SPANISH_STALE, "", ENGLISH_RULE, ""].join("\n") });
  const englishOnly = auditOf({ "CLAUDE.md": ["# Reglas", "", ENGLISH_RULE, ""].join("\n") });

  // the file's mean is the English rule's score alone — a misread Spanish
  // sentence would have averaged in as a bad English one
  assert.equal(withSpanish.files[0].score, englishOnly.files[0].score);
  assert.equal(withSpanish.files[0].grade, englishOnly.files[0].grade);
  assert.equal(withSpanish.corpusScore, englishOnly.corpusScore);
  // it is still inventoried as a rule; only the scoring withdrew
  assert.equal(withSpanish.files[0].ruleCount, 2);
  assert.equal(englishOnly.files[0].ruleCount, 1);
});

test("short, ambiguous, and backtick-heavy English lines all stay English-scored", () => {
  // The conservative asymmetry, made mechanical: a false "unsupported" silently
  // ungrades a real English rule, so only strong signal reclassifies. Everything
  // here is either too short to screen, mixed, or technical English that happens
  // to carry a foreign-looking token.
  const staysEnglish = [
    "Use `const`, not `var`.",
    "de la el",
    "Run `npm test` before `git commit`.",
    "Use the `src/api/handler.ts` boundary for every request, and validate the body with `zod`.",
    "Always run the formatter, the linter, the type checker and the test suite before pushing.",
    // mixed: real Spanish function words, but English ones beside them
    "Always revisa el archivo before you commit anything to the main branch.",
    // language-neutral tokens only — nothing to screen, so nothing is claimed
    "Run lint, build, typecheck, format, test, package, publish.",
  ];
  for (const text of staysEnglish) {
    assert.equal(engine.detectLanguageMode(text), "english", text);
  }

  // and the paths, identifiers and backtick spans never reach the screen at all
  assert.deepEqual(engine.languageTokens("Use `el archivo de la configuracion` in `src/de/la/el.ts`."), ["use", "in"]);
});

test("every screened language is recognized from its own closed-class words", () => {
  const cases = [
    ["latin-unsupported:es", "Nunca uses variables globales; usa el contenedor de dependencias para cada modulo."],
    ["latin-unsupported:pt", "Antes de cada commit execute os testes e verifique se a configuracao esta correta."],
    ["latin-unsupported:fr", "Avant de committer, lancez les tests et verifiez que la configuration est correcte."],
    ["latin-unsupported:it", "Prima di ogni commit esegui i test e controlla che la configurazione sia corretta."],
    ["latin-unsupported:de", "Vor jedem Commit werden die Tests ausgefuehrt und die Konfiguration wird geprueft."],
  ];
  for (const [mode, text] of cases) assert.equal(engine.detectLanguageMode(text), mode, text);

  // a word shared between English and a screened language is evidence for
  // neither side, so it leaves both lists rather than tipping the screen
  for (const lang of ["es", "pt", "fr", "it", "de"]) {
    for (const word of engine.FUNCTION_WORDS[lang]) {
      assert.equal(engine.FUNCTION_WORDS.en.has(word), false, "`" + word + "` counts on both sides");
    }
  }
});

test("a non-Latin rule takes the same mode vocabulary and the same withdrawal", () => {
  const audit = auditOf({ "CLAUDE.md": ["- Перед commit запустите тесты.", "", ENGLISH_RULE, ""].join("\n") });
  assert.equal(audit.rules[0].languageMode, "non-latin-script");
  assert.equal(audit.rules[0].score, null);
  assert.equal(audit.rules[0].grade, null);
  const unsupported = findingsOfType(audit, "unsupported-language");
  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0].mode, "non-latin-script");
  assert.equal(unsupported[0].analyzer, "language-mode");
  assert.match(unsupported[0].evidence.basis, /non-Latin script detection/);
});

test("coverage reports unsupported-language counts per mode", () => {
  const audit = auditOf({
    "CLAUDE.md": [
      "# Reglas", "",
      SPANISH_STALE, "",
      "- Nunca uses variables globales; usa el contenedor de dependencias para cada modulo.", "",
      "- Перед commit запустите тесты.", "",
      ENGLISH_RULE, "",
    ].join("\n"),
  });
  const report = engine.renderReport(audit);
  // the "graded" count is a claim about what a rubric read, so it excludes them
  assert.match(report, /1 of 1 instruction file\(s\) parsed, 1 rule\(s\) graded of 4 extracted/);
  assert.match(report, /2 rule\(s\) or skill description\(s\) read as Spanish \(`latin-unsupported:es`\)/);
  assert.match(report, /1 rule\(s\) or skill description\(s\) read as a non-Latin script \(`non-latin-script`\)/);
  assert.match(report, /set aside from English wording checks and from every grade/);
});

test("a skill description the trigger recipe cannot read is set aside, not graded weak", () => {
  const audit = auditOf({
    "CLAUDE.md": ENGLISH_RULE + "\n",
    ".claude/skills/despliegue/SKILL.md": [
      "---",
      "name: despliegue",
      "description: Ejecuta el despliegue del proyecto cuando el usuario pide una nueva version de la aplicacion.",
      "---",
      "",
      "# Despliegue",
      "",
    ].join("\n"),
  });
  const skill = audit.skills[0];
  assert.equal(skill.languageMode, "latin-unsupported:es");
  assert.equal(skill.checks.mode, "unsupported-language");
  assert.deepEqual(skill.checks.missing, []);

  const report = engine.renderReport(audit);
  // it never appears as a weak description with an English verdict against it
  assert.doesNotMatch(report, /Weak skill descriptions \(1 to fix\)/);
  const unsupported = findingsOfType(audit, "unsupported-language");
  assert.equal(unsupported.length, 1);
  assert.match(unsupported[0].summary, /describes itself in Spanish/);
  assert.deepEqual(unsupported[0].sources, [
    { path: ".claude/skills/despliegue/SKILL.md", lineStart: 1, lineEnd: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// ci — opt-in CI output — [Foreman: 084]
// ---------------------------------------------------------------------------

const CI_CLEAN = ["# Project rules", "", ENGLISH_RULE, ""].join("\n");

test("ci exits 0 on a clean fixture and names the default gate set", () => {
  const root = tmpProject({ "CLAUDE.md": CI_CLEAN });
  const { code, out } = cli(root, "ci");
  assert.equal(code, 0, out);
  assert.match(out, /^assay ci — claude-code profile \d+, analyzer /m);
  assert.match(out, /^gates: availability, schema, stale-targets, conflicts$/m);
  assert.match(out, /^gated findings: none$/m);
  assert.match(out, /^advisory \(never gates\): \d+/m);
});

test("ci writes nothing at all — no record, no state, no temp file", () => {
  const root = tmpProject({ "CLAUDE.md": CI_CLEAN });
  const before = fs.readdirSync(root).sort();
  assert.equal(cli(root, "ci").code, 0);
  assert.equal(cli(root, "ci", "--json").code, 0);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  assert.equal(fs.existsSync(path.join(root, ".assay-tmp")), false);
  assert.equal(fs.existsSync(path.join(root, ".assay")), false);
});

test("ci exits 2 on a planted stale target under the default gates", () => {
  const root = tmpProject({
    "CLAUDE.md": ["# Project rules", "", "- Follow [the guide](docs/missing-guide.md) when editing handlers.", ""].join("\n"),
  });
  const { code, out } = cli(root, "ci");
  assert.equal(code, 2, out);
  assert.match(out, /^gated findings: 1 \(stale-targets 1\)$/m);
  assert.match(out, /^ {2}stale-targets {2}CLAUDE\.md:3 {2}it requires `docs\/missing-guide\.md`.*\[mechanical\]$/m);
});

test("ci --fail-on selects within the closed set; what is not selected is advisory", () => {
  const root = tmpProject({
    "CLAUDE.md": ["# Project rules", "", "- Follow [the guide](docs/missing-guide.md) when editing handlers.", "", PIN_YES, ""].join("\n"),
    ".claude/rules/deps.md": "# Deps\n\n" + PIN_NO + "\n",
    "src/app.ts": "export {};\n",
  });
  // the whole default set fails on the stale target
  assert.equal(cli(root, "ci").code, 2);

  // narrowed to availability alone, nothing gates and the stale target is
  // reported as advisory instead of dropped
  const narrowed = cli(root, "ci", "--fail-on", "availability");
  assert.equal(narrowed.code, 0, narrowed.out);
  assert.match(narrowed.out, /^gates: availability$/m);
  assert.match(narrowed.out, /^gated findings: none$/m);
  assert.match(narrowed.out, /advisory \(never gates\).*blocked 1/m);

  // the conflict is present, selectable by name, and still never gates — its
  // evidence is heuristic, and the evidence bound outranks the gate table
  const conflicts = cli(root, "ci", "--fail-on", "conflicts");
  assert.equal(conflicts.code, 0, conflicts.out);
  assert.match(conflicts.out, /^gates: conflicts$/m);
  assert.match(conflicts.out, /advisory \(never gates\).*conflicting 2/m);
  assert.match(conflicts.out, /conflict 1/);

  // a selection is canonically ordered, so the same gates always print the same
  assert.match(cli(root, "ci", "--fail-on", "conflicts,availability").out, /^gates: availability, conflicts$/m);
});

test("ci --fail-on refuses anything outside the closed set and names it, exit 1", () => {
  const root = tmpProject({ "CLAUDE.md": CI_CLEAN });
  for (const bad of ["at-risk", "context-pressure", "mechanical-candidate", "everything", ",", "availability,at-risk"]) {
    const run = cli(root, "ci", "--fail-on", bad);
    assert.equal(run.code, 1, "`" + bad + "` was accepted");
    assert.match(run.err, /The gate set is closed: availability, schema, stale-targets, conflicts, duplicates, malformed-config\./);
    assert.match(run.err, /advisory by design/);
  }
  // and the flag still needs a value — bare or empty is the same usage error
  for (const args of [["ci", "--fail-on"], ["ci", "--fail-on", ""]]) {
    const bare = cli(root, ...args);
    assert.equal(bare.code, 1);
    assert.match(bare.err, /--fail-on needs a comma-separated gate list/);
  }
});

test("a gated type labelled heuristic cannot fail a build — the evidence bound is structural", () => {
  // Everything below is a gated type under a selected gate. Only the evidence
  // level differs, and it alone decides.
  const gated = (level) => ({
    findings: [{
      id: "F001", type: "conflict", severity: "high", analyzer: "conflict-detection",
      summary: "planted", explanation: "planted", evidence: { level, basis: "planted" },
      sources: [{ path: "CLAUDE.md", lineStart: 1, lineEnd: 1 }], safeActions: [],
    }],
  });
  for (const level of ["mechanical", "documented"]) {
    assert.equal(engine.ciEvaluate(gated(level), ["conflicts"]).failed.length, 1, level);
  }
  for (const level of ["heuristic", "model-inferred", "experiment-supported"]) {
    const result = engine.ciEvaluate(gated(level), ["conflicts"]);
    assert.deepEqual(result.failed, [], level + " failed a build");
    assert.deepEqual(result.advisory, { conflict: 1 }, level);
  }
  // and a mechanical finding of a type NO gate names is still advisory
  const ungated = { findings: [{
    id: "F001", type: "context-pressure", severity: "low", analyzer: "context-pressure",
    summary: "planted", explanation: "planted", evidence: { level: "mechanical", basis: "planted" },
    sources: [{ path: "CLAUDE.md", lineStart: 1, lineEnd: 1 }], safeActions: [],
  }] };
  assert.deepEqual(engine.ciEvaluate(ungated, engine.CI_GATE_NAMES).failed, []);
});

test("ci --json emits a stable, deterministic, schema-versioned shape", () => {
  const root = tmpProject({
    "CLAUDE.md": ["# Project rules", "", "- Follow [the guide](docs/missing-guide.md) when editing handlers.", "",
      "- Antes de hacer commit, revisa el archivo de configuracion y ejecuta las pruebas.", ""].join("\n"),
  });
  const first = cli(root, "ci", "--json");
  const second = cli(root, "ci", "--json");
  assert.equal(first.code, 2);
  // no clock, no run id, nothing that moves between two runs of one tree
  assert.equal(first.out, second.out);

  const record = JSON.parse(first.out);
  assert.equal(record.schemaVersion, engine.SCHEMA_VERSION);
  assert.equal(record.analyzer.name, "assay");
  assert.equal(record.analyzer.version, engine.ANALYZER_VERSION);
  assert.equal(typeof record.profile.host, "string");
  assert.deepEqual(record.gates, engine.CI_DEFAULT_GATES);
  assert.deepEqual(record.allowedGates, engine.CI_GATE_NAMES);
  assert.equal(record.exitCode, 2);
  // [Foreman: 097] `fix` is the finding's own first safe action, so a CI log
  // names the repair beside the failure instead of only the path.
  assert.deepEqual(record.failed, [{
    gate: "stale-targets", state: "blocked", severity: "high", evidence: "mechanical",
    path: "CLAUDE.md", line: 3,
    summary: "it requires `docs/missing-guide.md`, which the project does not contain",
    fix: "repair reference",
  }]);
  // the language modes reach CI as advisory counts, carrying the mode
  assert.equal(record.advisory["unsupported-language:latin-unsupported:es"], 1);
  // advisory keys are sorted, so two runs on two machines diff cleanly
  assert.deepEqual(Object.keys(record.advisory), [...Object.keys(record.advisory)].sort());
});

test("ci never runs a model step and never reads a judgments file", () => {
  const root = tmpProject({ "CLAUDE.md": CI_CLEAN });
  assert.equal(cli(root, "scan").code, 0);
  const keys = JSON.parse(cli(root, "scan").out).judge.map((j) => j.key);
  const judgments = {};
  // judgments that WOULD move a state if anything here read them
  for (const k of keys) judgments[k] = { F3: 0.1, F8: 0.1 };
  fs.writeFileSync(path.join(root, ".assay-tmp", "judgments.json"), JSON.stringify(judgments));
  const withJudgments = cli(root, "ci", "--json");
  fs.rmSync(path.join(root, ".assay-tmp"), { recursive: true, force: true });
  const without = cli(root, "ci", "--json");
  assert.equal(withJudgments.out, without.out);
});

// ---------------------------------------------------------------------------
// Transaction hardening — the reproduced 1.0.0 holes stay closed
// ---------------------------------------------------------------------------

test("a failed validation run leaves the change open, whatever its passing rows say", () => {
  const root = txProject();
  // The mechanism names a skill the patch does NOT create, so host-discovery
  // fails while reparse and static-reanalysis both record `pass`.
  planDraft(root, {
    changes: [{
      ...PROMOTE_CHANGE,
      mechanism: { type: "skill", name: "ghost" },
    }],
  });
  assert.equal(cli(root, "apply", "--change", "c-skill").code, 0);
  const validated = cli(root, "validate", "--change", "c-skill");
  assert.equal(validated.code, 1);
  assert.match(validated.err, /host-discovery/);
  // the prose is untouched
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), TX_CLAUDE);

  // a run with any failing step is a failed run, so the change stays open and
  // the journal holding its pre-image is not deletable: clean refuses
  const cleaned = cli(root, "clean");
  assert.equal(cleaned.code, 1);
  assert.match(cleaned.err, /1 open change\(s\) — c-skill/);
  assert.ok(fs.existsSync(path.join(root, ".assay", "journal.jsonl")));

  // rollback resolves it, and clean then lets go
  assert.equal(cli(root, "rollback", "--change", "c-skill").code, 0);
  assert.equal(cli(root, "clean").code, 0);
});

test("a plan edited after approval stops resolving: content id first, containment always", () => {
  const root = txProject();
  const { summary } = planDraft(root, { changes: [REWRITE_CHANGE] });
  const planFile = path.join(root, ".assay", "plan-" + summary.planId + ".json");

  // 1. an edit without recomputing the id is caught by the id itself
  const record = JSON.parse(fs.readFileSync(planFile, "utf-8"));
  record.changes[0].patches[0].new = "- Something else entirely.";
  fs.writeFileSync(planFile, JSON.stringify(record, null, 2));
  const tampered = cli(root, "apply", "--change", "c-rewrite");
  assert.equal(tampered.code, 1);
  assert.match(tampered.err, /does not match the plan's content/);

  // 2. an attacker recomputing the id still cannot aim outside the root
  record.changes[0].patches[0] = { path: "../escaped.md", sourceHash: null, old: null, new: "x" };
  record.changes[0].files = ["../escaped.md"];
  record.planId = engine.hashContent(JSON.stringify({ changes: record.changes, batches: record.batches })).slice(0, 12);
  fs.writeFileSync(planFile, JSON.stringify(record, null, 2));
  const escaping = cli(root, "apply", "--change", "c-rewrite");
  assert.equal(escaping.code, 1);
  assert.match(escaping.err, /escapes the project root/);
  assert.equal(fs.existsSync(path.join(root, "..", "escaped.md")), false);
});

test("two patches on one file in one change are rejected at plan time", () => {
  const root = txProject();
  const { code, err } = planDraft(root, {
    changes: [{
      id: "c1", kind: "rule-rewrite", rationale: "two edits",
      patches: [
        { path: "CLAUDE.md", old: "- Run prettier before committing.", new: "- A." },
        { path: "CLAUDE.md", old: "- Never use `var` — use `const` instead.", new: "- B." },
      ],
    }],
  });
  assert.equal(code, 1);
  assert.match(err, /two patches touch CLAUDE\.md — fold them into one patch/);
});

test("rollback refuses a file that changed after apply, and --force restores the pre-image", () => {
  const root = txProject();
  planDraft(root, { changes: [REWRITE_CHANGE] });
  assert.equal(cli(root, "apply", "--change", "c-rewrite").code, 0);
  const handEdit = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8") + "\n- My later hand edit.\n";
  fs.writeFileSync(path.join(root, "CLAUDE.md"), handEdit);

  const refused = cli(root, "rollback", "--change", "c-rewrite");
  assert.equal(refused.code, 1);
  assert.match(refused.err, /CLAUDE\.md changed after assay wrote it/);
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), handEdit, "the later edit survives the refusal");

  assert.equal(cli(root, "rollback", "--change", "c-rewrite", "--force").code, 0);
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), TX_CLAUDE);
});

test("a failed batch names the changes already applied and left in place", () => {
  const root = txProject({ "a.md": "rule A original\n" });
  planDraft(root, {
    changes: [
      { id: "aaa-good", kind: "rule-rewrite", rationale: "ok",
        patches: [{ path: "a.md", old: "rule A original", new: "rule A changed" }] },
      { id: "zzz-bad", kind: "rule-rewrite", rationale: "writes unparseable JSON",
        patches: [{ path: "broken.json", old: null, new: "{ not json" }] },
    ],
    batches: { all: ["aaa-good", "zzz-bad"] },
  });
  const { code, err } = cli(root, "apply", "--batch", "all");
  assert.equal(code, 1);
  assert.match(err, /Change zzz-bad was restored/);
  assert.match(err, /Applied before it and still in place: aaa-good \(a\.md\)/);
  assert.equal(fs.readFileSync(path.join(root, "a.md"), "utf-8"), "rule A changed\n");
  assert.equal(fs.existsSync(path.join(root, "broken.json")), false);
});

// ---------------------------------------------------------------------------
// Analyzer honesty — tag blocks disclosed, illustrative tokens skipped
// ---------------------------------------------------------------------------

test("a non-example tag block is excluded AND disclosed as an unsupported construct", () => {
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n\n- Always validate input.\n\n<critical>\n- Never commit secrets.\n</critical>\n",
  });
  const scanData = engine.scan(root, { projectOnly: true });
  // the body stays out of extraction, exactly as before
  assert.ok(!scanData.rules.some((r) => /commit secrets/.test(r.text)));
  // but the region is disclosed now, with the tag named
  const source = scanData.sources.find((s) => s.path === "CLAUDE.md");
  assert.ok(source.unsupported.some((u) => /<critical> tag block/.test(u.reason)));
  // an <example> block keeps its silence — it is the documented convention
  const exampleRoot = tmpProject({ "CLAUDE.md": "# Rules\n\n<example>\nnot a rule\n</example>\n" });
  const exampleScan = engine.scan(exampleRoot, { projectOnly: true });
  const exampleSource = exampleScan.sources.find((s) => s.path === "CLAUDE.md");
  assert.ok(!(exampleSource.unsupported || []).some((u) => /tag block/.test(u.reason)));
});

test("staleness skips quoted tokens and bare directory names, and still gates real dead paths", () => {
  const root = tmpProject({ "CLAUDE.md": "x\n" });
  const quoted = engine.checkStaleness('The entry\'s source is a relative `"./plugin-name"` path.', root);
  assert.equal(quoted.missing.length, 0, "a quoted token is an illustration, not a reference");
  const bareDir = engine.checkStaleness("An edit lands in its `scripts/` or `hooks/`.", root);
  assert.equal(bareDir.missing.length, 0, "a bare single-segment directory names a shape");
  const dead = engine.checkStaleness("See `docs/missing-guide.md` for the contract.", root);
  assert.equal(dead.gated, true, "a two-segment concrete path still gates when absent");
});

// ---------------------------------------------------------------------------
// --startup — the Codex chain gains its CLI input
// ---------------------------------------------------------------------------

test("--startup reaches the codex chain, and a profile that ignores it is a usage error", () => {
  const root = tmpProject({
    "AGENTS.md": "root guidance\n",
    "sub/AGENTS.md": "nested guidance\n",
  });
  const ok = cli(root, "scan", "--host", "codex", "--project-only", "--startup", "sub");
  assert.equal(ok.code, 0);
  const record = JSON.parse(fs.readFileSync(path.join(root, ".assay-tmp", "scan.json"), "utf-8"));
  assert.equal(path.basename(record.context.startupDirectory), "sub");
  assert.deepEqual(record.sources.map((s) => s.path), ["AGENTS.md", "sub/AGENTS.md"]);

  const refused = cli(root, "scan", "--project-only", "--startup", "sub");
  assert.equal(refused.code, 1);
  assert.match(refused.err, /--startup is not supported by the claude-code profile/);

  const outside = cli(root, "scan", "--host", "codex", "--project-only", "--startup", "..");
  assert.equal(outside.code, 1);
  assert.match(outside.err, /--startup must name the root or a directory inside it/);
});

// ---------------------------------------------------------------------------
// @path imports and nested memory — [Foreman: 090]
// ---------------------------------------------------------------------------

function scanRecord(root) {
  const scanned = cli(root, "scan", "--project-only");
  assert.equal(scanned.code, 0, scanned.err);
  return JSON.parse(fs.readFileSync(path.join(root, ".assay-tmp", "scan.json"), "utf-8"));
}

test("an @path import pulls the target file into the graded set", () => {
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n\n@docs/style.md\n\n- Run `npm test` before pushing.\n",
    "docs/style.md": "- Never use `var` anywhere in `src/`.\n",
  });
  const record = scanRecord(root);
  const imported = record.sources.find((s) => s.path === "docs/style.md");
  assert.ok(imported, "imported file missing from sources");
  assert.equal(imported.imported, true);
  assert.equal(imported.alwaysLoaded, true); // importer loads every session, so its imports do too
  assert.match(imported.selectionReason, /imported by CLAUDE\.md:3/);
  assert.ok(record.rules.some((r) => r.file === "docs/style.md"), "imported rules not graded");
});

test("an import cycle reads each file once and terminates", () => {
  const root = tmpProject({
    "CLAUDE.md": "@a.md\n\n- Run `npm test` before pushing.\n",
    "a.md": "@b.md\n\n- Always update `README.md` after a release.\n",
    "b.md": "@a.md\n\n- Never commit `dist/` output.\n",
  });
  const record = scanRecord(root);
  assert.equal(record.sources.filter((s) => s.path === "a.md").length, 1);
  assert.equal(record.sources.filter((s) => s.path === "b.md").length, 1);
});

test("a path-shaped import that resolves nowhere lands in coverage", () => {
  const root = tmpProject({
    "CLAUDE.md": "@docs/gone.md\n\n- Run `npm test` before pushing.\n",
  });
  const record = scanRecord(root);
  const miss = record.coverage.inaccessible.find((e) => e.path === "docs/gone.md");
  assert.ok(miss, "unresolved import not disclosed");
  assert.match(miss.reason, /imported by CLAUDE\.md:1/);
  assert.match(miss.reason, /not found/);
});

test("a bare @word mention and an email address are not imports", () => {
  const root = tmpProject({
    "CLAUDE.md": "Ping @reviewer or victor.villegas@tuta.com first.\n\n- Run `npm test` before pushing.\n",
  });
  const record = scanRecord(root);
  assert.equal(record.coverage.inaccessible.length, 0);
  assert.equal(record.sources.length, 1);
});

test("imports inside code fences and inline code never fire", () => {
  const root = tmpProject({
    "CLAUDE.md": "```\n@docs/fenced.md\n```\n\nUse `@docs/span.md` literally.\n\n- Run `npm test` before pushing.\n",
  });
  const record = scanRecord(root);
  assert.equal(record.coverage.inaccessible.length, 0);
  assert.equal(record.sources.length, 1);
});

test("a chain past the documented hop cap is disclosed, not silently dropped", () => {
  const root = tmpProject({
    "CLAUDE.md": "@a1.md\n",
    "a1.md": "@a2.md\n",
    "a2.md": "@a3.md\n",
    "a3.md": "@a4.md\n",
    "a4.md": "@a5.md\n",
    "a5.md": "- Never reach this depth.\n",
  });
  const record = scanRecord(root);
  assert.ok(record.sources.some((s) => s.path === "a4.md"), "hop 4 should be read");
  assert.ok(!record.sources.some((s) => s.path === "a5.md"), "hop 5 must not be read");
  const capped = record.coverage.inaccessible.find((e) => e.path === "a5.md");
  assert.ok(capped, "the file past the cap must land in coverage");
  assert.match(capped.reason, /import depth/);
});

test("a nested CLAUDE.md is graded but never counted always-loaded", () => {
  const root = tmpProject({
    "CLAUDE.md": "- Run `npm test` before pushing.\n",
    "packages/app/CLAUDE.md": "- Always lint `app/` code with `npm run lint`.\n",
  });
  const record = scanRecord(root);
  const nested = record.sources.find((s) => s.path === "packages/app/CLAUDE.md");
  assert.ok(nested, "nested memory missing from sources");
  assert.equal(nested.nested, true);
  assert.equal(nested.alwaysLoaded, false);
  assert.match(nested.selectionReason, /loads when Claude works under/);
  assert.ok(record.rules.some((r) => r.file === "packages/app/CLAUDE.md"), "nested rules not graded");
});

test("node_modules and dot-directories are not walked for nested memory", () => {
  const root = tmpProject({
    "CLAUDE.md": "- Run `npm test` before pushing.\n",
    "node_modules/pkg/CLAUDE.md": "- Never grade this.\n",
    ".cache/CLAUDE.md": "- Never grade this either.\n",
  });
  const record = scanRecord(root);
  assert.equal(record.sources.length, 1);
});

// ---------------------------------------------------------------------------
// Hooks, quotes, scopes — [Foreman: 091]
// ---------------------------------------------------------------------------

test("a malformed settings.json is a named hole, not an empty layer", () => {
  const root = tmpProject({
    "CLAUDE.md": "- Run `npm test` before pushing.\n",
    ".claude/settings.json": '{ "hooks": { "PreToolUse": [ ] },, }',
  });
  const scanData = engine.scan(root);
  const audit = engine.composeAudit(scanData, judgeEvery(scanData));
  const holes = (audit.repoChecks || {}).inaccessible || [];
  assert.ok(holes.some((h) => /settings\.json/.test(h.path) && /unreadable hook configuration/.test(h.reason)),
    "parse failure must be disclosed: " + JSON.stringify(holes));
  assert.match(engine.renderReport(audit), /could not read .*settings\.json/);
});

test("a hook whose script is gone and a matcher that will not compile are findings", () => {
  const root = tmpProject({
    "CLAUDE.md": "- Run `npm test` before pushing.\n",
    ".claude/settings.json": JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "node .claude/hooks/gone.js" }] },
          { matcher: "([", hooks: [{ type: "command", command: "echo hi" }] },
        ],
      },
    }),
  });
  const scanData = engine.scan(root);
  const audit = engine.composeAudit(scanData, judgeEvery(scanData));
  const missing = audit.findings.filter((f) => f.type === "hook-target-missing");
  assert.equal(missing.length, 1);
  assert.match(missing[0].summary, /gone\.js/);
  const bad = audit.findings.filter((f) => f.type === "hook-matcher-invalid");
  assert.equal(bad.length, 1);
  const report = engine.renderReport(audit);
  assert.match(report, /is not in the project/);
  assert.match(report, /is not a valid pattern/);
});

test("a wired hook with a live script raises neither finding", () => {
  const root = tmpProject({
    "CLAUDE.md": "- Run `npm test` before pushing.\n",
    ".claude/hooks/ok.js": "console.log(1);\n",
    ".claude/settings.json": JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node .claude/hooks/ok.js" }] }] },
    }),
  });
  const scanData = engine.scan(root);
  const audit = engine.composeAudit(scanData, judgeEvery(scanData));
  assert.deepEqual(audit.findings.filter((f) => f.type === "hook-target-missing"), []);
  assert.deepEqual(audit.findings.filter((f) => f.type === "hook-matcher-invalid"), []);
});

test("block-quoted lines are content, never rules", () => {
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n\n> Always update the changelog before merging.\n\n> We never test on Fridays.\n\n- Use `pnpm` for every install.\n",
  });
  const scanData = engine.scan(root);
  assert.equal(scanData.rules.length, 1, JSON.stringify(scanData.rules.map((r) => r.text)));
  assert.equal(scanData.rules[0].text, "Use `pnpm` for every install.");
  // the inventory invariant still holds: quoted lines are content, not lost
  const src = scanData.sources[0];
  const total = Object.values(src.spans).reduce((a, b) => a + b, 0);
  assert.equal(total, src.lineCount);
});

test("a backslash path with an extension is checked for staleness", () => {
  const root = tmpProject({
    "CLAUDE.md": "- Follow the checklist in `scripts\\release.md` for releases.\n- Escape digits with `\\d+` in matchers.\n",
  });
  const scanData = engine.scan(root);
  const flagged = scanData.rules.filter((r) => r.staleness && r.staleness.missing.length);
  assert.equal(flagged.length, 1, JSON.stringify(scanData.rules.map((r) => r.staleness)));
  assert.match(flagged[0].text, /release\.md/);
});

test("user-scope weak rules render under User scope, not in the project fix list", () => {
  const root = tmpProject({ "CLAUDE.md": "- Run `npm test` before pushing.\n" });
  const userDir = tmpUserDir({ "CLAUDE.md": "- Be helpful.\n" });
  const scanData = engine.scan(root, { userDir });
  const audit = engine.composeAudit(scanData, judgeEvery(scanData));
  const report = engine.renderReport(audit);
  const weakSection = report.split("### Weak rules")[1];
  if (weakSection) {
    assert.doesNotMatch(weakSection.split("###")[0], /Be helpful/);
  }
  assert.match(report, /### User scope/);
  assert.match(report.split("### User scope")[1], /Be helpful/);
  // links to the user file carry forward slashes and a ~ label
  assert.doesNotMatch(report, /\]\(\w:\\/);
});

test("a subagent description is graded and a weak one lands in its own section", () => {
  const root = tmpProject({
    "CLAUDE.md": "- Run `npm test` before pushing.\n",
    ".claude/agents/helper.md": "---\nname: helper\ndescription: A general helper for various tasks.\n---\n",
  });
  const scanData = engine.scan(root);
  const audit = engine.composeAudit(scanData, judgeEvery(scanData));
  const report = engine.renderReport(audit);
  assert.match(report, /## Weak subagent descriptions \(1 to fix\)/);
  assert.match(report, /helper/);
});

// ---------------------------------------------------------------------------
// Conditional conflicts, shared stale targets, scopes above and beside — [Foreman: 093]
// ---------------------------------------------------------------------------

test("two rules gated on one condition that ban and command the same action are a conditional conflict", () => {
  const root = tmpProject({
    "CLAUDE.md": [
      "# Rules", "",
      "- When releasing a plugin, always pin dependencies to exact versions in `package.json`.",
      "- When releasing a plugin, never pin dependencies to exact versions in `package.json`.",
      "",
    ].join("\n"),
  });
  const scanData = engine.scan(root);
  const audit = engine.composeAudit(scanData, judgeEvery(scanData));
  const found = audit.findings.filter((f) => f.type === "conditional-conflict");
  assert.equal(found.length, 1, JSON.stringify(audit.findings.map((f) => f.type)));
  assert.match(found[0].summary, /under "When releasing a plugin"/);
  assert.equal(found[0].evidence.level, "heuristic");
  // both rules take the conflicting state, and the note names the condition
  const states = audit.findings.filter((f) => f.state === "conflicting");
  assert.equal(states.length, 2);
  assert.match(states[0].explanation, /Both fire under one condition/);
  // the pair is a conflict edge, never also a duplicate
  assert.equal(audit.relationships.filter((r) => r.kind === "conflict").length, 1);
  assert.deepEqual(audit.findings.filter((f) => f.type === "duplicate"), []);
  // and the report renders it under Conflicts
  assert.match(engine.renderReport(audit), /### Conflicts[\s\S]*under "When releasing a plugin"/);
});

test("a conditional rule against an unconditional opposite reads as an exception, not a conflict", () => {
  const root = tmpProject({
    "CLAUDE.md": [
      "# Rules", "",
      "- Never pin dependencies to exact versions in `package.json`.",
      "- When releasing a plugin, always pin dependencies to exact versions in `package.json`.",
      "",
    ].join("\n"),
  });
  const scanData = engine.scan(root);
  const audit = engine.composeAudit(scanData, judgeEvery(scanData));
  assert.deepEqual(audit.findings.filter((f) => f.type === "conditional-conflict"), []);
  assert.deepEqual(audit.findings.filter((f) => f.type === "conflict"), []);
});

test("one dead path several sources point at is a stale shared target", () => {
  const root = tmpProject({
    "CLAUDE.md": [
      "# Rules", "",
      "- Run `scripts/shared/tool.js` before every push to keep the manifest honest.",
      "- Validate the marketplace manifest with `scripts/shared/tool.js` after edits.",
      "",
    ].join("\n"),
    ".claude/settings.json": JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node scripts/shared/tool.js" }] }] },
    }),
  });
  const scanData = engine.scan(root);
  const audit = engine.composeAudit(scanData, judgeEvery(scanData));
  const shared = audit.findings.filter((f) => f.type === "stale-shared-target");
  assert.equal(shared.length, 1, JSON.stringify(audit.findings.map((f) => f.type)));
  assert.match(shared[0].summary, /`scripts\/shared\/tool\.js` does not exist, and 3 sources still point at it/);
  assert.equal(shared[0].evidence.level, "mechanical");
  assert.match(engine.renderReport(audit), /### Stale shared targets/);
  // the CI stale-targets gate closes over it
  const verdict = engine.ciEvaluate(audit, ["stale-targets"]);
  assert.ok(verdict.failed.some((f) => f.type === "stale-shared-target"),
    JSON.stringify(verdict));
});

test("a single dead reference stays a per-rule finding, never a shared target", () => {
  const root = tmpProject({
    "CLAUDE.md": "- Run `scripts/shared/tool.js` before every push to keep the manifest honest.\n",
  });
  const scanData = engine.scan(root);
  const audit = engine.composeAudit(scanData, judgeEvery(scanData));
  assert.deepEqual(audit.findings.filter((f) => f.type === "stale-shared-target"), []);
});

test("user rules in ~/.claude/rules/ are discovered, graded under User scope, and move no project number", () => {
  const root = tmpProject({ "CLAUDE.md": "- Run `npm test` before pushing.\n" });
  const userDir = tmpUserDir({
    "CLAUDE.md": "- Prefer pnpm.\n",
    "rules/prefs.md": "- Be helpful.\n",
    "rules/scoped.md": '---\npaths: ["src/**"]\n---\n\n- Return typed errors from every handler.\n',
  });
  const scanData = engine.scan(root, { userDir });
  const userRules = scanData.files.filter((f) => f.scope === "user" && f.kind === "rules");
  assert.equal(userRules.length, 2, JSON.stringify(scanData.files.map((f) => [f.path, f.scope, f.kind])));
  // an unscoped user rules file loads every session; a scoped one does not
  assert.deepEqual(userRules.map((f) => f.alwaysLoaded).sort(), [false, true]);

  const audit = engine.composeAudit(scanData, judgeEvery(scanData));
  const report = engine.renderReport(audit);
  assert.match(report.split("### User scope")[1], /prefs\.md/);
  // the project grade is the project's alone
  const alone = engine.scan(root, { projectOnly: true });
  const aloneAudit = engine.composeAudit(alone, judgeEvery(alone));
  assert.equal(audit.corpusScore, aloneAudit.corpusScore);
});

test("CLAUDE.md files above the project root are read outermost-first and sectioned apart", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "assay-above-"));
  fs.writeFileSync(path.join(base, "CLAUDE.md"), "- Always ask before deleting anything under this tree.\n");
  fs.mkdirSync(path.join(base, "mid"), { recursive: true });
  fs.writeFileSync(path.join(base, "mid", "CLAUDE.local.md"), "- Prefer the staging database here.\n");
  const root = path.join(base, "mid", "proj");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "- Run `npm test` before pushing.\n");

  const { sources } = adapter.discoverSources(adapter.detectContext({ root, projectOnly: false, userDir: EMPTY_USER_DIR }));
  const ancestors = sources.filter((s) => s.scope === "ancestor");
  assert.deepEqual(ancestors.map((s) => s.absPath), [
    path.join(base, "CLAUDE.md"),
    path.join(base, "mid", "CLAUDE.local.md"),
  ], "outermost directory first, CLAUDE.local.md at its own level");
  assert.ok(ancestors.every((s) => s.alwaysLoaded === true));
  assert.ok(ancestors.every((s) => s.kind === "memory"));
  // the ancestor sits between user memory and the project's own memory
  const projMemory = sources.find((s) => s.path === "CLAUDE.md");
  assert.ok(ancestors[0].precedence < projMemory.precedence);

  // --project-only means this repository's files alone
  const fenced = adapter.discoverSources(adapter.detectContext({ root, projectOnly: true }));
  assert.deepEqual(fenced.sources.filter((s) => s.scope === "ancestor"), []);

  // graded apart, counted always-loaded, and the project grade is untouched
  const scanData = engine.scan(root);
  const audit = engine.composeAudit(scanData, judgeEvery(scanData));
  const report = engine.renderReport(audit);
  assert.match(report, /### Above the project root/);
  assert.match(report.split("### Above the project root")[1], /ask before deleting/i);
  const alone = engine.scan(root, { projectOnly: true });
  const aloneAudit = engine.composeAudit(alone, judgeEvery(alone));
  assert.equal(audit.corpusScore, aloneAudit.corpusScore);
});

test("the chain table's # column counts read order, matching the Why column's chain positions", () => {
  const root = tmpProject({
    "AGENTS.md": "# Root\n\n- Return typed errors from every handler.\n",
    "svc/AGENTS.md": "# Service\n\n- Log every request id.\n",
    "svc/api/AGENTS.md": "# API\n\n- Validate every request body.\n",
  });
  const startup = path.join(root, "svc", "api");
  const audit = engine.composeAudit(engine.scan(root, { adapter: codex, projectOnly: true, startup }), null);
  const report = engine.renderReport(audit);
  const rows = report.split("\n").filter((l) => /^\| \d+ \|/.test(l));
  assert.deepEqual(rows.map((l) => l.split("|")[1].trim()), ["1", "2", "3"],
    "the # column must be 1..N in read order, not the precedence numbers");
  assert.match(report, /chain position 2 of 3/);
});

// ---------------------------------------------------------------------------
// [Foreman: 095] renderBrief — the default report
// ---------------------------------------------------------------------------

// The bucketing is the whole design: a rule lands in the first list that claims
// it, so "one rule, one line" is a property of the data rather than a discipline
// each section has to remember. These tests pin that order and the words.

function brief(files, opts) {
  const root = tmpProject(files);
  return engine.renderBrief(engine.composeAudit(engine.scan(root, opts || {}), null));
}

test("the brief report says what it looked at and what needs doing, in plain words", () => {
  const out = brief({ "CLAUDE.md": "# Rules\n\n- Keep things tidy.\n- Always run `npm test` before you open a pull request.\n" });
  assert.match(out, /^# assay — /m);
  assert.match(out, /Looked at 2 rules in 1 file\./);
  assert.match(out, /\*\*1 rule needs work\.\*\*/);
  assert.match(out, /## Fix these first/);
  assert.match(out, /too vague to act on/);
  assert.match(out, /Name a file, a command, or show an example/);
  // the reader is told where to go next, never left with a bare table
  // [Foreman: 165] `--fix` is retired; the line names the offer instead, because
  // four model commands share this report and the engine cannot know which one
  // the reader typed.
  assert.match(out, /offers to rewrite the weak ones/);
  assert.match(out, /--verbose/);
});

// [Foreman: 096] validate re-scans, so it honors the startup chain the audit
// ran under — a change to a file below the root is validated against the chain
// that contains it — and a command that runs no scan refuses the flag instead
// of wearing a label it would never honor.
test("validate honors --startup on the codex host, and non-scanning commands refuse it", () => {
  const root = tmpProject({
    "AGENTS.md": "# Rules\n\n- Keep the build green by running `npm test` before pushing.\n",
    "sub/AGENTS.md": "# Sub rules\n\n- Follow `docs/release.md` before tagging.\n",
  });
  assert.equal(cli(root, "scan", "--host", "codex", "--startup", "sub").code, 0);
  fs.writeFileSync(path.join(root, ".assay-tmp", "draft-plan.json"), JSON.stringify({
    changes: [{
      id: "c-sub", kind: "stale-reference-repair", rationale: "the referenced path is gone",
      patches: [{ path: "sub/AGENTS.md", old: "- Follow `docs/release.md` before tagging.", new: "- Keep the tagging steps in this file." }],
    }],
  }));
  assert.equal(cli(root, "plan", "--from", ".assay-tmp/draft-plan.json").code, 0);
  assert.equal(cli(root, "apply", "--change", "c-sub").code, 0);

  // the re-scan reads the root-to-startup chain: both files, both rules
  const validated = cli(root, "validate", "--change", "c-sub", "--host", "codex", "--startup", "sub");
  assert.equal(validated.code, 0, validated.err);
  const reanalysis = JSON.parse(validated.out).evidence.find((e) => e.kind === "static-reanalysis");
  assert.match(reanalysis.detail, /across 2 rule\(s\)/);

  // a profile that models the startup directory as the root still refuses it
  const claude = cli(root, "validate", "--change", "c-sub", "--startup", "sub");
  assert.equal(claude.code, 1);
  assert.match(claude.err, /--startup is not supported by the .* profile/);

  // and a command that runs no scan refuses either flag outright
  const report = cli(root, "report", "--startup", "sub");
  assert.equal(report.code, 1);
  assert.match(report.err, /--startup belongs to the commands that scan/);
  const hosted = cli(root, "plan", "--from", ".assay-tmp/draft-plan.json", "--host", "codex");
  assert.equal(hosted.code, 1);
  assert.match(hosted.err, /--host belongs to the commands that scan/);
});

// [Foreman: 095] The codex-host brief is read behind two different front doors
// — one per install host — so it may name flags but never a slash command.
test("the codex brief names flags, never a front door another host owns", () => {
  const root = tmpProject({ "AGENTS.md": "# Rules\n\n- Keep things tidy.\n- Follow `docs/missing.md` before tagging.\n" });
  assert.equal(cli(root, "scan", "--host", "codex").code, 0);
  const { code, out } = cli(root, "report");
  assert.equal(code, 0);
  assert.match(out, /--verbose/);
  assert.doesNotMatch(out, /\/assay:/);
});

test("a clean corpus says so instead of printing empty sections", () => {
  const out = brief({ "CLAUDE.md": "# Rules\n\n- Always run `npm test` before you open a pull request.\n" });
  assert.match(out, /\*\*Nothing here needs fixing\.\*\*/);
  assert.doesNotMatch(out, /## Fix these first/);
  assert.doesNotMatch(out, /## Could be automatic instead/);
  assert.doesNotMatch(out, /## Also worth a look/);
  // and it never invites a rewrite when there is nothing to rewrite
  assert.doesNotMatch(out, /--fix/);
});

test("a rule that cannot load is named once, and outranks anything about its wording", () => {
  const out = brief({
    "CLAUDE.md": "# Rules\n\n- Keep things tidy.\n",
    ".claude/rules/orphan.md": "---\npaths:\n  - '**/*.no-such-extension'\n---\n\n- Be careful out there.\n",
  });
  assert.match(out, /\*\*1 rule never loads\.\*\*/);
  // [Foreman: 097] The row is the finding's own sentence, so it says WHY this
  // rule does not load — a hardcoded line said the same thing about every state.
  assert.match(out, /scoped to globs that match no file/);
  const hits = out.split("\n").filter((l) => l.includes("orphan.md:6"));
  assert.equal(hits.length, 1, "a rule that cannot load must be reported once:\n" + out);
});

test("two rules that argue are one row naming both, and neither is graded separately", () => {
  const out = brief({ "CLAUDE.md": "# Rules\n\n- Never push to `origin` without review.\n- Always push to `origin` without review.\n" });
  assert.match(out, /\*\*1 pair of rules disagrees\.\*\*/);
  assert.match(out, /two rules disagree/);
  assert.match(out, /one bans what the other asks for/);
  // assay names the pair and stops — it never picks a winner
  assert.match(out, /Decide which one you meant/);
  assert.equal(out.split("\n").filter((l) => l.includes("CLAUDE.md:3")).length, 1);
  assert.equal(out.split("\n").filter((l) => l.includes("CLAUDE.md:4")).length, 1);
});

test("a rule pointing at a file that is not there says so", () => {
  const out = brief({ "CLAUDE.md": "# Rules\n\n- Read `docs/handbook.md` before you start.\n" });
  assert.match(out, /docs\/handbook\.md/);
});

test("a long fix list is capped and says how many it left out, and of what", () => {
  const rules = [];
  for (let i = 0; i < 14; i++) rules.push("- Keep thing " + i + " tidy.");
  const out = brief({ "CLAUDE.md": "# Rules\n\n" + rules.join("\n") + "\n" });
  const rows = out.split("\n").filter((l) => l.startsWith("| \""));
  assert.equal(rows.length, 8, "the table is capped at 8 rows");
  // [Foreman: 142] A bare count reads as "more of the same". The line names the
  // class of every row it withheld, and the flag that would show them.
  assert.match(out, /6 more not shown here — 6 weakly worded\./);
  assert.match(out, /Run `--top 14` for more rows/);
});

// [Foreman: 142] The defect this pins: `rows.slice(0, 8)` over rows pushed in
// bucket order gave the first crowded class every seat. A live run printed eight
// dead paths and then closed by offering `--fix` for 20 weak rules the reader
// had never been shown.
test("a crowded class cannot take every seat in the fix table", () => {
  const dead = [];
  for (let i = 0; i < 12; i++) dead.push("- Read `docs/missing-" + i + ".md` before you edit anything.");
  const vague = [];
  for (let i = 0; i < 12; i++) vague.push("- Keep thing " + i + " tidy.");
  const out = brief({ "CLAUDE.md": "# Rules\n\n" + dead.concat(vague).join("\n") + "\n" });
  const table = out.split("## Fix these first")[1].split("\n").filter((l) => l.startsWith("| \""));
  assert.equal(table.length, 8, "still capped at 8 rows");
  const stale = table.filter((l) => l.includes("which is not there")).length;
  const weak = table.length - stale;
  assert.ok(stale > 0, "the more urgent class still leads");
  assert.ok(weak > 0, "and the other class is not starved out of the table");
  // Both classes are named in the overflow line, not just the one that overflowed most.
  assert.match(out, /more not shown here — .*pointing at a file that is not there.*weakly worded/);
});

test("the brief report never carries a factor code, an evidence tag or a grade", () => {
  const out = brief({ "CLAUDE.md": "# Rules\n\n- Keep things tidy.\n- Never use `var`.\n- Do the right thing.\n" });
  assert.doesNotMatch(out, /\bF[1-8]\b/);
  assert.doesNotMatch(out, /\[(mechanical|heuristic|model-inferred|experiment-supported)/);
  assert.doesNotMatch(out, /\b[A-F] \(0\.\d\d\)/);
});

test("--verbose is the CLI's door to the full report; the default is the brief one", () => {
  const root = tmpProject({ "CLAUDE.md": "# Rules\n\n- Keep things tidy.\n" });
  assert.equal(cli(root, "scan").code, 0);
  const plain = cli(root, "report");
  assert.equal(plain.code, 0);
  assert.match(plain.out, /^# assay — /m);
  assert.doesNotMatch(plain.out, /## Coverage/);
  const full = cli(root, "report", "--verbose");
  assert.equal(full.code, 0);
  assert.match(full.out, /^# Rule audit — /m);
  assert.match(full.out, /## Coverage/);
});

// [Foreman: 095] What the adversarial pass found, kept honest here.

test("a pipe in a rule, a path or a gate's reason never breaks the table", () => {
  const root = tmpProject({
    "CLAUDE.md": [
      "# Rules",
      "",
      "- Read `docs/a|b.md` before you start.",
      "- Keep [things] **tidy** | always.",
      "- Never do a|b without c|d.",
      // a rule whose own text carries a BACKSLASH before the pipe: escaping the
      // pipe alone turns this into an escaped backslash and a live delimiter
      "- Follow `docs/x\\|y.md` and check it on every change you make here.",
      "",
    ].join("\n"),
    ".claude/rules/a]b.md": "# Scoped\n\n- Keep the generated output tidy.\n",
  });
  const out = engine.renderBrief(engine.composeAudit(engine.scan(root), null));
  for (const line of out.split("\n")) {
    if (!line.startsWith("|") || line.startsWith("|---")) continue;
    // Only a pipe with an EVEN number of backslashes in front of it is a real
    // delimiter; count those rather than stripping `\|`, which would call an
    // escaped backslash an escaped pipe and hide the bug this test is for.
    const cells = (line.match(/(?<!\\)(?:\\\\)*\|/g) || []).length;
    assert.equal(cells, 5, "a row must have exactly four cells:\n" + line);
  }
  // and a `]` in a path does not close the link label early
  assert.doesNotMatch(out, /\[[^\]\\]*[^\\]\][^(]/, "a link label must not close early:\n" + out);
});

test("escaping a table cell never touches a backslash that is not before a pipe", () => {
  const root = tmpProject({
    "CLAUDE.md": [
      "# Rules",
      "",
      "- Always match the tag against `\\d+` before you publish the package.",
      "- Never hardcode `C:\\Users\\x` in any config file you add here.",
      "- Keep the a|b column aligned in every table you add to the docs.",
      "",
    ].join("\n"),
  });
  const audit = engine.composeAudit(engine.scan(root), null);
  const brief = engine.renderBrief(audit);
  const full = engine.renderReport(audit, { verbose: true });
  // A backslash escape does not apply inside a code span, so doubling one there
  // is visible damage to the user's own text. The full report lists every rule,
  // so it is where both survivors are asserted present.
  assert.match(full, /`\\d\+`/, "a regex in a code span must survive verbatim:\n" + full);
  assert.match(full, /C:\\Users\\x/, "a Windows path must survive verbatim:\n" + full);
  for (const [name, out] of [["brief", brief], ["full", full]]) {
    assert.doesNotMatch(out, /\\\\d\+/, name + " doubled a backslash that no table needed:\n" + out);
    assert.doesNotMatch(out, /C:\\\\Users/, name + " doubled a backslash that no table needed:\n" + out);
    // ...while a bare pipe is still escaped, which is the whole point
    assert.match(out, /a\\\|b/, name + " must escape a pipe in rule text:\n" + out);
  }
});

test("a path carrying a pipe, a paren, a space or a bracket still links and still fits its row", () => {
  const root = tmpProject({ "CLAUDE.md": "# Rules\n\n- Always run `npm test` before you open a pull request.\n" });
  const audit = engine.composeAudit(engine.scan(root), null);
  const template = audit.rules[0];
  for (const p of [".claude/rules/a|b.md", ".claude/rules/c(d).md", ".claude/rules/g h.md",
                   ".claude/rules/x]y.md", ".claude/rules/h#h.md", ".claude/rules/q?q.md"]) {
    const clone = JSON.parse(JSON.stringify(audit));
    clone.rules.push({
      ...JSON.parse(JSON.stringify(template)),
      id: "R900", file: p, lineStart: 3, lineEnd: 3, text: "Keep things tidy.",
      weak: true, score: 0.1, grade: "F", factorValues: { F1: 0.4, F7: 0.2 }, dominantWeakness: "F7",
    });
    const row = engine.renderBrief(clone).split("\n").find((l) => l.includes("Keep things tidy"));
    assert.ok(row, "no row rendered for " + p);
    const cells = (row.match(/(?<!\\)(?:\\\\)*\|/g) || []).length;
    assert.equal(cells, 5, "a path containing " + p + " broke its row:\n" + row);
    // the target survives as one unbroken token that resolves back to the path
    const href = /\]\(([^)]*)\)/.exec(row);
    assert.ok(href, "the link target must not be cut short:\n" + row);
    assert.doesNotMatch(href[1], /[ |#?]/, "the link target must not carry a raw space, pipe, hash or query:\n" + row);
    assert.equal(decodeURIComponent(href[1]), p + ":3", "the target must decode back to the real path:\n" + row);
  }
});

test("escaping a cell walks the string once, whatever the backslashes do", () => {
  // A shared helper with a greedy backslash run backtracks from every position,
  // which is quadratic. This is the shape that would show it.
  const run = "\\".repeat(200000);
  const started = process.hrtime.bigint();
  const out = engine.escapeTableCell(run + "x");
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(out, run + "x", "a run with no pipe is left alone");
  assert.ok(ms < 250, `escaping 200k backslashes took ${ms.toFixed(0)}ms — the helper is not linear`);
});

test("an escaped cell renders back to exactly what the rule said", () => {
  // The contract is not "contains no bare pipe" — it is that a reader sees the
  // author's text. These are the parities that break if the doubling is wrong.
  // Every case carries a pipe: that is the sequence this helper exists for, and
  // the only one it changes. A cell with no pipe is passed through untouched,
  // asserted separately below.
  const cases = ["|", "\\|", "\\\\|", "\\\\\\|", "a|b|c", "|lead", "trail|"];
  for (const original of cases) {
    const escaped = engine.escapeTableCell(original);
    // undo what a GFM table cell does: an escaped pipe becomes a pipe, and a
    // doubled backslash becomes one
    const rendered = escaped.replace(/\\\\/g, " ").replace(/\\\|/g, "|").replace(/ /g, "\\");
    assert.equal(rendered, original, `escaping changed the text: ${JSON.stringify(original)} → ${JSON.stringify(escaped)}`);
    // and no bare pipe survives to split the row
    assert.doesNotMatch(escaped, /(?<!\\)(?:\\\\)*\|(?<!\\\|)/, `a bare pipe survived: ${JSON.stringify(escaped)}`);
  }
  // A cell with no pipe is returned exactly as given — a regex, a Windows path,
  // an empty string, a run of backslashes.
  for (const untouched of ["", "\\d+", "C:\\Users\\x", "\\\\\\\\", "plain text"]) {
    assert.equal(engine.escapeTableCell(untouched), untouched, "a cell with no pipe must pass through");
  }
  // and it never throws on what a hand-built record might hold
  for (const odd of [null, undefined, 42, {}]) assert.equal(typeof engine.escapeTableCell(odd), "string");
});

test("a rule the reader cannot fix here is pointed at, never counted as clean", () => {
  const userDir = tmpUserDir({ "CLAUDE.md": "# Mine\n\n- Keep things tidy.\n- Prefer clarity.\n" });
  const root = tmpProject({ "CLAUDE.md": "# Rules\n\n- Always run `npm test` before you open a pull request.\n" });
  const out = engine.renderBrief(engine.composeAudit(engine.scan(root, { userDir }), null));
  // the denominator is the project's own rules, so it never disagrees with the
  // lists underneath it
  assert.match(out, /Looked at 1 rule in 1 file\./);
  // and the reader's own weak rules are named rather than silently dropped
  assert.doesNotMatch(out, /\*\*Nothing here needs fixing\.\*\*/);
  assert.match(out, /\*\*Nothing in this repo's rules needs fixing\.\*\*/);
  assert.match(out, /2 of the rules outside this repo need work/);
  // [Foreman: 097] and the count that reconciles the headline with the scan is in
  // the run's own line, not last in a list that truncates it away
  assert.match(out, /2 more rules load from outside this repo — `--project-only` leaves them out\./);
});

test("a weak subagent description reaches the short report, described the same way as in the full one", () => {
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n\n- Always run `npm test` before you open a pull request.\n",
    ".claude/agents/mute.md": "---\nname: mute\ndescription: Reviews things.\n---\n\nReviews things.\n",
  });
  const audit = engine.composeAudit(engine.scan(root), null);
  const short = engine.renderBrief(audit);
  const full = engine.renderReport(audit);
  assert.match(short, /The `mute` subagent may never get picked/);
  assert.match(short, /no "Use when" trigger clause/);
  // one derivation behind both views, so they can never tell different stories
  assert.match(full, /no "Use when" trigger clause/);
});

test("the withheld count covers every entry a list dropped, not just some", () => {
  const files = { "CLAUDE.md": "# Rules\n\n- Always run `npm test` before you open a pull request.\n" };
  for (const name of ["a", "b", "c", "d", "e", "f"]) {
    files[`.claude/agents/${name}.md`] = `---\nname: ${name}\ndescription: Reviews things.\n---\n\nReviews.\n`;
  }
  const out = engine.renderBrief(engine.composeAudit(engine.scan(tmpProject(files)), null));
  const shown = out.split("\n").filter((l) => /may never get picked/.test(l)).length;
  const more = /…and (\d+) more/.exec(out);
  assert.ok(more, "a truncated list must say how many it withheld:\n" + out);
  assert.equal(shown + Number(more[1]), 6, "shown + withheld must equal the total:\n" + out);
});

test("a rule the host never loads is listed above a pair that argues", () => {
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n\n- Never push to `origin` without review.\n- Always push to `origin` without review.\n",
    ".claude/rules/orphan.md": "---\npaths:\n  - '**/*.no-such-extension'\n---\n\n- Always double-check the output.\n",
  });
  const out = engine.renderBrief(engine.composeAudit(engine.scan(root), null));
  const rows = out.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Rule") && !l.startsWith("|---"));
  assert.match(rows[0], /the host never loads it/, "a rule that cannot load must come first:\n" + out);
  assert.match(rows[1], /two rules disagree/, "a conflicting pair comes after the hard gates:\n" + out);
});

// [Foreman: 141] A repository vendored inside this one loads like project
// policy and the reader owns none of it. The live 1.15.0 run that produced this
// entry put all 40 fix rows inside two vendored folders, every one of them a
// dead path relative to that folder's own root.

test("a rule inside a vendored repository is listed, never counted as the reader's to fix", () => {
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n\n- Always run `npm test` before you open a pull request.\n",
    "knowledge/kotlin/CLAUDE.md": "# Vendored\n\n- Keep it tidy.\n- Read `does-not-exist.md` before editing.\n",
    "knowledge/kotlin/.git": "gitdir: ../../.git/modules/knowledge/kotlin\n",
  });
  const scanData = engine.scan(root);
  const vendored = scanData.files.filter((f) => f.vendored);
  assert.equal(vendored.length, 1, "the nested `.git` marks exactly the vendored file");
  assert.equal(vendored[0].vendoredRoot, "knowledge/kotlin");
  assert.ok(!scanData.files.find((f) => f.path === "CLAUDE.md").vendored, "the reader's own file is untouched");

  const out = engine.renderBrief(engine.composeAudit(scanData, null));
  // Its rules still load, so the report names the folder rather than hiding it.
  assert.match(out, /knowledge\/kotlin.*vendored inside this one/);
  // But nothing inside it reaches a fix table the reader is asked to act on.
  const fixSection = out.split("## Fix these first")[1] || "";
  assert.ok(!fixSection.includes("knowledge/kotlin"), "no vendored row is offered as a fix");
});

test("a submodule declared in .gitmodules counts as vendored even before it is initialized", () => {
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n\n- Always run `npm test` before you open a pull request.\n",
    ".gitmodules": '[submodule "vendor/guide"]\n\tpath = vendor/guide\n\turl = https://example.invalid/guide.git\n',
    "vendor/guide/AGENTS.md": "# Vendored\n\n- Never use `var`.\n",
    "vendor/guide/CLAUDE.md": "# Vendored\n\n- Never use `var`.\n",
  });
  const scanData = engine.scan(root);
  const vendored = scanData.files.filter((f) => f.vendored);
  assert.ok(vendored.length >= 1, "the .gitmodules path marks the directory with no .git present");
  assert.ok(vendored.every((f) => f.vendoredRoot === "vendor/guide"));
});

test("a vendored finding cannot fail a ci run", () => {
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n\n- Always run `npm test` before you open a pull request.\n",
    "vendor/lib/CLAUDE.md": "# Vendored\n\n- Read `gone.md` before editing anything.\n",
    "vendor/lib/.git": "gitdir: ../../.git/modules/vendor/lib\n",
  });
  const audit = engine.composeAudit(engine.scan(root), null);
  const stale = (audit.findings || []).filter((f) => (f.sources || []).some((s) => s.path.startsWith("vendor/lib/")));
  assert.ok(stale.length > 0, "the vendored dead reference is still found and reported");
  const result = engine.ciEvaluate(audit, ["stale-targets"]);
  assert.equal(result.failed.length, 0, "but it never stops a build the reader cannot fix from here");
});

// [Foreman: 143] Two numbers for one run. The headline counted files that
// produced a rule; the provenance line named every file read. A live run said
// "126 rules in 12 files" over a line naming 22 of them.
test("the headline file count is the same population the provenance line names", () => {
  const out = brief({
    "CLAUDE.md": "# Rules\n\n- Always run `npm test` before you open a pull request.\n",
    ".claude/rules/empty.md": "# Notes\n\nThis file is prose and carries no rule at all.\n",
  });
  const headline = out.split("\n").find((l) => l.startsWith("Looked at "));
  const named = (out.split("\n").find((l) => l.startsWith("Read ")) || "").match(/`[^`]+`/g) || [];
  const claimed = Number(headline.match(/in (\d+) files?\./)[1]);
  assert.equal(claimed, named.length, `headline says ${claimed} files, provenance names ${named.length}`);
  assert.equal(claimed, 2, "a file that yielded no rule was still read, and is still counted");
});


// [Foreman: 144] Three of four rows in "Also worth a look" carried one identical
// sentence on a live run. The advice is per-shape, not per-file, so the files
// that share a shape share a row.
function shapeFile() {
  const prose = [];
  for (let i = 0; i < 60; i++) prose.push("Background on how this project came to be, paragraph " + i + ".");
  return "# Notes\n\n" + prose.join("\n\n") +
    "\n\n- Always run `npm test` before you open a pull request.\n" +
    "- Never merge without a review from the owner of the touched module.\n" +
    "- Always update `docs/CHANGELOG.md` in the same commit as a behaviour change.\n";
}

test("files that share one shape problem share one line, not one line each", () => {
  const body = shapeFile();
  const out = brief({
    "CLAUDE.md": "# Rules\n\n- Always run `npm test` before you open a pull request.\n",
    ".claude/rules/one.md": body,
    ".claude/rules/two.md": body,
    ".claude/rules/three.md": body,
  });
  const section = out.split("## Also worth a look")[1];
  assert.ok(section, "the fixture must actually produce a shape finding");
  const lines = section.split("\n").filter((l) => l.startsWith("- "));
  const advice = lines.map((l) => l.slice(l.indexOf(" — ") + 3)).filter(Boolean);
  assert.equal(new Set(advice).size, advice.length, "no two rows repeat one identical sentence");
  const shared = lines.find((l) => l.includes("one.md"));
  assert.ok(shared, "the shape row names the files it is about");
  assert.ok(shared.includes("two.md") && shared.includes("three.md"), "all three files sit on the one row");
});

// [Foreman: 140] The last unbuilt half of the blind-pass plan. A pair sharing an
// action verb and opposite polarity but diluted below the overlap threshold was
// dropped in silence — the one thing a conflict analyzer must never do. These
// two rules command `pin` with opposite polarity and share two content tokens
// of nine, which is under CONFLICT_JACCARD and over the near-miss floor.
const NEAR_MISS = {
  "CLAUDE.md": [
    "# Project rules",
    "",
    "- Always pin dependencies to exact versions in the release manifest.",
    "- Never pin dependencies to a floating major range.",
    "",
  ].join("\n"),
};

test("a near-miss conflict is silent by default", () => {
  const audit = engine.composeAudit(engine.scan(tmpProject(NEAR_MISS)), {});
  const conflicts = (audit.findings || []).filter((f) => f.type === "conflict" || f.type === "conditional-conflict");
  assert.equal(conflicts.length, 0, "the pair is below the threshold, so it is not a reported conflict");
  assert.deepEqual((audit.semantic || {}).candidates, [], "and nothing is proposed unless it was asked for");
});

test("under --semantic the same pair comes back as a proposal, never as a finding", () => {
  const root = tmpProject(NEAR_MISS);
  const audit = engine.composeAudit(engine.scan(root), {}, { semantic: true });
  const candidates = (audit.semantic || {}).candidates || [];
  assert.equal(candidates.length, 1, "the near miss is proposed once");
  const c = candidates[0];
  assert.equal(c.kind, "indirect-conflict");
  assert.equal(c.proposedBy, "analyzer", "a reader must be able to tell a script proposed this, not the model");
  assert.equal(c.keys.length, 2, "keyed by content hash, the way the renderer resolves a candidate");
  assert.equal(c.accepted, null, "unreviewed, so the accept/reject surface picks it up");
  assert.match(c.summary, /opposite polarity/);
  // It renders, keyed to both rules, rather than falling through as unmatched.
  const shown = engine.renderReport(audit, { verbose: true });
  assert.doesNotMatch(shown, /no rule in this scan matches its keys/);
  // The additivity invariant: a proposal moves nothing.
  const plain = engine.composeAudit(engine.scan(root), {});
  assert.deepEqual(audit.findings, plain.findings, "findings are identical with and without the proposals");
  assert.deepEqual(audit.relationships, plain.relationships, "no proposal reaches the relationship graph");
});

test("a pair that already reports as a conflict is never proposed a second time", () => {
  const files = { "CLAUDE.md": "# Project rules\n\n- Always use tabs for indentation in this repository.\n- Never use tabs for indentation in this repository.\n" };
  const audit = engine.composeAudit(engine.scan(tmpProject(files)), {}, { semantic: true });
  const conflicts = (audit.findings || []).filter((f) => f.type === "conflict");
  assert.ok(conflicts.length >= 1, "this pair is a real conflict");
  assert.deepEqual((audit.semantic || {}).candidates, [], "so it is a finding, not a proposal");
});

test("two rules sharing only a verb are not proposed as a near miss", () => {
  const files = {
    "CLAUDE.md": [
      "# Project rules",
      "",
      "- Always use the shared logger for anything a support engineer might read later.",
      "- Never use a bare relative import inside the generated protobuf packages.",
      "",
    ].join("\n"),
  };
  const audit = engine.composeAudit(engine.scan(tmpProject(files)), {}, { semantic: true });
  assert.deepEqual((audit.semantic || {}).candidates, [], "no subject in common, so no proposal");
});

// [Foreman: 147] The last item on the product strategy's corpus list:
// "suspicious improvements caused only by rubric-oriented wording". A grade can
// rise because a rule got better, or because it acquired the words the rubric
// rewards, and a before/after table cannot tell those apart. The report says so
// rather than pretending to know which one happened.
test("a grade that rose with nothing else changing is disclosed, never scored", () => {
  const before = { "CLAUDE.md": "# Rules\n\n- Keep things tidy.\n- Handle errors well.\n" };
  // Deliberately no new path anchor: introducing one would repair or create a
  // real finding, and this fixture has to move the grade and nothing else.
  const after = { "CLAUDE.md": "# Rules\n\n- Always run `npm test` before you open a pull request.\n- Always return a typed error from every request handler.\n" };
  const prev = engine.composeAudit(engine.scan(tmpProject(before)), null);
  const now = engine.composeAudit(engine.scan(tmpProject(after)), null);
  const out = engine.renderReport(now, { verbose: true, prev });
  assert.match(out, /Grades rose with nothing else changing/);
  assert.match(out, /only reading both/);
  // It is a disclosure: no finding, no state, no gate.
  assert.ok(!(now.findings || []).some((f) => f.type === "rubric-only-gain"), "it never becomes a finding");
});

test("a grade that rose because a dead reference was repaired is not called suspicious", () => {
  const before = { "CLAUDE.md": "# Rules\n\n- Always read `docs/missing-guide.md` before editing the parser.\n- Always run `npm test` before you open a pull request.\n" };
  const after = {
    "CLAUDE.md": "# Rules\n\n- Always read `docs/guide.md` before editing the parser.\n- Always run `npm test` before you open a pull request.\n",
    "docs/guide.md": "# Guide\n",
  };
  const prev = engine.composeAudit(engine.scan(tmpProject(before)), null);
  const now = engine.composeAudit(engine.scan(tmpProject(after)), null);
  const out = engine.renderReport(now, { verbose: true, prev });
  assert.doesNotMatch(out, /Grades rose with nothing else changing/);
});

// [Foreman: 106] A skill written before the current routing guidance carries
// several of these shapes at once. Individually each is a row in the weak-skill
// table; together they are one description authored against older advice, and
// the repair is one rewrite. The ADR this entry cites admits no new check and
// no new evidence tier, so this reads only signals that already ship.
test("a skill carrying several older-guidance shapes is named as one rewrite", () => {
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n\n- Always run `npm test` before you open a pull request.\n",
    ".claude/skills/legacy/SKILL.md": [
      "---",
      "name: legacy",
      "description: Reads, parses, converts, validates, normalizes and exports spreadsheet data, plus charts, pivots and formulas.",
      "when_to_use: When the user mentions a spreadsheet.",
      "---",
      "",
      "# legacy",
      "",
      "Do the thing.",
    ].join("\n"),
  });
  const audit = engine.composeAudit(engine.scan(root), null);
  const out = engine.renderReport(audit, { verbose: true });
  assert.match(out, /### Written against older guidance/);
  assert.match(out, /`legacy`/);
  assert.match(out, /keeps `when_to_use` as its own field/);
  assert.match(out, /craft-skill/);
});

test("a skill with one weak point is not called older guidance", () => {
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n\n- Always run `npm test` before you open a pull request.\n",
    ".claude/skills/nearly/SKILL.md": [
      "---",
      "name: nearly",
      'description: Converts a .csv file into a formatted .xlsx workbook. Use when the user asks to turn a CSV into a spreadsheet — e.g. "make this csv an excel file", "convert data.csv to xlsx".',
      "---",
      "",
      "# nearly",
      "",
      "Convert the file.",
    ].join("\n"),
  });
  const out = engine.renderReport(engine.composeAudit(engine.scan(root), null), { verbose: true });
  assert.doesNotMatch(out, /### Written against older guidance/);
});
