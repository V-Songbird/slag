"use strict";

// jig runners — the Claude-session half of the guard set. Everything a hook
// does lives here so `runner.js` stays the thin single-dispatch entry the hook
// wiring points at.
//
// Three properties this file exists to make mechanical rather than promised:
//
//   1. It can only deny what was proven. A guard denies when its own row asks
//      to arm and the proof hash recorded at install still matches the check on
//      disk. There is no session ladder and no probation: a check whose fixture
//      pair passed is proven at install (SCOPE, "Arming"), and a config
//      claiming a proof it does not have is not armed, whatever it says.
//   2. It cannot be turned into a matcher by editing the committed config. The
//      config is a trust boundary a teammate can edit, so a guard may only NAME
//      an installed check; supplying a pattern of its own is a hard rejection,
//      and the check it names is the one the proof hash binds.
//   3. It fails open, always. An unreadable config, an unreadable check, or an
//      outright bug leaves the tool call alone and leaves a ledger line saying
//      why.

const fs = require("fs");
const path = require("path");

// The engine owns the shared vocabulary: the schema version every jig artifact
// ships at and the directory they all live in. Re-declaring either here is how
// they would drift apart.
const { SCHEMA_VERSION, STATE_DIR, stripBom } = require("../scripts/jig.js");
// The one function that says what binds a proof to the check it proves. A
// second copy of that hashing rule here would be a second answer to the
// question admission already answered.
const { proofHash } = require("../scripts/admission.js");

const CONFIG_FILE = "config.json";
const LEDGER_FILE = "ledger.jsonl";
const OFF_FILE = "off";
const CHECKS_DIR = "checks";

// The closed runner set. A config naming anything else is invalid — the whole
// point of a closed set is that a teammate cannot introduce a new execution
// point by editing a JSON file.
const HOOK_RUNNERS = ["PreToolUse", "PostToolUse"];
const EVENT_TOOLS = { PreToolUse: ["Bash"], PostToolUse: ["Edit", "Write"] };

// The mode a guard takes when its own row asks for nothing. Observe is a
// choice the owner makes, never a probation a guard serves (SCOPE, "Does the
// ten-clean-session ladder survive").
const DEFAULT_MODE = "observe";

// No top-level `mode`. One word that silently arms twenty checks is too much
// blast radius, so a mode is only ever a guard's own (SCOPE, "Does top-level
// config.mode survive").
const CONFIG_KEYS = ["schemaVersion", "guards", "defaultBranches", "zones"];
const CONFIG_MODES = ["observe", "armed"];
const GUARD_KEYS = ["id", "check", "classId", "runner", "mode", "provenance", "proof"];

// Provenance rides the guard rather than the plan, because two mistakes out of
// one interview can be answered for differently. It is recorded and disclosed;
// it decides nothing at runtime, since what proves a check now is its fixture
// pair rather than where the answer came from.
const PROVENANCES = ["elicited", "forensic", "assumed"];

// A deny reply missing any of its three parts means the check was not armable
// and should have been discarded at admission. This is the backstop for one
// that got past it.
const DENY_PARTS = ["reason", "alternative", "override"];

