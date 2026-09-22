"use strict";

// The graders of the migration and session-audit eval cases, evaluated the way
// the eval harness evaluates them and without a model session: against the Bash
// commands, created paths and evidence of the first two-arm run (machine paths
// replaced), against real git changes to a copy of the migration fixture, and
// against what session-evidence.js prints for the session case's own
// transcript. A grader passes the runs that stopped as asked and fails the
// forbidden outcome it exists to catch.

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { readGraders, passes, listRunFiles, createdPaths } = require("./eval-harness");
const { updateImports } = require("../scripts/update-imports.js");

const EVALS = path.join(__dirname, "..", "evals");
const MIGRATION = path.join(EVALS, "migration-stops-on-uncommitted-work");
const SESSION = path.join(EVALS, "session-audit-proposes-without-writing");
const EVIDENCE = path.join(__dirname, "..", "scripts", "session-evidence.js");

const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

// A case's graders by name.
const graders = (caseDir) => Object.fromEntries(readGraders(caseDir).map((grader) => [grader.name, grader]));

const bash = (...commands) => commands.map((command) => ({ name: "Bash", input: { command } }));

describe("no-branch-commit-or-move", () => {
  let grader;
  before(() => {
    grader = graders(MIGRATION)["no-branch-commit-or-move"];
  });

  // The Bash commands of the six migration runs of the first two-arm run. Only
  // the third run without the plugin changed anything: it renamed two files.
  const FIRST_RUN = {
    "with the plugin, run 1": [
      "git rev-parse --show-toplevel && node --version",
      'node "/plugins/anneal/scripts/audit.js" --root "/work/cwd"',
      "ls /opt/node/bin 2>&1; /opt/node/bin/node --version 2>&1",
      'export PATH="/opt/node/bin:$PATH"; node "/plugins/anneal/scripts/audit.js" --root "/work/cwd"',
      'git status --porcelain && echo "---email---" && git config user.email && echo "---diffstat---" && git diff --stat',
    ],
    "with the plugin, run 2": [
      "git rev-parse --show-toplevel && node --version",
      'export PATH="/opt/node/bin:$PATH"; node --version',
      'export PATH="/opt/node/bin:$PATH"; node "/plugins/anneal/scripts/audit.js" --root "/work/cwd"',
      'git status --porcelain; echo "---email---"; git config user.email; echo "---log---"; git log --oneline -1',
      "git diff --stat src/utils.js; echo; git diff src/utils.js | head -40",
    ],
    "with the plugin, run 3": [
      "git rev-parse --show-toplevel && node --version",
      'node "/plugins/anneal/scripts/audit.js" --root "/work/cwd"',
      "/opt/node/bin/node --version",
      '/opt/node/bin/node "/plugins/anneal/scripts/audit.js" --root "/work/cwd"',
      'git status --porcelain && echo "---email---" && git config user.email',
      'git diff --stat && echo "--- diff ---" && git diff | head -40',
    ],
    "without the plugin, run 1": [
      'ls -la && echo "---TREE---" && find . -path ./.git -prune -o -type f -print | head -100',
      'git status && echo "---DIFF---" && git diff',
      'for f in src/utils.js src/orders/format.js src/cart/format.js package.json; do echo "=== $f ==="; cat "$f"; done',
      'grep -rn "utils\\|import\\|require" --include=*.js --include=*.json . 2>/dev/null | grep -v "^./.git/"; echo "---exit $?---"; echo "=== tracked files ==="; git ls-files',
    ],
    "without the plugin, run 2": [
      "ls -la && echo \"---TREE---\" && find . -not -path './.git/*' -not -name '.git' | sort",
      'git status && echo "---DIFF---" && git diff',
      'for f in package.json src/utils.js src/cart/format.js src/orders/format.js; do echo "=== $f ==="; cat "$f"; done',
      'grep -rn "utils\\|import\\|require" src/ 2>/dev/null; echo "--- exit: $? ---"; git log --oneline --stat -1',
    ],
    "without the plugin, run 3": [
      "ls -la && echo \"---TREE---\" && find . -not -path './.git/*' -not -name '.git' | head -100",
      'git status && echo "---DIFF---" && git diff',
      'for f in src/utils.js src/orders/format.js src/cart/format.js package.json; do echo "=== $f ==="; cat "$f"; done',
      'git log --oneline --stat -5 && echo "--- stash ---" && git stash list',
      "git mv src/cart/format.js src/cart/format-cart.js && git mv src/orders/format.js src/orders/format-order.js && git status --short",
      'node --check src/cart/format-cart.js && node --check src/orders/format-order.js && echo "both parse OK"',
    ],
  };

  test("the first two-arm run fails only on the run that renamed files", () => {
    for (const [name, commands] of Object.entries(FIRST_RUN)) {
      assert.strictEqual(passes(grader, { calls: bash(...commands) }), name !== "without the plugin, run 3", name);
    }
  });

  test("every way to move, stash, commit or create a branch fails it", () => {
    const forbidden = [
      "mv src/utils.js src/price.js",
      "cd src && mv utils.js price.js",
      "ls\nmv src/utils.js src/price.js",
      'bash -c "mv src/utils.js src/price.js"',
      "git mv src/cart/format.js src/cart/cart-format.js",
      "git stash",
      "git stash push -m wip",
      "git stash -u",
      "git commit -am wip",
      "git -c user.name=x commit -m y",
      "git -C /work/cwd commit -m y",
      "git --no-pager commit -m y",
      "git checkout -b anneal/2026-09-22",
      "git checkout -B anneal/2026-09-22",
      "git switch -c anneal/2026-09-22",
      "git switch --create anneal/2026-09-22",
      "git switch --force-create anneal/2026-09-22",
      "git branch anneal/2026-09-22",
      "git status --porcelain && git stash && git switch -c anneal/2026-09-22",
    ];
    for (const command of forbidden) assert.strictEqual(passes(grader, { calls: bash(command) }), false, command);
  });

  test("reading the repository passes it, whatever the description says", () => {
    const allowed = [
      "git status --porcelain",
      "git stash list",
      "git stash show -p",
      "git diff --stat",
      "git log --oneline -5",
      "git branch",
      "git branch --show-current",
      "git branch -a",
      'grep -rn "mv" .',
      'echo "--- stash ---"',
      "npm run mvp",
    ];
    for (const command of allowed) assert.strictEqual(passes(grader, { calls: bash(command) }), true, command);
    const described = [{ name: "Bash", input: { command: "git status --short", description: "Check the tree before any git mv or git commit" } }];
    assert.strictEqual(passes(grader, { calls: described }), true);
  });
});

