"use strict";

// [Foreman: 085] The release checklist, as executable assertions.
//
// SCOPE.md's "Release gates" section lists what must hold before a host profile
// is releasable. Everything there was already true and already tested — spread
// across the suite that grew with each entry, where a person cutting a release
// cannot read it as a checklist. This file IS the checklist: one named test per
// bullet, each proving its claim mechanically and mostly through the public
// surface, so the answer to "is this releasable" is one command.
//
// The 1.0.0+ cut procedure:
//   1. `node --test assay/tests/assay.test.js`   — the main suite, green
//   2. `node --test assay/tests/release-gates.test.js` — this file, green
//   3. `node scripts/assay-doc-drift.js`         — OK, or the affected
//      capability disabled with an explanation in the adapter and the README
// A required cell that fails exits this file non-zero, and doc-drift exits 2
// naming the blocked profile. Nothing is wired into git hooks: the release
// discipline is the enforcement point, and it is a person running three
// commands, not a daemon.
//
// Cells this machine cannot express — a live host, a case-sensitive filesystem,
// a symlink without the privilege to make one — are SKIPPED WITH A DISCLOSURE,
// counted, and printed as DISCLOSED GAPS on every run. A checklist that quietly
// omits what it could not check is worse than no checklist.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const engine = require("../scripts/assay.js");

// The same isolation the main suite takes: the developer's own ~/.claude and
// ~/.codex must never leak into a gate.
const EMPTY_USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "assay-gate-userdir-"));
const EMPTY_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "assay-gate-codexhome-"));
process.env.ASSAY_USER_DIR = EMPTY_USER_DIR;
process.env.CODEX_HOME = EMPTY_CODEX_HOME;
// [Foreman: 095] And the same stop the main suite takes: without it a gate that
// counts rules counts whatever CLAUDE.md happens to sit above the temp
// directory on this machine, and its numbers stop being a property of the
// fixture.
process.env.ASSAY_ANCESTOR_STOP = os.tmpdir();

const CLI = path.join(__dirname, "..", "scripts", "assay.js");
const PLUGIN_ROOT = path.join(__dirname, "..");

function tmpProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assay-gate-"));
  for (const [rel, content] of Object.entries(files || {})) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

// `cwd` is the startup directory, which is a fact of the run for every profile
// with a root-to-startup chain — so it is a parameter here, never assumed.
function cli(cwd, args, env) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: "utf-8", env: { ...process.env, ...(env || {}) },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function readJson(root, name) {
  return JSON.parse(fs.readFileSync(path.join(root, ".assay-tmp", name), "utf-8"));
}

// Content hash + mtime of every file outside the two directories assay owns.
function snapshotTree(root) {
  const snap = {};
  const stack = ["."];
  while (stack.length) {
    const rel = stack.pop();
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = rel === "." ? e.name : rel + "/" + e.name;
      if (e.isDirectory()) {
        if (e.name !== ".assay-tmp" && e.name !== ".assay") stack.push(child);
      } else if (e.isFile()) {
        const full = path.join(root, child);
        snap[child] = crypto.createHash("sha1").update(fs.readFileSync(full)).digest("hex") +
          ":" + fs.statSync(full).mtimeMs;
      }
    }
  }
  return snap;
}

// Every gap this run could not close, with the reason. Printed at the end so
// the checklist always states its own coverage.
const DISCLOSED_GAPS = [];
function disclose(cell, reason) {
  DISCLOSED_GAPS.push({ cell, reason });
  return reason;
}

// The ratified disclosure, in the adapter's own words — one sentence, one
// place. A gate that invented its own wording would drift from the report's.
const NO_LIVE_CODEX = engine.ADAPTERS.codex.coverageNotes()
  .find((n) => /no live Codex host was probed/.test(n));
assert.ok(NO_LIVE_CODEX, "the Codex adapter no longer states its live-host limit");

const CLEAN_RULE = "- Never use `var` — use `const` instead.";
const CLEAN_CLAUDE = ["# Project rules", "", CLEAN_RULE, ""].join("\n");

// ---------------------------------------------------------------------------
// "its effective-source inventory matches labeled fixtures"
// "unsupported and inaccessible sources are disclosed"
// ---------------------------------------------------------------------------

test("release gate: the effective-source inventory matches labeled fixtures", () => {
  // Claude: the documented surface, in load order, each source labelled with why
  // it is or is not effective.
  const claudeRoot = tmpProject({
    "CLAUDE.md": CLEAN_CLAUDE,
    "CLAUDE.local.md": "- Use the staging database locally.\n",
    ".claude/rules/api.md": '---\npaths: ["src/**/*.ts"]\n---\n\n- Validate every request body at the handler boundary.\n',
    "src/api/handler.ts": "export {};",
  });
  assert.equal(cli(claudeRoot, ["scan"]).code, 0);
  const claude = readJson(claudeRoot, "scan.json");
  assert.deepEqual(claude.files.map((f) => f.path),
    ["CLAUDE.md", "CLAUDE.local.md", ".claude/rules/api.md"]);
  for (const f of claude.files) assert.equal(typeof f.alwaysLoaded, "boolean", f.path);

  // Codex: the chain the host resolves, root down to the startup directory, with
  // the beaten variant labelled rather than dropped. The CLI fixes the startup
  // directory at the project root on purpose — `cmdScan` names that ceiling and
  // `--startup <path>` as its upgrade path — so a chain that ends somewhere else
  // is exercised through the scan API the CLI calls.
  const codexRoot = tmpProject({
    "AGENTS.override.md": "# Override\n\n- Always run `npm test` before committing.\n",
    "AGENTS.md": "# House\n\n" + CLEAN_RULE + "\n",
    "svc/AGENTS.md": "# Service\n\n- Return typed errors from every handler.\n",
  });
  const codex = engine.scan(codexRoot, {
    adapter: engine.ADAPTERS.codex, projectOnly: true, startup: path.join(codexRoot, "svc"),
  });
  assert.deepEqual(codex.files.map((f) => f.path),
    ["AGENTS.override.md", "AGENTS.md", "svc/AGENTS.md"]);
  const beaten = codex.files.find((f) => f.path === "AGENTS.md");
  assert.equal(beaten.selected, false);
  assert.equal(beaten.shadowedBy, "AGENTS.override.md");
  // and the later word in the chain is the later word, not the first
  assert.ok(codex.files[2].precedence > codex.files[0].precedence);
});

// [ADR 2026-08-05 B1] The auto-memory surface is an effective source with its
// own labels: the index loads always (under a documented read cap), topic files
// load on demand. The gate proves the inventory carries those labels rather than
// leaving the surface invisible.
test("release gate: auto memory is a labeled effective source", () => {
  const root = tmpProject({ "CLAUDE.md": CLEAN_CLAUDE });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "assay-gate-automem-"));
  const slug = path.resolve(root).replace(/[\\/:]/g, "-");
  const memDir = path.join(userDir, "projects", slug, "memory");
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, "MEMORY.md"), "# Memory\n\n" + CLEAN_RULE + "\n");
  fs.writeFileSync(path.join(memDir, "debugging.md"), "# Debugging\n\n- The tests need a local Redis.\n");

  const scan = engine.scan(root, { userDir });
  const index = scan.sources.find((s) => s.autoMemory && s.path.endsWith("MEMORY.md"));
  assert.ok(index, "the auto-memory index is not in the effective-source inventory");
  assert.equal(index.alwaysLoaded, true);
  assert.equal(index.scope, "user");
  assert.equal(index.docCap.lines, 200);
  const topic = scan.sources.find((s) => s.autoMemory && s.path.endsWith("debugging.md"));
  assert.ok(topic && topic.alwaysLoaded === false, "the topic file is missing or mislabeled");
  // and the adapter discloses the residuals a file read cannot close
  assert.ok(scan.coverage.profileNotes.some((n) => /auto memory/.test(n)));
});

test("release gate: unsupported and inaccessible sources are disclosed", () => {
  const root = tmpProject({
    ".claude/rules/basics.md": "---\ndescription: Use when: broken\n---\n\n- Run `npm test` before committing.\n",
  });
  // a directory where CLAUDE.md should be: discovered, then unreadable
  fs.mkdirSync(path.join(root, "CLAUDE.md"));
  assert.equal(cli(root, ["scan"]).code, 0);
  const scanned = readJson(root, "scan.json");
  assert.equal(scanned.coverage.inaccessible.length, 1);
  assert.equal(scanned.coverage.inaccessible[0].path, "CLAUDE.md");
  assert.ok(scanned.coverage.inaccessible[0].reason);
  const unsupported = scanned.sources.flatMap((s) => s.unsupported);
  assert.equal(unsupported.length, 1);
  assert.match(unsupported[0].reason, /^malformed frontmatter: /);

  const report = cli(root, ["report", "--verbose"]);
  assert.equal(report.code, 0, report.err);
  assert.match(report.out, /could not read `CLAUDE\.md`/);
  assert.match(report.out, /unsupported construct\(s\) — inventoried, not graded/);
});

// ---------------------------------------------------------------------------
// "hard gates run before prose heuristics"
// ---------------------------------------------------------------------------

// One rule that BOTH claims would take: the wording is strong enough to score
// well and bare enough to read as a stall risk, and the host never loads the
// file it sits in. The gate has to win — a prose heuristic that outranked an
// unloadable rule would send someone to reword text nothing reads.
test("release gate: hard gates run before prose heuristics", () => {
  const root = tmpProject({
    ".claude/rules/dead.md": '---\npaths: ["nope/**/*.ts"]\n---\n\n- Never use `var` in `src/api/handler.ts`.\n',
  });
  assert.equal(cli(root, ["scan"]).code, 0);
  assert.equal(cli(root, ["report", "--verbose"]).code, 0);
  const audit = readJson(root, "audit.json");
  const rule = audit.rules[0];

  // both claims are live on this one rule
  assert.equal(rule.stallRisk, true, "fixture lost its prose-heuristic claim");
  assert.ok(rule.factorValues.F1 >= 0.9, "fixture lost its strong wording");

  // and the state is the gate, at the gate's severity, on the gate's evidence
  const state = audit.findings.find((f) => f.rule === rule.id && f.state);
  assert.equal(state.state, "inactive");
  assert.equal(state.severity, "high");
  assert.equal(state.evidence.level, "mechanical");
  assert.equal(engine.FINDING_STATES.indexOf("inactive") < engine.FINDING_STATES.indexOf("at-risk"), true);

  // the report puts the gate above every heuristic section, and never prints a
  // grade beside it
  const md = cli(root, ["report", "--verbose"]).out;
  const gatesAt = md.indexOf("## Hard gates");
  assert.ok(gatesAt !== -1);
  assert.ok(gatesAt < md.indexOf("## Operational findings"));
  assert.ok(gatesAt < md.indexOf("## Structural hygiene (secondary)"));
  const gates = md.slice(gatesAt, md.indexOf("## Operational findings"));
  assert.match(gates, /\*\*inactive\*\*/);
  assert.doesNotMatch(gates, /\b[A-F] \(0\.\d\d\)/);
});

// ---------------------------------------------------------------------------
// "parser coverage meets the inventory invariant"
// ---------------------------------------------------------------------------

test("release gate: parser coverage meets the inventory invariant", () => {
  // Every physical line of every parsed file lands in exactly one class. The
  // main suite proves this construct by construct; the gate re-asserts the
  // invariant itself over the shapes a release has to survive.
  const projects = [
    { "CLAUDE.md": CLEAN_CLAUDE },
    { "CLAUDE.md": "", ".claude/rules/empty.md": "" },
    { "CLAUDE.md": "---\nbroken: yes: no\n---\n\n- Run the tests.\n\n```js\nunclosed\n" },
    { "CLAUDE.md": "| Do | Don't |\n|---|---|\n| Run `npm test` | Никогда |\n" },
  ];
  for (const files of projects) {
    const scanData = engine.scan(tmpProject(files), { projectOnly: true });
    assert.equal(scanData.sources.length, scanData.files.length);
    for (const source of scanData.sources) {
      const total = Object.values(source.spans).reduce((a, b) => a + b, 0);
      assert.equal(total, source.lineCount,
        source.path + ": spans sum to " + total + ", file has " + source.lineCount + " lines");
    }
  }
});

// ---------------------------------------------------------------------------
// "Markdown and JSON agree on findings"
// ---------------------------------------------------------------------------

// One fixture artifact, two views, one finding set. The fixture reaches every
// section that exists today: hard gates, conflicts, duplicates, the byte
// budget, unsupported language, and — on the profile that has them — the
// instruction chain and maintainability.

