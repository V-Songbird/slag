"use strict";

// The per-language catalogue loader. jig 1.0.1 shipped one Node catalogue and
// required it at module load; the editions are six files of 100–200 KB each and
// the runner path opens at most one or two of them, so everything here is lazy
// and cached rather than eager.
//
// The editions are reference material, never a gate (SCOPE, "The stance that
// replaces it"): nothing in this module decides what may be installed. It
// answers three questions — which editions does this project look like, what
// does one of them say, and what is the stable name of a thing inside it.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// The index and the edition files version independently: the index describes
// the shelf, an edition describes a language, and a bump on one side must not
// force a rewrite of the other. v4 added `detect.manifest` to the editions —
// the project file an ecosystem cannot install anything without — and the index
// never carried it, so the index is still at 3.
const INDEX_SCHEMA = 3;
const EDITION_SCHEMA = 4;

const CATALOGUE_DIR = "catalogues";
const INDEX_FILE = "index.json";

// The engine's runner names, which are not the catalogue's lever names. The
// editions describe *what catches a mistake*; the engine needs to know *which
// installed artifact runs it*, and only these two levers exist in v3.
const RUNNER_BY_LEVER = { "check-driver": "checks", "tool-rule": "ci" };

const COMMENT_SYNTAXES = ["hash", "slash", "none"];

// Directories whose contents describe a dependency or a build output rather
// than this project. Counting them would let one vendored Go module make a
// TypeScript repository detect as Go.
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", ".jig", "node_modules", "vendor", "target", "dist", "build",
  "out", "bin", "obj", "__pycache__", ".venv", "venv", ".tox", ".gradle", ".mvn",
  ".idea", ".vscode", ".next", ".nuxt", "coverage", ".pytest_cache", ".mypy_cache",
  ".cargo", ".stack-work", "Pods", "site-packages",
]);

// A polyglot monorepo is normal (SCOPE, "What happens on a polyglot
// repository"), but detection is a heuristic over file names and must not turn
// into an unbounded walk of somebody's home directory. The caps are generous
// enough that the ranking is unchanged on any real repository.
const MAX_FILES = 20000;
const MAX_DEPTH = 12;

function expected(message) {
  const err = new Error(message);
  err.expected = true;
  return err;
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function requireRoot(root, what) {
  if (typeof root !== "string" || root === "") {
    throw expected("editions." + what + " needs an absolute path to the " +
      (what === "detectEditions" ? "project" : "plugin") + " root, and got " + JSON.stringify(root));
  }
  return root;
}

function readJson(file, what) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw expected(what + " is missing at " + file + " — the jig install is incomplete, reinstall the plugin");
    }
    throw expected(what + " could not be read at " + file + " (" + err.message + ")");
  }
  // The catalogues are authored by hand and by agents, so a BOM is a real
  // possibility and is not worth a parse failure a human has to diagnose.
  const text = buf.toString("utf8").replace(/^﻿/, "");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw expected(what + " at " + file + " is not readable JSON (" + err.message + ")");
  }
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

const indexCache = new Map();

