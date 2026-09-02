"use strict";

// The vocabulary the engine and the session hooks share: the constants that
// name jig's artifacts and the handful of pure helpers that read them.
//
// It exists to be cheap. A hook runs on every tool call, and requiring the
// engine for a schema number and two string functions made every one of those
// spawns parse five thousand lines it never called into. Nothing here touches
// the filesystem, spawns a process or requires another module, so both halves
// can name the same constant without one of them paying for the other.

// Additive-only rule: every jig schema ships at 1 and only ever
// gains fields. Reading a plan stamped higher is a refusal rather than a guess,
// because a field this build cannot see could be the one that made the write
// safe. Unknown keys at the SAME version are warned about and ignored.
const SCHEMA_VERSION = 1;

const STATE_DIR = ".jig";
// What each lane runs besides the check driver: the linter, the type checker and
// the test runner the owner ticked. Part of the install a teammate clones, like
// the config and the checks — CI reads it, so it is committed and never ignored.
const VERIFY_FILE = "verify.json";

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// The lane entries a change would leave on disk, or null when the change carries
// no readable list. Null is not "no entries" — the same rule `proposedGuards`
// draws for the config, for the same reason.
function proposedVerifyEntries(content) {
  if (typeof content !== "string") return null;
  let record = null;
  try {
    record = JSON.parse(stripBom(content));
  } catch {
    return null;
  }
  if (!isObject(record) || !Array.isArray(record.entries)) return null;
  return record.entries.filter((e) => isObject(e));
}

// The fixture path derivation, hand-copied from `scripts/templates/run.mjs`.
// That file is ESM text jig byte-copies into somebody's repository, so this one
// cannot import it; `tests/blanker-drift.test.js` holds the two copies to the
// letter. Every glob segment collapses to a concrete one, so the seeded path
// satisfies the detector's own first glob.
function concreteSegment(glob, star) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      out += star;
      while (glob[i + 1] === "*") i++;
    } else if (c === "?") {
      out += "x";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      const body = end === -1 ? glob.slice(i + 1) : glob.slice(i + 1, end);
      out += body.split(",")[0];
      i = end === -1 ? glob.length : end;
    } else {
      out += c;
    }
  }
  return out;
}

function fixturePath(det) {
  const glob = (det.params.paths || [])[0] || "fixture.txt";
  const segments = glob.split("/");
  const base = concreteSegment(segments.pop(), "fixture");
  const dirs = segments
    .filter((seg) => seg !== "**" && seg !== "")
    .map((seg) => concreteSegment(seg, "fx"));
  return [...dirs, base].join("/");
}

module.exports = {
  SCHEMA_VERSION, STATE_DIR, VERIFY_FILE,
  isObject, stripBom, proposedVerifyEntries, concreteSegment, fixturePath,
};