// The four ways a markdown report can name a finding: its own sentence, the
// rule id it belongs to, the exact span, or the file it is about. The last one
// is the floor and it is deliberate — where one cause affects many rules (the
// byte cap landing inside a file), the markdown states the cause once against
// the file, while the record carries the finding once per affected rule. Both
// hold the same finding; only the grouping differs, so the check matches at the
// granularity the report actually uses.
// razor: file granularity is the floor for markdown. Tightening it to the span
// means the markdown renderer must list one line per affected rule — a report
// change, not a test change, and the upgrade path if that ever becomes wanted.
function namedInMarkdown(md, finding) {
  if (md.includes(finding.summary)) return true;
  if (finding.rule && md.includes(finding.rule)) return true;
  return (finding.sources || []).some((s) => md.includes(s.path + ":" + s.lineStart) || md.includes(s.path));
}

test("release gate: Markdown and JSON agree on findings", () => {
  // Bytes, not rules: the byte budget is a property of what loads every session,
  // so the fixture reaches it with fenced narrative rather than a thousand
  // near-identical bullets that would only be testing the duplicate detector.
  const bulk = ["<!-- assay-ignore-start -->", "",
    ...Array.from({ length: 700 },
      (_, i) => "Historical note " + i + ": this paragraph is background for the reader, never a rule."),
    "", "<!-- assay-ignore-end -->"].join("\n");
  const root = tmpProject({
    "CLAUDE.md": [
      "# Rules", "",
      CLEAN_RULE,
      "- Follow [the guide](docs/missing-guide.md) when editing handlers.",
      "- Antes de hacer commit, ejecuta las pruebas y revisa la configuracion.",
      "- Always pin dependencies to exact versions in `package.json`.",
      "", bulk, "",
    ].join("\n"),
    ".claude/rules/deps.md": "# Deps\n\n- Never pin dependencies to exact versions in `package.json`.\n",
    ".claude/rules/dupe.md": "# Dupe\n\n" + CLEAN_RULE + "\n",
  });

  assert.equal(cli(root, ["scan"]).code, 0);
  assert.equal(cli(root, ["report", "--verbose"]).code, 0);

  const audit = readJson(root, "audit.json");
  const md = cli(root, ["report", "--verbose"]).out;

  // the fixture actually reaches the sections it claims to
  const types = new Set(audit.findings.map((f) => f.type));
  for (const type of ["conflict", "duplicate", "context-pressure", "unsupported-language"]) {
    assert.ok(types.has(type), "fixture is missing a " + type + " finding");
  }
  assert.ok(audit.findings.some((f) => f.state === "blocked"), "fixture is missing its stale target");

  // JSON == markdown
  for (const f of audit.findings) {
    assert.ok(namedInMarkdown(md, f), "markdown never names finding " + f.id + " (" + f.type + ")");
  }

  // and the newer sections reach the report, not just the record
  assert.match(md, /bytes of instructions load before every session/);
  assert.match(md, /read as Spanish \(`latin-unsupported:es`\)/);
});

test("release gate: Markdown and JSON agree on findings — Codex chain and budget", () => {
  // Two sections exist only for a profile whose host documents a read order and
  // a cap, and a chain that reaches the cap needs a startup directory below the
  // root — which the CLI fixes at the root by design. So this half runs through
  // the same scan and render functions the CLI calls, one step lower down.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "assay-gate-codex-"));
  fs.writeFileSync(path.join(home, "config.toml"), "project_doc_max_bytes = 400\n");
  const filler = (name) => "# " + name + "\n\n" + Array.from({ length: 12 },
    (_, i) => "- Always validate request body number " + i + " at the handler boundary.").join("\n") + "\n";
  const root = tmpProject({
    // the bare noun phrase is the maintainability item: a line the host loads
    // and can act on, out of which no directive verb can be read
    "AGENTS.override.md": "# Override\n\n- Always run `npm test` before committing.\n- Only `snake_case` for column names.\n",
    "AGENTS.md": filler("root"),
    "svc/AGENTS.md": filler("service"),
  });
  const audit = engine.composeAudit(engine.scan(root, {
    adapter: engine.ADAPTERS.codex, projectOnly: true,
    startup: path.join(root, "svc"), userDir: home,
  }), null);
  const record = engine.makeRecord("audit", audit, root);
  const md = engine.renderReport(audit, { verbose: true });

  const types = new Set(audit.findings.map((f) => f.type));
  assert.ok(types.has("budget-exceeded") || types.has("budget-truncation"), "fixture never reached the cap");
  assert.equal(engine.validateRecord(record, "audit"), null);

  for (const f of audit.findings) {
    assert.ok(namedInMarkdown(md, f), "markdown never names finding " + f.id + " (" + f.type + ")");
  }
  // the two sections only this profile has
  assert.match(md, /## Instruction chain/);
  assert.match(md, /Chain total \d+ bytes against a documented \d+-byte cap/);
  assert.match(md, /## Maintainability/);
});

// ---------------------------------------------------------------------------
// "semantic analysis is optional and additive"
// ---------------------------------------------------------------------------

test("release gate: semantic analysis is optional and additive", () => {
  const files = {
    "CLAUDE.md": ["# Rules", "", CLEAN_RULE,
      "- Follow [the guide](docs/missing-guide.md) when editing handlers.",
      "- Write clean, maintainable code.", ""].join("\n"),
  };
  const withoutRoot = tmpProject(files);
  const withRoot = tmpProject(files);

  assert.equal(cli(withoutRoot, ["scan"]).code, 0);
  assert.equal(cli(withoutRoot, ["report", "--verbose"]).code, 0);

  const scanned = cli(withRoot, ["scan"]);
  assert.equal(scanned.code, 0);
  const keys = JSON.parse(scanned.out).judge.map((j) => j.key);
  const judgments = {};
  // Judgments inside the bands where no rule takes a model-inferred state, so
  // what the model said is present and the deterministic layer is untouched.
  for (const key of keys) judgments[key] = { F3: 0.7, F8: 0.7 };
  judgments._candidates = [{
    kind: "paraphrase-duplicate", keys: [keys[0]],
    summary: "Proposed.", reason: "Different words, one duty.", accepted: null,
  }];
  fs.writeFileSync(path.join(withRoot, ".assay-tmp", "judgments.json"), JSON.stringify(judgments));
  assert.equal(cli(withRoot, ["report", "--verbose"]).code, 0);

  const findingsOf = (root) => readJson(root, "audit.json").findings
    .map((f) => [f.type, f.state, f.severity, f.summary, JSON.stringify(f.sources)]);

  assert.deepEqual(findingsOf(withRoot), findingsOf(withoutRoot));
  assert.ok(findingsOf(withoutRoot).some((f) => f[1] === "blocked"), "fixture lost its hard gate");
  // the semantic pass is payload, and an audit without it still validates
  assert.equal(engine.validateRecord(readJson(withoutRoot, "audit.json"), "audit"), null);
  assert.ok(readJson(withRoot, "audit.json").semantic.candidates.length);
});

// ---------------------------------------------------------------------------
// "default analysis performs no mutation"
// ---------------------------------------------------------------------------

test("release gate: default analysis performs no mutation", () => {
  const root = tmpProject({
    "CLAUDE.md": CLEAN_CLAUDE,
    ".claude/rules/api.md": "- Validate every request body at the handler boundary.\n",
    ".claude/settings.json": '{ "hooks": {} }\n',
    "src/api/handler.ts": "export {};",
  });
  const before = snapshotTree(root);
  for (const args of [["scan"], ["report"], ["remeasure"], ["ci"], ["ci", "--json"]]) {
    const r = cli(root, args);
    assert.equal(r.code, 0, args.join(" ") + ": " + r.err);
  }
  assert.deepEqual(snapshotTree(root), before, "an analysis command wrote outside its own directories");
  // and the transaction state is never opened by a read-only run
  assert.equal(fs.existsSync(path.join(root, engine.STATE_DIR)), false);
  // `ci` goes further: it writes nothing at all, including its own directory
  const ciRoot = tmpProject({ "CLAUDE.md": CLEAN_CLAUDE });
  const listing = fs.readdirSync(ciRoot).sort();
  assert.equal(cli(ciRoot, ["ci"]).code, 0);
  assert.deepEqual(fs.readdirSync(ciRoot).sort(), listing);
});

// ---------------------------------------------------------------------------
// "every supported mutation is previewed, journaled, validated, and reversible"
// ---------------------------------------------------------------------------

const TX_CLAUDE = [
  "# Project rules", "",
  CLEAN_RULE,
  "- Always update the changelog when you touch a public API.",
  "",
].join("\n");

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

function txProject() {
  const root = tmpProject({ "CLAUDE.md": TX_CLAUDE });
  fs.writeFileSync(path.join(root, "draft.json"), JSON.stringify({ changes: [PROMOTE_CHANGE] }));
  return root;
}

test("release gate: every supported mutation is previewed, journaled and reversible", () => {
  const root = txProject();

  // previewed: the plan states the exact text before anything is written
  const planned = cli(root, ["plan", "--from", "draft.json"]);
  assert.equal(planned.code, 0, planned.err);
  const summary = JSON.parse(planned.out);
  const plan = JSON.parse(fs.readFileSync(
    path.join(root, engine.STATE_DIR, "plan-" + summary.planId + ".json"), "utf-8"));
  assert.equal(engine.validateRecord(plan, "plan"), null);
  const change = plan.changes.find((c) => c.id === "c-skill");
  assert.equal(change.patches[0].new, PROMOTE_CHANGE.patches[0].new);
  assert.equal(fs.existsSync(path.join(root, ".claude", "skills", "changelog", "SKILL.md")), false);

  // stale rejection: a file touched after planning is never patched over
  const stalePlan = txProject();
  assert.equal(cli(stalePlan, ["plan", "--from", "draft.json"]).code, 0);
  fs.writeFileSync(path.join(stalePlan, "CLAUDE.md"), TX_CLAUDE + "- One more rule.\n");
  const rewrite = {
    id: "c-rewrite", kind: "rule-rewrite", rationale: "why",
    patches: [{ path: "CLAUDE.md", old: CLEAN_RULE, new: "- Never use `var`; use `const`." }],
  };
  fs.writeFileSync(path.join(stalePlan, "draft2.json"), JSON.stringify({ changes: [rewrite] }));
  assert.equal(cli(stalePlan, ["plan", "--from", "draft2.json"]).code, 0);
  fs.writeFileSync(path.join(stalePlan, "CLAUDE.md"), TX_CLAUDE + "- Edited by someone else.\n");
  const stale = cli(stalePlan, ["apply", "--change", "c-rewrite"]);
  assert.equal(stale.code, 1);
  assert.match(stale.err, /Stale plan: CLAUDE\.md changed since change c-rewrite was planned/);

  // journaled: intent carries the pre-image and precedes the outcome
  assert.equal(cli(root, ["apply", "--change", "c-skill"]).code, 0);
  const rows = engine.readJournal(root);
  assert.deepEqual(rows.map((r) => r.event), ["intent", "outcome"]);
  assert.ok("preImage" in rows[0]);

  // validated, then reversible: the tree comes back byte for byte
  assert.equal(cli(root, ["validate", "--change", "c-skill"]).code, 0);
  assert.equal(cli(root, ["rollback", "--change", "c-skill"]).code, 0);
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), TX_CLAUDE);
  assert.equal(fs.existsSync(path.join(root, ".claude", "skills", "changelog", "SKILL.md")), false);
});

// The write that replaced a rule is never assay's to undo on the author's
// behalf: a plan adds the mechanism, `apply` writes it, and taking the prose out
// afterwards is the author's own edit — reversible through `rollback` like any
// other write this transaction made.
test("release gate: no command deactivates a source rule", () => {
  const root = txProject();
  assert.equal(cli(root, ["plan", "--from", "draft.json"]).code, 0);
  assert.equal(cli(root, ["apply", "--change", "c-skill"]).code, 0);
  assert.equal(cli(root, ["validate", "--change", "c-skill"]).code, 0);
  // the rule the skill replaced is still exactly where the author left it
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), TX_CLAUDE);
  assert.match(cli(root, ["validate", "--change", "c-skill"]).out, /source instruction is still active/);
});

// ---------------------------------------------------------------------------
// "public language does not imply static compliance prediction"
// ---------------------------------------------------------------------------

