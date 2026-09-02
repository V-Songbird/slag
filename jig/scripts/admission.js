// The fixture-pair admission test.
//
// SCOPE moves verifiability from where a check came from to whether the check
// demonstrably works, and this file is the whole of that move: a check is
// admitted when its own patterns fire on its own violation fixture and stay
// silent on its own near miss, and never for any other reason. Nothing here
// knows about the catalogue, the plan, or the owner — it is handed checks and
// a blanker and it answers yes or no.
//
// Every refusal throws. A check that cannot be tested must never be reported
// as a check that passed, and a `null` return would read as exactly that by
// the time it reached a coverage matrix.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DISCARDED_FILE = "discarded.json";

// A check states its patterns the way an edition class does — under
// `check-driver` detectors — so an authored check and a catalogue class go
// through one admission with one shape, rather than admission carrying a
// second contract forever.
function driverUnits(check, id) {
  const dets = (check.detectors || []).filter((d) => d && d.lever === "check-driver");
  const units = [];
  for (const det of dets) {
    const p = det.params || {};
    const patterns = (p.patterns || []).filter((s) => typeof s === "string" && s.length);
    if (!patterns.length) continue;
    // The fixture is text, not a file on disk, but the blanker reads comment
    // and string syntax off a filename — so the detector's own first path glob
    // decides what language this text is. A brace-glob like `**/*.{ts,tsx}`
    // has no extension to take and falls back to `.txt`, which the blanker
    // reads with slash comment rules: the right answer for every brace glob
    // shipped, and the reason this stays a two-line derivation.
    const glob = (p.paths || ["x.txt"])[0];
    const ext = (String(glob).match(/\.[A-Za-z0-9]+$/) || [".txt"])[0];
    const opts = {
      stripComments: p.stripComments !== false,
      stripStrings: p.stripStrings !== false,
    };
    const syntax = p.commentSyntax || check.commentSyntax;
    if (syntax) opts.commentSyntax = syntax;
    units.push({ filename: "fixture" + ext, opts, perLine: p.perLine === true, patterns });
  }
  return units;
}

// The paired-change kind. Its fixtures are change sets rather than source, so
// it carries no filename, no blanker options and no patterns — two path sets
// and that is all there is to prove.
function pairedUnits(check) {
  const units = [];
  for (const det of (check.detectors || []).filter((d) => d && d.lever === "check-driver")) {
    const p = det.params || {};
    const paths = (p.paths || []).filter((s) => typeof s === "string" && s.length);
    const pairedWith = (p.pairedWith || []).filter((s) => typeof s === "string" && s.length);
    if (paths.length && pairedWith.length) units.push({ paths, pairedWith });
  }
  return units;
}

// The two session levers, and the hook runner each is proven under. A session
// guard is proven by the runner's OWN evaluation — injected, the way the
// blanker and the glob matcher are — because a second matcher here is exactly
// what let a bash-guard whose pattern matched nothing ship under a printed
// proof. A patternless session detector is NOT skipped the way an empty
// check-driver unit is: an empty driver unit mints no guard row and this one
// mints an armed guard with a coverage cell, so it comes in as a unit and fails
// on its own violation like any other lever that catches nothing.
const SESSION_RUNNERS = { "bash-guard": "PreToolUse", "edit-observe-guard": "PostToolUse" };

function sessionUnits(check) {
  const units = [];
  (check.detectors || []).forEach((det, i) => {
    const runner = det && SESSION_RUNNERS[det.lever];
    // The lever is named the way `adaptAuthoredDetector` names it, so the id a
    // discard reports is the id the plan and the manifest print.
    if (runner) units.push({ id: det.lever + "-" + i, runner, det });
  });
  return units;
}

