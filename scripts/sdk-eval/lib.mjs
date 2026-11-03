// The parts of the SDK eval runner that need no model: reading a case, turning
// the SDK's messages into the run the graders read, and deciding the
// deterministic verdicts. Verdicts come from anneal's eval-harness.js, the same
// evaluator the offline grader tests use, so both read a grader the same way.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const harness = require("../../anneal/tests/eval-harness.js");
export const { listRunFiles, createdPaths } = harness;

const HEAD = /^---\s*\n([\s\S]*?)---\s*\n?/;

// The environment an eval session gets. A runner started from inside a Claude
// Code session inherits that session's CLAUDE* variables; CLAUDE_CODE_ENTRYPOINT
// among them makes each eval session identify as Claude Code, which the API
// credit refuses ("Credit balance is too low"), so none reach the sessions and
// the SDK sets its own entrypoint. Every ANTHROPIC_* variable but the API key is
// dropped too, so a base URL, token or model set on the machine cannot send a
// session to another endpoint or model.
export const sessionEnv = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !/^CLAUDE/i.test(key) && (!/^ANTHROPIC_/i.test(key) || key === "ANTHROPIC_API_KEY")));

// The judge client's options. Explicit, because the client otherwise reads
// ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN from the environment.
export const JUDGE_CLIENT = { baseURL: "https://api.anthropic.com", authToken: null };

// The arms each case runs in: with and without the plugin, or under
// `--ablation none` only with it, for anneal's paired navigation cases, whose
// arms are their two snapshots.
export function runArms(ablation) {
  if (ablation === undefined) return ["with", "without"];
  if (ablation === "none") return ["with"];
  throw new Error("--ablation takes only none.");
}

// The query options of one session that need no SDK object or per-run path.
export const sessionOptions = (c, arm, { pluginDir, model }) => ({
  model,
  maxTurns: c.maxTurns,
  allowedTools: c.allowedTools,
  // Windows adds a PowerShell tool the POSIX harness never offers; sessions try it and are denied.
  disallowedTools: ["PowerShell"],
  permissionMode: "dontAsk",
  // User settings only, from the empty per-run config dir, as the eval harness
  // does: a fixture's CLAUDE.md and AGENTS.md do not load, so a map reaches the
  // session only through a read the prompt asks for.
  settingSources: ["user"],
  plugins: arm === "with" ? [{ type: "local", path: pluginDir }] : [],
  maxBudgetUsd: 2,
});

// One case folder: its tags and scaffold from case.yaml, its session limits and
// prompt from prompt.md, and its graders.
export function readCase(caseDir) {
  const yaml = fs.readFileSync(path.join(caseDir, "case.yaml"), "utf8");
  const promptFile = path.join(caseDir, "prompt.md");
  const head = harness.frontmatter(promptFile);
  return {
    name: path.basename(caseDir),
    dir: caseDir,
    tags: (/^tags: \[(.*)\]$/m.exec(yaml)?.[1] ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
    scaffold: /^ {2}scaffold_script: (\S+)$/m.exec(yaml)?.[1] ?? null,
    maxTurns: Number(head.max_turns ?? 30),
    timeoutSeconds: Number(head.timeout_seconds ?? 600),
    allowedTools: head.allowed_tools ?? [],
    prompt: fs.readFileSync(promptFile, "utf8").replace(HEAD, "").trim(),
    graders: harness.readGraders(caseDir),
  };
}

// The cases under a plugin's evals/ folder, narrowed by --case and --tag.
export function selectCases(pluginDir, { names = [], tags = [] } = {}) {
  const evals = path.join(pluginDir, "evals");
  return fs.readdirSync(evals, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(evals, entry.name, "case.yaml")))
    .map((entry) => readCase(path.join(evals, entry.name)))
    .filter((c) => (names.length === 0 || names.includes(c.name)) && (tags.length === 0 || c.tags.some((tag) => tags.includes(tag))));
}

