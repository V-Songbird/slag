#!/usr/bin/env node
"use strict";

// anneal's session evidence: where one session lost time. Reads one Claude Code
// transcript or one Codex rollout and prints bounded candidates as JSON: failures,
// and navigation candidates that pair what happened with a cause it might have.
// Read-only: it opens no other session and never touches an instruction file.
// It prints what session-evidence-claude.js and session-evidence-codex.js read, with the shell
// classification, navigation candidates, records and redaction they share in the sibling
// session-evidence-*.js modules. Neither host documents its transcript format, so every record
// shape read there is held by a fixture in one of the tests/session-evidence*.test.js files.

const fs = require("node:fs");
const path = require("node:path");
const { HOME, redact } = require("./session-evidence-redaction.js");
const { parseCutoff, records } = require("./session-evidence-records.js");
const { analyzeClaude } = require("./session-evidence-claude.js");
const { analyzeCodex } = require("./session-evidence-codex.js");

const SESSION_VARIABLES = { claude: "CLAUDE_CODE_SESSION_ID", codex: "CODEX_THREAD_ID" };

const ANALYZERS = { claude: analyzeClaude, codex: analyzeCodex };

// Codex rollout records wrap their data in a payload; Claude Code transcript records do not.
function detectHost(file) {
  const warnings = new Set();
  for (const [, row] of records(fs.readFileSync(file), warnings)) return "payload" in row ? "codex" : "claude";
  throw new Error("The transcript holds no complete record.");
}

function walk(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

// Never the latest session by guess: one id, and exactly one file that carries it.
function findTranscript(host, sessionId, homes) {
  if (!homes[host]) return [];
  if (host === "codex") return walk(path.join(homes.codex, "sessions")).filter((file) => file.endsWith(`${sessionId}.jsonl`));
  const projects = path.join(homes.claude, "projects");
  let names = [];
  try {
    names = fs.readdirSync(projects);
  } catch {
    return [];
  }
  return names.map((name) => path.join(projects, name, `${sessionId}.jsonl`)).filter((file) => fs.existsSync(file));
}

const USAGE = "usage: session-evidence.js [--session-file <file>] [--host claude|codex] [--session-id <id>]\n"
  + "       [--claude-home <dir>] [--codex-home <dir>] [--before <ISO time with zone> | --before-line <line>] [--limit <1-30>]\n";

function main(argv, env = process.env) {
  const options = {
    "--session-file": null, "--host": null, "--session-id": null, "--before": null, "--before-line": null, "--limit": "6",
    "--claude-home": env.CLAUDE_CONFIG_DIR || (HOME ? path.join(HOME, ".claude") : null),
    "--codex-home": env.CODEX_HOME || (HOME ? path.join(HOME, ".codex") : null),
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!(args[i] in options) || i + 1 >= args.length) return fail(USAGE, 2);
    options[args[i]] = args[i + 1];
  }
  const limit = Number(options["--limit"]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) return fail("session-evidence.js: --limit must be between 1 and 30\n", 2);
  // A line cutoff selects exactly the records before that line of the transcript, as the default cutoff does.
  const beforeLine = options["--before-line"] === null ? null : Number(options["--before-line"]);
  if (beforeLine !== null && (!/^\d+$/.test(options["--before-line"]) || !Number.isSafeInteger(beforeLine) || beforeLine < 1)) {
    return fail("session-evidence.js: --before-line must be a line number, 1 or more\n", 2);
  }
  if (beforeLine !== null && options["--before"] !== null) return fail("session-evidence.js: give --before or --before-line, not both\n", 2);
  let host = options["--host"];
  if (host !== null && !(host in ANALYZERS)) return fail(USAGE, 2);

  let file = options["--session-file"];
  if (file === null) {
    if (host === null) {
      const present = Object.keys(SESSION_VARIABLES).filter((name) => env[SESSION_VARIABLES[name]]);
      if (present.length !== 1) {
        return fail("session-evidence.js: cannot tell the host, because CLAUDE_CODE_SESSION_ID and CODEX_THREAD_ID are both set "
          + "or both missing. Supply --host or --session-file.\n", 2);
      }
      host = present[0];
    }
    const sessionId = options["--session-id"] || env[SESSION_VARIABLES[host]] || "";
    if (!/^[a-fA-F0-9-]{16,64}$/.test(sessionId)) {
      return fail("session-evidence.js: no unambiguous session id. Supply --session-file or --session-id.\n", 2);
    }
    const matches = findTranscript(host, sessionId, { claude: options["--claude-home"], codex: options["--codex-home"] });
    if (matches.length !== 1) {
      return fail(`session-evidence.js: expected one transcript for that session, found ${matches.length}. Supply --session-file.\n`, 2);
    }
    file = matches[0];
  }
  try {
    file = path.resolve(file);
    const before = options["--before"] === null ? beforeLine : parseCutoff(options["--before"]);
    host = host || detectHost(file);
    process.stdout.write(`${JSON.stringify({ host, ...ANALYZERS[host](file, before, limit) }, null, 2)}\n`);
    return 0;
  } catch (error) {
    return fail(`session-evidence.js: cannot extract reliable session evidence: ${error.message}\n`, 1);
  }
}

function fail(message, code) {
  process.stderr.write(message);
  return code;
}

if (require.main === module) process.exitCode = main(process.argv);

module.exports = { analyzeClaude, analyzeCodex, detectHost, redact, main };