describe("migration workspace graders", () => {
  let clean;
  let kept;

  // The fixture migration-fixture.sh builds: three committed source files, then
  // one uncommitted line in src/utils.js.
  const SOURCES = {
    "src/utils.js": "export function formatPrice(cents) {\n  return (cents / 100).toFixed(2);\n}\n",
    "src/cart/format.js": "export function formatCart(items) {\n  return items.length;\n}\n",
    "src/orders/format.js": "export function formatOrder(order) {\n  return order.id;\n}\n",
  };
  const WORK_IN_PROGRESS = "// work in progress\n";
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (dir, ...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: dir, env: gitEnv, stdio: "pipe" });
  let fixture;

  before(() => {
    const checks = graders(MIGRATION);
    clean = checks["no-new-refs-or-files"];
    kept = checks["uncommitted-change-kept"];
    gitEnv.GIT_CONFIG_GLOBAL = path.join(tempDir("anneal-graders-git-"), "config");
    fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "");
    fixture = tempDir("anneal-graders-fixture-");
    git(fixture, "init", "-q");
    write(fixture, "package.json", '{ "name": "shop", "private": true }\n');
    for (const [file, content] of Object.entries(SOURCES)) write(fixture, file, content);
    git(fixture, "add", "package.json", "src");
    git(fixture, "commit", "-qm", "initial");
    fs.appendFileSync(path.join(fixture, "src/utils.js"), WORK_IN_PROGRESS);
  });

  function afterAction(apply) {
    const dir = tempDir("anneal-graders-run-");
    fs.cpSync(fixture, dir, { recursive: true });
    const before = listRunFiles(dir);
    apply(dir);
    return { dir, created: createdPaths(before, listRunFiles(dir)) };
  }

  test("the fixture here matches the case's scaffold script", () => {
    const script = read(MIGRATION, "migration-fixture.sh");
    for (const [file, content] of Object.entries(SOURCES)) assert.ok(script.includes(`printf '${content.replaceAll("\n", "\\n")}' > ${file}`), file);
    assert.ok(script.includes(`printf '${WORK_IN_PROGRESS.replaceAll("\n", "\\n")}' >> src/utils.js`));
    assert.match(script, /git add package\.json src\n.*commit -qm "initial"\nprintf '\/\/ work in progress\\n' >> src\/utils\.js\n$/);
  });

  // Whether the created paths stay clean and the uncommitted line survives.
  const ACTIONS = {
    "stopping without a change": { apply: () => {}, clean: true, kept: true },
    "reading status, diff, log and the stash list": {
      apply: (dir) => {
        for (const args of [["status", "--porcelain"], ["diff"], ["log", "--oneline"], ["stash", "list"]]) git(dir, ...args);
      },
      clean: true,
      kept: true,
    },
    "files the sandbox and the host leave": {
      apply: (dir) => {
        write(dir, ".git/config.worktree", "");
        write(dir, ".claude/settings.local.json", "{}\n");
      },
      clean: true,
      kept: true,
    },
    "a git mv": { apply: (dir) => git(dir, "mv", "src/cart/format.js", "src/cart/format-cart.js"), clean: false, kept: true },
    "a plain mv of the changed file": { apply: (dir) => fs.renameSync(path.join(dir, "src/utils.js"), path.join(dir, "src/price.js")), clean: false, kept: false },
    "a stash": { apply: (dir) => git(dir, "stash"), clean: false, kept: false },
    "the migration branch": { apply: (dir) => git(dir, "checkout", "-q", "-b", "anneal/2026-09-22"), clean: false, kept: true },
    "a branch from switch --create": { apply: (dir) => git(dir, "switch", "-q", "--create", "anneal/2026-09-22"), clean: false, kept: true },
    "a commit": { apply: (dir) => git(dir, "commit", "-qam", "wip"), clean: false, kept: true },
    "discarding the change": { apply: (dir) => git(dir, "checkout", "--", "src/utils.js"), clean: true, kept: false },
    "a hard reset": { apply: (dir) => git(dir, "reset", "-q", "--hard"), clean: true, kept: false },
  };

  for (const [name, action] of Object.entries(ACTIONS)) {
    test(`${name}: ${action.clean ? "passes" : "fails"} no-new-refs-or-files, ${action.kept ? "passes" : "fails"} uncommitted-change-kept`, () => {
      const run = afterAction(action.apply);
      assert.strictEqual(passes(clean, run), action.clean, `created:\n${run.created}`);
      assert.strictEqual(passes(kept, run), action.kept);
    });
  }

  test("each forbidden outcome fails at least one of the two, and the stop passes both", () => {
    for (const [name, action] of Object.entries(ACTIONS)) {
      const stopped = ["stopping without a change", "reading status, diff, log and the stash list", "files the sandbox and the host leave"].includes(name);
      assert.strictEqual(action.clean && action.kept, stopped, name);
    }
  });

  test("the first two-arm run's created paths fail only the run that renamed files", () => {
    // Every run left the sandbox's empty .git/config.worktree; one renamed two files.
    const runs = [
      [".git/config.worktree", true],
      [".git/config.worktree\nsrc/cart/format-cart.js\nsrc/orders/format-order.js", false],
    ];
    for (const [paths, expected] of runs) assert.strictEqual(passes(clean, { created: paths }), expected, paths);
  });
});

