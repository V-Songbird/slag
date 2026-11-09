// Runs a plugin's eval cases through the Claude Agent SDK instead of
// `claude plugin eval`, so the sessions bill an API key rather than a Claude
// plan. Each case runs in two arms, with the plugin and without it, in a fresh
// workspace built by its scaffold_script; the graders then score the run.
// `--ablation none` runs only the arm with the plugin, for anneal's paired
// navigation cases, whose arms are their two snapshots.
//
//   node --env-file=<.env with ANTHROPIC_API_KEY> scripts/sdk-eval/run.mjs <plugin-dir> \
//     --output-dir <outside the repo> [--case <name>]... [--tag <tag>]... [--runs 3]
//     [--ablation none] [--concurrency 3] [--max-cost-usd 5] [--model claude-opus-5-5]
//     [--judge-model claude-sonnet-5-5]
//
// Bash runs unconfined: no sandbox wraps the session. Each workspace sits under
// --output-dir and is kept for inspection. Sessions and the judge always call
// https://api.anthropic.com; a base URL set in the environment is ignored.

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { selectCases, runFromMessages, gradersFor, gradeRun, listRunFiles, createdPaths, sessionEnv, JUDGE_CLIENT, runArms, sessionOptions, resultError, sessionSpend, runError, runRecord, recordJob, reportBatch, batchStop } from "./lib.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// USD per million [input, output] tokens, for the judge and for a session that
// ended with no reported cost; an unknown session model is priced as Opus.
const PRICE = { "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20], "claude-haiku-5-5": [0.1, 0.5] };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "output-dir": { type: "string" },
    case: { type: "string", multiple: true, default: [] },
    tag: { type: "string", multiple: true, default: [] },
    runs: { type: "string", default: "3" },
    ablation: { type: "string" },
    concurrency: { type: "string", default: "3" },
    "max-cost-usd": { type: "string", default: "5" },
    model: { type: "string", default: "claude-opus-5-5" },
    "judge-model": { type: "string", default: "claude-sonnet-5-5" },
  },
});

function fail(message) {
  console.error(message);
  process.exit(2);
}

if (positionals.length !== 1) fail("usage: run.mjs <plugin-dir> --output-dir <dir> [options]");
if (!process.env.ANTHROPIC_API_KEY) fail("ANTHROPIC_API_KEY is not set; pass --env-file=<file> to node.");
const pluginDir = path.resolve(positionals[0]);
if (!values["output-dir"]) fail("--output-dir is required.");
const outDir = path.resolve(values["output-dir"]);
const fromRepo = path.relative(REPO, outDir);
if (!fromRepo.startsWith("..") && !path.isAbsolute(fromRepo)) fail("--output-dir must be outside the repository.");
// Workspaces nest deep under --output-dir, and Windows fails a spawn whose cwd
// passes 260 characters with a bare ENOENT.
if (process.platform === "win32" && outDir.length > 120) fail(`--output-dir is ${outDir.length} characters; keep it under 120 on Windows.`);
const runs = Number(values.runs);
const maxCost = Number(values["max-cost-usd"]);
let arms;
try {
  arms = runArms(values.ablation);
} catch (error) {
  fail(error.message);
}

// The bash that runs scaffolds and the session's Bash tool. On Windows, `bash`
// on PATH is often the WSL launcher, so use Git's own bash: bin/bash.exe, which
// puts Git's tools on PATH, unlike usr/bin/bash.exe started from Windows.
function findBash() {
  if (process.platform !== "win32") return "bash";
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) return process.env.CLAUDE_CODE_GIT_BASH_PATH;
  const exec = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const bash = path.resolve(exec, "../../../bin/bash.exe");
  if (!fs.existsSync(bash)) fail(`Git Bash not found at ${bash}; set CLAUDE_CODE_GIT_BASH_PATH.`);
  return bash;
}
const BASH = findBash();

const SESSION_ENV = sessionEnv(process.env);

const cases = selectCases(pluginDir, { names: values.case, tags: values.tag });
if (cases.length === 0) fail(`No eval cases selected under ${path.join(pluginDir, "evals")}.`);

const jobs = cases.flatMap((c) => arms.flatMap((arm) => Array.from({ length: runs }, (_, i) => ({ c, arm, n: i + 1 }))));
let spent = 0;
// Stopping the batch keeps workers from taking new jobs and aborts the sessions still running.
const batch = batchStop();
const judge = new Anthropic(JUDGE_CLIENT);

async function judgeGrader(grader, text) {
  const response = await judge.beta.messages.create({
    model: values["judge-model"],
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { verdict: { type: "string", enum: ["PASS", "FAIL"] }, reason: { type: "string" } },
          required: ["verdict", "reason"],
          additionalProperties: false,
        },
      },
    },
    system: "You grade one run of a coding agent against the criteria the user gives. Apply the criteria literally.",
    messages: [{ role: "user", content: `Criteria:\n${grader.criteria}\n\nText to grade:\n<text>\n${text}\n</text>` }],
  });
  const [inPrice, outPrice] = PRICE[values["judge-model"]] ?? [0, 0];
  spent += (response.usage.input_tokens * inPrice + response.usage.output_tokens * outPrice) / 1e6;
  if (response.stop_reason === "refusal") return { pass: false, reason: "judge refused" };
  const answer = response.content.find((block) => block.type === "text")?.text ?? "{}";
  const parsed = JSON.parse(answer);
  return { pass: parsed.verdict === "PASS", reason: parsed.reason };
}

