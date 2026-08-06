"use strict";

// [Foreman: 074] Claude Code host adapter.
//
// Everything assay knows about *where Claude Code loads instructions from* lives
// in this file and nowhere else. The shared analyzers in ../assay.js consume the
// objects returned here; they never look at a filename and conclude anything
// about loading. That is the seam SCOPE.md's "Host adapter contract" asks for,
// and the reason a second host can be added without touching the scoring code.
//
// Discovery only. Reading a file's bytes and parsing its Markdown/YAML stays in
// the shared engine, which owns the vendored parsers — so this file has zero
// dependencies, including on assay.js.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
// [Foreman: 080] The one require in an adapter: repository-level enforcement is
// not host knowledge, so both profiles read it out of the same file.
const { discoverRepoChecks: sharedRepoChecks } = require("./repo-checks.js");

const NAME = "claude-code";
// 3 = adds the auto-memory surface (~/.claude/projects/<project>/memory/).
// 2 = the whole documented project surface plus user-scope memory. 1 saw only
// ./CLAUDE.md and .claude/rules/. The constant exists to date-stamp surface
// coverage, so a record naming an older version is known to have seen less.
const PROFILE_VERSION = 3;

// Documented load order, broadest scope first, so a later source is read after
// (and outranks) an earlier one. `precedence` is that ranking as a number;
// sources sharing a number are documented as loading at the same priority.
const PRECEDENCE = {
  userMemory: 1,
  userRules: 1, // "loaded before project rules, giving project rules higher priority"
  // Auto memory loads at the start of every conversation, same as user memory.
  // Its rank RELATIVE to the other user-scope sources is not documented — the
  // docs say only that both load at conversation start — so this shares the
  // user-memory number and coverageNotes discloses the ordering as observed.
  userAutoMemory: 1,
  ancestorMemory: 2, // "ordered from the filesystem root down to your working directory"
  projectMemory: 3,
  projectRules: 3, // "same priority as .claude/CLAUDE.md"
  localMemory: 4, // appended after CLAUDE.md at the project level, so read last
};

// The documented MEMORY.md read limit. Only the first 200 lines OR 25KB of the
// auto-memory index load at conversation start, "whichever comes first",
// measured over the content that loads — YAML frontmatter and block-level HTML
// comments are stripped first (documented v2.1.211+). The docs are definitive
// that content past the boundary is dropped on the next load, so the engine
// derives an inactive (never-read) state for a rule past it, not the ambiguous
// at-risk the chain-wide cap gets. The byte value behind "25KB" is not spelled
// out on the page; 25×1024 is assay's reading of it, marked unverified.
const MEMORY_INDEX_CAP = {
  lines: 200,
  bytes: 25 * 1024, // "25KB" — exact byte constant unverified; see comment above
  claim: "the auto-memory index MEMORY.md loads only its first 200 lines or first 25KB, whichever comes first, measured with frontmatter and block HTML comments stripped",
  url: "https://code.claude.com/docs/en/memory.md",
};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

// `claude --version`, or null. Fails open on every axis: no binary, a non-zero
// exit, a hang, an unparseable line, a platform that spawns differently. A host
// version is a nice-to-have label on the record; it is never worth an exception
// or a stalled audit.
function probeHostVersion() {
  // npm installs the launcher as claude.cmd on Windows, which spawnSync will not
  // resolve from the bare name.
  const candidates = process.platform === "win32" ? ["claude.cmd", "claude"] : ["claude"];
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ["--version"], { encoding: "utf-8", timeout: 2000, windowsHide: true });
      const m = r && r.status === 0 && r.stdout ? r.stdout.match(/\d+\.\d+\.\d+\S*/) : null;
      if (m) return m[0];
    } catch {
      // next candidate, then null
    }
  }
  return null;
}

