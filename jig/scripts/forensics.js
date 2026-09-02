#!/usr/bin/env node
"use strict";

// jig forensics — deterministic git mining, no model anywhere in the loop.
// Two jobs, and it is worth being precise about which is which because they
// are answerable to different standards:
//
//   incidents[] — reverts, fix-clusters, churn hotspots, deleted test files,
//                 assertion-reducing test diffs. These ANCHOR the interview:
//                 "this file has been fixed six times" is a question worth
//                 asking a human. They are never a claim about a class.
//   ranking[]   — the catalogue's own classes, re-ordered by how often this
//                 repository's history actually shows each one. This is what
//                 pre-ranks the class multi-select.
//
// THE INJECTION FIREWALL: nothing mined here ever becomes a
// matcher. Every content signal below is evaluated with a pattern the
// CATALOGUE ships, and a hit only ever raises that class's rank. Repository
// content is evidence, never configuration. The two signals the catalogue
// cannot express as a single-file pattern — a deleted test file and a diff
// that removes assertions — are structural, read from the shape of the diff
// rather than from any text the repository supplied.
//
// Honesty about history shapes: a young repository and a squash-merged one
// both destroy the per-commit signal this depends on. Rather than reporting
// confident nonsense from four commits, forensics falls back SILENTLY to the
// catalogue's own ordering and records why. Attribution is best-effort by
// construction — an author line and a Co-Authored-By trailer are the only
// evidence git offers about who was driving.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const editionsLib = require("./editions.js");
// One glob compiler, shared with the driver and the session guards. The local
// copy this replaced could not read brace alternation, which every edition uses.
const { globToRegExp } = require("../hooks/jig-lib.js");

const PLUGIN_ROOT = path.join(__dirname, "..");

// A class as the ranking wants it: namespaced by edition, detectors carrying
// the runner that would execute them. Namespacing matters — the ids that leave
// this file are the ids the interview and the engine select by.
function classesFrom(loaded) {
  const out = [];
  for (const edition of loaded) {
    for (const cls of edition.classes || []) {
      out.push({
        ...cls,
        id: editionsLib.namespacedId(edition.edition, cls.id),
        edition: edition.edition,
        detectors: (cls.detectors || []).map((det, i) => editionsLib.adaptDetector(cls, det, i)),
      });
    }
  }
  return out;
}

let everyClass = null;
function allClasses() {
  if (!everyClass) {
    const index = editionsLib.loadIndex(PLUGIN_ROOT);
    everyClass = classesFrom(index.editions.map((row) => editionsLib.loadEdition(PLUGIN_ROOT, row.id)));
  }
  return everyClass;
}

// The editions this project actually matches. The scan's own profile is the
// cheapest answer; without one, detect them the same way the scan does. Ranking
// a Python repository in Rust class ids is the failure this replaces, so falling
// back to every shipped edition is the last resort and not the first.
function projectClasses(root) {
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(root, ".jig", "profile.json"), "utf-8"));
    const ids = Array.isArray(profile.editions) ? profile.editions.filter((id) => typeof id === "string") : [];
    if (ids.length) return classesFrom(ids.map((id) => editionsLib.loadEdition(PLUGIN_ROOT, id)));
  } catch (err) {
    // No profile, or one this build cannot read. Detect instead.
  }
  try {
    const index = editionsLib.loadIndex(PLUGIN_ROOT);
    const detected = editionsLib.detectEditions(root, index);
    const ids = (Array.isArray(detected) ? detected : [])
      .map((row) => (typeof row === "string" ? row : row && row.id))
      .filter((id) => typeof id === "string" && id);
    if (ids.length) return classesFrom(ids.map((id) => editionsLib.loadEdition(PLUGIN_ROOT, id)));
  } catch (err) {
    // An unreadable tree. Rank over everything rather than nothing.
  }
  return allClasses();
}

const SCHEMA_VERSION = 1;

