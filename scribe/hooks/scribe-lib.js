"use strict";

// scribe shared library — everything both hooks need lives here so gate.js and
// observer.js stay thin entries the wiring points at.
//
// Three properties this file exists to keep mechanical rather than promised:
//
//   1. The rubric is static, plugin-shipped text. It is never assembled from
//      repository content — a hostile file in the repo has no path into the
//      instruction that rides every prompt. Config can only pick between the
//      two bar lines shipped below.
//   2. The standing tax is capped. RUBRIC_CAP is the product's honesty number:
//      the emitted context can never exceed it, and the release-gate test
//      asserts both bars fit under it.
//   3. It fails open, always. An unreadable or invalid config warns on stderr
//      and degrades to defaults; a ledger write that fails is dropped; nothing
//      in this file may break the user's turn.

const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;
const STATE_DIR = ".scribe";
const CONFIG_FILE = "config.json";
const LEDGER_FILE = "ledger.jsonl";
const OFF_FILE = "off";

// The public honesty number, stated in SCOPE.md's release gates: the
// additionalContext the gate emits — rubric plus JSON envelope — stays under
// this many bytes.
const RUBRIC_CAP = 1400;

// How much of the prompt a judged line keeps. Enough to evaluate ask quality
// at review time, small enough that the ledger never becomes a transcript.
const PROMPT_KEEP = 200;
const QUESTION_KEEP = 120;
// Option labels are short by construction (the method caps them at five
// words), and the review only needs them to tell a picked label from an
// answer nobody offered.
const OPTION_KEEP = 60;
// A harvested answer longer than this is not an answer; it is dropped whole
// rather than clipped, so nothing long enough to carry an instruction lands
// in the ledger. ANSWER_KEEP is the count, not a length.
const ANSWER_MAX = 80;
const ANSWERS_KEEP = 8;

const BARS = ["conservative", "standard"];
// Asking is the product. The default bar asks whenever readings genuinely
// fork; `conservative` is the opt-in for projects that want less.
const DEFAULT_BAR = "standard";

// Rounds of questions per session before the gate stops asking (0 disables the
// cap). Off by default: a session that keeps forking has earned the questions,
// and a user who disagrees has the wave-off, the cap, and the kill switch.
const DEFAULT_FATIGUE_CAP = 0;

// Wave-off phrases, in two forms.
//
// WAVE_OFF_RE is the loose one: it finds a phrase anywhere. That is right for
// scanning the short strings a user types into a question round, where the
// whole payload is their answer.
//
// isWaveOff() is the strict one, for a whole prompt. A wave-off is something
// the user LEADS with, so the phrase has to open the prompt after at most a
// short agreement lead-in — and then still look like an aside rather than a
// sentence about one. Matching anywhere turned ordinary requests into
// wave-offs ("add a Surprise me button to the UI", "the spec says you decide
// the retry count"), which cost the prompt its rubric AND fed the review's
// streak rule evidence the user never gave.
const WAVE_OFF_PHRASES =
  "just do it|stop asking|no (?:more )?questions|don['’]?t ask|whatever you think|you decide|surprise me";
const WAVE_OFF_RE = new RegExp("\\b(" + WAVE_OFF_PHRASES + ")\\b", "i");
const WAVE_OFF_OPENS = new RegExp(
  "^\\s*(?:(?:ok|okay|yes|yeah|fine|sure|please)\\b[\\s,.:;!-]*){0,2}(?:" + WAVE_OFF_PHRASES + ")\\b",
  "i",
);
// Past this length a prompt that merely starts with a phrase is a request, not
// an aside — "stop asking me for the token every time, cache it" is work.
const WAVE_OFF_SHORT = 40;

function isWaveOff(prompt) {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  const opener = WAVE_OFF_OPENS.exec(text);
  if (!opener) return false;
  // Either nothing follows the phrase but punctuation, or the whole prompt is
  // short enough that the trailing words are a rider on the wave-off.
  return !/^\s+\S/.test(text.slice(opener[0].length)) || text.length <= WAVE_OFF_SHORT;
}

