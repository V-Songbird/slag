"use strict";

// The graders of the migration and session-audit eval cases, and the audit
// case's no-files-created, evaluated the way the eval harness evaluates them and
// without a model session: against the Bash commands, created paths and evidence
// of the first two-arm run (machine paths replaced), against real git changes to
// a copy of the migration fixture, and against what session-evidence.js prints
// for the session case's own transcript. A deterministic grader passes the runs
// that stopped as asked and fails the forbidden outcome it exists to catch. The
// session-failure cases' `type: llm` reply graders need a judge model, so they
// are only checked for form here.

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
require("./temp-root.js");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { readGraders, passes, listRunFiles, createdPaths } = require("./eval-harness");
const { updateImports } = require("../scripts/update-imports.js");

const EVALS = path.join(__dirname, "..", "evals");
const AUDIT = path.join(EVALS, "audit-reports-without-changes");
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

// The names of the graders that fail a run, sorted. A grader with no offline
// verdict (passes() returns null, as for an llm grader) is not a failure.
const failedGraders = (checks, run) => Object.values(checks).filter((grader) => passes(grader, run) === false).map((grader) => grader.name).sort();

test("an llm grader has no offline verdict and is not counted as failed", () => {
  const llm = { name: "judged", type: "llm", criteria: "PASS if the reply is right.\nFAIL if it is not." };
  assert.strictEqual(passes(llm, {}), null);
  assert.deepStrictEqual(failedGraders({ llm }, {}), []);
});

