'use strict';
// gauge audit — the full mechanical measurement pass.
// Run from the project root: node <plugin>/scripts/audit.js [--json]
// Prints a markdown report; --json appends the raw data for programmatic use.
// Zero model tokens are spent measuring; the model only interprets the result.

const os = require('os');
const path = require('path');
const {
  scanAll, scanTranscripts, scanStateFiles, scanVendored, scanMcpAndPlugins, tokens,
} = require('../hooks/lib/scan.js');

const cwd = process.cwd();
const home = os.homedir();
const asJson = process.argv.includes('--json');

const scan = scanAll(cwd, home);
const transcripts = scanTranscripts(cwd, home);
const stateFiles = scanStateFiles(cwd);
const vendored = scanVendored(cwd);
const config = scanMcpAndPlugins(cwd, home);

const k = (n) => `${(n / 1000).toFixed(1)}k`;
const lines = [];
const findings = [];

lines.push(`# gauge audit — ${cwd}`, '');

// --- Measured session-start cost ---
if (transcripts.sessions.length) {
  const costs = transcripts.sessions.map(s => s.startTokens).sort((a, b) => a - b);
  const median = costs[Math.floor(costs.length / 2)];
  lines.push(`**Measured session-start cost** (first request, cache-creation + cache-read, last ${costs.length} sessions): median **${median.toLocaleString()} tokens**, range ${costs[0].toLocaleString()}–${costs[costs.length - 1].toLocaleString()}.`);
} else {
  lines.push(`**Measured session-start cost:** no transcripts found at ${transcripts.dir} — estimates below use chars/4.`);
}
lines.push('', `**Project-controlled always-loaded text:** ${k(scan.alwaysChars)} chars ≈ **${scan.alwaysTokens.toLocaleString()} tokens every session**.`, '');

// --- Broken skills (highest priority: silent failures) ---
if (scan.brokenSkills.length) {
  findings.push('broken-skills');
  lines.push(`## 🔴 Broken skill frontmatter (${scan.brokenSkills.length}) — these skills cannot self-trigger`);
  for (const s of scan.brokenSkills) lines.push(`- \`${s.path}\` — ${s.error}`);
  lines.push('');
}

// --- Always-loaded breakdown ---
lines.push('## Always-loaded breakdown (largest first)');
const rows = [
  ...scan.claudeMd.map(f => ({ label: `${f.path} (${f.why})`, chars: f.chars, kind: 'claudemd' })),
  ...scan.rules.filter(r => !r.scoped).map(r => ({ label: `${r.path} (rule, unscoped)`, chars: r.chars, kind: 'rule' })),
  ...(scan.memory ? [{ label: `${scan.memory.path} (memory index)`, chars: scan.memory.chars, kind: 'memory' }] : []),
  { label: `skill listing lines (${scan.skills.length} skills × description/when_to_use)`, chars: scan.skills.reduce((s, x) => s + x.listingChars, 0), kind: 'skills' },
].sort((a, b) => b.chars - a.chars);
for (const r of rows) lines.push(`- ${k(r.chars)} chars (~${tokens(r.chars)} tok/session) — ${r.label}`);
lines.push('');

const bigRules = scan.rules.filter(r => !r.scoped && r.chars > 5000);
if (bigRules.length) {
  findings.push('big-rules');
  lines.push(`## 🟠 Unscoped rules over 5k chars — candidates for \`paths:\` frontmatter or skill conversion`);
  for (const r of bigRules) lines.push(`- \`${r.path}\`: ${k(r.chars)} chars (~${tokens(r.chars)} tok/session saved if converted)`);
  lines.push('');
}

const scopedRules = scan.rules.filter(r => r.scoped);
if (scopedRules.length) lines.push(`(${scopedRules.length} rule(s) already \`paths:\`-scoped — conditional, not counted.)`, '');

// --- Per-turn hazards ---
if (stateFiles.length) {
  findings.push('state-files');
  lines.push('## 🟠 Large root state files (re-read cost per full read)');
  for (const f of stateFiles) lines.push(`- \`${f.path}\`: ${k(f.chars)} chars ≈ ${tokens(f.chars).toLocaleString()} tokens per read — archive completed entries`);
  lines.push('');
}
if (vendored.length) {
  findings.push('vendored');
  lines.push('## 🟠 Vendored trees visible to unscoped search (ripgrep does NOT skip submodules)');
  for (const v of vendored) lines.push(`- \`${v.path}\`: ${v.capped ? '2000+' : v.files} files${v.note ? ` (${v.note})` : ''} — scope searches by path, or use an index-aware tool`);
  lines.push('');
}

// --- Config surfaces ---
if (config.mcpServers.length || config.enabledPlugins.length) {
  lines.push('## Config surfaces');
  if (config.mcpServers.length) lines.push(`- MCP servers: ${config.mcpServers.join(', ')} — verify schemas stay deferred (\`/context\`)`);
  if (config.enabledPlugins.length) lines.push(`- Enabled plugins: ${config.enabledPlugins.join(', ')} — each adds skill-listing lines every session; prune unused`);
  lines.push('');
}

if (!findings.length) lines.push('✅ No structural findings — always-loaded text is within reason and no broken skills detected.', '');

process.stdout.write(lines.join('\n'));
if (asJson) {
  process.stdout.write('\n---JSON---\n' + JSON.stringify({ scan, transcripts, stateFiles, vendored, config }, null, 1));
}