// Three phrasings, and only three: each one promises that reading a file
// predicts what a model will do, which is the claim SCOPE.md rules out. They
// are legitimate in a NEGATED sentence — "never a prediction that Claude will
// comply" is the disclosure itself — so a hit counts only when its sentence
// carries no negation. Keep this list small: a long one turns into a thesaurus
// nobody trusts, and the reviewable rule is "do not promise compliance".
const COMPLIANCE_PROMISES = [
  /will\s+(follow|comply|obey)/i,
  /guarantee[sd]?\s+compliance/i,
  /predict\w*[^.]{0,60}\bcompl/i,
];
const NEGATION = /\b(never|not|no|without|isn't|won't|cannot|can't|rather than)\b/i;

test("release gate: public language does not imply static compliance prediction", () => {
  // [Foreman: 165] `_shared` holds no SKILL.md — it holds the procedure the
  // model commands read, which is public text by the same argument.
  const skills = fs.readdirSync(path.join(PLUGIN_ROOT, "skills"))
    .filter((name) => name !== "_shared")
    .map((name) => path.join("skills", name, "SKILL.md"));
  const files = ["README.md", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json",
    "codex-skills/assay/SKILL.md", "skills/_shared/audit.md", "skills/_shared/fixes.md",
    ...skills];

  const offenders = [];
  for (const rel of files) {
    const full = path.join(PLUGIN_ROOT, rel);
    assert.ok(fs.existsSync(full), rel + " is missing — the guard is checking nothing");
    const text = fs.readFileSync(full, "utf-8");
    // sentence-shaped chunks, so a negation two paragraphs away never excuses a
    // promise here
    for (const sentence of text.split(/(?<=[.!?;])\s+|\n/)) {
      for (const promise of COMPLIANCE_PROMISES) {
        if (promise.test(sentence) && !NEGATION.test(sentence)) {
          offenders.push(rel + ": " + sentence.trim().slice(0, 120));
        }
      }
    }
  }
  assert.deepEqual(offenders, [], "public text promises compliance:\n" + offenders.join("\n"));

  // and the disclosure itself is present, not merely the absence of a promise
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf-8");
  assert.match(readme, /not a prediction that Claude will comply/);
});

// ---------------------------------------------------------------------------
// "the default report fits a screen, names a rule once, and needs no internals"
// ---------------------------------------------------------------------------

// [Foreman: 095] G1, G2 and G3 — the three properties that make the default
// report readable by someone who has never opened the host's documentation.
//
// They exist because taste does not survive a release cycle. Every section this
// report used to carry was added for a good reason and each one was individually
// right; together they turned an 18-rule project into a 140-line document. A
// budget is the only thing that makes the next finding compete for space instead
// of appending a section to the bottom.
//
// The fixture is deliberately noisy — rules that cannot load, pairs that argue,
// dead paths, many vague rules, several a script should own, buried ones, a file
// whose shape is the problem, a skill nobody can invoke and a subagent whose
// description says nothing. A gate measured on a quiet corpus guards nothing, so
// EVERY section of the report must render: `briefReport` asserts that before it
// hands the text to a gate.

const VAGUE = [
  "- Keep things tidy.", "- Be careful with the build.", "- Prefer clarity.",
  "- Do the right thing.", "- Try to keep functions small where you can.",
  "- Write clean, maintainable code.", "- Aim for good coverage.",
  "- Stay consistent.", "- Use sensible defaults.", "- Avoid surprises.",
];

const BRIEF_FIXTURE = {
  "CLAUDE.md": [
    "# Team rules",
    "",
    "- Never push to `origin` without review.",
    "- Always push to `origin` without review.",
    "- Never force-push to `release` without review.",
    "- Always force-push to `release` without review.",
    "- Read `docs/handbook.md` before you start.",
    "- Follow `docs/style-guide.md` on every change.",
    // Well-formed rules whose job belongs to a mechanism, not to prose — each
    // points at a file that exists, so nothing claims them before placement does.
    "- Run the `doc-reviewer` agent on every pull request before you merge it.",
    "- Run the `release-checker` agent on every tag before you publish it.",
    "- Before releasing, record the change in `CHANGELOG.md`.",
    "- Before publishing, note the new version in `docs/versions.md`.",
    "- Before merging, list the affected modules in `docs/impact.md`.",
    "- Follow the conventions in `docs/conventions.md` when you add a module.",
    ...VAGUE,
    "",
  ].join("\n"),
  "CHANGELOG.md": "# Changelog\n",
  "docs/conventions.md": "# Conventions\n",
  "docs/versions.md": "# Versions\n",
  "docs/impact.md": "# Impact\n",
  // `docs/handbook.md` above is cited but gone, and this is where it went — a
  // reference that merely MOVED is reported as fixable rather than as a rule the
  // host cannot apply, which is the one shape that reaches the stale bucket.
  "guides/handbook.md": "# Handbook\n",
  // A long file whose rules all sit in the bottom half — file shape, not wording.
  // [ADR 2026-08-05 D2] Kept over LONG_FILE_LINES on purpose: the narrative and
  // below-midpoint reasons are both length-gated now.
  ".claude/rules/shape.md": [
    "# Background",
    "",
    ...new Array(55).fill("Some narrative about why this project exists and how it grew."),
    "",
    ...VAGUE.slice(0, 6),
    "",
  ].join("\n"),
  ".claude/rules/orphan.md": [
    "---",
    "paths:",
    "  - '**/*.nothing-matches-this'",
    "---",
    "",
    "- Always double-check the generated output.",
    "- Always review the generated report.",
    "",
  ].join("\n"),
  ".claude/skills/ghost/SKILL.md":
    "---\nname: ghost\ndescription: Does a thing.\ndisable-model-invocation: true\nuser-invocable: false\n---\n",
  ".claude/agents/mute.md":
    "---\nname: mute\ndescription: Reviews things.\n---\n\nReviews things.\n",
  ".claude/agents/quiet.md":
    "---\nname: quiet\ndescription: Handles the build.\n---\n\nHandles the build.\n",
  ".claude/agents/still.md":
    "---\nname: still\ndescription: Looks at code.\n---\n\nLooks at code.\n",
};

function briefReport() {
  const root = tmpProject(BRIEF_FIXTURE);
  const scan = cli(root, ["scan"]);
  assert.equal(scan.code, 0, scan.err);
  // No judgments file on purpose: the default run is deterministic, and the
  // gates must hold on the report a user gets without spending a model call.
  const report = cli(root, ["report"]);
  assert.equal(report.code, 0, report.err);
  const out = report.out.replace(/\n$/, "");
  // [Foreman: 095] The anti-vacuity check. A gate that passes because a section
  // never rendered is worse than no gate, so the fixture must exercise all of
  // them, and this fails loudly the day one stops firing.
  for (const section of ["## Fix these first", "## Could be automatic instead", "## Also worth a look"]) {
    assert.ok(out.includes(section), `gate fixture no longer renders "${section}" — the gates below would be vacuous:\n` + out);
  }
  assert.match(out, /the host never loads it/, "gate fixture no longer produces a rule that cannot load:\n" + out);
  // [Foreman: 097] The provenance line is part of the worst case now, so the
  // budget is still measured with it present.
  assert.match(out, /^Read `/m, "gate fixture no longer prints what the run read:\n" + out);
  assert.match(out, /Did not check:/, "gate fixture no longer discloses a skipped check:\n" + out);
  assert.match(out, /point at files that aren't there/, "gate fixture no longer separates dead paths from wording:\n" + out);
  assert.match(out, /two rules disagree/, "gate fixture no longer produces a conflicting pair:\n" + out);
  assert.match(out, /which is not there/, "gate fixture no longer produces a dead reference:\n" + out);
  assert.match(out, /more not shown here/, "gate fixture no longer overflows the fix table:\n" + out);
  // Each cap is asserted where it lives. One shared "…and N more" match would be
  // satisfied by whichever list happened to overflow, which is how a fixture
  // stops measuring the worst case without anything going red.
  for (const name of ["Could be automatic instead", "Also worth a look"]) {
    const body = out.split("## " + name)[1].split("\n## ")[0];
    assert.match(body, /…and \d+ more/, `gate fixture no longer overflows the "${name}" list, so G1 is measuring less than the worst case:\n` + out);
  }
  return out;
}

// [Foreman: 097] The same fixture through `--verbose`. The full report is the
// one a reader is sent to when the short one is not enough, so its own limits
// are asserted here rather than left to taste.
function fullReport() {
  const root = tmpProject(BRIEF_FIXTURE);
  assert.equal(cli(root, ["scan"]).code, 0);
  const report = cli(root, ["report", "--verbose"]);
  assert.equal(report.code, 0, report.err);
  return report.out.replace(/\n$/, "");
}

// [Foreman: 097] The full report had no budget at all and had grown to 450 lines
// on this fixture, 29% of it one sentence repeated once per mechanism and 23% a
// table of rules the reader does not own. Deleting the repetition took it to 214.
// The budget is 220 rather than a rounder number on purpose: what is left is one
// line per rule and one per finding, so the next 20 lines have to come out of
// CONTENT, and that is a decision to take deliberately rather than by drift.
const REPORT_MAX_LINES = 220;

test("release gate: the full report has a line budget too", () => {
  const lines = fullReport().split("\n");
  assert.ok(lines.length <= REPORT_MAX_LINES,
    `the full report is ${lines.length} lines on the gate fixture, budget is ${REPORT_MAX_LINES}:\n` + lines.join("\n"));
});

test("release gate G1: the default report fits on a screen", () => {
  const lines = briefReport().split("\n");
  assert.ok(
    lines.length <= engine.BRIEF_MAX_LINES,
    `default report is ${lines.length} lines, budget is ${engine.BRIEF_MAX_LINES}:\n` + lines.join("\n"),
  );
  // Every section renders and all three caps overflow — `briefReport` asserts
  // both — so this is the structural maximum for the sections that exist today,
  // and the slack below is what a new section would have to fit inside. The
  // bound is a backstop; the per-cap assertions above are the real guard.
  assert.ok(
    lines.length >= engine.BRIEF_MAX_LINES - 6,
    `the gate fixture only reaches ${lines.length} of ${engine.BRIEF_MAX_LINES} lines, so it no longer measures the worst case — a new section could be added without G1 noticing:\n` + lines.join("\n"),
  );
});

test("release gate G2: the default report names a rule once", () => {
  const out = briefReport();
  // A rule is addressed as `path:line` in every view. Section headings split the
  // report; a location appearing under two of them is the repetition this gate
  // exists to stop. A bare file link carries no line and is a file, not a rule.
  const seen = new Map();
  const offenders = [];
  let section = "(top)";
  for (const line of out.split("\n")) {
    const heading = /^#{2,3} (.+)/.exec(line);
    if (heading) { section = heading[1]; continue; }
    for (const m of line.matchAll(/\]\(([^)\s]+):(\d+)\)/g)) {
      const at = m[1] + ":" + m[2];
      const first = seen.get(at);
      if (first === undefined) seen.set(at, section);
      else if (first !== section) offenders.push(`${at} appears under "${first}" and "${section}"`);
    }
  }
  assert.deepEqual(offenders, [], "a rule is reported twice:\n" + offenders.join("\n"));
});

// [Foreman: 097] G3′. The fix menu is read by the same person as the report, in
// the same breath, and it had never been through the report's own word list —
// "quality floor", "plan artifact", "placement candidate", "park". The labels are
// the sentences the user is asked to choose between, so they are held to the
// same bar as the page above them.
test("release gate G3': the fix menu uses no word that needs host internals", () => {
  const skill = fs.readFileSync(SHARED_AUDIT, "utf-8");
  const menu = skill.split("## 4. Offer fixes")[1].split("\n## ")[0];
  assert.ok(menu, "the audit skill no longer has a fix menu — this gate is checking nothing");
  // The option labels and the sentence the user reads beside each one.
  const labels = [...menu.matchAll(/^- `([^`]+)`[^\n]*?— "([^"]+)"/gm)].map((m) => m[1] + " — " + m[2]);
  assert.ok(labels.length >= 4, "the menu no longer offers labelled options:\n" + menu);
  const offenders = [];
  for (const label of labels) {
    for (const word of engine.BRIEF_BANNED_WORDS) {
      const re = new RegExp("\\b" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
      if (re.test(label)) offenders.push(word + " in: " + label);
    }
    // the two the menu invented for itself
    if (/\bquality floor\b|\bplan artifact\b/i.test(label)) offenders.push("menu jargon in: " + label);
  }
  assert.deepEqual(offenders, [], "the fix menu needs host internals:\n" + offenders.join("\n"));
});

test("release gate G3: the default report uses no word that needs host internals", () => {
  const out = briefReport();
  const offenders = [];
  for (const word of engine.BRIEF_BANNED_WORDS) {
    const re = new RegExp("\\b" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (re.test(out)) offenders.push(word);
  }
  // The factor codes are the rubric's own vocabulary and never the reader's.
  if (/\bF[1-8]\b/.test(out)) offenders.push("F1-F8 factor codes");
  // Evidence tags are the full report's contract, not the short one's.
  if (/\[(mechanical|heuristic|model-inferred|experiment-supported)/.test(out)) offenders.push("evidence tags");
  assert.deepEqual(offenders, [], "default report needs host internals:\n" + out);
});

// [Foreman: 097] The full report is where a confused reader is SENT. It may name
// an evidence level and a host profile — showing those is what it is for — but it
// may not invent a second name for something the short report already said in
// plain words, and it must carry a contents list so twenty sections are one
// glance rather than a scroll.
test("release gate: the full report keeps the plainer word and says what is in it", () => {
  const out = fullReport();
  const offenders = [];
  for (const word of engine.REPORT_BANNED_WORDS) {
    const re = new RegExp("\\b" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (re.test(out)) offenders.push(word);
  }
  assert.deepEqual(offenders, [], "the full report renames what the short one says plainly:\n" + offenders.join("\n"));
  assert.match(out, /^Below: .+·.+\.$/m, "the full report carries no contents list:\n" + out);
  // and the two reports agree on what is wrong with a rule
  assert.match(out, /too vague to act on|leaves? the standard to the reader/, out);
});

// ---------------------------------------------------------------------------
// "the default report never contradicts the analysis behind it"
// ---------------------------------------------------------------------------

// [Foreman: 097] G4. Every row about a rule the host cannot apply is built from
// that rule's own finding — its summary and its first safe action — never from a
// sentence written into the renderer. The rule this exists for: `blocked` shared
// a bucket with `inactive` and inherited its words, so a rule that loads
// perfectly was reported as one the host never reads, with a repair that could
// not fix it. A literal in that cell cannot be kept honest as states are added.
test("release gate G4: no row in the default report contradicts its own finding", () => {
  const root = tmpProject({
    // one of each hard-gate shape, plus the state that used to borrow their words
    "CLAUDE.md": "# Rules\n\n- Always follow `docs/gone.md` when you edit a handler.\n",
    ".claude/rules/orphan.md": "---\npaths:\n  - '**/*.no-such-extension'\n---\n\n- Always double-check the generated output.\n",
    ".claude/CLAUDE.md": "# Shadowed\n\n- Always run the whole suite before you tag a release.\n",
  });
  assert.equal(cli(root, ["scan"]).code, 0);
  const audit = JSON.parse(fs.readFileSync(path.join(root, ".assay-tmp", "scan.json"), "utf-8"));
  const composed = engine.composeAudit(audit, null);
  const out = engine.renderBrief(composed);

  const gates = composed.findings.filter((f) => engine.FINDING_STATES.includes(f.state) &&
    ["inactive", "shadowed"].includes(f.state));
  assert.ok(gates.length >= 2, "the fixture stopped producing rules the host cannot apply:\n" + out);
  for (const f of gates) {
    const rule = composed.rules.find((r) => r.id === f.rule);
    const row = out.split("\n").find((l) => l.startsWith("| ") && l.includes(rule.file + ":" + rule.lineStart));
    if (!row) continue; // capped out of the table, which is the one honest omission
    assert.ok(row.includes(f.summary), "a gated row does not carry its finding's own words:\n" + row + "\n" + f.summary);
    assert.ok(row.toLowerCase().includes(String(f.safeActions[0]).toLowerCase()),
      "a gated row does not carry its finding's own next step:\n" + row + "\n" + f.safeActions[0]);
  }
  // and the sentence that used to be printed for all three states is gone
  assert.doesNotMatch(out, /never reaches the assistant/,
    "the renderer is writing its own diagnosis again:\n" + out);

  // a rule citing a missing file LOADS — it must never be counted as one the
  // host does not read
  const blocked = composed.findings.filter((f) => f.state === "blocked");
  assert.ok(blocked.length >= 1, "the fixture stopped producing a dead reference:\n" + out);
  const counted = Number((/\*\*(\d+) rules? never loads?\.\*\*/.exec(out) || [])[1] || 0);
  assert.equal(counted, gates.length,
    "the headline counts a rule that loads among the rules that do not:\n" + out);
  assert.match(out, /points at `docs\/gone\.md`, which is not there/, out);
});

// [Foreman: 097] G5. A whole class of check that did not run is disclosed in the
// DEFAULT report, in its own words. Silence used to be indistinguishable from a
// clean result: a deterministic run, a corpus past the pairing cap and an
// unreadable file all produced the same confident page.
test("release gate G5: a check class that did not run says so in the default report", () => {
  // deterministic — no judgments file at all
  const plain = tmpProject({ "CLAUDE.md": "# Rules\n\n- Always run `npm test` before you open a pull request.\n" });
  assert.equal(cli(plain, ["scan"]).code, 0);
  const deterministic = cli(plain, ["report"]).out;
  assert.match(deterministic, /Did not check:.*whether a script could do the job instead/, deterministic);

  // past the pairing cap — duplicate and conflict detection do not run
  const many = ["# Rules", ""];
  for (let i = 0; i < 520; i++) many.push(`- Always run \`npm run task${i}\` when you edit \`src/mod${i}.ts\`.`);
  const big = tmpProject({ "CLAUDE.md": many.join("\n") + "\n" });
  assert.equal(cli(big, ["scan"]).code, 0);
  const capped = cli(big, ["report"]).out;
  assert.match(capped, /Did not check:.*whether any two rules repeat or disagree/, capped);

  // a file the host loads and assay could not open
  const unread = tmpProject({ "CLAUDE.md": "# Rules\n\nSee @docs/style-guide.md for the rest.\n\n- Always run `npm test` first.\n" });
  assert.equal(cli(unread, ["scan"]).code, 0);
  const missing = cli(unread, ["report"]).out;
  assert.match(missing, /Could not read `docs\/style-guide\.md`/, missing);

  // and a project with no rules is never congratulated
  const empty = tmpProject({});
  assert.equal(cli(empty, ["scan"]).code, 0);
  const nothing = cli(empty, ["report"]).out;
  assert.match(nothing, /No rules to look at yet/, nothing);
  assert.doesNotMatch(nothing, /Nothing here needs fixing/, nothing);
});

// [Foreman: 097] G6. A file that loads for a session here but is not in the
// checkout — the reader's own instruction files, a `CLAUDE.md` above the root,
// the assistant's auto-memory notes — is reported and never gates. It cannot
// reach the project's fix list, the headcount the grade averages, or a CI exit
// code, because nothing anyone does inside this repository would change it.
test("release gate G6: a finding outside the repository never gates", () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "assay-gate-scope-"));
  const memory = path.join(userDir, "projects");
  fs.mkdirSync(path.join(userDir, "rules"), { recursive: true });
  // an auto-memory index whose dated note cites a file that is long gone
  const project = tmpProject({ "CLAUDE.md": "# Rules\n\n- Always run `npm test` before you open a pull request.\n" });
  const slug = project.replace(/[\\/:]/g, "-");
  const memDir = path.join(memory, slug, "memory");
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, "MEMORY.md"),
    "---\nname: index\nmetadata:\n  node_type: memory\n---\n\n# Memory\n\n- Closed the gate in `scripts/long-gone.js` on 2026-07-28.\n");
  fs.writeFileSync(path.join(userDir, "CLAUDE.md"), "# Mine\n\n- Always follow `docs/personal-gone.md` when you refactor.\n");

  const env = { ...process.env, ASSAY_USER_DIR: userDir };
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args, "--root", project], { encoding: "utf-8", env });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  // nothing outside the checkout can stop a build
  const gated = run("ci");
  assert.equal(gated.code, 0, gated.out + gated.err);
  assert.match(gated.out, /gated findings: none/, gated.out);
  assert.match(gated.out, /outside this repository: \d+ file\(s\)/, gated.out);

  assert.equal(run("scan").code, 0);
  const brief = run("report").out;
  // the project's own denominator, and the count that reconciles it with the scan
  assert.match(brief, /Looked at 1 rule in 1 file\./, brief);
  assert.match(brief, /more rules? loads? from outside this repo/, brief);

  const audit = engine.composeAudit(
    JSON.parse(fs.readFileSync(path.join(project, ".assay-tmp", "scan.json"), "utf-8")), null);
  const outsidePaths = new Set(audit.files
    .filter((f) => f.scope === "user" || f.scope === "ancestor" || f.autoMemory).map((f) => f.path));
  assert.ok(outsidePaths.size >= 2, "the fixture stopped loading files from outside the repo");

  // a dated note is a record, not a rule leaning on a path
  for (const f of audit.findings) {
    const at = (f.sources || [])[0];
    if (!at || !outsidePaths.has(at.path)) continue;
    assert.notEqual(f.type, "stale-shared-target");
    if (/memory[\\/]MEMORY\.md$/.test(at.path)) {
      assert.notEqual(f.state, "blocked", "an auto-memory note was graded as a rule with a dead path: " + f.summary);
    }
  }
  const full = engine.renderReport(audit, { verbose: true });
  // nothing outside the checkout opens the report as a hard gate
  const hardGates = full.split("## Hard gates")[1].split("\n## ")[0];
  for (const p of outsidePaths) {
    assert.ok(!hardGates.includes(p), "a file outside the repo reached Hard gates:\n" + hardGates);
  }
  assert.doesNotMatch(full.split("### Restructure candidates")[1] || "", /projects[\\/]/,
    "restructure advice names a file this repository does not own:\n" + full);
  // the headcount is what the grade beside it averages
  const headcount = /\*\*(\d+) rules across (\d+) file\(s\)\*\*/.exec(full);
  assert.ok(headcount, full);
  assert.equal(Number(headcount[1]), 1, "the headcount counts rules the grade never saw:\n" + headcount[0]);
});