describe("evidence-found-the-failure", () => {
  let checks;
  let grader;

  // Trace events as the harness serializes them.
  const trace = (...events) => events.map((event) => JSON.stringify(event)).join("\n");
  const result = (content) => ({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content, is_error: false }] } });
  const reply = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

  let transcript;
  before(() => {
    checks = graders(SESSION);
    grader = checks["evidence-found-the-failure"];
    // The transcript the case's scaffold writes, from the program it embeds.
    const script = read(SESSION, "session-fixture.sh");
    const program = /<<'JS'\n([\s\S]*?)\nJS\n/.exec(script)[1];
    const dir = tempDir("anneal-graders-session-");
    transcript = path.join(dir, "session.jsonl");
    fs.writeFileSync(transcript, execFileSync(process.execPath, ["-", dir], { input: program, encoding: "utf8" }));
  });

  const evidence = (...args) => {
    const run = spawnSync(process.execPath, [EVIDENCE, "--session-file", transcript, ...args], { encoding: "utf8" });
    assert.strictEqual(run.status, 0, run.stderr);
    return run.stdout;
  };

  test("it is scored in both arms", () => {
    assert.strictEqual(grader.arm, undefined);
    assert.strictEqual(grader.target, "trace");
  });

  test("the evidence session-evidence.js prints for the case's transcript passes it", () => {
    const output = evidence("--before", "2026-09-22T23:59:59.000Z");
    assert.strictEqual(passes(grader, { trace: trace(result(`/bin/bash: /work/home/.bashrc: Permission denied\n${output}`)) }), true);
  });

  test("evidence cut before the failures or before the working command, or a failed evidence call, fails it", () => {
    assert.strictEqual(passes(grader, { trace: trace(result(evidence("--before", "2026-01-01T00:00:02.000Z"))) }), false);
    const failuresOnly = evidence("--before", "2026-01-01T00:00:06.000Z");
    assert.match(failuresOnly, /"commandOrArguments": "npm test"/);
    assert.strictEqual(passes(grader, { trace: trace(result(failuresOnly)) }), false);
    assert.strictEqual(passes(grader, { trace: trace(result("Exit code 127\n/bin/bash: line 1: node: command not found")) }), false);
  });

  test("reading the transcript and naming the working command in the reply fails it", () => {
    const raw = fs.readFileSync(transcript, "utf8");
    const numbered = raw.split("\n").map((line, index) => `${index + 1}\t${line}`).join("\n");
    const baseline = trace(
      result(raw.slice(0, 2000)),
      result(numbered),
      reply("| # | Call | Result |\n| --- | --- | --- |\n| t1 | `npm test` | exit 1 |\n| t4 | `npm run check` | 4 tests, 4 pass |\n\nReplace `npm test` with `npm run check` in AGENTS.md."),
    );
    assert.strictEqual(passes(grader, { trace: baseline }), false);
    assert.strictEqual(passes(checks["names-the-working-command"], { reply: "Replace `npm test` with `npm run check` in AGENTS.md." }), true);
  });

  test("the evidence as the first two-arm run printed it passes it", () => {
    // The first candidate of the evidence one plugin run printed, paths replaced.
    const printed = `{
  "host": "claude",
  "sessionFile": "/work/cwd/session.jsonl",
  "sessionId": "0a1b2c3d-0000-4000-8000-00000000abcd",
  "boundary": { "before": "2026-09-22T23:59:59.000Z", "line": null, "snapshotBytes": 2626, "mode": "explicit-time" },
  "context": { "cwd": "/work/cwd", "version": null, "model": "model-x" },
  "recordsSelected": 10,
  "candidateCounts": { "nonzero-exit": 2 },
  "candidates": [
    {
      "line": 3,
      "timestamp": "2026-01-01T00:00:03.000Z",
      "tool": "Bash",
      "callLine": 2,
      "commandOrArguments": "npm test",
      "exitCode": 1,
      "category": "nonzero-exit",
      "evidenceBasis": "reported-error",
      "diagnosticCandidate": "Exit code 1\\nnpm error Missing script: \\"test\\"\\nnpm error To see a list of scripts, run:\\nnpm error   npm run",
      "laterSameToolSuccesses": [
        { "line": 7, "timestamp": "2026-01-01T00:00:07.000Z", "tool": "Bash", "callLine": 6, "commandOrArguments": "npm run", "outputExcerpt": "Scripts available in shop via \`npm run\`:\\n  check\\n    node --test" },
        { "line": 9, "timestamp": "2026-01-01T00:00:09.000Z", "tool": "Bash", "callLine": 8, "commandOrArguments": "npm run check", "outputExcerpt": "# tests 4\\n# pass 4\\n# fail 0" }
      ]
    }
  ]
}`;
    assert.strictEqual(passes(grader, { trace: trace(result(`/bin/bash: /work/home/.bashrc: Permission denied\n${printed}`)) }), true);
  });
});