// Thresholds. Each one is the point below which the signal is noise rather
// than evidence — stated here as data so the tests can read them instead of
// hardcoding a second copy.
const THRESHOLDS = {
  minCommits: 20, // below this the history is too young to say anything
  logCommits: 500, // metadata pass depth
  diffCommits: 200, // content pass depth — the expensive one
  fixCluster: 3, // fixes landing on one file before it is a cluster
  churn: 8, // commits touching one file before it is a hotspot
  squashRatio: 0.6, // share of "(#123)"-suffixed subjects that reads as squash-merged
  clearedSignals: 2, // distinct signal kinds needed before incidents are shown
};

const MAX_BUFFER = 64 * 1024 * 1024;

// Said on every report that carries an actor split, because it is true of all
// of them: git offers an author line and a Co-Authored-By trailer and nothing
// else about who was driving.
const ATTRIBUTION = "best-effort — author line and Co-Authored-By trailers are the only evidence git carries";

const US = "\u001f";
const RS = "\u001e";

// Best-effort attribution. A Co-Authored-By trailer naming one of these wins
// over the author line, because the agent is the co-author on every host that
// writes a trailer at all and the human is whoever ran the session.
const AGENT_MARKS = [
  /\bclaude\b/i,
  /\bcodex\b/i,
  /\bcopilot\b/i,
  /\bcursor\b/i,
  /\baider\b/i,
  /\bdevin\b/i,
  /\bchatgpt\b/i,
  /\bgpt-[0-9]/i,
  /noreply@anthropic\.com/i,
  /noreply@openai\.com/i,
];