// [Foreman: 164] G7. The plain report is the page the auto-fix flow puts in
// front of the owner before it opens a transaction on their files. A page they
// have to scroll to reach the approval line is a page they approve without
// reading, so its budget is far tighter than the short report's — and a rule
// named twice inside 25 lines spends a large part of the page saying one thing.
//
// The fixture is the brief report's, plus the two rules whose own wording names
// a lifecycle moment. Without them the closing block has no hook to name and
// this gate would be measuring an empty list.
const PLAIN_FIXTURE = {
  ...BRIEF_FIXTURE,
  "CLAUDE.md": BRIEF_FIXTURE["CLAUDE.md"] + [
    "- Before pushing, record the change in `docs/pushed.md`.",
    "- After each edit, note the change in `docs/notes.md`.",
    "",
  ].join("\n"),
  "docs/pushed.md": "# Pushed\n",
  "docs/notes.md": "# Notes\n",
};

function plainReport() {
  const root = tmpProject(PLAIN_FIXTURE);
  assert.equal(cli(root, ["scan"]).code, 0);
  const report = cli(root, ["report", "--plain"]);
  assert.equal(report.code, 0, report.err);
  const out = report.out.replace(/\n$/, "");
  // The anti-vacuity check, same discipline as `briefReport`: every part this
  // gate measures has to render, or the assertions below pass on an empty page.
  assert.match(out, /points at .+, which is not there/, "the fixture no longer produces a dead path:\n" + out);
  assert.match(out, /ask for opposite things/, "the fixture no longer produces a conflicting pair:\n" + out);
  // Worst first, mechanically: a rule the host never reads at all opens the
  // page, ahead of every disagreement, dead path and wording problem below it.
  assert.match(out.split("\n")[2], /is never read by the assistant/,
    "the plain report no longer leads with the worst finding it has:\n" + out);
  assert.match(out, /and \d+ more, smaller than these\./, "the fixture no longer overflows the item cap, so the budget is not measured at its worst case:\n" + out);
  assert.match(out, /^About to be installed:$/m, "the plain report no longer closes with what it is about to install:\n" + out);
  return out;
}

