"use strict";

// The repeated-step search on synthetic Claude Code transcripts and Codex rollouts in temporary Git repositories:
// which sessions it reads, how it normalizes steps, each kind of finding, its exit codes, and that the hooks it reads
// the calls through leave session-evidence's own output unchanged.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { tempDir, transcript, at, human, use, result, say, meta, started, turn, message, call, output, fn } = require("./session-transcripts.js");
const { analyzeClaude } = require("../scripts/session-evidence-claude.js");
const { analyzeCodex } = require("../scripts/session-evidence-codex.js");
const { normalizer, promptKey, codexCommand, argument } = require("../scripts/session-repeats.js");
const { excerpt } = require("../scripts/session-evidence-redaction.js");

const CLI = path.join(__dirname, "..", "scripts", "session-repeats.js");

// GIT_CONFIG_NOSYSTEM drops the system core.longpaths that Git for Windows sets, so the isolated global config restores
// it; the script's own Git queries, in a child process, read the same config.
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(tempDir(), "config");
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[core]\n\tlongpaths = true\n");
const git = (dir, ...args) => execFileSync("git", [
  "-c", "core.longpaths=true", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args,
], { cwd: dir, stdio: "pipe", encoding: "utf8" });

// The script never reads this run's own session, nor a host home the test did not hand it.
const ENV = { ...process.env };
for (const name of ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete ENV[name];
const EMPTY = tempDir();

function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI, "--claude-home", EMPTY, "--codex-home", EMPTY, ...args], { encoding: "utf8", env: { ...ENV, ...env } });
}

function repeats(args, env) {
  const ran = run(args, env);
  assert.strictEqual(ran.status, 0, ran.stderr);
  return JSON.parse(ran.stdout);
}

// A Git repository named shop, at the path Git reports for it.
function shop({ files = {} } = {}) {
  const dir = path.join(tempDir(), "shop");
  fs.mkdirSync(dir);
  git(dir, "init", "-q");
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return path.resolve(git(dir, "rev-parse", "--show-toplevel").trim());
}

const ids = ["0a1b2c3d-0000-4000-8000-000000000001", "0a1b2c3d-0000-4000-8000-000000000002", "0a1b2c3d-0000-4000-8000-000000000003",
  "0a1b2c3d-0000-4000-8000-000000000004"];

// One Claude Code session in `root`: a typed prompt, then each step as a call and its result, in order. A step is a
// shell command, or [tool, input] for any other tool.
function claude(dir, root, index, steps, { prompt = `Task ${index}.`, rows = [] } = {}) {
  const id = ids[index];
  const lines = [{ ...human(prompt, 1), cwd: root, sessionId: id }];
  steps.forEach((step, n) => {
    const [tool, input] = typeof step === "string" ? ["Bash", { command: step }] : step;
    lines.push(use(`t${index}-${n}`, tool, input, 2 + n * 2), result(`t${index}-${n}`, "ok", 3 + n * 2));
  });
  lines.push(...rows, say(`end-${index}`, "Done.", 50));
  return transcript(lines, { dir, name: `${id}.jsonl` });
}

const commands = (out) => out.findings.commands.map((finding) => [finding.step, finding.sessions]);

