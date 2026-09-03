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
function driverUnits(check) {
  return sourceUnits(check, "patterns");
}

// The removal kind reads the same way a pattern kind does — same language, same
// blanking, same regular expressions — and differs only in which of the two
// texts it counts them in. So both are built here off the params key that holds
// them.
function removedUnits(check) {
  return sourceUnits(check, "removed");
}

function sourceUnits(check, key) {
  const dets = (check.detectors || []).filter((d) => d && d.lever === "check-driver");
  const units = [];
  for (const det of dets) {
    const p = det.params || {};
    const patterns = (p[key] || []).filter((s) => typeof s === "string" && s.length);
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
    // An extract detector names `pairedWith` too and means something else by it:
    // not "this had to change alongside" but "this is where the names have to
    // appear". Read as a paired-change rule it would be held to a change-set
    // fixture it is not, and discarded for a reason that names the wrong kind.
    if ((p.extract || []).length) continue;
    const paths = (p.paths || []).filter((s) => typeof s === "string" && s.length);
    const pairedWith = (p.pairedWith || []).filter((s) => typeof s === "string" && s.length);
    if (paths.length && pairedWith.length) units.push({ paths, pairedWith });
  }
  return units;
}

// The content-relation kind. Its patterns live under `extract` and each takes a
// name out of the doc; `pairedWith` says where that name has to appear. So it
// carries no filename and no blanker options either — the comparison is over raw
// bytes, and the patterns are all there is to prove.
function extractUnits(check) {
  const units = [];
  for (const det of (check.detectors || []).filter((d) => d && d.lever === "check-driver")) {
    const p = det.params || {};
    const patterns = (p.extract || []).filter((s) => typeof s === "string" && s.length);
    const paths = (p.paths || []).filter((s) => typeof s === "string" && s.length);
    const pairedWith = (p.pairedWith || []).filter((s) => typeof s === "string" && s.length);
    // All three or nothing, exactly as the driver selects it: a rule with no doc
    // to read or no union to look the names up in evaluates to nothing there, and
    // admitting it here would be coverage nobody could run.
    if (patterns.length && paths.length && pairedWith.length) units.push({ patterns });
  }
  return units;
}

// The session levers, and what each one READS. A session guard is proven by the
// runner's OWN evaluation — injected, the way the blanker and the glob matcher
// are — because a second matcher here is exactly what let a bash-guard whose
// pattern matched nothing ship under a printed proof. A patternless session
// detector is NOT skipped the way an empty check-driver unit is: an empty driver
// unit mints no guard row and this one mints an armed guard with a coverage
// cell, so it comes in as a unit and fails on its own violation like any other
// lever that catches nothing.
//
// The kind is what a fixture pair IS — a command, or the text of one edit — and
// it is no longer the same question as which event the lever runs on:
// `edit-guard` and `bash-guard` both run at PreToolUse and read nothing alike.
const SESSION_KINDS = { "bash-guard": "bash", "edit-guard": "edit", "edit-observe-guard": "edit" };

// What a session detector matches WITH. An edit detector may name both, and each
// is proven on its own: one evaluation over the whole detector fires on either,
// so a `removed` rule nothing exercised would ride into an armed guard under the
// patterns' proof and refuse calls nobody demonstrated.
const SESSION_PARAMS = ["patterns", "removed"];

