#!/usr/bin/env node
"use strict";

// anneal's audit: what makes an agent search, read or guess more than it needs
// to in a repository. Read-only. The file list comes from git, so the scan sees
// what search sees: tracked files plus untracked files that are not ignored.
// Outside git it walks the tree and reports that as a finding.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { observe } = require("./audit-observations.js");

const MAP_FILE_MAX_LINES = 200;
const LARGE_FILE_LINES = 800;
const INDEX_FILES_MIN = 3;
const MAX_DIR_DEPTH = 6;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const EVIDENCE_LIMIT = 15;
const SEVERITY_ORDER = ["high", "medium", "low"];

const CODE_EXTENSIONS = new Set([
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "vue", "svelte",
  "py", "rb", "php", "go", "rs", "java", "kt", "kts", "scala", "groovy",
  "cs", "fs", "vb", "swift", "m", "mm", "c", "h", "cc", "cpp", "cxx", "hpp", "hh",
  "dart", "lua", "ex", "exs", "erl", "clj", "cljs", "hs", "ml", "r", "jl",
  "sh", "bash", "ps1", "gd",
]);
const JS_EXTENSIONS = new Set(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]);

// File names a framework or language requires; repeating them is expected.
const ROUTE_NAMES = new Set([
  "page", "layout", "route", "loading", "error", "not-found", "template", "default", "middleware",
  "+page", "+layout", "+server", "+error", "+page.server", "+layout.server",
]);
const REQUIRED_NAMES = new Set(["index", "__init__", "__main__", "mod", "lib", "main", "conftest", "setup", "program", "startup", "assemblyinfo", ...ROUTE_NAMES]);
const GENERIC_NAMES = new Set(["utils", "util", "helpers", "helper", "common", "misc", "stuff", "general", "functions"]);

// Folders that usually hold build output or installed dependencies.
const BUILD_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "bin", "obj", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", "__pycache__", ".venv", "venv",
  ".gradle", ".dart_tool", "Library", "Temp", "Logs",
]);
// Committed files under these count as generated. build/ and bin/ are left
// out: projects keep real sources and assets there often enough.
const OUTPUT_DIRS = new Set([
  "node_modules", "dist", "out", "target", "obj", "coverage",
  ".next", ".nuxt", ".svelte-kit", "__pycache__", ".venv", "venv", "Library", "Temp",
]);
const COMPILED_EXTENSIONS = new Set(["class", "pyc", "o", "obj", "pdb"]);
// Test inputs and data a project keeps on purpose, so no build output.
const INPUT_DIRS = new Set(["fixtures", "__fixtures__", "testdata", "test-data", "__snapshots__", "snapshots", "golden", "data"]);

// A computed lookup on a name, call or index. The keywords are ones an array
// literal can follow, as in `for (const x of [...])`, which is not a lookup.
const NOT_A_LOOKUP = "(?:of|in|return|case|yield|await|typeof|instanceof|void|delete|throw|else|do|new|default)";
const JS_LOOKUP = String.raw`(?:(?:^|[^\w$])(?!${NOT_A_LOOKUP}\b)[\w$]+|[)\]])\s*\[\s*`;