// ---------------------------------------------------------------------------
// The rubric
// ---------------------------------------------------------------------------
//
// One compact judgment that rides every judged prompt. The full questioning
// method lives in the clarify skill, loaded only when the judgment here says
// "ambiguous" — that split is what keeps the standing cost pinned: the method
// can grow without a byte of it riding every prompt in every repo.

const RUBRIC_CORE = [
  "[scribe] Judge this request before acting on it.",
  "Stand down — skip the judgment, continue normally — if any of these holds:" +
    " the prompt answers a question you asked; another interview or question flow" +
    " is mid-conversation; the session is unattended (headless, goal-driven, or a" +
    " background agent) — there, take the most reasonable reading and proceed.",
  "Ambiguous = a reasonable colleague could execute this in two or more MATERIALLY" +
    " different ways: different files touched, different definition of done, or" +
    " different risk. Vague wording that still lands the same change is precise.",
  "Precise -> proceed in silence. Never mention scribe.",
  "Ambiguous -> invoke the scribe:clarify skill and follow it: numbered questions" +
    " via AskUserQuestion (max 4 per call), each with options, your best guess" +
    " first labeled \"(Recommended)\". Keep asking until no material gap is left;" +
    " a wider frontier spills into the next round. Never ask what the prompt, the" +
    " code, or the configuration already answers.",
  "If the user waves questions off (\"just do it\"), comply that turn, no argument.",
].join("\n");

const BAR_LINES = {
  conservative:
    "Bar: ask only when the wrong reading would cost real rework. In doubt, proceed.",
  standard:
    "Bar: when you are genuinely torn between readings, ask.",
};

function rubric(bar) {
  return RUBRIC_CORE + "\n" + (BAR_LINES[bar] || BAR_LINES[DEFAULT_BAR]);
}

// The exact stdout a gate emission produces — capped as a whole, envelope
// included, so the cap measures what actually rides the prompt.
function emission(bar) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: rubric(bar),
    },
  });
}

// ---------------------------------------------------------------------------
// Paths, kill switches, input
// ---------------------------------------------------------------------------

function statePath(root, ...parts) {
  return path.join(root, STATE_DIR, ...parts);
}

// One project, one `.scribe/`. The hook payload's `cwd` follows the session's
// working directory, so anchoring state on it drops a fresh ledger into every
// folder a session ever worked from — and the review then reads whichever
// fragment it happens to be standing in. CLAUDE_PROJECT_DIR is the host's own
// answer to where the session started, it does not move, and the host sets it
// for every hook it spawns. Off that path — the CLI, a host that sets nothing —
// the nearest `.scribe/` at or above the start directory keeps the reader
// pointed at the ledger the hooks are already writing.
function projectRoot(start) {
  const declared = process.env.CLAUDE_PROJECT_DIR;
  if (typeof declared === "string" && declared.trim()) return path.resolve(declared.trim());
  const from = path.resolve(typeof start === "string" && start ? start : process.cwd());
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, STATE_DIR))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return from;
    dir = up;
  }
}

// `.scribe/` holds machine-local evidence that grows on every turn, so it
// ignores its own moving parts and nobody has to remember to. `config.json`
// stays visible: that one is a project decision a team can reasonably commit.
function ensureStateDir(root) {
  const dir = statePath(root);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, [LEDGER_FILE, OFF_FILE].join("\n") + "\n");
  return dir;
}