// One unit per PATTERN, not per detector: the evaluator ORs a detector's
// patterns together, so a second pattern added beside one the fixture already
// fires would be admitted on the first one's hit and never proved. The evaluator
// is handed a copy of the detector carrying that one pattern instead.
function sessionUnits(check) {
  const units = [];
  (check.detectors || []).forEach((det, i) => {
    const kind = det && SESSION_KINDS[det.lever];
    if (!kind) return;
    // The lever is named the way `adaptAuthoredDetector` names it, so the id a
    // discard reports is the id the plan and the manifest print.
    const id = det.lever + "-" + i;
    const params = det.params || {};
    const keys = SESSION_PARAMS.filter((k) => Array.isArray(params[k]) && params[k].length);
    // A matcherless session detector is NOT skipped the way an empty check-driver
    // unit is: it mints an armed guard with a coverage cell, so it comes in as a
    // unit and fails on its own violation like any other lever that catches
    // nothing.
    if (!keys.length) { units.push({ id, kind, key: null, det }); return; }
    for (const key of keys) {
      const only = { ...params };
      for (const other of SESSION_PARAMS) if (other !== key) delete only[other];
      // The suffix names only what is ambiguous — the key when the detector has
      // both, the index when that key has several — so a one-pattern lever's id
      // reads the way it always has, in a discard and in a cross row alike.
      params[key].forEach((pattern, at) => {
        const suffix = params[key].length > 1 ? key + "[" + at + "]" : (keys.length > 1 ? key : "");
        units.push({
          id: suffix ? id + " (" + suffix + ")" : id,
          kind,
          key,
          det: { ...det, params: { ...only, [key]: [pattern] } },
        });
      });
    }
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

// The removal fixture, split. A removal is not visible in one file's content —
// every deleted line is absent from the after text and present in the before, so
// what a fixture has to carry is both. `--- after` on a line of its own is the
// fence, and a side without one is not a pair this rule can read: it is thrown
// on rather than guessed at, because a check admitted over half a fixture would
// claim coverage nobody demonstrated.
//
// The extract kind needs two texts for its own reason — the doc, then the union
// its names have to appear in — and says so with `--- paired`. The label is the
// only difference; it is never anything but one of those two literals, so
// nothing here escapes it.
function fencedHalves(text, label) {
  const at = text.search(new RegExp("^--- " + (label || "after") + "$", "m"));
  if (at === -1) return null;
  const nl = text.indexOf("\n", at);
  return { before: text.slice(0, at), after: nl === -1 ? "" : text.slice(nl + 1) };
}

// The extract fence, named once so admission, the driver and the skill cannot
// spell it differently.
const PAIRED_FENCE = "paired";

// The removal detector's whole rule, written once so admission and the shipped
// driver cannot answer it differently: some pattern this detector names is in
// the before text more times than it is in the after text.
//
// `.some()` because that is what the driver does at run time — any one spelling
// dropping is a finding. Admission does NOT read it that way: it hands this one
// pattern at a time, so a spelling the fixture never drops is discarded instead
// of riding in on a sibling's count.
function removedFires(units, halves, blank) {
  return units.some((u) => {
    const before = blank(halves.before, u.filename, u.opts);
    const after = blank(halves.after, u.filename, u.opts);
    return u.patterns.some((p) => countOf(before, p) > countOf(after, p));
  });
}

function countOf(text, pattern) {
  return (text.match(new RegExp(pattern, "g")) || []).length;
}

// The extract detector's whole rule: some name this detector's regex takes out
// of the doc appears nowhere in the union it is checked against. It is the
// driver's own `extractMisses`, byte for byte, and `blanker-drift.test.js` pins
// the two together — a hand-kept copy is what lets admission and the shipped
// driver answer the same fixture differently, which is the failure the drift
// test exists to make impossible.
//
// Raw bytes on both sides, and nothing blanked. A doc has no comments to strip,
// and a name the code carries only in a comment is still a name the code
// carries — counting it present is the direction that adds no finding.
// A pattern with no capture group takes nothing out of the doc, so it finds
// nothing and never fires on its own violation — which is what discards it,
// rather than a rule here about how a pattern must be written.
function extractMisses(det, doc, union) {
  const out = [];
  for (const pattern of det.params.extract) {
    for (const m of doc.matchAll(new RegExp(pattern, "g"))) {
      if (typeof m[1] !== "string" || !m[1]) continue;
      if (union.some((body) => body.includes(m[1]))) continue;
      out.push({ pattern, at: m.index + m[0].indexOf(m[1]) });
    }
  }
  return out;
}

// A unit's patterns in the shape the shared rule reads, and the fenced halves as
// the doc and a union of exactly one text. `before` is the doc, `after` is that
// union.
function extractFires(units, halves) {
  return units.some((u) =>
    extractMisses({ params: { extract: u.patterns } }, halves.before, [halves.after]).length > 0);
}

// What a passing check has to have fired: one hit for every pattern the check
// names, in whatever kind names it, plus one per paired detector — that kind
// names two glob sets and no patterns, so the detector is the smallest thing
// there is to prove. `ownPair` counts up to this same number, because a mismatch
// between the two would discard every check silently.
function patternCount(check) {
  const flat = (units) => units.reduce((n, u) => n + u.patterns.length, 0);
  return flat(driverUnits(check)) + pairedUnits(check).length + flat(removedUnits(check)) +
    flat(extractUnits(check)) + sessionUnits(check).length;
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
  const units = driverUnits(check);
  const paired = pairedUnits(check);
  const removed = removedUnits(check);
  const extract = extractUnits(check);
  const session = sessionUnits(check);
  if (!units.length && !paired.length && !removed.length && !extract.length && !session.length) {
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
  // A removal is only visible between two texts, so both halves of the pair have
  // to carry the fence — whichever lever reads them. The session levers are held
  // to it too: unfenced, their evaluation sees an empty before and the check
  // would be discarded under a reason naming the pattern rather than the missing
  // half of the fixture.
  if (removed.length || session.some((u) => u.key === "removed")) {
    for (const [half, text] of [["violation", violation], ["nearMiss", nearMiss]]) {
      if (fencedHalves(text)) continue;
      throw new Error(`admission: check "${id}" carries a removal detector and its ${half} fixture has no ` +
        "`--- after` fence — a removal is only visible between the file before an edit and the file after it");
    }
  }
  // And the extract kind needs its own two texts for its own reason: the doc,
  // then the union its names have to appear in. Unfenced there is nothing to
  // look them up in, and every capture would read as missing.
  if (extract.length) {
    for (const [half, text] of [["violation", violation], ["nearMiss", nearMiss]]) {
      if (fencedHalves(text, PAIRED_FENCE)) continue;
      throw new Error(`admission: check "${id}" carries an extract detector and its ${half} fixture has no ` +
        "`--- paired` fence — a doc's names mean nothing without the files they have to appear in");
    }
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
  // the near miss must not. One hit per DETECTOR, because a paired detector
  // names glob sets and no patterns — a second detector added beside the first
  // rides in on its hit otherwise.
  paired.forEach((unit, at) => {
    const label = paired.length > 1 ? `paired-change[${at}]` : "paired-change";
    if (pairedFires([unit], changeSet(violation), match)) violationHits++;
    else missed.push(label);
    if (pairedFires([unit], changeSet(nearMiss), match)) {
      nearMissHits++;
      falsePositives.push(label);
    }
  });

  // The removal half. Each side of the pair is one file before an edit and the
  // same file after it, and the rule is the difference between the two counts:
  // the violation deleted something the near miss kept. One hit per PATTERN: a
  // second spelling added to a detector whose fixture already drops the first
  // would otherwise be admitted having never been dropped by anything.
  if (removed.length) {
    const halves = { violation: fencedHalves(violation), nearMiss: fencedHalves(nearMiss) };
    for (const unit of removed) {
      for (const pattern of unit.patterns) {
        const one = [{ ...unit, patterns: [pattern] }];
        let onViolation;
        let onNearMiss;
        try {
          onViolation = removedFires(one, halves.violation, blank);
          onNearMiss = removedFires(one, halves.nearMiss, blank);
        } catch (err) {
          throw new Error(`admission: check "${id}" has an unusable removal pattern — ${err.message}`);
        }
        const label = `removal /${pattern}/`;
        if (onViolation) violationHits++;
        else missed.push(label);
        if (onNearMiss) {
          nearMissHits++;
          falsePositives.push(label);
        }
      }
    }
  }

  // The content half. Each side of the pair is a doc and the union its names
  // have to appear in, and the rule is the one the driver runs: the violation
  // names something the union does not have, the near miss names nothing it
  // lacks. One hit per PATTERN, for the reason the removal half counts that way.
  if (extract.length) {
    const halves = { violation: fencedHalves(violation, PAIRED_FENCE), nearMiss: fencedHalves(nearMiss, PAIRED_FENCE) };
    for (const unit of extract) {
      for (const pattern of unit.patterns) {
        const one = [{ patterns: [pattern] }];
        let onViolation;
        let onNearMiss;
        try {
          onViolation = extractFires(one, halves.violation);
          onNearMiss = extractFires(one, halves.nearMiss);
        } catch (err) {
          throw new Error(`admission: check "${id}" has an unusable extract pattern — ${err.message}`);
        }
        const label = `extract /${pattern}/`;
        if (onViolation) violationHits++;
        else missed.push(label);
        if (onNearMiss) {
          nearMissHits++;
          falsePositives.push(label);
        }
      }
    }
  }

  // The session half. Each lever is run through the hook runner's own
  // evaluation over the same fixture pair, and counts one hit exactly as the
  // paired rule does. A lever that misses its violation or fires on its near
  // miss discards the WHOLE check: a check is one promise, and half a promise
  // printed as coverage is the defect this closes.
  for (const unit of session) {
    if (evaluate(unit.det, violation)) violationHits++;
    else missed.push(unit.id);
    if (evaluate(unit.det, nearMiss)) {
      nearMissHits++;
      falsePositives.push(unit.id);
    }
  }

  const total = patternCount(check);
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
// edit guard's near-miss source, never across the two. The kind is the lever's,
// not the event's — since 2.11.0 both kinds run at PreToolUse.
// Removal is a fourth, and crosses only among removal kinds for the same reason
// the paired kind does: its near miss is a fenced before/after pair, and no
// other kind's fixture is one. Extract is a fifth and crosses the same way: its
// near miss is a doc fenced against the union its names appear in, which is a
// third kind of fixture again.
function crossNearMiss(checks, blank, match, evaluate) {
  if (!Array.isArray(checks)) throw new Error("admission: crossNearMiss expects an array of checks");
  if (typeof blank !== "function") throw new Error("admission: crossNearMiss needs the blanker function injected");
  const rows = [];
  for (const owner of checks) {
    const ownerId = checkId(owner);
    const { nearMiss } = fixturesOf(owner, ownerId);
    const ownerUnits = driverUnits(owner);
    const ownerPaired = pairedUnits(owner);
    const ownerHalves = removedUnits(owner).length ? fencedHalves(nearMiss) : null;
    const ownerDoc = extractUnits(owner).length ? fencedHalves(nearMiss, PAIRED_FENCE) : null;
    const ownerKinds = new Set(sessionUnits(owner).map((u) => u.kind));
    for (const runner of checks) {
      const runnerId = checkId(runner);
      if (runnerId === ownerId) continue;
      if (ownerUnits.length) {
        // The foreign fixture is blanked under the foreign check's own
        // filename: it is that language's source, whatever language the check
        // reading it was written for. Only the strip flags come from the
        // reader, because those are its own reading of source.
        const ownerName = ownerUnits[0].filename;
        for (const unit of driverUnits(runner)) {
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
      // And a removal check that reads every edit as a deletion: a pattern the
      // language sheds on any rewrite drops in count somewhere eventually, and
      // its own violation cannot show that. Another removal check's near miss —
      // an edit that deliberately kept the count — is the sample that finds it.
      const runnerRemoved = removedUnits(runner);
      if (ownerHalves && runnerRemoved.length && removedFires(runnerRemoved, ownerHalves, blank)) {
        rows.push({ check: runnerId, foreignCheck: ownerId, pattern: "removal" });
      }
      // And a capture regex that takes a name out of anything. `(\w+)` finds a
      // word in every doc, and no union has every word — so it reports drift on
      // any pair of files, and its own violation cannot show that. Another
      // extract check's near miss, a doc whose every name IS in its union, is
      // the sample it was not authored against.
      const runnerExtract = extractUnits(runner);
      if (ownerDoc && runnerExtract.length && extractFires(runnerExtract, ownerDoc)) {
        rows.push({ check: runnerId, foreignCheck: ownerId, pattern: "extract" });
      }
      // And the session levers. A bash-guard whose pattern matches every command
      // still fires on its own violation and can still dodge its own near miss;
      // somebody else's near-miss command is the only sample it was not
      // authored against (SCOPE, "Is the admission test only a check against its
      // own pair").
      if (typeof evaluate === "function") {
        for (const unit of sessionUnits(runner)) {
          if (!ownerKinds.has(unit.kind)) continue;
          if (evaluate(unit.det, nearMiss)) {
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

// The module is hashed with the pair to make the proof, and the runner rehashes
// it at load time over the fixtures the MODULE exports. So a module that exports
// no `fixtures` at all — or a different pair from the one admission proved —
// records a proof that can never match itself: the guard installs armed, the
// runner pulls it back to observe on every call, and the owner has a check that
// refuses nothing. That mismatch is what the proof exists to catch, and this
// catches it one step earlier, where the author can still fix the module.
//
// Read statically, because admission runs during `plan` and `plan` executes
// nothing the model wrote. A missing export is exact; a divergent pair is read
// by looking for each fixture's text in the source, raw or JSON-escaped, which
// are the two ways a module can carry it.
const FIXTURES_EXPORT = /export\s+(?:const|let|var)\s+fixtures\b|export\s*\{[^}]*\bfixtures\b/;

function moduleFixtureProblem(check, id) {
  const src = check.module;
  if (typeof src !== "string") return null;
  if (!FIXTURES_EXPORT.test(src)) {
    return `check "${id}" ships a module with no \`fixtures\` export — its proof is hashed over the pair the ` +
      "module carries, so it would install armed and run as observe for ever";
  }
  const { violation, nearMiss } = fixturesOf(check, id);
  for (const [half, text] of [["violation", violation], ["nearMiss", nearMiss]]) {
    if (src.includes(JSON.stringify(text)) || src.includes(text)) continue;
    return `check "${id}" ships a module whose \`fixtures\` export does not carry the ${half} it was admitted ` +
      "on — the recorded proof would never match the check on disk";
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
      total = patternCount(check);
    } catch (err) {
      discarded.push({ id, why: err.message });
      continue;
    }

    if (result.violationHits !== total || result.nearMissHits > expected) {
      discarded.push({ id, why: result.why });
      continue;
    }
    const moduleWhy = moduleFixtureProblem(check, id);
    if (moduleWhy) {
      discarded.push({ id, why: moduleWhy });
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
  SESSION_KINDS,
  SESSION_PARAMS,
  fencedHalves,
  patternCount,
  ownPair,
  crossNearMiss,
  admit,
  moduleFixtureProblem,
  writeDiscarded,
  proofHash,
};
