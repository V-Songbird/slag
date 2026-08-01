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
//   3. `node assay/scripts/doc-drift.js`         — OK, or the affected
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
// "Markdown, JSON, and HTML agree on findings"
// ---------------------------------------------------------------------------

// One fixture artifact, three views, one finding set. The fixture reaches every
// section that exists today: hard gates, conflicts, duplicates, the byte
// budget, behavior evidence, unsupported language, and — on the profile that
// has them — the instruction chain and maintainability.
const PROOF_FP = {
  key: "claude__haiku__gate-probe", probeId: "gate-probe", agent: "claude", model: "haiku",
  version: "2.1.0 (Claude Code)", n: 4, rate: 1, ci: [0.5, 1], scores: [1, 1, 1, 1],
  savedAt: "2026-07-20T10:00:00.000Z",
};

function findingIdsIn(html) {
  return new Set([...html.matchAll(/data-finding-id="([^"]+)"/g)].map((m) => m[1]));
}

function embeddedRecord(html) {
  const block = html.match(/<script type="application\/json" id="assay-data">([\s\S]*?)<\/script>/);
  assert.ok(block, "the HTML carries no data block");
  return JSON.parse(block[1]);
}

// The four ways a markdown report can name a finding: its own sentence, the
// rule id it belongs to, the exact span, or the file it is about. The last one
// is the floor and it is deliberate — where one cause affects many rules (the
// byte cap landing inside a file), the markdown states the cause once against
// the file instead of repeating a line per rule, while the HTML rules table
// necessarily carries a row each. Both views hold the same finding; only the
// grouping differs, so the check matches at the granularity each view uses.
// razor: file granularity is the floor for markdown. Tightening it to the span
// means the markdown renderer must list one line per affected rule — a report
// change, not a test change, and the upgrade path if that ever becomes wanted.
function namedInMarkdown(md, finding) {
  if (md.includes(finding.summary)) return true;
  if (finding.rule && md.includes(finding.rule)) return true;
  return (finding.sources || []).some((s) => md.includes(s.path + ":" + s.lineStart) || md.includes(s.path));
}

test("release gate: Markdown, JSON and HTML agree on findings", () => {
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
  fs.writeFileSync(path.join(root, "fp.json"), JSON.stringify(PROOF_FP));

  assert.equal(cli(root, ["scan"]).code, 0);
  assert.equal(cli(root, ["report", "--verbose"]).code, 0);
  assert.equal(cli(root, ["link", "--proof", "fp.json", "--rule", "R001"]).code, 0);
  assert.equal(cli(root, ["report", "--verbose"]).code, 0);
  assert.equal(cli(root, ["artifact"]).code, 0);

  const audit = readJson(root, "audit.json");
  const html = fs.readFileSync(path.join(root, ".assay-tmp", "report.html"), "utf-8");
  const md = cli(root, ["report", "--verbose"]).out;

  // the fixture actually reaches the sections it claims to
  const types = new Set(audit.findings.map((f) => f.type));
  for (const type of ["conflict", "duplicate", "context-pressure", "unsupported-language"]) {
    assert.ok(types.has(type), "fixture is missing a " + type + " finding");
  }
  assert.ok(audit.findings.some((f) => f.state === "blocked"), "fixture is missing its stale target");
  assert.equal(audit.proofLinks.length, 1);

  // JSON == HTML data block == HTML rendered
  const recorded = audit.findings.map((f) => f.id).sort();
  assert.deepEqual(embeddedRecord(html).findings.map((f) => f.id).sort(), recorded);
  assert.deepEqual([...findingIdsIn(html)].sort(), recorded);

  // == markdown
  for (const f of audit.findings) {
    assert.ok(namedInMarkdown(md, f), "markdown never names finding " + f.id + " (" + f.type + ")");
  }

  // and the newer sections are in both views, not just the record
  assert.match(md, /## Behavior evidence/);
  assert.match(html, /id="assay-proof"/);
  assert.match(md, /bytes of instructions load before every session/);
  assert.match(md, /read as Spanish \(`latin-unsupported:es`\)/);
  assert.match(html, /id="assay-language"/);
});

test("release gate: Markdown, JSON and HTML agree on findings — Codex chain and budget", () => {
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
  const html = engine.renderArtifact(audit);
  const md = engine.renderReport(audit, { verbose: true });

  const types = new Set(audit.findings.map((f) => f.type));
  assert.ok(types.has("budget-exceeded") || types.has("budget-truncation"), "fixture never reached the cap");
  assert.equal(engine.validateRecord(record, "audit"), null);

  const recorded = record.findings.map((f) => f.id).sort();
  assert.deepEqual(embeddedRecord(html).findings.map((f) => f.id).sort(), recorded);
  assert.deepEqual([...findingIdsIn(html)].sort(), recorded);
  for (const f of audit.findings) {
    assert.ok(namedInMarkdown(md, f), "markdown never names finding " + f.id + " (" + f.type + ")");
  }
  // the two sections only this profile has
  assert.match(md, /## Instruction chain/);
  assert.match(md, /Chain total \d+ bytes against a documented \d+-byte cap/);
  assert.match(md, /## Maintainability/);
  assert.match(html, /id="assay-chain"/);
  assert.match(html, /id="assay-budget"/);
  assert.match(html, /id="assay-maintainability"/);
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
  for (const args of [["scan"], ["report"], ["artifact"], ["remeasure"], ["ci"], ["ci", "--json"]]) {
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
// "the source cannot be retired before validation"
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
  retire: {
    path: "CLAUDE.md",
    old: "- Always update the changelog when you touch a public API.",
    new: "<!-- retired: the `changelog` skill owns this duty. -->",
  },
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

test("release gate: the source cannot be retired before validation", () => {
  const root = txProject();
  assert.equal(cli(root, ["plan", "--from", "draft.json"]).code, 0);

  const beforeApply = cli(root, ["retire", "--change", "c-skill"]);
  assert.equal(beforeApply.code, 1);
  assert.match(beforeApply.err, /the change has not been applied/);

  assert.equal(cli(root, ["apply", "--change", "c-skill"]).code, 0);
  const beforeValidate = cli(root, ["retire", "--change", "c-skill"]);
  assert.equal(beforeValidate.code, 1);
  assert.match(beforeValidate.err, /no validation evidence marking success/);
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), TX_CLAUDE,
    "the prose moved before its replacement was validated");

  assert.equal(cli(root, ["validate", "--change", "c-skill"]).code, 0);
  assert.equal(cli(root, ["retire", "--change", "c-skill"]).code, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), /- Always update the changelog/);
  // and the retirement is itself reversible
  assert.equal(cli(root, ["rollback", "--change", "c-skill"]).code, 0);
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), TX_CLAUDE);
});

// [Foreman: 093] A rolled-back change must refuse retirement by naming the
// rollback — not "no write in the journal", and not only a missing retire patch.
test("release gate: a rolled-back change refuses retirement by naming the rollback", () => {
  const root = txProject();
  assert.equal(cli(root, ["plan", "--from", "draft.json"]).code, 0);
  assert.equal(cli(root, ["apply", "--change", "c-skill"]).code, 0);
  assert.equal(cli(root, ["validate", "--change", "c-skill"]).code, 0);
  assert.equal(cli(root, ["rollback", "--change", "c-skill"]).code, 0);

  const afterRollback = cli(root, ["retire", "--change", "c-skill"]);
  assert.equal(afterRollback.code, 1);
  assert.match(afterRollback.err, /the change was rolled back/);
  assert.doesNotMatch(afterRollback.err, /no write in the journal/);
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"), TX_CLAUDE);

  // a change with no retire patch says so too, and still names the rollback
  const bare = txProject();
  const rewrite = {
    id: "c-rw", kind: "rule-rewrite", rationale: "why",
    patches: [{ path: "CLAUDE.md", old: CLEAN_RULE, new: "- Never use `var`; use `const` everywhere." }],
  };
  fs.writeFileSync(path.join(bare, "draft2.json"), JSON.stringify({ changes: [rewrite] }));
  assert.equal(cli(bare, ["plan", "--from", "draft2.json"]).code, 0);
  assert.equal(cli(bare, ["apply", "--change", "c-rw"]).code, 0);
  assert.equal(cli(bare, ["validate", "--change", "c-rw"]).code, 0);
  assert.equal(cli(bare, ["rollback", "--change", "c-rw"]).code, 0);
  const noPatch = cli(bare, ["retire", "--change", "c-rw"]);
  assert.equal(noPatch.code, 1);
  assert.match(noPatch.err, /declares no retirement patch/);
  assert.match(noPatch.err, /rolled back/);
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
  const skills = fs.readdirSync(path.join(PLUGIN_ROOT, "skills"))
    .map((name) => path.join("skills", name, "SKILL.md"));
  const files = ["README.md", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ...skills];

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
  ".claude/rules/shape.md": [
    "# Background",
    "",
    ...new Array(30).fill("Some narrative about why this project exists and how it grew."),
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
  assert.match(out, /never reaches the assistant/, "gate fixture no longer produces a rule that cannot load:\n" + out);
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
  assert.equal(run("artifact").code, 0);
  assert.ok(fs.existsSync(path.join(project, ".assay-tmp", "report.html")));

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
  fs.writeFileSync(path.join(root, "fp.json"), JSON.stringify(PROOF_FP));

  const SUCCESS = [
    [["scan"], "reads the project and writes scan.json"],
    [["report"], "composes the audit from the scan"],
    [["remeasure"], "re-scans and compares against the prior audit"],
    [["artifact"], "renders the HTML view of the audit"],
    [["ci"], "gates a clean project"],
    [["link", "--list"], "lists an empty Proof store"],
    [["plan", "--from", "draft.json"], "canonicalizes a draft into a plan"],
    [["link", "--proof", "fp.json", "--rule", "R001"], "attaches a measurement to a rule"],
    [["apply", "--change", "c-skill"], "writes only the named change"],
    [["validate", "--change", "c-skill"], "records validation evidence"],
    [["retire", "--change", "c-skill"], "retires the replaced prose"],
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
    [["artifact"], /scan|audit/],
    [["clean", "--nope"], /Unknown flag: --nope/],
    [["plan", "--from", "absent.json"], /No draft plan at absent\.json/],
    [["apply", "--change", "nope"], /no plan in \.assay\/ defines change nope/],
    [["validate", "--change", "nope"], /no plan in \.assay\/ defines change nope/],
    [["rollback", "--change", "nope"], /No change nope in \.assay\/journal\.jsonl/],
    [["retire", "--change", "nope"], /no plan in \.assay\/ defines change nope/],
    [["link", "--proof", "absent.json", "--rule", "R001"], /audit|resolve/],
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
  assert.deepEqual([...seen].sort(), ["apply", "artifact", "ci", "clean", "link", "plan",
    "remeasure", "report", "retire", "rollback", "scan", "validate"]);
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
  assert.match(preOne.err, /scan\.json is not a schema 1 scan record \(found schema pre-1\) — rerun `scan`\./);

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
  assert.match(partial.err, /rerun `scan`/);
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
const LIVE_CODEX_CHECK = " The manual live check is `node assay/scripts/live-host-codex.js` — " +
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
    "checked by `node assay/scripts/doc-drift.js`, which needs the network and is therefore a manual pre-release step — " +
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
  const drift = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "doc-drift.js"), "utf-8");
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
const RETIRED_COMMANDS = ["/assay:assay", "/assay:audit"];
const COMMANDS = ["claude", "codex", "craft-rules", "craft-skill"];

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

test("release gate: four commands, each named by its own skill, none taking --host", () => {
  const dirs = fs.readdirSync(path.join(PLUGIN_ROOT, "skills")).sort();
  assert.deepEqual(dirs, [...COMMANDS].sort());
  for (const dir of dirs) {
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
