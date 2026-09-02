"use strict";

// The in-place upgrade from a jig 1.0.1 install (SCOPE decision 2). The owner
// never runs `revert --all` first and never hand-edits anything under `.jig/`:
// jig reads the install it already made and rewrites it into the shape this
// engine reads, as one journaled transaction that reverts like any other.
//
// Three things make this more than a rename pass:
//
//   1. A 1.0.1 check module states its violation as `selftest = {path, sample}`
//      and nothing else. This engine admits a check on a fixture PAIR, so every
//      installed module is rewritten to carry both halves inline and is then
//      put through the same admission test an authored check faces. A module
//      that cannot be proven that way is discarded and reported — never carried
//      forward unproven, and never left running either.
//   2. Two of the four 1.0.1 classes were renamed by the editions. The guard
//      that watches one keeps its id anyway, because the ledger's history is
//      keyed on that id and an orphaned history is a migration failure rather
//      than an acceptable cost. Only the class the guard names moves.
//   3. The installed check driver carries the 1.0.1 blanker, whose three
//      confirmed faults are what the fixture pair is proven against here. A
//      check admitted under the fixed blanker and then run under the broken one
//      would be a proof about a different program, so the driver is refreshed
//      in the same transaction.
//
//   node jig.js migrate [--root <path>]
//
// Nothing is armed by this command. A guard keeps whatever mode its own row
// recorded (SCOPE, "What mode does a migrated 1.0.1 guard take"), and a row
// that recorded nothing lands in observe.

const fs = require("fs");
const path = require("path");

const jig = require("./jig.js");
const admission = require("./admission.js");
const editionsLib = require("./editions.js");
// The 1.0.1 catalogue is the record of the install being migrated: it holds the
// deny triple each class shipped with and the fixture pair its patterns were
// proven against. It is frozen input, not a catalogue jig still ships from —
// which is why it lives under `legacy/` rather than beside the editions. Read
// as history, never as a gate.
const legacyCatalogue = require("./legacy/catalogue-1.0.1.json");

const CHECKS_DIR = jig.STATE_DIR + "/checks";
const CHECK_SUFFIX = ".check.mjs";
const DRIVER_PATH = CHECKS_DIR + "/run.mjs";
const CONFIG_PATH = jig.STATE_DIR + "/" + jig.CONFIG_FILE;
const MANIFEST_PATH = jig.STATE_DIR + "/" + jig.MANIFEST_FILE;

// 1.0.1 shipped one catalogue and it was the Node one, so every class a 1.0.1
// install can carry belongs to what is now the javascript-typescript edition.
const LEGACY_EDITION = "javascript-typescript";

// SCOPE, "How do 1.0.1 class ids migrate": an explicit old-to-new map. A class
// missing from it has no edition equivalent and carries forward under its own
// id as an authored check — the fixture pair is what admits it either way.
const CLASS_MAP = {
  "silent-catch": "swallowed-exception",
  "focused-or-skipped-test": "skipped-test",
};

const HOOK_RUNNERS = jig.HOOK_RUNNERS;
const MODES = ["observe", "armed"];

