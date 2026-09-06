#!/usr/bin/env node
"use strict";

// A deterministic host integration probe, not a model benchmark. An in-process
// Responses server supplies harmless, fixed tool calls to the real Codex CLI.
// Fixture project writes stay in a fresh temporary directory. By default the
// plugin and CLI home are isolated too; --installed uses the owner's existing
// plugin and persisted hook trust without installing or changing any settings.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const engine = require("../jig.js");
const { packageCodex } = require("../package-codex.js");
const { fixtureGitEnvironment, withFixtureGitEnvironment } = require("./fixture-isolation.js");

function cliCommand(explicit) {
  if (explicit) return { command: explicit, prefix: [] };
  if (process.platform !== "win32") return { command: "codex", prefix: [] };
  const found = spawnSync("where.exe", ["codex"], { encoding: "utf8", windowsHide: true });
  for (const item of String(found.stdout || "").trim().split(/\r?\n/)) {
    if (/\.exe$/i.test(item)) return { command: item, prefix: [] };
    const js = path.join(path.dirname(item), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(js)) return { command: process.execPath, prefix: [js] };
  }
  throw new Error("Codex was not found; pass --codex <path-to-codex-executable>");
}

function run(cli, args, options, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    // A new POSIX process group lets the timeout stop Codex and its tools.
    const child = spawn(cli.command, [...cli.prefix, ...args], { ...options, windowsHide: true, detached: process.platform !== "win32" });
    let stdout = "", stderr = "", timedOut = false, finished = false, fallback;
    const finish = (error, code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(fallback);
      if (error) reject(error);
      else resolve({ code, stdout, stderr, timedOut });
    };
    child.stdin.end();
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        // Only the process tree this probe started; no user Codex sessions.
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => { child.kill("SIGKILL"); });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") child.kill("SIGKILL"); }
      }
      // A descendant with inherited pipes must not make the advertised timeout
      // unbounded, even if the OS fails to finish closing its handles.
      fallback = setTimeout(() => {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        child.unref();
        finish(null, null);
      }, 1000);
    }, timeoutMs);
    child.on("error", (error) => { finish(error); });
    child.on("close", (code) => { finish(null, code); });
  });
}

function probeCheck(id, lever, pattern) {
  const runner = "PreToolUse";
  const fixtures = { violation: pattern + "\n", nearMiss: "JIG_PROBE_SAFE\n" };
  const detectors = [{ lever, actor: "codex-session", confidence: "deterministic",
    params: { patterns: [pattern], ...(lever === "edit-guard" ? { paths: ["**/*.js"], onlyWhenIntroduced: true } : {}) } }];
  const deny = { reason: "Jig host probe caught " + id, alternative: "use the harmless JIG_PROBE_SAFE fixture instead", override: "the probe owner can remove the temporary guard" };
  const values = { id, title: id, severity: "safety", actor: "codex-session", confidence: "deterministic", fixtures, deny,
    detectors: detectors.map((detector) => ({ ...detector, id: lever + "-0", runner })) };
  return { ...values, axes: ["agent"], detectors,
    module: Object.entries(values).map(([key, value]) => "export const " + key + " = " + JSON.stringify(value) + ";").join("\n") + "\n" };
}

function prepareProject(project, gitEnvironment) {
  return withFixtureGitEnvironment(gitEnvironment, () => {
    fs.mkdirSync(project, { recursive: true });
    const git = spawnSync("git", ["init", "-q", "-b", "jig-probe"], { cwd: project, encoding: "utf8", windowsHide: true, timeout: 20000 });
    if (git.status !== 0) throw new Error("could not initialize temporary probe repository: " + git.stderr);
    fs.writeFileSync(path.join(project, "verify-pass.js"), "process.exit(0);\n");
    fs.writeFileSync(path.join(project, "verify-fail.js"), "process.exit(3);\n");
    engine.cmdScan(project, { _: [], change: [] });
    const authored = path.join(project, ".jig", "authored.json");
    fs.writeFileSync(authored, JSON.stringify({ schemaVersion: 1, checks: [
      probeCheck("probe-command", "bash-guard", "JIG_PROBE_DENY_COMMAND"),
      probeCheck("probe-edit", "edit-guard", "JIG_PROBE_DENY_EDIT"),
    ] }));
    const plan = engine.cmdPlan(project, { _: [], change: [], authored, provenance: "elicited", "no-ci": true });
    // These are precisely the two fixture guards above, in a disposable repo.
    // Apply still exercises the engine's normal named change/path boundary.
    for (const change of plan.changes) engine.cmdApply(project, { _: [], change: [change.id], path: [change.path] });
    fs.writeFileSync(path.join(project, ".jig", "verify.json"), JSON.stringify({ schemaVersion: 1, entries: [
      { id: "probe-pass", argv: ["node", "verify-pass.js"], lanes: ["commit"], paths: ["**/*.js"], expectedExit: 0 },
      { id: "probe-fail", argv: ["node", "verify-fail.js"], lanes: ["commit"], paths: ["**/*.js"], expectedExit: 0 },
    ] }));
  });
}