test("release gate G7: the plain report fits above a prompt and names each rule once", () => {
  const out = plainReport();
  const lines = out.split("\n");
  assert.ok(lines.length <= engine.PLAIN_MAX_LINES,
    `the plain report is ${lines.length} lines on the gate fixture, budget is ${engine.PLAIN_MAX_LINES}:\n` + out);

  // Every hook in the closing block is named by BOTH halves of what installs it.
  // An event with no matcher is a hook that fires on everything, and the reader
  // approving the install is entitled to know which one they are getting.
  const hooks = lines.filter((l) => /^- a hook on /.test(l));
  assert.ok(hooks.length >= 2, "the fixture no longer proposes hooks on two different events:\n" + out);
  for (const h of hooks) {
    assert.match(h, /^- a hook on \w+, matching \S+ — covers \d+ rules?\.$/, "a hook is listed without its event and matcher: " + h);
  }

  // A rule is addressed as `path:line`, so the same address on two lines is the
  // repetition this gate exists to stop.
  const seen = new Map();
  const offenders = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(?:^|[\s(])([\w./\-]+):(\d+)\b/g)) {
      const at = m[1] + ":" + m[2];
      if (seen.has(at)) offenders.push(`${at} is named on line ${seen.get(at) + 1} and again on line ${i + 1}`);
      else seen.set(at, i);
    }
  });
  assert.deepEqual(offenders, [], "a rule is named twice in the plain report:\n" + offenders.join("\n") + "\n" + out);
  assert.ok(seen.size >= 8,
    `the fixture names only ${seen.size} rules, so the repeat check is measuring almost nothing:\n` + out);

  // No factor codes and no grade: this page is a list of decisions about to be
  // taken, not a verdict on the project.
  const jargon = [];
  if (/\bF[1-8]\b/.test(out)) jargon.push("F1-F8 factor codes");
  if (/\bgrades?\b/i.test(out)) jargon.push("a grade");
  // Every entry in this list is a plain word, so it needs no escaping.
  for (const word of engine.BRIEF_BANNED_WORDS) {
    if (new RegExp("\\b" + word + "\\b", "i").test(out)) jargon.push(word);
  }
  assert.deepEqual(jargon, [], "the plain report needs host internals:\n" + out);
});

// ---------------------------------------------------------------------------
// "installation and fresh-session end-to-end tests pass"
// ---------------------------------------------------------------------------

test("release gate: installation and fresh-session end-to-end", () => {
  // Installed shape: the analyzer lives under a plugin root somewhere else on
  // the machine, and the session starts in a directory that is not the project.
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "assay-gate-install-"));
  const installed = path.join(installRoot, "plugins", "assay", "scripts");
  fs.cpSync(path.join(PLUGIN_ROOT, "scripts"), installed, { recursive: true });
  const installedCli = path.join(installed, "assay.js");
  const startup = fs.mkdtempSync(path.join(os.tmpdir(), "assay-gate-startup-"));

  const project = tmpProject({
    "CLAUDE.md": ["# Project rules", "", CLEAN_RULE, "- Write clean, maintainable code.", ""].join("\n"),
    ".claude/rules/api.md": '---\npaths: ["src/**/*.ts"]\n---\n\n- Validate every request body at the handler boundary.\n',
    "src/api/handler.ts": "export {};",
  });

  const run = (...args) => {
    const r = spawnSync(process.execPath, [installedCli, ...args, "--root", project],
      { cwd: startup, encoding: "utf-8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  const scanned = run("scan");
  assert.equal(scanned.code, 0, scanned.err);
  const summary = JSON.parse(scanned.out);
  assert.equal(summary.fileCount, 2);
  assert.equal(summary.judge.length, 3);

  const judgments = {};
  for (const j of summary.judge) judgments[j.key] = { F3: 0.7, F8: 0.9 };
  fs.writeFileSync(path.join(project, ".assay-tmp", "judgments.json"), JSON.stringify(judgments));

  const reported = run("report", "--verbose");
  assert.equal(reported.code, 0, reported.err);
  assert.match(reported.out, /# Rule audit — /);
  assert.match(reported.out, /Write clean, maintainable code\./);

  // the startup directory is untouched: nothing was written where the session
  // happened to begin, and nothing was written into the installed plugin either
  assert.deepEqual(fs.readdirSync(startup), []);
  assert.deepEqual(fs.readdirSync(installed).sort(), fs.readdirSync(path.join(PLUGIN_ROOT, "scripts")).sort());

  // and the record names the directory the analysis is about. The CLI fixes the
  // startup directory at the project root — `cmdScan` states that ceiling — so
  // this is the contract, not an accident of where the process happened to run.
  const record = readJson(project, "scan.json");
  assert.equal(path.resolve(record.context.projectRoot), path.resolve(project));
  assert.equal(record.context.startupDirectory, record.context.projectRoot);
});

// ---------------------------------------------------------------------------
// CLI and schema
// ---------------------------------------------------------------------------

test("release gate: every public command and its exit codes", () => {
  // Success, in the order a real session takes them: each row is one command,
  // its arguments, and the code the contract promises.
  const root = tmpProject({ "CLAUDE.md": TX_CLAUDE });
  fs.writeFileSync(path.join(root, "draft.json"), JSON.stringify({ changes: [PROMOTE_CHANGE] }));

  const SUCCESS = [
    [["scan"], "reads the project and writes scan.json"],
    [["report"], "composes the audit from the scan"],
    [["remeasure"], "re-scans and compares against the prior audit"],
    [["ci"], "gates a clean project"],
    [["plan", "--from", "draft.json"], "canonicalizes a draft into a plan"],
    [["apply", "--change", "c-skill"], "writes only the named change"],
    [["validate", "--change", "c-skill"], "records validation evidence"],
    [["rollback", "--change", "c-skill"], "puts every write back"],
    [["clean"], "removes the disposable directory"],
  ];
  const seen = new Set();
  for (const [args, why] of SUCCESS) {
    const r = cli(root, args);
    assert.equal(r.code, 0, args.join(" ") + " (" + why + "): " + r.err);
    seen.add(args[0]);
  }

  // Usage errors, one per command, from a project with no state at all.
  const bare = tmpProject({ "CLAUDE.md": CLEAN_CLAUDE });
  const USAGE = [
    [["scan", "--host", "nope"], /Unknown host: nope/],
    [["report"], /run `scan` first|scan\.json/],
    [["remeasure", "--verbse"], /Unknown flag: --verbse/],
    [["clean", "--nope"], /Unknown flag: --nope/],
    [["plan", "--from", "absent.json"], /No draft plan at absent\.json/],
    [["apply", "--change", "nope"], /no plan in \.assay\/ defines change nope/],
    [["validate", "--change", "nope"], /no plan in \.assay\/ defines change nope/],
    [["rollback", "--change", "nope"], /No change nope in \.assay\/journal\.jsonl/],
    [["ci", "--fail-on", "at-risk"], /The gate set is closed/],
  ];
  for (const [args, pattern] of USAGE) {
    const r = cli(bare, args);
    assert.equal(r.code, 1, args.join(" ") + " should be a usage error, got " + r.code);
    assert.match(r.err, pattern, args.join(" "));
    seen.add(args[0]);
  }
  assert.equal(cli(bare, ["nonsense"]).code, 1);
  assert.equal(cli(bare, []).code, 1);

  // exit 2 is `ci` and only `ci`: a gate failed, which is not a broken invocation
  const gated = tmpProject({
    "CLAUDE.md": "# Rules\n\n- Follow [the guide](docs/missing-guide.md) when editing handlers.\n",
  });
  const failed = cli(gated, ["ci"]);
  assert.equal(failed.code, engine.CI_EXIT_GATE_FAILED);
  assert.equal(failed.code, 2);
  assert.match(failed.out, /^gated findings: 1 \(stale-targets 1\)$/m);

  // every public command appeared in the matrix
  assert.deepEqual([...seen].sort(), ["apply", "ci", "clean", "plan",
    "remeasure", "report", "rollback", "scan", "validate"]);
});

test("release gate: schema versioning rejects an older record by name and round-trips the current one", () => {
  const root = tmpProject({ "CLAUDE.md": CLEAN_CLAUDE });
  assert.equal(cli(root, ["scan"]).code, 0);
  assert.equal(cli(root, ["report", "--verbose"]).code, 0);

  // the current record round-trips: written, re-read, still valid, same schema
  for (const [name, kind] of [["scan.json", "scan"], ["audit.json", "audit"]]) {
    const record = readJson(root, name);
    assert.equal(record.schemaVersion, engine.SCHEMA_VERSION);
    assert.equal(engine.validateRecord(record, kind), null, name);
    assert.equal(engine.validateRecord(JSON.parse(JSON.stringify(record)), kind), null, name + " round-trip");
  }

  // an older record is refused, and the version found is named in the refusal
  const scanFile = path.join(root, ".assay-tmp", "scan.json");
  const current = readJson(root, "scan.json");
  const { schemaVersion, analyzer, parser, profile, context, ...payload } = current;
  fs.writeFileSync(scanFile, JSON.stringify(payload));
  const preOne = cli(root, ["report", "--verbose"]);
  assert.equal(preOne.code, 1);
  assert.match(preOne.err, /scan\.json is not a schema 1 scan record \(found schema pre-1\) — rerun `assay\.js scan` to replace it\./);

  fs.writeFileSync(scanFile, JSON.stringify({ ...current, schemaVersion: 0 }));
  const zero = cli(root, ["report", "--verbose"]);
  assert.equal(zero.code, 1);
  assert.match(zero.err, /found schema 0/);
});

test("release gate: an interrupted run leaves a partial artifact that fails cleanly", () => {
  const noStack = (err) => {
    assert.doesNotMatch(err, /^\s+at /m, "a stack trace reached the user:\n" + err);
    assert.doesNotMatch(err, /^[A-Za-z]*Error: /m, "an unhandled error reached the user:\n" + err);
  };

  // A scan killed mid-write leaves a truncated record. The next command names
  // the file and says what to do, rather than throwing JSON at the user.
  const root = tmpProject({ "CLAUDE.md": CLEAN_CLAUDE });
  assert.equal(cli(root, ["scan"]).code, 0);
  const scanFile = path.join(root, ".assay-tmp", "scan.json");
  const whole = fs.readFileSync(scanFile, "utf-8");
  fs.writeFileSync(scanFile, whole.slice(0, Math.floor(whole.length * 0.6)));
  const partial = cli(root, ["report", "--verbose"]);
  assert.equal(partial.code, 1);
  assert.match(partial.err, /\.assay-tmp\/scan\.json is not a schema 1 scan record \(not valid JSON/);
  assert.match(partial.err, /rerun `assay.js scan`/);
  noStack(partial.err);

  // A journal killed mid-append leaves a torn final line. That one IS an
  // interrupted write and is resolvable, not an error.
  const tx = txProject();
  assert.equal(cli(tx, ["plan", "--from", "draft.json"]).code, 0);
  assert.equal(cli(tx, ["apply", "--change", "c-skill"]).code, 0);
  const journal = path.join(tx, engine.STATE_DIR, engine.JOURNAL_FILE);
  const rows = fs.readFileSync(journal, "utf-8");
  fs.writeFileSync(journal, rows.slice(0, rows.length - 30));
  const torn = cli(tx, ["rollback", "--change", "c-skill"]);
  assert.equal(torn.code, 0, torn.err);
  assert.match(torn.out, /interrupted apply resolved/);

  // A torn line with rows BEHIND it is damage, not an interruption: the journal
  // holds the only copy of the pre-images, so it refuses to be read silently.
  const damaged = txProject();
  assert.equal(cli(damaged, ["plan", "--from", "draft.json"]).code, 0);
  assert.equal(cli(damaged, ["apply", "--change", "c-skill"]).code, 0);
  const file = path.join(damaged, engine.STATE_DIR, engine.JOURNAL_FILE);
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  assert.ok(lines.length >= 2, "the fixture needs a row after the damaged one");
  lines[0] = lines[0].slice(0, 40);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const corrupt = cli(damaged, ["rollback", "--change", "c-skill"]);
  assert.equal(corrupt.code, 1);
  assert.match(corrupt.err, /\.assay\/journal\.jsonl is damaged: line 1 of \d+ is not valid JSON/);
  assert.match(corrupt.err, /holds the only copy of the files as they were/);
  noStack(corrupt.err);
});

// ---------------------------------------------------------------------------
// The Codex profile's additional required fixtures
// ---------------------------------------------------------------------------

// SCOPE.md names eight fixtures the Codex profile additionally requires. Each
// was built in its own entry; the gate re-asserts each once, end to end, so the
// checklist is one file rather than a reading list.
test("release gate: the Codex profile's required fixtures", () => {
  const codex = engine.ADAPTERS.codex;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "assay-gate-codexhome2-"));
  fs.writeFileSync(path.join(home, "config.toml"),
    'project_doc_fallback_filenames = ["TEAM_GUIDE.md"]\nproject_doc_max_bytes = 500\n');
  const ctx = (root, extra) => codex.detectContext({ root, projectOnly: true, codexHome: home, ...extra });

  // 1. AGENTS.md and AGENTS.override.md selection
  const selection = tmpProject({
    "AGENTS.override.md": "- Always run `npm test` before committing.\n",
    "AGENTS.md": "- Never use `var`.\n",
  });
  const selected = codex.discoverSources(ctx(selection)).sources;
  assert.deepEqual(selected.map((s) => s.path), ["AGENTS.override.md", "AGENTS.md"]);
  assert.equal(selected[1].shadowedBy, "AGENTS.override.md");

  // 2. configured fallback names
  const fallback = tmpProject({ "TEAM_GUIDE.md": "- Use `const` for locals.\n", "HOUSE.md": "- Never use `var`.\n" });
  const fell = codex.discoverSources(ctx(fallback)).sources;
  assert.deepEqual(fell.map((s) => s.path), ["TEAM_GUIDE.md"]);

  // 3. root-to-startup-directory precedence
  const chain = tmpProject({ "AGENTS.md": "- Never use `var`.\n", "svc/AGENTS.md": "- Return typed errors.\n" });
  const chained = codex.discoverSources(ctx(chain, { startup: path.join(chain, "svc") })).sources;
  assert.deepEqual(chained.map((s) => s.path), ["AGENTS.md", "svc/AGENTS.md"]);
  assert.ok(chained[1].precedence > chained[0].precedence);

  // 4. combined byte limits
  const big = "# Big\n\n" + Array.from({ length: 20 },
    (_, i) => "- Always validate request body number " + i + " at the boundary.").join("\n") + "\n";
  const capped = tmpProject({ "AGENTS.md": big, "svc/AGENTS.md": big });
  const cappedScan = engine.scan(capped, {
    adapter: codex, projectOnly: true, startup: path.join(capped, "svc"), userDir: home,
  });
  assert.equal(cappedScan.files[0].truncated, true);
  assert.equal(cappedScan.files[1].loaded, false);
  const cappedAudit = engine.composeAudit(cappedScan, null);
  assert.ok(cappedAudit.findings.some((f) => f.type === "budget-truncation"));
  assert.ok(cappedAudit.findings.some((f) => f.type === "budget-exceeded"));

  // 5. `.agents/skills` discovery and collective listing pressure — eight
  // descriptions, none over any per-skill cap, that overrun the shared budget
  const skillFiles = { "AGENTS.md": "- Never use `var`.\n" };
  for (let i = 0; i < 8; i++) {
    skillFiles[`.agents/skills/step-${i}/SKILL.md`] =
      `---\nname: step-${i}\ndescription: >-\n  ` + `Runs step ${i} of the release. `.repeat(45) + "\n---\n\nSteps.\n";
  }
  const skillsRoot = tmpProject(skillFiles);
  const skillsScan = engine.scan(skillsRoot, { adapter: codex, projectOnly: true, userDir: EMPTY_CODEX_HOME });
  assert.equal(skillsScan.skills.length, 8);
  const skillsAudit = engine.composeAudit(skillsScan, null);
  const listing = skillsAudit.findings.filter((f) => f.type === "skill-listing-budget");
  assert.equal(listing.length, 1, "the collective skill-listing budget is not reported");
  assert.match(listing[0].summary, /against a documented \d+-character budget/);

  // 6. agents/openai.yaml
  const sidecar = tmpProject({
    "AGENTS.md": "- Never use `var`.\n",
    ".agents/skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Ships the service. Use when the user asks to deploy.\n---\n\nSteps.\n",
    ".agents/skills/deploy/agents/openai.yaml": "policy:\n  allow_implicit_invocation: false\n",
  });
  const sidecarScan = engine.scan(sidecar, { adapter: codex, projectOnly: true, userDir: EMPTY_CODEX_HOME });
  assert.equal(sidecarScan.skills[0].metadataPath, ".agents/skills/deploy/agents/openai.yaml");
  assert.equal(sidecarScan.skills[0].metadata.allowImplicitInvocation, false);

  // 7. hook configuration and trust
  const hooked = tmpProject({
    "AGENTS.md": "- Never use `var`.\n",
    ".codex/hooks.json": JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "guard.js" }] }] },
    }),
  });
  const hooks = codex.discoverHooks(ctx(hooked)).hooks;
  assert.ok(hooks.length >= 1, "the documented project hook source was not read");
  // trust is the host's record, not a file this profile can read, so every
  // non-managed hook says so rather than claiming it runs
  for (const h of hooks) assert.match(JSON.stringify(h), /trust/i);

  // 8. .codex-plugin/plugin.json packaging — assay's own manifest, since that is
  // the artifact a release ships
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf-8"));
  for (const field of ["name", "version", "description"]) {
    assert.ok(manifest[field], ".codex-plugin/plugin.json is missing " + field);
  }
  for (const [key, value] of Object.entries(manifest)) {
    if (typeof value === "string" && value.startsWith("./")) {
      assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, value)), key + " points outside the plugin: " + value);
    }
  }
});

