"use strict";

// [Foreman: 079] Codex host adapter.
//
// Same contract as adapters/claude.js: everything assay knows about *where Codex
// loads instructions from* lives here, the shared analyzers in ../assay.js
// consume only what these functions return, and nothing below the adapter looks
// at a filename to decide whether a file loads. Zero dependencies, including on
// assay.js — discovery only, no file contents parsed here.
//
// The one structural difference from the Claude profile: Codex's instruction
// system IS a directory chain. Every file from the project root down to the
// startup directory is read, in that order, and the startup directory is
// therefore a first-class input rather than a synonym for the root.
//
// Encoded from https://learn.chatgpt.com/docs/agent-configuration/agents-md,
// https://learn.chatgpt.com/docs/build-skills, https://learn.chatgpt.com/docs/hooks
// and https://developers.openai.com/plugins/build/plugins, all verified
// 2026-07-28. See docs() for one claim per encoded behavior.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
// [Foreman: 080] Two requires, both of them the shared kind: repository-level
// enforcement is not host knowledge, and Codex's hook configuration is real TOML
// with nested array-of-tables. No file contents are still parsed HERE — see
// readHookLayer, which hands the parsed document straight back out as discovery.
const { discoverRepoChecks: sharedRepoChecks } = require("./repo-checks.js");
const toml = require("../vendor/smol-toml.js");

const NAME = "codex";
// 2 = the AGENTS.md instruction chain plus skills, hooks, trust and packaging.
// 1 saw the chain alone.
const PROFILE_VERSION = 2;

// Per-directory selection order, ahead of any configured fallback names.
const OVERRIDE_NAME = "AGENTS.override.md";
const BASE_NAME = "AGENTS.md";

// "Codex skips empty files and stops adding files once the combined size reaches
// the limit defined by project_doc_max_bytes (32 KiB by default)."
const DEFAULT_MAX_BYTES = 32 * 1024;
// The doc shows `project_doc_fallback_filenames = ["TEAM_GUIDE.md", ".agents.md"]`
// as an EXAMPLE and documents no default list, so the default is no fallbacks at
// all. Inventing one would make assay discover a file Codex never reads.
const DEFAULT_FALLBACK_FILENAMES = [];

// [Foreman: 080] "This list uses at most 2% of the model's context window, or
// 8,000 characters when the context window is unknown." A static analyzer never
// learns which model a session runs, so the unknown-window figure is the only
// one it can apply — and it is the documented number for exactly this case.
const DEFAULT_SKILL_LISTING_CHARS = 8000;

// [Foreman: 079] What the shared analyzers may apply to this profile's sources.
// The engine reads this object; it never reads the host name. `wordingRubric:
// false` withdraws the Claude-derived wording levers — explicit-trigger
// requirement, must/always bonus, negative-grammar penalty, line-position
// penalty, task-distance penalty, worked-example bonus — and with them the
// hygiene score those factors sum to, because a grade is that rubric's summary.
// SCOPE.md's Codex profile ratifies this: those weights were measured on one
// host and carry no evidence here. It is not a statement that Codex prose cannot
// be analyzed — availability gates, staleness, conflicts, duplicates and missing
// escape hatches all still run, because none of them is a wording weight.
//
// [Foreman: 080] `skillRecipe: false` is the same withdrawal one surface over.
// The trigger recipe — quoted trigger phrases, an exclusion clause, a 1,536-char
// listing cap per description — was measured against one host's skill router,
// and Codex documents a different mechanism: a collective listing budget, an
// explicit-invocation path, and an implicit-routing policy switch per skill.
// Grading a Codex skill against the other host's recipe would be a score with no
// experiment behind it. What remains is everything the doc does define: required
// `name` and `description`, the `agents/openai.yaml` sidecar, duplicate names,
// and the listing budget.
const POLICY = { wordingRubric: false, skillRecipe: false };

// [Foreman: 080] The nouns the report uses for this host's mechanisms. Prose that
// names a Claude Code primitive or a `.claude/rules/` file is wrong under a Codex
// record, and the renderer must not learn a host name to fix that — so the words
// travel on the record like the policy does. A profile that declares none keeps
// the engine's defaults, which is why the Claude report is unchanged to the byte.
const NOUNS = {
  primitive: "Codex primitive",
  scopedRules: "narrower `AGENTS.md` files further down the chain",
};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