// The context every later call is fixed against. `userDir` null means user scope
// was switched off (--project-only) and no user source is discovered at all.
//
// ASSAY_USER_DIR overrides the documented location. It exists so a test fixture
// can stand in for a real home directory — without it every fixture-based run
// would silently pick up whatever is in the developer's own ~/.claude.
function detectContext(opts = {}) {
  const projectRoot = path.resolve(opts.root || process.cwd());
  let userDir = null;
  if (!opts.projectOnly) {
    const raw = opts.userDir || process.env.ASSAY_USER_DIR || path.join(os.homedir(), ".claude");
    userDir = raw ? path.resolve(raw) : null;
  }
  // ASSAY_ANCESTOR_STOP fences the above-root walk the way ASSAY_USER_DIR
  // fences the home directory: ancestors are read only strictly below it. The
  // host itself walks to the filesystem root, which is the unfenced default.
  const stopRaw = opts.ancestorStop || process.env.ASSAY_ANCESTOR_STOP || null;
  return {
    projectRoot,
    // razor: assay analyzes one root, so the startup directory is that root.
    // Claude also walks up the tree above the working directory; an audit rooted
    // somewhere other than the project root is the case that makes the
    // distinction observable, and nothing asks for it yet.
    startupDirectory: projectRoot,
    userDir,
    // --project-only means "this repository's own files": it switches off the
    // user scope above and the above-root walk below, the two machine-local
    // surfaces a project audit cannot fix.
    projectOnly: opts.projectOnly === true,
    ancestorStop: stopRaw ? path.resolve(stopRaw) : null,
    hostVersion: opts.probeHost ? probeHostVersion() : null,
  };
}

// ---------------------------------------------------------------------------
// Instruction sources
// ---------------------------------------------------------------------------

// Claude Code discovers .md rule files recursively and follows symlinked files
// and directories. Mirror that loading surface so the audit neither misses a
// nested policy nor walks forever through a circular link.
//
// [Foreman: 070] A source the walk cannot open — an unreadable directory, a
// broken link — used to drop out with no trace, so the report counted what it
// graded and said nothing about what it never saw. Every swallowed error is
// recorded into `inaccessible` instead; paths are relative to `rulesDir` and the
// caller prefixes them.
function findRuleMarkdownFiles(rulesDir, inaccessible = []) {
  const found = [];
  const visitedDirs = new Set();

  function walk(absDir, relDir) {
    let realDir;
    try {
      realDir = fs.realpathSync(absDir);
    } catch (err) {
      inaccessible.push({ path: relDir || ".", reason: err.code || err.message });
      return;
    }
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      inaccessible.push({ path: relDir || ".", reason: err.code || err.message });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? relDir + "/" + entry.name : entry.name;
      let stat;
      try {
        stat = entry.isSymbolicLink() ? fs.statSync(abs) : null;
      } catch (err) {
        inaccessible.push({ path: rel, reason: err.code || err.message });
        continue; // broken link
      }
      const isDir = entry.isDirectory() || (stat && stat.isDirectory());
      const isFile = entry.isFile() || (stat && stat.isFile());
      if (isDir) walk(abs, rel);
      else if (isFile && entry.name.endsWith(".md")) found.push({ rel, abs });
    }
  }

  walk(rulesDir, "");
  return found;
}

