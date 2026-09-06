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
// Four families of file follow those rules, not one. A section file is the
// original. An MSBuild property file (`Directory.Build.props`) is the same
// shape wearing angle brackets: a `<PropertyGroup>` is a block and each child
// element is a key. A Gradle build script (`build.gradle.kts`) is the same
// shape again: `plugins { … }` is a block and each statement inside it is an
// entry, with assignments keyed and everything else deduplicated by its text.
// A JSON manifest (`package.json`) is the shape stated outright: a top-level
// object member is a block and its own members are keys, which is what lets a
// starter and three tools' `scripts` land in one file.
// Each family gets a reader and a renderer; `merge` itself is one function and
// rule 3 is enforced in one place for all four.
//
// Composition never touches a file the project already owns — the caller hands
// those back as snippets before it gets here — so every body merged below is
// one jig shipped, and release gate G5 composes every shipped combination.
//
// Anything this cannot merge is not merged. `mergeable()` is the whole list of
// formats, and a caller holding a `go.mod` is expected to report the snippet to
// the owner rather than compose one.

function expected(message) {
  const err = new Error(message);
  err.expected = true;
  return err;
}

// ---------------------------------------------------------------------------
// Shared machinery

// Brackets and braces opened by a value and not yet closed. Quoted text is
// skipped, so a `"]"` inside a string never closes an array — that is the one
// place a line-based reader would otherwise get a real file wrong.
function depthDelta(line, comment) {
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
    if (comment === "//" ? ch === "/" && line[i + 1] === "/" : ch === "#") break;
    if (ch === "[" || ch === "{") delta++;
    else if (ch === "]" || ch === "}") delta--;
  }
  return delta;
}

