"use strict";

// Claude adapter — the reference implementation of the run contract:
//
//   runAgent(prompt, checkoutDir, {model, maxBudgetUsd, timeoutMs, allowedTools})
//     -> { ok, cost, turns, response, editedFiles, ... }
//
// Headless flags reflect what a live binary on this host actually honors:
//  - `--permission-mode acceptEdits` auto-approves file edits; declared check
//    commands additionally need `--allowed-tools` scoping (acceptEdits alone
//    denies arbitrary shell), so allowedTools is opt-in per task.
//  - budget is bounded by `--max-budget-usd`, the spend proof actually cares
//    about; `--max-turns` is not relied on (unconfirmed on the current CLI).
//  - `--setting-sources project` + `--exclude-dynamic-system-prompt-sections`
//    keep an operator's global config and per-machine prompt sections from
//    inflating cost and busting cross-run cache.
//  - the nested-session env markers are deleted so a run looks like a fresh one.
//
// `is_error` (not exit code, not `subtype`) is the field trusted for success;
// it correlated 1:1 with the process exit code in every observed case.
//
// The binary is overridable via PROOF_CLAUDE_BIN so the runner can be exercised
// against a fake `claude` with zero API spend.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULTS = { model: "haiku", maxBudgetUsd: 0.25, timeoutMs: 300000 };

// Snapshot every file under a dir as rel -> "mtime:size", so a before/after
// diff yields the files the agent edited without needing to parse tool calls
// out of the transcript (which the cheap `json` envelope does not carry).
function snapshot(dir) {
  const out = new Map();
  const walk = (d, base) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (ent.name === ".git") continue;
        walk(path.join(d, ent.name), base ? base + "/" + ent.name : ent.name);
      } else {
        const st = fs.statSync(path.join(d, ent.name));
        out.set(base ? base + "/" + ent.name : ent.name, st.mtimeMs + ":" + st.size);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return out;
}

function diffEdited(before, after) {
  const edited = [];
  for (const [rel, sig] of after) if (before.get(rel) !== sig) edited.push(rel);
  return edited.sort();
}

// Pure: normalize raw spawn output into the parsed fields. Unit-testable against
// captured envelopes with no spawn.
function parse(raw) {
  let parsed = null;
  try {
    const line = String(raw.stdout || "").trim().split("\n").pop();
    parsed = JSON.parse(line);
  } catch { /* malformed / non-JSON output */ }
  const ok = raw.code === 0 && parsed != null && parsed.is_error !== true && !raw.timedOut;
  return {
    ok,
    cost: parsed && typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0,
    turns: parsed && typeof parsed.num_turns === "number" ? parsed.num_turns : null,
    response: parsed && typeof parsed.result === "string" ? parsed.result : "",
    isError: parsed ? parsed.is_error === true : null,
    parsed,
  };
}

function spawnAgent(prompt, cwd, opts) {
  return new Promise((resolve) => {
    const bin = process.env.PROOF_CLAUDE_BIN || "claude";
    const args = [
      "-p", "--output-format", "json",
      "--model", opts.model,
      "--permission-mode", "acceptEdits",
      "--max-budget-usd", String(opts.maxBudgetUsd),
      "--setting-sources", "project",
      "--exclude-dynamic-system-prompt-sections",
    ];
    if (opts.allowedTools) args.push("--allowed-tools", opts.allowedTools);
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const started = Date.now();
    let timedOut = false;
    const child = spawn(bin, args, { cwd, env, shell: true, windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr: String(stderr).slice(0, 2000), timedOut, wallMs: Date.now() - started });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(err), timedOut, wallMs: Date.now() - started });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function runAgent(prompt, checkoutDir, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const before = snapshot(checkoutDir);
  const raw = await spawnAgent(prompt, checkoutDir, o);
  const p = parse(raw);
  const after = snapshot(checkoutDir);
  return {
    ok: p.ok,
    cost: p.cost,
    turns: p.turns,
    response: p.response,
    editedFiles: diffEdited(before, after),
    isError: p.isError,
    timedOut: raw.timedOut,
    exitCode: raw.code,
    wallMs: raw.wallMs,
    stderr: p.ok ? undefined : raw.stderr,
  };
}

module.exports = { runAgent, parse, snapshot, diffEdited, DEFAULTS };