// A check name is a file name under `.jig/checks/`, and the config naming it is
// a trust boundary a teammate can edit — so a name that could climb out of that
// directory is refused rather than normalized into one that cannot.
const CHECK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
// guard that can only name an installed check.
//
// Nothing here touches the filesystem, so the review surface and the tests can
// judge a config without one. Resolving the check the guard names is a separate
// step, below.

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
        problems.push(label + " carries its own `" + key + "` — a guard may only name an installed" +
          " check, never supply a matcher of its own");
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

    const check = typeof g.check === "string" ? g.check.trim() : "";
    if (!CHECK_NAME.test(check)) {
      problems.push(label + ": `check` must name a check installed under " + STATE_DIR + "/" +
        CHECKS_DIR + " — letters, digits, dot, dash and underscore only — and got " +
        JSON.stringify(g.check));
      return;
    }
    if (!HOOK_RUNNERS.includes(g.runner)) {
      problems.push(label + ": `runner` must be one of " + HOOK_RUNNERS.join(", ") + ", and got " +
        JSON.stringify(g.runner));
      return;
    }
    if (g.mode !== undefined && !CONFIG_MODES.includes(g.mode)) {
      problems.push(label + ": unknown mode " + JSON.stringify(g.mode));
      return;
    }
    // The proof is a hash, and a hash of the wrong type is a config that cannot
    // be checked against anything rather than one that happens not to match.
    if (g.proof !== undefined && typeof g.proof !== "string") {
      problems.push(label + ": `proof` must be the hash recorded when the check was admitted");
      return;
    }
    // An unrecognized provenance degrades to `assumed`: the weakest claim, and
    // the one the coverage matrix discloses.
    const provenance = PROVENANCES.includes(g.provenance) ? g.provenance : "assumed";
    guards.push({
      id, check, classId: typeof g.classId === "string" && g.classId ? g.classId : check,
      runner: g.runner, mode: g.mode || DEFAULT_MODE, provenance,
      proof: typeof g.proof === "string" ? g.proof : null,
    });
  });

  // Deterministic order, computed from the guard's identity rather than taken
  // from the config's array order — otherwise reordering the file would reorder
  // the ledger, and the ledger is the evidence the review surface reads.
  guards.sort((a, b) =>
    a.check < b.check ? -1 :
    a.check > b.check ? 1 :
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

// Comment syntax is language data, so the edition that knows the language
// declares it per extension and hands the map down as `opts.commentSyntax`.
// This table is only the floor for a file no edition claimed — without it a
// `.py` or `.ps1` file would be read with JavaScript comment rules and every
// commented-out line would come back as live code.
const DEFAULT_COMMENT_SYNTAX = {
  ".py": "hash", ".pyi": "hash", ".rb": "hash", ".ps1": "hash", ".psm1": "hash",
  ".pl": "hash", ".pm": "hash", ".r": "hash", ".sh": "hash", ".bash": "hash",
  ".zsh": "hash", ".yml": "hash", ".yaml": "hash", ".toml": "hash",
};

function commentStyle(rel, syntax) {
  const ext = path.extname(rel).toLowerCase();
  if (syntax && typeof syntax[ext] === "string") return syntax[ext];
  if (/^(?:Dockerfile|Makefile|makefile|GNUmakefile)(?:\.|$)/.test(path.basename(rel))) return "hash";
  return DEFAULT_COMMENT_SYNTAX[ext] || "slash";
}

// A `/` opens a regular expression only where a value may start. After a name,
// a number, or a closing bracket it is division. The known miss is `if (x)
// /re/.test(s)`, where the regex body stays visible to the patterns — a rare
// shape, and one that can only ever add a finding, never hide one.
function regexCanStart(prev) {
  return prev === "" || !/[)\]}\w$]/.test(prev);
}

