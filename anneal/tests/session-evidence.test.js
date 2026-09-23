"use strict";

// The session evidence script's redaction, and its CLI through the real entry point, on synthetic transcripts.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { CLI, SESSION, tempDir, transcript, at, human, use, result, meta, started, turn } = require("./session-transcripts.js");
const { analyzeClaude, detectHost, redact } = require("../scripts/session-evidence.js");

describe("redaction", () => {
  test("credentials in a command or an output never reach an excerpt", () => {
    const report = analyzeClaude(transcript([
      human("deploy", 1),
      use("t1", "Bash", { command: "curl -H 'Authorization: Bearer abc.def.ghi' https://user:hunter2@example.invalid --token s3cr3t" }, 2),
      result("t1", "Exit code 1\nAPI_KEY=sk-abcdefghijklmnop1234 rejected\nSet-Cookie: session=abc123", 3, true),
      human("audit", 4),
    ]));
    const shown = JSON.stringify(report.candidates);
    for (const secret of ["abc.def.ghi", "hunter2", "s3cr3t", "sk-abcdefghijklmnop1234", "session=abc123"]) {
      assert.ok(!shown.includes(secret), `${secret} leaked`);
    }
    assert.match(shown, /\[REDACTED\]/);
  });

  // The home directory and the OS user name are read once, when the script loads, so each home gets a process of its
  // own. The user name is the home's last segment unless a test gives another.
  const redactUnder = (home, texts, user = home.split(/[\\/]/).pop()) => {
    const script = `const os = require("node:os"); os.homedir = () => ${JSON.stringify(home)};`
      + `os.userInfo = () => ({ username: ${JSON.stringify(user)} });`
      + `process.stdout.write(JSON.stringify(${JSON.stringify(texts)}.map(require(${JSON.stringify(CLI)}).redact)));`;
    const done = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    assert.strictEqual(done.status, 0, done.stderr);
    return JSON.parse(done.stdout);
  };

  test("the home directory is shortened however it is spelled", () => {
    for (const home of [String.raw`C:\Users\Quillfen`, "/home/quillfen"]) {
      const spellings = [home, home.replace(/\\/g, "/"), JSON.stringify(home).slice(1, -1)];
      assert.deepStrictEqual(redactUnder(home, spellings.map((spelled) => `cd ${spelled}/work`)), spellings.map(() => "cd ~/work"));
    }
  });

  test("a credential after Bearer or Basic is redacted, and a word after them is prose", () => {
    const credentials = [
      ["Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic [REDACTED]"],
      ["curl -H 'authorization: bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'", "curl -H 'authorization: bearer [REDACTED]'"],
      ["Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyz", "Bearer [REDACTED]"],
    ];
    for (const [text, shown] of credentials) assert.strictEqual(redact(text), shown);
    const prose = ["Basic usage: run npm test.", "Use Basic authentication.", "Bearer tokens expire.", "Basic PowerShell and Basic Self-Hosting"];
    for (const text of prose) assert.strictEqual(redact(text), text);
  });

  test("a Windows home is found in any case and spelling, and a sibling directory is left alone", () => {
    const texts = [
      String.raw`cat c:\users\QUILLFEN\notes.md`, String.raw`{"file_path":"C:\\Users\\Quillfen\\notes.md"}`, "file:///C:/Users/Quillfen/notes.md",
      String.raw`cat C:\Users\Quillfen2\notes.md`, String.raw`cd C:\Users\Quillfen.old`, String.raw`cd C:\Users\Quillfen_x`,
    ];
    assert.deepStrictEqual(redactUnder(String.raw`C:\Users\Quillfen`, texts), [
      String.raw`cat ~\notes.md`, String.raw`{"file_path":"~\\notes.md"}`, "file:///~/notes.md", texts[3], texts[4], texts[5],
    ]);
  });

  test("a Windows home is also found in MSYS, WSL and doubly escaped spellings, and a sibling there is left alone", () => {
    const nested = (file) => JSON.stringify({ content: JSON.stringify({ path: file }) });
    const texts = [
      "cat /c/Users/Quillfen/notes.md", "cat /mnt/c/Users/quillfen/notes.md", nested(String.raw`C:\Users\Quillfen\notes.md`),
      "cat /c/Users/Quillfen2/notes.md", "cat /mnt/c/Users/Quillfen.old/notes.md", nested(String.raw`C:\Users\Quillfen2\notes.md`),
    ];
    assert.deepStrictEqual(redactUnder(String.raw`C:\Users\Quillfen`, texts), [
      "cat ~/notes.md", "cat ~/notes.md", nested(String.raw`~\notes.md`), texts[3], texts[4], texts[5],
    ]);
  });

  test("a file name, path, date or short word after Basic or Bearer is prose, and a long token is a credential", () => {
    for (const text of ["Basic README.md covers setup.", "Basic src/index.js and Basic JSON/YAML", "Bearer 2026-01-01 rotation"]) {
      assert.strictEqual(redact(text), text);
    }
    assert.strictEqual(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), "Authorization: Bearer [REDACTED]");
  });

  test("code that names a secret is left alone, and an assigned secret is still redacted", () => {
    const code = [
      "if (token === null) return;", "interface Login { password: string; }", "const secret = process.env.SECRET;", "const cb = (token) => token;",
    ];
    for (const text of code) assert.strictEqual(redact(text), text);
    assert.strictEqual(redact("password: hunter22"), "password: [REDACTED]");
    assert.strictEqual(redact('token := "abc123def"'), "token := [REDACTED]");
  });

  test("a POSIX home keeps its case, and a root home names nobody", () => {
    const texts = ["cd /home/quillfen/work", "cd /home/quillfen2/work", "cd /HOME/QUILLFEN/work", String.raw`type C:\work\notes.md`];
    assert.deepStrictEqual(redactUnder("/home/quillfen", texts), ["cd ~/work", ...texts.slice(1)]);
    // A root home masks no account name either, whatever the OS calls the user.
    assert.deepStrictEqual(redactUnder("/", texts, "quillfen"), texts);
    assert.deepStrictEqual(redactUnder("C:\\", texts, "quillfen"), texts);
  });

  test("the account name is masked as a path segment, inside a project key and in ls -l owner and group columns", () => {
    const texts = [
      "cd D:/Projects/Quillfen/shop", "cat ../../Users/Quillfen/notes.md", String.raw`cat ..\..\Users\quillfen\notes.md`,
      String.raw`{"file_path":"D:\\Projects\\QUILLFEN\\notes.md"}`, "file:///D:/Projects/Quillfen/notes.md", "cd /mnt/d/Projects/quillfen/shop",
      String.raw`dir C:\Users\Quillfen\.claude\projects\C--Users-Quillfen-shop`, "projects/D--Projects-Quillfen-shop/0a1b.jsonl",
      "-rw-r--r-- 1 Quillfen 197121 12 Sep 22 10:00 notes.md", "total 8\ndrwxr-xr-x 2 quillfen quillfen 4096 Sep 22 10:00 shop",
      String.raw`{"output":"total 4\n-rw-r--r--@ 1 quillfen staff 12 Sep 22 10:00 notes.md"}`,
    ];
    assert.deepStrictEqual(redactUnder(String.raw`C:\Users\Quillfen`, texts), [
      "cd D:/Projects/<user>/shop", "cat ../../Users/<user>/notes.md", String.raw`cat ..\..\Users\<user>\notes.md`,
      String.raw`{"file_path":"D:\\Projects\\<user>\\notes.md"}`, "file:///D:/Projects/<user>/notes.md", "cd /mnt/d/Projects/<user>/shop",
      String.raw`dir ~\.claude\projects\C--Users-<user>-shop`, "projects/D--Projects-<user>-shop/0a1b.jsonl",
      "-rw-r--r-- 1 <user> 197121 12 Sep 22 10:00 notes.md", "total 8\ndrwxr-xr-x 2 <user> <user> 4096 Sep 22 10:00 shop",
      String.raw`{"output":"total 4\n-rw-r--r--@ 1 <user> staff 12 Sep 22 10:00 notes.md"}`,
    ]);
  });

  test("the account name stays as a word in prose or code, in a segment that only contains it, and in another case on POSIX", () => {
    const windows = [
      "Ask Quillfen before the release.", "const quillfen = load(); quillfen.run();", "QUILLFEN_LEVEL=5 npm run quillfen",
      "cd D:/Projects/Quillfen2/shop", "cd D:/Projects/Quillfen.old/shop", "cd D:/Projects/quillfen_x", "cd D:/Projects/V-Quillfen/shop",
      "projects/C--Users-Quillfen2-shop", "-rw-r--r-- 1 quillfen2 staff 12 Sep 22 10:00 notes.md",
    ];
    assert.deepStrictEqual(redactUnder(String.raw`C:\Users\Quillfen`, windows), windows);
    const posix = ["cd /srv/QUILLFEN/app", "-rw-r--r-- 1 Quillfen staff 12 Sep 22 10:00 notes.md"];
    assert.deepStrictEqual(redactUnder("/home/quillfen", posix), posix);
  });

  test("the OS user name is masked too when it differs from the home directory's last segment", () => {
    const texts = ["cd /srv/qfops/app", "cd /srv/quillfen/app", "projects/-home-qfops-shop", "-rw-r--r-- 1 qfops quillfen 12 Sep 22 10:00 notes.md"];
    assert.deepStrictEqual(redactUnder("/home/quillfen", texts, "qfops"), [
      "cd /srv/<user>/app", "cd /srv/<user>/app", "projects/-home-<user>-shop", "-rw-r--r-- 1 <user> <user> 12 Sep 22 10:00 notes.md",
    ]);
  });

  test("the account name is masked inside a lowercase folder name built from a path, as Codex and WSL write them", () => {
    const windows = [
      "cd ~/.codex/worktrees/demo-app-c-users-quillfen-codex", "ls /tmp/tool-cache-c-users-quillfen",
      "cd /root/.codex/-mnt-d-projects-quillfen-shop", "/tmp/claude-1000/-mnt-x-temp-claude-d--projects-quillfen-shop/0a1b/scratchpad",
    ];
    assert.deepStrictEqual(redactUnder(String.raw`C:\Users\Quillfen`, windows), [
      "cd ~/.codex/worktrees/demo-app-c-users-<user>-codex", "ls /tmp/tool-cache-c-users-<user>",
      "cd /root/.codex/-mnt-d-projects-<user>-shop", "/tmp/claude-1000/-mnt-x-temp-claude-d--projects-<user>-shop/0a1b/scratchpad",
    ]);
    assert.deepStrictEqual(redactUnder("/home/quillfen", ["ls /tmp/codex-home-quillfen-shop"]), ["ls /tmp/codex-home-<user>-shop"]);
  });

  test("a longer name, another spelling, prose and code keep the account name next to a folder name built from a path", () => {
    const kept = [
      "cd ~/.codex/worktrees/demo-app-c-users-quillfen2-codex", "cd /root/.codex/-mnt-d-projects-v-quillfen-shop",
      "cd /root/.codex/-mnt-d-projects-quillfenx-shop", "C-Users-Quillfen-shop", "quillfen-games", "com.quillfen.chat", "pytest-of-quillfen",
      "Ask quillfen before the users-facing release.", "const users_quillfen = count(users - quillfen);",
    ];
    assert.deepStrictEqual(redactUnder(String.raw`C:\Users\Quillfen`, kept), kept);
  });

  test("context.cwd shortens the home directory to ~, and session-review's root check still matches after expanding it", () => {
    const cwdUnder = (home, host, cwd) => {
      const file = host === "claude"
        ? transcript([{ ...human("fix it", 1), cwd }, human("audit", 2)])
        : transcript([meta, started(1), { ...turn(1), payload: { cwd, model: "model-y", effort: "medium" } }, started(2)]);
      const analyze = host === "claude" ? "analyzeClaude" : "analyzeCodex";
      const script = `require("node:os").homedir = () => ${JSON.stringify(home)};`
        + `process.stdout.write(JSON.stringify(require(${JSON.stringify(CLI)}).${analyze}(${JSON.stringify(file)}).context.cwd));`;
      const done = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
      assert.strictEqual(done.status, 0, done.stderr);
      return JSON.parse(done.stdout);
    };
    // session-review's check: expand a leading ~ to the home directory, then compare with the repository root as the
    // platform spells paths, slashes either way and, for a drive path, in any case.
    const sameRoot = (cwd, home, root) => {
      const spell = (value) => value.replace(/\\/g, "/").replace(/\/+$/, "");
      const expanded = spell(cwd.replace(/^~(?=$|[\\/])/, () => home));
      return /^[A-Za-z]:/.test(expanded) ? expanded.toLowerCase() === spell(root).toLowerCase() : expanded === spell(root);
    };
    const windows = cwdUnder(String.raw`C:\Users\Dev`, "claude", String.raw`C:\Users\Dev\projects\shop`);
    assert.strictEqual(windows, String.raw`~\projects\shop`);
    assert.ok(sameRoot(windows, String.raw`C:\Users\Dev`, "C:/Users/Dev/projects/shop"));
    const posix = cwdUnder("/home/dev", "codex", "/home/dev/shop");
    assert.strictEqual(posix, "~/shop");
    assert.ok(sameRoot(posix, "/home/dev", "/home/dev/shop"));
    assert.ok(!sameRoot(posix, "/home/dev", "/work/shop"));
    // A sibling of the home and a directory elsewhere keep their spelling; only the home prefix is shortened.
    assert.strictEqual(cwdUnder("/home/dev", "claude", "/home/dev2/shop"), "/home/dev2/shop");
    assert.strictEqual(cwdUnder("/home/dev", "codex", "/work/shop"), "/work/shop");
    // The account name stays in context.cwd, where excerpts mask it, so the root check needs nothing more.
    const elsewhere = cwdUnder(String.raw`C:\Users\Quillfen`, "codex", String.raw`D:\Projects\Quillfen\shop`);
    assert.strictEqual(elsewhere, String.raw`D:\Projects\Quillfen\shop`);
    assert.ok(sameRoot(elsewhere, String.raw`C:\Users\Quillfen`, "D:/Projects/Quillfen/shop"));
  });
});

