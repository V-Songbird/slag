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
// verified 2026-07-28. See docs() for one claim per encoded behavior.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const NAME = "codex";
// 1 = the documented AGENTS.md instruction chain. Skills, hooks and packaging
// are the next profile version's surface.
const PROFILE_VERSION = 1;

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
const POLICY = { wordingRubric: false };

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

// razor: top-level scalars and one-line string arrays only. No tables, no
// dotted keys, no multi-line arrays, no escapes inside strings — parsing stops
// at the first `[table]` header because everything after one belongs to that
// table and this reader owns the root only. Two keys do not justify a
// dependency. Upgrade path: vendor a pinned TOML parser when entry 080's inline
// `[hooks]` tables need one, and delete this function.
function parseTopLevelToml(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) break;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    const value = line.slice(eq + 1).trim();
    if (value.startsWith("[")) {
      out[key] = [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
    } else if (value.startsWith('"') || value.startsWith("'")) {
      const quoted = value.match(/^"([^"]*)"|^'([^']*)'/);
      out[key] = quoted ? (quoted[1] !== undefined ? quoted[1] : quoted[2]) : value;
    } else {
      const scalar = value.split("#")[0].trim();
      out[key] = /^-?\d+$/.test(scalar) ? Number(scalar) : scalar;
    }
  }
  return out;
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
  const raw = parseTopLevelToml(text);
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
// Skills, subagents, hooks, repository checks
// ---------------------------------------------------------------------------

// razor: profile version 1 is the instruction chain and nothing else. Codex
// documents `.agents/skills`, `agents/openai.yaml`, `hooks.json` and inline
// `[hooks]` config tables, and every one of them is entry 080's surface. Each
// function below returns the shape the engine expects for a project with none of
// them, so the ladder renders empty rather than wrong — and coverage says so out
// loud rather than letting an empty section read as "nothing configured".
function discoverSkills() {
  return { project: [], user: [] };
}

function discoverAgents() {
  return [];
}

function discoverHooks() {
  return [];
}

// razor: the npm/pre-commit/workflow detection in adapters/claude.js is
// host-agnostic and would work here verbatim, but copying it now would ship a
// level-4 ladder under a profile whose level-2 and level-3 rungs are still
// empty — a picture more misleading than an empty one. It lands with 080, when
// the rest of the ladder does, and that is when the shared half is worth
// extracting into one place.
function discoverRepoChecks() {
  return { checks: [], inaccessible: [] };
}

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
  };
}

// What this profile encodes and where the documentation says so. Every claim is
// re-read before the date below moves.
function docs() {
  const url = "https://learn.chatgpt.com/docs/agent-configuration/agents-md";
  return [
    { claim: "global scope: CODEX_HOME (default ~/.codex) is read first, AGENTS.override.md before AGENTS.md", url, verified: "2026-07-28" },
    { claim: "project scope: the chain runs from the project root down to the current working directory", url, verified: "2026-07-28" },
    { claim: "per-directory selection order is AGENTS.override.md, AGENTS.md, then configured fallback names", url, verified: "2026-07-28" },
    { claim: "project_doc_fallback_filenames names extra candidates; the doc gives an example and no default, so the default is none", url, verified: "2026-07-28" },
    { claim: "merge order concatenates from the root down, so a file nearer the working directory is the later word", url, verified: "2026-07-28" },
    { claim: "project_doc_max_bytes caps the COMBINED size (32 KiB by default); Codex skips empty files and stops adding files at the limit", url, verified: "2026-07-28" },
    { claim: "CODEX_HOME relocates the Codex home directory, which is where config.toml lives", url, verified: "2026-07-28" },
    { claim: "skills, hooks and plugin packaging are documented surfaces this profile version does not yet discover", url: "https://learn.chatgpt.com/docs/build-skills", verified: "2026-07-28" },
  ];
}

// What the audit must disclose about this profile whatever it finds. Coverage is
// a promise about what was looked at, so the limits travel with the adapter that
// owns them rather than being restated by a renderer.
function coverageNotes() {
  return [
    "codex profile v1: instruction chain only — skills, hooks, and packaging land with entry 080",
    "no live Codex host was probed — this profile is encoded from the official documentation verified 2026-07-28 and exercised against fixtures",
  ];
}

module.exports = {
  name: NAME,
  profileVersion: PROFILE_VERSION,
  policy: POLICY,
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
  parseTopLevelToml,
  chainDirectories,
  DEFAULT_MAX_BYTES,
};