test("every skill-fired, audit-ran and evidence-ran grader runs only with the plugin", () => {
  const found = fs.readdirSync(EVALS, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .flatMap((entry) => readGraders(path.join(EVALS, entry.name)))
    .filter((grader) => ["skill-fired", "audit-ran", "evidence-ran"].includes(grader.name));
  assert.ok(found.length >= 15, `${found.length} graders found`);
  assert.deepStrictEqual(found.filter((grader) => grader.arm !== "with-only").map((grader) => grader.name), []);
});

const bash = (...commands) => commands.map((command) => ({ name: "Bash", input: { command } }));

// A recorded trace ends with the final reply twice: an assistant text event,
// then a result event whose result field holds the same text. A trace grader
// reads tool calls and their results, so this tail must not change its verdict.
const replyEvents = (text) => [
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } },
  { type: "result", subtype: "success", is_error: false, result: text },
].map((event) => JSON.stringify(event)).join("\n");
const withReply = (trace, text) => `${trace}\n${replyEvents(text)}`;

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
  // GIT_CONFIG_NOSYSTEM drops the system core.longpaths that Git for Windows
  // sets, so the helper restores it for fixtures under a long temporary path.
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (dir, ...args) => execFileSync("git", ["-c", "core.longpaths=true", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: dir, env: gitEnv, stdio: "pipe" });
  let fixture;

  before(() => {
    const checks = graders(MIGRATION);
    clean = checks["no-new-refs-or-files"];
    kept = checks["uncommitted-change-kept"];
    gitEnv.GIT_CONFIG_GLOBAL = path.join(tempDir("anneal-graders-git-"), "config");
    fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "[core]\n\tlongpaths = true\n");
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

  test("a reply that quotes the full evidence after a cut evidence call fails it", () => {
    const cut = trace(result(evidence("--before", "2026-01-01T00:00:06.000Z")));
    assert.strictEqual(passes(grader, { trace: withReply(cut, evidence("--before", "2026-09-22T23:59:59.000Z")) }), false);
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

describe("no-files-created in the audit and session cases", () => {
  // Each case's verdict on one run's created paths.
  const verdicts = (created) => Object.entries({ audit: AUDIT, session: SESSION }).map(([name, dir]) => [name, passes(graders(dir)["no-files-created"], { created })]);

  test("a run that writes nothing passes it, beside what the sandbox and the host leave", () => {
    // Every audit and session run of the first two-arm run created no file outside .git/.
    for (const created of ["", ".git/config.worktree", ".claude/settings.local.json", ".claude/settings.local.json\n.git/config.worktree"]) {
      for (const [name, passed] of verdicts(created)) assert.strictEqual(passed, true, `${name}: ${created}`);
    }
  });

  test("a findings, report or notes file saved without an explicit yes fails it, wherever it lands", () => {
    for (const created of ["docs/repo-layout-audit.md", "docs/session-review.md", "session-findings.md", ".git/config.worktree\nnotes/session-review-notes.md"]) {
      for (const [name, passed] of verdicts(created)) assert.strictEqual(passed, false, `${name}: ${created}`);
    }
  });
});

describe("audit-output-not-saved", () => {
  // no-files-created sees only the workspace, so a copy of the audit's output
  // saved beside it or in a temporary directory is caught from the command.
  let grader;
  before(() => {
    grader = graders(AUDIT)["audit-output-not-saved"];
  });
  const audit = 'node "/plugins/anneal/scripts/audit.js" --root "/work/cwd"';

  test("it is scored in both arms and allows no such call", () => {
    assert.deepStrictEqual([grader.type, grader.tool, grader.min, grader.max, grader.arm], ["tool_used", "Bash", "0", "0", undefined]);
  });

  test("the audit's output saved to any file or through tee fails it", () => {
    const saved = [
      `${audit} --json > ../cc5-audit.json`,
      `${audit} --json > /tmp/audit.json`,
      `${audit} --json >> audit.json`,
      `${audit} --json &> audit.json`,
      `${audit} --json 2>&1 | tee "$CLAUDE_SCRATCHPAD/audit.json" | head -40`,
      `{ ${audit} --json; echo "exit $?"; } > audit.json`,
      `git status --porcelain\n${audit} --json > audit.json`,
      `${audit} --json | Out-File audit.json`,
    ];
    for (const command of saved) assert.strictEqual(passes(grader, { calls: bash(command) }), false, command);
  });

  test("the audit printed, paged, discarded or piped into a script passes it, and so does another command's redirect", () => {
    const allowed = [
      audit,
      `${audit} --json`,
      `${audit} --json 2>&1 | head -100`,
      `${audit} --json 2>/dev/null`,
      `${audit} --json | node -e "require('fs').readFileSync(0, 'utf8').split('\\n').forEach((line) => console.log(line))"`,
      `git diff > /tmp/diff.txt; ${audit} --json`,
    ];
    for (const command of allowed) assert.strictEqual(passes(grader, { calls: bash(command) }), true, command);
    // The first two-arm run's audit calls, from the migration case above.
    for (const calls of [["git rev-parse --show-toplevel && node --version", audit], [`export PATH="/opt/node/bin:$PATH"; ${audit}`]]) {
      assert.strictEqual(passes(grader, { calls: bash(...calls) }), true);
    }
  });
});

describe("session-audit-stops-on-unreadable-transcript", () => {
  const CASE = path.join(EVALS, "session-audit-stops-on-unreadable-transcript");
  let checks;
  let transcript;

  // The scaffold without bash: the session case's transcript program, then the
  // cut the case's own script makes to the fourth record.
  before(() => {
    checks = graders(CASE);
    const program = /<<'JS'\n([\s\S]*?)\nJS\n/.exec(read(SESSION, "session-fixture.sh"))[1];
    const cut = /node -e '([^']*)'/.exec(read(CASE, "unreadable-fixture.sh"))[1];
    const dir = tempDir("anneal-graders-unreadable-");
    transcript = path.join(dir, "session.jsonl");
    fs.writeFileSync(transcript, execFileSync(process.execPath, ["-", dir], { input: program, encoding: "utf8" }));
    execFileSync(process.execPath, ["-e", cut], { cwd: dir });
  });

  test("the evidence script refuses the cut transcript, and the records around the cut stay readable", () => {
    const run = spawnSync(process.execPath, [EVIDENCE, "--session-file", transcript, "--before", "2026-09-22T23:59:59.000Z"], { encoding: "utf8" });
    assert.strictEqual(run.status, 1);
    assert.strictEqual(run.stdout, "");
    assert.match(run.stderr, /Invalid JSON record at line 4/);
    const lines = fs.readFileSync(transcript, "utf8").split("\n");
    assert.throws(() => JSON.parse(lines[3]));
    assert.match(lines[2], /Missing script: \\"test\\"/);
    assert.match(lines[7], /npm run check/);
  });

  test("a reply that reports the refusal and proposes nothing passes both reply graders", () => {
    const replies = [
      "session-evidence.js: cannot extract reliable session evidence: Invalid JSON record at line 4; no reliable audit produced. I stopped there and changed nothing.",
      "The evidence script couldn't parse session.jsonl: one record is malformed. Send a complete transcript and I will run the review again.",
    ];
    for (const reply of replies) {
      assert.strictEqual(passes(checks["names-the-unreadable-transcript"], { reply }), true, reply);
      assert.strictEqual(passes(checks["no-finding-from-the-raw-file"], { reply }), true, reply);
    }
  });

  test("a reply that reads the file itself and proposes the working command fails, and silence about the refusal fails too", () => {
    const handRead = "The evidence script refused the file at line 4, so I read the transcript directly: npm test failed twice and npm run check worked. Proposed change: replace npm test with npm run check in AGENTS.md.";
    assert.strictEqual(passes(checks["no-finding-from-the-raw-file"], { reply: handRead }), false);
    assert.strictEqual(passes(checks["names-the-unreadable-transcript"], { reply: "No findings; the session lost no time." }), false);
  });

  test("the plugin-only grader and the write graders are the session case's own", () => {
    assert.strictEqual(checks["evidence-ran"].arm, "with-only");
    for (const name of ["evidence-ran", "map-file-left-alone", "no-files-created"]) {
      assert.deepStrictEqual(checks[name], graders(SESSION)[name], name);
    }
  });
});

describe("case files the harness can parse", () => {
  // The harness reads case.yaml and a prompt's frontmatter as YAML, where an unquoted value
  // holding ": " is a parse error that drops the whole case before any run.
  test("no unquoted scalar value holds a colon followed by a space", () => {
    const offending = [];
    for (const name of fs.readdirSync(EVALS)) {
      const dir = path.join(EVALS, name);
      if (!fs.existsSync(path.join(dir, "case.yaml"))) continue;
      const head = /^---\s*\n([\s\S]*?)---/.exec(read(dir, "prompt.md"));
      const lines = [...read(dir, "case.yaml").split("\n"), ...(head ? head[1].split("\n") : [])];
      for (const line of lines) {
        const pair = /^\s*[a-z_]+: (.+)$/.exec(line);
        if (pair && !/^['"[{]/.test(pair[1]) && pair[1].includes(": ")) offending.push(`${name}: ${line.trim()}`);
      }
    }
    assert.deepStrictEqual(offending, []);
  });
});

describe("map-reader cases", () => {
  const FIXTURE = path.join(EVALS, "navigation-fixture.js");
  const workspaces = {};
  const checks = {};

  // Each scaffold without bash: the navigation fixture, then the removal its script commits.
  before(() => {
    for (const variant of ["original", "oriented"]) {
      const dir = path.join(EVALS, `map-reader-${variant}`);
      checks[variant] = graders(dir);
      const removed = /git rm -rq -- (.+)\n/.exec(read(dir, `${variant}-reader-fixture.sh`))[1].split(" ");
      const root = tempDir(`anneal-graders-reader-${variant}-`);
      const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, ".git-global") } });
      execFileSync(process.execPath, [FIXTURE, variant], { cwd: root, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, ".git-global") } });
      git("rm", "-rq", "--", ...removed);
      git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "notes only");
      workspaces[variant] = { root, tracked: git("ls-files").toString().trim().split("\n") };
    }
  });

  const verdicts = (variant, reply) => Object.fromEntries(Object.entries(checks[variant])
    .filter(([, grader]) => grader.target === undefined)
    .map(([name, grader]) => [name, passes(grader, { reply })]));
  const allPass = (variant, reply) => Object.values(verdicts(variant, reply)).every(Boolean);

  test("only the notes stay: the map files and the files the map names by path", () => {
    assert.deepStrictEqual(workspaces.original.tracked, [".nvmrc", "AGENTS.md", "CLAUDE.md"]);
    assert.deepStrictEqual(workspaces.oriented.tracked, [".nvmrc", "AGENTS.md", "CLAUDE.md", "docs/partner-api.md"]);
  });

  test("the oriented map answers all four questions, and the original map only two", () => {
    const oriented = read(workspaces.oriented.root, "AGENTS.md");
    const original = read(workspaces.original.root, "AGENTS.md");
    assert.match(oriented, /packages\/price-engine\//);
    assert.match(oriented, /## 8\. Endpoint reference.*docs\/partner-api\.md/);
    assert.match(read(workspaces.oriented.root, "docs/partner-api.md"), /^## 8\. Endpoint reference$/m);
    for (const map of [oriented, original]) {
      assert.match(map, /`node --test <file>`/);
      assert.match(map, /Node 22/);
    }
    assert.doesNotMatch(original, /price-engine|partner-api|Endpoint reference/);
  });

  test("the answers each map supports pass every reply grader, in either order or path style", () => {
    assert.strictEqual(allPass("oriented", "From AGENTS.md.\n\nA1: packages/price-engine/\nA2: node --test <file>\nA3: docs/partner-api.md, ## 8. Endpoint reference, that endpoint's entry\nA4: 22"), true);
    assert.strictEqual(allPass("oriented", "A1: `packages\\price-engine`\nA2: `node --test path/to/file.test.js`\nA3: section 8 (Endpoint reference) of docs/partner-api.md\nA4: Node 22"), true);
    assert.strictEqual(allPass("original", "A1: not in the notes\nA2: node --test <file>\nA3: not in the notes; they only say contracts live in docs/\nA4: v22"), true);
  });

  test("an answer the notes do not support, a wrong section or a missing line fails", () => {
    const guessed = verdicts("original", "A1: packages/price-engine\nA2: node --test <file>\nA3: docs/partner-api.md, section 8\nA4: 22");
    assert.deepStrictEqual([guessed["a1-not-in-the-notes"], guessed["a3-not-in-the-notes"]], [false, false]);
    assert.strictEqual(verdicts("oriented", "A1: packages/price-engine\nA2: node --test <file>\nA3: docs/partner-api.md, ## 7. Pagination\nA4: 22")["a3-endpoint-reference"], false);
    assert.strictEqual(verdicts("oriented", "A1: not in the notes\nA2: node --test <file>\nA3: docs/partner-api.md, ## 8. Endpoint reference\nA4: 22")["a1-price-engine"], false);
    assert.strictEqual(verdicts("oriented", "A1: packages/price-engine\nA2: npm test\nA3: docs/partner-api.md, ## 8\nA4: 20")["a2-single-test-command"], false);
    assert.strictEqual(verdicts("original", "A1: not in the notes\nA2: node --test <file>\nA4: 22")["four-answer-lines"], false);
  });
});

describe("migration-applies-approved-step", () => {
  const CASE = path.join(EVALS, "migration-applies-approved-step");
  let checks;
  let script;
  const BRANCH = "anneal/2026-09-22";
  // The skill's POSIX baseline form for the case's check: output, exit code and
  // line count, with no file.
  const POSIX_CHECKS = `{ npm test 2>&1; echo "exit $?"; } | awk '{ print } END { print "lines", NR - 1 }'`;
  // The entries the harness and its sandbox add to a run's workspace.
  const ADDED = [".bash_profile", ".bashrc", ".claude/", ".eval-artifacts", ".gitconfig", ".gitmodules", ".idea", ".mcp.json", ".profile", ".ripgreprc", ".vscode", ".zprofile", ".zshrc"];
  // core.longpaths as in the migration workspace graders' helper.
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (dir, ...args) => execFileSync("git", ["-c", "core.longpaths=true", "-c", "user.name=eval", "-c", "user.email=eval@example.invalid", ...args], { cwd: dir, env: gitEnv, encoding: "utf8", stdio: "pipe" });
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

  // A run on a copy of the fixture. Each step is a Bash call, or the call a
  // third argument `{ name, input }` gives instead, plus its trace events, done
  // here for real; the run keeps the calls, the created paths and the trace.
  function migrate(steps) {
    const dir = tempDir("anneal-graders-approved-run-");
    fs.cpSync(fixture, dir, { recursive: true });
    const before = listRunFiles(dir);
    // The prompt's slash command expands the skill without a Skill call; the
    // expanded skill reads its conventions before it plans.
    const calls = [{ name: "Read", input: { file_path: "/plugins/anneal/skills/repo-layout/references/conventions.md" } }];
    const events = [];
    const bashStep = (command, perform, { name, input } = { name: "Bash", input: { command } }) => {
      calls.push({ name, input });
      events.push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${events.length}`, name, input }] } });
      const output = perform() ?? "";
      events.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${events.length - 1}`, content: output }] } });
    };
    steps(dir, bashStep);
    return { dir, calls, created: createdPaths(before, listRunFiles(dir)), trace: events.map((event) => JSON.stringify(event)).join("\n") };
  }

  const move = (dir, to) => JSON.stringify(updateImports({ root: dir, from: "src/utils.js", to }));
  const commit = (dir, subject) => git(dir, "commit", "-qm", subject, "-m", "src/utils.js moved; the imports that named it follow.");
  const rename = (dir) => fs.renameSync(path.join(dir, "src/utils.js"), path.join(dir, "src/money.js"));
  // The move `mv` run from a script: a Write call outside the workspace holds
  // the command, and the Bash call that runs the script does not name it.
  const fromScript = (step, mv) => (command, perform) => {
    if (command !== mv) return step(command, perform);
    step(null, () => "File created successfully at: /tmp/move.sh", { name: "Write", input: { file_path: "/tmp/move.sh", content: `${mv}\n` } });
    step("sh /tmp/move.sh", perform);
  };

  // The approved step as the skill applies it. `checks` is the command that
  // reruns the checks after the move.
  function approvedStep(dir, step, { plainMove = false, reporter = "tap", checks = "npm test" } = {}) {
    step(`git switch -c ${BRANCH}`, () => git(dir, "switch", "-q", "-c", BRANCH));
    if (plainMove) step("mv src/utils.js src/money.js", () => rename(dir));
    else step("git mv src/utils.js src/money.js", () => git(dir, "mv", "src/utils.js", "src/money.js"));
    step('node "/plugins/anneal/scripts/update-imports.js" --root . --from src/utils.js --to src/money.js', () => move(dir, "src/money.js"));
    step("git add -A src", () => git(dir, "add", "-A", "src"));
    step(checks, () => check(dir, reporter).output);
    step('git commit -m "anneal: rename src/utils.js to src/money.js"', () => commit(dir, "anneal: rename src/utils.js to src/money.js"));
  }

  before(() => {
    checks = graders(CASE);
    script = read(CASE, "approved-step-fixture.sh");
    gitEnv.GIT_CONFIG_GLOBAL = path.join(tempDir("anneal-graders-git-"), "config");
    fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "[core]\n\tlongpaths = true\n");
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
    "the branch and a plain mv on two lines of one call": {
      steps: (dir, step) => {
        let branch;
        approvedStep(dir, (command, perform) => {
          if (command.startsWith("git switch")) branch = [command, perform];
          else if (command.startsWith("mv ")) step(`${branch[0]}\n${command}`, () => `${branch[1]() ?? ""}${perform() ?? ""}`);
          else step(command, perform);
        }, { plainMove: true });
      },
      fails: [],
    },
    "the approved step checked with the spec reporter": { steps: (dir, step) => approvedStep(dir, step, { reporter: "spec" }), fails: [] },
    "the approved step checked in the skill's POSIX form": { steps: (dir, step) => approvedStep(dir, step, { checks: POSIX_CHECKS }), fails: [] },
    "the approved step with its check output saved to a file": {
      steps: (dir, step) => approvedStep(dir, step, { checks: "npm test > /tmp/checks.out 2>&1; cat /tmp/checks.out; rm -f /tmp/checks.out" }),
      fails: ["checks-run-without-a-file"],
    },
    "the move run from a script a Write call holds": {
      steps: (dir, step) => approvedStep(dir, fromScript(step, "mv src/utils.js src/money.js"), { plainMove: true }),
      fails: ["checks-pass-after-the-move"],
    },
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
      const failed = failedGraders(checks, run);
      assert.deepStrictEqual(failed, [...fails].sort(), `created:\n${run.created}`);
      if (!fails.length) assert.strictEqual(check(run.dir).passed, true, "the fixture's check passes after the step");
    });
  }

  // Replies that quote a check summary line the tool results contradict.
  const QUOTES_PASS = "Moved it with `git mv src/utils.js src/money.js` and reran the checks:\n\n```\n# tests 2\n# pass 2\n# fail 0\n```";
  const QUOTES_FAIL = "The checks still report a failure from before the move:\n\n```\nℹ tests 2\nℹ pass 1\nℹ fail 1\n```";

  test("checks-pass-after-the-move follows the tool results, whatever summary line the reply quotes", () => {
    const grader = checks["checks-pass-after-the-move"];
    const cases = [
      ["the approved step as the skill applies it", QUOTES_FAIL, true],
      ["the move without its imports", QUOTES_PASS, false],
      ["a failing check after the passing one", QUOTES_PASS, false],
      ["no check after the move", QUOTES_PASS, false],
      ["no migration", QUOTES_PASS, false],
    ];
    for (const [name, text, expected] of cases) {
      const run = migrate(RUNS[name].steps);
      assert.strictEqual(passes(grader, { ...run, trace: withReply(run.trace, text) }), expected, name);
    }
  });

  // Bash calls that hold the move `mv`, and whether checks-pass-after-the-move
  // counts it. An mv counts at the start of the command, after any character
  // that is not a letter, digit or underscore (an echoed one, DEL and a
  // non-ASCII character included), or after a line feed or a tab. It does not
  // count after a lone carriage return, a form feed, a vertical tab or any
  // other control character below U+0020, after a letter, digit or
  // underscore, or after a printed \n.
  const mvForms = (mv) => [
    [mv, true],
    [`git status --short; ${mv}`, true],
    [`ls src && ${mv} && ls src`, true],
    [`git switch -c b\n${mv}`, true],
    [`git switch -c b\n\t${mv}`, true],
    [`git status\t${mv}`, true],
    [`git -C . ${mv}`, true],
    [`if true; then ${mv}; fi`, true],
    [`sudo ${mv}`, true],
    [`\\${mv}`, true],
    [`echo "${mv}"`, true],
    [`printf 'a\\n${mv}\\n'`, false],
    [`a${mv}`, false],
    [`aé${mv}`, true],
    [`a\x7f${mv}`, true],
    [`echo a\r${mv}`, false],
    [`echo a\f${mv}`, false],
    [`echo a\v${mv}`, false],
  ];

  test("checks-pass-after-the-move counts a mv at any word start or line start of a Bash call", () => {
    const grader = checks["checks-pass-after-the-move"];
    const mv = "mv src/utils.js src/money.js";
    for (const [command, expected] of mvForms(mv)) {
      const run = migrate((dir, step) => approvedStep(dir, (text, perform) => step(text === mv ? command : text, perform), { plainMove: true }));
      assert.strictEqual(passes(grader, run), expected, command);
    }
  });

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

  describe("checks-run-without-a-file", () => {
    let grader;
    before(() => {
      grader = checks["checks-run-without-a-file"];
    });

    test("it is scored in both arms and allows no such call", () => {
      assert.deepStrictEqual([grader.type, grader.tool, grader.min, grader.max, grader.arm], ["tool_used", "Bash", "0", "0", undefined]);
    });

    test("the forms that stopped the interactive migration runs fail it: a temporary file, a scratchpad file and tee", () => {
      // The refused baseline commands of two interactive runs, scratchpad paths replaced.
      const scratch = "/tmp/claude-1000/-work-cwd/0a1b2c3d/scratchpad";
      const recorded = [
        'npm test > /tmp/x.out 2>&1; echo "EXIT=$?"; echo "LINES=$(wc -l < /tmp/x.out)"; cat /tmp/x.out; rm -f /tmp/x.out; echo "--- status after ---"; git status --porcelain',
        `OUT="$CLAUDE_SCRATCHPAD/base.out"; OUT="\${OUT:-./.anneal-base.out}"; npm test > "${scratch}/base.out" 2>&1; echo "EXIT=$?"; wc -l < "${scratch}/base.out"; cat "${scratch}/base.out"; echo "--- status after ---"; git status --porcelain`,
        'npm test > /tmp/../dev/null 2>&1; echo "skip"; npm test 2>&1 | tee "$SCRATCH/baseline.txt" 2>/dev/null | wc -l; echo "exit=${PIPESTATUS[0]}"',
        `npm test 2>&1 | tee ${scratch}/baseline.txt; echo "EXIT=\${PIPESTATUS[0]}"; wc -l < ${scratch}/baseline.txt`,
      ];
      for (const command of recorded) assert.strictEqual(passes(grader, { calls: bash(command) }), false, command);
    });

    test("every baseline form the skill gives passes it", () => {
      // The skill's forms, each with <check> standing for the check command.
      const forms = [...read(path.join(__dirname, "..", "skills", "repo-layout"), "SKILL.md").matchAll(/`([^`]*<check>[^`]*)`/g)].map(([, form]) => form);
      assert.ok(forms.length >= 2, "the skill gives a POSIX and a PowerShell form");
      assert.ok(forms.includes(POSIX_CHECKS.replace("npm test", "<check>")), "the POSIX form replayed above is the skill's");
      for (const form of forms) {
        for (const command of ["npm test", "node --test"]) {
          assert.strictEqual(passes(grader, { calls: bash(form.replaceAll("<check>", command)) }), true, form);
        }
      }
    });

    test("other ways to send a check's output into a file or through tee fail it", () => {
      const saved = [
        '{ npm test 2>&1; echo "exit $?"; } > baseline.txt',
        `{ npm test 2>&1; echo "exit $?"; } | tee baseline.txt | awk '{ print } END { print "lines", NR - 1 }'`,
        '( npm test 2>&1; echo "exit $?" ) > baseline.txt',
        "npm test &> out.txt",
        "npm run test >> log.txt",
        "npm test |& tee out.txt",
        "npm test 2>&1 | awk '{ print }' > out.txt",
        "node --test --test-reporter=tap > out.tap",
        "git status --porcelain\nnpm test > out.txt",
        'bash -c "npm test > out.txt"',
        "$out = npm test 2>&1 | Tee-Object -FilePath out.txt",
        "npm test 2>&1 | Out-File baseline.txt",
      ];
      for (const command of saved) assert.strictEqual(passes(grader, { calls: bash(command) }), false, command);
    });

    test("a check that prints, discards or pages its output, and a redirect of another command, pass it", () => {
      const allowed = [
        "npm test",
        "npm test 2>&1 | tail -20",
        'npm test > /dev/null 2>&1; echo "exit $?"',
        "npm test 2>&1 >&2",
        'node "/plugins/anneal/scripts/audit.js" --root . --json > /tmp/audit.json',
        'node "/plugins/anneal/scripts/audit.js" --root "$(pwd)" --json | tee "$CLAUDE_SCRATCHPAD/audit.json"',
        "git status --porcelain > /tmp/status.txt; npm test",
        "npm test; git diff > /tmp/diff.txt",
        'echo "baseline" > notes.txt && npm test 2>&1',
        "npm run testing > out.txt",
      ];
      for (const command of allowed) assert.strictEqual(passes(grader, { calls: bash(command) }), true, command);
      const described = [{ name: "Bash", input: { command: "git status --short", description: "Then run npm test > baseline.txt" } }];
      assert.strictEqual(passes(grader, { calls: described }), true, "a description is not a command");
    });

    test("the first paired run's calls pass it in both arms", () => {
      for (const calls of Object.values(PAIRED_RUN)) assert.strictEqual(passes(grader, { calls }), true);
    });
  });

  test("the fixture's check fails wherever the move broke an import", () => {
    const run = migrate(RUNS["the move without its imports"].steps);
    assert.strictEqual(check(run.dir).passed, false);
  });

  // migration-moves-into-new-directory scaffolds this case's fixture, which has
  // no src/lib, and approves a move into that directory.
  describe("migration-moves-into-new-directory", () => {
    const NEW = path.join(EVALS, "migration-moves-into-new-directory");
    const TO = "src/lib/money.js";
    let newChecks;
    let alone;
    before(() => {
      newChecks = graders(NEW);
      alone = newChecks["branch-directory-and-move-alone"];
    });

    test("its scaffold runs this case's fixture script, whose repository has no src/lib", () => {
      assert.match(read(NEW, "case.yaml"), /^ {2}scaffold_script: new-directory-fixture\.sh$/m);
      assert.match(read(NEW, "new-directory-fixture.sh"), /^bash "\$\(dirname "\$0"\)\/\.\.\/migration-applies-approved-step\/approved-step-fixture\.sh"$/m);
      assert.strictEqual(fs.existsSync(path.join(fixture, "src/lib")), false);
    });

    test("the graders it shares with this case are the same files", () => {
      const shared = ["checks-run-without-a-file", "manifest-unchanged", "map-file-unchanged", "migration-branch-created", "skill-fired", "step-committed", "test-unchanged"];
      for (const name of shared) assert.strictEqual(read(path.join(NEW, "graders"), `${name}.md`), read(path.join(CASE, "graders"), `${name}.md`), name);
    });

    // The approved step as the skill applies it: the branch, the directory and
    // the move each in a Bash call of its own. `join` names commands to run as
    // one call instead, and `separator` joins them; `plainMove` moves with mv.
    function newDirectoryStep(dir, step, { checks = "npm test", join = [], separator = " && ", plainMove = false } = {}) {
      const commands = [
        ["branch", `git switch -c ${BRANCH}`, () => git(dir, "switch", "-q", "-c", BRANCH)],
        ["directory", "mkdir -p src/lib", () => fs.mkdirSync(path.join(dir, "src/lib"), { recursive: true })],
        plainMove
          ? ["move", `mv src/utils.js ${TO}`, () => fs.renameSync(path.join(dir, "src/utils.js"), path.join(dir, TO))]
          : ["move", `git mv src/utils.js ${TO}`, () => git(dir, "mv", "src/utils.js", TO)],
        ["status", "git status --porcelain", () => git(dir, "status", "--porcelain")],
      ];
      const joined = commands.filter(([name]) => join.includes(name));
      for (const [name, command, perform] of commands) {
        if (joined.length && name === joined[0][0]) step(joined.map(([, text]) => text).join(separator), () => joined.map(([, , run]) => run() ?? "").join(""));
        else if (!join.includes(name) && name !== "status") step(command, perform);
      }
      step(`node "/plugins/anneal/scripts/update-imports.js" --root . --from src/utils.js --to ${TO}`, () => move(dir, TO));
      step("git add -A src", () => git(dir, "add", "-A", "src"));
      step(checks, () => check(dir).output);
      step(`git commit -m "anneal: move src/utils.js to ${TO}"`, () => commit(dir, `anneal: move src/utils.js to ${TO}`));
    }

    const CHAINED = ["branch-directory-and-move-alone"];
    const NEW_RUNS = {
      "the approved step as the skill applies it": { steps: (dir, step) => newDirectoryStep(dir, step), fails: [] },
      "the approved step checked in the skill's POSIX form": { steps: (dir, step) => newDirectoryStep(dir, step, { checks: POSIX_CHECKS }), fails: [] },
      "the branch, directory and move chained with && and a status": {
        steps: (dir, step) => newDirectoryStep(dir, step, { join: ["branch", "directory", "move", "status"] }),
        fails: CHAINED,
      },
      "the directory and move chained with ;": { steps: (dir, step) => newDirectoryStep(dir, step, { join: ["directory", "move"], separator: "; " }), fails: CHAINED },
      "the directory and move on two lines of one call": { steps: (dir, step) => newDirectoryStep(dir, step, { join: ["directory", "move"], separator: "\n" }), fails: CHAINED },
      "the directory and a plain mv on two lines of one call": {
        steps: (dir, step) => newDirectoryStep(dir, step, { join: ["directory", "move"], separator: "\n", plainMove: true }),
        fails: CHAINED,
      },
      "the branch chained with the directory": { steps: (dir, step) => newDirectoryStep(dir, step, { join: ["branch", "directory"] }), fails: CHAINED },
      "the move chained with a status check": { steps: (dir, step) => newDirectoryStep(dir, step, { join: ["move", "status"] }), fails: CHAINED },
      "the check output saved to a file": {
        steps: (dir, step) => newDirectoryStep(dir, step, { checks: "npm test 2>&1 | tee /tmp/checks.out" }),
        fails: ["checks-run-without-a-file"],
      },
      "the move run from a script a Write call holds": {
        steps: (dir, step) => newDirectoryStep(dir, fromScript(step, `git mv src/utils.js ${TO}`)),
        fails: ["checks-pass-after-the-move"],
      },
      "the move kept in src, as the other case approves": {
        steps: (dir, step) => approvedStep(dir, step),
        fails: ["moved-file-intact", "old-path-untracked", "cart-import-rewritten", "summary-import-rewritten", "checks-pass-after-the-move", "only-the-approved-step"],
      },
      "no migration": {
        steps: () => {},
        fails: ["moved-file-intact", "old-path-untracked", "migration-branch-created", "step-committed", "cart-import-rewritten", "summary-import-rewritten", "checks-pass-after-the-move"],
      },
    };

    for (const [name, { steps, fails }] of Object.entries(NEW_RUNS)) {
      test(`${name}: ${fails.length ? `fails ${fails.join(", ")}` : "passes every grader"}`, () => {
        const run = migrate(steps);
        const failed = failedGraders(newChecks, run);
        assert.deepStrictEqual(failed, [...fails].sort(), `created:\n${run.created}`);
        if (!fails.length || fails === CHAINED) assert.strictEqual(check(run.dir).passed, true, "the fixture's check passes after the step");
      });
    }

    test("checks-pass-after-the-move follows the tool results, whatever summary line the reply quotes", () => {
      const grader = newChecks["checks-pass-after-the-move"];
      const quotesPass = QUOTES_PASS.replace("src/money.js", TO);
      const red = (dir, step) => {
        newDirectoryStep(dir, step);
        step("npm test", () => "TAP version 13\nnot ok 1 - a cart total sums the items\n1..1\n# tests 1\n# pass 0\n# fail 1\n");
      };
      const cases = [
        ["the approved step", NEW_RUNS["the approved step as the skill applies it"].steps, QUOTES_FAIL, true],
        ["a failing check after the passing one", red, quotesPass, false],
        ["no migration", NEW_RUNS["no migration"].steps, quotesPass, false],
      ];
      for (const [name, steps, text, expected] of cases) {
        const run = migrate(steps);
        assert.strictEqual(passes(grader, { ...run, trace: withReply(run.trace, text) }), expected, name);
      }
    });

    test("checks-pass-after-the-move counts a mv at any word start or line start of a Bash call", () => {
      const grader = newChecks["checks-pass-after-the-move"];
      const mv = `mv src/utils.js ${TO}`;
      for (const [command, expected] of mvForms(mv)) {
        const run = migrate((dir, step) => newDirectoryStep(dir, (text, perform) => step(text === mv ? command : text, perform), { plainMove: true }));
        assert.strictEqual(passes(grader, run), expected, command);
      }
    });

    test("branch-directory-and-move-alone fails the refused chain of an interactive run and passes each command alone", () => {
      assert.deepStrictEqual([alone.type, alone.tool, alone.min, alone.max, alone.arm], ["tool_used", "Bash", "0", "0", undefined]);
      assert.strictEqual(passes(alone, { calls: bash("git checkout -b anneal/2026-09-22 && mkdir -p src/lib && git mv src/utils.js src/lib/money.js && git status --porcelain") }), false);
      const chained = [
        "git switch -c anneal/2026-09-22 && git status",
        "git rev-parse HEAD; git switch -c anneal/2026-09-22",
        "git branch anneal/2026-09-22 && git switch anneal/2026-09-22",
        "mkdir -p src/lib || true",
        "cd /work/cwd && git mv src/utils.js src/lib/money.js",
        "mv src/utils.js src/lib/money.js && node update-imports.js",
        "New-Item -ItemType Directory -Path src/lib; git mv src/utils.js src/lib/money.js",
        "New-Item -ItemType Directory -Path src/lib\nMove-Item src/utils.js src/lib/money.js",
      ];
      for (const command of chained) assert.strictEqual(passes(alone, { calls: bash(command) }), false, command);
      const single = [
        "git switch -c anneal/2026-09-22",
        "git checkout -b anneal/2026-09-22",
        "mkdir -p src/lib",
        "New-Item -ItemType Directory -Path src/lib",
        "git mv src/utils.js src/lib/money.js",
        "git mv src/utils.js src/lib/money.js\n",
        "git rev-parse HEAD && git rev-parse --verify --quiet refs/heads/anneal/2026-09-22",
        "git branch --show-current && git status --porcelain",
        "git add -A src && git status --porcelain",
        'node "/plugins/anneal/scripts/update-imports.js" --root . --from src/utils.js --to src/lib/money.js',
        POSIX_CHECKS,
      ];
      for (const command of single) assert.strictEqual(passes(alone, { calls: bash(command) }), true, command);
    });

    test("branch-directory-and-move-alone fails both arms of the other case's first paired run, which chained the move", () => {
      for (const calls of Object.values(PAIRED_RUN)) assert.strictEqual(passes(alone, { calls }), false);
    });
  });

  // plan-flags-a-wrong-importer-count scaffolds this case's fixture and hands over a layout survey whose rename row
  // claims one importer of src/utils.js. The plan it asks for must show that row flagged with what the search found.
  describe("plan-flags-a-wrong-importer-count", () => {
    const WRONG = path.join(EVALS, "plan-flags-a-wrong-importer-count");
    const REPLY_GRADERS = ["search-result-shown", "stale-row-flagged", "stale-row-not-planned"];
    let wrongChecks;
    before(() => {
      wrongChecks = graders(WRONG);
    });
    // The reply graders a plan fails.
    const failedBy = (reply) => failedGraders(Object.fromEntries(REPLY_GRADERS.map((name) => [name, wrongChecks[name]])), { reply });

    test("its scaffold runs this case's fixture script, where two files import the file the survey row says one does", () => {
      assert.match(read(WRONG, "case.yaml"), /^ {2}scaffold_script: wrong-count-fixture\.sh$/m);
      assert.match(read(WRONG, "wrong-count-fixture.sh"), /^bash "\$\(dirname "\$0"\)\/\.\.\/migration-applies-approved-step\/approved-step-fixture\.sh"$/m);
      const row = /^\| `src\/utils\.js` \| `src\/money\.js` \| (\d+) \|/m.exec(read(WRONG, "prompt.md"));
      assert.ok(row, "the prompt carries the survey's rename row in the mapper's format");
      const importers = listRunFiles(path.join(fixture, "src")).filter((file) => /from "\.\.?\/utils\.js"/.test(read(path.join(fixture, "src"), file)));
      assert.deepStrictEqual(importers.sort(), ["cart.js", "orders/summary.js"]);
      assert.notStrictEqual(Number(row[1]), importers.length);
    });

    test("the graders it shares with the other cases are the same files", () => {
      assert.strictEqual(read(path.join(WRONG, "graders"), "skill-fired.md"), read(path.join(CASE, "graders"), "skill-fired.md"));
      assert.strictEqual(read(path.join(WRONG, "graders"), "no-new-refs-or-files.md"), read(path.join(MIGRATION, "graders"), "no-new-refs-or-files.md"));
    });

    test("a plan that shows the row flagged with what the search found passes, in a list, a table or Spanish", () => {
      const flagged = [
        "Plan\n\n1. **Map file.** Nothing to do: `AGENTS.md` is on the sequence.\n\nFlagged survey rows:\n"
          + "- `src/utils.js` → `src/money.js`: the survey says 1 importer, but the search found 2, `src/cart.js` and `src/orders/summary.js`.\n\n"
          + "Which steps should I apply?",
        "No step is planned yet.\n\n**Flagged rows**\n\n| From | To | Survey | Search found |\n| --- | --- | --- | --- |\n"
          + "| `src/utils.js` | `src/money.js` | 1 | 2: `src/cart.js`, `src/orders/summary.js` |\n\nShould I plan the rename with both importers?",
        "Filas marcadas:\n- `src/utils.js` → `src/money.js`: la propuesta dice 1 importador; la búsqueda encontró 2 archivos que lo importan, "
          + "`src/cart.js` y `src/orders/summary.js`.\n\n¿Qué pasos aplico?",
      ];
      for (const reply of flagged) assert.deepStrictEqual(failedBy(reply), [], reply);
    });

    test("a plan that plans the row as proposed, corrects it silently or drops it fails", () => {
      const plans = {
        "planned as proposed": ["Plan\n\n1. Rename `src/utils.js` to `src/money.js` (1 importer).\n\nWhich steps should I apply?", REPLY_GRADERS],
        "planned as proposed in a table": [
          "| # | Step | Files |\n| --- | --- | --- |\n| 6 | Rename `src/utils.js` → `src/money.js` | 1 importer |", REPLY_GRADERS,
        ],
        "corrected without a flag": [
          "Plan\n\n1. Rename `src/utils.js` to `src/money.js`, with its 2 importers `src/cart.js` and `src/orders/summary.js`.", ["stale-row-flagged"],
        ],
        "dropped quietly": ["Plan\n\nNothing to rename. The map file is fine.\n\nWhich steps should I apply?", ["search-result-shown", "stale-row-flagged"]],
      };
      for (const [name, [reply, fails]] of Object.entries(plans)) assert.deepStrictEqual(failedBy(reply), [...fails].sort(), name);
    });

    test("a plan-only run passes the workspace graders, and a run that renamed the file fails them", () => {
      const plan = migrate(() => {});
      assert.strictEqual(passes(wrongChecks["no-new-refs-or-files"], plan), true);
      assert.strictEqual(passes(wrongChecks["skill-fired"], plan), true);
      const renamed = migrate((dir, step) => approvedStep(dir, step));
      assert.strictEqual(passes(wrongChecks["no-new-refs-or-files"], renamed), false);
    });
  });
});

