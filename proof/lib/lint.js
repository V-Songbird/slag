"use strict";

// Task linter (component 2, BLOCKING). A task set that fails the linter never
// reaches spend. Three walls, in order of severity:
//
//   ERROR (refuse to run):
//     - a task with no deterministic tier-1 assertion (nothing to grade cheaply)
//     - a marker-file assertion — the S03 lesson (gate2.md §1): a `SKILL_FIRED`
//       / `MARKER` sentinel is a leaky firing proxy a capable model refuses to
//       write while doing the real work, so it is rejected outright in favour of
//       an assertion on a real work product
//     - a set that is all one shape (same type AND same touched files) — a
//       tight CI over a monotype set launders a guess into a number (spec §5)
//   WARNING (runs, but the disclosure gets louder):
//     - thin diversity (one type across a few files, or a very small set)
//     - a weak / tautological assertion (the "vibe testing" failure, spec §5.2)
//
// The linter reads a task set: an array of task objects `{ id, type, surface,
// assert, ... }`. It never calls a model and never touches the network.

// Deterministic grader kinds (tier 1). `rubric` is tier 2 (a model call) and
// does NOT satisfy the assertion-present wall on its own.
const DETERMINISTIC = new Set([
  "file_exists", "file_absent", "file_regex", "file_regex_absent",
  "response_regex", "response_regex_absent", "composite",
]);

// A path whose only reason to exist is to prove the agent ran — the leaky proxy.
const MARKER_RE = /(^|[\/\\])[A-Z0-9_]*(FIRED|MARKER|SENTINEL|_FLAG|PROOF_?RAN|DID_?RUN)[A-Z0-9_]*(\.[a-z]+)?$/;

// Patterns so loose they assert nothing — grep-equivalents of `toBeDefined`.
const WEAK_PATTERN_RE = /^(\.[*+]|\.|\^|\$|\.\{0,\}|\\S|\\w[*+]?|[a-z]{1,2})$/i;

function collectGraders(assert) {
  const out = [];
  const walk = (g) => {
    if (!g || typeof g !== "object") return;
    out.push(g);
    if (g.type === "composite" && Array.isArray(g.children)) g.children.forEach(walk);
  };
  (assert || []).forEach(walk);
  return out;
}

function hasDeterministic(assert) {
  return collectGraders(assert).some((g) => DETERMINISTIC.has(g.type) && g.type !== "composite")
    || (assert || []).some((g) => g && g.type === "composite");
}

function markerAssertions(assert) {
  return collectGraders(assert).filter((g) => typeof g.path === "string" && MARKER_RE.test(g.path));
}

function weakAssertions(assert) {
  return collectGraders(assert).filter(
    (g) => (g.type === "file_regex" || g.type === "response_regex") && typeof g.pattern === "string" && WEAK_PATTERN_RE.test(g.pattern.trim())
  );
}

function taskFiles(task) {
  return collectGraders(task.assert).map((g) => g.path).filter(Boolean).sort();
}

// Lint a task set. Returns { ok, errors, warnings, summary }. `ok` is false iff
// there is at least one error — the caller MUST refuse to run in that case.
function lintTaskSet(tasks) {
  const errors = [];
  const warnings = [];
  const list = Array.isArray(tasks) ? tasks : [];

  if (list.length === 0) {
    return { ok: false, errors: ["task set is empty — nothing to measure"], warnings: [], summary: emptySummary() };
  }

  for (const t of list) {
    const id = t.id || "(unnamed)";
    if (!hasDeterministic(t.assert)) {
      errors.push(`task ${id}: no deterministic assertion — every task must carry a tier-1 check the runner can grade for free`);
    }
    const markers = markerAssertions(t.assert);
    for (const m of markers) {
      errors.push(`task ${id}: marker-file assertion on "${m.path}" is rejected — assert on a real work product, not a sentinel a capable model refuses to write (gate2 S03)`);
    }
    for (const w of weakAssertions(t.assert)) {
      warnings.push(`task ${id}: assertion pattern "${w.pattern}" is weak/tautological — it may pass on any output`);
    }
  }

  const types = uniq(list.map((t) => t.type || "unspecified"));
  const surfaces = uniq(list.map((t) => t.surface || "unspecified"));
  const fileSets = list.map(taskFiles);
  const allFiles = uniq(fileSets.flat());
  const sameFiles = fileSets.every((fs) => JSON.stringify(fs) === JSON.stringify(fileSets[0]));

  // All one shape: >1 task, single type, and every task touches the identical
  // file set. A tight CI over such a set says nothing general — refuse.
  if (list.length > 1 && types.length === 1 && sameFiles && allFiles.length <= 1) {
    errors.push(`set is all one shape: ${list.length} tasks, type "${types[0]}", ${allFiles.length} file — refusing to run; a verdict over a monotype set is not directional evidence`);
  } else if (types.length === 1 && list.length > 1) {
    warnings.push(`thin diversity: all ${list.length} tasks are type "${types[0]}" — the verdict is directional for THAT behavior only`);
  }
  if (list.length < 3) {
    warnings.push(`small set: ${list.length} task${list.length === 1 ? "" : "s"} — treat the verdict as indicative; harvest or add more to strengthen it`);
  }

  const summary = { n: list.length, types, surfaces, files: allFiles.length };
  return { ok: errors.length === 0, errors, warnings, summary };
}

function uniq(a) { return [...new Set(a)]; }
function emptySummary() { return { n: 0, types: [], surfaces: [], files: 0 }; }

module.exports = { lintTaskSet, DETERMINISTIC, MARKER_RE };
