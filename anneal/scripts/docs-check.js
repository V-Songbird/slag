#!/usr/bin/env node
"use strict";

// Checks a project's documentation against the documentation policy, without changing anything.
// High severity: the public/private boundary (ignore rules, tracked private files, public pages
// linking private ones). Medium: size caps and completed task notes. Low: frontmatter, type
// versus folder, related_files and filenames. The ignore probes and the tracked-file check came
// from a user-level gitignore skill's check-ignore.mjs.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// .private/ holds non-document working material and stays ignored in every profile. The four
// documentation directories decide the profile: all ignored, or all versioned as in a private
// repository whose cloud sessions must read them.
const LOCAL_ONLY = ".private";
const PRIVATE_DOCS = ["docs/tasks", "docs/decisions", "docs/knowledge/private", "docs/apis/private"];
const PUBLIC_PATHS = ["docs/README.md", "docs/knowledge/current-contract.md", "docs/apis/current-api.md"];
const PROBE = "docs-check-probe.md";
// At any depth, as the nested `**/docs/tasks/` ignore rules apply.
const LOCAL_PATH = /(^|\/)\.private(\/|$)/;
const PRIVATE_DOC_PATH = /(^|\/)docs\/(tasks|decisions|knowledge\/private|apis\/private)(\/|$)/;
const TASK_NOTE_LIMIT = 20000;
const HISTORY_LIMIT = 50000;
const TYPES = new Set(["task_summary", "adr", "api_spec", "knowledge"]);
// The types a docs/<folder>/ file may declare; a file directly under docs/ has no expectation.
const FOLDER_TYPES = {
  tasks: ["task_summary"],
  decisions: ["adr"],
  knowledge: ["knowledge"],
  apis: ["api_spec", "knowledge"],
};
const EXEMPT = new Set(["readme.md", "agents.md", "claude.md", "skill.md"]);
const SKIP = new Set([".git", "node_modules"]);
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

function ignored(root, file) {
  const result = git(root, ["check-ignore", "--no-index", "-q", "--", file]);
  if (![0, 1].includes(result.status)) throw new Error(result.stderr.trim() || "git check-ignore failed.");
  return result.status === 0;
}

// Ignored by a .gitignore in the working tree, which every clone carries. core.excludesFile and
// .git/info/exclude stay on this machine: Git prints them as an absolute path or under .git/, while
// a .gitignore source is relative to the top level. A negated pattern leaves the path visible. The
// global file is dropped so its rule on a parent directory cannot mask a committed rule.
function committedIgnored(root, file) {
  const result = spawnSync("git", ["-C", root, "-c", "core.excludesFile=", "check-ignore", "--no-index", "-v", "-z", "--stdin"], { encoding: "utf8", input: `${file}\0` });
  if (result.error) throw result.error;
  if (![0, 1].includes(result.status)) throw new Error(result.stderr.trim() || "git check-ignore failed.");
  const [source = "", , pattern = ""] = result.stdout.split("\0");
  return result.status === 0 && !path.isAbsolute(source) && path.posix.basename(source.replace(/\\/g, "/")) === ".gitignore" && !pattern.startsWith("!");
}

// Every Markdown file under a directory named docs, ignored ones included. Dot directories,
// dependencies and ignored directories outside a docs tree, such as build output, are skipped.
function docFiles(root) {
  const listing = git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
  const ignoredDirs = new Set(listing.status === 0 ? listing.stdout.split("\0").filter((p) => p.endsWith("/")) : []);
  const found = [];
  const walk = (dir, inDocs) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const skipped = SKIP.has(entry.name) || entry.name.startsWith(".") || (!inDocs && entry.name !== "docs" && ignoredDirs.has(`${rel}/`));
        if (!skipped) walk(rel, inDocs || entry.name === "docs");
      } else if (inDocs && entry.isFile() && entry.name.toLowerCase().endsWith(".md")) found.push(rel);
    }
  };
  walk("", false);
  return found.sort();
}