// Presence is the whole contract — the file's contents are never read, so
// `touch .scribe/off` works from anywhere. The env var is the same switch for
// contexts that cannot touch files (CI wrappers, one-off runs).
function isOff(root) {
  if (process.env.SCRIBE_OFF === "1") return true;
  return fs.existsSync(statePath(root, OFF_FILE));
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
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
// Config — hand-validated, fail-open
// ---------------------------------------------------------------------------
//
// Hand-written rather than schema-driven because scribe ships with no
// dependencies. Additive-only rule: this build reads schemaVersion 1; a higher
// number is a config from a future scribe and is refused into defaults rather
// than half-read.

const CONFIG_KEYS = ["schemaVersion", "bar", "off", "fatigueCap"];

function defaults() {
  return { bar: DEFAULT_BAR, off: false, fatigueCap: DEFAULT_FATIGUE_CAP, warnings: [] };
}

function readConfig(root) {
  const out = defaults();
  let raw;
  try {
    raw = fs.readFileSync(statePath(root, CONFIG_FILE), "utf-8");
  } catch {
    return out; // no config is the normal case, not a warning
  }
  let parsed;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch (err) {
    out.warnings.push(STATE_DIR + "/" + CONFIG_FILE + " is not valid JSON (" + err.message + ") — using defaults");
    return out;
  }
  if (!isObject(parsed)) {
    out.warnings.push(STATE_DIR + "/" + CONFIG_FILE + " is not a JSON object — using defaults");
    return out;
  }
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== SCHEMA_VERSION) {
    out.warnings.push(STATE_DIR + "/" + CONFIG_FILE + " is schemaVersion " +
      JSON.stringify(parsed.schemaVersion) + " and this build reads " + SCHEMA_VERSION + " — using defaults");
    return out;
  }
  for (const key of Object.keys(parsed)) {
    if (!CONFIG_KEYS.includes(key)) out.warnings.push(STATE_DIR + "/" + CONFIG_FILE + ": ignoring unknown key `" + key + "`");
  }
  if (parsed.bar !== undefined) {
    if (BARS.includes(parsed.bar)) out.bar = parsed.bar;
    else out.warnings.push(STATE_DIR + "/" + CONFIG_FILE + ": unknown bar " + JSON.stringify(parsed.bar) +
      " (known: " + BARS.join(", ") + ") — using " + DEFAULT_BAR);
  }
  if (parsed.off !== undefined) {
    if (typeof parsed.off === "boolean") out.off = parsed.off;
    else out.warnings.push(STATE_DIR + "/" + CONFIG_FILE + ": `off` must be true or false — ignoring");
  }
  if (parsed.fatigueCap !== undefined) {
    if (Number.isInteger(parsed.fatigueCap) && parsed.fatigueCap >= 0) out.fatigueCap = parsed.fatigueCap;
    else out.warnings.push(STATE_DIR + "/" + CONFIG_FILE + ": `fatigueCap` must be a whole number >= 0 — ignoring");
  }
  return out;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------
//
// Every line carries schemaVersion, ts, session, kind, and source from day one,
// because bar-tuning reads this data later and cannot invent fields the rows
// never had. `source` is always "mechanical" — every line is written by a
// hook that saw the event, never by the model reporting on itself. A judged
// line with no asked line in the same turn IS the pass-through record; the
// review derives it by subtraction instead of trusting a self-report.

function appendLedger(root, row) {
  try {
    ensureStateDir(root);
    fs.appendFileSync(
      statePath(root, LEDGER_FILE),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, ts: new Date().toISOString(), ...row }) + "\n",
    );
  } catch {
    /* best effort — a lost line must never cost the turn */
  }
}

function readLedger(root) {
  let lines;
  try {
    lines = fs.readFileSync(statePath(root, LEDGER_FILE), "utf-8").split("\n");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip a torn line */
    }
  }
  return rows;
}

// How many question rounds this session has already seen — the fatigue cap and
// the wave-off-by-prompt check both need exactly this count.
function askedCount(root, session) {
  if (!session) return 0;
  let n = 0;
  for (const row of readLedger(root)) {
    if (row.kind === "asked" && row.session === session) n++;
  }
  return n;
}

// Only what another file actually reaches for. Everything else stays internal.
module.exports = {
  SCHEMA_VERSION, LEDGER_FILE,
  RUBRIC_CAP, PROMPT_KEEP, QUESTION_KEEP, OPTION_KEEP, ANSWER_MAX, ANSWERS_KEEP,
  BARS, DEFAULT_FATIGUE_CAP,
  WAVE_OFF_RE, isWaveOff,
  rubric, emission, statePath, projectRoot, ensureStateDir, isOff, readInput, isObject,
  readConfig, defaults, appendLedger, readLedger, askedCount,
};
