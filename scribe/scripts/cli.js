#!/usr/bin/env node
"use strict";

// scribe's command surface — the deterministic half of the review skill.
// Reads the project's .scribe/ ledger and prints what the gate has actually
// done, so the asking bar is tuned from evidence instead of vibes (SCOPE
// job 4). Every suggestion this file makes states the rule that produced it.
//
// Derived passes: the ledger never carries a self-reported "passed" line. A
// judged row that no asked row followed (same session, before the next judged
// row) IS a pass — the subtraction happens here, in one place, so the two
// mechanical kinds are never conflated with an inference.

const lib = require("../hooks/scribe-lib");

// How much recent history the wave-off streak rule looks at, and how many
// wave-offs inside it count as a streak. Stated in the output verbatim.
const STREAK_WINDOW = 5;
const STREAK_WAVES = 2;
// How many judged-and-never-asked prompts it takes before "the gate never
// asks" is worth a line. Below this, silence is just a quiet week.
const QUIET_JUDGED = 20;
// Ask quality. When a round settles on an answer none of the options offered,
// the options missed the real reading — the cleanest signal there is that the
// questions were badly shaped rather than too frequent. No data exists to
// derive these from yet, so they are deliberately conservative and, like the
// others, quoted verbatim in the suggestion they produce.
const OFFMENU_WINDOW = 10;
const OFFMENU_ROUNDS = 3;

// An answer is on the menu when some offered label matches it. Either side may
// have been truncated on the way into the ledger, so a prefix match on the
// longer of the two counts.
function onMenu(answer, labels) {
  return labels.some((label) => {
    const a = answer.toLowerCase();
    const l = label.toLowerCase();
    return a === l || a.startsWith(l) || l.startsWith(a);
  });
}

// A round settled off-menu when at least one recorded answer matches nothing
// it offered. Rounds recorded before option labels were logged carry none, so
// they are not evidence either way and never count.
function settledOffMenu(row) {
  const labels = (row.questions || []).flatMap((q) => (Array.isArray(q.options) ? q.options : []));
  if (!labels.length) return null;
  const answers = Array.isArray(row.answers) ? row.answers : [];
  if (!answers.length) return null;
  return answers.some((a) => !onMenu(a, labels));
}

