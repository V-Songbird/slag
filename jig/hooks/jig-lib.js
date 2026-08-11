"use strict";

// jig runners — the Claude-session half of the guard set (jig-brief §3, work
// item J2). Everything a hook does lives here so `runner.js` stays the thin
// single-dispatch entry the hook wiring points at.
//
// Three properties this file exists to make mechanical rather than promised:
//
//   1. It cannot deny. v1 clamps every guard to observe regardless of what the
//      config asks for (jig-brief §2 amendment 2), so a false positive on day
//      one costs a ledger line and nothing else. The clamp is one constant read
//      in one place, and the emitted object carries only jig-namespaced keys —
//      there is no code path that can produce a host control field.
//   2. It cannot be turned into a matcher by editing the committed config. The
//      config is a trust boundary a teammate can edit, so a guard may only NAME
//      a catalogue detector by class and index; supplying a pattern of its own
//      is a hard rejection. That is the injection firewall (jig-brief §3).
//   3. It fails open, always. An unreadable config, an invalid config, or an
//      outright bug leaves the tool call alone and leaves a ledger line saying
//      why.

const fs = require("fs");
const path = require("path");

// The engine owns the shared vocabulary: the schema version every jig artifact
// ships at and the directory they all live in. Re-declaring either here is how
// they would drift apart.
const { SCHEMA_VERSION, STATE_DIR, stripBom } = require("../scripts/jig.js");
const catalogue = require("../scripts/catalogue.json");

const CONFIG_FILE = "config.json";
const LEDGER_FILE = "ledger.jsonl";
const OFF_FILE = "off";

// The closed runner set. A config naming anything else is invalid — the whole
// point of a closed set is that a teammate cannot introduce a new execution
// point by editing a JSON file.
const HOOK_RUNNERS = ["PreToolUse", "PostToolUse"];
const EVENT_TOOLS = { PreToolUse: ["Bash"], PostToolUse: ["Edit", "Write"] };

// The default mode, and the only reachable one until a guard passes the
// arming gate. Deny is capability earned from ledger evidence, never a
// configuration default — see effectiveState below for the whole truth table.
const V1_MODE = "observe";

// The arming gate's evidence thresholds: how many clean observed sessions a
// guard needs, with zero recorded false positives, before "armed" in the
// config means what it says. A heuristic detector can be wrong by design, so
// it needs a longer clean record than a deterministic one. Any recorded false
// positive resets the count to the sessions after it.
const ARM_SESSIONS = { deterministic: 10, heuristic: 25 };

// Provenances that may ever arm. `assumed` is structurally barred forever
// (jig-brief §4.6) — quick-start installs observe until someone re-runs the
// interview and answers for real.
const ARMABLE_PROVENANCE = ["elicited", "forensic"];

const CONFIG_KEYS = ["schemaVersion", "mode", "guards", "defaultBranches", "zones"];
const CONFIG_MODES = ["observe", "armed"];
const GUARD_KEYS = ["id", "classId", "detector", "runner", "mode", "provenance"];

// Keys that would smuggle a matcher into the config. Listed by name and refused
// loudly, rather than ignored as "unknown", because silently dropping one would
// leave a user believing their pattern was installed.
const MATCHER_KEYS = ["patterns", "pattern", "regex", "params", "match", "command", "paths"];

// Where `<default>` resolves when the config does not say. Two names, because a
// repo is one or the other and guessing wrong only ever widens an observe-mode
// match.
const DEFAULT_BRANCHES = ["main", "master"];

// ---------------------------------------------------------------------------
// Paths and the two instant-exit checks
// ---------------------------------------------------------------------------

function statePath(root, ...parts) {
  return path.join(root, STATE_DIR, ...parts);
}

// The kill switch. Presence is the whole contract — the file's contents are
// never read, so `touch .jig/off` works from anywhere.
function isOff(root) {
  return fs.existsSync(statePath(root, OFF_FILE));
}

// A repository that never ran the interview has no config, and jig must cost it
// nothing beyond the process spawn itself. Both checks run before stdin is even
// read, which is what keeps the unconfigured path at bare-node cost.
function isConfigured(root) {
  return fs.existsSync(statePath(root, CONFIG_FILE));
}

