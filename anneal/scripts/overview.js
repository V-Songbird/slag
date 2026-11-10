#!/usr/bin/env node
"use strict";

// anneal's front door: one line for each part of the plugin, saying what its own script found in this repository
// and which skill to run next. It runs the audit, the documentation check, the maintenance script and the
// repeated-step search as they are, reads their JSON and adds nothing of its own. No model, no network, and it
// writes nothing: each of those scripts is read-only.

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { directory } = require("./session-evidence-redaction.js");

const USAGE = "usage: overview.js --root <repository> [--json] [--no-sessions] [--claude-home <dir>] [--codex-home <dir>]\n";
const SCRIPT = (name) => path.join(__dirname, name);
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const number = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// One script's JSON, or the first line of what it said when it printed none.
function run(script, args) {
  const ran = spawnSync(process.execPath, [SCRIPT(script), ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 120000 });
  try {
    return { json: JSON.parse(ran.stdout) };
  } catch {
    const said = String(ran.stderr || ran.stdout || (ran.error && ran.error.message) || "it printed nothing").trim().split(/\r?\n/)[0];
    return { error: said.replace(/^[\w-]+\.js: /, "").slice(0, 240) };
  }
}

function navigation(root) {
  const { json, error } = run("audit.js", ["--root", root, "--json"]);
  if (error) return { part: "Navigation", skill: "repo-layout", found: null, next: null, note: error };
  const bySeverity = {};
  for (const finding of json.findings || []) bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
  const kinds = ["high", "medium", "low"].filter((severity) => bySeverity[severity]).map((severity) => `${bySeverity[severity]} ${severity}`);
  const context = json.startContext || {};
  const maps = (json.mapFiles || []).length;
  const over = Number(context.characters) > Number(context.budget);
  const found = [
    kinds.length ? `${kinds.join(", ")} ${kinds.length === 1 && (json.findings || []).length === 1 ? "finding" : "findings"}` : "no findings",
    maps ? plural(maps, "map file") : "no map file",
    Number.isFinite(context.characters) ? `start context ${number(context.characters)} of ${number(context.budget)} characters` : null,
  ].filter(Boolean).join("; ");
  return {
    part: "Navigation", skill: "repo-layout", found,
    counts: { findings: (json.findings || []).length, mapFiles: maps, startContextCharacters: context.characters ?? null, startContextBudget: context.budget ?? null },
    next: kinds.length || !maps || over ? "repo-layout audit" : null,
  };
}

function documentation(root) {
  const check = run("docs-check.js", ["--root", root, "--json"]);
  const maintenance = run("docs-maintenance.js", ["--root", root, "--json"]);
  if (check.error && maintenance.error) return { part: "Documentation", skill: "repo-docs", found: null, next: null, note: check.error };
  const counts = (check.json && check.json.counts) || {};
  const findings = (counts.high || 0) + (counts.medium || 0) + (counts.low || 0);
  const proposed = (maintenance.json && maintenance.json.counts) || {};
  const proposals = Object.values(proposed).reduce((sum, count) => sum + count, 0);
  const memory = Object.entries(proposed).filter(([kind]) => kind.startsWith("memory-")).reduce((sum, [, count]) => sum + count, 0);
  // With no maintained record the check has nothing to judge, so the next step is to choose where records go.
  if (check.json && check.json.docs === 0 && !proposals) {
    return { part: "Documentation", skill: "repo-docs", found: "no maintained records under docs/", counts: { checkFindings: 0, maintenanceProposals: 0 }, next: "repo-docs adopt" };
  }
  const found = [
    check.error ? null : `${plural(findings, "check finding")}${findings ? ` (${counts.high || 0} high)` : ""}`,
    maintenance.error ? null : `${plural(proposals, "maintenance proposal")}${memory ? `, ${memory} about native memory` : ""}`,
  ].filter(Boolean).join("; ");
  return {
    part: "Documentation", skill: "repo-docs", found, counts: { checkFindings: check.error ? null : findings, maintenanceProposals: maintenance.error ? null : proposals },
    next: [findings ? "repo-docs audit" : null, proposals ? "repo-docs maintain" : null].filter(Boolean).join(", then ") || null,
    ...(check.error || maintenance.error ? { note: check.error || maintenance.error } : {}),
  };
}

function sessions(root, homes) {
  const { json, error } = run("session-repeats.js", ["--root", root, ...homes]);
  if (error) return { part: "Past sessions", skill: "session-review", found: null, next: null, note: error };
  const read = json.sessionsRead || {};
  const unnamed = ["commands", "sequences", "lookups"].flatMap((kind) => json.findings[kind] || []).filter((finding) => !finding.namedInMap).length;
  const shared = (json.findings.navigation || []).length;
  const found = [
    `${plural((read.claude || 0) + (read.codex || 0), "session")} read`,
    `${plural(unnamed, "repeated step")} the map does not name`,
    `${plural(shared, "navigation finding")} shared by sessions`,
  ].join("; ");
  return {
    part: "Past sessions", skill: "session-review", found,
    counts: { sessions: (read.claude || 0) + (read.codex || 0), subagentTranscripts: read.subagentTranscripts || 0, repeatedStepsNotInMap: unnamed, sharedNavigationFindings: shared },
    next: unnamed || shared ? "session-review all" : null,
  };
}

function main(argv) {
  const args = argv.slice(2);
  const options = { root: null, json: false, sessions: true, homes: [] };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--json") options.json = true;
    else if (args[i] === "--no-sessions") options.sessions = false;
    else if (args[i] === "--root" && i + 1 < args.length) options.root = args[++i];
    else if ((args[i] === "--claude-home" || args[i] === "--codex-home") && i + 1 < args.length) options.homes.push(args[i], args[++i]);
    else return fail(USAGE, 2);
  }
  if (options.root === null) return fail(USAGE, 2);
  const root = path.resolve(options.root);
  const parts = [
    navigation(root),
    documentation(root),
    ...(options.sessions ? [sessions(root, options.homes)] : []),
    { part: "This session", skill: "session-review", found: "read only when you run it", next: "session-review" },
  ];
  const report = {
    tool: "anneal-overview", root: directory(root), parts,
    invocation: "Run a skill as /anneal:<name> on Claude Code, $<name> on Codex or /<name> on Antigravity.",
    limits: "Each line repeats what that part's own script counted: heuristic findings, proposals and candidates, none of them verified. "
      + "A part with nothing next still accepts a request. Past sessions are read for counts only.",
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  const width = Math.max(...parts.map((part) => part.part.length));
  const lines = [`anneal overview of ${report.root}`, ""];
  for (const part of parts) {
    lines.push(`${part.part.padEnd(width)}  ${part.found === null ? `not available: ${part.note}` : part.found}`);
    lines.push(`${"".padEnd(width)}  next: ${part.next === null ? "nothing to do" : part.next}`);
  }
  lines.push("", report.invocation, report.limits);
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function fail(message, code) {
  process.stderr.write(message);
  return code;
}

if (require.main === module) process.exitCode = main(process.argv);

module.exports = { main };