describe("which sessions count", () => {
  test("a command in 3 of 3 sessions is one finding; in 2 it needs --min-sessions 2", () => {
    const root = shop();
    const three = tempDir();
    for (const index of [0, 1, 2]) claude(three, root, index, ["npm test"]);
    const out = repeats(["--root", root, "--sessions-dir", three]);
    assert.deepStrictEqual(commands(out), [["npm test", 3]]);
    assert.deepStrictEqual(out.sessionsRead, { claude: 3, codex: 0, subagentTranscripts: 0 });
    assert.deepStrictEqual(out.dates, { first: at(1), last: at(1) });
    assert.strictEqual(out.findings.commands[0].occurrences, 3);
    assert.strictEqual(out.findings.commands[0].examples.length, 3);
    const two = tempDir();
    for (const index of [0, 1]) claude(two, root, index, ["npm test"]);
    assert.deepStrictEqual(commands(repeats(["--root", root, "--sessions-dir", two])), []);
    assert.deepStrictEqual(commands(repeats(["--root", root, "--sessions-dir", two, "--min-sessions", "2"])), [["npm test", 2]]);
  });

  test("a navigation candidate that may call for a change is one finding when several sessions share it", () => {
    const root = shop();
    const dir = tempDir();
    const wide = "x".repeat(20000);
    for (const index of [0, 1, 2]) {
      claude(dir, root, index, [], { rows: [
        use(`g${index}`, "Grep", { pattern: "cart" }, 10, { uuid: `call-g${index}` }), result(`g${index}`, wide, 11),
        // Version control prints a lot too, and its scope asks for no change.
        use(`l${index}`, "Bash", { command: "git log" }, 12), result(`l${index}`, wide, 13),
      ] });
    }
    // A resumed session copies the first one's records, with their uuids.
    fs.copyFileSync(path.join(dir, `${ids[0]}.jsonl`), path.join(dir, `${ids[3]}.jsonl`));
    const out = repeats(["--root", root, "--sessions-dir", dir]);
    assert.deepStrictEqual(out.findings.navigation.map((f) => [f.navigationKind, f.candidateCause, f.scope, f.sessions, f.occurrences, f.examples.length]),
      [["large-output", "broad-search", "layout", 3, 3, 3]]);
    assert.match(out.findings.navigation[0].step, /cart/);
    assert.strictEqual(out.navigationCounts["large-output"], 8, "every candidate is counted, the copies and the ones that ask for no change too");
    assert.deepStrictEqual(repeats(["--root", root, "--sessions-dir", dir, "--min-sessions", "4"]).findings.navigation, []);
  });

  test("the running session is skipped; an unreadable one is reported while the others count; a journal is never read", () => {
    const root = shop();
    const dir = tempDir();
    for (const index of [0, 1, 2, 3]) claude(dir, root, index, ["npm test"]);
    fs.writeFileSync(path.join(dir, "0a1b2c3d-0000-4000-8000-0000000000ff.jsonl"), "{not json\n");
    fs.writeFileSync(path.join(dir, "journal.jsonl"), "{not json\n");
    const out = repeats(["--root", root, "--sessions-dir", dir], { CLAUDE_CODE_SESSION_ID: ids[3] });
    assert.deepStrictEqual(commands(out), [["npm test", 3]]);
    assert.deepStrictEqual(out.skipped.map((skip) => [path.basename(skip.sessionFile), skip.reason]).sort(), [
      [`${ids[3]}.jsonl`, "running-session"], ["0a1b2c3d-0000-4000-8000-0000000000ff.jsonl", "unreadable"],
    ]);
    assert.match(out.skipped.find((skip) => skip.reason === "unreadable").message, /Invalid JSON record at line 1/);
  });

  test("a subagent transcript counts toward its parent session, in inSubagents", () => {
    const root = shop();
    const dir = tempDir();
    for (const index of [0, 1]) claude(dir, root, index, ["npm test"]);
    const parent = claude(dir, root, 2, []);
    const agent = { isSidechain: true, agentId: "a1" };
    transcript([
      { type: "user", ...agent, cwd: root, timestamp: at(1), message: { role: "user", content: "Run the suite." } },
      { ...use("s1", "Bash", { command: "npm test" }, 2), ...agent }, { ...result("s1", "ok", 3), ...agent },
    ], { dir: path.join(dir, path.basename(parent, ".jsonl"), "subagents", "workflows", "w1"), name: "agent-a1.jsonl" });
    const out = repeats(["--root", root, "--sessions-dir", dir]);
    assert.deepStrictEqual(out.sessionsRead, { claude: 3, codex: 0, subagentTranscripts: 1 });
    assert.deepStrictEqual(commands(out), [["npm test", 3]]);
    assert.strictEqual(out.findings.commands[0].inSubagents, 1);
    assert.deepStrictEqual(out.findings.prompts, [], "a subagent's task is no owner prompt");
  });

  test("a session whose main transcript cannot be read counts none of its subagent transcripts", () => {
    const root = shop();
    const dir = tempDir();
    for (const index of [0, 1]) claude(dir, root, index, ["npm test"]);
    // The first record is whole, so the host is known; the parser refuses the second.
    const broken = transcript([{ ...human("Task 2.", 1), cwd: root, sessionId: ids[2] }], { dir, name: `${ids[2]}.jsonl`, tail: "{not json\n{}\n" });
    const agent = { isSidechain: true, agentId: "a1" };
    transcript([{ ...use("s1", "Bash", { command: "npm test" }, 2), ...agent }, { ...result("s1", "ok", 3), ...agent }],
      { dir: path.join(dir, ids[2], "subagents"), name: "agent-a1.jsonl" });
    const out = repeats(["--root", root, "--sessions-dir", dir, "--min-sessions", "2"]);
    assert.deepStrictEqual(out.sessionsRead, { claude: 2, codex: 0, subagentTranscripts: 0 });
    assert.deepStrictEqual(out.findings.commands.map((finding) => [finding.step, finding.sessions, finding.inSubagents]), [["npm test", 2, 0]]);
    assert.deepStrictEqual(out.skipped.map((skip) => [path.basename(skip.sessionFile), skip.reason]), [[path.basename(broken), "unreadable"]]);
    // With only that session, nothing is read.
    const alone = tempDir();
    fs.cpSync(dir, alone, { recursive: true, filter: (from) => !path.basename(from).startsWith(ids[0]) && !path.basename(from).startsWith(ids[1]) });
    const none = run(["--root", root, "--sessions-dir", alone]);
    assert.strictEqual(none.status, 2, none.stdout);
    assert.match(none.stderr, /no session found to read/);
  });

  test("a record another transcript already holds, as a resumed session copies it, counts once, toward the first session read", () => {
    const root = shop();
    const dir = tempDir();
    const first = [{ ...human("Run the checks.", 1), cwd: root, uuid: "r1" }, { ...use("a1", "Bash", { command: "npm test" }, 2), uuid: "r2" },
      { ...result("a1", "ok", 3), uuid: "r3" }];
    transcript(first, { dir, name: `${ids[0]}.jsonl` });
    transcript([...first, { ...human("Now the status.", 10), cwd: root, uuid: "r4" }, { ...use("b1", "Bash", { command: "git status" }, 11), uuid: "r5" },
      { ...result("b1", "ok", 12), uuid: "r6" }], { dir, name: `${ids[1]}.jsonl` });
    const out = repeats(["--root", root, "--sessions-dir", dir, "--min-sessions", "2"]);
    assert.deepStrictEqual(out.sessionsRead, { claude: 2, codex: 0, subagentTranscripts: 0 });
    assert.deepStrictEqual([out.findings.commands, out.findings.prompts], [[], []]);
    // A session of its own that runs the same command and types the same prompt still counts.
    claude(dir, root, 2, ["npm test"], { prompt: "Run the checks." });
    const three = repeats(["--root", root, "--sessions-dir", dir, "--min-sessions", "2"]);
    assert.deepStrictEqual(three.findings.commands.map((finding) => [finding.step, finding.sessions, finding.occurrences]), [["npm test", 2, 2]]);
    assert.deepStrictEqual(three.findings.prompts.map((finding) => [finding.step, finding.sessions, finding.occurrences]), [["run the checks", 2, 2]]);
  });

  test("discovery reads the root's and a worktree's project folders and Codex rollouts whose session_meta cwd is the root", () => {
    const root = shop({ files: { "README.md": "# shop\n" } });
    git(root, "add", ".");
    git(root, "commit", "-qm", "initial");
    const worktree = path.join(path.dirname(root), "shop-wt");
    git(root, "worktree", "add", "-q", "-b", "wt", worktree);
    const home = tempDir();
    const key = (dir) => path.resolve(git(dir, "rev-parse", "--show-toplevel").trim()).replace(/[^A-Za-z0-9]/g, "-");
    const projects = path.join(home, "claude", "projects");
    claude(path.join(projects, key(root)), root, 0, ["npm test"]);
    claude(path.join(projects, key(worktree)), worktree, 1, ["npm test"]);
    claude(path.join(projects, `${key(root)}-other`), root, 2, ["npm test"]);
    // A session folder's nested transcript other than a subagent's is not read as a session.
    claude(path.join(projects, key(root), "nested"), root, 3, ["npm test"]);
    const rollout = (cwd, name) => transcript([
      { ...meta, payload: { ...meta.payload, cwd } }, started(1), { ...turn(2), payload: { ...turn(2).payload, cwd } },
      call("c1", "npm test", 3), output("c1", ["Process exited with code 0"], 4),
    ], { dir: path.join(home, "codex", "sessions", "2026", "01", "01"), name });
    rollout(root, "rollout-2026-01-01T00-00-00-0a1b2c3d-0000-4000-8000-0000000000c1.jsonl");
    rollout(path.join(path.dirname(root), "elsewhere"), "rollout-2026-01-01T00-00-00-0a1b2c3d-0000-4000-8000-0000000000c2.jsonl");
    const ran = spawnSync(process.execPath, [CLI, "--root", root, "--claude-home", path.join(home, "claude"), "--codex-home", path.join(home, "codex"),
      "--min-sessions", "2"], { encoding: "utf8", env: ENV });
    assert.strictEqual(ran.status, 0, ran.stderr);
    const out = JSON.parse(ran.stdout);
    assert.deepStrictEqual(out.sessionsRead, { claude: 2, codex: 1, subagentTranscripts: 0 });
    assert.deepStrictEqual(commands(out), [["npm test", 3]]);
  });
});

