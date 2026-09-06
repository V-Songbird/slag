"use strict";

// Host adoption is separate from the legacy format upgrade. It proposes one
// named, reversible instruction bridge and audits the reusable install without
// requiring (or executing) a check module. Shared verbatim by both plugin builds.
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const jig = require("./jig.js");
const HOSTS = ["codex", "claude"];
const EXCLUDED = new Set([".git", ".hg", ".svn", ".jig", ".codex-test", "node_modules", "vendor", "target", "dist", "build", "out", "bin", "obj", ".venv", "venv", "__pycache__", ".next", ".nuxt", "coverage", ".gradle", "Pods"]);
const MAX_ENTRIES = 100000;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_TARGET_BYTES = 32768;
const CONFIG = ".jig/config.json";
const MANIFEST = ".jig/manifest.json";
const hash = (value) => jig.hashBytes(Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"));
const normalized = (value) => jig.stripBom(String(value)).replace(/\r\n/g, "\n");
function expected(message) { return Object.assign(new Error(message), { expected: true }); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

// Never follow a junction, symlink or parent segment during discovery or at
// apply time. The generic file writer otherwise permits restoring a missing
// file: this review needs exact existence, too.
function safePath(root, rel) {
  if (typeof rel !== "string" || !rel || /[\x00-\x1f\x7f`]/.test(rel) || rel.includes("\\") || path.posix.isAbsolute(rel) ||
      /^[A-Za-z]:/.test(rel) || rel.split("/").some((s) => !s || s === "." || s === "..")) {
    throw expected("migration path is not a repository-relative path: " + JSON.stringify(rel));
  }
  let full = path.resolve(root);
  for (const part of rel.split("/")) {
    full = path.join(full, part);
    let stat;
    try { stat = fs.lstatSync(full); } catch (err) { if (err.code === "ENOENT") continue; throw err; }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw expected("migration refuses symlink, junction or hard link " + rel + "; review the real project file instead. Nothing was written.");
  }
  return full;
}
function read(root, rel) {
  const full = safePath(root, rel);
  let stat;
  try { stat = fs.statSync(full); } catch (err) { if (err.code === "ENOENT") return null; throw err; }
  if (!stat.isFile()) throw expected(rel + " is not a regular file; nothing was written.");
  return fs.readFileSync(full);
}
function json(root, rel) {
  const bytes = read(root, rel);
  if (bytes === null) throw expected("there is no " + rel + "; migrate --host adopts an existing Jig install. Nothing was written.");
  try { return JSON.parse(jig.stripBom(bytes.toString("utf8"))); }
  catch (err) { throw expected(rel + " is not readable JSON: " + err.message); }
}
function targetFor(root, host) {
  if (!HOSTS.includes(host)) throw expected("migrate --host needs codex or claude. Nothing was written.");
  if (host === "claude") return "CLAUDE.md";
  // Empty overrides do not supply instructions in Codex's discovery contract.
  const override = read(root, "AGENTS.override.md");
  return override && normalized(override).trim() ? "AGENTS.override.md" : "AGENTS.md";
}
function markers(host) {
  return { begin: "<!-- jig:host-migration:" + host + ":begin -->", end: "<!-- jig:host-migration:" + host + ":end -->" };
}
function region(text, host) {
  const { begin, end } = markers(host);
  const first = text.indexOf(begin), last = text.indexOf(end);
  if (first < 0 && last < 0) return null;
  if (first < 0 || last < first || text.indexOf(begin, first + begin.length) >= 0 || text.indexOf(end, last + end.length) >= 0) {
    throw expected("the Jig host migration region has malformed or duplicate markers; repair its boundaries before planning. Nothing was written.");
  }
  return { start: first, end: last + end.length, text: text.slice(first, last + end.length) };
}
function withoutBridges(text) {
  for (const host of HOSTS) { const found = region(text, host); if (found) text = text.slice(0, found.start) + text.slice(found.end); }
  return text;
}
function quote(value) { return "`" + value.replace(/`/g, "\\`") + "`"; }

// A deliberately small, rejecting parser. Unknown YAML never becomes an
// unconditional rule. Quoted inline arrays and ordinary YAML sequences cover
// the documented paths forms; the original patterns remain unchanged.
function rulePaths(text) {
  if (!text.startsWith("---\n")) return { paths: null };
  const end = text.indexOf("\n---", 3);
  if (end < 0 || !/^\n---(?:\n|$)/.test(text.slice(end))) return { problem: "unterminated rule frontmatter" };
  const front = text.slice(4, end);
  if (!/^paths\s*:/m.test(front)) {
    if (/\bpaths\b|<<\s*:/.test(front)) return { problem: "unsupported rule scope frontmatter" };
    return { paths: null };
  }
  const lines = front.split("\n");
  const at = lines.findIndex((line) => /^paths\s*:/.test(line));
  if (lines.filter((line) => /^paths\s*:/.test(line)).length !== 1) return { problem: "duplicate paths frontmatter" };
  const value = lines[at].replace(/^paths\s*:\s*/, "").trim();
  const scalar = (s) => {
    s = s.trim();
    if (/^"(?:[^"\\]|\\.)*"$/.test(s)) { try { return JSON.parse(s); } catch { return null; } }
    if (/^'(?:[^']|'')*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
    return /^[A-Za-z0-9_./*?{}!@+()\-]+$/.test(s) ? s : null;
  };
  let values;
  if (value.startsWith("[")) {
    // Tokenize commas outside quotes; a comma inside a quoted brace glob stays.
    if (!value.endsWith("]")) return { problem: "unsupported inline paths list" };
    const parts = value.slice(1, -1).match(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+/g) || [];
    values = parts.map(scalar);
    // Ensure no unmatched punctuation was silently consumed by the tokenizer.
    if (parts.join(",").replace(/\s/g, "") !== value.slice(1, -1).replace(/\s/g, "")) return { problem: "unsupported inline paths list" };
  } else if (!value) {
    values = [];
    for (let i = at + 1; i < lines.length; i++) {
      if (!lines[i].trim() || /^\s*#/.test(lines[i])) continue;
      const match = /^\s*-\s+(.+)$/.exec(lines[i]);
      if (match) values.push(scalar(match[1]));
      else if (/^\S/.test(lines[i])) break;
      else return { problem: "unsupported paths sequence" };
    }
  } else return { problem: "paths must be an explicit list" };
  if (!values.length || values.some((v) => typeof v !== "string" || !v || /[\r\n`]/.test(v))) return { problem: "empty or unsupported paths list" };
  return { paths: values };
}
function discover(root, host) {
  const files = [], links = [], nestedRepositories = [];
  let count = 0;
  function walk(dir, depth) {
    if (dir && fs.existsSync(path.join(root, dir, ".git"))) { nestedRepositories.push(dir); return; }
    if (depth > 48) throw expected("instruction discovery exceeded its depth limit; nothing was written.");
    for (const ent of fs.readdirSync(dir ? path.join(root, dir) : root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++count > MAX_ENTRIES) throw expected("instruction discovery exceeded " + MAX_ENTRIES + " entries; nothing was written.");
      const rel = dir ? dir + "/" + ent.name : ent.name;
      if (EXCLUDED.has(ent.name)) continue;
      if (ent.isSymbolicLink()) {
        // A non-instruction file link cannot contain nested instructions.
        let directory = true;
        try { directory = fs.statSync(path.join(root, rel)).isDirectory(); } catch {}
        const instruction = /(?:^|\/)(?:CLAUDE(?:\.local)?|AGENTS(?:\.override)?)\.md$/.test(rel) || /(?:^|\/)\.claude\/rules\/.*\.md$/.test(rel);
        if (directory || instruction) links.push(rel);
        continue;
      }
      if (ent.isDirectory()) { walk(rel, depth + 1); continue; }
      if (ent.isFile()) files.push(rel);
    }
  }
  walk("", 0);
  const selected = files.filter((rel) => host === "codex"
    ? /(?:^|\/)CLAUDE(?:\.local)?\.md$/.test(rel) || /(?:^|\/)\.claude\/rules\/.*\.md$/.test(rel)
    : /(?:^|\/)AGENTS(?:\.override)?\.md$/.test(rel));
  const rows = [], problems = links.map((rel) => ({ path: rel, why: "symlink or junction not followed; review whether it contains project instructions" }));
  for (const rel of selected) {
    const bytes = read(root, rel);
    if (bytes.length > MAX_SOURCE_BYTES) throw expected(rel + " exceeds the instruction source size limit; nothing was written.");
    const text = withoutBridges(normalized(bytes));
    if (!text.trim()) continue;
    let scope = path.posix.dirname(rel);
    const rule = /^(?:(.*)\/)?\.claude\/rules\//.exec(rel);
    if (rule) scope = rule[1] || ".";
    else if (scope === ".claude" || scope.endsWith("/.claude")) scope = path.posix.dirname(scope);
    if (host === "claude" && path.posix.basename(rel) === "AGENTS.md") {
      const overrideRel = (scope === "." ? "" : scope + "/") + "AGENTS.override.md";
      if (files.includes(overrideRel) && normalized(read(root, overrideRel)).trim()) continue;
    }
    const parsed = rule ? rulePaths(text) : { paths: null };
    if (parsed.problem) problems.push({ path: rel, why: parsed.problem });
    rows.push({ path: rel, scope, paths: parsed.paths || null, hash: hash(bytes), contentHash: hash(text.trim()) });
  }
  rows.sort((a, b) => a.scope.split("/").length - b.scope.split("/").length || a.path.localeCompare(b.path));
  return { instructions: rows, problems, nestedRepositories, excludedDirectories: [...EXCLUDED].sort() };
}
function readInstall(root) {
  const config = json(root, CONFIG), manifest = json(root, MANIFEST);
  if (!object(config) || config.schemaVersion !== jig.SCHEMA_VERSION || !Array.isArray(config.guards)) throw expected("config schema or guards cannot be fully read; upgrade or repair Jig before host migration. Nothing was written.");
  if (!object(manifest) || manifest.schemaVersion !== jig.SCHEMA_VERSION || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw expected("manifest schema or artifacts cannot be fully read; nothing was written.");
  if (config.guards.some((g) => !object(g) || typeof g.id !== "string" || !g.id)) throw expected("config contains an unreadable guard; nothing was written.");
  const journalFile = read(root, ".jig/journal.jsonl");
  const journal = jig.readJournal(root);
  const missingPreimages = [];
  for (const row of journal) {
    if (row.preImage === null || row.preImage === undefined) continue;
    if (!/^[a-f0-9]{64}$/.test(row.preImage)) throw expected("the journal contains an invalid pre-image reference; nothing was written.");
    const bytes = read(root, ".jig/preimages/" + row.preImage);
    if (bytes === null || hash(bytes) !== row.preImage) missingPreimages.push(row.preImage);
  }
  let legacyUpgradeRequired = config.guards.some((g) => object(g) && typeof g.detector === "string");
  const states = manifest.artifacts.map((a) => {
    if (!object(a) || typeof a.path !== "string") throw expected("manifest contains an unreadable artifact; nothing was written.");
    if (a.path === "git:core.hooksPath") return { ...a, state: "not-measured", currentHash: null };
    const bytes = read(root, a.path);
    if (/\.check\.mjs$/.test(a.path) && bytes && /\bexport const selftest\b/.test(bytes.toString("utf8"))) legacyUpgradeRequired = true;
    return { ...a, state: bytes === null ? "missing" : hash(bytes) === a.hash || a.ownership === "schema" ? "active" : "drifted", currentHash: bytes === null ? null : hash(bytes) };
  });
  return { config, manifest, states, legacyUpgradeRequired, history: {
    journal: journalFile === null ? "missing" : "present",
    ledger: read(root, ".jig/ledger.jsonl") === null ? "missing" : "present",
    missingPreimages: [...new Set(missingPreimages)],
    note: "Ignored history and pre-images do not travel with an ordinary clone or worktree. Missing history cannot be reconstructed by migration. Existing history is retained; this plan adds its own journal and pre-image entries only when applied.",
  } };
}
function snapshot(root, host, target, discovery, install) {
  return hash(JSON.stringify({ host, target, discovery,
    config: hash(read(root, CONFIG)),
    manifest: { ...install.manifest, artifacts: install.manifest.artifacts.filter((a) => a.path !== target).sort((a, b) => a.path.localeCompare(b.path)) },
    artifacts: install.states.filter((a) => a.path !== target).sort((a, b) => a.path.localeCompare(b.path)).map((a) => [a.path, a.currentHash]),
  }));
}
function bridgeFor(host, discovery) {
  const { begin, end } = markers(host);
  const lines = [begin,
    "<!-- jig:prose-evidence: existing repository instruction paths, explicitly reviewed for host adoption -->",
    "<!-- jig:host-source-sha256 " + hash(JSON.stringify(discovery.instructions.map(({ hash: rawHash, ...row }) => row))) + " -->",
    "Jig host migration to " + host + ". Before work, read the applicable project instructions below.",
    "Paths are relative to the repository root. Keep each instruction within its stated scope; nested instructions govern only their subtree. Read each file once, ignoring Jig host-migration blocks in referenced files to avoid a bridge cycle. Preserve source rule frontmatter conditions. Resolve referenced governance documents relative to their source file.",
  ];
  for (const row of discovery.instructions) {
    const when = row.scope === "." ? "For this repository" : "Before working under " + quote(row.scope + "/");
    const condition = row.paths ? ", only for files matching " + row.paths.map(quote).join(", ") + " relative to " + quote(row.scope + "/") : "";
    lines.push("- " + when + condition + ": read " + quote(row.path) + ".");
  }
  lines.push("These pointers carry project policy; they do not register hooks or prove enforcement. Use the installed Jig skills for this host. If source and destination policies conflict or require a host-specific command, resolve that with the owner before the affected action.", end);
  return lines.join("\n");
}
function proposedText(current, host, bridge) {
  const text = current === null ? "" : normalized(current);
  const found = region(text, host);
  return found ? text.slice(0, found.start) + bridge + text.slice(found.end)
    : text + (text ? (text.endsWith("\n") ? "\n" : "\n\n") : "") + bridge + "\n";
}
function budgets(content, bridge, host) {
  if (Buffer.byteLength(bridge, "utf8") > jig.PROSE_BUDGET_BYTES) throw expected("host migration exceeds Jig's " + jig.PROSE_BUDGET_BYTES + " byte prose budget; split or consolidate the instruction sources before planning. Nothing was written.");
  if (host === "codex" && Buffer.byteLength(content, "utf8") > MAX_TARGET_BYTES) throw expected("host migration exceeds the 32768 byte Codex instruction budget; nothing was written.");
}
function validateReview(root, review, target) {
  if (!object(review) || review.version !== 1 || !HOSTS.includes(review.host) ||
      !(review.targetHash === null || /^[a-f0-9]{64}$/.test(review.targetHash)) ||
      !/^[a-f0-9]{64}$/.test(review.snapshot) || !/^[a-f0-9]{64}$/.test(review.bridgeHash)) throw expected("invalid host migration review metadata; nothing was written.");
  if (target !== targetFor(root, review.host)) throw expected("the active host instruction target changed since review; re-plan before applying.");
  read(root, target);
  return { version: 1, host: review.host, targetHash: review.targetHash, snapshot: review.snapshot, bridgeHash: review.bridgeHash };
}
function assertReview(root, change) {
  const review = validateReview(root, change.migrationReview, change.path);
  if (change.kind !== "write-side-file" || typeof change.content !== "string") throw expected("host migration must be a reviewed instruction-file change");
  const discovery = discover(root, review.host), install = readInstall(root);
  if (snapshot(root, review.host, change.path, discovery, install) !== review.snapshot) throw expected("host migration sources or install changed since review; re-plan and approve the new change. Nothing was written.");
  const bridge = bridgeFor(review.host, discovery);
  if (hash(bridge) !== review.bridgeHash || !region(change.content, review.host) || region(change.content, review.host).text !== bridge) throw expected("host migration bridge differs from its reviewed sources; re-plan before applying.");
  budgets(change.content, bridge, review.host);
  const current = read(root, change.path);
  const intended = jig.applyStyle(change.content, { eol: change.eol, bom: change.bom });
  if (current !== null && hash(current) === hash(intended)) return;
  if ((current === null ? null : hash(current)) !== review.targetHash) throw expected("host migration target changed or disappeared since review; re-plan before applying. Nothing was written.");
  if (proposedText(current, review.host, bridge) !== change.content) throw expected("host migration may only replace its own region and preserve owner instructions. Nothing was written.");
}
function wiring(root) {
  const git = (args) => {
    const result = cp.spawnSync("git", ["-c", "safe.directory=" + path.resolve(root).replace(/\\/g, "/"), ...args], { cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))) });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const hooksPath = git(["config", "--get", "core.hooksPath"]);
  const hook = git(["rev-parse", "--git-path", "hooks/pre-commit"]);
  let hookPresent = false;
  if (hook) { try { hookPresent = fs.statSync(path.resolve(root, hook)).isFile(); } catch {} }
  return { coreHooksPath: hooksPath, preCommitPath: hook, preCommitPresent: hookPresent,
    driverPresent: read(root, ".jig/checks/run.mjs") !== null,
    verifyPresent: read(root, ".jig/verify.json") !== null,
    verified: false,
    note: "File and Git configuration presence is inventory, not an execution witness. Validate the driver, staged commit lane, configured tools, and CI in this checkout. Hook wiring and Node on PATH may differ on another machine.",
  };
}
function cmdMigrateHost(root, opts) {
  const host = opts && opts.host;
  const target = targetFor(root, host);
  if (opts["accept-drops"]) throw expected("--accept-drops belongs to legacy migration; do not combine it with --host. Host migration never drops guards.");
  const install = readInstall(root), discovery = discover(root, host);
  const report = {
    instructions: discovery.instructions, unresolved: discovery.problems, excludedDirectories: discovery.excludedDirectories, nestedRepositories: discovery.nestedRepositories,
    controls: { off: read(root, ".jig/off") !== null, note: "The .jig/off escape hatch, existing guard modes and false-positive history are preserved." },
    drift: install.states.filter((a) => a.state === "drifted" || a.state === "missing").map((a) => ({ path: a.path, state: a.state })),
    guards: install.config.guards.map((g) => ({ id: g.id, mode: g.mode, runner: g.runner, proof: g.proof })),
    legacyUpgradeRequired: install.legacyUpgradeRequired, history: install.history, wiring: wiring(root),
    session: { host, verified: false, required: "Install and enable the destination host's Jig plugin; review/trust its hooks using that host's supported controls. In a disposable copy, witness a real denied tool call and an allowed near miss. Check desktop and CLI separately; runtime selftest alone is not a native-host witness." },
    reviewRequired: ["Review source and destination instructions together for contradictions and host-specific command names. A bridge does not translate arbitrary prose, settings, permissions, skills or custom hooks.",
      "Only repository instructions in the reported discovery scope are bridged. User/managed instructions, external imports, Codex fallback filenames, and Claude exclusion settings require separate review. Follow local source references when reviewing governance; their target bytes are not fingerprinted by this plan.",
      "Keep existing checks, guard IDs, modes, proofs, driver, source rules, and historical records. Resolve reported drift separately; migration does not overwrite it.",
      "Missing local history prevents reverting earlier installations; this migration can only journal its own changes."],
  };
  const result = { ok: true, host, target, migrated: [], plan: null, changes: [], report };
  if (install.legacyUpgradeRequired) return { ...result, why: "This install needs the legacy format migration first. Run migrate without --host, review any drops or edit-guard changes, then request host migration again. Nothing was written." };
  if (discovery.problems.length) return { ...result, why: "Instruction discovery has unresolved scopes or links. Review the reported paths before a host migration can be planned. Nothing was written." };
  if (!discovery.instructions.length && !region(normalized(read(root, target) || ""), host)) return { ...result, why: "No source-host project instructions were found in the reported discovery scope. Existing Jig state is reusable; follow the reported verification and history steps. Nothing was written." };
  const current = read(root, target), bridge = bridgeFor(host, discovery), content = proposedText(current, host, bridge);
  budgets(content, bridge, host);
  if (current !== null && normalized(current) === content) return { ...result, why: "The host instruction bridge is current. This does not certify hooks, commit checks, CI, or missing history. Nothing was written." };
  const migrationReview = { version: 1, host, targetHash: current === null ? null : hash(current), snapshot: snapshot(root, host, target, discovery, install), bridgeHash: hash(bridge) };
  const id = "migrate-host-" + host + "-" + hash(JSON.stringify({ content, migrationReview })).slice(0, 16);
  const draft = { changes: [{ id, kind: "write-side-file", path: target, content, migrationReview, classIds: [], ownership: "file", provenance: "elicited", template: { name: "host-migration", version: "1.0.0" },
    rationale: "Make the reviewed " + (host === "codex" ? "Claude" : "Codex") + " project instructions reachable from " + host + " while retaining their source paths and scope; preserve the target's owner text and all existing Jig checks and decisions." }] };
  const { problems, payload } = jig.planFromDraft(draft, root);
  if (problems.length) throw expected("Host migration plan rejected: " + problems.join("; "));
  const planPath = ".jig/plan-" + payload.planId + ".json";
  const full = safePath(root, planPath);
  fs.writeFileSync(full, JSON.stringify(payload, null, 2) + "\n");
  return { ...result, plan: payload.planId, planPath,
    changes: payload.changes.map((c) => ({ id: c.id, path: c.path, content: c.content, rationale: c.rationale, apply: "apply --change " + c.id + " --path " + c.path, revert: "revert --change " + c.id })),
    why: "Host adoption is planned, not applied. Review the complete target text, source paths, drift, and verification gaps; approve this exact change/path pair before applying. Only the review plan was written.",
  };
}
module.exports = { cmdMigrateHost, validateReview, assertReview, discover, rulePaths, targetFor, markers };