// `codex --version`, or null. Fails open on every axis, exactly like the Claude
// adapter's probe: no binary, a non-zero exit, a hang, an unparseable line. A
// host version is a label on the record and is never worth an exception. Codex
// is not installed on most machines assay runs on; null is an ordinary outcome.
function probeHostVersion() {
  const candidates = process.platform === "win32" ? ["codex.cmd", "codex"] : ["codex"];
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

// [Foreman: 080] Every TOML this profile reads goes through here, and it is a
// real parser now. 079 shipped a subset reader for two top-level scalars and left
// the upgrade path written down: vendor a pinned parser the day inline `[hooks]`
// tables need one. They do — Codex configures hooks as `[[hooks.SessionStart]]`
// array-of-tables with `[[hooks.SessionStart.hooks]]` nested inside them, and a
// hand-rolled reader that half-understands that syntax reports the wrong hooks
// rather than none. See vendor/VENDOR.md for the pin and its integrity hash.
//
// Malformed input throws in the parser and is caught by every caller; nothing
// here decides what a bad file means.
function parseToml(text) {
  return toml.parse(String(text));
}

// Parser errors carry a rendered source excerpt; a report wants the sentence.
function firstLine(message) {
  return String(message).split("\n")[0].trim();
}

// The effective Codex configuration for discovery: the instruction byte cap and
// the fallback filenames, each tagged with whether it was configured or is the
// documented default, so a report can say which number it applied and why.
//
// Absent or unreadable config.toml is the ordinary case and yields the
// documented defaults. A key that is present but not the shape the doc
// documents also yields the default, plus an issue the engine reports as a
// coverage gap — assay never guesses at a malformed value and never throws.
function readConfig(codexHome) {
  const file = path.join(codexHome, "config.toml");
  const config = {
    maxBytes: DEFAULT_MAX_BYTES,
    maxBytesSource: "default",
    fallbackFilenames: DEFAULT_FALLBACK_FILENAMES,
    fallbackFilenamesSource: "default",
    path: file,
  };
  let text;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    // ENOENT is the normal case: no config file, documented defaults apply.
    if (err.code !== "ENOENT") return { config, issue: { path: file, reason: err.code || err.message } };
    return { config, issue: null };
  }
  // [Foreman: 080] A config.toml the parser rejects is a coverage gap, not a
  // crash and not a reason to guess: the documented defaults apply and the
  // report says the file could not be read.
  let raw;
  try {
    raw = parseToml(text);
  } catch (err) {
    return { config, issue: { path: file, reason: "not valid TOML — " + firstLine(err.message) } };
  }
  const bad = [];
  if (raw.project_doc_max_bytes !== undefined) {
    if (Number.isInteger(raw.project_doc_max_bytes) && raw.project_doc_max_bytes > 0) {
      config.maxBytes = raw.project_doc_max_bytes;
      config.maxBytesSource = "configured";
    } else {
      bad.push("project_doc_max_bytes");
    }
  }
  if (raw.project_doc_fallback_filenames !== undefined) {
    const names = raw.project_doc_fallback_filenames;
    if (Array.isArray(names) && names.length && names.every((n) => typeof n === "string" && n)) {
      config.fallbackFilenames = names;
      config.fallbackFilenamesSource = "configured";
    } else {
      bad.push("project_doc_fallback_filenames");
    }
  }
  return {
    config,
    issue: bad.length ? { path: file, reason: "unreadable value for " + bad.join(", ") + " — documented defaults applied" } : null,
  };
}

// The context every later call is fixed against.
//
// `startupDirectory` is the mechanism, not a formality: Codex reads every
// AGENTS.md from the project root down to the directory it was started in, so
// two runs of the same repository from different directories receive different
// instructions. `userDir` null means user scope was switched off
// (--project-only) and the Codex home instruction file is not discovered — the
// configuration in that same directory is still read, because it is host
// configuration rather than an instruction source.
//
// CODEX_HOME is Codex's own documented variable for relocating that directory,
// and it doubles as the test seam ASSAY_USER_DIR is for the Claude profile.
function detectContext(opts = {}) {
  const projectRoot = path.resolve(opts.root || process.cwd());
  const startupDirectory = opts.startup ? path.resolve(opts.startup) : projectRoot;
  const codexHome = path.resolve(
    opts.codexHome || opts.userDir || process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
  );
  const { config, issue } = readConfig(codexHome);
  return {
    projectRoot,
    startupDirectory,
    userDir: opts.projectOnly ? null : codexHome,
    codexHome,
    // [Foreman: 080] Skills do NOT live under the Codex home: the doc puts
    // user-scope skills in `$HOME/.agents/skills` and admin-scope skills in
    // `/etc/codex/skills`. Null under --project-only, which is also what keeps a
    // fixture run off the developer's own machine-wide skills.
    agentsHome: opts.projectOnly ? null : path.resolve(opts.agentsHome || path.join(os.homedir(), ".agents")),
    adminSkillsDir: opts.projectOnly ? null : path.resolve(opts.adminSkillsDir || ADMIN_SKILLS_DIR),
    config,
    configIssue: issue,
    hostVersion: opts.probeHost ? probeHostVersion() : null,
  };
}

// ---------------------------------------------------------------------------
// Instruction sources
// ---------------------------------------------------------------------------

