const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const engine = require("../scripts/jig.js");
const { spawnSync } = require("node:child_process");
const A = require("./authored.js");

// Every test here runs the engine the way the Codex skills do, with --runtime codex.
process.env.JIG_RUNTIME = "codex";

function project(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jig-codex-engine-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}
function plan(root, opts = {}) {
  return engine.cmdPlan(root, { _: [], change: [], authored: A.writeChecks(root, [A.PIPED_INSTALLER]),
    "no-ci": true, provenance: "elicited", ...opts });
}
function applyRegion(root, record) {
  const region = record.changes.find((c) => c.kind === "write-agents-region");
  assert.ok(region);
  engine.cmdApply(root, { _: [], change: [region.id], path: [region.path] });
  return region;
}

test("Codex refuses every new Claude surface, including normalized paths and historical green probes", (t) => {
  const root = project(t);
  for (const rel of [".claude/settings.json", ".CLAUDE/rules/jig.md", "tmp/../.claude/rules/jig.md"]) {
    assert.match(engine.targetProblem(root, "write-side-file", rel), /Claude Code surface/);
  }
  assert.equal(engine.probeGreen(), false);
  const changes = [{ id: "old-approved", kind: "write-rule", path: ".claude/rules/jig-old.md", content: "old\n", sourceHash: null }];
  fs.mkdirSync(path.join(root, ".jig"));
  fs.writeFileSync(path.join(root, ".jig", "plan-0123456789ab.json"), JSON.stringify({ schemaVersion: 1, planId: "0123456789ab", changes }));
  assert.throws(() => engine.cmdApply(root, { _: [], change: ["old-approved"], path: [changes[0].path] }), /Claude Code surface/);
  assert.equal(fs.existsSync(path.join(root, changes[0].path)), false);
});

test("historical Claude instruction writes still restore their original bytes", (t) => {
  const original = Buffer.from("# Owner\r\n");
  const root = project(t, { ".claude/rules/jig-history.md": original });
  engine.journalledWrite(root, { tx: "historical", plan: "old" },
    { id: "historical-rule", path: ".claude/rules/jig-history.md", kind: "write-rule" }, Buffer.from("# Installed\n"));
  engine.cmdRevert(root, { _: [], change: ["historical-rule"] });
  assert.deepEqual(fs.readFileSync(path.join(root, ".claude/rules/jig-history.md")), original);
});

test("checks aliases and governance compose one approved region and preserve owner bytes", (t) => {
  const original = Buffer.from("\ufeff# Owner\r\nKeep this policy.\r\n");
  const root = project(t, { "AGENTS.md": original, "SCOPE.md": "# Scope\n" });
  engine.cmdScan(root, {});
  const record = plan(root, { "agents-region": true, "checks-rule": true, "wire-governance": true });
  const rows = record.changes.filter((c) => c.kind === "write-agents-region");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, "AGENTS.md");
  assert.ok(record.consent.item.includes(rows[0].id));
  applyRegion(root, record);
  const installed = fs.readFileSync(path.join(root, "AGENTS.md"));
  assert.deepEqual(installed.subarray(0, original.length), original);
  assert.match(installed.toString("utf8"), /jig:checks:begin/);
  assert.match(installed.toString("utf8"), /jig:governance:begin/);
  assert.match(installed.toString("utf8"), /SCOPE\.md/);
  engine.cmdRevert(root, { _: [], change: [rows[0].id] });
  assert.deepEqual(fs.readFileSync(path.join(root, "AGENTS.md")), original);
});

test("adding governance preserves the installed harness and refreshing the harness retains governance", (t) => {
  const root = project(t, { "AGENTS.md": "# Owner\n", "SCOPE.md": "# Scope\n" });
  const first = plan(root, { "checks-rule": true });
  applyRegion(root, first);
  const before = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  const checks = before.match(/<!-- jig:checks:begin -->[\s\S]*?<!-- jig:checks:end -->/)[0];
  engine.cmdScan(root, {});
  applyRegion(root, plan(root, { "wire-governance": true }));
  const withGovernance = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(withGovernance.includes(checks));
  applyRegion(root, plan(root, { "agents-region": true }));
  assert.ok(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8").includes("SCOPE.md"));
});

test("legacy unsectioned harness text survives a governance-only composition", (t) => {
  const begin = "<!-- jig:begin \u2014 jig owns what sits between these markers -->";
  const old = "jig guards this repository.\nRun our old approved checks.\n";
  const root = project(t, { "AGENTS.md": "# Owner\n" + begin + "\n\n" + old + "\n<!-- jig:end -->\n" });
  const region = engine.composeAgentsRegion(root, [], false, false, ["SCOPE.md"]);
  assert.ok(region.content.includes(old.trim()));
  assert.match(region.content, /jig:checks:begin/);
  assert.match(region.content, /SCOPE\.md/);
});

test("an active AGENTS override receives the region without changing the shadowed file", (t) => {
  const root = project(t, { "AGENTS.md": "# Root\n", "AGENTS.override.md": "# Active\n" });
  const record = plan(root, { "checks-rule": true });
  assert.equal(applyRegion(root, record).path, "AGENTS.override.md");
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "# Root\n");
  assert.match(fs.readFileSync(path.join(root, "AGENTS.override.md"), "utf8"), /jig guards/);
  const rules = engine.ruleCorpus(root);
  assert.equal(rules.files.find((f) => f.path === "AGENTS.md").loaded, false);
});