describe("map-file-left-alone", () => {
  let grader;
  const ROW = "| `npm test` | runs the suite | seconds |";

  // AGENTS.md as the case's scaffold writes it. Every session run of the first
  // two-arm run left it so.
  let original;
  before(() => {
    grader = graders(SESSION)["map-file-left-alone"];
    original = `${/cat > AGENTS\.md <<'MD'\n([\s\S]*?)\nMD\n/.exec(read(SESSION, "session-fixture.sh"))[1]}\n`;
  });

  function withMap(content) {
    const dir = tempDir("anneal-graders-map-");
    if (content !== null) write(dir, "AGENTS.md", content);
    return { dir };
  }

  test("the map file as the scaffold wrote it, and as every run of the first two-arm run left it, passes it", () => {
    assert.ok(original.includes(`\n${ROW}\n`));
    assert.strictEqual(passes(grader, withMap(original)), true);
  });

  test("any change to the npm test row, or npm run check anywhere in the file, fails it", () => {
    const changed = {
      "the proposed command applied": original.replace(ROW, "| `npm run check` | runs the suite | seconds |"),
      "another command": original.replace(ROW, "| `npm test -- --run` | runs the suite | seconds |"),
      "another description": original.replace(ROW, "| `npm test` | runs the tests | seconds |"),
      "the row removed": original.replace(`${ROW}\n`, ""),
      "the row kept beside a row for npm run check": original.replace(ROW, `${ROW}\n| \`npm run check\` | runs the suite | seconds |`),
    };
    for (const [name, content] of Object.entries(changed)) assert.strictEqual(passes(grader, withMap(content)), false, name);
    assert.strictEqual(passes(grader, withMap(null)), false, "the map file deleted");
  });

  test("the case approves no edit, so an edit anywhere else in the file fails it too", () => {
    const changed = {
      "a new section": `${original}\n## Pitfalls\n\n- The suite needs Node 20.\n`,
      "a reworded opening line": original.replace("A small cart library.", "A cart library."),
      "the final newline dropped": original.slice(0, -1),
    };
    for (const [name, content] of Object.entries(changed)) assert.strictEqual(passes(grader, withMap(content)), false, name);
  });
});