// The size of a candidate file, or null when there is nothing to select. A path
// that exists but cannot be measured is NOT nothing: it is recorded so the
// engine reports a coverage gap rather than assuming the file is absent.
function candidateSize(abs, label, inaccessible) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch (err) {
    if (err.code !== "ENOENT") inaccessible.push({ path: label, reason: err.code || err.message });
    return null;
  }
  if (!st.isFile()) {
    inaccessible.push({ path: label, reason: "not a file" });
    return null;
  }
  return st.size;
}

function relPath(root, abs) {
  const rel = path.relative(root, abs);
  return rel ? rel.split(path.sep).join("/") : path.basename(abs);
}

// Project root down to the startup directory, inclusive at both ends. Equal
// endpoints are a chain of one.
//
// razor: the project root is the root assay was pointed at. The doc says Codex
// starts at "the project root (typically the Git root)" and does not define the
// detection, so assay uses the root it was given rather than guessing at one; a
// startup directory outside that root is not a chain assay can describe, and
// collapses to the root alone.
function chainDirectories(ctx) {
  const rel = path.relative(ctx.projectRoot, ctx.startupDirectory);
  if (!rel) return [ctx.projectRoot];
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [ctx.projectRoot];
  const dirs = [ctx.projectRoot];
  let at = ctx.projectRoot;
  for (const part of rel.split(path.sep)) {
    at = path.join(at, part);
    dirs.push(at);
  }
  return dirs;
}

// Every documented instruction source Codex reads for this context, in
// documented read order: the Codex home file first, then the project chain from
// the root down. Discovery only — no file is opened, so a path that exists but
// cannot be read still arrives here and the engine's reader reports it as a
// coverage gap rather than dropping it.
//
// Same-directory selection is `AGENTS.override.md`, then `AGENTS.md`, then each
// configured fallback name in configured order; empty files are skipped, which
// is the one case where "skips empty files" is observable at selection time.
//
// [Foreman: 076] pattern, applied to a second host: the candidates that LOSE
// same-directory selection are still emitted, marked `selected: false` with
// `shadowedBy` naming the winner. Those files read like live policy and the host
// never opens them, so the audit parses them and reports their rules as shadowed
// instead of leaving the file invisible and the author believing it applies.
function discoverSources(ctx) {
  const sources = [];
  const inaccessible = [];
  if (ctx.configIssue) inaccessible.push(ctx.configIssue);

  const candidateNames = [OVERRIDE_NAME, BASE_NAME, ...(ctx.config.fallbackFilenames || [])];

  // One directory's selection: the first candidate present wins, every other
  // candidate present is emitted shadowed. `position` is that directory's place
  // in the read order, in words a reader can check against the table.
  const select = (dir, scope, precedence, position) => {
    const present = [];
    for (const name of candidateNames) {
      const abs = path.join(dir, name);
      const bytes = candidateSize(abs, scope === "user" ? abs : relPath(ctx.projectRoot, abs), inaccessible);
      // "Codex skips empty files" — a zero-byte candidate is not selected and
      // does not shadow the next name in the order.
      if (bytes) present.push({ name, abs, bytes });
    }
    if (!present.length) return;
    const [winner, ...losers] = present;
    const nameOf = (entry) => (scope === "user" ? entry.abs : relPath(ctx.projectRoot, entry.abs));
    const shared = { scope, kind: "memory", precedence };
    sources.push({
      ...shared,
      path: nameOf(winner),
      absPath: winner.abs,
      alwaysLoaded: true,
      bytes: winner.bytes,
      selectionReason: losers.length
        ? `${position} — \`${winner.name}\` selected over ${losers.map((l) => "`" + l.name + "`").join(", ")}`
        : `${position} — \`${winner.name}\` selected`,
    });
    for (const loser of losers) {
      sources.push({
        ...shared,
        path: nameOf(loser),
        absPath: loser.abs,
        alwaysLoaded: false,
        bytes: loser.bytes,
        selected: false,
        shadowedBy: nameOf(winner),
        selectionReason: `${position} — \`${winner.name}\` was selected here, so \`${loser.name}\` is never read`,
      });
    }
  };

  // Global scope: the Codex home directory, read before the project chain and
  // therefore outranked by every file in it.
  if (ctx.userDir) select(ctx.userDir, "user", 1, "Codex home, read before the project chain");

  const dirs = chainDirectories(ctx);
  dirs.forEach((dir, i) => {
    const where = i === 0 ? "." : relPath(ctx.projectRoot, dir);
    select(dir, "project", 2 + i, `chain position ${i + 1} of ${dirs.length} (\`${where}\`)`);
  });

  applyByteCap(sources, ctx.config.maxBytes);
  return { sources, inaccessible };
}