test("owner text can change after approval while an intervening jig region edit is refused", (t) => {
  const root = project(t, { "AGENTS.md": "# Owner\n" });
  const record = plan(root, { "checks-rule": true });
  fs.appendFileSync(path.join(root, "AGENTS.md"), "New owner policy.\n");
  applyRegion(root, record);
  assert.match(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /New owner policy/);
  const next = plan(root, { "checks-rule": true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), fs.readFileSync(path.join(root, "AGENTS.md"), "utf8").replace("jig guards", "Owner changed how jig guards"));
  assert.throws(() => applyRegion(root, next), /instruction region changed since review/);
});

test("malformed existing jig markers and unfenced proposed regions are refused", (t) => {
  const root = project(t, { "AGENTS.md": "# Owner\n<!-- jig:end -->\n" });
  assert.throws(() => plan(root, { "checks-rule": true }), /incomplete, duplicated or reversed markers/);
  const bare = project(t);
  const invalid = engine.planFromDraft({ changes: [{ id: "unfenced", kind: "write-agents-region", path: "AGENTS.md", content: "Replace everything.\n" }] }, bare);
  assert.match(invalid.problems.join(" "), /complete jig markers/);
});

test("Codex scan inventories native hooks and skills without inferring project trust", (t) => {
  const root = project(t, {
    ".codex/config.toml": "[features]\nhooks = true\n",
    ".codex/hooks.json": JSON.stringify({ hooks: { PreToolUse: [{ matcher: "apply_patch", hooks: [{ type: "command", command: "custom-check" }] }] } }),
    ".claude/settings.json": JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "old-check" }] }] } }),
    ".agents/skills/context/SKILL.md": "Read SCOPE.md before editing.\n",
    "SCOPE.md": "# Scope\n", "src/AGENTS.md": "# More specific\n",
  });
  const result = engine.cmdScan(root, {});
  assert.equal(result.guardrails.host.projectTrust, "unknown");
  assert.equal(result.guardrails.host.hooksEnabled, "unknown");
  assert.ok(result.guardrails.hooks.some((h) => h.source === ".codex/hooks.json"));
  assert.ok(result.guardrails.hooks.every((h) => !h.source.startsWith(".claude/")));
  assert.ok(result.occupied.includes("PreToolUse:apply_patch"));
  assert.deepEqual(result.governance.orphans, []);
  assert.ok(result.disclosures.some((line) => line.includes("combines ancestor")));
  assert.ok(result.disclosures.every((line) => !line.includes("root is not read")));
});

test("historical actor metadata still fills the Codex coverage column without changing proof bytes", (t) => {
  const root = project(t);
  const legacy = A.authored({ id: "legacy-actor", title: "Historical guard", fixtures: A.PIPED_INSTALLER.fixtures,
    deny: A.PIPED_INSTALLER.deny, detectors: [{ lever: "bash-guard", actor: "claude-session", confidence: "deterministic", params: { patterns: [A.PIPE_PATTERN] } }] });
  const record = engine.cmdPlan(root, { _: [], change: [], authored: A.writeChecks(root, [legacy]), "no-ci": true });
  const review = JSON.parse(fs.readFileSync(path.join(root, ".jig/plan.json"), "utf8"));
  assert.deepEqual(review.actors, ["human-editor", "human-ci", "codex-session"]);
  assert.equal(review.rows[0].cells["codex-session"].grade, "DET");
  assert.match(review.rows[0].cells["codex-session"].blocks, /host interception is unverified/);
  A.applyPlan(engine, root, record);
  assert.ok(fs.readFileSync(path.join(root, ".jig/checks/legacy-actor.check.mjs"), "utf8").includes('"claude-session"'));
});

test("installed modes and synthetic runtime catches never become Codex host proof", (t) => {
  const root = project(t);
  const record = plan(root);
  A.applyPlan(engine, root, record);
  const report = engine.cmdInventory(root);
  assert.equal(report.lanes.session.runs, null);
  assert.equal(report.lanes.session.state, "unverified-host");
  const proof = engine.cmdSelftest(root, { live: true });
  assert.equal(proof.witnessed, true);
  assert.equal(proof.hostVerified, false);
  assert.equal(proof.evidence, "runtime-selftest");
  const guard = proof.probes.find((p) => p.kind === "guard");
  assert.equal(guard.transport, "codex-payload");
  assert.equal(guard.caught, true);
  assert.equal(engine.cmdInventory(root).lanes.session.runs, null);
});