function exists(abs) {
  try {
    return fs.existsSync(abs);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Auto memory — the always-loaded surface added in PROFILE_VERSION 3
// ---------------------------------------------------------------------------

// OBSERVED, NOT DOCUMENTED. The host derives the auto-memory directory from a
// project path by dash-encoding it: the drive colon and every path separator
// become "-" (D:\a\b -> "D--a-b"; /home/u -> "-home-u"). The docs say only that
// <project> is "derived from the git repository", so this is a best-effort
// match. When the derived directory is absent — a slug mismatch, no memory yet,
// a relocated directory assay could not read — discovery fails open and emits
// nothing, and coverageNotes discloses the encoding as observed.
function autoMemorySlug(root) {
  return root.replace(/[\\/:]/g, "-");
}

// `autoMemoryEnabled` and `autoMemoryDirectory`, read with settings precedence
// (local > project > user). Managed policy is not read here (disclosed). The
// project/local values are honored by the host only after its workspace-trust
// dialog, which no static read can confirm — also disclosed.
function autoMemorySettings(ctx) {
  const files = [
    path.join(ctx.projectRoot, ".claude", "settings.local.json"),
    path.join(ctx.projectRoot, ".claude", "settings.json"),
    ...(ctx.userDir ? [path.join(ctx.userDir, "settings.json")] : []),
  ];
  let enabled = true, enabledSet = false, dir = null, dirSet = false;
  for (const abs of files) {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(abs, "utf-8")); } catch { continue; }
    if (!enabledSet && typeof cfg.autoMemoryEnabled === "boolean") { enabled = cfg.autoMemoryEnabled; enabledSet = true; }
    if (!dirSet && typeof cfg.autoMemoryDirectory === "string" && cfg.autoMemoryDirectory) { dir = cfg.autoMemoryDirectory; dirSet = true; }
  }
  if (process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1") enabled = false;
  return { enabled, dir };
}

// The auto-memory sources for this project. `MEMORY.md` is the always-loaded
// index (subject to the documented read cap on MEMORY_INDEX_CAP); sibling topic
// files load on demand, so they are inventoried but never counted as
// always-loaded. When auto memory is switched off the index still sits on disk
// yet the host ignores it, so it is emitted `selected: false` with the reason
// rather than as a false always-loaded claim.
function discoverAutoMemory(ctx, inaccessible) {
  const out = [];
  const { enabled, dir } = autoMemorySettings(ctx);
  const base = dir
    ? (dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : path.resolve(dir))
    : path.join(ctx.userDir, "projects", autoMemorySlug(ctx.projectRoot), "memory");
  const indexPath = path.join(base, "MEMORY.md");
  if (!exists(indexPath)) return out; // fail open
  out.push({
    path: indexPath, absPath: indexPath, scope: "user", kind: "memory",
    autoMemory: true,
    alwaysLoaded: enabled,
    ...(enabled ? {} : { selected: false }),
    precedence: PRECEDENCE.userAutoMemory,
    docCap: MEMORY_INDEX_CAP,
    selectionReason: enabled
      ? "auto-memory index — loads at the start of every conversation (first 200 lines or 25KB)"
      : "auto memory is disabled (autoMemoryEnabled false or CLAUDE_CODE_DISABLE_AUTO_MEMORY=1) — the index is not loaded",
  });
  let names = [];
  try {
    names = fs.readdirSync(base).sort();
  } catch (err) {
    inaccessible.push({ path: base, reason: err.code || err.message });
  }
  for (const name of names) {
    if (name === "MEMORY.md" || !name.endsWith(".md")) continue;
    const abs = path.join(base, name);
    out.push({
      path: abs, absPath: abs, scope: "user", kind: "memory",
      autoMemory: true, alwaysLoaded: false,
      precedence: PRECEDENCE.userAutoMemory,
      selectionReason: "auto-memory topic file — loads when Claude follows the memory index, not at conversation start",
    });
  }
  return out;
}

// Every documented instruction source Claude Code loads for this project, in
// load order. Discovery only: no file is opened, so a path that exists but
// cannot be read still arrives here and is reported by the engine's reader as a
// coverage gap rather than vanishing.
function discoverSources(ctx) {
  const sources = [];
  const inaccessible = [];
  const root = ctx.projectRoot;

  if (ctx.userDir) {
    const userMemory = path.join(ctx.userDir, "CLAUDE.md");
    if (exists(userMemory)) {
      sources.push({
        path: userMemory,
        absPath: userMemory,
        scope: "user",
        kind: "memory",
        alwaysLoaded: true,
        precedence: PRECEDENCE.userMemory,
        selectionReason: "user memory — loads for every project on this machine",
      });
    }
    // "Personal rules in ~/.claude/rules/ apply to every project on your
    // machine" and load before project rules. Same recursive walk as the
    // project's rules directory; an unscoped file loads every session.
    const userRulesDir = path.join(ctx.userDir, "rules");
    if (exists(userRulesDir)) {
      const walkIssues = [];
      for (const ruleFile of findRuleMarkdownFiles(userRulesDir, walkIssues)) {
        sources.push({
          path: ruleFile.abs,
          absPath: ruleFile.abs,
          scope: "user",
          kind: "rules",
          alwaysLoaded: false, // declared scope decides; see loadsAlways
          precedence: PRECEDENCE.userRules,
          selectionReason: "user rules directory — loads before project rules for every project on this machine",
        });
      }
      for (const issue of walkIssues) {
        inaccessible.push({
          path: issue.path === "." ? userRulesDir : path.join(userRulesDir, issue.path),
          reason: issue.reason,
        });
      }
    }
    // Auto memory: ~/.claude/projects/<project>/memory/. An always-loaded,
    // instruction-bearing surface the earlier profile could not see. User-scope,
    // so --project-only (userDir null) excludes it with the rest of user scope.
    for (const s of discoverAutoMemory(ctx, inaccessible)) sources.push(s);
  }

  // "CLAUDE.md and CLAUDE.local.md files in the directory hierarchy above the
  // working directory are loaded in full at launch", ordered from the
  // filesystem root down. The walk climbs from the root's parent and reverses,
  // so the outermost directory is emitted (and read) first. `ancestorStop`
  // fences fixtures; the host itself climbs all the way up.
  if (!ctx.projectOnly) {
    const ancestorDirs = [];
    let dir = path.dirname(root);
    while (true) {
      if (ctx.ancestorStop && dir === ctx.ancestorStop) break;
      ancestorDirs.push(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    ancestorDirs.reverse();
    for (const ancestor of ancestorDirs) {
      for (const name of ["CLAUDE.md", "CLAUDE.local.md"]) {
        const abs = path.join(ancestor, name);
        if (!exists(abs)) continue;
        sources.push({
          path: abs,
          absPath: abs,
          scope: "ancestor",
          kind: "memory",
          alwaysLoaded: true,
          precedence: PRECEDENCE.ancestorMemory,
          selectionReason: "ancestor memory — `" + ancestor + "` is above the project root, read before the project's own memory",
        });
      }
    }
  }

  // Same-level selection: the project memory file is ./CLAUDE.md OR
  // ./.claude/CLAUDE.md, never both.
  //
  // [Foreman: 076] The variant that loses the selection is still returned, marked
  // `selected: false`. It exists, it reads like live policy, and the host ignores
  // it — so the audit parses it and reports its rules as shadowed rather than
  // leaving the file invisible and the author believing it applies.
  const rootClaude = path.join(root, "CLAUDE.md");
  const altClaude = path.join(root, ".claude", "CLAUDE.md");
  if (exists(rootClaude)) {
    sources.push({
      path: "CLAUDE.md", absPath: rootClaude, scope: "project", kind: "memory",
      alwaysLoaded: true, precedence: PRECEDENCE.projectMemory,
      selectionReason: "project memory",
    });
    if (exists(altClaude)) {
      sources.push({
        path: ".claude/CLAUDE.md", absPath: altClaude, scope: "project", kind: "memory",
        alwaysLoaded: false, precedence: PRECEDENCE.projectMemory,
        selected: false, shadowedBy: "CLAUDE.md",
        selectionReason: "same-level variant — CLAUDE.md was selected",
      });
    }
  } else if (exists(altClaude)) {
    sources.push({
      path: ".claude/CLAUDE.md", absPath: altClaude, scope: "project", kind: "memory",
      alwaysLoaded: true, precedence: PRECEDENCE.projectMemory,
      selectionReason: "project memory — ./CLAUDE.md absent, .claude/CLAUDE.md selected",
    });
  }

  const localClaude = path.join(root, "CLAUDE.local.md");
  if (exists(localClaude)) {
    sources.push({
      path: "CLAUDE.local.md", absPath: localClaude, scope: "project", kind: "memory",
      alwaysLoaded: true, precedence: PRECEDENCE.localMemory,
      selectionReason: "local project memory — loads alongside CLAUDE.md, read last",
    });
  }

  const rulesDir = path.join(root, ".claude", "rules");
  if (exists(rulesDir)) {
    const walkIssues = [];
    for (const ruleFile of findRuleMarkdownFiles(rulesDir, walkIssues)) {
      sources.push({
        path: ".claude/rules/" + ruleFile.rel,
        absPath: ruleFile.abs,
        scope: "project",
        kind: "rules",
        // Declared scope decides this one; see loadsAlways.
        alwaysLoaded: false,
        precedence: PRECEDENCE.projectRules,
        selectionReason: "project rules directory",
      });
    }
    for (const issue of walkIssues) {
      inaccessible.push({
        path: issue.path === "." ? ".claude/rules" : ".claude/rules/" + issue.path,
        reason: issue.reason,
      });
    }
  }

  // Nested memory: a CLAUDE.md in a subdirectory loads when Claude works in
  // that subtree, not every session. Discovered so its rules are graded and its
  // existence is disclosed; `nested: true` keeps its bytes out of the
  // always-loaded total.
  for (const found of findNestedMemoryFiles(root, inaccessible)) {
    sources.push({
      path: found.rel,
      absPath: found.abs,
      scope: "project",
      kind: "memory",
      alwaysLoaded: false,
      nested: true,
      precedence: PRECEDENCE.projectMemory,
      selectionReason: "nested memory — loads when Claude works under `" +
        found.rel.slice(0, -"CLAUDE.md".length) + "`",
    });
  }

  return { sources, inaccessible };
}

// Every <subdir>/CLAUDE.md below the project root. Dot-directories and
// node_modules never hold instructions the host reads for this project, and a
// visited-realpath set keeps a symlink cycle from walking forever.
// razor: CLAUDE.md only — a nested CLAUDE.local.md is undocumented; support it
// the day the host documents it.
function findNestedMemoryFiles(root, inaccessible = []) {
  const found = [];
  const visited = new Set();

  function walk(absDir, relDir, depth) {
    if (depth > 12) return; // razor: bounded walk; raise if a real repo nests deeper
    let realDir;
    try {
      realDir = fs.realpathSync(absDir);
    } catch (err) {
      inaccessible.push({ path: relDir, reason: err.code || err.message });
      return;
    }
    if (visited.has(realDir)) return;
    visited.add(realDir);
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      inaccessible.push({ path: relDir, reason: err.code || err.message });
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relDir ? relDir + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        walk(path.join(absDir, entry.name), rel, depth + 1);
      } else if (entry.name === "CLAUDE.md" && relDir) {
        found.push({ rel, abs: path.join(absDir, entry.name) });
      }
    }
  }

  walk(root, "", 0);
  return found;
}

// The documented @path import syntax in memory files: a token at a whitespace
// boundary, resolved relative to the importing file, `~/` to the home
// directory. Code fences and inline code spans never import. A bare token with
// no separator that resolves to nothing is a mention, not an import — only a
// path-shaped target that fails to resolve is reported.
const IMPORT_MAX_DEPTH = 4; // "a maximum depth of four hops" — the engine enforces it

function discoverImports(file, ctx) {
  const out = { sources: [], unresolved: [] };
  if (file.kind !== "memory") return out;
  const root = ctx.projectRoot;
  const lines = String(file.content).split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const scrubbed = line.replace(/`[^`]*`/g, "");
    const re = /(^|\s)@([A-Za-z0-9_~.][A-Za-z0-9_~./-]*)/g;
    let m;
    while ((m = re.exec(scrubbed))) {
      const target = m[2].replace(/[.,;:)]+$/, "");
      if (!target) continue;
      const abs = target.startsWith("~/")
        ? path.join(os.homedir(), target.slice(2))
        : path.resolve(path.dirname(file.absPath), target);
      let stat = null;
      try { stat = fs.statSync(abs); } catch { /* not a file — decided below */ }
      if (!stat || !stat.isFile()) {
        if (target.includes("/")) {
          out.unresolved.push({ target, line: i + 1, importedBy: file.path, reason: "not found" });
        }
        continue;
      }
      const relToRoot = path.relative(root, abs);
      const inRoot = relToRoot && !relToRoot.startsWith("..") && !path.isAbsolute(relToRoot);
      const userDir = ctx.userDir ? path.resolve(ctx.userDir) : null;
      const inUserDir = userDir && !path.relative(userDir, abs).startsWith("..");
      if (!inRoot && !inUserDir) {
        out.unresolved.push({
          target, line: i + 1, importedBy: file.path,
          reason: "outside the project and user scope — not analyzed",
        });
        continue;
      }
      out.sources.push({
        path: inRoot ? relToRoot.replace(/\\/g, "/") : abs.replace(/\\/g, "/"),
        absPath: abs,
        scope: file.scope,
        kind: "memory",
        alwaysLoaded: file.alwaysLoaded === true,
        imported: true,
        precedence: file.precedence,
        selectionReason: "imported by " + file.path + ":" + (i + 1),
      });
    }
  }
  return out;
}

// The one loading question that cannot be answered until the file is parsed: a
// rules file with no `paths` frontmatter loads every session, exactly like
// CLAUDE.md. The engine parses the frontmatter and asks here, so the rule stays
// host knowledge instead of leaking into shared scoring code.
function loadsAlways(source, declaredGlobs) {
  // [Foreman: 076] A source the host did not select never loads, whatever its
  // frontmatter says.
  if (source.selected === false) return false;
  if (source.alwaysLoaded) return true;
  return source.kind === "rules" && (declaredGlobs || []).length === 0;
}

// ---------------------------------------------------------------------------
// Skills, subagents, hooks
// ---------------------------------------------------------------------------

function skillsIn(dir, prefix) {
  const found = [];
  let names;
  try {
    if (!fs.statSync(dir).isDirectory()) return found;
    names = fs.readdirSync(dir).sort();
  } catch {
    return found;
  }
  for (const name of names) {
    const abs = path.join(dir, name, "SKILL.md");
    if (exists(abs)) found.push({ name, path: prefix + name + "/SKILL.md", absPath: abs });
  }
  return found;
}

// Project skills are graded against the trigger recipe; user skills are not.
// A user skill is somebody's personal tooling, it applies to every project, and
// rewriting it from inside a project audit would be the wrong scope — so it is
// counted and named, never scored.
function discoverSkills(ctx) {
  return {
    project: skillsIn(path.join(ctx.projectRoot, ".claude", "skills"), ".claude/skills/"),
    user: ctx.userDir ? skillsIn(path.join(ctx.userDir, "skills"), path.join(ctx.userDir, "skills") + "/") : [],
  };
}

// Project subagents. A subagent's frontmatter description is its routing
// trigger — the same job, and the same failure mode, as a skill description —
// so discovery hands back the file for the engine to grade, not just a name.
function discoverAgents(ctx) {
  const dir = path.join(ctx.projectRoot, ".claude", "agents");
  try {
    if (!fs.statSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort().map((n) => ({
      name: n.slice(0, -3),
      path: ".claude/agents/" + n,
      absPath: path.join(dir, n),
    }));
  } catch {
    return [];
  }
}

// The last path-shaped token of a hook command line names the script; the
// interpreter and env-var prefixes around it are noise.
function hookCommandLabel(cmd) {
  const clean = String(cmd).replace(/["']/g, "");
  const pathy = clean.split(/\s+/).filter((t) => /[\\/]/.test(t));
  const token = pathy.length ? pathy[pathy.length - 1] : clean.split(/\s+/)[0];
  return token.split(/[\\/]/).pop();
}

function readHookConfig(file, source, entries, issues = []) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return; // absent — nothing configured here
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    // [Foreman: 091] A settings file that exists and will not parse is a hole
    // in the enforcement ladder, not an empty layer: every hook it declares is
    // invisible, and a candidate it would have covered gets proposed again.
    // The Codex adapter has always reported this; now both hosts do.
    issues.push({
      path: file,
      reason: "unreadable hook configuration — " + String(err.message).split("\n")[0].trim(),
    });
    return;
  }
  for (const [event, groups] of Object.entries(cfg.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of g.hooks || []) {
        if (!h || !h.command) continue;
        // [Foreman: 091] The full command line stays on the record — it is what
        // secret redaction and target checks read. `label` is the display name.
        entries.push({
          event, matcher: g.matcher || "*", source,
          command: String(h.command),
          label: hookCommandLabel(h.command),
          ...(Number.isInteger(h.timeout) ? { timeout: h.timeout } : {}),
        });
      }
    }
  }
}

// Hooks that already run for this project: project + user settings, plus every
// installed plugin's hooks.json. A rule the audit flags as a hook candidate may
// already be enforced by one of these — the report lists them so the candidate
// can be checked instead of rebuilt.
function discoverHooks(ctx) {
  const entries = [];
  const inaccessible = [];
  const root = ctx.projectRoot;
  readHookConfig(path.join(root, ".claude", "settings.json"), "project", entries, inaccessible);
  readHookConfig(path.join(root, ".claude", "settings.local.json"), "project", entries, inaccessible);
  // The hook inventory is the author's working input, not graded content, so it
  // reads the user's settings even under --project-only: a hook wired there
  // still fires on this project.
  const userDir = ctx.userDir || path.join(os.homedir(), ".claude");
  readHookConfig(path.join(userDir, "settings.json"), "user", entries, inaccessible);
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(userDir, "plugins", "installed_plugins.json"), "utf-8"));
    for (const [key, installs] of Object.entries(reg.plugins || {})) {
      const name = key.split("@")[0];
      for (const inst of Array.isArray(installs) ? installs : []) {
        if (!inst || !inst.installPath) continue;
        readHookConfig(path.join(inst.installPath, "hooks", "hooks.json"), "plugin: " + name, entries, inaccessible);
      }
    }
  } catch {
    // no plugin registry — nothing to add
  }
  const seen = new Set();
  return {
    hooks: entries.filter((e) => {
      const k = e.event + "|" + e.matcher + "|" + e.command + "|" + e.source;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
    inaccessible,
  };
}

// [Foreman: 077] Levels 4 and 5 of the enforcement ladder: checks the repository
// runs, and gates a remote runs.
// [Foreman: 080] The surfaces are host-agnostic — npm scripts and CI workflows
// are not a Claude Code concept — and now that a second profile has rungs at
// these levels the detection lives in ./repo-checks.js and both adapters call
// it. This profile adds nothing host-flavored on top, so it delegates whole.
function discoverRepoChecks(ctx) {
  return sharedRepoChecks(ctx.projectRoot);
}

// ---------------------------------------------------------------------------
// Supported mutation targets — [Foreman: 082]
// ---------------------------------------------------------------------------

// The slot SCOPE.md's host adapter contract names ("supported mutation targets")
// and nothing filled until the authoring skills became clients of this profile.
// Where a NEW rule or a NEW skill may be written is host knowledge exactly like
// where an existing one is discovered — and discovery cannot answer it, because
// a file that does not exist yet is not in discoverSources' output. So the
// declaration is static, like `policy` and `nouns`, and rides the record beside
// them: an authoring flow reads its write targets off the record instead of
// learning a host name.
//
// `docs` is the page the format came from, so a generated artifact's
// `placement-promotion` provenance names a URL this profile vouches for rather
// than one a model recalled.
const TARGETS = {
  rule: {
    docs: "https://code.claude.com/docs/en/memory.md",
    places: [
      {
        path: "CLAUDE.md",
        scope: "project",
        kind: "memory",
        scoping: "loads every session; a new rule belongs in the top quarter of the file",
      },
      {
        path: ".claude/rules/<topic>.md",
        scope: "project",
        kind: "rules",
        scoping: "`paths:` frontmatter binds it to the files it governs — the glob must match at least one real file; with no `paths:` it loads every session",
      },
    ],
  },
  skill: {
    docs: "https://code.claude.com/docs/en/skills.md",
    dir: ".claude/skills/<name>/",
    file: "SKILL.md",
    // Frontmatter the host documents as required for a project skill. The
    // trigger recipe is a separate question and lives in `policy.skillRecipe`.
    requires: ["description"],
    // No separate invocation or UI metadata file: the frontmatter carries it.
    metadata: [],
  },
  hook: {
    docs: "https://code.claude.com/docs/en/hooks.md",
    path: ".claude/settings.json",
  },
};

// ---------------------------------------------------------------------------
// Budgets and provenance
// ---------------------------------------------------------------------------

// Claude Code documents no hard byte cap for the instruction CHAIN — CLAUDE.md
// files are loaded in full whatever their length, and the 200-line guidance is
// adherence advice, not a limit the host enforces. So the corpus budget stays
// null and no rule is graded against a chain-wide number the host never applies.
// The one documented per-file limit — MEMORY.md's first-200-lines/25KB read cap
// — is NOT a chain budget: it rides the auto-memory source record on `docCap`
// (MEMORY_INDEX_CAP), and the engine derives an inactive state per rule past it.
function budgets() {
  return { documented: null };
}

// What this profile encodes and where the documentation says so. Every claim is
// re-read before the date below moves.
function docs() {
  const memory = "https://code.claude.com/docs/en/memory.md";
  return [
    // The memory.md claims were re-read live 2026-08-05; the pages below them
    // were not re-read that day and keep their earlier date, per profile.
    { claim: "user, project, and local memory files and their load order", url: memory, verified: "2026-08-05" },
    { claim: "CLAUDE.md and CLAUDE.local.md above the working directory load in full at launch, filesystem root first", url: memory, verified: "2026-08-05" },
    { claim: "~/.claude/rules/ user rules load before project rules", url: memory, verified: "2026-08-05" },
    { claim: "@path imports recurse to a maximum depth of four hops", url: memory, verified: "2026-08-05" },
    { claim: ".claude/rules/ recursive discovery, symlinks, and paths scoping", url: memory, verified: "2026-08-05" },
    // [ADR 2026-08-05 B4] The auto-memory surface.
    { claim: "auto memory at ~/.claude/projects/<project>/memory/ — MEMORY.md index loads at conversation start (first 200 lines or 25KB, whichever first), topic files load on demand, on by default", url: memory, verified: "2026-08-05" },
    // [ADR 2026-08-05 C2/C3] Documented guidance assay's placement direction rests on.
    { claim: "CLAUDE.md size guidance: target under 200 lines per file — adherence advice, not an enforced cap", url: memory, verified: "2026-08-05" },
    { claim: "host guidance: keep CLAUDE.md lightweight and move procedural/verification guidance into skills or path-scoped rules that load on demand", url: memory, verified: "2026-08-05" },
    { claim: "skill discovery and SKILL.md frontmatter", url: "https://code.claude.com/docs/en/skills.md", verified: "2026-07-28" },
    // [ADR 2026-08-05 C4] The listing cap is a documented host default, not an assay constant.
    { claim: "the skill-listing entry truncates the combined description + when_to_use text at 1,536 characters, configurable via skillListingMaxDescChars", url: "https://code.claude.com/docs/en/skills.md", verified: "2026-08-05" },
    { claim: "hook configuration in settings files", url: "https://code.claude.com/docs/en/hooks.md", verified: "2026-07-28" },
    { claim: "subagent definitions in .claude/agents/", url: "https://code.claude.com/docs/en/sub-agents.md", verified: "2026-07-28" },
    { claim: "hooks require a trusted workspace, which no static read can confirm", url: "https://code.claude.com/docs/en/hooks.md", verified: "2026-07-28" },
    // [ADR 2026-08-05 C2] The host's own documented CLAUDE.md remedy.
    { claim: "/doctor checkup trims checked-in CLAUDE.md and migrates the always-loaded guidance that remains into skills and nested CLAUDE.md, with confirmation (v2.1.206+)", url: "https://code.claude.com/docs/en/commands.md", verified: "2026-08-05" },
    // [ADR 2026-08-05 C5] Saved workflows — an explicit-invocation surface assay does not discover.
    { claim: "saved workflow scripts in .claude/workflows/, ~/.claude/workflows/, and plugin workflows/ directories run as explicit /<name> slash commands (invoke-only since v2.1.218)", url: "https://code.claude.com/docs/en/workflows.md", verified: "2026-08-05" },
  ];
}

// What the audit must disclose about this profile whatever it finds, in the
// adapter's own words. Coverage is a promise about what was looked at, so the
// residual limits travel with the adapter that owns them.
// [ADR 2026-08-05 B5] Discovery of auto memory (B1) still leaves gaps a file
// read cannot close; C5's saved-workflows line rides here too.
function coverageNotes() {
  return [
    "auto memory: topic files load on demand and assay cannot observe which of them a session actually followed",
    "auto memory: the ~/.claude/projects/<project> directory encoding, and auto memory's position in the loaded context relative to other user-scope sources, are observed, not documented — an absent directory is treated as no auto memory rather than a discovery failure",
    "auto memory: an `autoMemoryDirectory` relocation is honored only where a settings file was read, and its project/local trust gate cannot be confirmed by a static read",
    "saved workflow scripts (.claude/workflows/, ~/.claude/workflows/, plugin workflows/) are documented but explicit-invocation only, so assay does not discover them — their absence never falsifies the always-loaded byte total or the load order",
  ];
}

module.exports = {
  name: NAME,
  profileVersion: PROFILE_VERSION,
  targets: TARGETS, // [Foreman: 082]
  detectContext,
  discoverSources,
  loadsAlways,
  discoverSkills,
  discoverAgents,
  discoverHooks,
  discoverRepoChecks,
  discoverImports,
  IMPORT_MAX_DEPTH,
  budgets,
  docs,
  coverageNotes,
  // exported for the engine's compatibility re-export and its own tests
  findRuleMarkdownFiles,
};