// The documented combined cap, applied over the selected sources in documented
// read order: "Codex skips empty files and stops adding files once the combined
// size reaches the limit defined by project_doc_max_bytes (32 KiB by default)".
//
// The cap is combined across the chain, not per file, so where it lands depends
// on everything read before it. Three outcomes, all recorded as facts ON the
// source so the engine — not this adapter — decides what finding they become:
//
//   - a source entirely below the cap loads whole;
//   - the source the cap lands inside carries `truncatedAtByte`, its own offset
//     where the combined total reaches the limit;
//   - a source that begins at or past the cap is never added: `loaded: false`.
//
// The middle case is a boundary, not a verdict. The doc stops at file
// granularity — "stops adding files once the combined size reaches the limit" —
// and never says whether the crossing file arrives whole or cut there. The
// fields record WHERE the boundary falls, which is documented; what to claim
// about the bytes after it is the engine's call, and the engine declines to
// claim non-delivery. The names `truncated` / `truncatedAtByte` are kept because
// they name the host concept the config key is named for.
function applyByteCap(sources, cap) {
  let at = 0;
  for (const source of sources) {
    if (source.selected === false) continue; // never read, so it costs nothing
    source.startsAtByte = at;
    if (at >= cap) {
      source.loaded = false;
      source.alwaysLoaded = false;
    } else {
      source.loaded = true;
      if (at + source.bytes > cap) {
        source.truncated = true;
        source.truncatedAtByte = cap - at;
      }
    }
    at += source.bytes;
  }
}

// Codex reads the whole selected chain at session start; there is no per-file
// scope declaration to consult, so the declared globs a Claude rules file would
// carry have no meaning here and are not read.
function loadsAlways(source) {
  if (source.selected === false) return false;
  if (source.loaded === false) return false;
  return source.alwaysLoaded === true;
}

// ---------------------------------------------------------------------------
// Skills — [Foreman: 080]
// ---------------------------------------------------------------------------

// "Codex scans for skills in multiple locations, scanning from your current
// working directory up to the repository root": that is the same directory set
// the instruction chain walks, so chainDirectories answers both questions.
const SKILLS_DIR = path.join(".agents", "skills");
const SKILL_FILE = "SKILL.md";
// The optional sidecar, at a fixed path relative to the skill root.
const SKILL_METADATA = path.join("agents", "openai.yaml");
// Machine-wide defaults. Documented as an absolute POSIX path; on a platform
// without one the read finds nothing, which is the honest answer rather than a
// guessed equivalent.
const ADMIN_SKILLS_DIR = "/etc/codex/skills";

// Every skill directory under one `.agents/skills`-shaped root. Discovery only:
// SKILL.md is located and its frontmatter is left for the engine, exactly as the
// Claude profile splits it. The sidecar's PRESENCE is discovery — its contents
// are YAML and belong to the engine's parser.
function skillsIn(dir, label, scope, source) {
  const found = [];
  let names;
  try {
    if (!fs.statSync(dir).isDirectory()) return found;
    names = fs.readdirSync(dir).sort();
  } catch {
    return found;
  }
  for (const name of names) {
    const abs = path.join(dir, name, SKILL_FILE);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue; // a directory without a SKILL.md is not a skill
    }
    if (!st.isFile()) continue;
    const metaAbs = path.join(dir, name, SKILL_METADATA);
    const entry = {
      name,
      path: label + name + "/" + SKILL_FILE,
      absPath: abs,
      scope,
      source,
    };
    let metaStat;
    try {
      metaStat = fs.statSync(metaAbs);
    } catch {
      metaStat = null;
    }
    if (metaStat && metaStat.isFile()) {
      entry.metadataPath = label + name + "/" + SKILL_METADATA.split(path.sep).join("/");
      entry.metadataAbsPath = metaAbs;
    }
    found.push(entry);
  }
  return found;
}

// The plugin manifest's `skills` path, resolved inside the plugin root. Manifest
// paths "are resolved relative to the plugin root and must stay inside that
// root", so one that escapes is not read.
function insideRoot(root, rel) {
  const abs = path.resolve(root, rel);
  const from = path.relative(root, abs);
  return !from.startsWith("..") && !path.isAbsolute(from) ? abs : null;
}

function readPluginManifest(root) {
  const file = path.join(root, ".codex-plugin", "plugin.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(file, "utf-8"));
    return manifest && typeof manifest === "object" ? manifest : null;
  } catch {
    return null; // no manifest here, or one that is not JSON — nothing to bundle
  }
}

