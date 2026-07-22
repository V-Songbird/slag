"use strict";

// Tier-2 rubric grader (component 7) — the first model-judged tier, for outcomes
// no deterministic assertion can capture. ONE cheap structured yes/no haiku call
// per run, kept OFF the default path: the runner invokes it only when a task
// declares a `rubric` block and the run was started with --rubric. Tier 1 is
// always preferred.
//
// M0 item 15: use the CLI's native `--json-schema` (the validated object arrives
// pre-parsed in top-level `structured_output`), pin score to 0..1 so the model
// doesn't drift scales. Overridable via PROOF_CLAUDE_BIN so tests never spend.

const { spawn } = require("child_process");

const SCHEMA = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 1 },
    reasonCode: { type: "string" },
  },
  required: ["pass", "score", "reasonCode"],
};

// Build the grader prompt (pure). `rubric.question` is the task author's yes/no
// criterion; the agent's response and edited files are the evidence.
function buildRubricPrompt(rubric, ctx) {
  return [
    "You are a strict grader. Judge ONLY the criterion below against the agent's work.",
    "Answer as JSON matching the schema. No prose.",
    "",
    `CRITERION: ${rubric.question}`,
    "",
    `AGENT RESPONSE:\n${(ctx.response || "").slice(0, 4000)}`,
    ctx.editedFiles && ctx.editedFiles.length ? `\nEDITED FILES: ${ctx.editedFiles.join(", ")}` : "",
  ].join("\n");
}

function buildArgs(model) {
  return [
    "-p", "--output-format", "json",
    "--model", model || "haiku",
    "--json-schema", JSON.stringify(SCHEMA),
    "--setting-sources", "project",
    "--exclude-dynamic-system-prompt-sections",
  ];
}

// Parse a raw `--output-format json` envelope into a 0..1 score. Prefers the
// pre-parsed `structured_output`; falls back to JSON inside `result`. Pure.
function parseRubric(raw) {
  let env = null;
  try { env = typeof raw === "string" ? JSON.parse(String(raw).trim().split("\n").pop()) : raw; } catch { /* malformed */ }
  if (!env || env.is_error === true) return { ok: false, score: null, reasonCode: "grader_error" };
  let out = env.structured_output;
  if (!out && typeof env.result === "string") { try { out = JSON.parse(env.result); } catch { /* not json */ } }
  if (!out || typeof out.score !== "number") return { ok: false, score: null, reasonCode: "grader_unparsable" };
  const score = Math.max(0, Math.min(1, out.score));
  return { ok: true, score, pass: !!out.pass, reasonCode: out.reasonCode || "" };
}

// Live grade: spawn the fake/real binary. Off the default path.
function rubricGrade(rubric, ctx, opts = {}) {
  return new Promise((resolve) => {
    const bin = process.env.PROOF_CLAUDE_BIN || "claude";
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const child = spawn(bin, buildArgs(opts.model), { env, shell: true, windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", () => resolve(parseRubric(stdout)));
    child.on("error", () => resolve({ ok: false, score: null, reasonCode: "grader_spawn_error" }));
    child.stdin.write(buildRubricPrompt(rubric, ctx));
    child.stdin.end();
  });
}

module.exports = { buildRubricPrompt, buildArgs, parseRubric, rubricGrade, SCHEMA };