// ---------------------------------------------------------------------------
// Disclosed gaps — cells this machine cannot express
// ---------------------------------------------------------------------------

// A live host costs a model session per probe, which a unit suite must never
// spend — so these two cells stay disclosed here and their proof lives in the
// manual script, run like doc-drift as a pre-release step. It starts real
// Codex sessions over a sentinel-token AGENTS.md chain and exits 2 when the
// loaded chain disagrees with the adapter's model.
// [Foreman: 094] Last run 2026-07-28 against codex-cli 0.145.0: OK — chain
// order, fresh-session delivery, and AGENTS.override.md selection all held.
const LIVE_CODEX_CHECK = " The manual live check is `node scripts/assay-live-host-codex.js` — " +
  "last run 2026-07-28 against codex-cli 0.145.0: OK.";
test("release gate: Codex installed-host end-to-end", {
  skip: disclose("codex installed-host end-to-end", NO_LIVE_CODEX + LIVE_CODEX_CHECK),
}, () => {});

test("release gate: Codex fresh-session loading at session start", {
  skip: disclose("codex fresh-session loading", NO_LIVE_CODEX + LIVE_CODEX_CHECK),
}, () => {});

test("release gate: Claude Code installed-host end-to-end", {
  skip: disclose("claude-code installed-host end-to-end",
    "no live Claude Code host was probed — the installed-plugin layout and the fresh startup directory are exercised, " +
    "but no session was started and no instruction file was observed being loaded"),
}, () => {});

// Case sensitivity: on a case-insensitive filesystem `CLAUDE.md` and `claude.md`
// are one file, so a fixture that distinguishes them cannot exist here.
const caseProbe = fs.mkdtempSync(path.join(os.tmpdir(), "assay-gate-case-"));
fs.writeFileSync(path.join(caseProbe, "CaseProbe.md"), "x");
const CASE_SENSITIVE = !fs.existsSync(path.join(caseProbe, "caseprobe.md"));

test("release gate: source selection is case-sensitive where the filesystem is", {
  skip: CASE_SENSITIVE ? false : disclose("case-sensitive source selection",
    "this filesystem is case-insensitive (" + process.platform + "), so `CLAUDE.md` and `claude.md` are one file here — " +
    "the distinct-source fixture cannot be expressed on this machine"),
}, () => {
  const root = tmpProject({ "CLAUDE.md": CLEAN_CLAUDE, "claude.md": "- Something else entirely.\n" });
  const scanData = engine.scan(root, { projectOnly: true });
  assert.deepEqual(scanData.files.map((f) => f.path), ["CLAUDE.md"]);
});

// Symlinked rule files are documented discovery behavior, and creating one on
// Windows needs a privilege a test run does not have by default.
function symlinksAvailable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assay-gate-link-"));
  fs.writeFileSync(path.join(dir, "target.md"), "- Never use `var`.\n");
  try {
    fs.symlinkSync(path.join(dir, "target.md"), path.join(dir, "link.md"), "file");
    return null;
  } catch (err) {
    return err.code || err.message;
  }
}
const SYMLINK_ERROR = symlinksAvailable();

test("release gate: a symlinked rule file is discovered", {
  skip: SYMLINK_ERROR ? disclose("symlinked rule discovery",
    "this process cannot create a symlink (" + SYMLINK_ERROR + " on " + process.platform + ") — " +
    "creating one needs a privilege a plain test run does not hold, so the documented symlink behavior is unexercised here") : false,
}, () => {
  const root = tmpProject({ ".claude/rules/real.md": "- Validate every request body at the handler boundary.\n" });
  const target = path.join(root, ".claude", "rules", "real.md");
  fs.symlinkSync(target, path.join(root, ".claude", "rules", "linked.md"), "file");
  const scanData = engine.scan(root, { projectOnly: true });
  assert.deepEqual(scanData.files.map((f) => f.path).sort(),
    [".claude/rules/linked.md", ".claude/rules/real.md"]);
});

// Network, not correctness: the drift probe is a separate command so a flaky
// connection can never fail a suite. Naming it here keeps it in the checklist.
test("release gate: host documentation provenance is current", {
  skip: disclose("host documentation provenance",
    "checked by `node scripts/assay-doc-drift.js`, which needs the network and is therefore a manual pre-release step — " +
    "exit 0 means every documented claim is still stated on its page, exit 2 names the profile blocked for release"),
}, () => {});

// Printed from an exit handler on stderr, not from inside a test: a runner
// reformats or swallows a test's stdout depending on its reporter, and the one
// thing this file must always say out loud is what it did not check. Every skip
// above is registered by the time the module finishes loading, so the list is
// complete however the run ends.
process.on("exit", () => {
  const lines = ["", "DISCLOSED GAPS (" + DISCLOSED_GAPS.length + ") — release cells this run did not close:"];
  for (const gap of DISCLOSED_GAPS) lines.push("  - " + gap.cell + ": " + gap.reason);
  process.stderr.write(lines.join("\n") + "\n");
});

test("release gate: DISCLOSED GAPS", () => {
  // Every skipped cell states a reason, and every adapter claim has a probe row
  // in the drift script that guards it.
  assert.ok(DISCLOSED_GAPS.length, "nothing was disclosed — a skip lost its reason");
  for (const gap of DISCLOSED_GAPS) assert.ok(gap.reason && gap.reason.length > 40, gap.cell);
  // The drift probe is maintainer tooling and lives outside the plugin, so the
  // gate reads it from the repository rather than from what ships to a user.
  const drift = fs.readFileSync(path.join(PLUGIN_ROOT, "..", "scripts", "assay-doc-drift.js"), "utf-8");
  for (const profile of Object.keys(engine.ADAPTERS)) {
    for (const claim of engine.ADAPTERS[profile].docs()) {
      assert.ok(drift.includes(claim.url), profile + ": no drift probe guards " + claim.url);
    }
  }
});

// ---------------------------------------------------------------------------
// "the four commands are the four commands"
// ---------------------------------------------------------------------------

// [Foreman: 096] A rename ships broken when one reference survives it. The
// retired name is the cheapest thing to check and the easiest thing to miss:
// it lives in prose, in a skill description, in a manifest, and in the closing
// line the engine prints. So the gate greps the whole shipped plugin for it,
// and asserts the four skill directories that replaced it are the only ones.
//
// CHANGELOG.md is excluded on purpose. It is the record of what the plugin used
// to be called, and rewriting history there would be the actual defect.
const RETIRED_COMMANDS = ["/assay:assay", "/assay:audit", "/assay:claude"];
// [Foreman: 165] The four model commands replaced the single audit door.
const MODEL_COMMANDS = ["opus5", "sonnet5", "haiku45", "fable5"];
const COMMANDS = [...MODEL_COMMANDS, "codex", "craft-rules", "craft-skill", "revert"];
// Not a command: the one file the four model commands defer to.
const SHARED_DIR = "_shared";
const SHARED_AUDIT = path.join(PLUGIN_ROOT, "skills", SHARED_DIR, "audit.md");

function shippedFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "tests" || entry.name.startsWith(".assay")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) shippedFiles(full, out);
    else if (/\.(md|js|json)$/.test(entry.name) && entry.name !== "CHANGELOG.md") out.push(full);
  }
  return out;
}

test("release gate: no retired command name survives anywhere in the plugin", () => {
  const offenders = [];
  for (const file of shippedFiles(PLUGIN_ROOT)) {
    const text = fs.readFileSync(file, "utf-8");
    for (const retired of RETIRED_COMMANDS) {
      if (text.includes(retired)) offenders.push(path.relative(PLUGIN_ROOT, file) + " → " + retired);
    }
  }
  assert.deepEqual(offenders, [], "a retired command name still ships:\n" + offenders.join("\n"));
});