// One pattern per line of code. A literal lookup is searchable; these are not.
const RUNTIME_NAME_PATTERNS = [
  [JS_EXTENSIONS, new RegExp(JS_LOOKUP + "(['\"])[^'\"\\n]*\\1\\s*\\+")],
  [JS_EXTENSIONS, new RegExp(JS_LOOKUP + "`[^`\\n]*\\$\\{")],
  [JS_EXTENSIONS, /\beval\s*\(|\bnew\s+Function\s*\(/],
  [new Set(["py"]), /\bgetattr\s*\(\s*[^,\n]+,\s*(?!\s|["']\w+["']\s*[,)])/],
  [new Set(["py"]), /\bimportlib\.import_module\s*\(\s*(?!\s|["'][\w.]+["']\s*[,)])/],
  [new Set(["py"]), /(?<![\w.])(?:eval|exec)\s*\(|\bglobals\s*\(\s*\)\s*\[/],
  [new Set(["rb"]), /\.(?:public_)?send\s*\(\s*(?!\s|:\w+\s*[,)]|["'][\w?!]+["']\s*[,)])/],
  [new Set(["php"]), /\$\$\w+|\bcall_user_func(?:_array)?\s*\(/],
  [new Set(["cs"]), /\b(?:Type\.GetType|Activator\.CreateInstance|GetMethod|InvokeMember)\s*\(|\b(?:SendMessage|SendMessageUpwards|BroadcastMessage|Invoke|InvokeRepeating|StartCoroutine)\s*\(\s*"/],
  [new Set(["java", "kt", "kts", "scala", "groovy"]), /\bClass\.forName\s*\(|\.getDeclaredMethod\s*\(|\.getMethod\s*\(/],
  [new Set(["go"]), /\.MethodByName\s*\(/],
];

const CHECK_SCRIPT = /^(test|lint|typecheck|type-check|types|check|verify|validate|ci)(:[\w-]+)?$/;
const COMBINED_CHECK = /^(check|verify|validate|ci)$/;
const CHECK_TARGET = /^(check|test|lint|typecheck|verify|validate|ci)\b/;
// Names Node's own runner treats as test files; it also runs any script under a
// test/ folder, and skips node_modules and dot folders.
const NODE_TEST_NAME = /^(?:[^/]*[.\-_]test|test-[^/]*|test)\.[cm]?js$/;
const FIXTURE_DIRS = new Set(["fixtures", "__fixtures__"]);
// Check runners a harness mounts: collet's, and jig's, the retired plugin collet replaced.
const HARNESS_CHECKS = [".collet/checks/run.mjs", ".jig/checks/run.mjs"];

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function walk(root) {
  const files = [];
  const pending = [""];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== ".git" && !BUILD_DIRS.has(entry.name)) pending.push(rel);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }
  return files.sort();
}

function listFiles(root) {
  try {
    git(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { isGit: false, tracked: walk(root), untracked: [], limitations: [] };
  }
  const split = (output) => output.split("\0").filter(Boolean);
  return { isGit: true, tracked: split(git(root, ["ls-files", "-z", "--cached"])), ...untrackedFiles(root, split) };
}

// A sandbox can deny reading an ignore file, such as the global excludes file.
// Git then warns and skips it, or, when it can open but not read the file, refuses
// to list; the retry drops only the global file. Either way the listing lacks those
// rules, and the report names the file as a limitation instead of stopping.
function untrackedFiles(root, split) {
  const list = (config) => spawnSync("git", ["-C", root, ...config, "ls-files", "-z", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let result = list([]);
  let warnings = result.stderr || "";
  if (result.status !== 0 && /cannot use .+ as an exclude file/.test(warnings)) {
    result = list(["-c", "core.excludesFile="]);
    warnings += result.stderr || "";
  }
  if (result.error || result.status !== 0) throw result.error || new Error(`git ls-files failed: ${result.stderr.trim()}`);
  const unreadable = [...new Set([...warnings.matchAll(/unable to access '([^']+)'/g)].map((match) => match[1]))];
  return {
    untracked: split(result.stdout),
    limitations: unreadable.map(limitationFor),
  };
}

// Git names the file by its absolute path, usually under the owner's home: shorten that to ~ with
// session evidence's home rule. Loaded here, not at the top, because that module requires this one.
function limitationFor(file) {
  const { directory } = require("./session-evidence-redaction.js");
  return `Git could not read ${directory(file)}, so untracked files are listed without its ignore rules`;
}

function extensionOf(file) {
  const base = path.posix.basename(file);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function stemOf(file) {
  const base = path.posix.basename(file);
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

const dirsOf = (file) => file.split("/").slice(0, -1);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const nameGroup = ([stem, group]) => `${stem}: ${group.slice(0, 5).join(", ")}${group.length > 5 ? `, +${group.length - 5} more` : ""}`;
const sized = ({ file, lines }) => `${file} (${lines === null ? "over 2 MB" : `${lines} lines`})`;

function readFile(root, file) {
  try {
    const full = path.join(root, file);
    const { size } = fs.statSync(full);
    if (size > MAX_READ_BYTES) return { size, text: null };
    const buffer = fs.readFileSync(full);
    return { size, text: buffer.subarray(0, 8000).includes(0) ? null : buffer.toString("utf8") };
  } catch {
    return null;
  }
}

function countLines(text) {
  if (!text) return 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) newlines++;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

function rootReader(root) {
  let names;
  try {
    names = new Set(fs.readdirSync(root));
  } catch {
    names = new Set();
  }
  const text = (file) => {
    const info = readFile(root, file);
    return info && info.text !== null ? info.text : "";
  };
  const json = (file) => {
    try {
      return JSON.parse(text(file));
    } catch {
      return null;
    }
  };
  return { names, has: (name) => names.has(name), text, json };
}

// The map file every host loads at the start of a session. Which name a host
// reads is the host's business; the audit only cares that one of them exists
// and stays short, and reports the ones it found so the plan can point a
// missing name at an existing file instead of copying it.
const MAP_FILES = [
  "CLAUDE.md", ".claude/CLAUDE.md",
  "AGENTS.md", ".agents/AGENTS.md",
  "GEMINI.md", ".gemini/GEMINI.md",
];

function mapFileFindings(root, add) {
  const found = MAP_FILES.filter((file) => fs.existsSync(path.join(root, file)));
  if (!found.length) {
    add("map-file-missing", "high", "No map file, so every session starts by exploring", [MAP_FILES.join(", ")]);
    return found;
  }
  for (const map of found) {
    const lines = countLines(readFile(root, map)?.text || "");
    if (lines > MAP_FILE_MAX_LINES) {
      add("map-file-long", "medium", `${map} has ${lines} lines, over ${MAP_FILE_MAX_LINES}, and loads into every session`, [map]);
    }
  }
  return found;
}

// Characters a model reads and a person does not see: zero-width characters,
// the word joiner, a byte order mark past the start, bidi embeddings and
// isolates, and Unicode tags. A file an agent loads as instructions can carry
// an order in them that nobody reviewing the file can read. The joiner inside
// an emoji and the tags of a subdivision flag render, so they are skipped. The
// evidence names each line and code point and counts tags, never decoding them.
const HIDDEN_CHARACTERS =
  /(?<!\p{Extended_Pictographic}\uFE0F?|[\u{1F3FB}-\u{1F3FF}])\u200D|[\u200B\u200C\u2060\uFEFF\u202A-\u202E\u2066-\u2069]|(?<!\u{1F3F4}[\u{E0020}-\u{E007E}]*)[\u{E0000}-\u{E007F}]/gu;
const INSTRUCTION_DIRS = [".agents/", ".claude/", ".cursor/rules/", ".gemini/"];

function isInstructionFile(file) {
  if (MAP_FILES.includes(path.posix.basename(file))) return true;
  return INSTRUCTION_DIRS.some((dir) => file.startsWith(dir)) && /\.(md|mdc)$/i.test(file);
}

function hiddenCharacterFindings(root, files, add) {
  const evidence = [];
  for (const file of files.filter(isInstructionFile)) {
    const text = readFile(root, file)?.text;
    if (!text) continue;
    text.replace(/^\uFEFF/, "").split("\n").forEach((line, i) => {
      const found = [...line.matchAll(HIDDEN_CHARACTERS)].map(([char]) => char.codePointAt(0));
      if (!found.length) return;
      const tags = found.filter((code) => code >= 0xe0000).length;
      const named = [...new Set(found.filter((code) => code < 0xe0000))].map((code) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
      evidence.push(`${file}:${i + 1} ${[...named, ...(tags ? [plural(tags, "Unicode tag character")] : [])].join(", ")}`);
    });
  }
  if (evidence.length) {
    add("instruction-hidden-characters", "low", "Characters invisible on screen in files agents load as instructions", evidence);
  }
}

// A .env that no template describes is a runtime the agent cannot reproduce:
// the names it needs are in a file it must never read. Only fires when an env
// file is actually there, so a project without one is never nagged.
const ENV_FILES = [".env", ".env.local", ".env.development", ".env.test", ".env.production"];
const ENV_TEMPLATES = [".env.example", ".env.template", ".env.sample", ".env.dist"];

function envFindings(root, add) {
  const present = ENV_FILES.filter((file) => fs.existsSync(path.join(root, file)));
  if (!present.length) return;
  if (ENV_TEMPLATES.some((file) => fs.existsSync(path.join(root, file)))) return;
  add("env-template-missing", "medium", "Environment files with no template naming the variables they set", present);
}

function detectToolchain(root, reader) {
  const { has, text, json } = reader;
  const toolVersions = text(".tool-versions");
  const pinnedIn = (tool) => new RegExp(`^\\s*${tool}\\s+\\S`, "m").test(toolVersions);
  const ecosystems = [];
  const missing = [];
  const need = (name, declared, hint) => {
    ecosystems.push(name);
    if (!declared) missing.push(`${name} (${hint})`);
  };

  if (has("package.json")) {
    const pkg = json("package.json") || {};
    const volta = Boolean(pkg.volta && pkg.volta.node);
    need("node", has(".nvmrc") || has(".node-version") || pinnedIn("nodejs") || pinnedIn("node") || volta, ".nvmrc or .node-version");
  }
  if (["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"].some(has)) {
    need("python", has(".python-version") || pinnedIn("python"), ".python-version");
  }
  if (has("Cargo.toml")) need("rust", has("rust-toolchain.toml") || has("rust-toolchain"), "rust-toolchain.toml");
  if (has("go.mod")) need("go", /^go\s+\d/m.test(text("go.mod")), "a go directive in go.mod");
  if (fs.existsSync(path.join(root, "ProjectSettings", "ProjectVersion.txt"))) {
    ecosystems.push("unity");
  } else if ([...reader.names].some((name) => /\.(sln|slnx|csproj|fsproj|vbproj)$/i.test(name))) {
    need("dotnet", has("global.json"), "global.json");
  }
  if (has("Gemfile")) need("ruby", has(".ruby-version") || pinnedIn("ruby"), ".ruby-version");
  if (["pom.xml", "build.gradle", "build.gradle.kts"].some(has)) {
    const build = text("pom.xml") + text("build.gradle") + text("build.gradle.kts");
    const toolchain = /languageVersion|<maven\.compiler\.release>|<release>\d/.test(build);
    need("jvm", has(".java-version") || has(".sdkmanrc") || pinnedIn("java") || toolchain, ".java-version or a toolchain in the build file");
  }
  return { ecosystems, missing };
}

function checkKind(name) {
  if (COMBINED_CHECK.test(name)) return "combined";
  if (name.startsWith("test")) return "test";
  if (name.startsWith("lint")) return "lint";
  return "types";
}

function detectChecks(reader, ecosystems, files) {
  const { has, text, json } = reader;
  const commands = [];
  const kinds = new Set();
  let combined = false;
  const found = (command, source, name) => {
    commands.push({ command, source });
    const kind = checkKind(name);
    if (kind === "combined") combined = true;
    else kinds.add(kind);
  };

  if (has("package.json")) {
    const pkg = json("package.json") || {};
    const runner = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun run" : "npm run";
    for (const name of Object.keys(pkg.scripts || {})) {
      if (!CHECK_SCRIPT.test(name) || /watch|fix|update|debug/.test(name)) continue;
      found(runner === "npm run" && name === "test" ? "npm test" : `${runner} ${name}`, "package.json", name);
    }
  }
  for (const makefile of ["Makefile", "makefile", "GNUmakefile"]) {
    if (!has(makefile)) continue;
    for (const match of text(makefile).matchAll(/^([\w-]+)\s*:(?!=)/gm)) {
      if (CHECK_TARGET.test(match[1])) found(`make ${match[1]}`, makefile, match[1]);
    }
  }
  for (const justfile of ["justfile", "Justfile"]) {
    if (!has(justfile)) continue;
    for (const match of text(justfile).matchAll(/^([\w-]+)[^:\n]*:(?!=)/gm)) {
      if (CHECK_TARGET.test(match[1])) found(`just ${match[1]}`, justfile, match[1]);
    }
  }
  // A Node script in the root scripts/ folder with a check's name: scripts/check.js.
  for (const file of files) {
    const script = /^scripts\/([^/.]+)\.[cm]?js$/.exec(file);
    if (script && CHECK_SCRIPT.test(script[1])) found(`node ${file}`, file, script[1]);
  }
  for (const runner of HARNESS_CHECKS) if (files.includes(runner)) commands.push({ command: `node ${runner}`, source: runner });
  if (has("Cargo.toml")) commands.push({ command: "cargo test", source: "Cargo.toml" });
  if (has("go.mod")) commands.push({ command: "go test ./...", source: "go.mod" });
  const gradle = ["build.gradle", "build.gradle.kts"].find(has);
  if (gradle) commands.push({ command: `${has("gradlew") ? "./gradlew" : "gradle"} check`, source: gradle });
  if (has("pom.xml")) commands.push({ command: `${has("mvnw") ? "./mvnw" : "mvn"} verify`, source: "pom.xml" });
  if (ecosystems.includes("dotnet")) commands.push({ command: "dotnet test", source: "solution" });
  if (ecosystems.includes("python")) {
    if (has("tox.ini")) commands.push({ command: "tox", source: "tox.ini" });
    if (has("noxfile.py")) commands.push({ command: "nox", source: "noxfile.py" });
    if (has("pytest.ini") || has("conftest.py") || text("pyproject.toml").includes("[tool.pytest")) {
      commands.push({ command: "pytest", source: "pytest config" });
    }
  }
  // With no manifest, `node --test` runs the test files Node finds, unless a bare
  // run would also execute fixture tests or enter submodule checkouts.
  if (!has("package.json") && !has(".gitmodules")) {
    const tests = files.filter((file) => !inBuildDir(file) && !dirsOf(file).some((dir) => dir.startsWith("."))
      && (NODE_TEST_NAME.test(path.posix.basename(file)) || (dirsOf(file).includes("test") && /\.[cm]?js$/.test(file))));
    const fixtureTest = tests.some((file) => NODE_TEST_NAME.test(path.posix.basename(file)) && dirsOf(file).some((dir) => FIXTURE_DIRS.has(dir)));
    if (tests.length && !fixtureTest) commands.push({ command: "node --test", source: tests[0] });
  }
  return { commands, combined, split: !combined && kinds.size > 1 };
}

function isGeneratedPath(file) {
  const base = path.posix.basename(file).toLowerCase();
  if (dirsOf(file).some((dir) => OUTPUT_DIRS.has(dir))) return true;
  if (/\.min\.(js|css)$/.test(base) || /\.(js|mjs|cjs|css|ts)\.map$/.test(base)) return true;
  return COMPILED_EXTENSIONS.has(extensionOf(file));
}

const inBuildDir = (file) => dirsOf(file).some((dir) => BUILD_DIRS.has(dir));
// The first input folder a path sits under, as `test/fixtures/`, or null.
const inputDir = (file) => {
  const index = dirsOf(file).findIndex((dir) => INPUT_DIRS.has(dir));
  return index === -1 ? null : `${dirsOf(file).slice(0, index + 1).join("/")}/`;
};

function groupByDir(files, dirSet) {
  const groups = new Map();
  for (const file of files) {
    const dirs = dirsOf(file);
    const index = dirs.findIndex((dir) => dirSet.has(dir));
    const key = index === -1 ? file : `${dirs.slice(0, index + 1).join("/")}/`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  return [...groups].map(([key, n]) => (key.endsWith("/") ? `${key} (${plural(n, "file")})` : key));
}

function isConfigFile(file) {
  const base = path.posix.basename(file);
  return /\.config\.[cm]?[jt]sx?$/.test(base) || /^\.?[\w-]+rc\.[cm]?[jt]s$/.test(base) || /\.stories\.[jt]sx?$/.test(base);
}

function isReexportOnly(text) {
  const body = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
  return body !== "" && /^(?:export (?:type )?(?:\*(?: as [\w$]+)?|\{[^}]*\}) from ['"][^'"]+['"] ?;? ?)+$/.test(body);
}

function scanContents(root, codeFiles) {
  const large = [];
  const runtimeNames = [];
  const defaultExports = [];
  const reexportFiles = [];
  for (const file of codeFiles) {
    const info = readFile(root, file);
    if (!info) continue;
    if (info.text === null) {
      if (info.size > MAX_READ_BYTES) large.push({ file, lines: null });
      continue;
    }
    const lines = countLines(info.text);
    if (lines > LARGE_FILE_LINES) large.push({ file, lines });

    const ext = extensionOf(file);
    const patterns = RUNTIME_NAME_PATTERNS.filter(([exts]) => exts.has(ext)).map(([, pattern]) => pattern);
    if (patterns.length) {
      info.text.split("\n").forEach((line, i) => {
        if (patterns.some((pattern) => pattern.test(line))) runtimeNames.push(`${file}:${i + 1}`);
      });
    }
    if (!JS_EXTENSIONS.has(ext)) continue;
    const stem = stemOf(file);
    if (!isConfigFile(file) && !REQUIRED_NAMES.has(stem) && /^\s*export\s+default\b/m.test(info.text)) defaultExports.push(file);
    if (stem === "index" && isReexportOnly(info.text)) reexportFiles.push(file);
  }
  large.sort((a, b) => (b.lines ?? Infinity) - (a.lines ?? Infinity));
  return { large, runtimeNames, defaultExports, reexportFiles };
}

function audit(rootArg) {
  const root = path.resolve(rootArg);
  const listing = listFiles(root);
  const files = [...listing.tracked, ...listing.untracked];
  const codeFiles = files.filter((file) => CODE_EXTENSIONS.has(extensionOf(file)) && !inBuildDir(file) && !isGeneratedPath(file));
  const reader = rootReader(root);
  const findings = [];
  const add = (id, severity, title, evidence) => {
    findings.push({ id, severity, title, count: evidence.length, evidence: evidence.slice(0, EVIDENCE_LIMIT) });
  };

  if (!listing.isGit) add("not-a-git-repo", "high", "Not a git repository, so search can't use .gitignore to skip generated files", ["."]);
  const mapFiles = mapFileFindings(root, add);
  hiddenCharacterFindings(root, files, add);
  envFindings(root, add);

  const { ecosystems, missing } = detectToolchain(root, reader);
  if (missing.length) add("toolchain-version-missing", "medium", "No declared toolchain version to run the project with", missing);

  const checks = detectChecks(reader, ecosystems, files);
  if (!checks.commands.length && codeFiles.length) {
    add("check-command-missing", "high", "No test or check command found", ["no package script, make or just target, scripts/ check, harness runner, build tool, test runner config or Node test files"]);
  } else if (checks.split) {
    add("check-command-split", "low", "Checks run as separate commands; no single one runs them all", checks.commands.map((entry) => entry.command));
  }

  const committed = listing.isGit ? listing.tracked.filter(isGeneratedPath) : [];
  if (listing.isGit) {
    const notIgnored = listing.untracked.filter(inBuildDir);
    if (notIgnored.length) add("build-output-not-ignored", "high", "Build or dependency folders not ignored by git, so they show up in search", groupByDir(notIgnored, BUILD_DIRS));
    // A generated-looking file under an input folder is kept on purpose; required-inputs names it.
    const generated = committed.filter((file) => !inputDir(file));
    if (generated.length) add("build-output-tracked", "medium", "Generated files committed to git", groupByDir(generated, OUTPUT_DIRS));
  }

  const byStem = new Map();
  for (const file of codeFiles) {
    const stem = stemOf(file);
    if (!REQUIRED_NAMES.has(stem)) byStem.set(stem, [...(byStem.get(stem) || []), file]);
  }
  const duplicates = [...byStem].filter(([, group]) => group.length > 1).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  if (duplicates.length) add("duplicate-names", "medium", "File names used more than once, so a search by name is ambiguous", duplicates.map(nameGroup));

  const genericDirs = new Set();
  const genericFiles = [];
  for (const file of codeFiles) {
    const dirs = dirsOf(file);
    dirs.forEach((dir, i) => {
      if (GENERIC_NAMES.has(dir.toLowerCase())) genericDirs.add(`${dirs.slice(0, i + 1).join("/")}/`);
    });
    if (GENERIC_NAMES.has(stemOf(file).replace(/\.(test|spec)$/, ""))) genericFiles.push(file);
  }
  if (genericDirs.size || genericFiles.length) {
    add("generic-names", "medium", "Generic file or folder names that say nothing about what is inside", [...genericDirs, ...genericFiles]);
  }

  const indexFiles = codeFiles.filter((file) => stemOf(file) === "index");
  if (indexFiles.length >= INDEX_FILES_MIN) add("index-files", "low", "Several files named index, so a search by name is ambiguous", indexFiles);

  const deepFiles = codeFiles.filter((file) => dirsOf(file).length >= MAX_DIR_DEPTH);
  if (deepFiles.length) {
    add("deep-nesting", "low", `Code ${MAX_DIR_DEPTH} or more folders deep, so listing the way down costs a step each time`, deepFiles);
  }

  const contents = scanContents(root, codeFiles);
  if (contents.large.length) add("large-files", "medium", `Code files over ${LARGE_FILE_LINES} lines, expensive to read whole`, contents.large.map(sized));
  if (contents.runtimeNames.length) add("runtime-names", "low", "Names built at runtime, which search can't follow", contents.runtimeNames);
  if (contents.defaultExports.length) add("default-exports", "low", "Default exports, which can be imported under another name", contents.defaultExports);
  if (contents.reexportFiles.length) add("re-export-files", "low", "Index files that only re-export, adding a hop to every lookup", contents.reexportFiles);

  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const facts = { mapFiles, checks, duplicates, deepFiles, committed, indexFiles: indexFiles.length >= INDEX_FILES_MIN ? indexFiles : [], large: contents.large };
  const shared = { EVIDENCE_LIMIT, OUTPUT_DIRS, ROUTE_NAMES, countLines, dirsOf, extensionOf, inBuildDir, inputDir, isGeneratedPath, nameGroup, plural, sized, stemOf };
  return {
    tool: "anneal-audit",
    schemaVersion: 1,
    root,
    git: listing.isGit,
    limitations: listing.limitations,
    ecosystems,
    files: { scanned: files.length, code: codeFiles.length },
    mapFiles,
    checks,
    findings,
    observations: observe(files, reader, facts, shared),
  };
}

const listed = (entry) => [`  ${entry.id} (${entry.count}): ${entry.title}`, ...entry.evidence.slice(0, 3).map((item) => `    ${item}`), ...(entry.count > 3 ? [`    +${entry.count - 3} more`] : [])];

function formatSummary(report) {
  const lines = [
    `anneal audit: ${report.root}`,
    `${plural(report.files.scanned, "file")} (${report.files.code} code) | git: ${report.git ? "yes" : "no"} | ecosystems: ${report.ecosystems.join(", ") || "none detected"}`,
    ...report.limitations.map((limitation) => `limitation: ${limitation}`),
    "",
  ];
  if (!report.findings.length) lines.push("No findings.");
  for (const severity of SEVERITY_ORDER) {
    const group = report.findings.filter((finding) => finding.severity === severity);
    if (!group.length) continue;
    lines.push(severity);
    for (const finding of group) lines.push(...listed(finding));
  }
  if (report.observations.length) {
    lines.push("", "observations (informational)");
    for (const observation of report.observations) lines.push(...listed(observation), `    note: ${observation.note}`);
  }
  const commands = report.checks.commands.map((entry) => entry.command);
  const note = report.checks.split ? " (no single command runs them all)" : "";
  lines.push("", `map files: ${report.mapFiles.length ? report.mapFiles.join(" | ") : "none"}`);
  lines.push(`checks: ${commands.length ? commands.join(" | ") : "none found"}${note}`);
  return `${lines.join("\n")}\n`;
}

function main(argv) {
  const args = argv.slice(2);
  let root = process.cwd();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--root" && i + 1 < args.length) root = args[++i];
    else {
      process.stderr.write("usage: audit.js [--root <dir>] [--json]\n");
      return 2;
    }
  }
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(root).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    process.stderr.write(`audit.js: not a directory: ${root}\n`);
    return 2;
  }
  const report = audit(root);
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatSummary(report));
  return 0;
}

// Exported before main runs, so a module main loads lazily sees the whole API.
module.exports = { HIDDEN_CHARACTERS, audit, formatSummary, limitationFor, main };

if (require.main === module) process.exitCode = main(process.argv);