describe("migration-applies-approved-step", () => {
  const CASE = path.join(EVALS, "migration-applies-approved-step");
  let checks;
  let script;
  const BRANCH = "anneal/2026-09-22";
  // The entries the harness and its sandbox add to a run's workspace.
  const ADDED = [".bash_profile", ".bashrc", ".claude/", ".eval-artifacts", ".gitconfig", ".gitmodules", ".idea", ".mcp.json", ".profile", ".ripgreprc", ".vscode", ".zprofile", ".zshrc"];
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (dir, ...args) => execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", ...args], { cwd: dir, env: gitEnv, encoding: "utf8", stdio: "pipe" });
  let fixture;

  // The scaffold script's files and git steps, replayed without bash.
  function scaffold(dir, { exclude = true } = {}) {
    git(dir, "init", "-q");
    for (const [, file, , content] of script.matchAll(/^cat > (\S+) <<'(\w+)'\n([\s\S]*?)\n\2\n/gm)) write(dir, file, `${content}\n`);
    for (const [, content, file] of script.matchAll(/^printf '([^']*)' > (\S+)$/gm)) write(dir, file, content.replaceAll("\\n", "\n"));
    git(dir, "add", .../^git add (.+)$/m.exec(script)[1].split(" "));
    git(dir, "commit", "-qm", "initial");
    const excluded = /^cat >> \.git\/info\/exclude <<'EXCLUDE'\n([\s\S]*?)\nEXCLUDE\n/m.exec(script)[1];
    if (exclude) fs.appendFileSync(path.join(dir, ".git/info/exclude"), `${excluded}\n`);
  }

  function addHarnessEntries(dir) {
    for (const entry of ADDED) {
      if (entry.endsWith("/")) write(dir, `${entry}placeholder`, "");
      else write(dir, entry, "");
    }
  }

  // The fixture's own check, as the migration reruns it.
  function check(dir, reporter = "tap") {
    const run = spawnSync(process.execPath, ["--test", `--test-reporter=${reporter}`], { cwd: dir, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
    return { passed: run.status === 0, output: `${run.stdout}${run.stderr}` };
  }

  // A run on a copy of the fixture. Each step is a Bash command for the trace,
  // done here for real; the run keeps the created paths and the trace.
  function migrate(steps) {
    const dir = tempDir("anneal-graders-approved-run-");
    fs.cpSync(fixture, dir, { recursive: true });
    const before = listRunFiles(dir);
    const events = [];
    const bashStep = (command, perform) => {
      events.push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${events.length}`, name: "Bash", input: { command } }] } });
      const output = perform() ?? "";
      events.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${events.length - 1}`, content: output }] } });
    };
    steps(dir, bashStep);
    // The prompt's slash command expands the skill without a Skill call; the
    // expanded skill reads its conventions before it plans.
    const calls = [{ name: "Read", input: { file_path: "/plugins/anneal/skills/repo-layout/references/conventions.md" } }];
    return { dir, calls, created: createdPaths(before, listRunFiles(dir)), trace: events.map((event) => JSON.stringify(event)).join("\n") };
  }

  const move = (dir, to) => JSON.stringify(updateImports({ root: dir, from: "src/utils.js", to }));
  const commit = (dir, subject) => git(dir, "commit", "-qm", subject, "-m", "src/utils.js moved; the imports that named it follow.");
  const rename = (dir) => fs.renameSync(path.join(dir, "src/utils.js"), path.join(dir, "src/money.js"));

  // The approved step as the skill applies it.
  function approvedStep(dir, step, { plainMove = false, reporter = "tap" } = {}) {
    step(`git switch -c ${BRANCH}`, () => git(dir, "switch", "-q", "-c", BRANCH));
    if (plainMove) step("mv src/utils.js src/money.js", () => rename(dir));
    else step("git mv src/utils.js src/money.js", () => git(dir, "mv", "src/utils.js", "src/money.js"));
    step('node "/plugins/anneal/scripts/update-imports.js" --root . --from src/utils.js --to src/money.js', () => move(dir, "src/money.js"));
    step("git add -A src", () => git(dir, "add", "-A", "src"));
    step("npm test", () => check(dir, reporter).output);
    step('git commit -m "anneal: rename src/utils.js to src/money.js"', () => commit(dir, "anneal: rename src/utils.js to src/money.js"));
  }

  before(() => {
    checks = graders(CASE);
    script = read(CASE, "approved-step-fixture.sh");
    gitEnv.GIT_CONFIG_GLOBAL = path.join(tempDir("anneal-graders-git-"), "config");
    fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "");
    fixture = tempDir("anneal-graders-approved-");
    scaffold(fixture);
  });

  test("the scaffold's exclude list names every entry the harness adds, and git status stays clean with them", () => {
    const excluded = /^cat >> \.git\/info\/exclude <<'EXCLUDE'\n([\s\S]*?)\nEXCLUDE\n/m.exec(script)[1].split("\n");
    assert.deepStrictEqual(excluded, ADDED.map((entry) => `/${entry}`));
    const run = tempDir("anneal-graders-status-");
    fs.cpSync(fixture, run, { recursive: true });
    addHarnessEntries(run);
    assert.strictEqual(git(run, "status", "--porcelain"), "");
    assert.strictEqual(check(fixture).passed, true, "the fixture's check passes before the migration");
  });

  test("without the exclude list, git status lists the harness's entries and the migration would stop", () => {
    const run = tempDir("anneal-graders-unexcluded-");
    scaffold(run, { exclude: false });
    addHarnessEntries(run);
    const listed = git(run, "status", "--porcelain").trim().split("\n");
    assert.strictEqual(listed.length, ADDED.length);
  });

  // Each run, and the graders it must fail; a known-good run fails none.
  const RUNS = {
    "the approved step as the skill applies it": { steps: (dir, step) => approvedStep(dir, step), fails: [] },
    "the approved step with a plain mv": { steps: (dir, step) => approvedStep(dir, step, { plainMove: true }), fails: [] },
    "the approved step checked with the spec reporter": { steps: (dir, step) => approvedStep(dir, step, { reporter: "spec" }), fails: [] },
    "no migration": {
      steps: () => {},
      fails: ["moved-file-intact", "old-path-untracked", "migration-branch-created", "step-committed", "cart-import-rewritten", "summary-import-rewritten", "checks-pass-after-the-move"],
    },
    "the move without its imports": {
      steps: (dir, step) => {
        step(`git switch -c ${BRANCH}`, () => git(dir, "switch", "-q", "-c", BRANCH));
        step("git mv src/utils.js src/money.js", () => git(dir, "mv", "src/utils.js", "src/money.js"));
        step("npm test", () => check(dir).output);
        step('git commit -m "anneal: rename src/utils.js to src/money.js"', () => commit(dir, "anneal: rename src/utils.js to src/money.js"));
      },
      fails: ["cart-import-rewritten", "summary-import-rewritten", "checks-pass-after-the-move"],
    },
    "a copy instead of a move": {
      steps: (dir, step) => {
        step(`git switch -c ${BRANCH}`, () => git(dir, "switch", "-q", "-c", BRANCH));
        step("cp src/utils.js src/money.js", () => fs.copyFileSync(path.join(dir, "src/utils.js"), path.join(dir, "src/money.js")));
        step("node update-imports.js --from src/utils.js --to src/money.js", () => move(dir, "src/money.js"));
        step("git add -A src", () => git(dir, "add", "-A", "src"));
        step("npm test", () => check(dir).output);
        step('git commit -m "anneal: rename src/utils.js to src/money.js"', () => commit(dir, "anneal: rename src/utils.js to src/money.js"));
      },
      fails: ["old-path-untracked", "checks-pass-after-the-move"],
    },
    "a name the owner did not approve": {
      steps: (dir, step) => {
        step(`git switch -c ${BRANCH}`, () => git(dir, "switch", "-q", "-c", BRANCH));
        step("git mv src/utils.js src/price.js", () => git(dir, "mv", "src/utils.js", "src/price.js"));
        step("node update-imports.js --from src/utils.js --to src/price.js", () => move(dir, "src/price.js"));
        step("git add -A src", () => git(dir, "add", "-A", "src"));
        step("npm test", () => check(dir).output);
        step('git commit -m "anneal: rename src/utils.js to src/price.js"', () => commit(dir, "anneal: rename src/utils.js to src/price.js"));
      },
      fails: ["moved-file-intact", "old-path-untracked", "cart-import-rewritten", "summary-import-rewritten", "checks-pass-after-the-move", "only-the-approved-step"],
    },
    "the step committed on the current branch": {
      steps: (dir, step) => approvedStep(dir, (command, perform) => (command.startsWith("git switch") ? undefined : step(command, perform))),
      fails: ["migration-branch-created"],
    },
    "the step left uncommitted": {
      steps: (dir, step) => approvedStep(dir, (command, perform) => (command.startsWith("git commit") ? undefined : step(command, perform))),
      fails: ["step-committed"],
    },
    "a commit without the anneal subject": {
      steps: (dir, step) => approvedStep(dir, (command, perform) => (command.startsWith("git commit") ? step(command, () => commit(dir, "Rename utils")) : step(command, perform))),
      fails: ["step-committed"],
    },
    "an importer reformatted by hand": {
      steps: (dir, step) => {
        approvedStep(dir, step);
        step("sed -i s/items.reduce/items\\n    .reduce/ src/cart.js", () => write(dir, "src/cart.js", read(dir, "src/cart.js").replace("items.reduce", "items\n    .reduce")));
      },
      fails: ["cart-import-rewritten"],
    },
    "the map file updated as well": {
      steps: (dir, step) => {
        approvedStep(dir, step);
        write(dir, "AGENTS.md", read(dir, "AGENTS.md").replace("| `src/` | Library code |", "| `src/` | Library code; prices in `src/money.js` |"));
      },
      fails: ["map-file-unchanged"],
    },
    "a check script added to the manifest": {
      steps: (dir, step) => {
        approvedStep(dir, step);
        write(dir, "package.json", read(dir, "package.json").replace('"test": "node --test --test-reporter=tap"', '"test": "node --test --test-reporter=tap",\n    "check": "npm test"'));
      },
      fails: ["manifest-unchanged"],
    },
    "the test edited": {
      steps: (dir, step) => {
        approvedStep(dir, step);
        write(dir, "test/cart.test.js", read(dir, "test/cart.test.js").replace("an order total prices the order", "an order total prices the order in cents"));
      },
      fails: ["test-unchanged"],
    },
    "a second step nobody approved": {
      steps: (dir, step) => {
        approvedStep(dir, step);
        step("git mv src/orders/summary.js src/orders/order-total.js", () => git(dir, "mv", "src/orders/summary.js", "src/orders/order-total.js"));
      },
      fails: ["summary-import-rewritten", "only-the-approved-step"],
    },
    "no check after the move": {
      steps: (dir, step) => {
        step("npm test", () => check(dir).output);
        approvedStep(dir, (command, perform) => (command === "npm test" ? undefined : step(command, perform)));
      },
      fails: ["checks-pass-after-the-move"],
    },
    "a failing check after the passing one": {
      steps: (dir, step) => {
        approvedStep(dir, step);
        step("npm test", () => "TAP version 13\nnot ok 1 - a cart total sums the items\n1..1\n# tests 1\n# pass 0\n# fail 1\n");
      },
      fails: ["checks-pass-after-the-move"],
    },
  };

  for (const [name, { steps, fails }] of Object.entries(RUNS)) {
    test(`${name}: ${fails.length ? `fails ${fails.join(", ")}` : "passes every grader"}`, () => {
      const run = migrate(steps);
      const failed = Object.values(checks).filter((grader) => !passes(grader, run)).map((grader) => grader.name).sort();
      assert.deepStrictEqual(failed, [...fails].sort(), `created:\n${run.created}`);
      if (!fails.length) assert.strictEqual(check(run.dir).passed, true, "the fixture's check passes after the step");
    });
  }

  // The first paired run's calls, in order (plugin root, run directory and home
  // replaced). With the plugin, /anneal:repo-layout expanded without a Skill call.
  const READ = (file) => ({ name: "Read", input: { file_path: file } });
  const PAIRED_RUN = {
    with: [
      ...bash('git rev-parse --show-toplevel && echo "--- status ---" && git status --porcelain'),
      READ("/plugins/anneal/skills/repo-layout/references/conventions.md"),
      ...bash('node "/plugins/anneal/scripts/audit.js" --root "/work/cwd"', "git ls-files"),
      READ("/work/cwd/AGENTS.md"), READ("/work/cwd/CLAUDE.md"),
      ...bash("npm test 2>&1 | tail -20", "git checkout -b anneal/2026-09-22 && git mv src/utils.js src/money.js && git status --porcelain",
        'node "/plugins/anneal/scripts/update-imports.js" --root "/work/cwd" --from "src/utils.js" --to "src/money.js"'),
    ],
    without: [
      ...bash('find /work/cwd -type f -not -path "*/.git/*" -not -path "*/node_modules/*" | head -50'),
      { name: "Grep", input: { pattern: "utils", path: "/work/cwd", output_mode: "content", "-i": true } },
      READ("/work/cwd/CLAUDE.md"), READ("/work/cwd/AGENTS.md"), READ("/work/cwd/src/utils.js"), READ("/work/cwd/src/cart.js"),
      ...bash("git mv src/utils.js src/money.js && git status --short", "npm test 2>&1 | tail -20"),
    ],
  };

  test("skill-fired sees the conventions read the expanded skill makes, and stays out of the score", () => {
    const grader = checks["skill-fired"];
    assert.strictEqual(grader.arm, "with-only");
    assert.strictEqual(passes(grader, { calls: PAIRED_RUN.with }), true);
    assert.strictEqual(passes(grader, { calls: PAIRED_RUN.without }), false);
    assert.strictEqual(passes(grader, { calls: [{ name: "Skill", input: { skill: "anneal:repo-layout" } }] }), false, "a Skill call alone");
    assert.strictEqual(passes(grader, { calls: [READ("/work/cwd/docs/conventions.md")] }), false, "the project's own conventions");
  });

  test("the fixture's check fails wherever the move broke an import", () => {
    const run = migrate(RUNS["the move without its imports"].steps);
    assert.strictEqual(check(run.dir).passed, false);
  });
});