const FIX_SUBJECT = /\b(fix|fixes|fixed|hotfix|bugfix|bug|patch|repair|regression)\b/i;
const REVERT_SUBJECT = /^revert\s+["']/i;
const REVERT_BODY = /^this reverts commit\b/im;
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i;

// Owned by forensics, not by the catalogue, and deliberately so: the
// weakened-assertion class ships with a detector that says in its own params
// that no single-snapshot pattern exists for it, because the class IS a diff.
const ASSERTION_LINE = /\b(assert|expect|should|chai|sinon|t\.(is|deepEqual|truthy|throws))\b/;

// ---------------------------------------------------------------------------
// git — read-only, always
// ---------------------------------------------------------------------------

// Every invocation in this file is a `git log` or a `git rev-parse`. Nothing
// here writes to the repository, checks anything out, or touches the index,
// and a failure is a null rather than a throw: a repository that cannot be
// read is the fallback case, not an error the interview should die on.
function git(root, args) {
  const r = spawnSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

function isRepo(root) {
  return git(root, ["rev-parse", "--is-inside-work-tree"]) !== null;
}

function attribute(author, email, body) {
  const trailers = (body.match(/^co-authored-by:.*$/gim) || []).join("\n");
  if (trailers && AGENT_MARKS.some((re) => re.test(trailers))) return "agent";
  const who = author + " <" + email + ">";
  return AGENT_MARKS.some((re) => re.test(who)) ? "agent" : "human";
}

// ---------------------------------------------------------------------------
// Pass 1 — commit metadata and the files each commit touched
// ---------------------------------------------------------------------------

function readLog(root, limit) {
  const format = ["%H", "%an", "%ae", "%aI", "%P", "%s", "%b"].join(US);
  const out = git(root, [
    "log",
    "--max-count=" + limit,
    "--no-color",
    "--name-status",
    "--format=" + RS + format,
  ]);
  if (out === null) return null;

  const commits = [];
  for (const record of out.split(RS)) {
    if (!record.trim()) continue;
    const fields = record.split(US);
    if (fields.length < 7) continue;
    const [sha, author, email, date, parents, subject] = fields;

    // git prints the body, then the name-status block. Split them on the first
    // line that reads as a status line; a body line shaped like "M\tpath" would
    // misparse one commit and nothing else.
    const files = [];
    const bodyLines = [];
    let inFiles = false;
    for (const line of fields[6].split("\n")) {
      const m = /^([ACDMRTUX])\d*\t(.+)$/.exec(line);
      if (m) {
        inFiles = true;
        // A rename prints "old\tnew" — the new path is the one that lives on.
        const parts = m[2].split("\t");
        files.push({ status: m[1], path: parts[parts.length - 1].replace(/\\/g, "/") });
      } else if (!inFiles) {
        bodyLines.push(line);
      }
    }
    const body = bodyLines.join("\n");

    commits.push({
      sha,
      author,
      email,
      date,
      parents: parents.trim() ? parents.trim().split(/\s+/) : [],
      subject,
      body,
      files,
      actor: attribute(author, email, body),
    });
  }
  return commits;
}

// ---------------------------------------------------------------------------
// Pass 2 — added and removed lines, per file, per commit
// ---------------------------------------------------------------------------


// The content signals ARE the catalogue's own file-content detectors — the
// ones a check driver would run. Deriving them here rather than restating them
// keeps forensics and the guards it recommends looking for the same thing, and
// makes it structurally impossible for this file to introduce a pattern of its
// own.
function contentDetectors(classes) {
  const out = [];
  for (const cls of classes || allClasses()) {
    for (const det of cls.detectors || []) {
      const p = det.params || {};
      if (det.runner !== "checks" || !Array.isArray(p.patterns) || !Array.isArray(p.paths)) continue;
      out.push({
        classId: cls.id,
        confidence: det.confidence,
        patterns: p.patterns.map((src) => new RegExp(src)),
        paths: p.paths.map(globToRegExp),
      });
    }
  }
  return out;
}

// Bound the expensive pass to the extensions the catalogue actually looks at.
// `**/*.{ts,tsx}` carries two extensions and no plain suffix, so a naive match
// on the tail of the glob sees neither. Expand the alternation first.
function extensionsOf(glob) {
  const brace = /\{([^}]*)\}/.exec(glob);
  if (brace) {
    return brace[1].split(",").flatMap((alt) => extensionsOf(glob.replace(brace[0], alt.trim())));
  }
  const m = /\.([a-z0-9]+)$/i.exec(glob);
  return m ? [m[1].toLowerCase()] : [];
}

function diffPathspec(classes) {
  const exts = new Set();
  for (const cls of classes || allClasses()) {
    for (const det of cls.detectors || []) {
      for (const glob of (det.params && det.params.paths) || []) {
        for (const ext of extensionsOf(glob)) exts.add(ext);
      }
    }
  }
  return [...exts].sort().map((e) => "*." + e);
}

function readDiffs(root, limit, pathspec) {
  const out = git(root, [
    "log",
    "--max-count=" + limit,
    "--no-color",
    "--no-renames",
    "--unified=0",
    "-p",
    "--format=" + RS + "%H",
    "--",
    ...pathspec,
  ]);
  if (out === null) return null;

  const records = [];
  for (const record of out.split(RS)) {
    if (!record.trim()) continue;
    const lines = record.split("\n");
    const sha = lines[0].trim();
    const files = new Map();
    let current = null;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("+++ ")) {
        const target = line.slice(4).trim();
        current = target === "/dev/null" ? null : target.replace(/^b\//, "").replace(/\\/g, "/");
        if (current && !files.has(current)) files.set(current, { added: [], removed: [] });
        continue;
      }
      if (line.startsWith("--- ") || line.startsWith("diff --git ") || line.startsWith("@@")) continue;
      if (!current) continue;
      if (line.startsWith("+")) files.get(current).added.push(line.slice(1));
      else if (line.startsWith("-")) files.get(current).removed.push(line.slice(1));
    }
    records.push({ sha, files });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

function tallyActors(list) {
  return {
    human: list.filter((a) => a === "human").length,
    agent: list.filter((a) => a === "agent").length,
  };
}

function reverts(commits) {
  return commits
    .filter((c) => REVERT_SUBJECT.test(c.subject) || REVERT_BODY.test(c.body))
    .map((c) => ({ kind: "revert", sha: c.sha, subject: c.subject, date: c.date, actor: c.actor }));
}

function fixClusters(commits, min) {
  const byFile = new Map();
  for (const c of commits) {
    if (!FIX_SUBJECT.test(c.subject)) continue;
    for (const f of c.files) {
      if (f.status === "D") continue;
      if (!byFile.has(f.path)) byFile.set(f.path, []);
      byFile.get(f.path).push(c);
    }
  }
  return [...byFile.entries()]
    .filter(([, cs]) => cs.length >= min)
    .map(([file, cs]) => ({
      kind: "fix-cluster",
      path: file,
      count: cs.length,
      commits: cs.map((c) => c.sha),
      actors: tallyActors(cs.map((c) => c.actor)),
    }))
    .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1));
}