function readInput() {
  try {
    return JSON.parse(stripBom(fs.readFileSync(0, "utf-8")) || "{}");
  } catch {
    return {};
  }
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Config validation — hand-written, per runner
// ---------------------------------------------------------------------------
//
// Hand-written rather than schema-driven because jig ships with no
// dependencies, and a JSON Schema library would be the first one. The rules
// below ARE the per-runner schema: a closed key set, a closed runner set, and a
// guard that can only point at catalogue data.

function classById(id) {
  return catalogue.classes.find((c) => c.id === id) || null;
}

function readConfig(root) {
  let raw;
  try {
    raw = fs.readFileSync(statePath(root, CONFIG_FILE), "utf-8");
  } catch (err) {
    return { problems: [STATE_DIR + "/" + CONFIG_FILE + " could not be read: " + err.message] };
  }
  try {
    return { problems: [], config: JSON.parse(stripBom(raw)) };
  } catch (err) {
    return { problems: [STATE_DIR + "/" + CONFIG_FILE + " is not valid JSON: " + err.message] };
  }
}

// Returns { problems, warnings, guards }. A non-empty `problems` means the whole
// config is refused and every guard is skipped — partial enforcement from a
// half-valid config would be the worst of both answers.
function validateConfig(raw) {
  const problems = [];
  const warnings = [];
  const guards = [];
  const done = () => ({ problems, warnings, guards });

  if (!isObject(raw)) {
    problems.push(CONFIG_FILE + " is not a JSON object");
    return done();
  }
  // Additive-only rule (jig-brief §5): this build reads schemaVersion 1 and
  // refuses anything higher, because a field it cannot see could be the one
  // that narrowed a guard.
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    problems.push(
      CONFIG_FILE + " is schemaVersion " + JSON.stringify(raw.schemaVersion) +
        " and this runner reads " + SCHEMA_VERSION,
    );
    return done();
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.includes(key)) warnings.push(CONFIG_FILE + ": ignoring unknown key `" + key + "`");
  }
  if (raw.mode !== undefined && !CONFIG_MODES.includes(raw.mode)) {
    problems.push(CONFIG_FILE + ": unknown mode " + JSON.stringify(raw.mode) +
      " (known: " + CONFIG_MODES.join(", ") + ")");
  }
  if (raw.defaultBranches !== undefined &&
      (!Array.isArray(raw.defaultBranches) || !raw.defaultBranches.every((b) => typeof b === "string" && b))) {
    problems.push(CONFIG_FILE + ": `defaultBranches` must be an array of branch names");
  }
  if (!Array.isArray(raw.guards)) {
    problems.push(CONFIG_FILE + " has no `guards` array");
    return done();
  }

  const seen = new Set();
  raw.guards.forEach((g, i) => {
    const label = "guards[" + i + "]";
    if (!isObject(g)) {
      problems.push(label + " is not an object");
      return;
    }
    for (const key of Object.keys(g)) {
      if (GUARD_KEYS.includes(key)) continue;
      if (MATCHER_KEYS.includes(key)) {
        problems.push(label + " carries its own `" + key + "` — a guard may only name a catalogue" +
          " detector, never supply a matcher of its own");
      } else {
        warnings.push(label + ": ignoring unknown key `" + key + "`");
      }
    }
    const id = typeof g.id === "string" ? g.id.trim() : "";
    if (!id) {
      problems.push(label + " is missing a string id");
      return;
    }
    if (seen.has(id)) {
      problems.push("duplicate guard id: " + id);
      return;
    }
    seen.add(id);

    const cls = typeof g.classId === "string" ? classById(g.classId) : null;
    if (!cls) {
      problems.push(label + ": " + JSON.stringify(g.classId) + " is not a class in the catalogue");
      return;
    }
    // The full dual-axis spine ships as data so forensics can rank against it.
    // Only the four installable classes may become a running guard.
    if (!cls.installableAtV1) {
      problems.push(label + ": the class " + cls.id + " ships as data at v1 and is not installable");
      return;
    }
    // A detector is named by its stable id, or by its index for configs written
    // before ids existed. Both resolve to the same row; the id survives a
    // reorder of the catalogue and the index does not, which is why generated
    // configs carry the id.
    let detIndex = -1;
    if (typeof g.detector === "string") {
      detIndex = cls.detectors.findIndex((d) => d.id === g.detector);
    } else if (Number.isInteger(g.detector)) {
      detIndex = g.detector >= 0 && g.detector < cls.detectors.length ? g.detector : -1;
    }
    if (detIndex < 0) {
      problems.push(label + ": `detector` must be one of " + cls.id + "'s detector ids (" +
        cls.detectors.map((d) => d.id).join(", ") + ") or an index below " + cls.detectors.length);
      return;
    }
    const det = cls.detectors[detIndex];
    if (!HOOK_RUNNERS.includes(det.runner)) {
      problems.push(label + ": " + cls.id + " detector " + det.id + " runs on `" + det.runner +
        "`, which is not a hook runner");
      return;
    }
    if (g.runner !== det.runner) {
      problems.push(label + ": declares runner " + JSON.stringify(g.runner) + " but " + cls.id +
        " detector " + det.id + " runs on `" + det.runner + "`");
      return;
    }
    if (g.mode !== undefined && !CONFIG_MODES.includes(g.mode)) {
      problems.push(label + ": unknown mode " + JSON.stringify(g.mode));
      return;
    }
    // Provenance rides the guard row so the arming gate can read it at
    // runtime. Anything unrecognized degrades to `assumed`, the value that can
    // never arm — the safe direction, same as the plan's own rule.
    const provenance = ARMABLE_PROVENANCE.includes(g.provenance) ? g.provenance : "assumed";
    guards.push({ id, classId: cls.id, detector: detIndex, detectorId: det.id, runner: det.runner, provenance, mode: g.mode, det });
  });

  // Deterministic order, computed from the guard's identity rather than taken
  // from the config's array order — otherwise reordering the file would reorder
  // the ledger, and the ledger is the evidence 0.2.0's arming gate reads.
  guards.sort((a, b) =>
    a.classId < b.classId ? -1 :
    a.classId > b.classId ? 1 :
    a.detector !== b.detector ? a.detector - b.detector :
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  return done();
}