test("release gate: every command is named by its own skill, and none takes --host", () => {
  const dirs = fs.readdirSync(path.join(PLUGIN_ROOT, "skills")).sort();
  assert.deepEqual(dirs, [...COMMANDS, SHARED_DIR].sort());
  for (const dir of dirs) {
    // `_shared` carries no SKILL.md and is no command; it is the procedure the
    // model commands open, and G9 below is what holds it in step with them.
    if (dir === SHARED_DIR) continue;
    const fm = engine.parseFrontmatter(fs.readFileSync(path.join(PLUGIN_ROOT, "skills", dir, "SKILL.md"), "utf-8"));
    // the command name is the frontmatter name, not the directory
    assert.equal(fm.name, dir, dir + " names itself something else");
    const hint = String(fm["argument-hint"] || "");
    // --host is an engine argument now. Each command knows its own host, so a
    // hint offering the flag would put a choice back in front of a user who
    // does not have one to make.
    assert.doesNotMatch(hint, /--host/, dir + " still offers --host");
    // --startup names the directory a session began in, which only the chain
    // host has. It belongs to that one command and nowhere else.
    assert.equal(/--startup/.test(hint), dir === "codex", dir + " gets --startup wrong");
  }
});

// ---------------------------------------------------------------------------
// dual-host packaging: the Codex install carries its own front door
// ---------------------------------------------------------------------------

// [Foreman: 095] One plugin directory installs on either host, and each host
// sees only its own surface. The Codex manifest names the Codex skill
// directory, the one skill in it drives the same engine, and nothing a Codex
// session is handed speaks the other host's name.
test("release gate: the Codex manifest advertises the Codex-native skill", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf-8"));
  assert.equal(manifest.skills, "./codex-skills/");
  const dirs = fs.readdirSync(path.join(PLUGIN_ROOT, "codex-skills")).sort();
  assert.deepEqual(dirs, ["assay"]);
  const fm = engine.parseFrontmatter(fs.readFileSync(path.join(PLUGIN_ROOT, "codex-skills", "assay", "SKILL.md"), "utf-8"));
  assert.equal(fm.name, "assay", "the Codex skill names itself something else");
  assert.ok(String(fm.description || "").trim().length, "the Codex skill ships no description");
});

// [Foreman: 097] The gate below walks the SHIPPED FILES. It never saw the report
// those files tell the model to print verbatim — and three sentences the engine
// generated named the other host, so a Codex session read them on screen while
// every file on disk was clean.
test("release gate: a Codex-profile report never names the other host", () => {
  const project = tmpProject({
    "AGENTS.md": [
      "# Rules",
      "",
      "- Always follow `docs/gone.md` before you cut a release.",
      "- Never push to `origin` without review.",
      "- Always push to `origin` without review.",
      "- Before releasing, record the change in `CHANGELOG.md`.",
      "- Write clean, maintainable code.",
      "",
    ].join("\n"),
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "assay-gate-cxhome-"));
  const env = { ...process.env, CODEX_HOME: home, ASSAY_USER_DIR: home };
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args, "--root", project], { encoding: "utf-8", env });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  assert.equal(run("scan", "--host", "codex", "--project-only").code, 0);
  for (const args of [["report"], ["report", "--verbose"]]) {
    const printed = run(...args);
    assert.equal(printed.code, 0, printed.err);
    const offenders = printed.out.split("\n").filter((l) => /claude/i.test(l));
    assert.deepEqual(offenders, [], `\`${args.join(" ")}\` under the Codex profile names the other host:\n` + offenders.join("\n"));
  }
});

test("release gate: the Codex-facing surface never names the other host", () => {
  // Everything a Codex session is told to read: the skill directory, the
  // manifest that advertises it, and the shared rubric the skill opens.
  const offenders = [];
  const check = (full) => {
    if (/claude/i.test(fs.readFileSync(full, "utf-8"))) offenders.push(path.relative(PLUGIN_ROOT, full));
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else check(full);
    }
  };
  walk(path.join(PLUGIN_ROOT, "codex-skills"));
  walk(path.join(PLUGIN_ROOT, "references"));
  check(path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"));
  assert.deepEqual(offenders, [], "the other host leaks into the Codex surface:\n" + offenders.join("\n"));
});

// [Foreman: 095] The published number and the engine's self-identity move
// together, or every record a release writes introduces itself as the release
// before it. The codex manifest carries the published number inside the plugin
// (the repo's own check keeps it equal to the marketplace entry), so the gate
// can hold without reaching outside the shipped directory.
test("release gate: the engine's analyzer version matches the shipped manifest", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf-8"));
  assert.equal(engine.ANALYZER_VERSION, manifest.version);
});

// [Foreman: 135] The two Codex surfaces are near-duplicate copies of one flow,
// and between 1.11.0 and 1.15.0 they silently fell a whole release apart on
// roughly fifteen points — found only by a manual multi-agent read. Nothing
// asserted they stay in step, so nothing did.
//
// This gate compares STRUCTURE, never prose: the two files are deliberately
// worded differently, and `codex-skills/` may not contain the other host's name
// in any case. What must not diverge is the shape a reader navigates by and the
// vocabulary the model acts on.
const CODEX_TWINS = {
  hosted: path.join(PLUGIN_ROOT, "skills", "codex", "SKILL.md"),
  native: path.join(PLUGIN_ROOT, "codex-skills", "assay", "SKILL.md"),
};

const readTwin = (p) => fs.readFileSync(p, "utf-8");
const stepHeadings = (text) => text.split("\n").filter((l) => /^## \d+\. /.test(l)).map((l) => l.replace(/^## /, "").trim());
// A flag counts as named wherever it appears, because the model reads the whole
// file — what matters is that neither surface knows a flag the other does not.
const flagsIn = (text) => [...new Set((text.match(/--[a-z][a-z-]+/g) || []))].sort();

test("release gate: the two Codex surfaces carry the same steps, in the same order", () => {
  const a = stepHeadings(readTwin(CODEX_TWINS.hosted));
  const b = stepHeadings(readTwin(CODEX_TWINS.native));
  assert.ok(a.length >= 6, "the hosted surface must actually have numbered steps");
  assert.deepEqual(b, a, "the two Codex surfaces describe different steps or a different order");
});

test("release gate: the two Codex surfaces know the same flags", () => {
  const a = flagsIn(readTwin(CODEX_TWINS.hosted));
  const b = flagsIn(readTwin(CODEX_TWINS.native));
  const onlyHosted = a.filter((f) => !b.includes(f));
  const onlyNative = b.filter((f) => !a.includes(f));
  assert.deepEqual({ onlyHosted, onlyNative }, { onlyHosted: [], onlyNative: [] },
    "a flag one Codex surface documents and the other does not");
});

test("release gate: the two Codex surfaces name the same draft-plan fields and change kinds", () => {
  const fields = (text) => [...new Set((text.match(/`(kind|files|patches|rationale|limitations|mechanism|provenance|addresses|batches|old|new|path|sourceHash)`/g) || []))].sort();
  const kinds = (text) => engine.CHANGE_KINDS.filter((k) => text.includes("`" + k + "`")).sort();
  const A = readTwin(CODEX_TWINS.hosted), B = readTwin(CODEX_TWINS.native);
  assert.deepEqual(fields(B), fields(A), "the draft plan is described with different fields on the two surfaces");
  assert.deepEqual(kinds(B), kinds(A), "one surface offers a change kind the other does not");
});

test("release gate: the two Codex surfaces offer the same fix-menu options", () => {
  // The labels are worded per surface; the OPTION SET is not allowed to differ.
  // Anchored on the nouns the engine acts on rather than on the sentence.
  const options = (text) => ({
    deadReferences: /[Rr]epair .*dead reference/.test(text),
    skillMetadata: /skill metadata/i.test(text),
    buildMechanism: /[Bb]uild the mechanism now/.test(text),
    writeThePlan: /write down the plan|write the plan/i.test(text),
  });
  assert.deepEqual(options(readTwin(CODEX_TWINS.native)), options(readTwin(CODEX_TWINS.hosted)),
    "the two Codex surfaces offer different repairs");
});

test("release gate: every Codex surface carries the guards that keep a fix honest", () => {
  // Each of these was missing from one surface and present on the other at some
  // point in 1.11.0–1.15.0. They are the guards whose absence produces a WRONG
  // change, not merely a terser one.
  const guards = [
    [/cannot put text in front of the user/i, "the no-report-behind-the-menu guard"],
    [/[Dd]o not rewrite\s+a description to the trigger recipe/i, "the trigger-recipe rewrite ban"],
    [/never a remembered\s*format|never a remembered format/i, "the live-docs requirement for a promotion"],
    [/stays exactly where it is|rules stay active|rules stay where/i, "the source-rule-stays guarantee"],
  ];
  for (const [file, label] of Object.entries(CODEX_TWINS)) {
    const text = readTwin(label);
    for (const [re, what] of guards) {
      assert.match(text.replace(/\s+/g, " "), re, `${file} lost ${what}`);
    }
  }
});

// The third surface describing the same flow. A looser check — it is a different
// host with different steps — but the step COUNT drifting is the same class of
// silent divergence, and it is cheap to notice.
test("release gate: the Claude audit surface still describes a numbered flow of its own", () => {
  const claude = stepHeadings(fs.readFileSync(SHARED_AUDIT, "utf-8"));
  const codex = stepHeadings(readTwin(CODEX_TWINS.hosted));
  assert.ok(claude.length >= 6, "the shared audit procedure must have numbered steps");
  assert.equal(claude.length, codex.length,
    "one audit surface grew or lost a step the others did not — deliberate is fine, silent is not");
});

// [Foreman: 161] G8. Only one model tier has ever been measured — haiku 4.5,
// rule-lab 2026-07. The other three profiles are extrapolations, and the whole
// reason they are allowed to ship as written is that every constant in them
// says so. A profile that claimed `mechanical`, `documented` or
// `experiment-supported` for a Claude-5 tier would be a compliance claim assay
// has no evidence for.
//
// The rule already exists as a jig guard at commit time. This gate is the CI
// half of the SAME guard, not a second definition of it: the forbidden
// vocabulary is read out of the check file, so the two cannot drift apart.
const EVIDENCE_CHECK = path.join(__dirname, "..", "..", ".jig", "checks",
  "assay-profile-evidence-tier.check.mjs");

const forbiddenEvidenceLevels = () => {
  const src = fs.readFileSync(EVIDENCE_CHECK, "utf-8");
  // The pattern lives in the check as a JSON-escaped string, so match its
  // alternation group rather than trying to re-escape the whole thing here.
  const m = src.match(/level:.*?\(\?:([a-z|-]+)\)/);
  assert.ok(m, "the jig evidence check no longer states its forbidden levels in a shape this gate can read");
  return m[1].split("|");
};

const MODEL_PROFILES = require("../scripts/models/index.js").PROFILES;
// The measured tier is haiku 4.5; every profile whose display name ends in a
// bare "5" is a Claude-5 tier and has no measurement behind it.
const isClaude5 = (p) => /^Claude \w+ 5$/.test(p.displayName);

test("release gate G8: no Claude-5 profile claims evidence nothing measured", () => {
  const forbidden = forbiddenEvidenceLevels();
  assert.deepEqual(forbidden, ["mechanical", "documented", "experiment-supported"],
    "the forbidden evidence vocabulary changed — confirm this gate and the jig check still mean the same thing");

  const claude5 = Object.values(MODEL_PROFILES).filter(isClaude5);
  assert.ok(claude5.length >= 3, "the Claude-5 profiles are missing from the profile registry");

  for (const profile of claude5) {
    assert.ok(profile.evidence, `${profile.id} ships no evidence record at all`);
    assert.ok(!forbidden.includes(profile.evidence.level),
      `${profile.id} claims ${profile.evidence.level} evidence for an unmeasured tier`);
    assert.equal(profile.evidence.level, "profile-inferred",
      `${profile.id} must declare profile-inferred evidence`);
    assert.ok(profile.evidence.basis && profile.evidence.limits,
      `${profile.id} must say what argued for its numbers and what they do not cover`);

    // Every constant the profile ships, marked one by one.
    const shipped = [
      ...Object.keys(profile.weights).map((k) => `weights.${k}`),
      ...Object.keys(profile.thresholds).map((k) => `thresholds.${k}`),
    ].sort();
    const marked = Object.keys(profile.evidence.constants).sort();
    assert.deepEqual(marked, shipped,
      `${profile.id} ships a constant with no evidence tier, or marks one it does not ship`);
    for (const [name, level] of Object.entries(profile.evidence.constants)) {
      assert.ok(!forbidden.includes(level),
        `${profile.id}'s ${name} claims ${level} evidence for an unmeasured tier`);
    }
  }
});

test("release gate G8: no profile source file writes a forbidden evidence level", () => {
  // The literal-text half, mirroring what the jig guard greps for, so a claim
  // written into a comment or a field this gate does not read is still caught.
  const forbidden = forbiddenEvidenceLevels();
  const dir = path.join(PLUGIN_ROOT, "scripts", "models");
  const re = new RegExp(`level:\s*["'](?:${forbidden.join("|")})["']`);
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(dir, file), "utf-8");
    assert.ok(!re.test(text), `${file} writes an evidence level nothing has measured`);
  }
});

