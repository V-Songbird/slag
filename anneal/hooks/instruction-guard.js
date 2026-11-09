#!/usr/bin/env node
"use strict";

// Refuses a file-tool write that would put characters invisible on screen into a
// file agents load as instructions. Such text can carry an order an agent
// follows and nobody reviewing the file can read. The characters are the ones
// the audit's `instruction-hidden-characters` finding reports, with the same
// exemptions for emoji, keycaps, subdivision flags and Mongolian letters; the
// files are the ones that finding reads. The denial names the file and each
// code point, and counts tags, never decoding them. A write through a shell
// command is not seen; the audit still reports what lands.

const fs = require("node:fs");
const path = require("node:path");
const { HIDDEN_CHARACTERS } = require("../scripts/audit.js");

// The audit's rule: a map file by name at any depth, or Markdown under an
// instruction folder at the repository root.
const MAP_NAMES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"];
const INSTRUCTION_DIRS = [".agents/", ".claude/", ".cursor/rules/", ".gemini/"];
const PATCH_HEADER = /^\*\*\*\s+(?:(?:Add|Update)\s+File|Move to):\s*(.+?)\s*$/;
const ANTIGRAVITY_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content"]);
const PATH_ARGS = new Set(["TargetFile", "AbsolutePath"]);

const withoutBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const strings = (value) => (typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : []);

// [file, text] for each file one call writes, with the text it adds. A whole-file
// write drops a leading byte order mark, as the audit does.
function writes(host, data) {
  if (host === "antigravity") {
    const call = data.toolCall || {};
    const args = call.args || {};
    if (!ANTIGRAVITY_TOOLS.has(call.name)) return [];
    const text = Object.entries(args).filter(([key]) => !PATH_ARGS.has(key)).flatMap(([, value]) => strings(value)).join("\n");
    return [[args.AbsolutePath ?? args.TargetFile, call.name === "write_to_file" ? withoutBom(text) : text]];
  }
  const input = data.tool_input || {};
  if (data.tool_name === "Write") return [[input.file_path, withoutBom(String(input.content ?? ""))]];
  if (data.tool_name === "Edit") return [[input.file_path, String(input.new_string ?? "")]];
  if (data.tool_name === "MultiEdit") {
    return [[input.file_path, (Array.isArray(input.edits) ? input.edits : []).map((edit) => String(edit?.new_string ?? "")).join("\n")]];
  }
  if (data.tool_name !== "apply_patch" || typeof input.command !== "string") return [];
  const out = [];
  for (const line of input.command.split("\n").map((each) => each.replace(/\r$/, ""))) {
    const header = PATCH_HEADER.exec(line);
    if (header) out.push([header[1], ""]);
    else if (out.length && line.startsWith("+")) out.at(-1)[1] += `${line.slice(1)}\n`;
  }
  return out;
}

function cwdOf(host, data) {
  if (host !== "antigravity") return data.cwd || process.cwd();
  return Array.isArray(data.workspacePaths) && data.workspacePaths[0] ? data.workspacePaths[0] : process.cwd();
}

// The path under the nearest repository root that holds the file, or under the
// working folder when no root is found; null outside both.
function relative(file, cwd) {
  const absolute = path.resolve(cwd, file);
  let dir = path.dirname(absolute);
  while (!fs.existsSync(path.join(dir, ".git")) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const root = fs.existsSync(path.join(dir, ".git")) ? dir : path.resolve(cwd);
  const rel = path.relative(root, absolute);
  return !rel || rel.startsWith("..") || path.isAbsolute(rel) ? null : rel.split(path.sep).join("/");
}

function isInstructionFile(file, cwd) {
  if (MAP_NAMES.includes(path.basename(file.replace(/\\/g, "/")))) return true;
  const rel = relative(file, cwd);
  return rel !== null && INSTRUCTION_DIRS.some((dir) => rel.startsWith(dir)) && /\.(md|mdc)$/i.test(rel);
}

// The code points as the audit's evidence names them: each one once, tags only counted.
function describe(codes) {
  const isTag = (code) => code >= 0xe0000 && code <= 0xe007f;
  const tags = codes.filter(isTag).length;
  const named = [...new Set(codes.filter((code) => !isTag(code)))].map((code) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
  return [...named, ...(tags ? [`${tags} Unicode tag character${tags === 1 ? "" : "s"}`] : [])].join(", ");
}

function refusal(host, data) {
  const cwd = cwdOf(host, data);
  for (const [file, text] of writes(host, data)) {
    if (typeof file !== "string" || !file || !isInstructionFile(file, cwd)) continue;
    const codes = [...text.matchAll(HIDDEN_CHARACTERS)].map(([char]) => char.codePointAt(0));
    if (!codes.length) continue;
    const named = relative(file, cwd) ?? file.replace(/\\/g, "/");
    return `anneal refuses this write: ${named} is a file agents load as instructions, and the new text holds characters invisible on screen: ${describe(codes)}. ` +
      "Leave them out, or, if the file is meant to talk about one, write its code point as text, U+ and its hex digits.";
  }
  return null;
}

function decide(host, data) {
  const reason = refusal(host, data);
  if (host === "antigravity") return reason ? { decision: "deny", reason } : { decision: "allow" };
  return reason ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } } : null;
}

function readInput() {
  try {
    const value = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

if (require.main === module) {
  const host = process.argv[2] || process.env.ANNEAL_HOST || "claude";
  try {
    const output = decide(host, readInput());
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    // A guard that crashes must not take the tool call with it.
    if (host === "antigravity") process.stdout.write(JSON.stringify({ decision: "allow" }));
  }
}

module.exports = { decide, isInstructionFile };