// A change-set fixture is one path per line. Blank lines and stray indentation
// are the author's formatting, never part of a path.
function changeSet(text) {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

// The paired detector's whole rule, written once so admission and the shipped
// driver cannot answer it differently: the set touched something in `paths` and
// nothing in `pairedWith`.
function pairedFires(units, set, match) {
  return units.some((u) => set.some((rel) => matchesAny(rel, u.paths, match)) &&
    !set.some((rel) => matchesAny(rel, u.pairedWith, match)));
}

function matchesAny(rel, globs, match) {
  return globs.some((g) => match(g).test(rel));
}

// What a passing check has to have fired. One per pattern, plus one for the
// paired rule if the check carries one — the same total `ownPair` counts up to,
// because a mismatch between the two would discard every check silently.
function patternCount(check, id) {
  return driverUnits(check, id).reduce((n, u) => n + u.patterns.length, 0) +
    (pairedUnits(check).length ? 1 : 0) + sessionUnits(check).length;
}

function checkId(check) {
  if (!check || typeof check !== "object" || typeof check.id !== "string" || !check.id.trim()) {
    throw new Error("admission: every check needs a string id — an unnamed check cannot be recorded as admitted or discarded");
  }
  return check.id;
}

function fixturesOf(check, id) {
  const f = check.fixtures || {};
  for (const half of ["violation", "nearMiss"]) {
    if (typeof f[half] !== "string" || !f[half].length) {
      throw new Error(
        `admission: check "${id}" declares no inline ${half} fixture — SCOPE admits a check on its pair and nothing else`,
      );
    }
  }
  return f;
}

// `perLine` is not a nicety. A pattern with a negated character class in it —
// `curl [^|]* \| sh` — crosses newlines happily, so run whole-file it pairs a
// curl on line 3 with an unrelated pipe on line 40 and admits a check that
// would fire on anything.
function fires(blanked, pattern, perLine) {
  const re = new RegExp(pattern);
  return perLine ? blanked.split("\n").some((line) => re.test(line)) : re.test(blanked);
}

function ownPair(check, blank, match, evaluate) {
  const id = checkId(check);
  if (typeof blank !== "function") {
    throw new Error(`admission: check "${id}" cannot be tested — no blanker function was injected`);
  }
  const { violation, nearMiss } = fixturesOf(check, id);
  const units = driverUnits(check, id);
  const paired = pairedUnits(check);
  const session = sessionUnits(check);
  if (!units.length && !paired.length && !session.length) {
    throw new Error(
      `admission: check "${id}" declares no check-driver patterns, so there is nothing to prove against its fixtures`,
    );
  }
  // A paired check is proven the same way and by the same rule the driver runs,
  // so it needs the glob matcher the way a pattern check needs the blanker.
  // Missing, it is untestable, and an untestable check is never an admitted one.
  if (paired.length && typeof match !== "function") {
    throw new Error(`admission: check "${id}" is a paired-change check and no glob matcher was injected — it cannot be tested`);
  }
  if (session.length && typeof evaluate !== "function") {
    throw new Error(`admission: check "${id}" carries the session lever(s) ${session.map((u) => u.id).join(", ")} ` +
      "and no session evaluator was injected — it cannot be tested");
  }

  let violationHits = 0;
  let nearMissHits = 0;
  const missed = [];
  const falsePositives = [];
  for (const unit of units) {
    const cleanViolation = blank(violation, unit.filename, unit.opts);
    const cleanNearMiss = blank(nearMiss, unit.filename, unit.opts);
    for (const pattern of unit.patterns) {
      let onViolation;
      let onNearMiss;
      try {
        onViolation = fires(cleanViolation, pattern, unit.perLine);
        onNearMiss = fires(cleanNearMiss, pattern, unit.perLine);
      } catch (err) {
        // A pattern that will not compile is a defect in the check, and the
        // raw SyntaxError names neither the check nor the pattern.
        throw new Error(`admission: check "${id}" has an unusable pattern /${pattern}/ — ${err.message}`);
      }
      if (onViolation) violationHits++;
      else missed.push(pattern);
      if (onNearMiss) {
        nearMissHits++;
        falsePositives.push(pattern);
      }
    }
  }

  // The paired half. Its fixtures are read as change sets, and the pair means
  // the same thing it means for a pattern check: the violation must fire it and
  // the near miss must not. One unit, one hit, so the totals stay comparable.
  if (paired.length) {
    if (pairedFires(paired, changeSet(violation), match)) violationHits++;
    else missed.push("paired-change");
    if (pairedFires(paired, changeSet(nearMiss), match)) {
      nearMissHits++;
      falsePositives.push("paired-change");
    }
  }

  // The session half. Each lever is run through the hook runner's own
  // evaluation over the same fixture pair, and counts one hit exactly as the
  // paired rule does. A lever that misses its violation or fires on its near
  // miss discards the WHOLE check: a check is one promise, and half a promise
  // printed as coverage is the defect this closes.
  for (const unit of session) {
    if (evaluate(unit.det, unit.runner, violation)) violationHits++;
    else missed.push(unit.id);
    if (evaluate(unit.det, unit.runner, nearMiss)) {
      nearMissHits++;
      falsePositives.push(unit.id);
    }
  }

  const total = units.reduce((n, u) => n + u.patterns.length, 0) + (paired.length ? 1 : 0) + session.length;
  const passes = violationHits === total && nearMissHits === 0;
  const reasons = [];
  if (missed.length) {
    reasons.push(`${missed.length} of ${total} pattern(s) never fired on the violation fixture: ${missed.join(", ")}`);
  }
  if (falsePositives.length) {
    reasons.push(`${falsePositives.length} pattern(s) fired on the near miss: ${falsePositives.join(", ")}`);
  }
  return { id, violationHits, nearMissHits, passes, why: passes ? null : reasons.join("; ") };
}

// The pair test cannot see a check that fires on everything, because a check
// that fires on everything still fires on its own violation and can still be
// written to dodge its own near miss. Somebody else's near miss is the only
// sample it was not authored against.
// The two kinds are crossed separately, and never against each other. A foreign
// near miss only tests a check when it is the kind of thing that check reads:
// running a source pattern over a list of file paths, or a path rule over
// somebody's Python, proves nothing about either and would fail at random.
// The session levers are a third kind and cross the same way: a bash-guard
// against another bash-guard's near-miss command, an edit guard against another
// edit guard's near-miss source, never across the two.
function crossNearMiss(checks, blank, match, evaluate) {
  if (!Array.isArray(checks)) throw new Error("admission: crossNearMiss expects an array of checks");
  if (typeof blank !== "function") throw new Error("admission: crossNearMiss needs the blanker function injected");
  const rows = [];
  for (const owner of checks) {
    const ownerId = checkId(owner);
    const { nearMiss } = fixturesOf(owner, ownerId);
    const ownerUnits = driverUnits(owner, ownerId);
    const ownerPaired = pairedUnits(owner);
    const ownerRunners = new Set(sessionUnits(owner).map((u) => u.runner));
    for (const runner of checks) {
      const runnerId = checkId(runner);
      if (runnerId === ownerId) continue;
      if (ownerUnits.length) {
        // The foreign fixture is blanked under the foreign check's own
        // filename: it is that language's source, whatever language the check
        // reading it was written for. Only the strip flags come from the
        // reader, because those are its own reading of source.
        const ownerName = ownerUnits[0].filename;
        for (const unit of driverUnits(runner, runnerId)) {
          const blanked = blank(nearMiss, ownerName, unit.opts);
          for (const pattern of unit.patterns) {
            if (fires(blanked, pattern, unit.perLine)) {
              rows.push({ check: runnerId, foreignCheck: ownerId, pattern });
            }
          }
        }
      }
      // A paired check that fires on everything is the same hazard with a
      // different shape: `**` paired with something nothing ever matches. Every
      // other paired check's near-miss change set is the sample that finds it.
      const runnerPaired = pairedUnits(runner);
      if (ownerPaired.length && runnerPaired.length && typeof match === "function" &&
          pairedFires(runnerPaired, changeSet(nearMiss), match)) {
        rows.push({ check: runnerId, foreignCheck: ownerId, pattern: "paired-change" });
      }
      // And the session levers. A bash-guard whose pattern matches every command
      // still fires on its own violation and can still dodge its own near miss;
      // somebody else's near-miss command is the only sample it was not
      // authored against (SCOPE, "Is the admission test only a check against its
      // own pair").
      if (typeof evaluate === "function") {
        for (const unit of sessionUnits(runner)) {
          if (!ownerRunners.has(unit.runner)) continue;
          if (evaluate(unit.det, unit.runner, nearMiss)) {
            rows.push({ check: runnerId, foreignCheck: ownerId, pattern: unit.id });
          }
        }
      }
    }
  }
  return rows;
}

// SCOPE: the deny triple is authored alongside the check, and a missing part
// discards it exactly as a failing fixture does — a guard that can refuse a
// call without saying why, offering nothing else, and with no way out is worse
// than no guard.
const DENY_PARTS = ["reason", "alternative", "override"];

// A deny reply is prose, and the fixture pair cannot read prose. jig has already
// shipped an `alternative` sliced out of a catalogue note mid-code-span, present
// and complete and meaningless to the agent it refuses. These two are what a
// machine can tell about it: text that opens a code span and never closes it was
// cut, and text this short cannot say what to do instead.
const DENY_FLOOR = 20;

function denySense(part, text) {
  const trimmed = text.trim();
  if (trimmed.length < DENY_FLOOR) {
    return `its ${part} is ${trimmed.length} characters, under the ${DENY_FLOOR}-character floor — too short to tell a blocked call anything`;
  }
  // An odd number of backticks means a span was opened and the text ended
  // inside it, which is what a mid-sentence slice out of markdown looks like.
  if ((trimmed.match(/`/g) || []).length % 2 === 1) {
    return `its ${part} ends inside an unclosed code span, so the text was cut mid-sentence`;
  }
  return null;
}

// Every reply this check can hand a blocked call, resolved the way the runner
// resolves it: a detector's own deny wins over the check's (`denyOf` in
// jig-lib). Reading only the check's is how a garbled per-detector triple went
// past admission, past the plan, and into the words a refused agent reads.
function denyReplies(check) {
  const dets = (check.detectors || []).filter((d) => d && typeof d === "object");
  return dets.length ? dets.map((d) => d.deny || check.deny) : [check.deny];
}

function denyProblem(check, id) {
  for (const deny of denyReplies(check)) {
    if (!deny || typeof deny !== "object") {
      return `check "${id}" declares no deny triple — reason, alternative and override are all required`;
    }
    const missing = DENY_PARTS.filter((k) => typeof deny[k] !== "string" || !deny[k].trim());
    if (missing.length) return `check "${id}" has an incomplete deny triple — missing ${missing.join(", ")}`;
    for (const part of DENY_PARTS) {
      const why = denySense(part, deny[part]);
      if (why) return `check "${id}" ships a deny reply that was not authored whole — ${why}`;
    }
  }
  return null;
}

// A heuristic check may buy one known near-miss hit up front. The number is
// carried into the result rather than consumed here, so what was tolerated is
// disclosed on the coverage matrix instead of vanishing into a pass.
function declaredNearMissHits(check, id) {
  const n = check.expectedNearMissHits;
  if (n === undefined || n === null) return 0;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`admission: check "${id}" declares expectedNearMissHits=${JSON.stringify(n)} — it must be a non-negative integer`);
  }
  return n;
}

// `opts.cross` folds cross-class hits into the discards. It is off by default
// because two checks over the same language legitimately share shapes, and a
// disclosed cross hit is evidence for the owner rather than an automatic
// verdict. Turning it on makes admission strict.
//
// `opts.match` is the glob matcher, injected the way the blanker is, and only a
// paired-change check needs it. `opts.evaluate` is the hook runner's own
// session evaluation, and only a check carrying a session lever needs it.
// Without either, such a check is discarded with that as the reason rather than
// admitted untested.
function admit(checks, blank, opts) {
  if (!Array.isArray(checks)) throw new Error("admission: admit expects an array of authored checks");
  if (typeof blank !== "function") throw new Error("admission: admit needs the blanker function injected");
  const o = opts || {};
  const admitted = [];
  const discarded = [];
  const seen = new Set();

  for (const check of checks) {
    const id = checkId(check);
    if (seen.has(id)) {
      // Two checks under one id cannot both be recorded, armed or reverted.
      // Refusing the batch is the only answer that does not lose one of them.
      throw new Error(`admission: two checks claim the id "${id}" — check ids must be unique`);
    }
    seen.add(id);

    const denyWhy = denyProblem(check, id);
    if (denyWhy) {
      discarded.push({ id, why: denyWhy });
      continue;
    }

    let result;
    let expected;
    let total;
    try {
      expected = declaredNearMissHits(check, id);
      result = ownPair(check, blank, o.match, o.evaluate);
      total = patternCount(check, id);
    } catch (err) {
      discarded.push({ id, why: err.message });
      continue;
    }

    if (result.violationHits !== total || result.nearMissHits > expected) {
      discarded.push({ id, why: result.why });
      continue;
    }
    admitted.push({
      id,
      check,
      violationHits: result.violationHits,
      nearMissHits: result.nearMissHits,
      expectedNearMissHits: expected,
    });
  }

  if (o.cross) {
    for (const row of crossNearMiss(admitted.map((a) => a.check), blank, o.match, o.evaluate)) {
      const at = admitted.findIndex((a) => a.id === row.check);
      if (at === -1) continue;
      admitted.splice(at, 1);
      discarded.push({
        id: row.check,
        why: `check "${row.check}" fired on ${row.foreignCheck}'s near miss with /${row.pattern}/`,
      });
    }
  }

  return { admitted, discarded };
}