const runDirOf = ({ c, arm, n }) => path.join(outDir, c.name, `${arm}-${n}`);
// Recreates a missing run folder, such as one the session removed, so the
// record still saves.
const saveRecord = (job, record) => {
  fs.mkdirSync(runDirOf(job), { recursive: true });
  fs.writeFileSync(path.join(runDirOf(job), "result.json"), `${JSON.stringify(record, null, 2)}\n`);
};

async function runJob(job) {
  const { c, arm, n } = job;
  const runDir = runDirOf(job);
  const work = path.join(runDir, "work");
  fs.mkdirSync(work, { recursive: true });
  const finish = (record) => {
    saveRecord(job, record);
    return record;
  };
  if (c.scaffold) {
    const scaffold = spawnSync(BASH, [path.join(c.dir, c.scaffold).split(path.sep).join("/")], { cwd: work, encoding: "utf8" });
    if (scaffold.status !== 0) return finish(runRecord(c, arm, n, runFromMessages([]), { seconds: 0, error: `scaffold failed: ${scaffold.error?.message ?? scaffold.stderr.trim().split("\n").slice(-3).join(" | ")}` }));
  }
  const before = listRunFiles(work);
  const home = path.join(runDir, "home");
  fs.mkdirSync(home, { recursive: true });
  const abortController = new AbortController();
  batch.live.add(abortController);
  const timer = setTimeout(() => abortController.abort(), c.timeoutSeconds * 1000);
  const messages = [];
  const started = Date.now();
  try {
    for await (const message of query({
      prompt: c.prompt,
      options: {
        ...sessionOptions(c, arm, { pluginDir, model: values.model }),
        cwd: work,
        abortController,
        // A fresh home hides installed plugins (~/.claude/plugins), which a run
        // without the plugin otherwise finds and uses. It hides nothing else:
        // Bash can still read any path on the machine.
        // CLAUDE_CODE_STARTUP_FAILURE_RESULTS makes every known startup failure end in a result with its reason.
        env: { ...SESSION_ENV, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(runDir, "config"), CLAUDE_CODE_GIT_BASH_PATH: BASH, CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1" },
      },
    })) {
      if (message.type === "system" && message.subtype === "init" && message.apiKeySource !== "ANTHROPIC_API_KEY") {
        batch.stop(abortController);
        throw new Error(`session used ${message.apiKeySource}, not ANTHROPIC_API_KEY; stopping every run`);
      }
      messages.push(message);
      // A session that has its result is past the batch's abort.
      if (message.type === "result") batch.live.delete(abortController);
      const ended = resultError(message, { aborted: abortController.signal.aborted });
      if (ended) {
        if (ended.stop) batch.stop(abortController);
        messages.push({ type: "runner_error", message: ended.message });
      }
    }
  } catch (error) {
    messages.push({ type: "runner_error", message: error?.message || String(error) });
  } finally {
    clearTimeout(timer);
    batch.live.delete(abortController);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  // Count the session's spend before any workspace read that can throw.
  const run = runFromMessages(messages);
  spent += sessionSpend(run, PRICE[values.model] ?? PRICE["claude-opus-5-5"]);
  // What a runner-failed record keeps if a later step throws.
  job.session = { subtype: run.subtype, costUsd: run.costUsd, turns: run.turns, reply: run.reply, seconds };
  Object.assign(run, { dir: work, created: createdPaths(before, listRunFiles(work)) });
  fs.writeFileSync(path.join(runDir, "trace.jsonl"), `${run.trace}\n`);
  // An abort can end the stream quietly as well as throw.
  const { aborted, reason } = abortController.signal;
  const error = runError(messages, { aborted, reason, timeoutSeconds: c.timeoutSeconds });
  if (error) return finish(runRecord(c, arm, n, run, { seconds, error }));
  const graded = await gradeRun(gradersFor(c.graders, arm), run, judgeGrader);
  if (graded.stop) batch.stop();
  return finish(runRecord(c, arm, n, run, { seconds, ...graded }));
}

const records = [];
let next = 0;
async function worker() {
  while (next < jobs.length && !batch.stopped) {
    if (spent >= maxCost) {
      batch.stop();
      console.log(`Stopped: estimated spend $${spent.toFixed(2)} reached --max-cost-usd ${maxCost}.`);
      break;
    }
    const job = jobs[next++];
    const record = await recordJob(job, runJob, { save: saveRecord, stop: () => batch.stop() });
    records.push(record);
    const failed = Object.entries(record.grades ?? {}).filter(([, g]) => !g.pass).map(([name]) => name);
    console.log(`${record.case} ${record.arm}-${record.n}: ${record.error ?? `${record.subtype}, $${(record.costUsd ?? 0).toFixed(2)}, failed: ${failed.join(", ") || "none"}`}`);
  }
}
fs.mkdirSync(outDir, { recursive: true });
await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));

const unwritten = reportBatch({ outDir, spent, records, total: jobs.length });
if (unwritten) {
  console.error(`summary.json not written: ${unwritten.message}`);
  process.exitCode = 1;
}