// Top-level keys of a YAML frontmatter block, with related_files read as a list.
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!match) return null;
  const fields = {};
  let list = null;
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item && list) {
      list.push(unquote(item[1]));
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, value] = pair;
    list = null;
    if (value === "") fields[key] = list = [];
    else if (value.startsWith("[")) fields[key] = value.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);
    else fields[key] = unquote(value);
  }
  return fields;
}

// Where a related_files entry may point: from the repository root, or, for a plugin's own docs/,
// from the directory that holds that docs/.
function relatedCandidates(file, related) {
  const docsDir = /(?:^|\/)docs\//.exec(file);
  const base = docsDir && docsDir.index > 0 ? file.slice(0, docsDir.index + 1) : "";
  return base ? [related, path.posix.join(base, related)] : [related];
}

const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");

// Link targets outside code, inline and reference-style.
function linkTargets(text) {
  const prose = text.replace(/^(```|~~~)[\s\S]*?^\1/gm, "").replace(/`[^`\n]*`/g, "");
  const targets = [];
  for (const m of prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)) targets.push(m[1]);
  for (const m of prose.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)) targets.push(m[1]);
  return targets;
}

// The repository-relative path a link points to, or null for a URL, an anchor or a path that
// leaves the repository.
function resolveLink(file, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return null;
  let clean = target.replace(/[#?].*$/, "");
  try {
    clean = decodeURIComponent(clean);
  } catch {}
  if (!clean) return null;
  const joined = clean.startsWith("/") ? path.posix.normalize(clean.slice(1)) : path.posix.join(path.posix.dirname(file), clean);
  return joined.startsWith("..") ? null : joined;
}

function check(directory) {
  const root = path.resolve(directory);
  const context = git(root, ["rev-parse", "--show-toplevel"]);
  if (context.status !== 0) throw new Error(context.stderr.trim() || "Target is not a Git working tree.");
  const findings = [];
  const add = (id, severity, file, detail) => findings.push({ id, severity, path: file, detail });

  const privateIgnored = PRIVATE_DOCS.filter((dir) => committedIgnored(root, `${dir}/${PROBE}`));
  const profile = privateIgnored.length === 0 ? "versioned" : "ignored";
  const isPrivate = (file) => LOCAL_PATH.test(file) || (profile === "ignored" && PRIVATE_DOC_PATH.test(file));

  if (!committedIgnored(root, `${LOCAL_ONLY}/${PROBE}`)) add("private-visible", "high", `${LOCAL_ONLY}/`, "not ignored");
  if (profile === "ignored") {
    for (const dir of PRIVATE_DOCS) {
      if (!privateIgnored.includes(dir)) add("private-visible", "high", `${dir}/`, "not ignored while the other private documentation directories are");
    }
  }
  for (const file of PUBLIC_PATHS) {
    if (ignored(root, file)) add("public-ignored", "high", file, "public documentation is ignored");
  }

  const listing = git(root, ["ls-files", "-z"]);
  if (listing.status !== 0) throw new Error(listing.stderr.trim() || "git ls-files failed.");
  const tracked = listing.stdout.split("\0").filter(Boolean);
  for (const file of tracked) {
    if (isPrivate(file)) add("tracked-private", "high", file, "tracked in a private directory");
  }
  for (const file of tracked) {
    if (!file.toLowerCase().endsWith(".md") || isPrivate(file)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const target of linkTargets(text)) {
      const resolved = resolveLink(file, target);
      if (resolved && isPrivate(resolved)) add("public-links-private", "high", file, `links ${target}`);
    }
  }

  const docs = docFiles(root);
  for (const file of docs) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const name = path.posix.basename(file);
    const folder = /(?:^|\/)docs\/([^/]+)\//.exec(file)?.[1];
    const fields = EXEMPT.has(name.toLowerCase()) ? undefined : frontmatter(text);
    const isTask = folder === "tasks" || fields?.type === "task_summary";

    if (isTask && text.length > TASK_NOTE_LIMIT) add("task-note-large", "medium", file, `${text.length} characters, over ${TASK_NOTE_LIMIT}`);
    // History-like: private research and working notes, or a name that says history. A large
    // public reference page is left to the layout audit's large-files finding.
    const historyLike = /(^|\/)docs\/(knowledge|apis)\/private\//.test(file) || /history/i.test(name);
    if (!isTask && historyLike && text.length > HISTORY_LIMIT) add("history-doc-large", "medium", file, `${text.length} characters, over ${HISTORY_LIMIT}; condense it`);
    if (isTask && fields?.status === "completed") add("task-note-completed", "medium", file, "completed; fold its findings and delete it");

    if (fields === undefined) continue;
    if (fields === null) {
      add("frontmatter-missing", "low", file, "no YAML frontmatter");
    } else {
      for (const key of ["type", "summary", "related_files"]) {
        if (fields[key] === undefined) add("frontmatter-field-missing", "low", file, `no ${key}`);
      }
      if (fields.type !== undefined && !TYPES.has(fields.type)) add("frontmatter-type-unknown", "low", file, `type ${fields.type}`);
      if (isTask && !["active", "blocked", "completed"].includes(fields.status)) add("frontmatter-field-missing", "low", file, "no valid status");
      const allowed = FOLDER_TYPES[folder];
      if (allowed && TYPES.has(fields.type) && !allowed.includes(fields.type)) {
        add("type-folder-mismatch", "low", file, `type ${fields.type} in docs/${folder}/`);
      } else if (!allowed && ["task_summary", "adr"].includes(fields.type)) {
        add("type-folder-mismatch", "low", file, `type ${fields.type} outside docs/${fields.type === "adr" ? "decisions" : "tasks"}/`);
      }
      for (const related of Array.isArray(fields.related_files) ? fields.related_files : []) {
        if (/[*?[{]/.test(related)) continue;
        if (!relatedCandidates(file, related).some((p) => fs.existsSync(path.join(root, p)))) add("related-file-missing", "low", file, `related file ${related} does not exist`);
      }
    }
    const stem = name.replace(/\.md$/i, "");
    if (/^\d+$/.test(stem)) add("filename", "low", file, "a bare id; add a slug, as in <id>-<slug>");
    else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(stem)) add("filename", "low", file, "not kebab-case");
    else if (/(^|-)\d{4}-\d{2}-\d{2}(-|$)/.test(stem)) add("filename", "low", file, "a date in a living filename");
  }

  // Code-point order, so the same tree gives the same report under any locale.
  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || byText(a.id, b.id) || byText(a.path, b.path));
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return { root, profile, docs: docs.length, counts, findings };
}

function formatSummary(report) {
  const lines = [
    `profile: ${report.profile === "ignored" ? "private documentation ignored" : "private documentation versioned"}`,
    `documents: ${report.docs}; findings: ${report.counts.high} high, ${report.counts.medium} medium, ${report.counts.low} low`,
  ];
  for (const f of report.findings) lines.push(`${f.severity} ${f.id}: ${f.path} (${f.detail})`);
  return `${lines.join("\n")}\n`;
}

const USAGE = "usage: docs-check.js --root <project-directory> [--json]\n";

// Exit 1 when a high finding exists, 0 otherwise, and 2 for bad arguments or no Git working tree.
function main(argv) {
  const args = argv.slice(2);
  let root;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (args[i] === "--json") json = true;
    else if (args[i] === "--root" && !root && i + 1 < args.length && !args[i + 1].startsWith("--")) root = args[++i];
    else {
      process.stderr.write(USAGE);
      return 2;
    }
  }
  if (!root) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    const report = check(root);
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatSummary(report));
    return report.counts.high ? 1 : 0;
  } catch (error) {
    process.stderr.write(`docs-check.js: ${error.message}\n`);
    return 2;
  }
}

module.exports = { check, committedIgnored, docFiles, formatSummary, frontmatter, linkTargets, main, relatedCandidates };

if (require.main === module) process.exitCode = main(process.argv);
