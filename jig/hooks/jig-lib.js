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

// `vocab.js` owns the shared vocabulary: the schema version every jig artifact
// ships at, the directory they all live in, and the pure helpers that read
// them. Re-declaring any of it here is how the two halves would drift apart —
// and requiring the engine for it is what made every hook spawn parse five
// thousand lines it never called into (`tests/runner.test.js` holds this
// boundary open).
const {
  SCHEMA_VERSION, STATE_DIR, VERIFY_FILE, SHELL_TOOLS,
  stripBom, fixturePath, proposedVerifyEntries,
} = require("../scripts/vocab.js");
// The one function that says what binds a proof to the check it proves. A
// second copy of that hashing rule here would be a second answer to the
// question admission already answered.
const { proofHash, fencedHalves, SESSION_PARAMS } = require("../scripts/admission.js");

const CONFIG_FILE = "config.json";
const LEDGER_FILE = "ledger.jsonl";
const OFF_FILE = "off";
const CHECKS_DIR = "checks";

// The closed runner set. A config naming anything else is invalid — the whole
// point of a closed set is that a teammate cannot introduce a new execution
// point by editing a JSON file.
const HOOK_RUNNERS = ["PreToolUse", "PostToolUse"];
const EVENT_TOOLS = { PreToolUse: [...SHELL_TOOLS, "Edit", "Write"], PostToolUse: ["Edit", "Write"] };

// Which tools each session lever reads. Two levers share PreToolUse now — a
// shell command and an edit payload arrive on the same event — so the EVENT can
// no longer say how a detector's params are read. Its lever does. `edit-guard`
// denies before the bytes land; `edit-observe-guard` is the PostToolUse lever
// installs made before 2.11.0 carry, and it keeps working exactly as it was
// until its owner migrates it, because the proof hash recorded for it binds the
// lever it was admitted on.
const LEVER_TOOLS = {
  // Every shell tool a host may name, not the one lever's name. A command is a
  // command whichever tool ran it, and the patterns are the author's problem —
  // a lever that never evaluates is the worse failure.
  "bash-guard": SHELL_TOOLS,
  "edit-guard": ["Edit", "Write"],
  "edit-observe-guard": ["Edit", "Write"],
};

// The events the runner dispatches, which is deliberately wider than the set a
// guard may name. The three added here carry no guard and can carry none: two
// witness a verification run, one reads those rows back at the completion
// moment. Keeping them out of HOOK_RUNNERS is what stops a hand-edited config
// naming `runner: "Stop"` and inventing an execution point nothing proves.
const STOP_EVENTS = ["Stop", "SubagentStop"];
const HOOK_EVENTS = [...HOOK_RUNNERS, "PostToolUseFailure", ...STOP_EVENTS];

// The mode a guard takes when its own row asks for nothing. Observe is a
// choice the owner makes, never a probation a guard serves (SCOPE, "Does the
// ten-clean-session ladder survive").
const DEFAULT_MODE = "observe";

