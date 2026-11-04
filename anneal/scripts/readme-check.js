#!/usr/bin/env node
"use strict";

// Mechanical checks for a README draft, without changing anything: an unclosed fence, the H1
// count, badges above the description, fences with no language, a `$` prompt in a copyable
// block, whether any block shows a result, leftover placeholders, link text that names no
// destination or repeats its URL, filler words, long sentences and an optional prose budget.
// None of them judge meaning. Ported from a user-level readme skill's check_readme.py.

const fs = require("node:fs");

const MAX_WORDS = 25;
const BUDGET = { minimal: 400, standard: 900, advanced: 1200 };
// The line boundaries of Python's str.splitlines(), which the checks were written against.
const LINE_BREAK = new RegExp(`\\r\\n|[\\n\\v\\f\\r\\x1c-\\x1e\\x85${String.fromCharCode(0x2028, 0x2029)}]`);
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^\s*[`~]{3,}\s*$/;
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "powershell", "ps1"]);
const RESULT_LANGS = new Set(["text", "txt", "console", "output", "json", "yaml", "log"]);
// A comment in a code block that shows what a call returns, such as `// user -> { id: 42 }`.
const RESULT_COMMENT = /^\s*(\/\/|#|--|;)\s*\S.*(->|=>|returns|returned)/;
const VAGUE_LINK = /\[\s*(click here|here|this link|read more|more|link|aqu[ií]|haz clic aqu[ií]|m[aá]s|leer m[aá]s)\s*\]\(/iu;
const URL_LINK = /\[\s*([^\]]+?)\s*\]\(\s*(https?:\/\/[^)\s]+)\s*\)/g;
// Word boundaries over Unicode letters and digits, so `éjust` is not the filler `just`.
const FILLER = /(?<![\p{L}\p{N}_])(simply|just|obviously|easy|easily|powerful|blazing|awesome|it should be noted|we will now|utilize)(?![\p{L}\p{N}_])/giu;

const words = (text) => text.split(/\s+/).filter(Boolean);
const sentences = (text) => text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function splitLines(text) {
  const lines = text.split(LINE_BREAK);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

// Findings as { line, rule, message }, sorted by line, then rule, then message. `tier` adds the
// prose budget check: minimal, standard or advanced.
function checkReadme(text, { tier } = {}) {
  // trim() and \s also cover a byte order mark, so one before the title leaves the H1 intact.
  const lines = splitLines(text);
  const findings = [];
  const flag = (index, rule, message) => findings.push({ line: index + 1, rule, message });

  let open = null;
  const fences = [];
  const prose = [];
  let h1 = 0;
  let firstText = null;
  let firstBadge = null;
  lines.forEach((line, i) => {
    const marker = FENCE_OPEN.exec(line);
    if (marker && !open) {
      open = { start: i, mark: marker[2][0], lang: marker[3].trim() };
      return;
    }
    if (open) {
      if (FENCE_CLOSE.test(line) && line.trim()[0] === open.mark) {
        fences.push({ start: open.start, end: i, lang: open.lang });
        open = null;
      }
      return;
    }
    const stripped = line.trim();
    if (stripped.startsWith("# ")) h1++;
    if (stripped.startsWith("[![") || stripped.startsWith("![")) {
      if (firstBadge === null) firstBadge = i;
      return;
    }
    if (!stripped || stripped.startsWith("#") || stripped.startsWith("|")) return;
    if (firstText === null) firstText = i;
    prose.push([i, stripped]);
  });

  if (open) flag(open.start, "fence-unclosed", "code fence is never closed");
  if (h1 !== 1) flag(0, "h1-count", `expected exactly one H1, found ${h1}`);
  if (firstBadge !== null && firstText !== null && firstBadge < firstText) {
    flag(firstBadge, "badge-first", "badges appear before the description; move them below it");
  }

  const body = ({ start, end }) => lines.slice(start + 1, end);
  for (const fence of fences) {
    if (!fence.lang) flag(fence.start, "fence-lang", "code fence has no language tag");
    if (!SHELL_LANGS.has(fence.lang.toLowerCase())) continue;
    const prompt = body(fence).findIndex((line) => line.trimStart().startsWith("$ "));
    if (prompt >= 0) flag(fence.start + 1 + prompt, "prompt-in-copy-block", "copyable block contains a `$` prompt; use a text block to show responses");
  }
  const shown = fences.some((fence) => RESULT_LANGS.has(fence.lang.toLowerCase()) || body(fence).some((line) => RESULT_COMMENT.test(line)));
  if (fences.length && !shown) {
    flag(fences[0].start, "no-shown-result", "no block anywhere shows what a reader should see; add expected output, or a comment on the call showing the value it returns");
  }

  for (const [i, text] of prose) {
    if (text.includes("{{")) flag(i, "placeholder", "unfilled template placeholder");
    if (VAGUE_LINK.test(text)) flag(i, "link-text", "link text does not name its destination");
    for (const [, label, href] of text.matchAll(URL_LINK)) {
      const naked = href.replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
      if (label.replace(/\/+$/, "").toLowerCase() === naked.toLowerCase()) flag(i, "link-text", "link text repeats the URL; name the destination instead");
    }
    for (const [hit] of text.matchAll(FILLER)) flag(i, "filler", `remove or replace '${hit}'`);
    const long = sentences(text.replace(/`[^`]*`/g, "X")).map((sentence) => words(sentence).length).find((n) => n > MAX_WORDS);
    if (long !== undefined) flag(i, "long-sentence", `${long} words; split it`);
  }

  if (Object.hasOwn(BUDGET, tier ?? "")) {
    const total = prose.reduce((sum, [, text]) => sum + words(text).length, 0);
    if (total > BUDGET[tier]) flag(0, "over-budget", `${total} words of prose against a ${tier} budget of ${BUDGET[tier]}; move a section behind a link`);
  }

  return findings.sort((a, b) => a.line - b.line || compare(a.rule, b.rule) || compare(a.message, b.message));
}

const USAGE = "usage: readme-check.js [--tier minimal|standard|advanced] README.md\n";

// Exit 1 while findings remain, 0 when there are none, and 2 for bad arguments or an unreadable file.
function main(args) {
  let tier;
  let valid = true;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier") {
      tier = (args[++i] ?? "").toLowerCase();
      valid &&= Object.hasOwn(BUDGET, tier);
    } else if (args[i].startsWith("--")) valid = false;
    else files.push(args[i]);
  }
  if (!valid || files.length !== 1) {
    process.stderr.write(USAGE);
    return 2;
  }
  let text;
  try {
    text = fs.readFileSync(files[0], "utf8");
  } catch (error) {
    process.stderr.write(`readme-check: cannot read ${files[0]}: ${error.message}\n`);
    return 2;
  }
  const findings = checkReadme(text, { tier });
  const out = findings.map((f) => `${f.line}:${f.rule}  ${f.message}\n`);
  out.push(`${findings.length} finding${findings.length === 1 ? "" : "s"}\n`);
  process.stdout.write(out.join(""));
  return findings.length ? 1 : 0;
}

module.exports = { checkReadme, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