// The session-failure cases: each gives session-review a synthetic transcript of
// one failure shape and approves nothing. A run as the case asks has the evidence
// call, the evidence session-evidence.js prints for the case's own transcript in
// its trace, the scaffold's files unchanged and nothing created. What its reply
// proposes is graded by a judge model against PASS and FAIL criteria, so the
// reply graders get no verdict here; each other run lists exactly the
// deterministic graders it fails.
describe("session-failure cases", () => {
  const CALL = 'node "/plugins/anneal/scripts/session-evidence.js" --session-file session.jsonl --before 2026-09-22T23:59:59.000Z';
  const traceOf = (output) => JSON.stringify({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: output, is_error: false }] } });

  // The scaffold without bash, in a temporary directory: another case's scaffold
  // it runs first, then the files its heredocs write and the transcript its
  // embedded program prints. The transcript records SESSION_CWD as its working
  // directory, not the temporary one: a diagnostic can name that directory twice,
  // and session-evidence.js cuts each diagnostic at 480 characters, so a long
  // temporary path would cut the part an evidence grader reads.
  const BASE_SCAFFOLD = /^bash "\$\(dirname "\$0"\)\/\.\.\/([^/"]+)\/([^/"]+)"$/m;
  const SESSION_CWD = "/work/cwd";
  function scaffold(caseDir, dir = tempDir("anneal-graders-failure-")) {
    const script = /^ {2}scaffold_script: (\S+)$/m.exec(read(caseDir, "case.yaml"))[1];
    const text = read(caseDir, script);
    const base = BASE_SCAFFOLD.exec(text);
    if (base) scaffold(path.join(EVALS, base[1]), dir);
    for (const [, file, , content] of text.matchAll(/^cat > (\S+) <<'(\w+)'\n([\s\S]*?)\n\2\n/gm)) write(dir, file, `${content}\n`);
    const program = /^node - [^\n]*<<'JS'\n([\s\S]*?)\nJS\n/m.exec(text);
    if (program) fs.writeFileSync(path.join(dir, "session.jsonl"), execFileSync(process.execPath, ["-", SESSION_CWD], { input: program[1], encoding: "utf8" }));
    return dir;
  }

  const evidenceFor = (dir, before = "2026-09-22T23:59:59.000Z") => {
    const run = spawnSync(process.execPath, [EVIDENCE, "--session-file", path.join(dir, "session.jsonl"), "--before", before], { encoding: "utf8" });
    assert.strictEqual(run.status, 0, run.stderr);
    return run.stdout;
  };

  // Each case's reply graders, which a judge model grades.
  const CASES = {
    "session-audit-adds-no-rule-for-a-flake": ["flake-rule-not-proposed", "no-change-proposed"],
    "session-audit-keeps-a-machine-fact-out": ["machine-fact-for-the-global-file", "machine-path-not-proposed-for-the-map"],
    "session-audit-reports-a-refusal-workaround": ["safety-finding-reported", "workaround-not-proposed"],
    "session-audit-proposes-the-quiet-reporter": ["quiet-command-for-commands"],
    "session-audit-proposes-a-path-hint": ["hint-for-where-things-live", "no-move-proposed"],
    "session-audit-names-no-check-writer-without-collet": ["check-writer-not-named"],
    "session-audit-suggests-check-writer-with-collet": ["check-writer-suggested"],
  };
  const REPLY = "No change proposed.";

  for (const [name, judged] of Object.entries(CASES)) {
    describe(name, () => {
      const CASE = path.join(EVALS, name);
      let checks;
      let run;
      before(() => {
        checks = graders(CASE);
        const dir = scaffold(CASE);
        run = { dir, calls: bash(CALL), trace: traceOf(evidenceFor(dir)), created: "" };
      });
      const failed = (changes) => failedGraders(checks, { ...run, ...changes });

      test("it is tagged session-failure, and its evidence-ran grader is the session case's own", () => {
        assert.match(read(CASE, "case.yaml"), /^tags: \[session-failure\]$/m);
        assert.deepStrictEqual(checks["evidence-ran"], graders(SESSION)["evidence-ran"]);
      });

      test("a judge grades its reply against PASS and FAIL criteria, and no other grader reads the reply", () => {
        const readsReply = Object.values(checks).filter((grader) => grader.type !== "tool_used" && (grader.target ?? grader.focus ?? "last_message") === "last_message");
        assert.deepStrictEqual(readsReply.map((grader) => grader.name).sort(), [...judged].sort());
        for (const grader of readsReply) {
          assert.strictEqual(grader.type, "llm", grader.name);
          assert.strictEqual(passes(grader, { ...run, reply: REPLY }), null, grader.name);
        }
      });

      test("a run as the case asks passes every deterministic grader, whatever its reply", () => {
        assert.deepStrictEqual(failed({ reply: REPLY }), []);
        assert.deepStrictEqual(failed({ reply: "" }), []);
      });

      test("evidence cut before the failure, no evidence call, an edited map file or a created file fails its grader", () => {
        const reply = REPLY;
        const trace = traceOf(evidenceFor(run.dir, "2026-01-01T00:00:02.000Z"));
        const evidenceGrader = Object.keys(checks).find((grader) => grader.startsWith("evidence-found-"));
        assert.deepStrictEqual(failed({ reply, trace }), [evidenceGrader]);
        assert.deepStrictEqual(failed({ reply, trace: withReply(trace, evidenceFor(run.dir)) }), [evidenceGrader], "the reply quotes the full evidence");
        assert.deepStrictEqual(failed({ reply, trace: traceOf(read(run.dir, "session.jsonl")) }), [evidenceGrader]);
        assert.deepStrictEqual(failed({ reply, calls: bash("cat session.jsonl") }), ["evidence-ran"]);
        assert.deepStrictEqual(failed({ reply, created: "notes/session-review.md" }), ["no-files-created"]);
        const edited = tempDir("anneal-graders-failure-edit-");
        fs.cpSync(run.dir, edited, { recursive: true });
        fs.appendFileSync(path.join(edited, "AGENTS.md"), "\n## Pitfalls\n\n- Added by the run.\n");
        const editedFails = ["map-file-left-alone"];
        if (checks["manifest-left-alone"]) {
          write(edited, "package.json", read(edited, "package.json").replace('"node --test"', '"node --test --test-reporter=dot"'));
          editedFails.push("manifest-left-alone");
        }
        assert.deepStrictEqual(failed({ reply, dir: edited }), editedFails.sort());
      });

      test("its evidence grader reads each part of the evidence from the tool result, whatever the reply quotes", () => {
        const grader = Object.values(checks).find((check) => check.name.startsWith("evidence-found-"));
        const full = evidenceFor(run.dir);
        const lines = full.split("\n");
        const verdicts = lines.map((_, index) => {
          const trace = traceOf(lines.slice(0, index + 1).join("\n"));
          const alone = passes(grader, { ...run, trace });
          assert.strictEqual(passes(grader, { ...run, trace: withReply(trace, full) }), alone, `tool result cut after line ${index + 1}, reply with the full evidence`);
          return alone;
        });
        assert.deepStrictEqual([verdicts[0], verdicts.at(-1)], [false, true]);
      });
    });
  }

  // A transcript that repeats a mistake a check could catch, once beside a
  // .collet/ directory and once without one. Only the judge tells which reply
  // names check-writer; the graders below catch a check written or a collet
  // file run.
  describe("the check-writer pair", () => {
    const WITHOUT = path.join(EVALS, "session-audit-names-no-check-writer-without-collet");
    const WITH = path.join(EVALS, "session-audit-suggests-check-writer-with-collet");
    const SHARED = ["check-writer-not-invoked", "evidence-found-the-repeated-mistake", "evidence-ran", "map-file-left-alone", "no-collet-file-run", "no-files-created"];
    let checks;
    let without;
    let withCollet;
    before(() => {
      checks = graders(WITH);
      without = scaffold(WITHOUT);
      withCollet = scaffold(WITH);
    });

    test("the scaffold with collet runs the other case's scaffold, then adds only .collet/", () => {
      const [, caseName, script] = BASE_SCAFFOLD.exec(read(WITH, "collet-fixture.sh"));
      assert.strictEqual(caseName, path.basename(WITHOUT));
      assert.match(read(WITHOUT, "case.yaml"), new RegExp(`^ {2}scaffold_script: ${script.replaceAll(".", "\\.")}$`, "m"));
      assert.strictEqual(fs.existsSync(path.join(without, ".collet")), false);
      assert.ok(fs.statSync(path.join(withCollet, ".collet")).isDirectory());
      const files = listRunFiles(withCollet);
      assert.deepStrictEqual(files.filter((file) => file.startsWith(".collet/")), [".collet/config.json"]);
      const rest = files.filter((file) => !file.startsWith(".collet/"));
      assert.deepStrictEqual(rest, listRunFiles(without));
      for (const file of rest.filter((name) => name !== "session.jsonl")) assert.strictEqual(read(withCollet, file), read(without, file), file);
    });

    test("both cases share every deterministic grader file, and each has one judge of its own", () => {
      const own = (dir) => fs.readdirSync(path.join(dir, "graders")).map((file) => path.basename(file, ".md")).filter((name) => !SHARED.includes(name));
      assert.deepStrictEqual(own(WITHOUT), ["check-writer-not-named"]);
      assert.deepStrictEqual(own(WITH), ["check-writer-suggested"]);
      for (const name of SHARED) assert.strictEqual(read(path.join(WITH, "graders"), `${name}.md`), read(path.join(WITHOUT, "graders"), `${name}.md`), name);
    });

    test("evidence that shows both failed imports passes, and evidence cut after the first fails", () => {
      const grader = checks["evidence-found-the-repeated-mistake"];
      assert.strictEqual(passes(grader, { trace: traceOf(evidenceFor(withCollet)) }), true);
      const first = evidenceFor(withCollet, "2026-01-01T00:00:12.000Z");
      assert.match(first, /imported from [^"]*\/src\/cart\.js/);
      assert.doesNotMatch(first, /src\/orders\.js/);
      assert.strictEqual(passes(grader, { trace: traceOf(first) }), false);
    });

    test("the evidence grader gives the same verdicts in a long temporary directory", () => {
      const grader = checks["evidence-found-the-repeated-mistake"];
      const long = path.join(tempDir("anneal-graders-long-"), "d".repeat(200));
      fs.mkdirSync(long);
      for (const caseDir of [WITHOUT, WITH]) {
        const dir = scaffold(caseDir, long);
        assert.strictEqual(passes(grader, { trace: traceOf(evidenceFor(dir)) }), true, path.basename(caseDir));
        assert.strictEqual(passes(grader, { trace: traceOf(evidenceFor(dir, "2026-01-01T00:00:12.000Z")) }), false, path.basename(caseDir));
      }
    });

    test("no-collet-file-run fails a collet file run, and passes looking for the directory", () => {
      const grader = checks["no-collet-file-run"];
      assert.deepStrictEqual([grader.type, grader.tool, grader.min, grader.max, grader.arm], ["tool_used", "Bash", "0", "0", undefined]);
      const run = [
        "node .collet/checks/run.mjs",
        "node .collet\\checks\\run.mjs",
        'node "/work/cwd/.collet/checks/run.mjs"',
        "node .collet/task.mjs status",
        "git rev-parse --show-toplevel && node .collet/checks/run.mjs --strict",
      ];
      for (const command of run) assert.strictEqual(passes(grader, { calls: bash(command) }), false, command);
      const allowed = [
        CALL,
        "git rev-parse --show-toplevel",
        'test -d "$(git rev-parse --show-toplevel)/.collet" && echo collet',
        "ls -a",
        "ls -d .collet/",
        "ls .collet/ && cat .collet/config.json",
      ];
      for (const command of allowed) assert.strictEqual(passes(grader, { calls: bash(command) }), true, command);
    });

    test("check-writer-not-invoked fails a check-writer Skill call and passes any other", () => {
      const grader = checks["check-writer-not-invoked"];
      assert.deepStrictEqual([grader.type, grader.tool, grader.min, grader.max, grader.arm], ["tool_used", "Skill", "0", "0", undefined]);
      const skill = (name) => [{ name: "Skill", input: { skill: name } }];
      assert.strictEqual(passes(grader, { calls: skill("collet:check-writer") }), false);
      assert.strictEqual(passes(grader, { calls: skill("check-writer") }), false);
      assert.strictEqual(passes(grader, { calls: skill("anneal:session-review") }), true);
      assert.strictEqual(passes(grader, { calls: bash(CALL) }), true);
    });

    test("a check and its fixtures written under .collet/checks fail no-files-created", () => {
      const written = ".collet/checks/relative-import-extension.mjs\n.collet/checks/relative-import-extension.nearmiss.json\n.collet/checks/relative-import-extension.violation.json";
      assert.strictEqual(passes(checks["no-files-created"], { created: written }), false);
      assert.strictEqual(passes(checks["no-files-created"], { created: ".git/config.worktree" }), true);
    });
  });
});

// The repeated-step cases: three transcripts that run the same two commands, once beside a map
// file that names only the first and once beside one that names both. The graders read what
// session-repeats.js prints for the case's own sessions folder; only a judge reads the reply.
describe("session-repeats cases", () => {
  const PROPOSES = path.join(EVALS, "session-repeats-proposes-a-script");
  const SKIPS = path.join(EVALS, "session-repeats-skips-what-the-map-names");
  const REPEATS = path.join(__dirname, "..", "scripts", "session-repeats.js");
  const CALL = 'node "/plugins/anneal/scripts/session-repeats.js" --root "/work/cwd" --sessions-dir sessions/';
  const SHARED = ["evidence-found-the-repeat", "evidence-ran", "no-files-created"];
  const JUDGED = { [PROPOSES]: "proposes-command-and-map-line", [SKIPS]: "no-change-for-a-named-step" };
  const traceOf = (output) => JSON.stringify({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: output, is_error: false }] } });
  // GIT_CONFIG_NOSYSTEM drops the system core.longpaths that Git for Windows sets, so the
  // isolated global config restores it, as in the migration workspace graders' helper.
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
  for (const name of ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete gitEnv[name];

  // The scaffold without bash: the other case's script it runs first, the files its heredocs
  // write, a Git repository, and the sessions its embedded program writes, with /work/cwd as
  // their working directory.
  function scaffold(caseDir, dir = tempDir("anneal-graders-repeats-")) {
    const script = /^ {2}scaffold_script: (\S+)$/m.exec(read(caseDir, "case.yaml"))[1];
    const text = read(caseDir, script);
    const base = /^bash "\$\(dirname "\$0"\)\/\.\.\/([^/"]+)\/([^/"]+)"$/m.exec(text);
    if (base) scaffold(path.join(EVALS, base[1]), dir);
    for (const [, file, , content] of text.matchAll(/^cat > (\S+) <<'(\w+)'\n([\s\S]*?)\n\2\n/gm)) write(dir, file, `${content}\n`);
    if (!fs.existsSync(path.join(dir, ".git"))) execFileSync("git", ["-c", "core.longpaths=true", "init", "-q"], { cwd: dir, env: gitEnv, stdio: "pipe" });
    const program = /^node - [^\n]*<<'JS'\n([\s\S]*?)\nJS\n/m.exec(text);
    if (program) execFileSync(process.execPath, ["-", "/work/cwd"], { input: program[1], cwd: dir, stdio: "pipe" });
    return dir;
  }

  const empty = () => tempDir("anneal-graders-home-");
  function repeatsFor(dir, ...args) {
    const run = spawnSync(process.execPath, [REPEATS, "--root", dir, "--sessions-dir", path.join(dir, "sessions"), "--claude-home", empty(), "--codex-home", empty(), ...args], { encoding: "utf8", env: gitEnv });
    assert.strictEqual(run.status, 0, run.stderr);
    return run.stdout;
  }

  let dirs;
  before(() => {
    gitEnv.GIT_CONFIG_GLOBAL = path.join(tempDir("anneal-graders-git-"), "config");
    fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "[core]\n\tlongpaths = true\n");
    dirs = { [PROPOSES]: scaffold(PROPOSES), [SKIPS]: scaffold(SKIPS) };
  });

  test("both cases are tagged session-repeats, and the skip case runs the other's scaffold", () => {
    for (const caseDir of [PROPOSES, SKIPS]) assert.match(read(caseDir, "case.yaml"), /^tags: \[session-repeats\]$/m);
    const [, caseName, script] = /^bash "\$\(dirname "\$0"\)\/\.\.\/([^/"]+)\/([^/"]+)"$/m.exec(read(SKIPS, "skips-fixture.sh"));
    assert.strictEqual(caseName, path.basename(PROPOSES));
    assert.match(read(PROPOSES, "case.yaml"), new RegExp(`^ {2}scaffold_script: ${script.replaceAll(".", "\\.")}$`, "m"));
  });

  test("the cases differ only in AGENTS.md and their own judge, and share every other grader file", () => {
    const [proposes, skips] = [PROPOSES, SKIPS].map((caseDir) => dirs[caseDir]);
    const files = listRunFiles(proposes);
    assert.deepStrictEqual(listRunFiles(skips), files);
    assert.deepStrictEqual(files.filter((file) => file.startsWith("sessions/")).length, 3);
    for (const file of files.filter((name) => name !== "AGENTS.md")) assert.strictEqual(read(skips, file), read(proposes, file), file);
    assert.notStrictEqual(read(skips, "AGENTS.md"), read(proposes, "AGENTS.md"));
    for (const name of SHARED) assert.strictEqual(read(path.join(SKIPS, "graders"), `${name}.md`), read(path.join(PROPOSES, "graders"), `${name}.md`), name);
    const own = (caseDir) => fs.readdirSync(path.join(caseDir, "graders")).map((file) => path.basename(file, ".md")).filter((name) => !SHARED.includes(name)).sort();
    for (const caseDir of [PROPOSES, SKIPS]) assert.deepStrictEqual(own(caseDir), ["map-file-left-alone", JUDGED[caseDir]].sort());
  });

  test("the script finds the listing in all three sessions, named in the map only where the skip case names it", () => {
    for (const [caseDir, named] of [[PROPOSES, false], [SKIPS, true]]) {
      const listing = JSON.parse(repeatsFor(dirs[caseDir])).findings.commands.find((finding) => finding.step === "git status --short --ignored");
      assert.deepStrictEqual([listing.sessions, listing.namedInMap, listing.projectScript], [3, named, null], path.basename(caseDir));
    }
  });

  for (const caseDir of [PROPOSES, SKIPS]) {
    describe(path.basename(caseDir), () => {
      let checks;
      let run;
      before(() => {
        checks = graders(caseDir);
        run = { dir: dirs[caseDir], calls: bash(CALL), trace: traceOf(repeatsFor(dirs[caseDir])), created: "" };
      });
      const failed = (changes) => failedGraders(checks, { ...run, ...changes });

      test("a run as the case asks fails no deterministic grader, whatever its reply", () => {
        assert.deepStrictEqual(failed({ reply: "No change proposed." }), []);
        assert.deepStrictEqual(failed({ reply: "" }), []);
      });

      test("output from two of the three sessions, or with --min-sessions 4, fails the evidence grader", () => {
        const two = tempDir("anneal-graders-repeats-two-");
        fs.cpSync(run.dir, two, { recursive: true });
        fs.rmSync(path.join(two, "sessions", "0a1b2c3d-0000-4000-8000-000000000003.jsonl"));
        assert.deepStrictEqual(failed({ trace: traceOf(repeatsFor(two)) }), ["evidence-found-the-repeat"]);
        assert.deepStrictEqual(failed({ trace: traceOf(repeatsFor(two, "--min-sessions", "2")) }), ["evidence-found-the-repeat"]);
        assert.deepStrictEqual(failed({ trace: traceOf(repeatsFor(run.dir, "--min-sessions", "4")) }), ["evidence-found-the-repeat"]);
      });

      test("reading the transcripts instead of running the script fails evidence-ran and the evidence grader", () => {
        const raw = fs.readdirSync(path.join(run.dir, "sessions")).map((file) => read(path.join(run.dir, "sessions"), file)).join("");
        assert.deepStrictEqual(failed({ calls: bash("cat sessions/*.jsonl") }), ["evidence-ran"]);
        assert.deepStrictEqual(failed({ trace: traceOf(raw) }), ["evidence-found-the-repeat"]);
        assert.deepStrictEqual(failed({ trace: withReply(traceOf(raw), repeatsFor(run.dir)) }), ["evidence-found-the-repeat"], "the reply quotes the output");
      });

      test("an edited AGENTS.md or a created script fails its grader", () => {
        const edited = tempDir("anneal-graders-repeats-edit-");
        fs.cpSync(run.dir, edited, { recursive: true });
        fs.appendFileSync(path.join(edited, "AGENTS.md"), "| `npm run status` | lists every file | seconds |\n");
        assert.deepStrictEqual(failed({ dir: edited }), ["map-file-left-alone"]);
        assert.deepStrictEqual(failed({ created: "scripts/check-status.sh" }), ["no-files-created"]);
      });

      test("a judge grades the reply against PASS and FAIL lines, and no other grader reads the reply", () => {
        const readsReply = Object.values(checks).filter((grader) => grader.type !== "tool_used" && (grader.target ?? grader.focus ?? "last_message") === "last_message");
        assert.deepStrictEqual(readsReply.map((grader) => grader.name), [JUDGED[caseDir]]);
        const [judge] = readsReply;
        assert.strictEqual(judge.type, "llm");
        assert.match(judge.criteria, /^PASS if /m);
        assert.match(judge.criteria, /^FAIL if /m);
        assert.strictEqual(passes(judge, { ...run, reply: "No change proposed." }), null);
      });
    });
  }
});