function loadIndex(pluginRoot) {
  requireRoot(pluginRoot, "loadIndex");
  const file = path.join(pluginRoot, CATALOGUE_DIR, INDEX_FILE);
  const hit = indexCache.get(file);
  if (hit) return hit;

  const record = readJson(file, "the catalogue index");
  // An exact match, not `<=`. An older index is as unreadable as a newer one:
  // its rows would be missing fields this loader treats as required, and
  // guessing at them is how a loader ships coverage it cannot support.
  if (record.schemaVersion !== INDEX_SCHEMA) {
    throw expected("the catalogue index at " + file + " is schemaVersion " + record.schemaVersion +
      " and this loader reads " + INDEX_SCHEMA + ". Upgrade jig rather than reading a catalogue shelf it" +
      " does not know.");
  }
  if (!Array.isArray(record.editions) || record.editions.length === 0) {
    throw expected("the catalogue index at " + file + " lists no editions");
  }
  for (const e of record.editions) {
    if (!isObject(e) || typeof e.id !== "string" || typeof e.file !== "string" || !isObject(e.detect)) {
      throw expected("the catalogue index at " + file + " has an edition row missing id, file or detect: " +
        JSON.stringify(e));
    }
  }
  indexCache.set(file, record);
  return record;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

// The index's `detect.files` entries are either an exact basename (`go.mod`) or
// a leading-star extension glob (`*.csproj`). Nothing else is used, so nothing
// else is supported — a full glob engine here would be a second pattern
// dialect nobody asked for.
function fileMatches(pattern, base) {
  if (pattern.startsWith("*")) return base.length > pattern.length - 1 && base.endsWith(pattern.slice(1));
  return base === pattern;
}

function walk(projectRoot) {
  const files = [];
  const stack = [{ dir: projectRoot, rel: "", depth: 0 }];
  while (stack.length > 0 && files.length < MAX_FILES) {
    const here = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(here.dir, { withFileTypes: true });
    } catch (err) {
      // An unreadable subdirectory is a fact about the machine, not a reason to
      // refuse to detect anything at all. The project root itself is different
      // — that one is the caller's mistake and is raised below.
      if (here.depth === 0) {
        throw expected("the project root " + projectRoot + " could not be read (" + err.message + ")");
      }
      continue;
    }
    for (const entry of entries) {
      const rel = here.rel === "" ? entry.name : here.rel + "/" + entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || here.depth + 1 > MAX_DEPTH) continue;
        stack.push({ dir: path.join(here.dir, entry.name), rel, depth: here.depth + 1 });
      } else if (entry.isFile()) {
        files.push({ rel, base: entry.name, ext: path.extname(entry.name).toLowerCase() });
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  return files;
}

function detectEditions(projectRoot, index) {
  requireRoot(projectRoot, "detectEditions");
  if (!isObject(index) || !Array.isArray(index.editions)) {
    throw expected("editions.detectEditions needs the parsed catalogue index from loadIndex(), and got " +
      JSON.stringify(index));
  }
  const files = walk(projectRoot);

  const results = [];
  for (const edition of index.editions) {
    const patterns = Array.isArray(edition.detect.files) ? edition.detect.files : [];
    const extensions = Array.isArray(edition.detect.extensions) ? edition.detect.extensions : [];
    const wanted = new Set(extensions.map((e) => e.toLowerCase()));

    const matchedFiles = [];
    const matchedExtensions = {};
    for (const f of files) {
      if (patterns.some((p) => fileMatches(p, f.base))) matchedFiles.push(f.rel);
      if (wanted.has(f.ext)) matchedExtensions[f.ext] = (matchedExtensions[f.ext] || 0) + 1;
    }
    const extHits = Object.values(matchedExtensions).reduce((a, b) => a + b, 0);
    if (matchedFiles.length === 0 && extHits === 0) continue;

    // Marker files are the stronger signal by a wide margin — a `go.mod` says
    // this is a Go project, whereas one stray `.toml` says almost nothing — so
    // the score is lexicographic with extension hits only breaking ties among
    // editions holding the same number of markers.
    matchedFiles.sort();
    results.push({
      id: edition.id,
      score: matchedFiles.length * 1000 + Math.min(extHits, 999),
      matchedFiles,
      matchedExtensions,
    });
  }
  // Ties broken by id so two runs over the same tree rank identically; readdir
  // order is not a promise any platform makes.
  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return results;
}

// ---------------------------------------------------------------------------
// One edition
// ---------------------------------------------------------------------------

const editionCache = new Map();

function loadEdition(pluginRoot, id) {
  requireRoot(pluginRoot, "loadEdition");
  if (typeof id !== "string" || id === "") {
    throw expected("editions.loadEdition needs an edition id, and got " + JSON.stringify(id));
  }
  const key = path.join(pluginRoot, CATALOGUE_DIR) + "\u0000" + id;
  const hit = editionCache.get(key);
  if (hit) return hit;

  // The filename comes from the index rather than from `id + ".json"`, because
  // the index is what owns the mapping and a convention held in two places
  // drifts.
  const index = loadIndex(pluginRoot);
  const row = index.editions.find((e) => e.id === id);
  if (!row) {
    throw expected("no edition `" + id + "` in the catalogue index — the index lists " +
      index.editions.map((e) => e.id).join(", "));
  }
  const file = path.join(pluginRoot, CATALOGUE_DIR, row.file);
  const record = readJson(file, "the " + id + " edition");
  if (record.schemaVersion !== EDITION_SCHEMA) {
    throw expected("the " + id + " edition at " + file + " is schemaVersion " + record.schemaVersion +
      " and this loader reads " + EDITION_SCHEMA + ". Upgrade jig rather than reading an edition it does" +
      " not know.");
  }
  if (record.edition !== id) {
    throw expected("the edition file " + row.file + " calls itself `" + record.edition + "` but the index" +
      " lists it as `" + id + "` — the catalogue shelf and its files disagree");
  }
  if (!Array.isArray(record.classes)) {
    throw expected("the " + id + " edition at " + file + " has no classes array");
  }
  validateManifest(record, file);
  editionCache.set(key, record);
  return record;
}

// v4's one new field. An ecosystem's project file is the thing every install in
// it needs and no tool can create — `uv add` has nowhere to record a dependency
// without a `pyproject.toml`, and `npm install` with no `package.json` walks up
// the tree and lands in whatever project happens to be above this one. So the
// edition states the file, and states either the starter jig may write or the
// reason only the owner can create it.
//
// `path`, `sample` and `hint` are each either one string for the whole edition
// or a map keyed by package manager, exactly the way `install` already is on a
// toolchain row. One edition needs it: `jvm` covers Gradle and Maven, and a
// `settings.gradle.kts` is not a project file a Maven build can use. Every
// other edition names one manager's worth of the same thing and stays a string.
function forManager(value, manager) {
  if (typeof value === "string") return value !== "" ? value : null;
  if (!isObject(value)) return null;
  const held = value[manager];
  return typeof held === "string" && held !== "" ? held : null;
}

// The rest of the starter. A project file on its own is not a project: a
// `Cargo.toml` with no `src/lib.rs` is a manifest cargo refuses to parse, and a
// `pyproject.toml` with no package directory builds an empty wheel. SCOPE's
// starter row says a starter must build with no source files in it, so
// `starter.files` is the smallest tree that makes the ecosystem's own build and
// test commands exit 0 — one source file and one smoke test — keyed by package
// manager wherever `sample` is, for the same reason.
function starterFilesFor(value, manager) {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  return Array.isArray(value[manager]) ? value[manager] : [];
}

// Every starter file is a byte jig writes into somebody's repository, so the
// path is checked here rather than at the write: a catalogue that named
// `../../.bashrc` would be a supply chain, not a starter.
function validateStarter(record, file, manifest, manager, hasSample, where) {
  if (manifest.starter === undefined) return;
  if (!isObject(manifest.starter)) {
    throw expected("the " + record.edition + " edition at " + file + " declares a detect.manifest.starter" +
      " that is not an object");
  }
  const files = starterFilesFor(manifest.starter.files, manager);
  if (files.length && !hasSample) {
    throw expected("the " + record.edition + " edition offers starter files" + where +
      " for a project file it does not write, so nothing would ever lay them down");
  }
  for (const entry of files) {
    if (!isObject(entry) || typeof entry.path !== "string" || entry.path === "" || typeof entry.body !== "string") {
      throw expected("the " + record.edition + " edition's detect.manifest.starter.files" + where +
        " must each carry a `path` and a `body`, and one carries " + JSON.stringify(entry));
    }
    // A starter file may belong to one tool rather than to the edition — the
    // JavaScript smoke tests are two files because `node --test` and vitest
    // read different ones. It has to name a tool this edition actually offers,
    // or the file would be unreachable and nobody would ever find out.
    if (entry.tool !== undefined) {
      const offered = (Array.isArray(record.toolchain) ? record.toolchain : []).map((t) => isObject(t) && t.id);
      if (!offered.includes(entry.tool)) {
        throw expected("the " + record.edition + " edition's starter file `" + entry.path + "`" + where +
          " is written only for the tool " + JSON.stringify(entry.tool) + ", which this edition does not offer");
      }
    }
    const rel = entry.path;
    if (rel.startsWith("/") || rel.includes("\\") || /^[A-Za-z]:/.test(rel) || rel.split("/").includes("..")) {
      throw expected("the " + record.edition + " edition's starter file `" + rel + "`" + where +
        " is not a relative path inside the project");
    }
    // The same discipline every other file jig writes is under: a starter body
    // is generated content with a version an install records, so it carries the
    // version and the hash of the bytes that version shipped. A body edited
    // without restamping both is refused here — before a plan exists — exactly
    // as a template whose file no longer matches `templates.json` is.
    if (typeof entry.version !== "string" || entry.version === "" || typeof entry.sha256 !== "string") {
      throw expected("the " + record.edition + " edition's starter file `" + entry.path + "`" + where +
        " carries no `version` and `sha256`, so an install could not say which body it received");
    }
    const found = crypto.createHash("sha256").update(Buffer.from(entry.body, "utf8")).digest("hex");
    if (found !== entry.sha256) {
      throw expected("the " + record.edition + " edition's starter file `" + entry.path + "`" + where +
        " does not match the hash its catalogue recorded for it (recorded " + entry.sha256.slice(0, 12) +
        ", found " + found.slice(0, 12) + "). Bump the file's `version` and restamp its `sha256` rather" +
        " than shipping a body nothing gates.");
    }
  }
}

function validateManifest(record, file) {
  const manifest = record.detect && record.detect.manifest;
  if (!isObject(manifest)) {
    throw expected("the " + record.edition + " edition at " + file + " declares no detect.manifest," +
      " so nothing can say what this ecosystem's project file is. A v" + EDITION_SCHEMA + " edition carries one.");
  }
  // Every manager this edition claims, because a greenfield run resolves one
  // before it needs a project file and an unanswered manager is a run with
  // nothing to write and nothing to say.
  const managers = Array.isArray(record.detect.packageManagers) && record.detect.packageManagers.length
    ? record.detect.packageManagers
    : [null];
  for (const manager of managers) {
    const where = managers.length > 1 ? " under " + manager : "";
    const hasPath = forManager(manifest.path, manager) !== null;
    const hasSample = forManager(manifest.sample, manager) !== null;
    const hasHint = forManager(manifest.hint, manager) !== null;
    if (hasSample && !hasPath) {
      throw expected("the " + record.edition + " edition offers a manifest sample" + where + " with no path to write it to");
    }
    // Exactly one of the two has to be true, and the reason is the honest half:
    // an edition that can neither write the project file nor say who does would
    // leave a greenfield run stuck with no next step to take.
    if (hasSample === hasHint) {
      throw expected("the " + record.edition + " edition's detect.manifest" + where + " must carry either a `sample`" +
        " jig can write or a `hint` naming what the owner runs instead — it carries " +
        (hasSample ? "both" : "neither"));
    }
    validateStarter(record, file, manifest, manager, hasSample, where);
  }
}

// The manifest as the engine wants it, resolved for the package manager this
// run settled on. Never throws for a missing one, because `validateManifest`
// already refused that at load. A caller with no manager yet gets the edition's
// first, which is the one a single-manager edition has anyway.
function manifestFor(edition, manager) {
  if (!isObject(edition) || !isObject(edition.detect) || !isObject(edition.detect.manifest)) {
    throw expected("editions.manifestFor needs a loaded edition, and got " + JSON.stringify(edition));
  }
  const m = edition.detect.manifest;
  const managers = Array.isArray(edition.detect.packageManagers) ? edition.detect.packageManagers : [];
  const key = manager && managers.includes(manager) ? manager : managers[0] || null;
  return {
    edition: edition.edition,
    packageManager: key,
    path: forManager(m.path, key),
    sample: forManager(m.sample, key),
    hint: forManager(m.hint, key),
    starter: starterFilesFor(isObject(m.starter) ? m.starter.files : null, key),
  };
}

// Whether this project has been created yet, judged the same way detection
// judges anything: the edition's own marker files. None of them present means
// there is no project here for a package manager to install into.
function projectExists(projectRoot, edition, exists) {
  requireRoot(projectRoot, "projectExists");
  if (!isObject(edition) || !isObject(edition.detect) || !Array.isArray(edition.detect.files)) {
    throw expected("editions.projectExists needs a loaded edition with detect.files, and got " + JSON.stringify(edition));
  }
  const seen = typeof exists === "function" ? exists : (rel) => fs.existsSync(path.join(projectRoot, rel));
  for (const pattern of edition.detect.files) {
    if (pattern.includes("*")) {
      let entries;
      try {
        entries = fs.readdirSync(projectRoot, { withFileTypes: true });
      } catch {
        return false;
      }
      if (entries.some((e) => e.isFile() && fileMatches(pattern, e.name))) return true;
      continue;
    }
    if (seen(pattern)) return true;
  }
  return false;
}

function editionClass(edition, classId) {
  if (!isObject(edition) || !Array.isArray(edition.classes)) {
    throw expected("editions.editionClass needs a loaded edition, and got " + JSON.stringify(edition));
  }
  const cls = edition.classes.find((c) => c.id === classId);
  if (!cls) {
    throw expected("the " + edition.edition + " edition has no class `" + classId + "`. Its classes are " +
      edition.classes.map((c) => c.id).join(", "));
  }
  return cls;
}

// v3 detectors dropped the `id` and `runner` fields the v2 catalogue carried,
// because they are engine concerns and an edition is language research. They
// are synthesized here so exactly one place decides what a detector is called
// and what runs it.
function adaptDetector(cls, det, index) {
  if (!isObject(cls) || typeof cls.id !== "string") {
    throw expected("editions.adaptDetector needs the class the detector belongs to, and got " + JSON.stringify(cls));
  }
  if (!isObject(det) || typeof det.lever !== "string") {
    throw expected("editions.adaptDetector needs a detector with a lever, and got " + JSON.stringify(det));
  }
  const runner = RUNNER_BY_LEVER[det.lever];
  if (!runner) {
    throw expected(cls.id + " has a detector on lever `" + det.lever + "`, which this build does not run." +
      " The levers it runs are " + Object.keys(RUNNER_BY_LEVER).join(", ") + ".");
  }

  let id;
  if (det.lever === "tool-rule") {
    // A tool rule names itself. `ruff/PLR0124` is the same detector wherever it
    // sits in the list, so the id survives an edition rewrite that reorders or
    // inserts detectors — and the ledger keeps its history under it.
    const params = isObject(det.params) ? det.params : {};
    if (typeof params.tool !== "string" || typeof params.rule !== "string") {
      throw expected(cls.id + " has a tool-rule detector with no params.tool or params.rule, so it has no" +
        " stable identity. Fix the edition rather than installing a guard whose ledger cannot be trusted.");
    }
    id = det.lever + "-" + params.tool + "-" + params.rule;
  } else {
    // A check-driver detector is a bag of regexes with nothing self-naming in
    // it, so position is the only identity available. Reordering a class's
    // check-driver detectors renames them, which is why the editions treat
    // detector order as part of the contract.
    if (!Number.isInteger(index) || index < 0) {
      throw expected(cls.id + " has a " + det.lever + " detector whose identity is its position, and" +
        " adaptDetector was called with index " + JSON.stringify(index));
    }
    id = det.lever + "-" + index;
  }
  return { ...det, id, runner };
}

// Class ids are unique inside an edition and 26 of the 77 are shared across
// editions — `swallowed-exception` exists in all six. Anything that reaches a
// config, a manifest or a ledger row is namespaced, so a Python guard and a Go
// guard are never the same row.
function namespacedId(editionId, classId) {
  if (typeof editionId !== "string" || editionId === "") {
    throw expected("editions.namespacedId needs an edition id, and got " + JSON.stringify(editionId));
  }
  if (typeof classId !== "string" || classId === "") {
    throw expected("editions.namespacedId needs a class id, and got " + JSON.stringify(classId));
  }
  return editionId + "/" + classId;
}

// SCOPE, "Where does comment syntax live": the edition declares it per
// extension, because a filename table in the driver is the wrong home for
// language data — and the 1.0.1 table is exactly why `#` comments in .py, .rb
// and .ps1 files were read as live code.
function commentSyntaxFor(edition, ext) {
  if (!isObject(edition) || !isObject(edition.detect) || !isObject(edition.detect.commentSyntax)) {
    throw expected("the " + (isObject(edition) ? edition.edition : JSON.stringify(edition)) + " edition" +
      " declares no detect.commentSyntax map, so nothing can say how to blank its comments");
  }
  if (typeof ext !== "string" || ext === "") {
    throw expected("editions.commentSyntaxFor needs a file extension like `.py`, and got " + JSON.stringify(ext));
  }
  const key = (ext.startsWith(".") ? ext : "." + ext).toLowerCase();
  const found = edition.detect.commentSyntax[key];
  // An extension the edition never claimed is not an error: the driver walks
  // whatever the path globs matched, and a .md or .json file simply has no
  // comment syntax this edition speaks for. Blanking nothing is the safe answer.
  if (found === undefined) return "none";
  if (!COMMENT_SYNTAXES.includes(found)) {
    throw expected("the " + edition.edition + " edition declares comment syntax `" + found + "` for " + key +
      ", which is not one of " + COMMENT_SYNTAXES.join(", "));
  }
  return found;
}

// ---------------------------------------------------------------------------
// Quick start
// ---------------------------------------------------------------------------

// `--quick` used to be a phrase in a skill — "take the edition's leading
// classes" — and nothing computed it, so the selection was whatever the model
// decided in the moment. That makes the `assumed` provenance SCOPE keeps for
// quick start unfalsifiable: the owner cannot see what was assumed on their
// behalf. The answer is computed here and recorded on the profile, so the same
// repository selects the same classes twice and the basis is on disk either way.

// Deliberately small. Quick start's whole promise is one review and no
// questions, and forty item-tier changes is not something anybody reviews — it
// is something they approve by fatigue.
const QUICK_CAP = 8;

function fallbackReason(forensics) {
  if (!isObject(forensics)) return "it was never run";
  if (typeof forensics.fallback === "string" && forensics.fallback !== "") return forensics.fallback;
  return "nothing ranked";
}

function quickSelection(profile, forensics, pluginRoot) {
  if (!isObject(profile)) {
    throw expected("editions.quickSelection needs the scan profile, and got " + JSON.stringify(profile));
  }
  const root = typeof pluginRoot === "string" && pluginRoot !== "" ? pluginRoot : path.join(__dirname, "..");
  const editionIds = Array.isArray(profile.editions)
    ? profile.editions.filter((id) => typeof id === "string" && id !== "")
    : [];

  // The order the editions themselves argue for when history has nothing to
  // say: tier first — safety before hygiene — then the order the edition
  // authored its classes in. That is forensics' own fallback rule, restated
  // here rather than imported, because forensics requires this file.
  const catalogue = [];
  for (const id of editionIds) {
    loadEdition(root, id).classes.forEach((cls, i) => {
      catalogue.push({ classId: namespacedId(id, cls.id), edition: id, severity: cls.severity, order: i });
    });
  }
  catalogue.sort((a, b) =>
    Number(b.severity === "safety") - Number(a.severity === "safety") ||
    a.edition.localeCompare(b.edition) ||
    a.order - b.order);

  // Forensics that mined nothing ranks by nothing, and its rows say so in
  // their own `basis`. Taking that head would dress catalogue order up as
  // evidence, so an unusable run falls back explicitly instead.
  // Scoped to the editions the scan matched, the same set the result reports as
  // its basis. Forensics ranks over every edition it can read, so an unfiltered
  // head would install Python classes in a TypeScript repository and report the
  // TypeScript edition as the reason.
  const ranking = isObject(forensics) && forensics.usable === true && Array.isArray(forensics.ranking)
    ? forensics.ranking.filter((row) => isObject(row) && typeof row.classId === "string" &&
      editionIds.includes(row.edition))
    : [];
  const usable = ranking.length > 0;
  const head = (usable ? ranking : catalogue).slice(0, QUICK_CAP);

  return {
    cap: QUICK_CAP,
    basis: usable ? "forensics" : "catalogue",
    why: usable
      ? "the head of the forensics ranking over this repository's own history"
      : "no usable forensics (" + fallbackReason(forensics) + "), so classes by tier and then catalogue order",
    editions: editionIds,
    considered: usable ? ranking.length : catalogue.length,
    classes: head.map((row) => ({
      classId: row.classId,
      edition: typeof row.edition === "string" ? row.edition : null,
      severity: typeof row.severity === "string" ? row.severity : null,
      hits: usable && Number.isInteger(row.hits) ? row.hits : 0,
      basis: usable ? row.basis || "forensics" : "catalogue",
    })),
  };
}

module.exports = {
  QUICK_CAP,
  quickSelection,
  loadIndex,
  detectEditions,
  loadEdition,
  editionClass,
  adaptDetector,
  namespacedId,
  commentSyntaxFor,
  manifestFor,
  projectExists,
  // Detection's own bounded walk and its pattern matcher, exported because the
  // engine has to answer the same two questions an install poses: which files a
  // glob in `detect.files` names right now, and what the tree held before the
  // package manager ran.
  walkFiles: walk,
  // The walk's file cap, exported for the one caller that DIFFERS two walks. A
  // truncated list is cut wherever the count ran out, so two of them put
  // different files on either side of the cut and a path that was only ever
  // missing from the first would read as a path the install created.
  WALK_MAX_FILES: MAX_FILES,
  fileMatches,
};