describe("normalized steps", () => {
  test("whitespace, the root in either slash style, ids and temporary paths collapse to one key", () => {
    const root = path.resolve("/work/shop");
    const normalize = normalizer([root]);
    const forward = root.replace(/\\/g, "/");
    const variants = [
      `node   scripts/check.js  "${forward}" --run 0a1b2c3d-0000-4000-8000-00000000abcd > /tmp/run-1/out.txt`,
      `node scripts/check.js "${forward.replace(/\//g, "\\")}" --run 1b2c3d4e-0000-4000-8000-00000000abcd >  /tmp/run-2/out.txt`,
      `cd "${forward}" && node scripts/check.js "." --run deadbeef1 > /var/tmp/x/out.txt`,
    ];
    assert.deepStrictEqual([...new Set(variants.map(normalize))], ['node scripts/check.js "." --run <id> > <temp>/out.txt']);
    assert.strictEqual(normalize(`cat ${forward}/src/cart.js`), "cat ./src/cart.js");
    assert.strictEqual(normalize(`git -C "${forward}" status --short`), "git status --short");
    assert.strictEqual(normalize("npm test 1234567"), "npm test 1234567", "a number is no id");
  });

  test("a redirect to a temporary path keeps its operator, so it never shares a key with that path as an argument", () => {
    const normalize = normalizer([path.resolve("/work/shop")]);
    assert.strictEqual(normalize("npm test 2>/tmp/run-1/err.txt"), "npm test 2><temp>/err.txt");
    assert.strictEqual(normalize("npm test >/tmp/run-1/out.txt <C:/Temp/in.txt"), "npm test ><temp>/out.txt <<temp>/in.txt");
    assert.strictEqual(normalize("npm test /tmp/run-1/err.txt"), "npm test <temp>/err.txt");
    // The account placeholder the redaction writes inside a path leaves the path whole.
    assert.strictEqual(normalize("cat /mnt/c/Users/<user>/AppData/Local/Temp/run/in.txt"), "cat <temp>/in.txt");
  });

  test("one command run from two folders of the repository is two steps, each keyed with its folder from the root", () => {
    const root = shop();
    const dir = tempDir();
    for (const index of [0, 1, 2]) {
      claude(dir, root, index, [], {
        rows: [{ ...use(`a${index}`, "Bash", { command: "node --test" }, 20), cwd: path.join(root, "anneal") }, result(`a${index}`, "ok", 21),
          { ...use(`c${index}`, "Bash", { command: "node --test" }, 22), cwd: path.join(root, "collet") }, result(`c${index}`, "ok", 23),
          { ...use(`r${index}`, "Bash", { command: "node --test" }, 24), cwd: root }, result(`r${index}`, "ok", 25),
          { ...use(`o${index}`, "Bash", { command: "node --test" }, 26), cwd: "/elsewhere/shop" }, result(`o${index}`, "ok", 27)],
      });
    }
    const out = repeats(["--root", root, "--sessions-dir", dir]);
    assert.deepStrictEqual(commands(out), [["node --test", 3], ["cd anneal && node --test", 3], ["cd collet && node --test", 3]]);
    assert.strictEqual(out.findings.commands[0].occurrences, 6, "a folder outside the repository adds nothing");
    // On Codex the folder is the call's workdir, absolute or relative to the turn's cwd.
    const rollouts = tempDir();
    for (const index of [0, 1, 2]) {
      transcript([
        { ...meta, payload: { id: `thread-${index}`, cwd: root } }, started(1), { ...turn(2), payload: { ...turn(2).payload, cwd: root } },
        fn(`w${index}`, "exec_command", { cmd: "node --test", workdir: index ? "anneal" : path.join(root, "anneal") }, 3), output(`w${index}`, ["ok"], 4),
      ], { dir: rollouts, name: `rollout-2026-01-01T00-00-0${index}-${ids[index]}.jsonl` });
    }
    assert.deepStrictEqual(commands(repeats(["--root", root, "--sessions-dir", rollouts])), [["cd anneal && node --test", 3]]);
  });

  test("Edit and Write are no steps; a read of the same path in 3 sessions is a lookup with a root-relative path", () => {
    const root = shop();
    const dir = tempDir();
    const file = path.join(root, "src", "cart.js");
    for (const index of [0, 1, 2]) {
      claude(dir, root, index, [["Read", { file_path: file }], ["Edit", { file_path: file, old_string: "a", new_string: "b" }],
        ["Write", { file_path: path.join(root, "notes.md"), content: "x" }]]);
    }
    const out = repeats(["--root", root, "--sessions-dir", dir]);
    assert.deepStrictEqual(out.findings.lookups.map((finding) => [finding.step, finding.sessions, finding.namedInMap]), [["read src/cart.js", 3, false]]);
    assert.deepStrictEqual(out.findings.commands, []);
    assert.deepStrictEqual(out.findings.sequences, []);
  });

  test("two commands in a row by one actor for one prompt are a sequence; split across prompts or actors they are not", () => {
    const root = shop();
    const together = tempDir();
    for (const index of [0, 1, 2]) claude(together, root, index, ["npm test", "git status --short --ignored"]);
    const out = repeats(["--root", root, "--sessions-dir", together]);
    assert.deepStrictEqual(out.findings.sequences.map((finding) => [finding.step, finding.sessions]), [["npm test -> git status --short --ignored", 3]]);
    const apart = tempDir();
    for (const index of [0, 1, 2]) {
      const agent = { isSidechain: true, agentId: "a1" };
      claude(apart, root, index, ["npm test"], {
        rows: index === 0
          ? [{ ...human("Now the status.", 30), cwd: root }, use("p2", "Bash", { command: "git status --short --ignored" }, 31), result("p2", "ok", 32)]
          : [{ ...use(`s${index}`, "Bash", { command: "git status --short --ignored" }, 31), ...agent }, { ...result(`s${index}`, "ok", 32), ...agent }],
      });
    }
    const split = repeats(["--root", root, "--sessions-dir", apart]);
    assert.deepStrictEqual(split.findings.sequences, []);
    assert.deepStrictEqual(commands(split), [["git status --short --ignored", 3], ["npm test", 3]]);
  });
});