function analyze(rows, cfg) {
  const t = { judged: 0, capped: 0, rounds: 0, wavedOff: 0, passed: 0 };
  const sessions = new Set();
  const recentRounds = [];
  const recentEvents = [];
  const pending = new Map(); // session -> its latest judged row is still unanswered

  for (const row of rows) {
    sessions.add(row.session);
    if (row.kind === "judged") {
      if (row.capped) {
        t.capped++;
        continue;
      }
      if (pending.get(row.session)) t.passed++;
      pending.set(row.session, true);
      t.judged++;
    } else if (row.kind === "asked") {
      pending.set(row.session, false);
      t.rounds++;
      recentRounds.push(row);
      recentEvents.push("asked");
    } else if (row.kind === "waved-off") {
      t.wavedOff++;
      recentEvents.push("waved-off");
    }
  }
  for (const p of pending.values()) if (p) t.passed++;

  const suggestions = [];
  const window = recentEvents.slice(-STREAK_WINDOW);
  const waves = window.filter((e) => e === "waved-off").length;
  if (waves >= STREAK_WAVES) {
    suggestions.push(
      "wave-off streak: " + waves + " of your last " + window.length +
      " question events were wave-offs (rule: " + STREAK_WAVES + "+ in the last " +
      STREAK_WINDOW + "). The bar is costing more than it saves here — " +
      (cfg.bar === "standard"
        ? 'set "bar": "conservative" in .scribe/config.json, or "off": true.'
        : 'consider "off": true in .scribe/config.json, or touch .scribe/off.'),
    );
  }
  // The one under-ask rule. It fires on either bar: a silent gate means the
  // prompts are precise or the nudge is not landing, and which of those it is
  // depends on the bar, not on whether the question is worth asking.
  if (t.rounds === 0 && t.judged >= QUIET_JUDGED) {
    suggestions.push(
      "quiet gate: " + t.judged + " prompts judged, zero questions asked (rule: " +
      QUIET_JUDGED + "+ judged, none asked). Either your prompts are precise — good — or " +
      (cfg.bar === "conservative"
        ? 'the bar is high; "bar": "standard" asks whenever readings genuinely fork.'
        : "the nudge is not landing; the bar is already the eager one, so check scribe is " +
          "installed here and not switched off."),
    );
  }
  // The cap that produced a capped row is not on the row, so the sentence must
  // not name a number: config can have changed since, and at the 1.1.0 default
  // of 0 it would name a cap that is not set.
  if (t.capped > 0) {
    suggestions.push(
      "fatigue cap engaged " + t.capped + " time(s): scribe stopped asking for the rest of " +
      "those sessions once the configured round cap was reached (rule: a cap is set and a " +
      "session reached it). " +
      (cfg.fatigueCap > 0
        ? 'Raise "fatigueCap" only if those rounds were genuinely earning their answers.'
        : "The cap is off now, so those are historical rows — nothing to change."),
    );
  }
  // Ask quality, not ask frequency: the remedy is better options, never a
  // quieter bar.
  const judgedRounds = recentRounds.map(settledOffMenu).filter((v) => v !== null).slice(-OFFMENU_WINDOW);
  const offMenu = judgedRounds.filter(Boolean).length;
  if (offMenu >= OFFMENU_ROUNDS) {
    suggestions.push(
      "off-menu answers: " + offMenu + " of your last " + judgedRounds.length +
      " rounds settled on an answer none of the options offered (rule: " +
      OFFMENU_ROUNDS + "+ in the last " + OFFMENU_WINDOW + " rounds carrying options). " +
      "That is the options missing the real reading, not scribe asking too often — " +
      "the fix is the option-crafting rules in the clarify method, not the bar.",
    );
  }

  return { totals: t, sessions, recentRounds: recentRounds.slice(-5), suggestions };
}

function fmtRound(row) {
  const qs = (row.questions || [])
    .map((q) => (q.header ? q.header + ": " : "") + (q.question || ""))
    .join(" | ");
  const ans = Array.isArray(row.answers) && row.answers.length
    ? "  -> " + row.answers.join(", ")
    : "";
  return "  " + (row.ts || "").slice(0, 16) + "  " + (qs || "(round shape unrecorded)") + ans;
}

function review(root, json) {
  const rows = lib.readLedger(root);
  const cfg = lib.readConfig(root);
  const r = analyze(rows, cfg);
  if (json) {
    process.stdout.write(JSON.stringify({
      totals: r.totals,
      sessions: r.sessions.size,
      suggestions: r.suggestions,
    }) + "\n");
    return;
  }
  const t = r.totals;
  const out = [];
  out.push("scribe review — " + lib.statePath(root, lib.LEDGER_FILE));
  if (!rows.length) {
    out.push("No ledger yet. scribe has not judged a prompt in this project.");
  } else {
    out.push("");
    out.push("  judged " + (t.judged + t.capped) + "   asked " + t.rounds +
      " round(s)   passed " + t.passed + " (derived)   waved off " + t.wavedOff +
      (t.capped ? "   fatigue-capped " + t.capped : ""));
    out.push("  sessions " + r.sessions.size + "   bar " + cfg.bar +
      "   fatigue cap " + (cfg.fatigueCap || "off"));
    if (r.recentRounds.length) {
      out.push("");
      out.push("Recent rounds:");
      for (const row of r.recentRounds) out.push(fmtRound(row));
    }
    out.push("");
    if (r.suggestions.length) {
      out.push("Suggestions:");
      for (const s of r.suggestions) out.push("  - " + s);
    } else {
      out.push("No suggestions — the bar looks right for how you work.");
    }
  }
  const remembered = readMemory(root);
  if (remembered.size) {
    out.push("");
    out.push("Remembered answers (stated as assumptions, never re-asked):");
    for (const [term, v] of remembered) out.push("  " + term + " = " + v.meaning);
  }
  process.stdout.write(out.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Memory — remembered answers per repo
// ---------------------------------------------------------------------------
//
// Append-only JSONL, folded on read: the latest line for a term wins, and a
// `forgotten` line is a tombstone. Nothing is ever rewritten in place, so a
// crash mid-write can cost at most the line being written, and the file
// doubles as its own audit trail. A remembered answer is a stated assumption
// at the next round, never a question — and never more than that: the clarify
// skill states it and the user can veto it in the same breath.

const fs = require("fs");
const MEMORY_FILE = "memory.jsonl";

function appendMemory(root, row) {
  lib.ensureStateDir(root);
  fs.appendFileSync(
    lib.statePath(root, MEMORY_FILE),
    JSON.stringify({ schemaVersion: lib.SCHEMA_VERSION, ts: new Date().toISOString(), ...row }) + "\n",
  );
}

function readMemory(root) {
  let lines;
  try {
    lines = fs.readFileSync(lib.statePath(root, MEMORY_FILE), "utf-8").split("\n");
  } catch {
    return new Map();
  }
  const folded = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row.term !== "string" || !row.term) continue;
    const term = row.term.toLowerCase();
    if (row.forgotten) folded.delete(term);
    else if (typeof row.meaning === "string" && row.meaning) folded.set(term, { meaning: row.meaning, ts: row.ts });
  }
  return folded;
}