// ---------------------------------------------------------------------------
// Comment and string blanking
// ---------------------------------------------------------------------------
//
// The same discipline as the check-driver template, ported by hand because the
// template is ESM text that gets byte-copied into user repos and this file
// cannot import it. Kept in step by the efficacy suite, which runs both sides
// over the same near-miss fixtures and fails when they disagree.
//
// Every blanked region keeps its length and its newlines. Blanking an Edit
// fragment can misread context a whole file would settle (a new_string that
// starts mid-string, say) — and a misread here only ever REMOVES a match. At
// observe mode that is the safe direction: a quiet miss for the guard, with
// the check driver still reading the whole file as the deterministic floor.

const HASH_COMMENT_EXT = new Set([".sh", ".bash", ".zsh", ".yml", ".yaml", ".toml"]);

function commentStyle(rel) {
  const base = path.basename(rel);
  if (base === "Dockerfile" || base.startsWith("Dockerfile.")) return "hash";
  return HASH_COMMENT_EXT.has(path.extname(rel).toLowerCase()) ? "hash" : "slash";
}

// A `/` opens a regular expression only where a value may start. After a name,
// a number, or a closing bracket it is division.
function regexCanStart(prev) {
  return prev === "" || !/[)\]}\w$]/.test(prev);
}

function blankRegions(text, rel) {
  const style = commentStyle(rel);
  const out = text.split("");
  const erase = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const toLineEnd = (from) => {
    let j = from;
    while (j < text.length && text[j] !== "\n") j++;
    return j;
  };

  let prev = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (style === "hash" && c === "#") {
      const end = toLineEnd(i);
      erase(i, end);
      i = end;
      continue;
    }
    if (style === "slash" && c === "/" && text[i + 1] === "/") {
      const end = toLineEnd(i);
      erase(i, end);
      i = end;
      continue;
    }
    if (style === "slash" && c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      erase(i, end);
      i = end;
      continue;
    }
    if (style === "slash" && c === "/" && regexCanStart(prev)) {
      let j = i + 1;
      let charClass = false;
      while (j < text.length) {
        const d = text[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") break;
        if (d === "[") charClass = true;
        else if (d === "]") charClass = false;
        else if (d === "/" && !charClass) { j++; break; }
        j++;
      }
      erase(i + 1, Math.max(i + 1, j - 1));
      prev = "/";
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length) {
        const d = text[j];
        if (d === "\\") { j += 2; continue; }
        if (d === c) { j++; break; }
        // A single- or double-quoted literal cannot span a line in valid
        // source; treating a stray newline as the end keeps one unbalanced
        // quote from blanking the rest of the payload.
        if (d === "\n" && c !== "`") break;
        j++;
      }
      erase(i + 1, Math.max(i + 1, j - 1));
      prev = c;
      i = j;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// The arming gate
// ---------------------------------------------------------------------------
//
// Deny is earned, never configured. effectiveState is a pure truth table:
// every input arrives as an argument, nothing is read from disk here, and the
// tests walk every row. The order below is the order of authority — a bar
// earlier in the list cannot be argued past by anything later.

// Enough glob for a zone path: `**` crosses separators, `*` does not. A zone
// can only ever force observe — it weakens, never matches content — which is
// why a glob in the committed config is not a matcher-smuggling hole.
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + out + "$", "i");
}