// No top-level `mode`. One word that silently arms twenty checks is too much
// blast radius, so a mode is only ever a guard's own (SCOPE, "Does top-level
// config.mode survive").
const CONFIG_KEYS = ["schemaVersion", "guards", "defaultBranches", "zones"];
const CONFIG_MODES = ["observe", "armed"];
const GUARD_KEYS = ["id", "check", "classId", "runner", "mode", "provenance", "proof", "teach"];

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
  // Additive-only rule: this build reads schemaVersion 1 and
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
    // Teaching is opt-in per guard and off unless this row says otherwise
    // (SCOPE, "Does an observing guard teach by default"). A non-boolean is a
    // config that cannot be read as an answer rather than one that happens to
    // be false.
    if (g.teach !== undefined && typeof g.teach !== "boolean") {
      problems.push(label + ": `teach` must be true or false, and got " + JSON.stringify(g.teach));
      return;
    }
    // The channel is `additionalContext`, and 2.13.0 measured it on both
    // runners rather than assuming either: roadmap 233 drove a live host where a
    // PreToolUse reply carrying `additionalContext` and no `permissionDecision`
    // reached the model and refused nothing. So teaching is a property of the
    // guard the owner opted in, not of the event it happens to run on — which is
    // what makes it reachable on `edit-guard`, the edit lever a fresh install
    // actually gets.
    // An unrecognized provenance degrades to `assumed`: the weakest claim, and
    // the one the coverage matrix discloses.
    const provenance = PROVENANCES.includes(g.provenance) ? g.provenance : "assumed";
    guards.push({
      id, check, classId: typeof g.classId === "string" && g.classId ? g.classId : check,
      runner: g.runner, mode: g.mode || DEFAULT_MODE, provenance,
      proof: typeof g.proof === "string" ? g.proof : null,
      teach: g.teach === true,
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
//
// `tool` narrows further, and only a caller holding a real payload has it: a
// bash-guard and an edit-guard both declare PreToolUse, and running one over the
// other's payload would match a shell pattern against a file's contents.
// A detector on a lever this build does not run is dropped WITH the tool
// unnarrowed too, so the caller's "does this check carry anything for this
// event" question answers no and the broken install is reported. Narrowing on
// the tool alone made an unknown lever look like a guard reading another tool,
// which is a coverage hole that said nothing.
function sessionDetectors(mod, runner, tool) {
  const dets = mod && Array.isArray(mod.detectors) ? mod.detectors : [];
  return dets.filter((d) => isObject(d) && d.runner === runner && leverTools(d).length &&
    (!tool || leverTools(d).includes(tool)) && hasMatcher(d));
}

// What a session detector matches WITH, either kind of it. A removal detector
// names no `patterns` and is a detector all the same; reading only `patterns`
// here is what let a removal check admit and then guard nothing at all.
function hasMatcher(det) {
  const p = (det && det.params) || {};
  return SESSION_PARAMS.some((k) => Array.isArray(p[k]) && p[k].length > 0);
}

// A lever this build does not run reads no tool at all, which is what keeps an
// unknown lever from being evaluated as an edit by default.
function leverTools(det) {
  return (det && LEVER_TOOLS[det.lever]) || [];
}

// A command lever, whichever shell tool the host names. Asked here rather than
// spelled `includes("Bash")` at each call site: three files used to carry that
// literal, and one of them being missed is how the win32 lane went quiet.
function isShellLever(det) {
  return SHELL_TOOLS.some((t) => leverTools(det).includes(t));
}

// The check may state one deny reply for itself or one per detector; either way
// all three parts are required. Null means this guard cannot arm at all.
function denyOf(mod, det) {
  const deny = (det && det.deny) || (mod && mod.deny) || null;
  if (!isObject(deny)) return null;
  return DENY_PARTS.every((k) => typeof deny[k] === "string" && deny[k].trim()) ? deny : null;
}

// The words a blocked call reads, composed in one place. The guard id leads,
// because a refusal that will not say which guard refused leaves the caller
// nothing to look up; the false-alarm line closes it, because a caller who
// thinks the guard is wrong needs the command rather than a search. jig's plan
// renders through this same function, so the owner approves the exact string
// that ships.
// `hasDriver` adds one sentence pointing at the harness: the deny reply is
// jig's only channel to the model and it fires after the fact, so the refusal
// is also the one place worth saying what to run next. Gated on the driver
// existing — an install with guards and no `run.mjs` would otherwise name a
// file that is not there.
// Each of the three is closed here rather than trusted to have closed itself:
// the triple is authored prose and jig prints it as one string, so an
// alternative that ended without a stop ran straight into "To override" and the
// refusal the model reads was two sentences with no break between them.
function sentence(text) {
  const t = String(text).trim();
  return /[.!?]$/.test(t) ? t : t + ".";
}

function denyText(guardId, deny, hasDriver) {
  return "[jig guard " + guardId + "] " + sentence(deny.reason) +
    " Instead: " + sentence(deny.alternative) +
    " To override: " + sentence(deny.override) +
    (hasDriver ? " Before calling this work done, run: node .jig/checks/run.mjs." : "") +
    " (false alarm? /jig:review fp " + guardId + ")";
}

// What an observing guard says when its owner opted it into teaching. The same
// triple a deny carries, and deliberately nothing else: no false-alarm command,
// because nothing was refused and there is no report to withdraw; no harness
// pointer, because this is not the moment work is being called done; and no
// source, because the model already has the edit it just made in front of it.
function teachText(guardId, deny) {
  return "[jig guard " + guardId + " would have denied this] " + sentence(deny.reason) +
    " Instead: " + sentence(deny.alternative) +
    " To override: " + sentence(deny.override);
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

// A hook payload names the file the way the host does: absolute, and on win32
// backslashed behind a drive letter. A `paths` glob and a zone glob are both
// written repo-relative, so the path is made repo-relative ONCE, in `runEvent`,
// which is the only place holding the root. Matching the tail of the path
// instead would let a directory ABOVE the checkout satisfy a repo-relative
// glob — a repo cloned to `/src/vendor/app` would have every guard disarmed by
// an observe zone of `vendor/**` — and that is a zone widening itself past what
// the owner named. A path outside the root keeps its own spelling and matches
// no repo-relative glob, which is the truth about it.
function repoRelative(root, filePath) {
  if (!filePath) return "";
  const p = String(filePath).replace(/\\/g, "/");
  const rel = path.relative(root, path.resolve(root, p)).split(path.sep).join("/");
  return rel && rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel) ? rel : p;
}

// The one matching rule both path-scoped levers read, and the same rule
// `matchesAny` in `scripts/templates/run.mjs` applies to the same `paths`
// field: the whole repo-relative path, anchored, never a suffix of it. Two
// answers to one field would put a would-deny in the ledger for a file the
// check driver considers out of scope.
function matchesPathGlobs(globs, rel) {
  if (!rel) return false;
  return globs.some((g) => typeof g === "string" && globToRegExp(g).test(rel));
}

function zoneForcesObserve(zones, filePath) {
  if (!isObject(zones) || !Array.isArray(zones.observe) || !filePath) return false;
  return matchesPathGlobs(zones.observe, filePath);
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
// reads one fact from it: whether a false positive stands. A 1.0.1 install and
// a hand-written line raise one with {decision:"false-positive", guardId};
// {decision:"false-positive-cleared", guardId} settles it — the later line
// wins, because an append-only ledger is how a wave-off stays undoable.
//
// `fp` writes {decision:"false-positive-pending"} instead: since 2.8.0 the
// judgment is recorded here and the guard is quieted by an approved config
// change, so a pending line counts as a wave-off and holds nothing. It is
// tracked separately so a review can say a wave-off was raised and never
// settled. `fired` is carried for the review surface, which reports what each
// guard has done.
//
// `fired` alone is a numerator with nothing under it: four catches out of four
// calls and four out of four thousand read identically. Every evaluated guard
// leaves a row on every call, pass included, so `evaluated` is that denominator
// and it costs nothing new — it is counted in the pass this function already
// makes. `denied` and `wouldDeny` split it by what the guard was allowed to do,
// and `lastFired` is the most recent catch by the row's own timestamp, not its
// position, because more than one lane appends here.
//
// The cost this leaves standing: the ledger is never compacted (SCOPE,
// Reporting — deleting rows deletes the evidence a wave-off is undone from), so
// this pass is linear in the ledger and grows for the life of the repository.
// Nothing here reads the file a second time to pay for the denominator, and
// `ledger.lines` on every review report is the growth the owner acts on.
//
// The commit lane writes rows with the class it caught and no guard id — the
// check driver runs no guard. Those are keyed under `CLASS_KEY` instead, where
// nothing keyed by guard id can collide with them: a class that has only ever
// fired at commit time used to read as one that had never fired, and folding
// its catches into a guard's own `fired` would have put a lane with no
// denominator inside one that has.
const CLASS_KEY = "class:";

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
    const key = row.guardId ||
      (typeof row.lane === "string" && typeof row.classId === "string" ? CLASS_KEY + row.classId : null);
    if (!key) continue;
    const s = stats[key] || (stats[key] = {
      standingFalsePositive: false, pendingFalsePositive: false, falsePositives: 0, fired: 0,
      denied: 0, wouldDeny: 0, evaluated: 0, lastFired: null,
    });
    if (row.decision === "false-positive") {
      s.falsePositives++;
      s.standingFalsePositive = true;
    } else if (row.decision === "false-positive-pending") {
      s.falsePositives++;
      s.pendingFalsePositive = true;
    } else if (row.decision === "false-positive-cleared") {
      s.standingFalsePositive = false;
      s.pendingFalsePositive = false;
    } else if (row.decision === "would-deny" || row.decision === "deny") {
      s.fired++;
      s.evaluated++;
      if (row.decision === "deny") s.denied++; else s.wouldDeny++;
      if (typeof row.ts === "string" && (s.lastFired === null || row.ts > s.lastFired)) s.lastFired = row.ts;
    } else if (row.decision === "pass" && row.check !== "unusable") {
      // A guard whose check will not load leaves a pass row on every call and
      // evaluates nothing. Counting those would report "caught 0 out of 4
      // looks" for a guard that never looked once — a denominator describing
      // coverage nobody had, on the row `problem` separately calls broken.
      s.evaluated++;
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
// The `--opt=value` spelling puts the value inside the token, where the
// leading-dash filter already drops it. Only the separated spelling matters.
const PUSH_VALUE_OPTS = ["-o", "--push-option", "--receive-pack", "--exec", "--repo"];

function pushBranch(command) {
  const m = /\bgit\s+push\b([^\n]*)/.exec(command);
  if (!m) return null;
  const tokens = m[1].trim().split(/\s+/).filter((w) => w);
  const words = [];
  for (let i = 0; i < tokens.length; i++) {
    // Every `git push` option that takes its value as the NEXT word. That word
    // is a bare token in argv exactly the way the refspec is, so dropping only
    // the flag would leave the value standing where the remote belongs and
    // shift the branch out of reach — which reads as out of scope, and an armed
    // guard passes the push it was installed to stop.
    if (PUSH_VALUE_OPTS.includes(tokens[i])) { i++; continue; }
    if (!tokens[i].startsWith("-")) words.push(tokens[i]);
  }
  return words.length >= 2 ? refspecBranch(words[1]) : null;
}

// `main`, `HEAD:main`, `+main`, `+HEAD:main`, `:main` and `refs/heads/main` are
// the same push. The destination is the last `:`-separated part; the delete
// form `:main` has an empty source, so the other side names the branch.
function refspecBranch(refspec) {
  const parts = refspec.replace(/^\+/, "").split(":");
  const dest = parts[parts.length - 1] || parts[0];
  return dest.replace(/^refs\/heads\//, "");
}

function branchInScope(command, onlyBranches, config) {
  const wanted = onlyBranches.flatMap((b) =>
    b === "<default>" ? (config.defaultBranches || DEFAULT_BRANCHES) : [b]);
  const named = pushBranch(command);
  return named === null || wanted.includes(named);
}

// A pattern is data the check carries, and data can be wrong: a source that
// will not compile throws out of the loop, past every guard still queued behind
// it, and out to the runner — which fails the whole call open. One bad pattern
// would take the healthy armed guards on that event with it. Compiling here
// contains it to the pattern that is broken: it is skipped, named on `failed`
// so its own guard records the gap, and everything else still evaluates. This
// is containment, not ReDoS protection — a pattern that compiles and then runs
// for ever is a different problem and is not addressed here.
function compilePattern(source, flags, failed) {
  try {
    return new RegExp(source, flags);
  } catch {
    if (!failed.includes(source)) failed.push(source);
    return null;
  }
}

function evalBash(det, payload, config, failed) {
  const params = det.params || {};
  const command = String((payload.tool_input && payload.tool_input.command) || "");
  if (!command) return null;
  for (const source of params.patterns || []) {
    const re = compilePattern(source, "", failed);
    if (!re || !re.test(command)) continue;
    if (Array.isArray(params.onlyBranches) && !branchInScope(command, params.onlyBranches, config)) continue;
    return source;
  }
  return null;
}

// The edit payload carries the edit, not the file's history. For an Edit that
// is enough: `onlyWhenIntroduced` compares the replacement against what it
// replaced. A Write supplies no prior text at all, so the whole payload counts
// as introduced — an over-match that is a ledger line and never a block.
// Both sides are blanked before matching, so a shape that lives only in a
// comment, a string, or a regular expression is not an introduction.
//
// `removed` is the other direction and the session half of the removal kind: it
// fires when a pattern is in the replaced text more times than in the
// replacement. A Write carries no `old_string`, so a removal detector never
// fires on one — the disclosed limit of reading a removal one call at a time,
// and the reason `evalSessionDetector` cannot prove such a lever.
function evalEdit(det, payload, failed, rel) {
  const params = det.params || {};
  const input = payload.tool_input || {};
  // `paths` scopes the check that owns this detector, and the check driver has
  // always honoured it. It scopes the guard the same way. Absent or empty means
  // everywhere, which is what every guard authored before this meant. Out of
  // scope is a pass and never a would-deny: a guard that does not apply here
  // has caught nothing, and a ledger row saying otherwise is a coverage claim.
  if (Array.isArray(params.paths) && params.paths.length && !matchesPathGlobs(params.paths, rel)) return null;
  const after = String(input.new_string !== undefined ? input.new_string : (input.content || ""));
  const before = String(input.old_string || "");
  // An edit that empties a region — `new_string: ""`, the shape a deleted test
  // arrives in — is exactly the payload the removal kind exists to read, so it
  // is no longer the end of this function. The pattern kind still needs
  // something to have landed, and returns below.
  if (!after && !before) return null;
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
  for (const source of params.removed || []) {
    const re = compilePattern(source, "g", failed);
    if (!re) continue;
    if ((cleanBefore.match(re) || []).length > (cleanAfter.match(re) || []).length) return source;
  }
  if (!after) return null;
  for (const source of params.patterns || []) {
    const re = compilePattern(source, "g", failed);
    if (!re) continue;
    const hits = (cleanAfter.match(re) || []).length;
    if (!hits) continue;
    if (params.onlyWhenIntroduced && hits <= (cleanBefore.match(re) || []).length) continue;
    return source;
  }
  return null;
}

// Returns { det, matched } for the first of the check's detectors that fired,
// or null. The PATTERN is what gets recorded, never the text it matched — the
// ledger is a record of which guard fired, and copying a line of the user's
// source into a log file is not that.
//
// `failed` collects the patterns that would not compile, so the caller can say
// so on the guard's own row. Optional: a caller with nothing to record passes
// nothing and the bad patterns are still skipped rather than thrown.
//
// `rel` is the payload's file made repo-relative by the caller that holds the
// root. A caller with no root falls back to the payload's own spelling, which
// matches no repo-relative glob unless it already is one.
//
// Which of the two evaluations a detector gets is read off its lever, never off
// the event: since 2.11.0 an edit guard and a bash guard both run at PreToolUse.
function evaluateGuard(dets, payload, config, failed, rel) {
  const bad = failed || [];
  const file = rel === undefined
    ? String((payload.tool_input || {}).file_path || "").replace(/\\/g, "/")
    : rel;
  for (const det of dets) {
    const tools = leverTools(det);
    if (!tools.length) continue;
    const matched = isShellLever(det)
      ? evalBash(det, payload, config, bad)
      : evalEdit(det, payload, bad, file);
    if (matched) return { det, matched };
  }
  return null;
}

// The session levers, proven the way they will run. Admission hands over one
// detector and one fixture; this builds the tool call the host would send and
// answers with the evaluation above — so a lever admission calls proven and the
// guard a session actually runs can never be two different guards. Reaching for
// a second matcher inside admission is what let a bash-guard matching
// `zzz-never-matches-anything` ship under a printed proof.
// A path-scoped edit detector only fires on a path its own globs match, so the
// fixture is seeded at the same derived path `jig selftest` probes it at.
// The lever picks the payload shape, not the runner: `edit-guard` and
// `bash-guard` share PreToolUse and read nothing alike.
function evalSessionDetector(det, text) {
  if (isShellLever(det)) {
    // `branchInScope` passes a push that names no branch, because a bare
    // `git push` cannot be read for one. That is right at runtime and it is not
    // a proof: a fixture naming no branch would admit a guard scoped to a
    // branch nobody has, which then catches nothing real. A branch-scoped lever
    // is proven by a fixture that names the push it exists to stop.
    const params = (det && det.params) || {};
    if (Array.isArray(params.onlyBranches) && params.onlyBranches.length && pushBranch(text) === null) return false;
    return !!evaluateGuard([det], { tool_input: { command: text } }, {}, [], "");
  }
  const rel = fixturePath({ params: (det && det.params) || {} });
  // A fenced fixture IS an edit — the file before it and the file after it — so
  // it is proven as one, `old_string` against `new_string`. That is the only
  // shape a removal lever can be proven on, and without the fence there is no
  // before: a Write carries none, which is the disclosed limit of the kind.
  const halves = fencedHalves(text);
  const input = halves
    ? { file_path: rel, old_string: halves.before, new_string: halves.after }
    : { file_path: rel, content: text };
  return !!evaluateGuard([det], { tool_input: input }, {}, [], rel);
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
// Proof of verification
// ---------------------------------------------------------------------------
//
// The headline gap this plugin exists to close: a session that ran the tests
// and a session that only said it did used to leave identical traces, so "the
// tests pass" was contradictable by nothing jig holds.
//
// Two halves that must not blur. A Bash call running a command
// `.jig/verify.json` names is EVIDENCE — it leaves a row, and pass and fail
// split on WHICH event fired, because that is the signal the host documents. A
// Stop is additionalContext ONLY: SCOPE's derail pass answers "May the Stop
// hook exit 2" with a No, since a block at Stop has no fixture pair behind it.
//
// Both halves fail open. A row that cannot be appended and a `git status` that
// will not run are disclosed, never a reason to hold a tool call or a stop.

function isWitnessEvent(event, tool) {
  // PostToolUseFailure is registered for the shell tools alone, so it is a
  // witness however the payload names its tool. PostToolUse carries the edit
  // guards too, and only its shell half is a witness — a guard must never
  // evaluate here. A verification run is a verification run whichever shell
  // tool ran it: gating this on `Bash` alone left every win32 session with
  // nothing to witness and `lastGreen` permanently null.
  return event === "PostToolUseFailure" || (event === "PostToolUse" && SHELL_TOOLS.includes(tool));
}

// The lane entries as installed, or none. Read through the engine's own reader
// so the file has one interpretation: a second parse here would be a second
// answer to what counts as an entry.
function verifyEntries(root) {
  let raw;
  try {
    raw = fs.readFileSync(statePath(root, VERIFY_FILE), "utf-8");
  } catch {
    return [];
  }
  return proposedVerifyEntries(raw) || [];
}

// The entry this command IS, or null. Shell-word split and then matched whole:
// a witness says this exact argv ran, not that something resembling it did.
// A command carrying a pipe, a redirect or a second statement splits into words
// no entry equals, which is the right answer — an entry names one program with
// its arguments, and jig runs it with no shell for that reason.
function verifyEntryFor(entries, command) {
  const argv = String(command || "").trim().split(/\s+/).filter(Boolean);
  if (!argv.length) return null;
  return entries.find((e) => Array.isArray(e.argv) && e.argv.length === argv.length &&
    e.argv.every((word, i) => word === argv[i])) || null;
}

// Recorded only where the payload carries one, and now from the place a live
// host was measured putting it. Roadmap 230's probe (Claude Code 2.1.257,
// `docs/research/jig/HOST-PROBE-2026-09-02.md`) found `PostToolUseFailure`
// carries no `tool_response` at all — the code arrives as the `error` string
// "Exit code 3" — so without this read the entry's own `expectedExit` could
// never be honoured on the one event that carries a failure. The structured
// fields stay first for a host that reports one. Anything else the host phrases
// as an error is left null rather than guessed at: a number nobody measured is
// the last thing a file the review surface reads back as fact should hold.
function exitCodeOf(payload) {
  const res = payload && payload.tool_response;
  if (isObject(res)) {
    for (const key of ["exit_code", "exitCode"]) {
      if (Number.isInteger(res[key])) return res[key];
    }
  }
  const err = payload && payload.error;
  const said = typeof err === "string" ? /^exit code (\d+)$/i.exec(err.trim()) : null;
  return said ? Number(said[1]) : null;
}

// The verification rows, in the order they were written. Its own reader rather
// than a field on `ledgerStats`: those stats are keyed by guardId and a witness
// row carries none, which is also what keeps a test run out of the arming model.
//
// The cost of that second reader, stated plainly because C9 asked for it rather
// than for compaction: this is a second full-file pass over a ledger that never
// rotates, paid on every review, every inventory, and every Stop that has a
// lane entry to check. A repository with no `.jig/verify.json` pays neither —
// `stopContext` returns before it reaches here.
function verifyRows(root) {
  let lines = [];
  try {
    lines = fs.readFileSync(statePath(root, LEDGER_FILE), "utf-8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
  const rows = [];
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row.verify === "string" && (row.decision === "verified" || row.decision === "verify-failed")) {
      rows.push(row);
    }
  }
  return rows;
}

// Which shell tools this repository has actually been seen to send, off the
// rows jig's own hooks wrote. Every payload names its tool and every row records
// it, so this is an observation. `process.platform` is not one: it was wrong on
// the first machine it was asked about, where an interactive session offers a
// `Bash` tool and a `PowerShell` tool at once while a headless one on the same
// OS offers only `PowerShell`. Nothing seen yet returns an empty list, which the
// surfaces report as "not yet observed" rather than defaulting to a guess —
// SCOPE, "It never silently substitutes a default for an answer the owner did
// not give".
//
// A third full-file pass over a ledger that never rotates, on the same terms
// `verifyRows` states above: paid on every review and every inventory, by a
// repository that has a session lane at all.
function shellToolsSeen(root) {
  let lines = [];
  try {
    lines = fs.readFileSync(statePath(root, LEDGER_FILE), "utf-8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
  const seen = new Set();
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (SHELL_TOOLS.includes(row.tool)) seen.add(row.tool);
  }
  return SHELL_TOOLS.filter((t) => seen.has(t));
}

// The last green run per entry id. Pure, and taken from the row's own timestamp
// rather than its position, because the ledger is appended to by more than one
// lane and only the timestamp orders them.
function lastGreenRuns(rows) {
  const last = new Map();
  for (const row of rows) {
    if (row.decision !== "verified" || typeof row.ts !== "string") continue;
    const prev = last.get(row.verify);
    if (!prev || prev < row.ts) last.set(row.verify, row.ts);
  }
  return last;
}

// The one line the completion moment gets, or null when there is nothing true
// to say. Pure: the rows, the entries and the changed paths all arrive as
// arguments, so the tests walk it without a repository.
//
// It over-reads in the safe direction on purpose. An edit the last green run
// already covered still counts, so the worst case is a line telling somebody to
// re-run tests they ran a minute ago — printed beside the timestamp of that run
// so they can see it. The reverse, staying quiet about edits nothing verified,
// is the silence this whole thing exists to end.
function staleVerification(rows, entries, changedPaths) {
  const green = lastGreenRuns(rows);
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string") continue;
    const globs = Array.isArray(entry.paths) && entry.paths.length ? entry.paths : null;
    const hits = globs ? changedPaths.filter((p) => matchesPathGlobs(globs, p)) : changedPaths;
    if (!hits.length) continue;
    const at = green.get(entry.id) || null;
    return "jig: " + hits.length + " edit" + (hits.length === 1 ? "" : "s") + " under " +
      (globs ? globs.join(", ") : "this repository") +
      (at ? " since the last green run of " + entry.id + " (" + at + ")."
          : ", and no green run of " + entry.id + " is recorded.");
  }
  return null;
}

// `XY <path>`, or `XY <old> -> <new>` for a rename — the destination is the path
// that exists now. git quotes a path with unusual bytes in it; the quotes come
// off so a glob sees the same spelling every other reader of a path does.
function porcelainPath(line) {
  let rel = line.slice(3);
  const arrow = rel.indexOf(" -> ");
  if (arrow !== -1) rel = rel.slice(arrow + 4);
  return rel.trim().replace(/^"|"$/g, "");
}

// One subprocess, at Stop only. Nothing else in this file starts one — a spawn
// on every tool call is the standing tax jig promised not to be — and the
// completion moment is one turn, not one call. Null means git could not answer,
// which is a disclosed gap rather than an empty working tree.
function changedPaths(root) {
  const { spawnSync } = require("child_process");
  // `-uall` because git collapses an untracked directory to `src/`, and a path
  // glob written for `src/**/*.js` matches nothing in that. A whole new
  // directory of unverified source is exactly the case worth naming, so it has
  // to arrive as files. Ignored paths are still ignored, which is what keeps
  // this off `node_modules`.
  const run = spawnSync("git", ["status", "--porcelain", "-uall"], {
    cwd: root, shell: false, windowsHide: true, encoding: "utf-8", maxBuffer: 4 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) return null;
  return String(run.stdout || "").split("\n").filter((l) => l.trim()).map(porcelainPath).filter(Boolean);
}

// The evidence half. No guard is consulted and none can be: this returns before
// the config is read at all.
function witness(root, event, base, payload, warn) {
  const entry = verifyEntryFor(verifyEntries(root), (payload.tool_input || {}).command);
  if (!entry) return { jig: { event, decision: "pass", verify: null } };
  const exitCode = exitCodeOf(payload);
  // Which event fired is the documented signal — and the measured one: roadmap
  // 230 watched a failing command fire `PostToolUseFailure` and no `PostToolUse`
  // at all. It stays the answer wherever the payload carries no code. A code it
  // DID carry outranks it: a row reading
  // `verified` beside `exitCode: 1` is a coverage claim contradicted by its own
  // evidence, and a host that routes a failing command to PostToolUse would
  // otherwise make every red run green on jig's headline surface. The entry's
  // own `expectedExit` is what green means for it (SCOPE, "What counts as
  // caught for a non-zero exit"), because a tool that catches by exiting
  // non-zero has not failed when it does.
  const expected = Number.isInteger(entry.expectedExit) ? entry.expectedExit : 0;
  const passed = exitCode === null ? event === "PostToolUse" : exitCode === expected;
  try {
    appendLedger(root, ledgerRow(base, {
      actor: "claude-session", guardId: null, classId: null,
      decision: passed ? "verified" : "verify-failed", matched: null, durMs: 0,
      rest: { verify: entry.id, event, exitCode },
    }));
  } catch (err) {
    // A row that will not append is a gap in the evidence and never a reason to
    // touch the tool call that produced it.
    warn("jig: the " + entry.id + " run was not recorded (" + err.message + ")");
  }
  return { jig: { event, decision: "pass", verify: { entry: entry.id, passed, exitCode } } };
}

// The completion moment. One line of additionalContext and nothing else — no
// decision, no exit 2, no guard.
function stopContext(root, event, base, warn) {
  let line = null;
  let problem = null;
  try {
    // Nothing to verify, nothing to say — and nothing to pay for saying it.
    // Reached before the spawn on purpose: a repository with no lane entries
    // would otherwise run `git status` and read the whole ledger once per turn
    // for the life of the repository, and fail open loudly on every one of them
    // where git cannot answer.
    const entries = verifyEntries(root);
    if (!entries.length) return { jig: { event, decision: "pass", stale: null } };
    const changed = changedPaths(root);
    if (changed === null) problem = "git status could not be read here";
    else line = staleVerification(verifyRows(root), entries, changed);
  } catch (err) {
    problem = err.message;
  }
  if (problem) {
    warn("jig: no verification check at this stop — " + problem);
    try {
      appendLedger(root, ledgerRow(base, {
        actor: "jig", guardId: null, classId: null, decision: "pass", matched: null,
        durMs: 0, rest: { stop: event, failedOpen: problem },
      }));
    } catch { /* a ledger that will not append is not a reason to hold a stop */ }
  }
  const out = { jig: { event, decision: "pass", stale: line } };
  if (line) out.hookSpecificOutput = { hookEventName: event, additionalContext: line };
  return out;
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
  // The two events that witness a verification run, and the two that read those
  // rows back, are answered before the config is even opened. That is what makes
  // "guards never evaluate on these events" mechanical rather than promised.
  if (isWitnessEvent(event, base.tool)) return witness(root, event, base, payload, warn);
  if (STOP_EVENTS.includes(event)) return stopContext(root, event, base, warn);

  // The host names the file its own way; every glob jig matches against it is
  // repo-relative. This is the only place that holds the root, so this is where
  // the two are put in one namespace. The ledger keeps the host's spelling.
  const rel = repoRelative(root, base.path);

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
  // of observing guards never pays for it. Read on first use rather than up
  // front, so an Edit call whose guards all turn out to read Bash pays for
  // nothing at all: PreToolUse now carries both, and the common case on a large
  // ledger was a megabyte read for zero evaluations.
  let stats = null;
  const statsFor = (id) => {
    if (stats === null) stats = running.some((g) => g.mode === "armed") ? ledgerStats(root) : {};
    return stats[id];
  };
  const results = [];
  let deny = null;
  let denyGuard = null;
  let teach = null;
  for (const guard of running) {
    const started = process.hrtime.bigint();
    const durMs = () => Math.round(Number(process.hrtime.bigint() - started) / 1e6 * 1000) / 1000;
    const record = loadCheck(root, guard.check);
    const dets = record.problem ? [] : sessionDetectors(record.mod, event, base.tool);
    // A bash guard on an Edit call, or an edit guard on a Bash call: both are
    // registered for PreToolUse now, and a guard with nothing to say about this
    // tool did not evaluate. No warning and no row — it is not a broken install
    // and a pass row here would inflate every other guard's denominator.
    if (!dets.length && !record.problem && sessionDetectors(record.mod, event).length) continue;
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

    const failed = [];
    const hit = evaluateGuard(dets, payload, read.config, failed, rel);
    const det = hit ? hit.det : dets[0];
    const s = statsFor(guard.id);
    const eff = effectiveState(guard, read.config, rel, {
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
    // A guard the owner armed and the gate pulled back to observe is a coverage
    // gap nothing else shows: the config still reads `armed`. Said once, out
    // loud, and recorded on the row so review and inventory report it too.
    const demoted = guard.mode === "armed" && eff.mode !== "armed" ? eff.why : null;
    if (demoted) warn("jig: " + guard.id + " is armed in the config but ran as observe — " + demoted);
    // A pattern that will not compile is a hole in this guard and in nothing
    // else. Said out loud and put on the row, because a guard that quietly
    // stopped watching part of what it names is a coverage claim jig has not
    // earned.
    if (failed.length) {
      warn("jig: " + guard.id + " skipped a pattern that will not compile — " + failed.join(", "));
    }
    appendLedger(root, ledgerRow(base, {
      actor: det.actor || record.mod.actor || null, guardId: guard.id, classId: guard.classId,
      decision, matched: hit ? hit.matched : null, mode: eff.mode, durMs: durMs(),
      rest: {
        confidence: det.confidence || record.mod.confidence || null, demoted,
        patternsFailed: failed.length ? failed : null,
      },
    }));
    results.push({
      guardId: guard.id, classId: guard.classId, decision,
      matched: hit ? hit.matched : null, mode: eff.mode,
    });
    if (decision === "deny" && !deny) {
      deny = denyOf(record.mod, det);
      if (deny) denyGuard = guard.id;
    }
    // One line per event, so the first teaching guard to match is the one that
    // speaks. A guard whose check ships no complete triple has nothing to teach
    // WITH — the same reason it could not arm — and stays silent.
    if (decision === "would-deny" && guard.teach && !teach) {
      const triple = denyOf(record.mod, det);
      if (triple) teach = teachText(guard.id, triple);
    }
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
    const reason = denyText(denyGuard, deny, fs.existsSync(statePath(root, CHECKS_DIR, "run.mjs")));
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
  // The observe-mode channel, and the only one jig has to the model that does
  // not refuse anything. Both runners carry it since 2.13.0, so on PreToolUse a
  // teaching guard can share this reply with an armed one's deny — one guard
  // refusing while another only watches. It merges into that reply and never
  // replaces it: dropping the `permissionDecision` would turn a refusal the
  // owner armed into a pass.
  if (teach) out.hookSpecificOutput = { ...out.hookSpecificOutput, hookEventName: event, additionalContext: teach };
  return out;
}

module.exports = {
  HOOK_RUNNERS, HOOK_EVENTS, STOP_EVENTS, isShellLever,
  EVENT_TOOLS, LEVER_TOOLS, DEFAULT_MODE, CONFIG_KEYS, CONFIG_MODES, GUARD_KEYS, MATCHER_KEYS,
  DEFAULT_BRANCHES, PROVENANCES, DENY_PARTS,
  CONFIG_FILE, LEDGER_FILE, OFF_FILE, CHECKS_DIR,
  statePath, isOff, isConfigured, readInput,
  readConfig, validateConfig,
  loadCheck, sessionDetectors, denyOf, denyText, teachText, checkProof,
  blankRegions, globToRegExp, pushBranch, branchInScope, evaluateGuard, evalSessionDetector,
  effectiveState, ledgerStats, CLASS_KEY, zoneForcesObserve,
  appendLedger, runEvent,
  isWitnessEvent, verifyEntries, verifyEntryFor, exitCodeOf,
  verifyRows, lastGreenRuns, staleVerification, porcelainPath, changedPaths,
  shellToolsSeen,
};