// SCOPE: a discard reported only in a transcript is hidden by morning. The file
// is written even when nothing was discarded, because an absent file and a
// clean run are the same silence otherwise.
function writeDiscarded(stateDir, discarded) {
  if (typeof stateDir !== "string" || !stateDir.trim()) {
    throw new Error("admission: writeDiscarded needs the state directory as an explicit path");
  }
  if (!Array.isArray(discarded)) throw new Error("admission: writeDiscarded expects an array of discarded rows");
  for (const row of discarded) {
    if (!row || typeof row.id !== "string" || typeof row.why !== "string" || !row.why.trim()) {
      throw new Error(`admission: every discarded row needs an id and a readable why — got ${JSON.stringify(row)}`);
    }
  }
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, DISCARDED_FILE);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, discarded }, null, 2) + "\n");
  return file;
}

// What binds a proof to the check it proves. Each part is length-prefixed
// before hashing: concatenated plainly, moving a line out of the module and
// into a fixture would leave the digest unchanged, and a hand-edited config
// could claim a proof it does not have.
function proofHash(checkSource, violation, nearMiss) {
  const parts = [["checkSource", checkSource], ["violation", violation], ["nearMiss", nearMiss]];
  const h = crypto.createHash("sha256");
  for (const [name, value] of parts) {
    if (typeof value !== "string") {
      throw new Error(`admission: proofHash needs ${name} as a string — a proof over a missing part would bind nothing`);
    }
    h.update(String(Buffer.byteLength(value)) + "\n").update(value);
  }
  return h.digest("hex");
}

module.exports = {
  ownPair,
  crossNearMiss,
  admit,
  writeDiscarded,
  proofHash,
};