function zoneForcesObserve(zones, filePath) {
  if (!isObject(zones) || !Array.isArray(zones.observe) || !filePath) return false;
  const rel = String(filePath).replace(/\\/g, "/");
  return zones.observe.some((g) => typeof g === "string" && globToRegExp(g).test(rel));
}

// stats: { sessionsSinceReset, falsePositives } for this guard, from
// ledgerStats below. Returns { mode, why } — `why` is the bar that held, so a
// review surface can say why a guard is still observing without re-deriving.
function effectiveState(guard, config, filePath, stats) {
  const wanted = guard.mode || config.mode || V1_MODE;
  if (wanted !== "armed") return { mode: "observe", why: "not asked to arm" };
  if (!ARMABLE_PROVENANCE.includes(guard.provenance)) {
    return { mode: "observe", why: "provenance `" + guard.provenance + "` can never arm" };
  }
  const det = guard.det || {};
  if (!det.deny || !det.deny.reason || !det.deny.alternative || !det.deny.override) {
    return { mode: "observe", why: "the catalogue ships no complete deny reply for this detector" };
  }
  if (zoneForcesObserve(config.zones, filePath)) {
    return { mode: "observe", why: "a zone in the config forces observe for this path" };
  }
  const needed = ARM_SESSIONS[det.confidence] || ARM_SESSIONS.heuristic;
  const s = stats || { sessionsSinceReset: 0, falsePositives: 0 };
  if (s.falsePositives > 0 && s.sessionsSinceReset < needed) {
    return { mode: "observe", why: "a recorded false positive reset the clock at " +
      s.sessionsSinceReset + " of " + needed + " clean sessions" };
  }
  if (s.sessionsSinceReset < needed) {
    return { mode: "observe", why: "observed in " + s.sessionsSinceReset + " of " + needed +
      " clean sessions" };
  }
  return { mode: "armed", why: needed + " clean sessions and no standing false positive" };
}