function keyOf(line) {
  const m = line.match(/^\s*((?:"[^"]*"|'[^']*'|[A-Za-z0-9_.\-*]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.\-*]+))*)\s*=/);
  return m ? m[1].trim() : null;
}

function indentOf(line) {
  return line.match(/^\s*/)[0];
}

// Find-or-create, so two blocks with one header inside a single body land in
// one block exactly as they do across two bodies.
function blockIn(blocks, block) {
  const held = blocks.find((b) => b.header === block.header);
  if (held) return held;
  blocks.push(block);
  return block;
}

function addEntries(target, incoming, where, source, conflicts) {
  for (const entry of incoming) {
    if (entry.key === null) {
      // Comments, blank lines, and statements with no name to key them by. A
      // repeat of something already here is noise the reader did not ask for,
      // so only new text is carried over.
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

// ---------------------------------------------------------------------------
// Section files — `pyproject.toml`, `.editorconfig`, `.ini`, `.cfg`

// A header at depth zero only. `select = [` opens a value that runs over
// several lines and whose closing `]` would otherwise read as a header, so the
// depth counter is what separates a section from an array element.
function isHeader(line) {
  const t = line.trim();
  return t.startsWith("[") && t.endsWith("]");
}

// One entry per logical line: a key and every continuation line its value runs
// over, kept together so a multi-line array moves as one unit.
function readSections(text) {
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
      depth += depthDelta(line, "#");
      if (depth <= 0) { depth = 0; pending = null; }
      continue;
    }
    if (depth === 0 && isHeader(line)) {
      current = blockIn(blocks, { header: line.trim(), entries: [] });
      continue;
    }
    const entry = { key: keyOf(line), lines: [line] };
    sink().push(entry);
    const delta = depthDelta(line, "#");
    if (entry.key !== null && delta > 0) { depth = delta; pending = entry; }
  }
  return { preamble, blocks };
}

function renderSections(preamble, blocks) {
  const out = [];
  for (const entry of preamble) out.push(...entry.lines);
  for (const block of blocks) {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push(block.header);
    for (const entry of block.entries) out.push(...entry.lines);
  }
  return out;
}

// ---------------------------------------------------------------------------
// MSBuild property files — `Directory.Build.props`, `.targets`

const XML_OPEN = /^<([A-Za-z_][\w.\-]*)(\s[^>]*?)?>$/;
const XML_ELEMENT = /^<([A-Za-z_][\w.\-]*)[\s>/]/;

// `<Project>` wraps everything, a `<PropertyGroup>` is a block, and a child of
// one is a key: `<Nullable>` set twice is exactly the dispute rule 3 exists
// for. In any other group — an `<ItemGroup>` of package references — an entry
// is keyed by its whole text, so two different items both survive and two
// identical ones collapse.
function readMsbuild(text) {
  const lines = String(text || "").split(/\r?\n/);
  const preamble = [];
  const blocks = [];
  let root = null;
  let current = null;
  let pending = null;

  for (const line of lines) {
    const t = line.trim();
    if (pending) {
      pending.lines.push(line);
      if (t === "</" + pending.tag + ">" || t.endsWith("</" + pending.tag + ">")) pending = null;
      continue;
    }
    if (t === "") continue;
    if (!root) {
      if (/^<Project(\s|>)/.test(t)) { root = line; continue; }
      preamble.push({ key: null, lines: [line] });
      continue;
    }
    if (current) {
      if (t === "</" + current.tag + ">") { current = null; continue; }
      const tag = (t.match(XML_ELEMENT) || [])[1] || null;
      const entry = {
        key: current.tag === "PropertyGroup" && tag ? tag : t,
        tag,
        lines: [line],
      };
      current.entries.push(entry);
      if (tag && !t.endsWith("/>") && !t.endsWith("</" + tag + ">")) pending = entry;
      continue;
    }
    if (t === "</Project>") continue;
    const open = t.match(XML_OPEN);
    if (open && !t.endsWith("/>")) {
      current = blockIn(blocks, { header: t, tag: open[1], open: line, entries: [] });
      continue;
    }
    preamble.push({ key: null, lines: [line] });
  }
  return { preamble, blocks, root };
}

function renderMsbuild(preamble, blocks, root) {
  const out = [];
  for (const entry of preamble) out.push(...entry.lines);
  out.push(root || "<Project>");
  for (const block of blocks) {
    out.push(block.open);
    for (const entry of block.entries) out.push(...entry.lines);
    out.push(indentOf(block.open) + "</" + block.tag + ">");
  }
  out.push("</Project>");
  return out;
}

// ---------------------------------------------------------------------------
// Gradle build scripts — `build.gradle.kts`, `build.gradle`

const KOTLIN_INDENT = "    ";

// The reason this one is worth having rather than reporting: Gradle allows a
// script exactly ONE `plugins { }` block, and it must come first. Handing the
// owner two snippets to paste hands them a build file that cannot compile, so
// "jig writes none of it" is not the safe answer here — it is the wrong one.
//
// A block is a top-level `header {` … `}`. Inside it, an assignment is keyed
// and everything else — a plugin id, a dependency, a nested `options.x { }` —
// is an entry deduplicated by its text, which is what collapses the `java`
// plugin both samples ask for into one line.
function readKotlin(text) {
  const lines = String(text || "").split(/\r?\n/);
  const preamble = [];
  const blocks = [];
  let current = null;
  let depth = 0;
  let pending = null;

  for (const line of lines) {
    const t = line.trim();
    const delta = depthDelta(line, "//");
    if (current === null) {
      if (t === "") continue;
      if (t.endsWith("{") && delta === 1) {
        current = blockIn(blocks, { header: t.slice(0, -1).trim(), entries: [] });
        depth = 1;
        continue;
      }
      // A block written on one line: `repositories { mavenCentral() }`.
      const one = delta === 0 ? t.match(/^([^{}]+)\{(.+)\}$/) : null;
      if (one && one[2].trim() !== "") {
        const block = blockIn(blocks, { header: one[1].trim(), entries: [] });
        block.entries.push({ key: null, lines: [KOTLIN_INDENT + one[2].trim()] });
        continue;
      }
      preamble.push({ key: keyOf(line), lines: [line] });
      continue;
    }
    if (pending) {
      pending.lines.push(line);
      depth += delta;
      if (depth <= 1) { depth = 1; pending = null; }
      continue;
    }
    if (depth === 1 && t === "}") { current = null; depth = 0; continue; }
    const entry = { key: keyOf(line), lines: [line] };
    current.entries.push(entry);
    if (delta > 0) { depth += delta; pending = entry; }
  }
  return { preamble, blocks };
}

function renderKotlin(preamble, blocks) {
  const out = [];
  for (const entry of preamble) out.push(...entry.lines);
  for (const block of blocks) {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push(block.header + " {");
    for (const entry of block.entries) out.push(...entry.lines);
    out.push("}");
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON manifests — `package.json`

// The one family with a real grammar, and it composes because the grammar has
// a parser in the standard library: nothing here guesses at a shape the way a
// line reader has to. A top-level object member is a block and its own members
// are the keys, so `scripts` merges exactly as `[tool.ruff]` does — which is
// what puts the starter's `name` and each tool's `lint`, `typecheck` and `test`
// in one `package.json` instead of the last writer's alone.
//
// A value is carried as its own JSON text, so rule 3 compares two values the
// same way it compares two `key = value` lines, and a nested object moves whole.
function readJson(text) {
  let value;
  try {
    value = JSON.parse(String(text || ""));
  } catch (err) {
    throw expected("sections cannot compose a body that is not JSON (" + err.message + ")");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw expected("sections composes a JSON object, and this body is " + JSON.stringify(value));
  }
  const preamble = [];
  const blocks = [];
  for (const [key, member] of Object.entries(value)) {
    if (member !== null && typeof member === "object" && !Array.isArray(member)) {
      const block = blockIn(blocks, { header: key, entries: [] });
      for (const [k, v] of Object.entries(member)) block.entries.push({ key: k, lines: [JSON.stringify(v)] });
      continue;
    }
    preamble.push({ key, lines: [JSON.stringify(member)] });
  }
  return { preamble, blocks };
}

function renderJson(preamble, blocks) {
  const out = {};
  for (const entry of preamble) out[entry.key] = JSON.parse(entry.lines[0]);
  for (const block of blocks) {
    const member = {};
    for (const entry of block.entries) member[entry.key] = JSON.parse(entry.lines[0]);
    out[block.header] = member;
  }
  return JSON.stringify(out, null, 2).split("\n");
}

// ---------------------------------------------------------------------------
// Which reader a path gets

const MERGEABLE = new Set([".toml", ".editorconfig", ".ini", ".cfg"]);

function isSectionFile(base) {
  if (MERGEABLE.has(base)) return true;
  const dot = base.lastIndexOf(".");
  return dot > 0 && MERGEABLE.has(base.slice(dot).toLowerCase());
}

// A grammar with no fixed shape and no parser to lean on — `go.mod` — is absent
// on purpose. A half-parser writing somebody's build file is worse than no
// feature; the four below earn their place by being declarative or parseable,
// and by every body they see being one jig itself shipped.
const FORMATS = [
  { claims: isSectionFile, read: readSections, render: renderSections },
  { claims: (base) => /\.(props|targets)$/i.test(base), read: readMsbuild, render: renderMsbuild },
  { claims: (base) => /\.gradle(\.kts)?$/i.test(base), read: readKotlin, render: renderKotlin },
  { claims: (base) => /\.json$/i.test(base), read: readJson, render: renderJson },
];

// The basename is what decides, not the extension alone: `.editorconfig` has no
// extension at all, `pyproject.toml` is decided by `.toml`, and
// `build.gradle.kts` by an extension two dots deep.
function formatFor(configPath) {
  if (typeof configPath !== "string" || configPath === "") return null;
  const base = configPath.replace(/\\/g, "/").split("/").pop();
  return FORMATS.find((f) => f.claims(base)) || null;
}

function mergeable(configPath) {
  return formatFor(configPath) !== null;
}

// ---------------------------------------------------------------------------
// The merge

// `parts` is [{ source, body }] in the order they should win. Returns the one
// body to write and every key two sources disagreed about. The caller decides
// what a conflict means; this module never resolves one silently.
function merge(parts, configPath) {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw expected("sections.merge needs at least one body to compose, and got " + JSON.stringify(parts));
  }
  const format = formatFor(configPath) || FORMATS[0];
  const preamble = [];
  const blocks = [];
  const conflicts = [];
  let root = null;

  for (const part of parts) {
    if (!part || typeof part.body !== "string") {
      throw expected("sections.merge was handed a part with no body: " + JSON.stringify(part));
    }
    const read = format.read(part.body);
    if (read.root && !root) root = read.root;
    addEntries(preamble, read.preamble, "the file's own preamble", part.source, conflicts);
    for (const block of read.blocks) {
      const held = blockIn(blocks, { ...block, entries: [] });
      addEntries(held.entries, block.entries, block.header, part.source, conflicts);
    }
  }
  for (const c of conflicts) c.path = configPath || null;

  const out = format.render(preamble, blocks, root);
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return { body: out.join("\n") + "\n", conflicts };
}

module.exports = { mergeable, merge, MERGEABLE };