function churn(commits, min) {
  const byFile = new Map();
  for (const c of commits) {
    for (const f of c.files) {
      if (!byFile.has(f.path)) byFile.set(f.path, []);
      byFile.get(f.path).push(c.actor);
    }
  }
  return [...byFile.entries()]
    .filter(([, actors]) => actors.length >= min)
    .map(([file, actors]) => ({ kind: "churn", path: file, count: actors.length, actors: tallyActors(actors) }))
    .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1));
}

function deletedTests(commits) {
  const out = [];
  for (const c of commits) {
    for (const f of c.files) {
      if (f.status === "D" && TEST_PATH_RE.test(f.path)) {
        out.push({ kind: "test-file-deleted", path: f.path, sha: c.sha, date: c.date, actor: c.actor });
      }
    }
  }
  return out;
}

// A test diff that takes out more assertions than it puts back. The catalogue
// says in the class's own detector note that this shape is only visible in a
// diff, which is why it lives here and not in a check driver.
function weakenedAssertions(diffs, byShaActor) {
  const out = [];
  for (const rec of diffs) {
    for (const [file, d] of rec.files) {
      if (!TEST_PATH_RE.test(file)) continue;
      const removed = d.removed.filter((l) => ASSERTION_LINE.test(l)).length;
      const added = d.added.filter((l) => ASSERTION_LINE.test(l)).length;
      if (removed > added) {
        out.push({
          kind: "assertion-reduced",
          path: file,
          sha: rec.sha,
          removed,
          added,
          actor: byShaActor.get(rec.sha) || "human",
        });
      }
    }
  }
  return out;
}