describe("prompts", () => {
  test("the same typed prompt in 3 sessions is a finding; injected text and host notices are not", () => {
    const root = shop();
    const dir = tempDir();
    const injected = [{ type: "user", isMeta: true, cwd: root, timestamp: at(40), message: { role: "user", content: "Caveat from the host." } },
      { ...human("<system-reminder>Notice.</system-reminder>", 41), cwd: root }];
    for (const index of [0, 1, 2]) claude(dir, root, index, [], { prompt: ["Run the checks.", "run the  checks", "Run the checks!"][index], rows: injected });
    const out = repeats(["--root", root, "--sessions-dir", dir]);
    assert.deepStrictEqual(out.findings.prompts.map((finding) => [finding.step, finding.sessions, finding.repositories]), [["run the checks", 3, 1]]);
  });

  test("a slash command is keyed by its name", () => {
    assert.strictEqual(promptKey("<command-message>shop:check</command-message>\n<command-name>/shop:check</command-name>\n<command-args>now</command-args>"), "/shop:check");
    assert.strictEqual(promptKey("/shop:check all of it"), "/shop:check");
  });

  test("a prompt that starts with an absolute path is keyed whole, as one that starts with the home is", () => {
    assert.strictEqual(promptKey("/var/log/app.txt explain this."), "/var/log/app.txt explain this");
    assert.notStrictEqual(promptKey("/var/log/app.txt explain this"), promptKey("/var/log/app.txt delete it"));
  });

  test("redaction's markers keep their case in a prompt's key", () => {
    assert.strictEqual(promptKey("Use Password=Hunter22 Now"), "use password=[REDACTED] now");
    assert.strictEqual(promptKey(`Fix${String.fromCodePoint(0x200b)}It`), "fix<U+200B>it");
    // A secret that redaction matches only once it is lower cased is redacted in the key too.
    assert.strictEqual(promptKey("Use SK-ABCDEFGHIJKLMNOPQRSTUV now"), "use [REDACTED] now");
  });

  test("a prompt is redacted before it is lower cased, so a POSIX home and its account name never reach the key", () => {
    // The home and the user name are read when the script loads, so this home gets a process of its own.
    const script = `const os = require("node:os"); os.homedir = () => "/Users/Alice"; os.userInfo = () => ({ username: "Alice" });`
      + `process.stdout.write(JSON.stringify(["Read /Users/Alice/shop/notes.md", "Copy /Volumes/Backup/Alice/notes.md",`
      + `"/Alice:deploy now", "<command-name>/Alice:deploy</command-name>", "<command-name>/Users/Alice/x</command-name>"]`
      + `.map(require(${JSON.stringify(CLI)}).promptKey)));`;
    const done = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    assert.strictEqual(done.status, 0, done.stderr);
    assert.deepStrictEqual(JSON.parse(done.stdout),
      ["read ~/shop/notes.md", "copy /volumes/backup/<user>/notes.md", "/<user>:deploy", "/<user>:deploy", "~/x"]);
  });

  test("with --also-root, another repository's sessions add to prompts only", () => {
    const root = shop();
    const other = shop();
    const home = tempDir();
    const dir = tempDir();
    for (const index of [0, 1]) claude(dir, root, index, [], { prompt: "Run the checks." });
    const key = other.replace(/[^A-Za-z0-9]/g, "-");
    claude(path.join(home, "projects", key), other, 2, ["npm test", "npm test"], { prompt: "Run the checks." });
    claude(path.join(home, "projects", key), other, 3, ["npm test"], { prompt: "Something else." });
    const ran = spawnSync(process.execPath, [CLI, "--root", root, "--sessions-dir", dir, "--also-root", other, "--claude-home", home, "--codex-home", EMPTY,
      "--min-sessions", "2"], { encoding: "utf8", env: ENV });
    assert.strictEqual(ran.status, 0, ran.stderr);
    const out = JSON.parse(ran.stdout);
    assert.deepStrictEqual(out.findings.prompts.map((finding) => [finding.step, finding.sessions, finding.repositories]), [["run the checks", 3, 2]]);
    assert.deepStrictEqual(out.findings.commands, []);
    assert.strictEqual(out.repositories.length, 2);
  });
});