function expected(message) {
  const err = new Error(message);
  err.expected = true;
  return err;
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function statePath(root, ...parts) {
  return path.join(root, jig.STATE_DIR, ...parts);
}

function readText(root, rel) {
  const full = path.join(root, rel);
  return fs.existsSync(full) ? fs.readFileSync(full) : null;
}

// ---------------------------------------------------------------------------
// Reading the install
// ---------------------------------------------------------------------------

// Every refusal here happens before a single byte is written. An install this
// engine cannot fully read is an install it must not rewrite: the field it
// cannot see could be the one that narrowed a guard.
function readLegacyConfig(root) {
  const buf = readText(root, CONFIG_PATH);
  if (buf === null) {
    throw expected("there is no " + CONFIG_PATH + " here, so this is not a jig install — nothing was written.");
  }
  let record;
  try {
    record = JSON.parse(jig.stripBom(buf.toString("utf8")));
  } catch (err) {
    throw expected(CONFIG_PATH + " is not readable JSON (" + err.message + "). Repair it before migrating —" +
      " migration rewrites that file and would have to guess at what it said. Nothing was written.");
  }
  if (!isObject(record)) throw expected(CONFIG_PATH + " is not a guard configuration — nothing was written.");
  if (record.schemaVersion > jig.SCHEMA_VERSION) {
    throw expected(CONFIG_PATH + " is schemaVersion " + record.schemaVersion + " and this engine reads " +
      jig.SCHEMA_VERSION + ". The install is newer than the jig running here — upgrade jig rather than" +
      " migrating an install it cannot fully read. Nothing was written.");
  }
  return record;
}

// The scan options a 1.0.1 module states are inside its `check` body, not in
// its exports, so the only way to read them is to hand the module a context
// that records the call. The module is already being `require`d for its
// patterns; running one function of it costs nothing more in trust.
function scanCall(mod) {
  let seen = null;
  const ctx = {
    scan(classId, paths, patterns, opts) {
      if (!seen) seen = { paths: paths || [], patterns: patterns || [], opts: opts || {} };
      return [];
    },
    files: () => [],
    read: () => null,
    clean: (rel, text) => text,
    lineOf: () => 1,
    finding: () => ({}),
    // A check that reads git gets an honest "git did not answer" and returns
    // its skip row, which is exactly the shape that has no patterns to prove.
    git: () => ({ ok: false, stdout: "" }),
  };
  try {
    mod.check(ctx);
  } catch (err) {
    return null;
  }
  return seen && seen.patterns.length ? seen : null;
}

function loadModule(root, rel) {
  try {
    // `require` reads an ESM module synchronously, the same door jig-lib opens
    // for an installed check.
    return { mod: require(path.join(root, rel)) };
  } catch (err) {
    return { problem: "it could not be read (" + String(err.message).split("\n")[0] + ")" };
  }
}

// The pair a 1.0.1 class was proven against, as text. The catalogue names the
// files relative to the repository that builds jig, so the leading segment is
// dropped and the rest resolved inside the plugin — a marketplace install does
// not have to be in a directory called `jig` for its own fixtures to be found.
function fixturePair(cls) {
  const read = (rels) => {
    const texts = [];
    for (const rel of rels || []) {
      const file = path.join(jig.PLUGIN_ROOT, String(rel).split("/").slice(1).join("/"));
      if (!fs.existsSync(file)) return null;
      texts.push(fs.readFileSync(file, "utf8"));
    }
    return texts.length ? texts.join("\n") : null;
  };
  const fixtures = cls.fixtures || {};
  const violation = read(fixtures.violation);
  const nearMiss = read(fixtures.nearMiss);
  return violation && nearMiss ? { violation, nearMiss } : null;
}

// ---------------------------------------------------------------------------
// One migrated check
// ---------------------------------------------------------------------------

function driverDetector(cls, mod, call) {
  const legacy = (cls.detectors || []).find((d) => d.lever === "check-driver") || {};
  const o = call.opts;
  return {
    lever: "check-driver",
    actor: legacy.actor || "human-editor",
    confidence: legacy.confidence || mod.confidence || "deterministic",
    params: {
      patterns: call.patterns,
      paths: call.paths,
      // `strings` was the driver's older spelling of `stripStrings`, and both
      // switches default to true. Normalised once, here, so nothing downstream
      // has to re-derive what the installed module meant.
      stripComments: o.stripComments !== false,
      stripStrings: o.stripStrings !== undefined ? o.stripStrings !== false : o.strings !== false,
      perLine: o.perLine === true,
    },
  };
}

// Only the session detectors the config actually installed a guard for. The
// catalogue class carries more than any one install used, and carrying the rest
// would widen what the migrated check watches without anybody approving it.
function guardDetectors(cls, rows) {
  const out = [];
  for (const row of rows) {
    const det = (cls.detectors || []).find((d) => d.id === row.detector && HOOK_RUNNERS.includes(d.runner));
    if (!det || out.some((d) => d.id === det.id)) continue;
    out.push({
      lever: det.lever,
      id: det.id,
      runner: det.runner,
      actor: det.actor,
      confidence: det.confidence,
      params: det.params,
      deny: det.deny,
    });
  }
  return out;
}

function moduleSource(row) {
  return [
    "// jig:owned — migrated by jig from the 1.0.1 check `" + row.was + "`.",
    "//",
    "// The file keeps the name 1.0.1 gave it, and so does every guard that names",
    "// it. The ledger's history is keyed on that name, and a rename here would",
    "// orphan everything those guards have recorded.",
    "",
    "export const id = " + JSON.stringify(row.id) + ";",
    "export const title = " + JSON.stringify(row.title) + ";",
    "export const severity = " + JSON.stringify(row.severity) + ";",
    "",
    "export const detectors = " + JSON.stringify(row.detectors, null, 2) + ";",
    "",
    "// The deny triple 1.0.1 shipped for this class, carried forward whole.",
    "export const deny = " + JSON.stringify(row.deny, null, 2) + ";",
    "",
    "// The pair this check was admitted on, inline so it reverts with the check",
    "// and the selftest stays re-runnable forever.",
    "export const fixtures = " + JSON.stringify(row.fixtures, null, 2) + ";",
    "",
    "export function check(ctx) {",
    "  const det = detectors.find((d) => d.lever === \"check-driver\");",
    "  return ctx.scan(id, det.params.paths, det.params.patterns, det.params);",
    "}",
    "",
  ].join("\n");
}

// What a discarded check leaves behind. The file stays — `revert` puts the
// original back byte for byte from it — but it exports nothing, so the driver
// skips it and an unproven check stops running the moment it is discarded.
function tombstoneSource(id, why) {
  return [
    "// jig:owned — discarded by jig's 1.0.1 migration.",
    "//",
    "// The check `" + id + "` could not be proven against a fixture pair:",
    "//   " + why,
    "//",
    "// It exports nothing, so nothing runs it. Its ledger history is untouched,",
    "// `revert` puts the original file back, and /jig:jig can author a",
    "// replacement that earns its place on a pair of its own.",
    "",
  ].join("\n");
}

// The whole per-module decision: what this check becomes, or why it cannot
// become anything. Nothing here judges the pair — admission does that, over
// every check at once, because a check that fires on everything is only visible
// from another check's near miss.
function authoredFrom(root, artifact, guardRows, edition) {
  const was = path.basename(artifact.path, CHECK_SUFFIX);
  const loaded = loadModule(root, artifact.path);
  if (loaded.problem) return { was, path: artifact.path, why: "the installed check " + loaded.problem };
  const mod = loaded.mod;

  const oldId = typeof mod.id === "string" && mod.id ? mod.id : was;
  const cls = legacyCatalogue.classes.find((c) => c.id === oldId);
  if (!cls) {
    return { was, path: artifact.path, why: "no 1.0.1 class `" + oldId + "` — migration has no deny reply and no" +
      " fixture pair to prove this check with" };
  }
  const call = scanCall(mod);
  if (!call) {
    return { was, path: artifact.path, why: "the check scans no patterns, so there is nothing a fixture pair can" +
      " prove about it" };
  }
  const fixtures = fixturePair(cls);
  if (!fixtures) {
    return { was, path: artifact.path, why: "the 1.0.1 fixtures for `" + oldId + "` are not on this machine, so the" +
      " pair cannot be run" };
  }

  const detectors = [driverDetector(cls, mod, call), ...guardDetectors(cls, guardRows)];
  const deny = (detectors.find((d) => d.deny) || {}).deny ||
    ((cls.detectors || []).find((d) => d.deny) || {}).deny;

  const mapped = CLASS_MAP[oldId];
  const editionClass = mapped ? editionsLib.editionClass(edition, mapped) : null;
  return {
    was,
    path: artifact.path,
    check: {
      id: editionClass ? editionsLib.namespacedId(edition.edition, editionClass.id) : oldId,
      title: editionClass ? editionClass.title : (mod.title || cls.title),
      severity: editionClass ? editionClass.severity : (mod.severity || cls.severity || "safety"),
      detectors,
      deny,
      fixtures,
    },
  };
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

function changeId(name, content) {
  return "migrate-" + name + "-" + jig.hashBytes(Buffer.from(content, "utf8")).slice(0, 8);
}

// The artifact as it will actually sit on disk. The engine writes every file in
// the target's own EOL and BOM style, so a hash or a proof taken over the
// payload as authored describes bytes the file never has: the manifest would
// report a freshly migrated install as drifted, and the proof recorded for a
// guard would not match the check the runner reads on a CRLF checkout.
function asWritten(root, rel, content) {
  const bytes = jig.applyStyle(content, jig.detectStyle(readText(root, rel)));
  return { text: bytes.toString("utf8"), hash: jig.hashBytes(bytes) };
}

function cmdMigrate(root) {
  if (!fs.existsSync(statePath(root))) {
    throw expected("there is no " + jig.STATE_DIR + "/ here — `migrate` upgrades an install jig already made," +
      " and there is nothing here to upgrade. Nothing was written.");
  }
  const config = readLegacyConfig(root);
  const manifest = jig.readManifest(root);
  if (!manifest.artifacts.length) {
    throw expected(MANIFEST_PATH + " records no artifacts, so nothing here was installed by jig — nothing was" +
      " written.");
  }
  // A damaged journal is refused before the transaction starts rather than
  // appended to: it holds the only copy of this project as it was.
  jig.readJournal(root);

  const states = jig.manifestStates(root, manifest);
  const modules = states.filter((a) => a.path.startsWith(CHECKS_DIR + "/") && a.path.endsWith(CHECK_SUFFIX) &&
    a.state !== "retired");
  const guards = (Array.isArray(config.guards) ? config.guards : []).filter(isObject);

  if (!modules.length) {
    throw expected("no check modules are installed under " + CHECKS_DIR + "/, so there is nothing to migrate." +
      " Nothing was written.");
  }
  // Read off the config and the module text rather than by loading the
  // modules: `export const selftest` IS the 1.0.1 shape, and a half-finished
  // migration still shows it, which is what makes running migrate again the
  // right move after an interrupted one.
  const legacy = guards.some((g) => typeof g.detector === "string") ||
    modules.some((a) => /\bexport const selftest\b/.test(String(readText(root, a.path))));
  // Not a refusal. "There was nothing to upgrade" is the answer migrate exists
  // to give on a repository that is already current, and exiting 1 on it made
  // every caller treat the healthy case as a failure.
  if (!legacy) {
    return {
      ok: true,
      migrated: [],
      why: "this install is already on the pair shape — every guard names an installed check and no check" +
        " carries a 1.0.1 selftest. Nothing was written.",
    };
  }

  // jig will not write over a file it does not own, and a file jig installed
  // and somebody then edited is theirs now. One edited artifact refuses
  // the whole migration, because the migration is one transaction.
  const blocked = [...modules.map((a) => a.path), DRIVER_PATH]
    .map((rel) => jig.occupancyProblem(root, rel, states))
    .filter(Boolean);
  if (blocked.length) {
    throw expected("Refusing to migrate:\n  - " + blocked.join("\n  - ") +
      "\n  Revert or remove each one, then run migrate again. Nothing was written.");
  }

  const edition = editionsLib.loadEdition(jig.PLUGIN_ROOT, LEGACY_EDITION);
  const byClass = new Map();
  for (const g of guards) byClass.set(g.classId, [...(byClass.get(g.classId) || []), g]);

  const candidates = [];
  const discarded = [];
  const tombstones = new Map();
  for (const artifact of modules) {
    const row = authoredFrom(root, artifact, byClass.get(path.basename(artifact.path, CHECK_SUFFIX)) ||
      byClass.get(artifact.classIds && artifact.classIds[0]) || [], edition);
    if (row.why) {
      discarded.push({ id: row.was, why: row.why });
      tombstones.set(row.path, tombstoneSource(row.was, row.why));
      continue;
    }
    candidates.push(row);
  }

  // The same admission every authored check faces, cross near-miss included:
  // migration is not a door around the test that admits a check.
  const { blankRegions } = require("../hooks/jig-lib.js");
  const verdict = admission.admit(candidates.map((c) => c.check), blankRegions, { cross: true });
  const admitted = new Map(verdict.admitted.map((a) => [a.id, a]));
  for (const row of candidates) {
    if (admitted.has(row.check.id)) continue;
    const why = (verdict.discarded.find((d) => d.id === row.check.id) || {}).why || "the fixture pair did not pass";
    discarded.push({ id: row.was, why });
    tombstones.set(row.path, tombstoneSource(row.was, why));
  }

  // The migrated modules. Each one keeps its own path — that name is what the
  // guards and the ledger are keyed on — and carries the proof that binds it to
  // the pair it was just admitted on.
  const written = new Map();
  const changes = [];
  const migrated = [];
  for (const row of candidates) {
    if (!admitted.has(row.check.id)) continue;
    const source = moduleSource(row.check);
    const disk = asWritten(root, row.path, source);
    const proof = admission.proofHash(disk.text, row.check.fixtures.violation, row.check.fixtures.nearMiss);
    const id = changeId(row.was, source);
    changes.push({
      id, kind: "write-side-file", path: row.path, content: source,
      classIds: [row.check.id], ownership: "file", proof,
      rationale: "migrate " + row.was + " to the pair shape",
    });
    written.set(row.path, {
      id, classIds: [row.check.id], proof, hash: disk.hash,
      template: { name: "check-" + row.was, version: "migrated" },
    });
    migrated.push({ was: row.was, classId: row.check.id, check: row.was, proof });
  }
  for (const [rel, source] of tombstones) {
    const id = changeId(path.basename(rel, CHECK_SUFFIX) + "-discarded", source);
    changes.push({
      id, kind: "write-side-file", path: rel, content: source,
      classIds: [], ownership: "file",
      rationale: "discard " + path.basename(rel, CHECK_SUFFIX) + " — it could not be proven",
    });
    written.set(rel, { id, classIds: [], proof: null, hash: asWritten(root, rel, source).hash,
      template: { name: "discarded-" + path.basename(rel, CHECK_SUFFIX), version: "migrated" } });
  }

  // The driver, refreshed in the same transaction. The pairs above were proven
  // against the corrected blanker, and the 1.0.1 copy on disk is the one whose
  // faults that correction fixed.
  const driverEntry = jig.templateIndex().find((t) => t.name === "check-driver");
  const driverBody = jig.templateBody(driverEntry);
  const driverId = changeId("driver", driverBody);
  changes.push({
    id: driverId, kind: "write-side-file", path: DRIVER_PATH, content: driverBody,
    classIds: [], ownership: "file",
    rationale: "the migrated checks are proven against this driver's blanker, not the 1.0.1 one",
  });
  written.set(DRIVER_PATH, {
    id: driverId, classIds: [], proof: null, hash: asWritten(root, DRIVER_PATH, driverBody).hash,
    template: { name: driverEntry.name, version: driverEntry.version },
  });

  // The config. Guard ids survive verbatim; only the class a guard names, the
  // check it points at and the proof binding them move. There is no top-level
  // `mode` any more, and a guard whose own row recorded nothing lands in
  // observe rather than inheriting one word that armed the whole file.
  const bySlug = new Map(migrated.map((m) => [m.check, m]));
  const newGuards = [];
  const droppedGuards = [];
  for (const g of guards) {
    const id = typeof g.id === "string" ? g.id.trim() : "";
    const slug = modules.map((a) => path.basename(a.path, CHECK_SUFFIX))
      .find((s) => s === g.classId || s === g.check);
    const row = slug ? bySlug.get(slug) : null;
    if (!id || !row || !HOOK_RUNNERS.includes(g.runner)) {
      droppedGuards.push({
        guardId: id || null,
        classId: g.classId || null,
        why: !id ? "the guard has no id"
          : !slug ? "no check module in this install answers for " + JSON.stringify(g.classId)
          : !row ? "the check it names was discarded"
          : "its runner " + JSON.stringify(g.runner) + " is not one this engine runs",
      });
      continue;
    }
    newGuards.push({
      id,
      check: row.check,
      classId: row.classId,
      runner: g.runner,
      mode: MODES.includes(g.mode) ? g.mode : "observe",
      provenance: jig.PROVENANCES.includes(g.provenance) ? g.provenance : "assumed",
      proof: row.proof,
    });
  }
  const configPayload = { schemaVersion: jig.SCHEMA_VERSION, guards: newGuards };
  if (Array.isArray(config.defaultBranches)) configPayload.defaultBranches = config.defaultBranches;
  if (isObject(config.zones)) configPayload.zones = config.zones;
  const configContent = JSON.stringify(configPayload, null, 2) + "\n";
  changes.push({
    id: changeId("config", configContent), kind: "write-config", path: CONFIG_PATH, content: configContent,
    classIds: newGuards.map((g) => g.classId), ownership: "schema",
    rationale: "guards keep their ids and their modes; the classes they name move to the editions",
  });

  // The manifest is rewritten here rather than left to `apply`, because apply
  // merges rows by change id and would leave the 1.0.1 row for each path
  // sitting beside the new one — two rows for one file, one of them reporting
  // drift forever.
  const artifacts = manifest.artifacts.map((a) => {
    const hit = written.get(a.path);
    return hit ? { ...a, id: hit.id, classIds: hit.classIds, hash: hit.hash, proof: hit.proof,
      template: hit.template, state: "active" } : a;
  });
  const manifestContent = JSON.stringify({ schemaVersion: jig.SCHEMA_VERSION, artifacts }, null, 2) + "\n";
  changes.push({
    id: changeId("manifest", manifestContent), kind: "write-side-file", path: MANIFEST_PATH,
    content: manifestContent, classIds: [], ownership: "file",
    rationale: "record what each migrated artifact now hashes to",
  });

  const { problems, payload } = jig.planFromDraft({ changes }, root);
  if (problems.length) throw expected("The migration was rejected:\n  - " + problems.join("\n  - "));
  fs.writeFileSync(statePath(root, "plan-" + payload.planId + ".json"),
    JSON.stringify(payload, null, 2) + "\n");
  const applied = jig.cmdApply(root, { _: [], change: [], plan: payload.planId });

  // Written whether or not anything was discarded: an absent file and a clean
  // run are the same silence otherwise.
  admission.writeDiscarded(statePath(root), discarded);

  const stats = require("../hooks/jig-lib.js").ledgerStats(root);
  return {
    ok: true,
    plan: payload.planId,
    tx: applied.tx,
    // Every surviving guard under the id it already had, with the history that
    // followed it. This is the migration's own proof that nothing was orphaned.
    guards: newGuards.map((g) => ({
      guardId: g.id,
      classId: g.classId,
      was: (guards.find((o) => o.id === g.id) || {}).classId || null,
      check: g.check,
      mode: g.mode,
      fired: (stats[g.id] || {}).fired || 0,
      wavedOff: (stats[g.id] || {}).falsePositives || 0,
    })),
    migrated,
    // Checks the pair threw out, the guards that went with them, and where the
    // rows live. Their ledger lines stay in the ledger — evidence is never
    // deleted — but nothing reads them any more, and that is said out loud
    // rather than left to be discovered.
    discarded,
    discardedFile: jig.STATE_DIR + "/discarded.json",
    droppedGuards,
    applied: applied.applied,
    notes: [
      "Nothing was armed by this migration. Each guard kept the mode its own row recorded.",
      "Undo the whole thing with `revert --tx " + applied.tx + "`.",
    ].concat(discarded.length
      ? ["The discarded checks stopped running and their files are now records of why." +
        " Author replacements with /jig:jig if those mistakes still matter."]
      : []),
  };
}

module.exports = {
  CLASS_MAP,
  LEGACY_EDITION,
  cmdMigrate,
  authoredFrom,
  fixturePair,
  moduleSource,
  tombstoneSource,
  scanCall,
};
