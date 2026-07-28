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

const NAME = "claude-code";
// 2 = the whole documented project surface plus user-scope memory. 1 saw only
// ./CLAUDE.md and .claude/rules/.
const PROFILE_VERSION = 2;

// Documented load order, broadest scope first, so a later source is read after
// (and outranks) an earlier one. `precedence` is that ranking as a number;
// sources sharing a number are documented as loading at the same priority.
const PRECEDENCE = {
  userMemory: 1,
  projectMemory: 2,
  projectRules: 2, // "same priority as .claude/CLAUDE.md"
  localMemory: 3, // appended after CLAUDE.md at the project level, so read last
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
  return {
    projectRoot,
    // razor: assay analyzes one root, so the startup directory is that root.
    // Claude also walks up the tree above the working directory; an audit rooted
    // somewhere other than the project root is the case that makes the
    // distinction observable, and nothing asks for it yet.
    startupDirectory: projectRoot,
    userDir,
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

// Every documented instruction source Claude Code loads for this project, in
// load order. Discovery only: no file is opened, so a path that exists but
// cannot be read still arrives here and is reported by the engine's reader as a
// coverage gap rather than vanishing.
//
// razor: user scope is the user's CLAUDE.md alone. ~/.claude/rules/ is a real
// documented surface too; it lands the day the report has somewhere useful to
// put a second user-scope file, and until then a user rules walk would be
// discovery nobody reads.
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

  return { sources, inaccessible };
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

// Project subagents, by name. Inventory only: a subagent is a real placement
// target, and knowing one already exists changes what a placement candidate
// should say. Modeling the mechanism itself is a later entry's job.
function discoverAgents(ctx) {
  const dir = path.join(ctx.projectRoot, ".claude", "agents");
  try {
    if (!fs.statSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort().map((n) => n.slice(0, -3));
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

function readHookConfig(file, source, entries) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return; // absent or malformed — no inventory from this file
  }
  for (const [event, groups] of Object.entries(cfg.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of g.hooks || []) {
        if (!h || !h.command) continue;
        entries.push({ event, matcher: g.matcher || "*", command: hookCommandLabel(h.command), source });
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
  const root = ctx.projectRoot;
  readHookConfig(path.join(root, ".claude", "settings.json"), "project", entries);
  readHookConfig(path.join(root, ".claude", "settings.local.json"), "project", entries);
  // The hook inventory is the author's working input, not graded content, so it
  // reads the user's settings even under --project-only: a hook wired there
  // still fires on this project.
  const userDir = ctx.userDir || path.join(os.homedir(), ".claude");
  readHookConfig(path.join(userDir, "settings.json"), "user", entries);
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(userDir, "plugins", "installed_plugins.json"), "utf-8"));
    for (const [key, installs] of Object.entries(reg.plugins || {})) {
      const name = key.split("@")[0];
      for (const inst of Array.isArray(installs) ? installs : []) {
        if (!inst || !inst.installPath) continue;
        readHookConfig(path.join(inst.installPath, "hooks", "hooks.json"), "plugin: " + name, entries);
      }
    }
  } catch {
    // no plugin registry — nothing to add
  }
  const seen = new Set();
  return entries.filter((e) => {
    const k = e.event + "|" + e.matcher + "|" + e.command + "|" + e.source;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// [Foreman: 077] Levels 4 and 5 of the enforcement ladder: checks the repository
// runs, and gates a remote runs. The surfaces are host-agnostic — npm scripts and
// CI workflows are not a Claude Code concept — but discovery stays adapter-owned
// so a second host profile can name different ones.
//
// Conservative and mechanical throughout: a name in a manifest, a file that
// exists. Nothing here is opened to decide whether it would pass, and every read
// fails open — an unreadable file is skipped, an unreadable directory that exists
// is reported as inaccessible rather than counted as empty.
const REPO_SCRIPT_NAMES = ["check", "format", "lint", "test"];

function discoverRepoChecks(ctx) {
  const checks = [];
  const inaccessible = [];
  const root = ctx.projectRoot;

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
    for (const name of REPO_SCRIPT_NAMES) {
      if (typeof scripts[name] === "string" && scripts[name].trim()) {
        checks.push({ type: "repo-check", name: "npm script: " + name, path: "package.json" });
      }
    }
  } catch {
    // absent or malformed — no manifest checks
  }

  for (const name of [".pre-commit-config.yaml", ".pre-commit-config.yml"]) {
    if (exists(path.join(root, name))) checks.push({ type: "repo-check", name, path: name });
  }

  // Read textually, never through `git config`: no subprocess, and the same
  // answer on every platform.
  try {
    const cfg = fs.readFileSync(path.join(root, ".git", "config"), "utf-8");
    const m = cfg.match(/^\s*hooksPath\s*=\s*(.+?)\s*$/m);
    if (m) checks.push({ type: "repo-check", name: "git hooks: " + m[1], path: ".git/config" });
  } catch {
    // no repo, or no readable config
  }

  const workflowDir = path.join(root, ".github", "workflows");
  if (exists(workflowDir)) {
    try {
      for (const name of fs.readdirSync(workflowDir).sort()) {
        if (/\.ya?ml$/.test(name)) {
          checks.push({ type: "remote-gate", name, path: ".github/workflows/" + name });
        }
      }
    } catch (err) {
      inaccessible.push({ path: ".github/workflows", reason: err.code || err.message });
    }
  }

  return { checks, inaccessible };
}

// ---------------------------------------------------------------------------
// Budgets and provenance
// ---------------------------------------------------------------------------

// Claude Code documents no hard byte cap for memory files — CLAUDE.md is loaded
// in full whatever its length, and the 200-line guidance is adherence advice,
// not a limit the host enforces. The adapter reports none rather than inventing
// one and grading against a number the host never applies.
function budgets() {
  return { documented: null };
}

// What this profile encodes and where the documentation says so. Every claim is
// re-read before the date below moves.
function docs() {
  return [
    { claim: "user, project, and local memory files and their load order", url: "https://code.claude.com/docs/en/memory.md", verified: "2026-07-28" },
    { claim: ".claude/rules/ recursive discovery, symlinks, and paths scoping", url: "https://code.claude.com/docs/en/memory.md", verified: "2026-07-28" },
    { claim: "skill discovery and SKILL.md frontmatter", url: "https://code.claude.com/docs/en/skills.md", verified: "2026-07-28" },
    { claim: "hook configuration in settings files", url: "https://code.claude.com/docs/en/hooks.md", verified: "2026-07-28" },
    { claim: "subagent definitions in .claude/agents/", url: "https://code.claude.com/docs/en/sub-agents.md", verified: "2026-07-28" },
    { claim: "hooks require a trusted workspace, which no static read can confirm", url: "https://code.claude.com/docs/en/hooks.md", verified: "2026-07-28" },
  ];
}

module.exports = {
  name: NAME,
  profileVersion: PROFILE_VERSION,
  detectContext,
  discoverSources,
  loadsAlways,
  discoverSkills,
  discoverAgents,
  discoverHooks,
  discoverRepoChecks,
  budgets,
  docs,
  // exported for the engine's compatibility re-export and its own tests
  findRuleMarkdownFiles,
};