function evaluateHostChecks({ execution, requestCount, expectedRequests, serverError, project, rows }) {
  const nativeDenial = (id) => rows.some((row) => row.classId === id && row.decision === "deny" && row.host === "codex" && row.actor === "codex-session");
  const rawUnknown = (id) => {
    const raw = rows.filter((row) => row.verify === id && (row.host === "codex" || row.tool === "Bash" || row.lane == null));
    return raw.length > 0 && raw.every((row) => row.host === "codex" && row.actor === "codex-session" && row.event === "PostToolUse"
      && row.tool === "Bash" && row.decision === "verify-unknown" && row.exitCode === null);
  };
  const driverWitness = (id, decision, exitCode) => rows.some((row) => row.verify === id && row.decision === decision
    && row.exitCode === exitCode && row.lane === "commit" && row.tool == null && row.session == null && row.host == null);
  const nearMiss = path.join(project, "safe-edit.js");
  return {
    hostExited: execution.code === 0 && !execution.timedOut,
    requestsCompleted: requestCount === expectedRequests && !serverError,
    commandPrevented: !fs.existsSync(path.join(project, "blocked-command.txt")) && nativeDenial("probe-command"),
    editPrevented: !fs.existsSync(path.join(project, "blocked-edit.js")) && nativeDenial("probe-edit"),
    nearMissAllowed: fs.existsSync(nearMiss) && fs.readFileSync(nearMiss, "utf8") === "JIG_PROBE_SAFE();\n",
    rawShellOutcomesNotInvented: ["probe-pass", "probe-fail"].every(rawUnknown),
    driverPassingVerificationRecorded: driverWitness("probe-pass", "verified", 0),
    driverFailingVerificationRecorded: driverWitness("probe-fail", "verify-failed", 3),
  };
}