// One hit per (class, commit, file). A refactor that renames a helper across
// forty files is one piece of evidence about the class, not forty.
function contentHits(diffs, detectors, byShaActor) {
  const hits = new Map();
  for (const rec of diffs) {
    for (const [file, d] of rec.files) {
      for (const det of detectors) {
        if (!det.paths.some((re) => re.test(file))) continue;
        if (!d.added.some((line) => det.patterns.some((re) => re.test(line)))) continue;
        if (!hits.has(det.classId)) hits.set(det.classId, []);
        hits.get(det.classId).push({ sha: rec.sha, path: file, actor: byShaActor.get(rec.sha) || "human" });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

// The order the editions themselves argue for when history has nothing to say:
// safety before hygiene, then as authored. Nothing here asks whether a class is
// installable — every class is, and the fixture pair is what admits it.
function catalogueOrder(classes) {
  return (classes || allClasses())
    .map((cls, i) => ({ cls, i }))
    .sort((a, b) => {
      const sev = Number(b.cls.severity === "safety") - Number(a.cls.severity === "safety");
      if (sev) return sev;
      return a.i - b.i;
    })
    .map(({ cls }) => cls);
}

function rank(hitsByClass, classes) {
  const base = catalogueOrder(classes);
  const rows = base.map((cls, i) => {
    const hits = hitsByClass.get(cls.id) || [];
    return {
      classId: cls.id,
      title: cls.title,
      edition: cls.edition,
      severity: cls.severity,
      hits: hits.length,
      actors: tallyActors(hits.map((h) => h.actor)),
      examples: hits.slice(0, 3).map((h) => ({ sha: h.sha, path: h.path })),
      basis: hits.length ? "forensics" : "catalogue",
      order: i,
    };
  });
  rows.sort((a, b) => b.hits - a.hits || a.order - b.order);
  return rows.map(({ order, ...row }) => row);
}

// ---------------------------------------------------------------------------
// Since the install
// ---------------------------------------------------------------------------

// What the repository has done since jig was installed, read from git rather
// than from the ledger. The ledger only ever saw the agent sessions jig's own
// hooks ran inside; a commit from a teammate, from CI or from a plain terminal
// never touched it, so an owner coming back a month later gets day-one facts.
// `before` and `after` split the same content hits on the install date, which
// is the one number that answers "is this class still happening".
function sinceInstallReport(since, commits, byShaDate, hitsByClass, contentDepth) {
  const at = Date.parse(since);
  if (!Number.isFinite(at)) return null;
  const after = commits.filter((c) => Date.parse(c.date) >= at);
  const byClass = {};
  for (const [classId, hits] of hitsByClass) {
    const seen = hits.filter((h) => Date.parse(byShaDate.get(h.sha)) >= at).length;
    byClass[classId] = { before: hits.length - seen, after: seen };
  }
  // `truncated` answers for the window `byClass` was built from, which is the
  // CONTENT pass and not the deeper log pass above it. Read against the log,
  // it said `false` for a repository whose install predates its 200th-newest
  // commit while every class read `before: 0` — the same report saying the
  // history reaches back and that nothing existed before the install. Depth 0
  // is the fallback paths, where no diff was read at all and an empty
  // `byClass` means "not mined" rather than "no longer happening".
  const read = contentDepth > 0 ? commits.slice(0, contentDepth) : [];
  const oldest = read.length ? Date.parse(read[read.length - 1].date) : null;
  return {
    since,
    commits: after.length,
    actors: tallyActors(after.map((c) => c.actor)),
    truncated: oldest === null || oldest > at,
    byClass,
    attribution: ATTRIBUTION,
  };
}

// ---------------------------------------------------------------------------
// The public call
// ---------------------------------------------------------------------------

function runForensics(root, opts) {
  const options = opts || {};
  const th = { ...THRESHOLDS, ...(options.thresholds || {}) };
  // The editions this repository matched at scan time. Every id that leaves
  // this function is namespaced, so it joins with the engine's own selection.
  const classes = projectClasses(root);
  const empty = {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    usable: false,
    fallback: null,
    repo: null,
    cleared: [],
    incidents: [],
    ranking: rank(new Map(), classes),
    attribution: ATTRIBUTION,
    sinceInstall: null,
    notes: [],
  };

  if (!isRepo(root)) return { ...empty, fallback: "not-a-repository" };

  const commits = readLog(root, th.logCommits);
  if (commits === null || commits.length === 0) return { ...empty, fallback: "no-history" };

  // The since-install view survives every fallback below it. A squash-merged or
  // young history destroys the per-commit SIGNAL, but "142 commits landed here
  // since jig was installed" is still a fact, and it is the whole point of a
  // report somebody opens a month later.
  const byShaDate = new Map(commits.map((c) => [c.sha, c.date]));
  const since = (hits, contentDepth) =>
    (typeof options.since === "string"
      ? sinceInstallReport(options.since, commits, byShaDate, hits, contentDepth || 0) : null);

  const merges = commits.filter((c) => c.parents.length > 1).length;
  const squashSubjects = commits.filter((c) => /\(#\d+\)\s*$/.test(c.subject)).length;
  const squashed = merges === 0 && squashSubjects / commits.length >= th.squashRatio;
  const repo = {
    commits: commits.length,
    truncated: commits.length >= th.logCommits,
    merges,
    squashed,
    oldest: commits[commits.length - 1].date,
    newest: commits[0].date,
    actors: tallyActors(commits.map((c) => c.actor)),
  };

  // A young or squash-merged history destroys the per-commit signal every one
  // of these thresholds is calibrated against — a squash collapses the fix
  // cluster into the feature that caused it. Say nothing rather than guess.
  if (commits.length < th.minCommits) {
    return { ...empty, repo, fallback: "young-history", sinceInstall: since(new Map()) };
  }
  if (squashed) return { ...empty, repo, fallback: "squash-merged", sinceInstall: since(new Map()) };

  const byShaActor = new Map(commits.map((c) => [c.sha, c.actor]));
  const detectors = contentDetectors(classes);
  const notes = [];
  // How deep the content pass actually went. `sinceInstall.truncated` answers
  // for this window, not the log one above it, so it has to travel with the
  // hits it describes.
  const diffDepth = Math.min(th.diffCommits, commits.length);
  const diffs = readDiffs(root, diffDepth, diffPathspec(classes));
  if (diffs === null) {
    notes.push("the diff pass could not be read, so content signals are missing from this ranking");
  }

  const found = {
    revert: reverts(commits),
    "fix-cluster": fixClusters(commits, th.fixCluster),
    churn: churn(commits, th.churn),
    "test-file-deleted": deletedTests(commits),
    "assertion-reduced": diffs ? weakenedAssertions(diffs, byShaActor) : [],
  };
  const hitsByClass = diffs ? contentHits(diffs, detectors, byShaActor) : new Map();
  // These two signals are diffs, so no single-snapshot pattern can find them and
  // no edition ships one. They rank by the class's own unqualified name in
  // whichever editions this project loaded — an edition that carries no such
  // class simply gets no row, and the signal still counts as cleared.
  const named = (name) => classes.filter((cls) => cls.id.endsWith("/" + name));
  for (const cls of named("deleted-test")) {
    for (const del of found["test-file-deleted"]) {
      if (!hitsByClass.has(cls.id)) hitsByClass.set(cls.id, []);
      hitsByClass.get(cls.id).push({ sha: del.sha, path: del.path, actor: del.actor });
    }
  }
  if (found["assertion-reduced"].length) {
    for (const cls of named("softened-assertion")) {
      hitsByClass.set(cls.id, found["assertion-reduced"].map((a) => ({ sha: a.sha, path: a.path, actor: a.actor })));
    }
  }

  // Each class the history actually shows counts as its own signal. Two
  // different anti-patterns turning up really is two pieces of evidence, and
  // collapsing them into one "content" signal would silence a repository whose
  // whole story is written in its diffs.
  const cleared = Object.keys(found).filter((k) => found[k].length > 0);
  for (const classId of [...hitsByClass.keys()].sort()) cleared.push("content:" + classId);

  // "Incidents shown only when ≥2 signals clear thresholds" — one lonely
  // signal is a coincidence, and showing it invites the interview to build a
  // story on it.
  if (cleared.length < th.clearedSignals) {
    return { ...empty, repo, cleared, fallback: "below-threshold", sinceInstall: since(hitsByClass, diffs ? diffDepth : 0), notes };
  }

  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    usable: true,
    fallback: null,
    repo,
    cleared,
    incidents: [
      ...found.revert,
      ...found["fix-cluster"],
      ...found.churn,
      ...found["test-file-deleted"],
      ...found["assertion-reduced"],
    ],
    ranking: rank(hitsByClass, classes),
    attribution: ATTRIBUTION,
    sinceInstall: since(hitsByClass, diffs ? diffDepth : 0),
    notes,
  };
}

function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) opts[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  const root = typeof opts.root === "string" ? path.resolve(opts.root) : process.cwd();
  const thresholds = {};
  if (opts.commits) thresholds.diffCommits = Number(opts.commits);
  const options = { thresholds };
  if (typeof opts.since === "string") options.since = opts.since;
  process.stdout.write(JSON.stringify(runForensics(root, options), null, 2) + "\n");
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  SCHEMA_VERSION,
  THRESHOLDS,
  AGENT_MARKS,
  TEST_PATH_RE,
  git,
  isRepo,
  attribute,
  readLog,
  readDiffs,
  globToRegExp,
  contentDetectors,
  diffPathspec,
  reverts,
  fixClusters,
  churn,
  deletedTests,
  weakenedAssertions,
  contentHits,
  sinceInstallReport,
  catalogueOrder,
  rank,
  runForensics,
  main,
};