describe("what the map and the manifest already hold", () => {
  test("namedInMap reads AGENTS.md or a CLAUDE.md that imports it; projectScript names the script a command runs or is", () => {
    const scripts = JSON.stringify({ scripts: { check: "node --test && git status --short --ignored", test: "node --test" } });
    const dir = tempDir();
    const steps = ["npm run check", "node --test && git status --short --ignored", "git status --short --ignored"];
    for (const [files, named] of [
      [{ "AGENTS.md": "# shop\n\n| `git status --short --ignored` | lists every file |\n" }, true],
      [{ "CLAUDE.md": "@AGENTS.md\n", "AGENTS.md": "# shop\n\nRun `git status   --short --ignored` last.\n" }, true],
      [{ "CLAUDE.md": "# shop\n" }, false],
    ]) {
      const root = shop({ files: { ...files, "package.json": scripts } });
      const sessions = path.join(dir, String(named), String(Object.keys(files).length));
      for (const index of [0, 1, 2]) claude(sessions, root, index, steps);
      const out = repeats(["--root", root, "--sessions-dir", sessions]);
      const byStep = Object.fromEntries(out.findings.commands.map((finding) => [finding.step, [finding.namedInMap, finding.projectScript]]));
      assert.deepStrictEqual(byStep, {
        "git status --short --ignored": [named, null], "npm run check": [false, "check"], "node --test && git status --short --ignored": [false, "check"],
      });
    }
  });

  test("namedInMap needs a whole code span, fenced line or link target, never a word or a longer command holding the step", () => {
    const root = shop({ files: {
      "AGENTS.md": "# shop\n\nRun `npm test:watch` or `git status --short --ignored`; the tools are listed below.\n\n```\nnode   --test\n```\n\n"
        + "The cart is [here](./src/cart.js#top).\n",
    } });
    const dir = tempDir();
    const steps = ["npm test", "git status", "ls", "node --test", ["Read", { file_path: path.join(root, "src", "cart.js") }],
      ["Read", { file_path: path.join(root, "src", "car.js") }]];
    for (const index of [0, 1, 2]) claude(dir, root, index, steps);
    const out = repeats(["--root", root, "--sessions-dir", dir]);
    const named = (kind) => Object.fromEntries(out.findings[kind].map((finding) => [finding.step, finding.namedInMap]));
    assert.deepStrictEqual(named("commands"), { "npm test": false, "git status": false, ls: false, "node --test": true });
    assert.deepStrictEqual(named("lookups"), { "read src/cart.js": true, "read src/car.js": false });
  });

  test("a command run from a folder is named by a row that holds the bare command and names that folder", () => {
    const root = shop({ files: { "AGENTS.md": "# shop\n\n| `node --test` from `anneal/` or ./collet | one suite |\n| `node --test` | Runs the app tests |\n\nThe `tools/` folder.\n" } });
    const dir = tempDir();
    for (const index of [0, 1, 2]) {
      claude(dir, root, index, [], {
        rows: ["anneal", "collet", "tools", "annealing", "app"].flatMap((folder, n) => [
          { ...use(`${folder}${index}`, "Bash", { command: "node --test" }, 20 + n * 2), cwd: path.join(root, folder) }, result(`${folder}${index}`, "ok", 21 + n * 2),
        ]),
      });
    }
    const out = repeats(["--root", root, "--sessions-dir", dir]);
    assert.deepStrictEqual(Object.fromEntries(out.findings.commands.map((finding) => [finding.step, finding.namedInMap])), {
      "cd anneal && node --test": true, "cd collet && node --test": true, "cd tools && node --test": false, "cd annealing && node --test": false,
      // A bare word in prose names no folder.
      "cd app && node --test": false,
    });
    const sequences = Object.fromEntries(out.findings.sequences.map((finding) => [finding.step, finding.namedInMap]));
    assert.strictEqual(sequences["cd anneal && node --test -> cd collet && node --test"], true);
    assert.strictEqual(sequences["cd collet && node --test -> cd tools && node --test"], false);
  });

  test("a command whose own text holds ' -> ' is matched against the map and the scripts whole", () => {
    const step = 'node x.js --arrow "a -> b"';
    const root = shop({ files: { "AGENTS.md": `# shop\n\nRun \`${step}\`.\n`, "package.json": JSON.stringify({ scripts: { arrow: step } }) } });
    const dir = tempDir();
    for (const index of [0, 1, 2]) claude(dir, root, index, [step]);
    const out = repeats(["--root", root, "--sessions-dir", dir]);
    assert.deepStrictEqual(out.findings.commands.map((finding) => [finding.step, finding.namedInMap, finding.projectScript]), [[step, true, "arrow"]]);
  });

  test("bun test is Bun's own runner, never the test script; bun run test and bun lint are scripts", () => {
    const root = shop({ files: { "package.json": JSON.stringify({ scripts: { test: "vitest", lint: "eslint ." } }) } });
    const dir = tempDir();
    for (const index of [0, 1, 2]) claude(dir, root, index, ["bun test", "bun run test", "bun lint"]);
    const out = repeats(["--root", root, "--sessions-dir", dir]);
    assert.deepStrictEqual(Object.fromEntries(out.findings.commands.map((finding) => [finding.step, finding.projectScript])),
      { "bun test": null, "bun run test": "test", "bun lint": "lint" });
  });

  test("a typed quoted folder that is no JSON string is no error", () => {
    const step = String.raw`cd "src\lib" && npm test`;
    const root = shop({ files: { "AGENTS.md": "# shop\n\n`npm test` from `src/`\n" } });
    const dir = tempDir();
    for (const index of [0, 1, 2]) claude(dir, root, index, [step]);
    const out = repeats(["--root", root, "--sessions-dir", dir]);
    assert.deepStrictEqual(out.findings.commands.map((finding) => [finding.step, finding.namedInMap]), [[step, false]]);
  });

  test("the map's spans and the scripts' text are normalized as steps are, temporary paths and the root included", () => {
    const check = "node scripts/check.js --out /tmp/check.txt";
    const dir = tempDir();
    const root = path.join(dir, "shop");
    fs.mkdirSync(root);
    git(root, "init", "-q");
    const top = path.resolve(git(root, "rev-parse", "--show-toplevel").trim());
    const forward = top.replace(/\\/g, "/");
    fs.writeFileSync(path.join(top, "AGENTS.md"), `# shop\n\nRun \`${check}\` or \`node "${forward}/scripts/lint.js"\`. The cart is \`${forward}/src/cart.js\`.\n`);
    fs.writeFileSync(path.join(top, "package.json"), JSON.stringify({ scripts: { "check:out": check } }));
    const sessions = tempDir();
    for (const index of [0, 1, 2]) {
      claude(sessions, top, index, [`node scripts/check.js --out /tmp/run-${index}/check.txt`, 'node "./scripts/lint.js"',
        ["Read", { file_path: path.join(top, "src", "cart.js") }]]);
    }
    const out = repeats(["--root", top, "--sessions-dir", sessions]);
    const byStep = Object.fromEntries(out.findings.commands.map((finding) => [finding.step, [finding.namedInMap, finding.projectScript]]));
    assert.deepStrictEqual(byStep, { "node scripts/check.js --out <temp>/check.txt": [true, "check:out"], 'node "./scripts/lint.js"': [true, null] });
    assert.deepStrictEqual(out.findings.lookups.map((finding) => [finding.step, finding.namedInMap]), [["read src/cart.js", true]]);
  });
});

