'use strict';
// gauge/hooks/lib/scan.js — shared measurement library.
// Everything here is deterministic filesystem inspection: no model tokens spent.
// Grounded against Claude Code 2.1.x loading behavior (see gauge README, "Grounding").

const fs = require('fs');
const path = require('path');
const os = require('os');

const TOKENS_PER_CHAR = 0.25; // heuristic: 1 token ≈ 4 chars
const tokens = (chars) => Math.round(chars * TOKENS_PER_CHAR);

function readSafe(p, maxBytes = 4 * 1024 * 1024) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > maxBytes) return null;
    return fs.readFileSync(p, 'utf8');
  } catch { return null; }
}

function sizeSafe(p) {
  try { const st = fs.statSync(p); return st.isFile() ? st.size : -1; } catch { return -1; }
}

function listDirs(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}

function listFiles(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name); }
  catch { return []; }
}

// Parse SKILL.md / rule frontmatter. Deliberately simple (key: value lines only) —
// its job is linting the fields Claude Code's listing depends on, not full YAML.
function parseFrontmatter(content) {
  const out = { ok: false, bom: false, fields: {}, error: null };
  if (content == null) { out.error = 'unreadable'; return out; }
  if (content.charCodeAt(0) === 0xFEFF) {
    out.bom = true;
    out.error = 'BOM (U+FEFF) before frontmatter — description renders as "---" in the skill listing';
    return out; // measured: BOM breaks the parse entirely, so stop here like the real parser does
  }
  if (!/^---\r?\n/.test(content)) { out.error = 'no frontmatter delimiter on line 1'; return out; }
  const end = content.slice(4).search(/^---\s*$/m);
  if (end === -1) { out.error = 'unterminated frontmatter'; return out; }
  const block = content.slice(4, 4 + end);
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m) out.fields[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  out.ok = true;
  return out;
}

// Claude Code's project-dir munging for ~/.claude/projects/<name>.
function mungeProjectDir(cwd) {
  return cwd.replace(/[\\/:. ]/g, '-');
}

// --- Always-loaded inventory ---------------------------------------------

function scanClaudeMdChain(cwd, home) {
  const files = [];
  const seen = new Set();
  const add = (p, why) => {
    const size = sizeSafe(p);
    if (size >= 0 && !seen.has(p)) { seen.add(p); files.push({ path: p, chars: size, why }); }
  };
  add(path.join(home, '.claude', 'CLAUDE.md'), 'user global');
  let dir = cwd;
  for (;;) {
    add(path.join(dir, 'CLAUDE.md'), dir === cwd ? 'project' : 'parent dir');
    add(path.join(dir, 'CLAUDE.local.md'), 'local');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // @imports expand at launch (docs) — one level deep, conservative match.
  for (const f of [...files]) {
    const content = readSafe(f.path);
    if (!content) continue;
    for (const m of content.matchAll(/(?:^|\s)@([\w~][\w./\\-]+)/g)) {
      let target = m[1];
      if (target.startsWith('~')) target = path.join(home, target.slice(1));
      const p = path.isAbsolute(target) ? target : path.resolve(path.dirname(f.path), target);
      add(p, `@import from ${path.basename(f.path)}`);
    }
  }
  return files;
}

function scanRules(cwd) {
  const rulesDir = path.join(cwd, '.claude', 'rules');
  const out = [];
  const walk = (dir) => {
    for (const f of listFiles(dir)) {
      if (!f.endsWith('.md')) continue;
      const p = path.join(dir, f);
      const content = readSafe(p);
      const fm = parseFrontmatter(content || '');
      const scoped = fm.ok && 'paths' in fm.fields;
      out.push({ path: p, chars: content ? content.length : 0, scoped });
    }
    for (const d of listDirs(dir)) walk(path.join(dir, d));
  };
  walk(rulesDir);
  return out;
}

function scanSkills(cwd, home) {
  const roots = [
    { root: path.join(cwd, '.claude', 'skills'), source: 'project' },
    { root: path.join(home, '.claude', 'skills'), source: 'user' },
  ];
  const out = [];
  for (const { root, source } of roots) {
    for (const name of listDirs(root)) {
      const p = path.join(root, name, 'SKILL.md');
      const content = readSafe(p);
      if (content == null) continue;
      const fm = parseFrontmatter(content);
      const desc = (fm.fields.description || '') + (fm.fields.when_to_use || '');
      out.push({
        name, source, path: p,
        bodyChars: content.length,
        listingChars: desc.length, // the always-loaded share
        broken: !fm.ok || !(fm.fields.description || '').trim(),
        error: fm.error || (fm.ok && !(fm.fields.description || '').trim() ? 'empty description' : null),
      });
    }
  }
  return out;
}

function scanMemory(cwd, home) {
  const p = path.join(home, '.claude', 'projects', mungeProjectDir(cwd), 'memory', 'MEMORY.md');
  const size = sizeSafe(p);
  return size >= 0 ? { path: p, chars: size } : null;
}

// --- Session-start cost from transcripts (measured, not estimated) --------

function scanTranscripts(cwd, home, limit = 10) {
  const dir = path.join(home, '.claude', 'projects', mungeProjectDir(cwd));
  let entries;
  try {
    entries = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  } catch { return { sessions: [], dir }; }
  const sessions = [];
  for (const { f } of entries) {
    const p = path.join(dir, f);
    let fd;
    try { fd = fs.openSync(p, 'r'); } catch { continue; }
    try {
      // First "usage" object in the file = the session's first request bill.
      const buf = Buffer.alloc(512 * 1024);
      let text = '', pos = 0;
      while (pos < 8 * 1024 * 1024) {
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        text += buf.toString('utf8', 0, n);
        const m = /"usage":\{[^{}]*"cache_creation_input_tokens":(\d+)[^{}]*"cache_read_input_tokens":(\d+)/.exec(text);
        if (m) {
          sessions.push({ file: f, startTokens: Number(m[1]) + Number(m[2]) });
          break;
        }
        pos += n;
      }
    } finally { fs.closeSync(fd); }
  }
  return { sessions, dir };
}

// --- Per-turn hazards ------------------------------------------------------

function scanStateFiles(cwd, thresholdBytes = 100 * 1024) {
  const out = [];
  for (const f of listFiles(cwd)) {
    if (!/\.(jsonl?|ya?ml|md|txt|csv)$/i.test(f)) continue;
    const size = sizeSafe(path.join(cwd, f));
    if (size >= thresholdBytes) out.push({ path: f, chars: size });
  }
  return out;
}

function countFilesCapped(dir, cap = 2000) {
  let count = 0;
  const stack = [dir];
  while (stack.length && count <= cap) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name === '.git') continue;
      if (e.isDirectory()) stack.push(path.join(d, e.name));
      else if (++count > cap) break;
    }
  }
  return count;
}