// On Windows the file tools take paths like `.collet\checks\x.mjs`, while the
// graders were written against the POSIX harness and match `.collet/checks/`.
const PATH_KEYS = new Set(["file_path", "path", "notebook_path"]);
const posixPaths = (message) => JSON.parse(JSON.stringify(message), (key, value) => (PATH_KEYS.has(key) && typeof value === "string" ? value.replaceAll("\\", "/") : value));

// The run the graders read, from the SDK's messages: every message serialized
// on its own line, with POSIX path separators in tool inputs, the tool calls,
// the final reply, and the cost.
export function runFromMessages(raw) {
  const messages = raw.map(posixPaths);
  const calls = [];
  let reply = "";
  let result = null;
  for (const message of messages) {
    if (message.type === "assistant") {
      for (const block of message.message?.content ?? []) {
        if (block.type === "tool_use") calls.push({ name: block.name, input: block.input });
        if (block.type === "text") reply = block.text;
      }
    }
    if (message.type === "result") result = message;
  }
  if (typeof result?.result === "string" && result.result) reply = result.result;
  return {
    trace: messages.map((message) => JSON.stringify(message)).join("\n"),
    calls,
    reply,
    costUsd: result?.total_cost_usd ?? null,
    turns: result?.num_turns ?? null,
    subtype: result?.subtype ?? "no-result",
  };
}

// The graders that apply to an arm: `arm: with-only` skips the run without the plugin.
export const gradersFor = (graders, arm) => graders.filter((grader) => grader.arm !== "with-only" || arm === "with");

// Why a session yields no grades: its timeout, or the runner's own error.
export function runError(messages, { aborted, timeoutSeconds }) {
  if (aborted) return `timed out after ${timeoutSeconds} seconds`;
  const found = messages.find((message) => message.type === "runner_error");
  return found ? String(found.message || "runner error") : null;
}

// The result.json of one run. A scaffold failure, a runner error or a timeout is
// a result too: it keeps its turns, seconds and cost, and fails every grader of
// its arm, since a run is correct only when every grader passes.
export function runRecord(c, arm, n, run, { seconds, error = null, grades = {} }) {
  const record = { case: c.name, arm, n, subtype: run.subtype, costUsd: run.costUsd, turns: run.turns, seconds, reply: run.reply };
  if (error === null) return { ...record, grades };
  const failed = Object.fromEntries(gradersFor(c.graders, arm).map((grader) => [grader.name, { pass: false, reason: `not graded: ${error}` }]));
  return { ...record, error, grades: failed };
}

// Pass counts per case, grader and arm, and the runs that errored or timed out.
export function summarize(records) {
  const summary = {};
  for (const record of records) {
    for (const [name, grade] of Object.entries(record.grades)) {
      const row = ((summary[record.case] ??= {})[name] ??= { with: [0, 0], without: [0, 0] });
      row[record.arm][1]++;
      if (grade.pass) row[record.arm][0]++;
    }
  }
  const errors = records.filter((record) => record.error).map(({ case: name, arm, n, error }) => ({ case: name, arm, n, error }));
  return { summary, errors };
}

// A deterministic verdict, or null for an llm grader.
export const verdict = (grader, run) => harness.passes(grader, run);

// The grades of a finished run: a deterministic verdict, or the judge's for an
// llm grader. A judge call that throws, such as an API error or a reply that is
// not JSON, fails that grader with the reason and leaves the others graded.
export async function gradeRun(graders, run, judge) {
  const grades = {};
  for (const grader of graders) {
    const fixed = verdict(grader, run);
    if (fixed !== null) grades[grader.name] = { pass: fixed };
    else {
      try {
        grades[grader.name] = await judge(grader, run);
      } catch (error) {
        grades[grader.name] = { pass: false, reason: `judge error: ${error?.message || String(error)}` };
      }
    }
  }
  return grades;
}

// The text an llm grader's judge reads.
export function judgeText(grader, run) {
  const focus = grader.focus ?? "last_message";
  if (focus === "last_message") return run.reply ?? "";
  if (focus === "trace") return run.trace ?? "";
  if (focus === "files") return run.created ?? "";
  const file = path.join(run.dir, focus.path);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "(the file does not exist)";
}
