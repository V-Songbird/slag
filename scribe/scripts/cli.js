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

function analyze(rows, cfg) {
  const t = { judged: 0, capped: 0, rounds: 0, wavedOff: 0, passed: 0 };
  const sessions = new Map();
  const recentRounds = [];
  const recentEvents = [];
  const pending = new Map(); // session -> its latest judged row is still unanswered

  for (const row of rows) {
    const s = sessions.get(row.session) || { judged: 0, rounds: 0, wavedOff: 0 };
    sessions.set(row.session, s);
    if (row.kind === "judged") {
      if (row.capped) {
        t.capped++;
        continue;
      }
      if (pending.get(row.session)) t.passed++;
      pending.set(row.session, true);
      t.judged++;
      s.judged++;
    } else if (row.kind === "asked") {
      pending.set(row.session, false);
      t.rounds++;
      s.rounds++;
      recentRounds.push(row);
      recentEvents.push("asked");
    } else if (row.kind === "waved-off") {
      t.wavedOff++;
      s.wavedOff++;
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
  if (t.rounds === 0 && t.judged >= QUIET_JUDGED && cfg.bar === "conservative") {
    suggestions.push(
      "quiet gate: " + t.judged + " prompts judged, zero questions asked (rule: " +
      QUIET_JUDGED + "+ judged, none asked, conservative bar). Either your prompts " +
      'are precise — good — or the bar is high; "bar": "standard" asks more.',
    );
  }
  if (t.capped > 0) {
    suggestions.push(
      "fatigue cap engaged " + t.capped + " time(s): scribe stopped asking after " +
      cfg.fatigueCap + " rounds in a session. Raise \"fatigueCap\" only if the " +
      "rounds were genuinely earning their answers.",
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
  process.stdout.write(out.join("\n") + "\n");
}

function main(argv) {
  const cmd = argv[0];
  const root = process.cwd();
  if (cmd === "review") return review(root, argv.includes("--json"));
  process.stderr.write("scribe: unknown command " + JSON.stringify(cmd || "") +
    " (known: review)\n");
  process.exitCode = 2;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { analyze, STREAK_WINDOW, STREAK_WAVES, QUIET_JUDGED };