// Every documented skill location a filesystem read can reach.
//
//   project — `.agents/skills` in every directory of the chain, root-first, plus
//             the skills this repository bundles as a Codex plugin;
//   user    — `$HOME/.agents/skills` and the admin `/etc/codex/skills`.
//
// Duplicate names are NOT resolved here, and not because it is hard: the doc
// says "if two skills share the same `name`, Codex doesn't merge them; both can
// appear in skill selectors". There is no winner to encode, so every copy is
// emitted and the engine reports the collision as the ambiguity it is.
//
// The system scope — skills "bundled by OpenAI" — has no documented path on
// disk, so it is a disclosed gap in coverageNotes rather than a guessed
// directory.
function discoverSkills(ctx) {
  const project = [];
  for (const dir of chainDirectories(ctx)) {
    const at = path.join(dir, SKILLS_DIR);
    const rel = relPath(ctx.projectRoot, at);
    project.push(...skillsIn(at, rel + "/", "project", rel));
  }
  const manifest = readPluginManifest(ctx.projectRoot);
  // The doc names no default for an omitted component path — the same reading
  // `project_doc_fallback_filenames` gets above: an example and no default means
  // the default is none. A manifest that declares no `skills` bundles no skills,
  // and guessing `./skills/` for it would report a surface nothing advertises.
  if (manifest && typeof manifest.skills === "string") {
    const abs = insideRoot(ctx.projectRoot, manifest.skills);
    if (abs) {
      const rel = relPath(ctx.projectRoot, abs);
      project.push(...skillsIn(abs, rel + "/", "plugin", ".codex-plugin/plugin.json"));
    }
  }
  const user = [];
  if (ctx.agentsHome) user.push(...skillsIn(path.join(ctx.agentsHome, "skills"), ctx.agentsHome + "/skills/", "user", "$HOME/.agents/skills"));
  if (ctx.adminSkillsDir) user.push(...skillsIn(ctx.adminSkillsDir, ctx.adminSkillsDir + "/", "admin", ADMIN_SKILLS_DIR));
  return { project, user };
}

// Codex documents no subagent definition format assay can read off disk. The
// SubagentStart/SubagentStop hook events prove subagents exist as a runtime
// concept; nothing documents where one is declared, so nothing is invented here.
function discoverAgents() {
  return [];
}

// ---------------------------------------------------------------------------
// Hooks and trust — [Foreman: 080]
// ---------------------------------------------------------------------------

// The documented event names, with the field each event's matcher filters on.
// These come from the hooks doc, not from the Claude profile's list — the two
// hosts share several names and neither one's set is the other's.
const HOOK_EVENTS = {
  SessionStart: "source", SessionEnd: "reason", SubagentStart: "agent_type",
  PreToolUse: "tool_name", PermissionRequest: "tool_name", PostToolUse: "tool_name",
  PreCompact: "trigger", PostCompact: "trigger", UserPromptSubmit: null,
  SubagentStop: "agent_type", Stop: null,
};