function memory(root, json) {
  const m = readMemory(root);
  if (json) {
    process.stdout.write(JSON.stringify(Object.fromEntries(
      [...m].map(([term, v]) => [term, v.meaning]),
    )) + "\n");
    return;
  }
  if (!m.size) {
    process.stdout.write("scribe remembers nothing in this project yet.\n");
    return;
  }
  const out = ["scribe's remembered answers — " + lib.statePath(root, MEMORY_FILE)];
  for (const [term, v] of m) {
    out.push("  " + term + " = " + v.meaning + "   (since " + (v.ts || "").slice(0, 10) + ")");
  }
  out.push('Forget one with: node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" forget <term>');
  process.stdout.write(out.join("\n") + "\n");
}

function main(argv) {
  const cmd = argv[0];
  const root = lib.projectRoot();
  if (cmd === "review") return review(root, argv.includes("--json"));
  if (cmd === "memory") return memory(root, argv.includes("--json"));
  if (cmd === "remember") {
    const term = (argv[1] || "").trim();
    const meaning = argv.slice(2).join(" ").trim();
    if (!term || !meaning) {
      process.stderr.write("scribe: remember needs a term and a meaning: remember <term> <meaning...>\n");
      process.exitCode = 2;
      return;
    }
    // A meaning is a short reading of a term, not a place to store standing
    // instructions — the cap keeps the memory an answer book, not a rulebook.
    if (term.length > 60 || meaning.length > 120) {
      process.stderr.write("scribe: keep it short — term <= 60 chars, meaning <= 120 chars\n");
      process.exitCode = 2;
      return;
    }
    appendMemory(root, { term: term.toLowerCase(), meaning });
    process.stdout.write("remembered: " + term.toLowerCase() + " = " + meaning + "\n");
    return;
  }
  if (cmd === "forget") {
    const term = (argv[1] || "").trim().toLowerCase();
    if (!term) {
      process.stderr.write("scribe: forget needs a term: forget <term>\n");
      process.exitCode = 2;
      return;
    }
    if (!readMemory(root).has(term)) {
      process.stderr.write("scribe: nothing remembered for " + JSON.stringify(term) + "\n");
      process.exitCode = 1;
      return;
    }
    appendMemory(root, { term, forgotten: true });
    process.stdout.write("forgotten: " + term + "\n");
    return;
  }
  process.stderr.write("scribe: unknown command " + JSON.stringify(cmd || "") +
    " (known: review, memory, remember, forget)\n");
  process.exitCode = 2;
}

if (require.main === module) main(process.argv.slice(2));

// The three thresholds are exported because the suggestion text quotes them
// verbatim, and the tests pin the quote to the constant.
module.exports = {
  analyze, STREAK_WINDOW, STREAK_WAVES, QUIET_JUDGED, OFFMENU_WINDOW, OFFMENU_ROUNDS,
};