function scanVendored(cwd) {
  const out = [];
  const gm = readSafe(path.join(cwd, '.gitmodules'));
  if (gm) {
    for (const m of gm.matchAll(/^\s*path\s*=\s*(.+)$/gm)) {
      const rel = m[1].trim();
      const n = countFilesCapped(path.join(cwd, rel));
      if (n > 0) out.push({ path: rel, files: n, capped: n > 2000 });
    }
  }
  const gitignore = readSafe(path.join(cwd, '.gitignore')) || '';
  if (fs.existsSync(path.join(cwd, 'node_modules')) && !/^\/?node_modules\/?\s*$/m.test(gitignore)) {
    out.push({ path: 'node_modules', files: countFilesCapped(path.join(cwd, 'node_modules')), capped: true, note: 'not gitignored' });
  }
  return out;
}

// --- Config surfaces -------------------------------------------------------

function scanMcpAndPlugins(cwd, home) {
  const result = { mcpServers: [], enabledPlugins: [] };
  const projectMcp = readSafe(path.join(cwd, '.mcp.json'));
  if (projectMcp) {
    try { result.mcpServers.push(...Object.keys(JSON.parse(projectMcp).mcpServers || {})); } catch {}
  }
  const userConfig = readSafe(path.join(home, '.claude.json'), 32 * 1024 * 1024);
  if (userConfig) {
    try {
      const cfg = JSON.parse(userConfig);
      const proj = (cfg.projects || {})[cwd];
      if (proj && proj.mcpServers) result.mcpServers.push(...Object.keys(proj.mcpServers));
    } catch {}
  }
  for (const f of ['settings.json', 'settings.local.json']) {
    const s = readSafe(path.join(cwd, '.claude', f));
    if (!s) continue;
    try {
      const cfg = JSON.parse(s);
      for (const [name, on] of Object.entries(cfg.enabledPlugins || {})) if (on) result.enabledPlugins.push(name);
    } catch {}
  }
  return result;
}

// --- Aggregation -----------------------------------------------------------

function scanAll(cwd, home) {
  home = home || os.homedir();
  const claudeMd = scanClaudeMdChain(cwd, home);
  const rules = scanRules(cwd);
  const skills = scanSkills(cwd, home);
  const memory = scanMemory(cwd, home);
  const alwaysChars =
    claudeMd.reduce((s, f) => s + f.chars, 0) +
    rules.filter(r => !r.scoped).reduce((s, r) => s + r.chars, 0) +
    skills.reduce((s, k) => s + k.listingChars, 0) +
    (memory ? memory.chars : 0);
  return {
    cwd, alwaysChars, alwaysTokens: tokens(alwaysChars),
    claudeMd, rules, skills, memory,
    brokenSkills: skills.filter(s => s.broken),
  };
}

module.exports = {
  tokens, readSafe, parseFrontmatter, mungeProjectDir,
  scanClaudeMdChain, scanRules, scanSkills, scanMemory,
  scanTranscripts, scanStateFiles, scanVendored, scanMcpAndPlugins, scanAll,
};