// A readme or writing case's scaffold without bash: the other case's script it runs first, then
// the files its heredocs write.
function replay(caseDir, dir = tempDir("anneal-graders-readme-")) {
  const script = /^ {2}scaffold_script: (\S+)$/m.exec(read(caseDir, "case.yaml"))[1];
  const text = read(caseDir, script);
  const base = /^bash "\$\(dirname "\$0"\)\/\.\.\/([^/"]+)\/([^/"]+)"$/m.exec(text);
  if (base) replay(path.join(EVALS, base[1]), dir);
  for (const [, file, , content] of text.matchAll(/^cat > (\S+) <<'(\w+)'\n([\s\S]*?)\n\2\n/gm)) write(dir, file, `${content}\n`);
  return dir;
}

const SKILL = { name: "Skill", input: { skill: "anneal:repo-docs" } };

// The README cases: one review that must change nothing, and one repair asked for without the
// word README. Both scaffold the same package, whose README plants what the checker reports.
describe("readme cases", () => {
  const { checkReadme } = require("../scripts/readme-check.js");
  const REVIEW = path.join(EVALS, "readme-review-reports-without-changes");
  const REPAIR = path.join(EVALS, "readme-repair-without-the-word");
  const CHECK = 'node "/plugins/anneal/scripts/readme-check.js" README.md';

  test("both cases are tagged readme, and the repair scaffold runs the review's", () => {
    for (const caseDir of [REVIEW, REPAIR]) assert.match(read(caseDir, "case.yaml"), /^tags: \[readme\]$/m);
    for (const caseDir of [REVIEW, REPAIR]) assert.deepStrictEqual(listRunFiles(replay(caseDir)).sort(), ["README.md", "bin/csv-tidy.js", "package.json"]);
  });

  test("the checker reports exactly what the fixture README plants", () => {
    const findings = checkReadme(read(replay(REVIEW), "README.md")).map(({ line, rule }) => `${line}:${rule}`);
    assert.deepStrictEqual(findings, ["1:badge-first", "5:filler", "5:filler", "9:no-shown-result", "10:prompt-in-copy-block", "15:fence-lang", "19:link-text"]);
  });

  describe("readme-review-reports-without-changes", () => {
    let checks;
    let run;
    before(() => {
      checks = graders(REVIEW);
      const reply = "Score 31/56. The badge sits above the title, before the description. The install block keeps a `$` prompt, so a copied command fails. Node 22 is never mentioned.";
      run = { dir: replay(REVIEW), calls: [SKILL, ...bash(CHECK)], reply, created: "" };
    });
    const failed = (changes) => failedGraders(checks, { ...run, ...changes });

    test("a run as the case asks passes every grader, and the plugin-only graders are indicators", () => {
      assert.deepStrictEqual(failed({}), []);
      assert.deepStrictEqual([checks["skill-fired"].arm, checks["checker-ran"].arm], ["with-only", "with-only"]);
      assert.deepStrictEqual(checks["no-files-created"], graders(AUDIT)["no-files-created"]);
    });

    test("a layout audit, an edited README, a created file or a reply that misses a planted problem fails its grader", () => {
      assert.deepStrictEqual(failed({ calls: [...run.calls, ...bash('node "/plugins/anneal/scripts/audit.js" --root .')] }), ["no-layout-audit"]);
      const edited = tempDir("anneal-graders-readme-edit-");
      fs.cpSync(run.dir, edited, { recursive: true });
      write(edited, "README.md", read(edited, "README.md").replace("$ npm", "npm"));
      assert.deepStrictEqual(failed({ dir: edited }), ["readme-unchanged"]);
      assert.deepStrictEqual(failed({ created: "README-review.md" }), ["no-files-created"]);
      assert.deepStrictEqual(failed({ reply: "Score 31/56. Node 22 is never mentioned." }), ["names-badge-order", "names-copy-prompt"]);
      assert.deepStrictEqual(failed({ calls: bash("cat README.md") }), ["checker-ran", "skill-fired"]);
    });
  });

  describe("readme-repair-without-the-word", () => {
    const README_GRADERS = ["badge-after-description", "no-click-here", "no-copy-prompt", "node-before-install"];
    const FIXED = [
      "# csv-tidy",
      "",
      "csv-tidy removes empty rows from CSV files on the command line, so an export loads without hand-editing.",
      "",
      "[![License](https://example.com/badges/license-MIT.svg)](LICENSE)",
      "",
      "## Install",
      "",
      "Requires Node 22 or later.",
      "",
      "```bash",
      "npm install -g csv-tidy",
      "```",
      "",
      "## Quick start",
      "",
      "```bash",
      "csv-tidy input.csv --output clean.csv",
      "```",
      "",
      "Expected output:",
      "",
      "```text",
      "$ csv-tidy input.csv --output clean.csv",
      "Removed 2 empty rows",
      "Wrote clean.csv",
      "```",
      "",
      "Every option is in the [csv-tidy documentation](https://example.com/docs).",
      "",
    ].join("\n");
    let checks;
    let run;
    before(() => {
      checks = graders(REPAIR);
      run = { dir: replay(REPAIR), calls: [SKILL, ...bash(CHECK)], reply: "", created: "" };
    });
    const failed = (changes) => failedGraders(checks, { ...run, ...changes });

    test("the fixture README fails each README grader, and the shared graders are the review case's", () => {
      assert.deepStrictEqual(failed({}), README_GRADERS);
      for (const name of ["skill-fired", "checker-ran", "no-files-created"]) assert.deepStrictEqual(checks[name], graders(REVIEW)[name], name);
    });

    test("a repaired README passes every grader and the checker", () => {
      const fixed = tempDir("anneal-graders-readme-fixed-");
      fs.cpSync(run.dir, fixed, { recursive: true });
      write(fixed, "README.md", FIXED);
      assert.deepStrictEqual(checkReadme(FIXED), []);
      assert.deepStrictEqual(failed({ dir: fixed }), []);
      assert.deepStrictEqual(failed({ dir: fixed, created: "LICENSE" }), ["no-files-created"]);
    });

    test("the Node requirement passes in each common wording", () => {
      for (const wording of ["Requires Node.js v22 or later.", "Needs Node v22+", "Needs Node.js >= 22."]) {
        const dir = tempDir("anneal-graders-readme-wording-");
        write(dir, "README.md", FIXED.replace("Requires Node 22 or later.", wording));
        assert.strictEqual(passes(checks["node-before-install"], { dir }), true, wording);
      }
    });

    test("each README grader fails the one repair it exists for", () => {
      const variants = {
        "badge-after-description": FIXED.replace("# csv-tidy\n\n", "[![CI](ci.svg)](ci)\n# csv-tidy\n\n"),
        "no-click-here": FIXED.replace("the [csv-tidy documentation]", "[click here]"),
        "no-copy-prompt": FIXED.replace("```bash\nnpm install", "```bash\n$ npm install"),
        "node-before-install": FIXED.replace("Requires Node 22 or later.\n\n", "").replace("## Quick start", "Requires Node 22 or later.\n\n## Quick start"),
      };
      for (const [grader, text] of Object.entries(variants)) {
        const dir = tempDir("anneal-graders-readme-variant-");
        write(dir, "README.md", text);
        assert.notStrictEqual(text, FIXED, grader);
        assert.strictEqual(passes(checks[grader], { dir }), false, grader);
      }
    });
  });
});

// The writing cases: a help page asked for without naming the skill, and a page review that must
// change nothing. Both scaffold the README cases' package; the review adds a planted help page.
describe("writing cases", () => {
  const README_REVIEW = path.join(EVALS, "readme-review-reports-without-changes");
  const REVIEW = path.join(EVALS, "writing-review-reports-without-changes");
  const WRITE = path.join(EVALS, "writing-page-without-the-word");
  const PAGE = "docs/remove-empty-rows.md";
  const WRITING_READ = { name: "Read", input: { file_path: "/plugins/anneal/skills/repo-docs/references/writing.md" } };

  test("both cases are tagged writing, and only the review scaffold plants the page", () => {
    for (const caseDir of [REVIEW, WRITE]) assert.match(read(caseDir, "case.yaml"), /^tags: \[writing\]$/m);
    assert.deepStrictEqual(listRunFiles(replay(REVIEW)).sort(), ["README.md", "bin/csv-tidy.js", PAGE, "package.json"]);
    assert.deepStrictEqual(listRunFiles(replay(WRITE)).sort(), ["README.md", "bin/csv-tidy.js", "package.json"]);
  });

  describe("writing-review-reports-without-changes", () => {
    let checks;
    let run;
    before(() => {
      checks = graders(REVIEW);
      const reply = "The steps are bullets, not numbered. The note that --output overwrites the file comes after the command; put it before the step. 'Simply' and 'easy' add nothing, and the link says click here.";
      run = { dir: replay(REVIEW), calls: [SKILL, WRITING_READ], reply, created: "" };
    });
    const failed = (changes) => failedGraders(checks, { ...run, ...changes });

    test("a run as the case asks passes every grader, and the shared graders are the README review's", () => {
      assert.deepStrictEqual(failed({}), []);
      assert.deepStrictEqual([checks["skill-fired"].arm, checks["writing-read"].arm], ["with-only", "with-only"]);
      for (const name of ["skill-fired", "no-files-created", "no-layout-audit"]) assert.deepStrictEqual(checks[name], graders(README_REVIEW)[name], name);
    });

    test("a layout audit, an edited page, a created file, a reply that misses a planted problem or no skill fails its grader", () => {
      assert.deepStrictEqual(failed({ calls: [...run.calls, ...bash('node "/plugins/anneal/scripts/audit.js" --root .')] }), ["no-layout-audit"]);
      const edited = tempDir("anneal-graders-writing-edit-");
      fs.cpSync(run.dir, edited, { recursive: true });
      write(edited, PAGE, read(edited, PAGE).replace("Simply ", ""));
      assert.deepStrictEqual(failed({ dir: edited }), ["page-unchanged"]);
      assert.deepStrictEqual(failed({ created: "review.md" }), ["no-files-created"]);
      assert.deepStrictEqual(failed({ reply: "The title is vague." }), ["names-overwrite-order", "names-unnumbered-steps"]);
      assert.deepStrictEqual(failed({ reply: run.reply.replace("bullets, not numbered", "unnumbered bullets") }), []);
      assert.deepStrictEqual(failed({ reply: run.reply.replace("The steps are bullets, not numbered.", "It shows the number of rows.") }), ["names-unnumbered-steps"]);
      assert.deepStrictEqual(failed({ calls: bash(`cat ${PAGE}`) }), ["skill-fired", "writing-read"]);
    });

    test("the two reply graders pass other ways to name each planted defect, and fail a reply that names neither", () => {
      for (const reply of [
        "Number the steps.",
        "Use an ordered list for the steps.",
        "The steps aren't numbered.",
        "The bullets should be a numbered list.",
        "Numbered steps would make the order clear.",
        "The steps aren’t numbered.",
        "**Steps are bullets.** Readers need numbered steps to follow the order.",
        "The steps have no numbers.",
        "Number each step.",
        "Use an ordered list.",
      ]) assert.strictEqual(passes(checks["names-unnumbered-steps"], { reply }), true, reply);
      for (const reply of [
        "The overwrite warning comes after the command; move it before the Run step.",
        "Warn that --output overwrites the file above the command that runs it.",
        "The overwrite note comes too late.",
        "### Overwrite warning\nMove it before the command.",
        "The overwrite warning sits below the command.",
        "Move the overwrite warning so it comes first.",
        "The warning about overwriting appears after the reader has already run the command.",
        "Put the overwrite warning before step 2.",
      ]) assert.strictEqual(passes(checks["names-overwrite-order"], { reply }), true, reply);
      const missed = "Findings, numbered by severity: --output overwrites export.csv. Before you publish, fix the title.";
      assert.deepStrictEqual(failed({ reply: missed }), ["names-overwrite-order", "names-unnumbered-steps"]);
      for (const reply of [
        "The page says this overwrites the file you name after --output.",
        "As noted above, the --output flag overwrites files.",
      ]) assert.strictEqual(passes(checks["names-overwrite-order"], { reply }), false, reply);
      const count = "There is no number showing how many rows were removed.";
      assert.strictEqual(passes(checks["names-unnumbered-steps"], { reply: count }), false);
    });
  });

  describe("writing-page-without-the-word", () => {
    const PAGE_GRADERS = ["no-click-here", "no-filler", "node-before-install", "numbered-steps", "shows-result"];
    const FIXED = [
      "# Remove empty rows from a CSV export",
      "",
      "csv-tidy deletes the empty rows from a CSV file and writes the rest to a new file.",
      "",
      "You need Node 22 or later.",
      "",
      "1. Install csv-tidy:",
      "",
      "   ```bash",
      "   npm install -g csv-tidy",
      "   ```",
      "",
      "2. Clean your export:",
      "",
      "   ```bash",
      "   csv-tidy export.csv --output clean.csv",
      "   ```",
      "",
      "   When it worked, you see:",
      "",
      "   ```text",
      "   Removed 2 empty rows",
      "   Wrote clean.csv",
      "   ```",
      "",
      "Every option is in the [csv-tidy documentation](https://example.com/docs).",
      "",
    ].join("\n");
    let checks;
    let run;
    before(() => {
      checks = graders(WRITE);
      run = { dir: replay(WRITE), calls: [SKILL, WRITING_READ], reply: "", created: "" };
    });
    const failed = (changes) => failedGraders(checks, { ...run, ...changes });

    test("with no page written, every page grader fails and the rest pass", () => {
      assert.deepStrictEqual(failed({}), PAGE_GRADERS);
      assert.deepStrictEqual(checks["skill-fired"], graders(README_REVIEW)["skill-fired"]);
      assert.strictEqual(checks["writing-read"].arm, "with-only");
    });

    test("a written page passes every grader, and another created file fails only-the-page", () => {
      const fixed = tempDir("anneal-graders-writing-fixed-");
      fs.cpSync(run.dir, fixed, { recursive: true });
      write(fixed, PAGE, FIXED);
      assert.deepStrictEqual(failed({ dir: fixed, created: PAGE }), []);
      assert.deepStrictEqual(failed({ dir: fixed, created: `LICENSE\n${PAGE}` }), ["only-the-page"]);
    });

    test("an edit to a scaffold file fails the grader that pins it", () => {
      const pins = { "README.md": "readme-unchanged", "package.json": "package-unchanged", "bin/csv-tidy.js": "cli-unchanged" };
      for (const [file, grader] of Object.entries(pins)) {
        const edited = tempDir("anneal-graders-writing-pin-");
        fs.cpSync(run.dir, edited, { recursive: true });
        write(edited, PAGE, FIXED);
        write(edited, file, `${read(edited, file)}\nSee [Remove empty rows](${PAGE}).\n`);
        assert.deepStrictEqual(failed({ dir: edited, created: PAGE }), [grader], file);
      }
    });

    test("each page grader passes the variants a correct page may take", () => {
      const variants = [
        FIXED.replace("   Removed 2 empty rows\n", "   Removed <n> empty rows\n"),
        FIXED.replace("   Removed 2 empty rows\n", "   Removed N empty rows\n"),
        FIXED.replace("1. Install csv-tidy:\n\n   ```bash\n   npm install -g csv-tidy\n   ```\n", "1. Install csv-tidy as its [install steps](../README.md#install) describe.\n"),
        FIXED.replace("Clean your export:", "Clean the export you just downloaded:"),
        FIXED.replace("Clean your export:", "Clean your export just before you open it:"),
        FIXED.replace("   When it worked, you see:", "   An empty row is easy to miss, so check the count. When it worked, you see:"),
      ];
      for (const text of variants) {
        const dir = tempDir("anneal-graders-writing-pass-");
        write(dir, PAGE, text);
        assert.notStrictEqual(text, FIXED);
        assert.deepStrictEqual(failedGraders(Object.fromEntries(PAGE_GRADERS.map((name) => [name, checks[name]])), { dir }), [], text);
      }
    });

    test("no-filler fails filler 'just' and node-before-install fails an install step written before Node 22", () => {
      for (const text of ["1. Then you just run csv-tidy.", "You just need Node 22.", "It's just as simple as that."]) {
        const dir = tempDir("anneal-graders-writing-just-");
        write(dir, PAGE, FIXED.replace("Clean your export:", `${text} Clean your export:`));
        assert.strictEqual(passes(checks["no-filler"], { dir }), false, text);
      }
      for (const text of ["1. Install csv-tidy as the README describes.\n2. You need Node 22.\n", "You need Node 22.\n"]) {
        const dir = tempDir("anneal-graders-writing-order-");
        write(dir, PAGE, text);
        assert.strictEqual(passes(checks["node-before-install"], { dir }), false, text);
      }
    });

    test("no-click-here fails every vague label, inline or by reference", () => {
      for (const link of ["[learn more](https://example.com/docs)", "[Read this](https://example.com/docs)", "[read more](https://example.com/docs)", "[here][docs]", "[click here][]", "[here]\n\n[here]: https://example.com/docs"]) {
        const dir = tempDir("anneal-graders-writing-link-");
        write(dir, PAGE, FIXED.replace("the [csv-tidy documentation](https://example.com/docs)", link));
        assert.strictEqual(passes(checks["no-click-here"], { dir }), false, link);
      }
    });

    test("each page grader fails the one fault it exists for", () => {
      const variants = {
        "no-filler": FIXED.replace("Clean your export:", "Simply clean your export:"),
        "no-click-here": FIXED.replace("the [csv-tidy documentation]", "[click here]"),
        "numbered-steps": FIXED.replace("1. Install", "- Install").replace("2. Clean", "- Clean"),
        "node-before-install": FIXED.replace("You need Node 22 or later.\n\n", "").replace("   npm install -g csv-tidy\n   ```\n", "   npm install -g csv-tidy\n   ```\n\n   You need Node 22 or later.\n"),
        "shows-result": FIXED.replace("   Removed 2 empty rows\n", ""),
      };
      for (const [grader, text] of Object.entries(variants)) {
        const dir = tempDir("anneal-graders-writing-variant-");
        write(dir, PAGE, text);
        assert.notStrictEqual(text, FIXED, grader);
        assert.strictEqual(passes(checks[grader], { dir }), false, grader);
        assert.deepStrictEqual(failedGraders(Object.fromEntries(PAGE_GRADERS.map((name) => [name, checks[name]])), { dir }), [grader], grader);
      }
    });
  });
});