test("an edit guard selftest uses Codex apply_patch payloads without planting project bytes", (t) => {
  const root = project(t);
  A.installChecks(engine, root, [A.EMPTY_CATCH], { "no-ci": true });
  const proof = engine.cmdSelftest(root, { live: true });
  const guard = proof.probes.find((p) => p.kind === "guard");
  assert.equal(guard.transport, "codex-payload");
  assert.equal(guard.hostVerified, false);
  assert.equal(guard.caught, true);
  assert.match(guard.command, /apply_patch/);
  const fixture = engine.fixturePath(A.EMPTY_CATCH.detectors.find((d) => d.lever === "edit-observe-guard"));
  assert.equal(fs.existsSync(path.join(root, fixture)), false);
});

test("later governance wiring retains previously approved document pointers", (t) => {
  const root = project(t, { "AGENTS.md": "# Owner\n", "SCOPE.md": "# Scope\n" });
  engine.cmdScan(root, {});
  applyRegion(root, plan(root, { "wire-governance": true }));
  fs.writeFileSync(path.join(root, "ROADMAP.md"), "# Roadmap\n");
  const scan = engine.cmdScan(root, {});
  assert.deepEqual(scan.governance.orphans, ["ROADMAP.md"]);
  applyRegion(root, plan(root, { "wire-governance": true }));
  const text = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.equal(text.split("read `SCOPE.md`").length - 1, 1);
  assert.equal(text.split("read `ROADMAP.md`").length - 1, 1);
  assert.equal(text.split("governance pointers computed from the scan").length - 1, 1);
  assert.deepEqual(engine.cmdScan(root, {}).governance.orphans, []);
});

test("Codex Edit and Write matcher aliases occupy the native patch slot", (t) => {
  for (const alias of ["Edit", "Write"]) {
    const root = project(t, { ".codex/hooks.json": JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: "^" + alias + "$", hooks: [{ type: "command", command: "custom-check" }] }],
    } }) });
    const report = engine.cmdScan(root, {});
    assert.deepEqual(report.occupied, ["PreToolUse:apply_patch"]);
    const slot = report.slots.find((s) => s.slot === "PreToolUse:apply_patch");
    assert.deepEqual(slot.overlap, ["apply_patch"]);
    assert.deepEqual(slot.aliases, [alias]);
    assert.ok(slot.occupiedBy[0].includes("^" + alias + "$"));
    assert.ok(report.disclosures.some((line) => line.includes(alias + " as aliases of apply_patch")));
  }
});

test("a newly appearing instruction override makes the approved AGENTS path stale", (t) => {
  const root = project(t, { "AGENTS.md": "# Owner\n" });
  const record = plan(root, { "checks-rule": true });
  fs.writeFileSync(path.join(root, "AGENTS.override.md"), "# New active policy\n");
  assert.throws(() => applyRegion(root, record), /active instruction file is now AGENTS\.override\.md/);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "# Owner\n");
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.override.md"), "utf8"), "# New active policy\n");
});


test("canonical plan paths cannot conceal metadata or engine-owned state on any OS", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jig-codex-path-"));
  try {
    for (const rel of ["x/../.git/config", "x\\..\\.git\\config"]) {
      assert.match(engine.targetProblem(root, "write-side-file", rel), /inside \.git/);
    }
    for (const rel of ["x/../.jig/journal.jsonl", "x\\..\\.jig\\journal.jsonl"]) {
      assert.match(engine.targetProblem(root, "write-side-file", rel), /belongs to the engine/);
    }
    assert.equal(engine.resolveInsideRoot(root, "..\\outside.json"), null);
    assert.equal(engine.resolveInsideRoot(root, "\\\\server\\share\\file"), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a Codex selftest hands the owner a reproduction through the Codex runner flags", (t) => {
  const root = project(t);
  A.applyPlan(engine, root, plan(root));
  const guard = engine.cmdSelftest(root, {}).probes.find((p) => p.kind === "guard");
  assert.match(guard.command, /"hook_event_name":"PreToolUse"/);
  assert.match(guard.command, / PreToolUse --runtime codex --diagnostic$/);
});

test("a Codex reproduction names Bash even after another host recorded PowerShell", (t) => {
  const root = project(t);
  A.applyPlan(engine, root, plan(root));
  const guardId = engine.cmdSelftest(root, {}).probes.find((p) => p.kind === "guard").probe;
  fs.appendFileSync(path.join(root, ".jig", "ledger.jsonl"), JSON.stringify({ guardId, decision: "pass", tool: "PowerShell" }) + "\n");
  assert.match(engine.cmdSelftest(root, {}).probes.find((p) => p.probe === guardId).command, /"tool_name":"Bash"/);
});

test("the engine CLI takes --runtime for the whole command and refuses a runtime it does not know", (t) => {
  const root = project(t);
  const cli = path.join(__dirname, "..", "scripts", "jig.js");
  const env = { ...process.env };
  delete env.JIG_RUNTIME;
  const run = (...args) => spawnSync(process.execPath, [cli, "scan", "--root", root, ...args], { encoding: "utf8", env, windowsHide: true });
  const codex = run("--runtime", "codex");
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(JSON.parse(codex.stdout).guardrails.host.host, "codex");
  const claude = run();
  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(JSON.parse(claude.stdout).guardrails.host, undefined);
  const unknown = run("--runtime", "cursor");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /--runtime takes claude or codex/);
});