// One pass over the ledger, stats for every guard at once. A false positive is
// a line the review skill wrote ({decision:"false-positive", guardId}); the
// clock restarts at the session after the latest one.
function ledgerStats(root) {
  let lines = [];
  try {
    lines = fs.readFileSync(statePath(root, LEDGER_FILE), "utf-8")
      .split("\n").filter((l) => l.trim());
  } catch {
    return {};
  }
  const stats = {};
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row.guardId) continue;
    const s = stats[row.guardId] || (stats[row.guardId] = {
      sessions: new Set(), sessionsSinceReset: 0, falsePositives: 0, fired: 0,
    });
    if (row.decision === "false-positive") {
      s.falsePositives++;
      s.sessions = new Set();
      continue;
    }
    if (row.decision === "would-deny" || row.decision === "deny") s.fired++;
    if (row.session) s.sessions.add(row.session);
  }
  for (const s of Object.values(stats)) {
    s.sessionsSinceReset = s.sessions.size;
    delete s.sessions;
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Guard evaluation
// ---------------------------------------------------------------------------

// The branch a `git push` names, or null when it names none. Read out of the
// command's own argv rather than by asking git, because a subprocess on every
// Bash call is exactly the standing tax jig promised not to be. A push with no
// branch named goes to the current one, which is unknowable here — so it stays
// in scope, and over-matching in observe mode costs a ledger line.
function pushBranch(command) {
  const m = /\bgit\s+push\b([^\n]*)/.exec(command);
  if (!m) return null;
  const words = m[1].trim().split(/\s+/).filter((w) => w && !w.startsWith("-"));
  return words.length >= 2 ? words[1] : null;
}

function branchInScope(command, onlyBranches, config) {
  const wanted = onlyBranches.flatMap((b) =>
    b === "<default>" ? (config.defaultBranches || DEFAULT_BRANCHES) : [b]);
  const named = pushBranch(command);
  return named === null || wanted.includes(named);
}

function evalBash(guard, payload, config) {
  const params = guard.det.params || {};
  const command = String((payload.tool_input && payload.tool_input.command) || "");
  if (!command) return null;
  for (const source of params.patterns || []) {
    if (!new RegExp(source).test(command)) continue;
    if (Array.isArray(params.onlyBranches) && !branchInScope(command, params.onlyBranches, config)) continue;
    return source;
  }
  return null;
}

// PostToolUse carries the edit, not the file's history. For an Edit that is
// enough: `onlyWhenIntroduced` compares the replacement against what it
// replaced. A Write supplies no prior text at all, so the whole payload counts
// as introduced — an over-match that is a ledger line and never a block.
// Both sides are blanked before matching, so a shape that lives only in a
// comment, a string, or a regular expression is not an introduction.
function evalEdit(guard, payload) {
  const params = guard.det.params || {};
  const input = payload.tool_input || {};
  const rel = typeof input.file_path === "string" ? input.file_path : "";
  const after = String(input.new_string !== undefined ? input.new_string : (input.content || ""));
  const before = String(input.old_string || "");
  if (!after) return null;
  const cleanAfter = blankRegions(after, rel);
  const cleanBefore = before ? blankRegions(before, rel) : "";
  for (const source of params.patterns || []) {
    const hits = (cleanAfter.match(new RegExp(source, "g")) || []).length;
    if (!hits) continue;
    if (params.onlyWhenIntroduced && hits <= (cleanBefore.match(new RegExp(source, "g")) || []).length) continue;
    return source;
  }
  return null;
}

// Returns the pattern that matched, or null. The PATTERN is what gets recorded,
// never the text it matched — the ledger is a record of which guard fired, and
// copying a line of the user's source into a log file is not that.
function evaluateGuard(guard, event, payload, config) {
  return event === "PreToolUse" ? evalBash(guard, payload, config) : evalEdit(guard, payload);
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------
//
// `session` and `actor` ship from day one (jig-brief §2 amendment 3): without
// them, 0.2.0's "arm only after N clean sessions" gate cannot read a single
// line of v1's observe data.

function appendLedger(root, row) {
  fs.appendFileSync(statePath(root, LEDGER_FILE), JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
}

function ledgerRow(base, extra) {
  return {
    session: base.session,
    actor: extra.actor,
    guardId: extra.guardId,
    classId: extra.classId,
    mode: extra.mode || V1_MODE,
    decision: extra.decision,
    tool: base.tool,
    matched: extra.matched,
    path: base.path,
    durMs: extra.durMs,
    ...extra.rest,
  };
}

// ---------------------------------------------------------------------------
// One event, start to finish
// ---------------------------------------------------------------------------

function runEvent(root, event, payload, warn) {
  const input = payload.tool_input || {};
  const base = {
    session: typeof payload.session_id === "string" ? payload.session_id : null,
    tool: typeof payload.tool_name === "string" ? payload.tool_name : null,
    path: typeof input.file_path === "string" ? input.file_path : null,
  };

  const read = readConfig(root);
  const check = read.problems.length ? { problems: read.problems, warnings: [], guards: [] }
                                     : validateConfig(read.config);
  for (const w of check.warnings) warn("jig: " + w);

  // Fail open, once, out loud. The committed config is a trust boundary; a
  // teammate breaking it must not silently disable the guards without trace,
  // and must not block anyone's tool call either.
  if (check.problems.length) {
    warn("jig: guards are off for this call — " + check.problems.join("; "));
    appendLedger(root, ledgerRow(base, {
      actor: "jig", guardId: null, classId: null, decision: "pass", matched: null,
      durMs: 0, rest: { config: "invalid", problems: check.problems },
    }));
    return { jig: { event, mode: V1_MODE, decision: "pass", config: "invalid", guards: [] } };
  }

  const tools = EVENT_TOOLS[event] || [];
  const running = check.guards.filter((g) => g.runner === event && (!base.tool || tools.includes(base.tool)));
  // The ledger is read once, and only when some guard is asking to arm — the
  // pure-observe path never pays for it.
  const wantsArming = running.some((g) => (g.mode || read.config.mode) === "armed");
  const stats = wantsArming ? ledgerStats(root) : {};
  const results = [];
  let deny = null;
  for (const guard of running) {
    const started = process.hrtime.bigint();
    const eff = effectiveState(guard, read.config, base.path, stats[guard.id]);
    const matched = evaluateGuard(guard, event, payload, read.config);
    const durMs = Number(process.hrtime.bigint() - started) / 1e6;
    // The only place a decision is ever named. "deny" is reachable through
    // exactly one door: effectiveState said armed, which means the provenance,
    // the deny reply, the zone, and the ledger evidence all held.
    const decision = matched ? (eff.mode === "armed" ? "deny" : "would-deny") : "pass";
    appendLedger(root, ledgerRow(base, {
      actor: guard.det.actor, guardId: guard.id, classId: guard.classId, decision, matched,
      mode: eff.mode,
      durMs: Math.round(durMs * 1000) / 1000, rest: { confidence: guard.det.confidence },
    }));
    results.push({ guardId: guard.id, classId: guard.classId, decision, matched, mode: eff.mode });
    if (decision === "deny" && !deny) deny = guard;
  }

  const out = {
    jig: {
      event,
      mode: results.some((r) => r.mode === "armed") ? "armed" : "observe",
      decision: results.some((r) => r.decision === "deny") ? "deny"
        : results.some((r) => r.decision === "would-deny") ? "would-deny" : "pass",
      guards: results,
    },
  };
  // The deny reply is schema-complete by construction: effectiveState refuses
  // to arm a detector whose catalogue entry lacks any of the three parts, so a
  // deny that reaches here always carries reason, alternative and override.
  if (deny) {
    const d = deny.det.deny;
    const reason = d.reason + " Instead: " + d.alternative + " To override: " + d.override + ".";
    if (event === "PreToolUse") {
      out.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      };
    } else {
      out.decision = "block";
      out.reason = reason;
    }
  }
  return out;
}

module.exports = {
  HOOK_RUNNERS, EVENT_TOOLS, V1_MODE, CONFIG_KEYS, GUARD_KEYS, MATCHER_KEYS, DEFAULT_BRANCHES,
  ARM_SESSIONS, ARMABLE_PROVENANCE,
  CONFIG_FILE, LEDGER_FILE, OFF_FILE,
  statePath, isOff, isConfigured, readInput,
  classById, readConfig, validateConfig,
  blankRegions, pushBranch, branchInScope, evaluateGuard,
  effectiveState, ledgerStats, zoneForcesObserve,
  appendLedger, runEvent,
};
