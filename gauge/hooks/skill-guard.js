'use strict';
// gauge skill-guard — PreToolUse hook on Write|Edit.
// Blocks the one silent, measured killer of skill triggering: broken SKILL.md
// frontmatter (BOM before ---, missing delimiter, empty description).
// Fires only when the target file is a SKILL.md; exit 2 blocks with a reason.

const fs = require('fs');
const path = require('path');
const { parseFrontmatter, readSafe } = require('./lib/scan.js');

function fail(msg) {
  process.stderr.write(`[gauge] blocked: ${msg}`);
  process.exit(2);
}

function main() {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  const ti = input.tool_input || {};
  const filePath = ti.file_path || '';
  if (path.basename(filePath) !== 'SKILL.md') return;

  if (input.tool_name === 'Write') {
    const fm = parseFrontmatter(ti.content || '');
    if (fm.bom) fail(`SKILL.md content starts with a UTF-8 BOM — the skill listing will show "---" instead of the description. Write it without the BOM.`);
    if (!fm.ok) fail(`SKILL.md frontmatter invalid (${fm.error}). It must start with "---" on line 1 and close with "---".`);
    if (!(fm.fields.description || '').trim()) fail(`SKILL.md frontmatter has no description — the skill will never self-trigger. Add a description before writing.`);
  } else if (input.tool_name === 'Edit') {
    // Editing a file that is already BOM-corrupted: force the root-cause fix first.
    const current = readSafe(filePath);
    if (current && current.charCodeAt(0) === 0xFEFF) {
      fail(`${filePath} starts with a UTF-8 BOM, which breaks its skill listing entry. Remove the BOM (rewrite the file without it) before editing further.`);
    }
    if (typeof ti.new_string === 'string' && ti.new_string.includes('﻿')) {
      fail(`edit would insert a UTF-8 BOM into SKILL.md — remove the \\uFEFF from new_string.`);
    }
  }
}

try { main(); } catch { /* never block on a guard crash */ }