describe("the command line", () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "", ...env },
  });

  test("a transcript handed over by path says which host wrote it", () => {
    const claude = transcript([human("go", 1), human("audit", 2)]);
    const codex = transcript([meta, started(1), started(2)]);
    assert.strictEqual(detectHost(claude), "claude");
    assert.strictEqual(detectHost(codex), "codex");
    const done = run(["--session-file", codex]);
    assert.strictEqual(done.status, 0, done.stderr);
    assert.strictEqual(JSON.parse(done.stdout).host, "codex");
  });

  test("a session id finds exactly one transcript under the host's home, and nothing else is a guess", () => {
    const home = tempDir();
    const file = transcript([human("go", 1), human("audit", 2)], { dir: path.join(home, "projects", "shop") });
    const found = run(["--claude-home", home], { CLAUDE_CODE_SESSION_ID: SESSION });
    assert.strictEqual(found.status, 0, found.stderr);
    assert.strictEqual(JSON.parse(found.stdout).sessionFile, file);

    transcript([human("go", 1), human("audit", 2)], { dir: path.join(home, "projects", "copy") });
    const twice = run(["--claude-home", home], { CLAUDE_CODE_SESSION_ID: SESSION });
    assert.strictEqual(twice.status, 2);
    assert.match(twice.stderr, /expected one transcript for that session, found 2/);
  });

  test("a Codex thread id is found at any depth under sessions", () => {
    const home = tempDir();
    const file = transcript([meta, started(1), started(2)], {
      dir: path.join(home, "sessions", "2026", "01", "01"), name: `rollout-2026-01-01T00-00-00-${SESSION}.jsonl`,
    });
    const found = run(["--host", "codex", "--session-id", SESSION, "--codex-home", home]);
    assert.strictEqual(found.status, 0, found.stderr);
    assert.strictEqual(JSON.parse(found.stdout).sessionFile, file);
  });

  test("with no session variable and no file, it says what to supply", () => {
    const none = run([]);
    assert.strictEqual(none.status, 2);
    assert.match(none.stderr, /Supply --host or --session-file/);
  });

  test("a bad flag, a bad limit and a cutoff without a timezone are refused", () => {
    const file = transcript([human("go", 1), human("audit", 2)]);
    assert.strictEqual(run(["--nope", "x"]).status, 2);
    assert.strictEqual(run(["--session-file", file, "--limit", "31"]).status, 2);
    const naive = run(["--session-file", file, "--before", "2026-01-01T00:00:00"]);
    assert.strictEqual(naive.status, 1);
    assert.match(naive.stderr, /The cutoff must include a timezone/);
  });

  test("a line cutoff is a line number, goes alone, and reruns the first run's interval byte for byte but for its mode", () => {
    const file = transcript([
      human("fix the cart total", 1),
      use("t1", "Bash", { command: "npm test" }, 2), result("t1", "Exit code 1\n1 failing", 3, true),
      human("audit", 4),
    ]);
    for (const value of ["0", "x", "1.5", "-2"]) {
      const refused = run(["--session-file", file, "--before-line", value]);
      assert.strictEqual(refused.status, 2);
      assert.match(refused.stderr, /--before-line must be a line number/);
    }
    const both = run(["--session-file", file, "--before-line", "4", "--before", at(30)]);
    assert.strictEqual(both.status, 2);
    assert.match(both.stderr, /give --before or --before-line, not both/);

    const first = run(["--session-file", file]);
    assert.strictEqual(first.status, 0, first.stderr);
    const line = JSON.parse(first.stdout).boundary.line;
    const rerun = run(["--session-file", file, "--before-line", String(line)]);
    assert.strictEqual(rerun.status, 0, rerun.stderr);
    assert.strictEqual(rerun.stdout.replace('"mode": "explicit-line"', '"mode": "before-latest-human-prompt"'), first.stdout);
    // Past the last line, a line cutoff takes in the whole transcript.
    assert.strictEqual(JSON.parse(run(["--session-file", file, "--before-line", "99"]).stdout).recordsSelected, 4);
  });

  test("the same bytes and cutoff give byte-identical evidence", () => {
    const file = transcript([
      human("fix the cart total", 1),
      use("a", "Read", { file_path: "/work/shop/cart.js" }, 2),
      use("b", "Bash", { command: "npm test" }, 2),
      result("b", "Exit code 1\n1 failing", 3, true),
      result("a", "export const cart = [];", 4),
      use("c", "Bash", { command: "npm run build" }, 5),
      human("audit", 6),
    ]);
    for (const args of [["--session-file", file], ["--session-file", file, "--before", at(30)]]) {
      const first = run(args);
      assert.strictEqual(first.status, 0, first.stderr);
      assert.strictEqual(run(args).stdout, first.stdout);
    }
  });

  test("the same bytes and cutoff give byte-identical navigation candidates", () => {
    const file = transcript([
      human("fix the cart total", 1),
      use("a", "Read", { file_path: "/work/shop/src/cart.js" }, 2),
      result("a", "<tool_use_error>File does not exist.</tool_use_error>", 3, true),
      use("b", "Bash", { command: "git ls-files | grep cart" }, 4),
      result("b", "lib/cart.js", 5),
      use("c", "Read", { file_path: "/work/shop/lib/cart.js" }, 6),
      result("c", "export const total = 1;", 7),
      use("d", "Read", { file_path: "/work/shop/lib/cart.js" }, 8),
      result("d", "export const total = 1;", 9),
      human("audit", 10),
    ]);
    for (const args of [["--session-file", file], ["--session-file", file, "--before", at(30)]]) {
      const first = run(args);
      assert.strictEqual(first.status, 0, first.stderr);
      assert.deepStrictEqual(JSON.parse(first.stdout).navigationCandidates.map((c) => c.kind), ["missing-path", "repeated-read"]);
      assert.strictEqual(run(args).stdout, first.stdout);
    }
  });

  test("without a home directory the script still prints evidence, redacts no home or account name and finds no session by id", () => {
    // The script reads the home directory and the OS user name once, at load, so each run replaces them in a process
    // of its own. The user is named as the home would be, so only the missing home keeps the account name.
    const runWith = (homedir, args, env = {}) => spawnSync(process.execPath, ["-e", `require("node:os").homedir = ${homedir};`
      + `require("node:os").userInfo = () => ({ username: "quillfen" });`
      + `process.exitCode = require(${JSON.stringify(CLI)}).main([process.execPath, ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}]);`], {
      encoding: "utf8", env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "", CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", ...env },
    });
    const missing = `() => { throw new Error("no home directory"); }`;
    const file = transcript([
      human("fix it", 1),
      use("t1", "Bash", { command: "cat /home/quillfen/notes.md" }, 2),
      result("t1", "Exit code 1\ncat: no such file", 3, true),
      human("audit", 4),
    ]);
    const shown = (homedir) => {
      const done = runWith(homedir, ["--session-file", file]);
      assert.strictEqual(done.status, 0, done.stderr);
      return JSON.parse(done.stdout).candidates[0].commandOrArguments;
    };
    assert.strictEqual(shown(`() => "/home/quillfen"`), "cat ~/notes.md");
    assert.strictEqual(shown(missing), "cat /home/quillfen/notes.md");
    const lookup = runWith(missing, [], { CLAUDE_CODE_SESSION_ID: SESSION });
    assert.strictEqual(lookup.status, 2);
    assert.match(lookup.stderr, /found 0\. Supply --session-file/);
  });

  test("a transcript that does not parse exits 1 and prints no evidence", () => {
    const broken = transcript([human("go", 1)], { tail: "{not json}\n" });
    const done = run(["--session-file", broken]);
    assert.strictEqual(done.status, 1);
    assert.strictEqual(done.stdout, "");
    assert.match(done.stderr, /Invalid JSON record at line 2/);
  });
});
