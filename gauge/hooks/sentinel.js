'use strict';
// gauge sentinel — SessionStart hook (matcher: startup|clear).
// Practices what gauge preaches: prints NOTHING unless something is wrong,
// so its own standing cost is zero on a healthy project.
// One line max, ~200 chars, only when a threshold is crossed.

const fs = require('fs');
const path = require('path');
const { scanAll, tokens, readSafe } = require('./lib/scan.js');

function main() {
  let cwd = process.cwd();
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (input.cwd) cwd = input.cwd;
  } catch { /* stdin optional — fall back to cwd */ }

  let budgetChars = 15000; // default alarm line for project-controlled always-loaded text
  const cfg = readSafe(path.join(cwd, '.claude', 'gauge.json'));
  if (cfg) { try { budgetChars = JSON.parse(cfg).budgetChars ?? budgetChars; } catch {} }
  if (budgetChars <= 0) return; // 0 disables the sentinel

  const scan = scanAll(cwd);
  const problems = [];
  if (scan.brokenSkills.length) {
    problems.push(`${scan.brokenSkills.length} skill(s) with broken frontmatter (${scan.brokenSkills.map(s => s.name).join(', ')})`);
  }
  if (scan.alwaysChars > budgetChars) {
    problems.push(`always-loaded context ≈${Math.round(scan.alwaysChars / 1000)}k chars (~${tokens(scan.alwaysChars)} tokens/session; budget ${Math.round(budgetChars / 1000)}k)`);
  }
  if (problems.length) {
    process.stdout.write(`[gauge] ${problems.join('; ')}. Run /gauge:audit for the fix list.`);
  }
}

try { main(); } catch { /* never break a session over telemetry */ }