async function hostProbe(options = {}) {
  const cli = cliCommand(options.codex);
  const probeParent = path.resolve(__dirname, "..", "..", ".codex-test");
  fs.mkdirSync(probeParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(probeParent, "host-"));
  const project = path.join(root, "project");
  const installed = options.installed === true;
  const modelOverride = options.model || (installed ? null : "gpt-5.4");
  const home = installed ? path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) : path.join(root, "codex-home");
  if (!installed) fs.mkdirSync(home);
  const gitEnvironment = fixtureGitEnvironment(path.join(root, "git-isolation"));
  prepareProject(project, gitEnvironment);
  // Keep CODEX_HOME's ordinary meaning. Installed mode inherits the actual
  // current home; isolated mode creates a new one. Neither copies credentials.
  const env = { ...gitEnvironment, ...(installed ? {} : { CODEX_HOME: home }) };
  delete env.OPENAI_API_KEY;
  const launch = { env, cwd: project };
  const version = await run(cli, ["--version"], launch);
  if (!installed) {
    const packaged = packageCodex(path.join(root, "marketplace"));
    for (const args of [["plugin", "marketplace", "add", packaged.root], ["plugin", "add", "jig@jig-local", "--json"]]) {
      const result = await run(cli, args, launch);
      if (result.code !== 0) throw new Error("temporary plugin install failed: " + result.stderr + result.stdout + "\nEvidence: " + root);
    }
  }

  const calls = [
    { shell: "node -e \"require('fs').writeFileSync('blocked-command.txt','JIG_PROBE_DENY_COMMAND')\"" },
    { patch: "*** Begin Patch\n*** Add File: blocked-edit.js\n+JIG_PROBE_DENY_EDIT();\n*** End Patch" },
    { patch: "*** Begin Patch\n*** Add File: safe-edit.js\n+JIG_PROBE_SAFE();\n*** End Patch" },
    { shell: "node verify-pass.js" },
    { shell: "node verify-fail.js" },
    { shell: "node .jig/checks/run.mjs --verify --lane commit --entry probe-pass" },
    { shell: "node .jig/checks/run.mjs --verify --lane commit --entry probe-fail" },
  ];
  let requestCount = 0;
  const captured = [];
  const httpRequests = [];
  let serverError = null;
  const server = http.createServer((req, res) => {
    const requestPath = new URL(req.url, "http://127.0.0.1").pathname;
    httpRequests.push({ method: req.method, path: requestPath });
    // Installed clients can make ancillary GETs (for example provider health
    // or model discovery). They are not Responses turns and carry no JSON.
    if (req.method !== "POST" || !requestPath.endsWith("/responses")) {
      res.writeHead(404); res.end("Only fixed Responses fixture calls are supported."); return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const request = JSON.parse(body);
        captured.push({ input: request.input, tools: request.tools });
        const tools = request.tools || [];
        const next = calls[requestCount++];
        let item;
        if (next && next.shell) {
          const name = ["exec_command", "shell_command", "shell"].find((candidate) => tools.some((tool) => tool.name === candidate));
          if (!name) throw new Error("host advertised no supported shell tool");
          const args = name === "exec_command" ? { cmd: next.shell } : name === "shell" ? { command: process.platform === "win32" ? ["powershell.exe", "-NoProfile", "-Command", next.shell] : ["sh", "-c", next.shell] } : { command: next.shell };
          item = { type: "function_call", id: "fc_" + requestCount, call_id: "call_" + requestCount, name, arguments: JSON.stringify(args) };
        } else if (next) {
          const tool = tools.find((entry) => entry.name === "apply_patch");
          if (!tool) throw new Error("host advertised no apply_patch tool");
          item = tool.type === "custom"
            ? { type: "custom_tool_call", id: "ct_" + requestCount, call_id: "call_" + requestCount, name: "apply_patch", input: next.patch }
            : { type: "function_call", id: "fc_" + requestCount, call_id: "call_" + requestCount, name: "apply_patch", arguments: JSON.stringify({ input: next.patch }) };
        } else item = { type: "message", id: "msg_final", role: "assistant", content: [{ type: "output_text", text: "Jig host probe complete." }] };
        const id = "resp_" + requestCount;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const event of [
          { type: "response.created", response: { id } },
          { type: "response.output_item.added", output_index: 0, item },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
        ]) res.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
        res.end();
      } catch (error) { serverError = error.message; res.writeHead(500); res.end(error.message); }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  let execution;
  try {
    execution = await run(cli, ["exec", "--skip-git-repo-check", "--json", "-C", project, "-s", options.hostOnly === true ? "danger-full-access" : "workspace-write",
      // Installed mode must exercise the owner's persisted review decision.
      // Bypass is only for the freshly copied isolated fixture package.
      ...(installed ? [] : ["--dangerously-bypass-hook-trust"]), "-c", "approval_policy=\"never\"",
      "-c", "model_provider=\"jig-probe\"",
      // Installed mode needs the owner's current model metadata/tool set. The
      // local provider supplies fixed responses regardless of the model slug.
      ...(modelOverride ? ["-c", "model=" + JSON.stringify(modelOverride)] : []),
      "-c", "model_providers.jig-probe.name=\"Jig deterministic probe\"",
      "-c", "model_providers.jig-probe.base_url=\"http://127.0.0.1:" + port + "/v1\"",
      "-c", "model_providers.jig-probe.wire_api=\"responses\"",
      "-c", "model_providers.jig-probe.requires_openai_auth=false",
      "-c", "windows.sandbox=\"unelevated\"", "-c", "features.enable_request_compression=false", "-c", "features.unified_exec=true",
      "-c", "features.apps=false", "-c", "features.remote_plugin=false",
      "-c", "projects." + JSON.stringify(project) + ".trust_level=\"trusted\"",
      "Exercise the supplied Jig fixture calls in this temporary repository, then finish."], launch);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  const ledgerPath = path.join(project, ".jig", "ledger.jsonl");
  const rows = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
  const checks = evaluateHostChecks({ execution, requestCount, expectedRequests: calls.length + 1, serverError, project, rows });
  fs.writeFileSync(path.join(root, "host-output.json"), JSON.stringify({ execution, captured, httpRequests }, null, 2));
  const result = { schemaVersion: 1, checkedAt: new Date().toISOString(), cliVersion: version.stdout.trim(), platform: process.platform, arch: process.arch,
    green: Object.values(checks).every(Boolean), checks, serverError, evidence: root, sandbox: options.hostOnly === true ? "none (fixed local tool fixtures only)" : "workspace-write",
    pluginMode: installed ? "installed" : "isolated", codexHome: home, hookTrustBypassed: !installed, modelOverride,
    configurationOverrides: ["local deterministic Responses provider", "fixed-fixture sandbox mode", "approval_policy=never", "request compression disabled", "unified exec enabled", "apps disabled", "remote plugin catalog disabled", "temporary project trusted for this invocation", ...(modelOverride ? ["model=" + modelOverride + " (standard Responses fixture transport)"] : [])],
    method: installed
      ? "Real Codex CLI using the current Codex home, installed plugins, and persisted hook trust without trust bypass or plugin installation; local deterministic Responses server and disposable fixture project, no model inference. Desktop UI delivery is not measured."
      : "Real Codex CLI with an isolated home, vetted temporary plugin hooks, and a local deterministic Responses server; no model inference. Desktop UI and other OSes are not measured by this run." };
  fs.writeFileSync(path.join(root, "results.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  let invalid = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--host-only") options.hostOnly = true;
    else if (args[i] === "--installed") options.installed = true;
    else if (args[i] === "--model" && args[i + 1]) options.model = args[++i];
    else if (args[i] === "--codex" && args[i + 1]) options.codex = args[++i];
    else invalid = true;
  }
  if (invalid) {
    process.stderr.write("usage: node scripts/probes/codex-host.js [--codex <executable>] [--host-only] [--installed] [--model <slug>]\n"); process.exitCode = 1;
  } else hostProbe(options).then((result) => {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n"); process.exitCode = result.green ? 0 : 1;
  }).catch((error) => { process.stderr.write("jig: " + error.message + "\n"); process.exitCode = 1; });
}
module.exports = { hostProbe, prepareProject, evaluateHostChecks, runCli: run };