describe("arguments the evidence cut", () => {
  test("a long Codex command or Grep pattern keeps its text up to the cut, marked as cut", () => {
    const long = `npm test -- ${"x".repeat(470)}`;
    const kept = (key) => `${long.slice(0, 480 - `{"${key}":"`.length)} [excerpt truncated]`;
    assert.strictEqual(codexCommand(excerpt(JSON.stringify({ cmd: long, workdir: "/r" }))), kept("cmd"));
    assert.strictEqual(codexCommand(excerpt(JSON.stringify({ cmd: "npm test", workdir: `/${"w".repeat(500)}` }))), "npm test");
    const shell = excerpt(JSON.stringify({ command: ["bash", "-lc", long] }));
    assert.strictEqual(codexCommand(shell), `${long.slice(0, 480 - '{"command":["bash","-lc","'.length)} [excerpt truncated]`);
    assert.strictEqual(argument(excerpt(JSON.stringify({ pattern: long, path: "/r" })), "pattern"), kept("pattern"));
    assert.strictEqual(codexCommand(excerpt(`*** Begin Patch\n${"x".repeat(500)}`)), null, "a cut patch is no command");
  });

  test("a listed step longer than the printed bound is printed cut, and warnings say so", () => {
    const root = shop();
    const dir = tempDir();
    const long = `npm test -- ${"x".repeat(300)}`;
    for (const index of [0, 1, 2]) claude(dir, root, index, [`${long} a`, `${long} b`, "npm run lint"]);
    const out = repeats(["--root", root, "--sessions-dir", dir]);
    const printed = out.findings.commands.map((finding) => finding.step);
    assert.strictEqual(printed.filter((step) => step === `${long.slice(0, 240)} [excerpt truncated]`).length, 2);
    // The two commands, and the three sequences that hold one of them.
    assert.deepStrictEqual(out.warnings.filter((warning) => /printed cut/.test(warning)),
      ["5 listed steps are printed cut to 240 characters; findings whose steps differ only after that print the same step."]);
  });
});

describe("Codex rollouts", () => {
  test("three rollouts that run the same command give the same finding as Claude Code sessions, and a prompt counts once", () => {
    const root = shop();
    const dir = tempDir();
    for (const index of [0, 1, 2]) {
      transcript([
        { ...meta, payload: { id: `thread-${index}`, cwd: root } }, started(1), { ...turn(2), payload: { ...turn(2).payload, cwd: root } },
        message("Run the checks.", 3), { timestamp: at(3), type: "event_msg", payload: { type: "user_message", message: "Run the checks." } },
        call(`c${index}`, "npm test", 4), output(`c${index}`, ["Process exited with code 0"], 5),
      ], { dir, name: `rollout-2026-01-01T00-00-0${index}-${ids[index]}.jsonl` });
    }
    const out = repeats(["--root", root, "--sessions-dir", dir]);
    assert.deepStrictEqual(out.sessionsRead, { claude: 0, codex: 3, subagentTranscripts: 0 });
    assert.deepStrictEqual(commands(out), [["npm test", 3]]);
    assert.deepStrictEqual(out.findings.prompts.map((finding) => [finding.step, finding.occurrences]), [["run the checks", 3]]);
  });

  test("only a shell tool's call is a command: another tool's arguments that hold a command are none", () => {
    const root = shop();
    const dir = tempDir();
    for (const index of [0, 1, 2]) {
      transcript([
        { ...meta, payload: { id: `thread-${index}`, cwd: root } }, started(1), { ...turn(2), payload: { ...turn(2).payload, cwd: root } },
        fn(`m${index}`, "mcp__deploy__run", { command: "npm run deploy" }, 3), output(`m${index}`, ["ok"], 4),
        fn(`n${index}`, "notes", { cmd: "cat README.md" }, 5), output(`n${index}`, ["ok"], 6),
        fn(`s${index}`, "shell", { command: ["bash", "-lc", "npm test"] }, 7), output(`s${index}`, ["ok"], 8),
      ], { dir, name: `rollout-2026-01-01T00-00-0${index}-${ids[index]}.jsonl` });
    }
    const out = repeats(["--root", root, "--sessions-dir", dir]);
    assert.deepStrictEqual(commands(out), [["npm test", 3]]);
    assert.deepStrictEqual(out.findings.lookups, []);
  });

  test("a forked rollout counts toward the thread it came from, and the prompts it copied are not typed again", () => {
    const root = shop();
    const dir = tempDir();
    const owner = (id, second = 0) => [
      { timestamp: at(second), type: "session_meta", payload: { id, cwd: root } }, started(1), { ...turn(2), payload: { ...turn(2).payload, cwd: root } },
      message("Fix the checkout.", 3), { timestamp: at(3), type: "event_msg", payload: { type: "user_message", message: "Fix the checkout." } },
      call(`${id}-c`, "npm test", 4), output(`${id}-c`, ["Process exited with code 0"], 5),
    ];
    const name = (index) => `rollout-2026-01-01T00-00-0${index}-${ids[index]}.jsonl`;
    for (const [index, id] of [[0, "thread-p"], [1, "thread-q"]]) transcript(owner(id), { dir, name: name(index) });
    // One fork marks where its own history starts after the copy; a fork of that fork marks none, so its copy stays.
    const fork = (id, from, start) => [
      { timestamp: at(0), type: "session_meta", payload: { id, cwd: root, forked_from_id: from, ...(start ? { subagent_history_start_ordinal: start } : {}) } },
      ...owner(from), started(6), { ...turn(7), payload: { ...turn(7).payload, cwd: root } }, message("Review the change.", 8),
      call(`${id}-c`, "npm test", 9), output(`${id}-c`, ["Process exited with code 0"], 10),
    ].map((row, ordinal) => ({ ...row, ordinal }));
    transcript(fork("thread-a", "thread-p", 8), { dir, name: name(2) });
    transcript(fork("thread-b", "thread-a"), { dir, name: name(3) });
    const out = repeats(["--root", root, "--sessions-dir", dir, "--min-sessions", "2"]);
    assert.deepStrictEqual(out.sessionsRead, { claude: 0, codex: 2, subagentTranscripts: 2 });
    // The second fork's copy of the first fork's call carries that call's id, and counts once.
    assert.deepStrictEqual(out.findings.commands.map((finding) => [finding.step, finding.sessions, finding.inSubagents]), [["npm test", 2, 2]]);
    assert.deepStrictEqual(out.findings.prompts.map((finding) => [finding.step, finding.sessions, finding.occurrences]), [["fix the checkout", 2, 2]]);
    // Forks whose thread is not read share one session of their own.
    const forks = repeats(["--root", root, "--session-file", path.join(dir, name(2)), "--session-file", path.join(dir, name(3)), "--min-sessions", "2"]);
    assert.deepStrictEqual(forks.sessionsRead, { claude: 0, codex: 0, subagentTranscripts: 2 });
    assert.deepStrictEqual([forks.findings.commands, forks.findings.prompts], [[], []]);
  });
});

describe("the command line", () => {
  test("two runs print the same bytes", () => {
    const root = shop();
    const dir = tempDir();
    for (const index of [0, 1, 2]) claude(dir, root, index, ["npm test", "git status --short --ignored"]);
    const first = run(["--root", root, "--sessions-dir", dir]);
    assert.strictEqual(first.status, 0, first.stderr);
    assert.strictEqual(run(["--root", root, "--sessions-dir", dir]).stdout, first.stdout);
  });

  test("it exits 2 on a bad option, a root outside Git, or no session to read", () => {
    const root = shop();
    const dir = tempDir();
    claude(dir, root, 0, ["npm test"]);
    for (const args of [["--root", root, "--sessions-dir", dir, "--since", "1d"], ["--sessions-dir", dir], ["--root", root, "--min-sessions", "1"],
      ["--root", root, "--min-sessions", "21"], ["--root", root, "--limit", "0"], ["--root", root, "--limit", "x"], ["--root", root, "--sessions-dir"]]) {
      assert.strictEqual(run(args).status, 2, args.join(" "));
    }
    const outside = tempDir();
    assert.match(run(["--root", outside, "--sessions-dir", dir]).stderr, /not inside a Git work tree/);
    const none = run(["--root", root, "--sessions-dir", tempDir()]);
    assert.strictEqual(none.status, 2);
    assert.match(none.stderr, /no session found to read/);
  });
});

describe("the evidence hooks", () => {
  test("analyzeClaude and analyzeCodex return the same evidence with and without hooks, and onCall sees each issued call once", () => {
    const root = "/work/shop";
    const file = transcript([human("Run the checks.", 1), use("t1", "Bash", { command: "npm test" }, 2), result("t1", "ok", 3),
      use("t1", "Bash", { command: "npm test" }, 2), use("t2", "Read", { file_path: "/work/shop/a.js" }, 4), result("t2", "x", 5), say("e", "Done.", 6)]);
    const rollout = transcript([meta, started(1), turn(2), message("Run the checks.", 3), call("c1", "npm test", 4), output("c1", ["ok"], 5)]);
    for (const [analyze, input, prompts] of [[analyzeClaude, file, 1], [analyzeCodex, rollout, 1]]) {
      const calls = [];
      const typed = [];
      const hooked = analyze(input, Number.MAX_SAFE_INTEGER, 6, { onCall: (seen) => calls.push(seen), onPrompt: (seen) => typed.push(seen) });
      assert.deepStrictEqual(hooked, analyze(input, Number.MAX_SAFE_INTEGER, 6));
      assert.ok(calls.length > 0);
      assert.strictEqual(calls.length, hooked.coverage.calls);
      assert.ok(typed.length >= prompts);
      assert.ok(calls.every((seen) => seen.cwd === root && typeof seen.callLine === "number"));
      if (analyze === analyzeCodex) assert.deepStrictEqual(calls.map((seen) => seen.callId), ["c1"]);
    }
  });
});