// ---------------------------------------------------------------------------
// [Foreman: 165] G9. One procedure, four doors.
// ---------------------------------------------------------------------------

// The single audit command became four, one per model target, and the whole
// reason that is affordable is that none of them carries the procedure. The
// procedure is `skills/_shared/audit.md` and the four SKILL.md files are a
// frontmatter and a pointer. The failure this gate exists to stop is the one
// the Codex twins already suffered in 1.11.0–1.15.0: a step or a flag added to
// one surface and not the others, drifting silently until a manual read found
// it. Four copies drift four ways, so the four are not allowed to have a copy.
//
// It also holds the thing that MUST differ. Each command names one model
// target, the four are distinct, and they are exactly the profiles the engine
// ships — a fifth command with no profile behind it, or two commands claiming
// one model, is a door that cannot mean what it says.
const modelSkill = (name) => fs.readFileSync(path.join(PLUGIN_ROOT, "skills", name, "SKILL.md"), "utf-8");
const bodyOf = (text) => text.split(/^---$/m).slice(2).join("---");
// Every distinct `--flag` token, `--top <n>` and `--top` counting as one.
const flagSet = (text) => [...new Set((text.match(/--[a-z][a-z-]+/g) || []))].sort();

test("release gate G9: the audit procedure is stated once, and only there", () => {
  assert.ok(fs.existsSync(SHARED_AUDIT), "the shared audit procedure is missing");
  assert.ok(stepHeadings(fs.readFileSync(SHARED_AUDIT, "utf-8")).length >= 6,
    "the shared audit procedure no longer carries the numbered steps");
  // and the retired single-door skill is gone rather than left beside it
  assert.ok(!fs.existsSync(path.join(PLUGIN_ROOT, "skills", "claude")),
    "the retired single-door audit skill still ships");

  for (const name of MODEL_COMMANDS) {
    const body = bodyOf(modelSkill(name));
    assert.deepEqual(stepHeadings(body), [],
      name + " restates a step of the procedure instead of deferring to it");
    assert.match(body, /\.\.\/_shared\/audit\.md/,
      name + " never sends the reader to the shared procedure");
    // A pointer, not a paraphrase. The bound is generous on purpose: what it
    // catches is a file that has started growing a second copy of the flow.
    const lines = body.split("\n").filter((l) => l.trim()).length;
    assert.ok(lines <= 12, name + " is " + lines + " lines of body — it is no longer thin:\n" + body);
    // Every engine call belongs to the procedure. A command that runs one has
    // begun to duplicate it.
    assert.doesNotMatch(body, /assay\.js/, name + " calls the engine itself");
  }
});

test("release gate G9: the four commands know exactly the flags the procedure documents", () => {
  const shared = fs.readFileSync(SHARED_AUDIT, "utf-8");
  const para = shared.slice(shared.indexOf("Flags in `$ARGUMENTS`"));
  const documented = flagSet(para.slice(0, para.indexOf("\n\n")));
  assert.ok(documented.length >= 6, "the shared procedure no longer lists its flags in one paragraph");
  assert.ok(!documented.includes("--fix"), "the shared procedure still documents the retired --fix");
  assert.ok(documented.includes("--dry-run"), "the shared procedure never documents --dry-run");

  const hints = MODEL_COMMANDS.map((name) => String(engine.parseFrontmatter(modelSkill(name))["argument-hint"] || ""));
  assert.equal(new Set(hints).size, 1, "the four commands offer different flags:\n" + hints.join("\n"));
  assert.deepEqual(flagSet(hints[0]), documented,
    "a command offers a flag the procedure does not document, or hides one it does");
});

test("release gate G9: each command names one model target, and the four are the shipped profiles", () => {
  const targets = new Map();
  for (const name of MODEL_COMMANDS) {
    const body = bodyOf(modelSkill(name));
    const found = [...body.matchAll(/\*\*Model target: ([^*]+?)\.\*\*/g)].map((m) => m[1]);
    assert.equal(found.length, 1, name + " names " + found.length + " model targets; it must name exactly one");
    targets.set(name, found[0]);
  }
  assert.equal(new Set(targets.values()).size, MODEL_COMMANDS.length,
    "two commands claim the same model target: " + [...targets].map((p) => p.join("→")).join(", "));
  // The target is the profile's own display name, so the command cannot name a
  // model the engine has never heard of.
  for (const [name, target] of targets) {
    const profile = MODEL_PROFILES[name];
    assert.ok(profile, name + " is a command with no model profile behind it");
    assert.equal(target, profile.displayName,
      name + " names `" + target + "`; its profile is `" + profile.displayName + "`");
  }
  assert.deepEqual([...targets.keys()].sort(), Object.keys(MODEL_PROFILES).sort(),
    "the commands and the shipped model profiles are not the same set");
});

test("release gate G9: no surface still offers the retired --fix", () => {
  const offenders = shippedFiles(PLUGIN_ROOT)
    .filter((f) => /--fix\b/.test(fs.readFileSync(f, "utf-8")))
    .map((f) => path.relative(PLUGIN_ROOT, f));
  assert.deepEqual(offenders, [], "--fix was retired but still ships:\n" + offenders.join("\n"));
});

// ---------------------------------------------------------------------------
// [Foreman: 163] G10. Two routes out of a run, one result.
// ---------------------------------------------------------------------------

// `/assay:revert` offers the owner a choice between restoring from the commit
// the run started at and restoring from the copies assay made itself. A choice
// is only safe to offer if it is not a choice about the OUTCOME — so this gate
// runs one identical fixture down each route and compares the trees byte for
// byte, files the run created included. If the two ever diverge, the skill is
// asking the owner a question they have no way to answer.
const SAFETY = require("../scripts/safety.js");

function tgit(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf-8" });
}

const GIT_MISSING = tgit(os.tmpdir(), ["--version"]).status !== 0;

// Content of every file outside `.git` and the two directories assay owns.
// Mtime is deliberately absent: a restore that rewrites identical bytes is a
// correct restore, and a clock is not part of what was undone.
function contentTree(root) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel || "."), { withFileTypes: true })) {
      const next = rel ? rel + "/" + e.name : e.name;
      if (e.name === ".git" || e.name === ".assay" || e.name === ".assay-tmp") continue;
      if (e.isDirectory()) walk(next);
      else out[next] = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, next))).digest("hex");
    }
  };
  walk("");
  return out;
}

// A committed project, a transaction row carrying BOTH routes, then the writes
// that row describes: one file edited, one file created. This is the shape
// `apply` produces, with the backup taken before the first write exactly as
// `cmdApply` takes it.
function revertFixture() {
  const root = tmpProject({
    "CLAUDE.md": "# Rules\n\n- Always read the plan before applying it.\n",
    "docs/keep.md": "untouched\n",
  });
  tgit(root, ["init", "-q"]);
  tgit(root, ["config", "user.email", "gate@example.invalid"]);
  tgit(root, ["config", "user.name", "gate"]);
  tgit(root, ["add", "-A"]);
  tgit(root, ["commit", "-qm", "base"]);
  const head = tgit(root, ["rev-parse", "HEAD"]).stdout.trim();
  const pre = contentTree(root);

  const txId = "t0123456789";
  const files = [".claude/skills/made/SKILL.md", "CLAUDE.md"];
  const backupDir = SAFETY.backupFiles(root, txId, files);
  SAFETY.appendTransaction(root, {
    txId, startedAt: "2026-08-25T00:00:00.000Z", gitHead: head, backupDir, files, changes: [],
  });

  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Rules\n\n- Rewritten by the run.\n");
  fs.mkdirSync(path.join(root, ".claude", "skills", "made"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "skills", "made", "SKILL.md"), "---\nname: made\n---\n");
  return { root, txId, head, pre };
}

test("release gate G10: both restore routes put the tree back byte for byte", {
  skip: GIT_MISSING ? disclose("revert route equivalence",
    "git is not on PATH in this environment, so neither restore route can be exercised end to end") : false,
}, () => {
  const viaGit = revertFixture();
  const viaBackup = revertFixture();
  const before = viaGit.pre;
  // the fixture is the same project twice, or the comparison below proves nothing
  assert.deepEqual(contentTree(viaGit.root), contentTree(viaBackup.root));
  assert.notDeepEqual(contentTree(viaGit.root), before, "the fixture never simulated the run's writes");

  const g = SAFETY.revertTransaction(viaGit.root, viaGit.txId, "git");
  const b = SAFETY.revertTransaction(viaBackup.root, viaBackup.txId, "backup");
  assert.equal(g.ok, true, "git route refused: " + g.problem);
  assert.equal(b.ok, true, "backup route refused: " + b.problem);

  assert.deepEqual(contentTree(viaGit.root), before, "the git route did not restore the pre-run tree");
  assert.deepEqual(contentTree(viaBackup.root), contentTree(viaGit.root),
    "the two routes disagree, so the skill's choice changes the outcome");
  // the created file is gone by both routes, and the directory with it
  assert.equal(fs.existsSync(path.join(viaGit.root, ".claude", "skills", "made")), false);
  assert.equal(fs.existsSync(path.join(viaBackup.root, ".claude", "skills", "made")), false);
  assert.deepEqual(g.removed, [".claude/skills/made/SKILL.md"]);
  assert.deepEqual(b.removed, [".claude/skills/made/SKILL.md"]);
});

test("release gate G10: a revert marks its row and refuses to run twice", {
  skip: GIT_MISSING ? disclose("revert row marking",
    "git is not on PATH in this environment, so a transaction row with a live commit cannot be built") : false,
}, () => {
  const { root, txId } = revertFixture();
  const first = SAFETY.revertTransaction(root, txId, "git");
  assert.equal(first.ok, true, first.problem);
  const row = SAFETY.readTransactions(root).find((r) => r.txId === txId);
  assert.equal(row.revertedAt, first.revertedAt);
  assert.match(String(row.revertedAt), /^\d{4}-\d{2}-\d{2}T/);

  const second = SAFETY.revertTransaction(root, txId, "git");
  assert.equal(second.ok, false);
  assert.match(second.problem, /already reverted/);
});

test("release gate G10: a broken route is refused whole, never in part", {
  skip: GIT_MISSING ? disclose("revert whole-or-nothing refusal",
    "git is not on PATH in this environment, so the git route cannot be put into a broken state") : false,
}, () => {
  // a corrupted backup copy
  const corrupt = revertFixture();
  const manifest = path.join(corrupt.root, ".assay", "backup-" + corrupt.txId, "CLAUDE.md");
  fs.writeFileSync(manifest, "tampered\n");
  const tree = contentTree(corrupt.root);
  const r1 = SAFETY.revertTransaction(corrupt.root, corrupt.txId, "backup");
  assert.equal(r1.ok, false);
  assert.match(r1.problem, /no longer matches its recorded digest/);
  assert.deepEqual(contentTree(corrupt.root), tree, "a refused revert still wrote to the tree");
  assert.equal(SAFETY.readTransactions(corrupt.root)[0].revertedAt, undefined);

  // a recorded commit that is not in this repository
  const gone = revertFixture();
  const rows = SAFETY.readTransactions(gone.root)
    .map((r) => ({ ...r, gitHead: "0".repeat(40) }));
  fs.writeFileSync(path.join(gone.root, ".assay", "transactions.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r2 = SAFETY.revertTransaction(gone.root, gone.txId, "git");
  assert.equal(r2.ok, false);
  assert.match(r2.problem, /not in this repository any more/);

  // a staged change on a named file blocks the whole transaction
  const staged = revertFixture();
  tgit(staged.root, ["add", "--", "CLAUDE.md"]);
  const stagedTree = contentTree(staged.root);
  const r3 = SAFETY.revertTransaction(staged.root, staged.txId, "git");
  assert.equal(r3.ok, false);
  assert.match(r3.problem, /staged or unmerged/);
  assert.match(r3.problem, /CLAUDE\.md/);
  assert.deepEqual(contentTree(staged.root), stagedTree, "a blocked revert still wrote to the tree");
});