// The last path-shaped token of a hook command line names the script; the
// interpreter and env-var prefixes around it are noise. Same reduction the
// Claude profile applies, and it is the first of two guards on secrets — the
// engine redacts whatever survives it at render time.
function hookCommandLabel(cmd) {
  const clean = String(cmd).replace(/["']/g, "");
  const pathy = clean.split(/\s+/).filter((t) => /[\\/]/.test(t));
  const token = pathy.length ? pathy[pathy.length - 1] : clean.split(/\s+/)[0];
  return token.split(/[\\/]/).pop();
}

// One `hooks` object — from hooks.json or from a config file's `[hooks]` tables —
// flattened into entries. The two representations parse to the same shape, which
// is why one reader serves both.
function collectHooks(hooksObject, into, tag) {
  if (!hooksObject || typeof hooksObject !== "object") return;
  for (const event of Object.keys(hooksObject).sort()) {
    const groups = hooksObject[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      for (const hook of Array.isArray(group.hooks) ? group.hooks : []) {
        if (!hook || !hook.command) continue;
        into.push({ ...tag, event, matcher: group.matcher || "*", command: hookCommandLabel(hook.command) });
      }
    }
  }
}

// A layer is a directory that may hold hooks.json, a config.toml with inline
// `[hooks]` tables, or both. "If more than one hook source exists, Codex loads
// all matching hooks. Higher-precedence config layers don't replace
// lower-precedence hooks" — so nothing here collapses one file into another, and
// a layer holding both representations keeps both, with the documented
// startup warning attached to each as a limit.
function readHookLayer(layer, entries, inaccessible) {
  const found = [];
  const files = [];
  for (const [file, key] of [[layer.hooksJson, "json"], [layer.configToml, "toml"]]) {
    if (!file) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch (err) {
      if (err.code !== "ENOENT") inaccessible.push({ path: file, reason: err.code || err.message });
      continue;
    }
    let parsed;
    try {
      parsed = key === "json" ? JSON.parse(text) : parseToml(text);
    } catch (err) {
      inaccessible.push({ path: file, reason: `unreadable hook configuration — ${firstLine(err.message)}` });
      continue;
    }
    const before = found.length;
    collectHooks(parsed && parsed.hooks, found, { source: layer.source, scope: layer.scope, definedIn: layer.label(file) });
    if (found.length > before) files.push(key);
  }
  if (files.length === 2) {
    for (const entry of found) entry.mergedRepresentations = true;
  }
  entries.push(...found);
}

// The trust state chain for one hook, as the doc defines it — and only as the
// doc defines it. Every axis a static read cannot settle is "unknown"; none is
// assumed true because it usually is.
//
//   configured — the definition is in a file assay read. Always true here.
//   enabled    — the layer loads at all. Project-local hooks "load only when the
//                project `.codex/` layer is trusted", which is project trust and
//                is not on disk; `allow_managed_hooks_only` turns this false
//                outright for every non-managed source.
//   trusted    — the DEFINITION is trusted. "Codex records trust against the
//                hook's current hash, so new or changed hooks are marked for
//                review and skipped until trusted." The trust store is not a
//                file this profile reads, so a non-managed hook is unknown.
//                Managed hooks are "trusted by policy" and can be stated true.
//   applicable — would it fire for this session. Unknown wherever enabled is.
//   verified   — never true anywhere in assay. The engine sets it.
function hookStates(entry, managedOnly) {
  if (entry.scope === "managed") {
    return { states: { configured: true, enabled: true, trusted: true, applicable: true }, limitKeys: ["managedTrust", "notExecuted"] };
  }
  if (managedOnly) {
    return { states: { configured: true, enabled: false, trusted: "unknown", applicable: false }, limitKeys: ["managedOnly", "notExecuted"] };
  }
  if (entry.scope === "project") {
    return { states: { configured: true, enabled: "unknown", trusted: "unknown", applicable: "unknown" }, limitKeys: ["projectTrust", "hookHashTrust", "notExecuted"] };
  }
  return { states: { configured: true, enabled: true, trusted: "unknown", applicable: "unknown" }, limitKeys: ["hookHashTrust", "notExecuted"] };
}

// Everything a static read can reach of the hook configuration, in documented
// load order: user layer, project layer, managed requirements, plugin bundle.
// All of it is retained — a hook in a lower layer is still a hook.
function discoverHooks(ctx) {
  const entries = [];
  const inaccessible = [];
  const root = ctx.projectRoot;
  const rel = (file) => relPath(root, file);

  readHookLayer({
    source: "user", scope: "user", label: (f) => f,
    hooksJson: path.join(ctx.codexHome, "hooks.json"),
    configToml: path.join(ctx.codexHome, "config.toml"),
  }, entries, inaccessible);

  readHookLayer({
    source: "project", scope: "project", label: rel,
    hooksJson: path.join(root, ".codex", "hooks.json"),
    configToml: path.join(root, ".codex", "config.toml"),
  }, entries, inaccessible);

  // Enterprise-managed requirements: hooks defined inline under `[hooks]`, plus
  // the policy switch that disables every other source.
  const requirements = path.join(ctx.codexHome, "requirements.toml");
  let managedOnly = false;
  let managedConfig = null;
  try {
    managedConfig = parseToml(fs.readFileSync(requirements, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      inaccessible.push({ path: requirements, reason: err.code ? err.code : `unreadable managed policy — ${firstLine(err.message)}` });
    }
  }
  if (managedConfig) {
    managedOnly = managedConfig.allow_managed_hooks_only === true;
    collectHooks(managedConfig.hooks, entries, { source: "managed", scope: "managed", definedIn: requirements });
  }

  // A plugin's hooks default to `hooks/hooks.json` under its root; the manifest's
  // `hooks` field overrides that path and must stay inside the root. Only a
  // plugin assay can see on disk is reachable — this repository, when it is one.
  const manifest = readPluginManifest(root);
  if (manifest) {
    const abs = insideRoot(root, typeof manifest.hooks === "string" ? manifest.hooks : "./hooks/hooks.json");
    if (abs) {
      readHookLayer({
        source: "plugin: " + (typeof manifest.name === "string" && manifest.name ? manifest.name : path.basename(root)),
        scope: "plugin", label: rel, hooksJson: abs, configToml: null,
      }, entries, inaccessible);
    }
  }

  const seen = new Set();
  const hooks = entries.filter((e) => {
    const k = e.event + "|" + e.matcher + "|" + e.command + "|" + e.source + "|" + e.definedIn;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map(({ mergedRepresentations, ...e }) => {
    const { states, limitKeys } = hookStates(e, managedOnly);
    if (mergedRepresentations) limitKeys.unshift("mergedRepresentations");
    return {
      ...e, states, limitKeys,
      // An event name the doc does not list is reported as configured and
      // unrecognized rather than silently counted as covering something.
      knownEvent: e.event in HOOK_EVENTS,
      // What this event's matcher actually filters on, so a report never assumes
      // every matcher names a tool.
      matcherFilters: HOOK_EVENTS[e.event] || null,
      managedOnly,
    };
  });
  // A hook layer that exists and could not be read is a hole in the ladder. The
  // engine folds these into the same list the repository checks use, where the
  // report already says "any gate there is missing from this ladder".
  return { hooks, inaccessible };
}

// [Foreman: 080] The shared half of level 4 and 5, now that this profile has the
// rungs below it filled in. Nothing about npm scripts or CI workflows is
// host-flavored, so this profile adds nothing on top either.
function discoverRepoChecks(ctx) {
  return sharedRepoChecks(ctx.projectRoot);
}

// ---------------------------------------------------------------------------
// Supported mutation targets — [Foreman: 082]
// ---------------------------------------------------------------------------

// Same declaration the Claude profile makes, and a different answer on every
// line — which is the point. An authoring flow reads this off the record; it
// never learns that "codex" means AGENTS.md. The chain is what makes a target
// choice a real decision here: a rule in the root file reaches every session,
// and the same rule one directory down reaches only sessions started there.
//
// `AGENTS.override.md` is listed because it is a documented, supported target —
// with the consequence stated, since writing one silences the `AGENTS.md` beside
// it entirely.
const TARGETS = {
  rule: {
    docs: "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
    places: [
      {
        path: "AGENTS.md",
        scope: "project",
        kind: "memory",
        scoping: "the chain root — read by a session started anywhere in the repository",
      },
      {
        path: "<subdirectory>/AGENTS.md",
        scope: "project",
        kind: "memory",
        scoping: "read only by a session started in that directory or below it, and read after the root file, so it is the later word",
      },
      {
        path: "AGENTS.override.md",
        scope: "project",
        kind: "memory",
        scoping: "wins same-directory selection — the `AGENTS.md` beside it is then never read at all",
      },
    ],
  },
  skill: {
    docs: "https://learn.chatgpt.com/docs/build-skills",
    dir: ".agents/skills/<name>/",
    file: "SKILL.md",
    // Both are documented as required frontmatter here; the Claude profile
    // requires only one of them.
    requires: ["name", "description"],
    // The sidecar carrying UI metadata, the implicit-invocation switch, and the
    // skill's tool dependencies. Optional to the host, so it is a target rather
    // than a requirement — but nothing else can express those three things.
    metadata: ["agents/openai.yaml"],
  },
  hook: {
    docs: "https://learn.chatgpt.com/docs/hooks",
    path: ".codex/hooks.json",
  },
};

// ---------------------------------------------------------------------------
// Budgets and provenance
// ---------------------------------------------------------------------------

// Codex DOES document a hard cap, so the profile reports one: the effective
// amount, whether it came from config.toml or the documented default, and the
// documentation behind it. `ctx` is optional so a caller can ask what the
// documented default is without fixing a context first.
function budgets(ctx) {
  const config = (ctx && ctx.config) || {};
  const amount = Number.isInteger(config.maxBytes) ? config.maxBytes : DEFAULT_MAX_BYTES;
  return {
    documented: {
      amount,
      unit: "bytes",
      scope: "combined across the instruction chain, in read order",
      source: config.maxBytesSource === "configured" ? "configured" : "default",
      claim: "project_doc_max_bytes caps the combined size of the instruction chain (32 KiB by default)",
      url: "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
      verified: "2026-07-28",
    },
    // [Foreman: 080] The second documented budget, and a different one: not the
    // instruction bytes a session reads, but the characters the initial SKILL
    // LIST costs before any skill is selected. "This list uses at most 2% of the
    // model's context window, or 8,000 characters when the context window is
    // unknown." assay never knows which model a session will run, so the
    // documented unknown-window number IS this profile's number — the 2% form is
    // reported alongside it rather than being computed against a guess.
    skillListing: {
      amount: DEFAULT_SKILL_LISTING_CHARS,
      unit: "characters",
      scope: "combined across every listed skill's name and description, before any skill is selected",
      source: "default",
      claim: "the initial skill list uses at most 2% of the context window, or 8,000 characters when it is unknown; Codex shortens descriptions first and may omit skills entirely for large sets",
      url: "https://learn.chatgpt.com/docs/build-skills",
      verified: "2026-07-28",
    },
  };
}

// What this profile encodes and where the documentation says so. Every claim is
// re-read before the date below moves.
function docs() {
  const url = "https://learn.chatgpt.com/docs/agent-configuration/agents-md";
  const skills = "https://learn.chatgpt.com/docs/build-skills";
  const hooks = "https://learn.chatgpt.com/docs/hooks";
  const plugins = "https://developers.openai.com/plugins/build/plugins";
  return [
    { claim: "global scope: CODEX_HOME (default ~/.codex) is read first, AGENTS.override.md before AGENTS.md", url, verified: "2026-07-28" },
    { claim: "project scope: the chain runs from the project root down to the current working directory", url, verified: "2026-07-28" },
    { claim: "per-directory selection order is AGENTS.override.md, AGENTS.md, then configured fallback names", url, verified: "2026-07-28" },
    { claim: "project_doc_fallback_filenames names extra candidates; the doc gives an example and no default, so the default is none", url, verified: "2026-07-28" },
    { claim: "merge order concatenates from the root down, so a file nearer the working directory is the later word", url, verified: "2026-07-28" },
    { claim: "project_doc_max_bytes caps the COMBINED size (32 KiB by default); Codex skips empty files and stops adding files at the limit", url, verified: "2026-07-28" },
    { claim: "CODEX_HOME relocates the Codex home directory, which is where config.toml lives", url, verified: "2026-07-28" },
    // [Foreman: 080] Skills.
    { claim: "repository skills live in `.agents/skills`, scanned from the working directory up to the repository root", url: skills, verified: "2026-07-28" },
    { claim: "user skills live in $HOME/.agents/skills and admin skills in /etc/codex/skills; system skills are bundled and have no documented path on disk", url: skills, verified: "2026-07-28" },
    { claim: "a skill is a directory holding a required SKILL.md whose frontmatter requires `name` and `description`", url: skills, verified: "2026-07-28" },
    { claim: "the optional `agents/openai.yaml` sidecar carries interface metadata, `policy.allow_implicit_invocation`, and tool dependencies", url: skills, verified: "2026-07-28" },
    { claim: "two skills sharing a name are not merged — both can appear in skill selectors", url: skills, verified: "2026-07-28" },
    { claim: "the initial skill list uses at most 2% of the context window, or 8,000 characters when it is unknown; descriptions are shortened first and skills may be omitted entirely", url: skills, verified: "2026-07-28" },
    { claim: "explicit invocation names a skill directly; implicit routing matches the description, and allow_implicit_invocation false switches it off", url: skills, verified: "2026-07-28" },
    // [Foreman: 080] Hooks and trust.
    { claim: "hooks are configured in hooks.json and in inline [[hooks.Event]] tables in config.toml, in the Codex home and in the project .codex layer", url: hooks, verified: "2026-07-28" },
    { claim: "if more than one hook source exists Codex loads all matching hooks — a higher-precedence layer does not replace a lower one", url: hooks, verified: "2026-07-28" },
    { claim: "a single layer holding both hooks.json and inline [hooks] has them merged, and Codex warns at startup", url: hooks, verified: "2026-07-28" },
    { claim: "project-local hooks load only when the project .codex layer is trusted", url: hooks, verified: "2026-07-28" },
    { claim: "trust is recorded against a hook definition's hash, so a new or changed definition is marked for review and skipped until trusted", url: hooks, verified: "2026-07-28" },
    { claim: "managed hooks from requirements.toml and other managed layers are trusted by policy and cannot be disabled from the hook browser", url: hooks, verified: "2026-07-28" },
    { claim: "allow_managed_hooks_only skips hooks from user, project, session, and plugin sources while managed hooks still load", url: hooks, verified: "2026-07-28" },
    { claim: "plugin-bundled hooks default to hooks/hooks.json under the plugin root and are not trusted by installation alone", url: hooks, verified: "2026-07-28" },
    { claim: "the hook events are SessionStart, SessionEnd, SubagentStart, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, SubagentStop, Stop, each with its own matcher field", url: hooks, verified: "2026-07-28" },
    // [Foreman: 080] Packaging.
    { claim: ".codex-plugin/plugin.json requires name, version, and description, and its component paths resolve relative to the plugin root and must stay inside it", url: plugins, verified: "2026-07-28" },
  ];
}

// What the audit must disclose about this profile whatever it finds. Coverage is
// a promise about what was looked at, so the limits travel with the adapter that
// owns them rather than being restated by a renderer.
function coverageNotes() {
  return [
    // [Foreman: 080] Each line is a scope a live host has and a file read does
    // not. None of them is a maybe: they are named so an empty section is never
    // read as "nothing configured".
    "codex skills: the system scope — skills bundled by the host — has no documented path on disk and was not looked for",
    "codex skills: only plugin skills this repository bundles are visible; a plugin installed elsewhere on the machine is not discoverable from a file read",
    "codex hooks: trust is stored by the host, not in a file this profile reads — every non-managed hook is reported as configured with its trust unconfirmed",
    "codex hooks: managed layers installed by MDM outside the Codex home are not reachable from here",
    "codex packaging: the .codex-plugin manifest is checked against the documented required fields — no Codex host has installed it or opened a session from it",
    "no live Codex host was probed — this profile is encoded from the official documentation verified 2026-07-28 and exercised against fixtures",
  ];
}

module.exports = {
  name: NAME,
  profileVersion: PROFILE_VERSION,
  policy: POLICY,
  nouns: NOUNS,
  targets: TARGETS, // [Foreman: 082]
  detectContext,
  discoverSources,
  loadsAlways,
  discoverSkills,
  discoverAgents,
  discoverHooks,
  discoverRepoChecks,
  budgets,
  docs,
  coverageNotes,
  // exported for the adapter's own tests
  parseToml,
  chainDirectories,
  HOOK_EVENTS,
  DEFAULT_MAX_BYTES,
  DEFAULT_SKILL_LISTING_CHARS,
};