// Both `stripComments` and `stripStrings` default to true: blanking more is the
// fewer-false-positives direction, so an edition that says nothing gets the
// safe reading. `strings` is the driver's older spelling of `stripStrings`.
//
// Comments and string literals are RECOGNISED unconditionally and only ERASED
// when asked. That separation is the whole fix for the third fault: with string
// bodies left visible, a scanner that stopped tracking them read the `//` in a
// URL as a comment and blanked the rest of the line, and the `/*` in a glob as
// a block comment and blanked the rest of the file.
function blankRegions(text, rel, opts) {
  const o = opts || {};
  const style = commentStyle(rel, o.commentSyntax);
  const stripComments = o.stripComments !== false;
  const stripStrings = o.stripStrings !== undefined ? o.stripStrings !== false : o.strings !== false;
  const out = text.split("");
  const erase = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const toLineEnd = (from) => {
    let j = from;
    while (j < text.length && text[j] !== "\n") j++;
    return j;
  };

  // A literal that never closes is not a literal: reading it as one is how a
  // lone apostrophe used to blank everything after it.
  const closedAt = (i, q, oneLine) => {
    let j = i + 1;
    while (j < text.length) {
      const d = text[j];
      if (d === "\\") { j += 2; continue; }
      if (d === q) return { body: i + 1, bodyEnd: j, end: j + 1 };
      if (d === "\n" && oneLine) return null;
      j++;
    }
    return null;
  };
  // Rust raw strings: `r"…"`, `r#"…"#`, `br##"…"##`. No escapes inside, and the
  // hash count picks the terminator, so a `"` in the body cannot end it early.
  const RAW = /(?:br|r)(#*)"/y;
  const literalAt = (i) => {
    const q = text[i];
    if (style === "hash") {
      if (q !== '"' && q !== "'") return null;
      // Python triple quotes span lines; consuming one whole is what keeps the
      // scanner in step with the rest of the file.
      if (text[i + 1] === q && text[i + 2] === q) {
        const close = text.indexOf(q + q + q, i + 3);
        return close === -1 ? null : { body: i + 3, bodyEnd: close, end: close + 3 };
      }
      return closedAt(i, q, true);
    }
    if (q === "r" || q === "b") {
      if (/[\w$]/.test(text[i - 1] || "")) return null;
      RAW.lastIndex = i;
      const m = RAW.exec(text);
      if (!m || m.index !== i) return null;
      const term = '"' + m[1];
      const body = i + m[0].length;
      const close = text.indexOf(term, body);
      return close === -1 ? null : { body, bodyEnd: close, end: close + term.length };
    }
    if (q === '"' || q === "'") return closedAt(i, q, true);
    // Template literals and Go raw strings both span lines.
    if (q === "`") return closedAt(i, q, false);
    return null;
  };

  let prev = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (style === "hash" && c === "#") {
      const end = toLineEnd(i);
      if (stripComments) erase(i, end);
      i = end;
      continue;
    }
    if (style === "slash" && c === "/" && text[i + 1] === "/") {
      const end = toLineEnd(i);
      if (stripComments) erase(i, end);
      i = end;
      continue;
    }
    if (style === "slash" && c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      if (stripComments) erase(i, end);
      i = end;
      continue;
    }
    const lit = literalAt(i);
    if (lit) {
      if (stripStrings) erase(lit.body, lit.bodyEnd);
      prev = text[lit.end - 1];
      i = lit.end;
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
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// The installed check
// ---------------------------------------------------------------------------
//
// The patterns a guard matches with live in the check module the owner
// approved and the fixture pair proved — not in the catalogue and not in the
// config (SCOPE, "The stance that replaces it"). An edition is 100–200 KB of
// language research and nothing on this path opens one: a tool call reads only
// the checks its own guards name.

const checkCache = new Map();

function loadCheck(root, name) {
  const file = statePath(root, CHECKS_DIR, name + ".check.mjs");
  const hit = checkCache.get(file);
  if (hit) return hit;
  let record;
  try {
    // `require` reads an ESM module synchronously, which is what keeps one tool
    // call one process with no await in it. The source is read alongside it
    // because the proof is over the bytes on disk, not over the parsed exports.
    record = { file, mod: require(file), source: fs.readFileSync(file, "utf-8") };
  } catch (err) {
    // First line only: a module-resolution error carries a require stack of
    // jig's own files, and a warning on a tool call is one line by contract.
    record = { file, problem: "the installed check `" + name + "` could not be read (" +
      String(err.message).split("\n")[0] + ")" };
  }
  checkCache.set(file, record);
  return record;
}

// A session guard's detectors are the check's own, selected by the runner they
// declare. A check with none for this event is an install that went wrong, and
// the caller says so out loud rather than passing silently.
function sessionDetectors(mod, runner) {
  const dets = mod && Array.isArray(mod.detectors) ? mod.detectors : [];
  return dets.filter((d) => isObject(d) && d.runner === runner &&
    Array.isArray(d.params && d.params.patterns) && d.params.patterns.length > 0);
}

// The check may state one deny reply for itself or one per detector; either way
// all three parts are required. Null means this guard cannot arm at all.
function denyOf(mod, det) {
  const deny = (det && det.deny) || (mod && mod.deny) || null;
  if (!isObject(deny)) return null;
  return DENY_PARTS.every((k) => typeof deny[k] === "string" && deny[k].trim()) ? deny : null;
}

// What binds a proof to the check it proves: the module as installed plus both
// inline fixtures, hashed by the same function that recorded the proof at
// admission. A check missing a fixture can no longer be proven, so it hashes to
// null and the guard stays in observe.
function checkProof(record) {
  const fixtures = (record.mod && record.mod.fixtures) || {};
  try {
    return proofHash(record.source, fixtures.violation, fixtures.nearMiss);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The arming gate
// ---------------------------------------------------------------------------
//
// A check whose fixture pair passed is proven at install, so what remains at
// runtime is integrity rather than probation: does the guard ask to arm, does
// the proof it recorded still describe the check on disk, and does a false
// positive stand against it. effectiveState is a pure truth table — every input
// arrives as an argument, nothing is read from disk here, and the tests walk
// every row. The order below is the order of authority.

// Enough glob for a zone path: `**` crosses separators, `*` does not. A zone
// can only ever force observe — it weakens, never matches content — which is
// why a glob in the committed config is not a matcher-smuggling hole.
function globToRegExp(glob) {
  let out = "";
  let depth = 0;
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
    } else if (c === "{") {
      depth++;
      out += "(?:";
    } else if (c === "}" && depth) {
      depth--;
      out += ")";
    } else if (c === "," && depth) {
      out += "|";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + out + ")".repeat(depth) + "$", "i");
}

function zoneForcesObserve(zones, filePath) {
  if (!isObject(zones) || !Array.isArray(zones.observe) || !filePath) return false;
  const rel = String(filePath).replace(/\\/g, "/");
  return zones.observe.some((g) => typeof g === "string" && globToRegExp(g).test(rel));
}

// evidence: { proof, deny, falsePositive } — the hash computed from the check
// on disk, the complete deny reply that check ships (null when it ships none),
// and whether a false positive stands against this guard. Returns { mode, why }
// — `why` is the bar that held, so a review surface can say why a guard is
// observing without re-deriving it.
function effectiveState(guard, config, filePath, evidence) {
  const e = evidence || {};
  if ((guard.mode || DEFAULT_MODE) !== "armed") return { mode: "observe", why: "not asked to arm" };
  // The backstop. A check with an incomplete deny triple is not armable and
  // should have been discarded at admission; reaching here means something
  // wrote a guard for a check that never earned one.
  if (!e.deny) {
    return { mode: "observe", why: "the check ships no complete deny reply, so it is not armable at all" };
  }
  if (!guard.proof) return { mode: "observe", why: "the guard records no proof of its check" };
  if (guard.proof !== e.proof) {
    return { mode: "observe", why: "the recorded proof does not match the check on disk" };
  }
  if (zoneForcesObserve(config.zones, filePath)) {
    return { mode: "observe", why: "a zone in the config forces observe for this path" };
  }
  if (e.falsePositive) {
    return { mode: "observe", why: "a recorded false positive holds this guard in observe" };
  }
  return { mode: "armed", why: "the recorded proof matches the check on disk and no false positive stands" };
}

// One pass over the ledger, stats for every guard at once. The arming model
// reads one fact from it: whether a false positive stands. The review skill
// raises one with {decision:"false-positive", guardId} and settles it with
// {decision:"false-positive-cleared", guardId} — the later line wins, because
// an append-only ledger is how a wave-off stays undoable. `fired` is carried
// for the review surface, which reports what each guard has done.
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
      standingFalsePositive: false, falsePositives: 0, fired: 0,
    });
    if (row.decision === "false-positive") {
      s.falsePositives++;
      s.standingFalsePositive = true;
    } else if (row.decision === "false-positive-cleared") {
      s.standingFalsePositive = false;
    } else if (row.decision === "would-deny" || row.decision === "deny") {
      s.fired++;
    }
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

function evalBash(det, payload, config) {
  const params = det.params || {};
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
function evalEdit(det, payload) {
  const params = det.params || {};
  const input = payload.tool_input || {};
  const rel = typeof input.file_path === "string" ? input.file_path : "";
  const after = String(input.new_string !== undefined ? input.new_string : (input.content || ""));
  const before = String(input.old_string || "");
  if (!after) return null;
  // The check states how its own language is read — which comments, which
  // string rules — because that is language data and the guard is one of six
  // editions' worth of them.
  const opts = {
    stripComments: params.stripComments,
    stripStrings: params.stripStrings,
    commentSyntax: params.commentSyntax,
  };
  const cleanAfter = blankRegions(after, rel, opts);
  const cleanBefore = before ? blankRegions(before, rel, opts) : "";
  for (const source of params.patterns || []) {
    const hits = (cleanAfter.match(new RegExp(source, "g")) || []).length;
    if (!hits) continue;
    if (params.onlyWhenIntroduced && hits <= (cleanBefore.match(new RegExp(source, "g")) || []).length) continue;
    return source;
  }
  return null;
}

// Returns { det, matched } for the first of the check's detectors that fired,
// or null. The PATTERN is what gets recorded, never the text it matched — the
// ledger is a record of which guard fired, and copying a line of the user's
// source into a log file is not that.
function evaluateGuard(dets, event, payload, config) {
  for (const det of dets) {
    const matched = event === "PreToolUse" ? evalBash(det, payload, config) : evalEdit(det, payload);
    if (matched) return { det, matched };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------
//
// `session` and `actor` ride every row because the review surface reports what
// each guard did and for which actor. They no longer feed an arming decision:
// nothing counts sessions any more.

function appendLedger(root, row) {
  fs.appendFileSync(statePath(root, LEDGER_FILE), JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
}

function ledgerRow(base, extra) {
  return {
    session: base.session,
    actor: extra.actor,
    guardId: extra.guardId,
    classId: extra.classId,
    mode: extra.mode || DEFAULT_MODE,
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
    return { jig: { event, mode: DEFAULT_MODE, decision: "pass", config: "invalid", guards: [] } };
  }

  const tools = EVENT_TOOLS[event] || [];
  const running = check.guards.filter((g) => g.runner === event && (!base.tool || tools.includes(base.tool)));
  // The ledger is read once, and only when some guard is asking to arm — a set
  // of observing guards never pays for it.
  const stats = running.some((g) => g.mode === "armed") ? ledgerStats(root) : {};
  const results = [];
  let deny = null;
  for (const guard of running) {
    const started = process.hrtime.bigint();
    const durMs = () => Math.round(Number(process.hrtime.bigint() - started) / 1e6 * 1000) / 1000;
    const record = loadCheck(root, guard.check);
    const dets = record.problem ? [] : sessionDetectors(record.mod, event);
    // A guard whose check will not load, or which carries nothing for this
    // event, is a broken install: it is reported once, out loud, and the tool
    // call goes through untouched.
    if (!dets.length) {
      const why = record.problem ||
        "the installed check `" + guard.check + "` declares no " + event + " detector";
      warn("jig: " + guard.id + " is not running — " + why);
      appendLedger(root, ledgerRow(base, {
        actor: null, guardId: guard.id, classId: guard.classId, decision: "pass", matched: null,
        mode: DEFAULT_MODE, durMs: durMs(), rest: { check: "unusable", why },
      }));
      results.push({ guardId: guard.id, classId: guard.classId, decision: "pass", matched: null, mode: DEFAULT_MODE });
      continue;
    }

    const hit = evaluateGuard(dets, event, payload, read.config);
    const det = hit ? hit.det : dets[0];
    const s = stats[guard.id];
    const eff = effectiveState(guard, read.config, base.path, {
      // The proof is hashed only for a guard that asked to arm. An observing
      // guard needs the check's patterns and nothing else.
      proof: guard.mode === "armed" ? checkProof(record) : null,
      deny: denyOf(record.mod, det),
      falsePositive: !!(s && s.standingFalsePositive),
    });
    // The only place a decision is ever named. "deny" is reachable through
    // exactly one door: effectiveState said armed, which means the deny reply,
    // the recorded proof, the zone and the false-positive record all held.
    const decision = hit ? (eff.mode === "armed" ? "deny" : "would-deny") : "pass";
    appendLedger(root, ledgerRow(base, {
      actor: det.actor || record.mod.actor || null, guardId: guard.id, classId: guard.classId,
      decision, matched: hit ? hit.matched : null, mode: eff.mode, durMs: durMs(),
      rest: { confidence: det.confidence || record.mod.confidence || null },
    }));
    results.push({
      guardId: guard.id, classId: guard.classId, decision,
      matched: hit ? hit.matched : null, mode: eff.mode,
    });
    if (decision === "deny" && !deny) deny = denyOf(record.mod, det);
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
  // to arm a guard whose check ships an incomplete triple, so a deny that
  // reaches here always carries reason, alternative and override.
  if (deny) {
    const reason = deny.reason + " Instead: " + deny.alternative + " To override: " + deny.override + ".";
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
  HOOK_RUNNERS, EVENT_TOOLS, DEFAULT_MODE, CONFIG_KEYS, CONFIG_MODES, GUARD_KEYS, MATCHER_KEYS,
  DEFAULT_BRANCHES, PROVENANCES, DENY_PARTS,
  CONFIG_FILE, LEDGER_FILE, OFF_FILE, CHECKS_DIR,
  statePath, isOff, isConfigured, readInput,
  readConfig, validateConfig,
  loadCheck, sessionDetectors, denyOf, checkProof,
  blankRegions, pushBranch, branchInScope, evaluateGuard,
  effectiveState, ledgerStats, zoneForcesObserve,
  appendLedger, runEvent,
};
