"use strict";

// jig sections — the one place that composes several tools' configuration into
// a single file.
//
// Why this exists. An edition names the file each tool configures, and in five
// of the six editions several tools name the SAME file: five python tools
// configure `pyproject.toml`, four dotnet tools configure `.editorconfig`, two
// rust tools configure `Cargo.toml`. The engine used to write each tool's
// sample verbatim at that path, one change per tool, so the last one applied
// replaced every earlier one — silently, because each write succeeded. A
// scaffolded Python project ended up with pytest's settings and nothing else.
//
// The fix is not a TOML parser. These files are section files: a preamble, then
// blocks introduced by a `[header]` line, each block a list of `key = value`
// lines. Merging them at that granularity is enough to compose the shipped
// samples correctly, and it is small enough to read in one sitting — which
// matters, because the output is a file on somebody's disk.
//
// Three rules, and the third is the one that keeps this honest:
//
//   1. A block header appears once. Later blocks with the same header merge
//      into the first rather than repeating it.
//   2. A key appears once per block. The FIRST writer wins.
//   3. A key the first writer set to one value and a later writer set to
//      another is a CONFLICT. It is kept as the first value and reported. A
//      merge that silently picked a winner would be the same bug in a new
//      place.
//
// Anything this cannot merge is not merged. `mergeable()` is the whole list of
// formats, and a caller holding a `go.mod` or a `build.gradle.kts` is expected
// to report the snippet to the owner rather than compose one.

// Section files jig composes. Everything else — XML project files, Kotlin build
// scripts, `go.mod` — has a real grammar and would need a real parser, and a
// half-parser writing somebody's build file is worse than no feature.
const MERGEABLE = new Set([".toml", ".editorconfig", ".ini", ".cfg"]);

function expected(message) {
  const err = new Error(message);
  err.expected = true;
  return err;
}

// The basename is what decides, not the extension alone: `.editorconfig` has no
// extension at all, and `pyproject.toml` is decided by `.toml`.
function mergeable(configPath) {
  if (typeof configPath !== "string" || configPath === "") return false;
  const base = configPath.replace(/\\/g, "/").split("/").pop();
  if (MERGEABLE.has(base)) return true;
  const dot = base.lastIndexOf(".");
  return dot > 0 && MERGEABLE.has(base.slice(dot).toLowerCase());
}

// A header at depth zero only. `select = [` opens a value that runs over
// several lines and whose closing `]` would otherwise read as a header, so the
// depth counter is what separates a section from an array element.
function isHeader(line) {
  const t = line.trim();
  return t.startsWith("[") && t.endsWith("]");
}

function keyOf(line) {
  const m = line.match(/^\s*((?:"[^"]*"|'[^']*'|[A-Za-z0-9_.\-*]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.\-*]+))*)\s*=/);
  return m ? m[1].trim() : null;
}

// Brackets and braces opened by a value and not yet closed. Quoted text is
// skipped, so a `"]"` inside a string never closes an array — that is the one
// place a line-based reader would otherwise get a real file wrong.
function depthDelta(line) {
  let delta = 0;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#") break;
    if (ch === "[" || ch === "{") delta++;
    else if (ch === "]" || ch === "}") delta--;
  }
  return delta;
}

// One entry per logical line: a key and every continuation line its value runs
// over, kept together so a multi-line array moves as one unit.
function readEntries(text) {
  const lines = String(text || "").split(/\r?\n/);
  const preamble = [];
  const blocks = [];
  let current = null;
  let depth = 0;
  let pending = null;

  const sink = () => (current ? current.entries : preamble);

  for (const line of lines) {
    if (pending) {
      pending.lines.push(line);
      depth += depthDelta(line);
      if (depth <= 0) { depth = 0; pending = null; }
      continue;
    }
    if (depth === 0 && isHeader(line)) {
      current = { header: line.trim(), entries: [] };
      blocks.push(current);
      continue;
    }
    const entry = { key: keyOf(line), lines: [line] };
    sink().push(entry);
    const delta = depthDelta(line);
    if (entry.key !== null && delta > 0) { depth = delta; pending = entry; }
  }
  return { preamble, blocks };
}

function addEntries(target, incoming, where, source, conflicts) {
  for (const entry of incoming) {
    if (entry.key === null) {
      // Comments and blank lines. A repeat of something already here is noise
      // the reader did not ask for, so only new prose is carried over.
      const text = entry.lines.join("\n").trim();
      if (text === "") continue;
      if (target.some((e) => e.key === null && e.lines.join("\n").trim() === text)) continue;
      target.push(entry);
      continue;
    }
    const held = target.find((e) => e.key === entry.key);
    if (!held) { target.push({ ...entry, source }); continue; }
    if (held.lines.join("\n").trim() === entry.lines.join("\n").trim()) continue;
    conflicts.push({
      path: null,
      where,
      key: entry.key,
      kept: held.lines.join("\n").trim(),
      keptFrom: held.source || null,
      dropped: entry.lines.join("\n").trim(),
      droppedFrom: source,
    });
  }
}

function render(preamble, blocks) {
  const out = [];
  for (const entry of preamble) out.push(...entry.lines);
  for (const block of blocks) {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push(block.header);
    for (const entry of block.entries) out.push(...entry.lines);
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n") + "\n";
}

// `parts` is [{ source, body }] in the order they should win. Returns the one
// body to write and every key two sources disagreed about. The caller decides
// what a conflict means; this module never resolves one silently.
function merge(parts, configPath) {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw expected("sections.merge needs at least one body to compose, and got " + JSON.stringify(parts));
  }
  const preamble = [];
  const blocks = [];
  const conflicts = [];

  for (const part of parts) {
    if (!part || typeof part.body !== "string") {
      throw expected("sections.merge was handed a part with no body: " + JSON.stringify(part));
    }
    const read = readEntries(part.body);
    addEntries(preamble, read.preamble, "the file's own preamble", part.source, conflicts);
    for (const block of read.blocks) {
      let held = blocks.find((b) => b.header === block.header);
      if (!held) { held = { header: block.header, entries: [] }; blocks.push(held); }
      addEntries(held.entries, block.entries, block.header, part.source, conflicts);
    }
  }
  for (const c of conflicts) c.path = configPath || null;
  return { body: render(preamble, blocks), conflicts };
}

module.exports = { mergeable, merge, MERGEABLE };
