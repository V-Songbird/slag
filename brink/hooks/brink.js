'use strict';

// brink — UserPromptSubmit hook.
// Watches how full the context window is and, once it crosses a threshold,
// surfaces a ONE-TIME nudge (via the hook's `systemMessage`, straight to the
// user) to run /compact with a guided instruction — so the summary keeps the
// live task instead of an auto-summary's guess. The instruction is tailored
// from the transcript: the task line and the files currently in play. Re-arms
// only after the window drops well below the line again (e.g. after a
// compaction), so a long session gets at most one nudge per fill-up.

const fs = require('fs');
const os = require('os');
const path = require('path');

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

// BRINK_* env var wins, then the plugin option the harness exports at enable
// time as CLAUDE_PLUGIN_OPTION_*, then the built-in default.
function setting(name, fallback) {
  for (const raw of [process.env[`BRINK_${name}`], process.env[`CLAUDE_PLUGIN_OPTION_${name}`]]) {
    if (raw !== undefined && raw !== '') return raw;
  }
  return fallback;
}

function settingNum(name, fallback) {
  const n = Number(setting(name, ''));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const TAIL_BYTES = 1024 * 1024;
const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit']);
const MAX_FILES = 3;

function baseName(p) {
  return String(p).replace(/\\/g, '/').split('/').filter(Boolean).pop() || String(p);
}

function firstLine(s, max) {
  const line = s.split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
}

// Read the transcript tail once and pull the three things the nudge needs:
//  - tokens: context occupancy ≈ the most recent main-thread request — the last
//    non-sidechain assistant usage summed across every numeric *_tokens field
//    (uncached input + cache read + cache write + output). null when absent.
//  - files: the most recent distinct file paths the turn touched (Edit/Write/
//    Read/…), basenames only, newest first, capped — the artifacts in play.
//  - task: the last real human prompt's first line, trimmed — the goal anchor.
function scan(transcriptPath) {
  const empty = { tokens: null, files: [], task: null };
  if (!transcriptPath) return empty;
  let lines;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      lines = buf.toString('utf8').split('\n');
      if (start > 0) lines = lines.slice(1); // drop the partial first line
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return empty;
  }

  const entries = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* skip a torn/partial line */
    }
  }

  let tokens = null;
  let task = null;
  const files = [];
  const seen = new Set();

  // One newest→oldest pass: first assistant usage wins for tokens, first human
  // prompt wins for task, file ops accumulate newest-first until capped.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];

    if (e.type === 'assistant' && !e.isSidechain) {
      const content = e.message && e.message.content;
      if (tokens === null) {
        const usage = e.message && e.message.usage;
        if (usage && typeof usage === 'object') {
          let sum = 0;
          for (const k of Object.keys(usage)) {
            if (/_tokens$/.test(k) && typeof usage[k] === 'number') sum += usage[k];
          }
          tokens = sum;
        }
      }
      if (files.length < MAX_FILES && Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === 'tool_use' && FILE_TOOLS.has(b.name)) {
            const fp = b.input && b.input.file_path;
            if (typeof fp === 'string' && fp) {
              const name = baseName(fp);
              if (!seen.has(name)) {
                seen.add(name);
                files.push(name);
              }
            }
          }
        }
      }
    } else if (e.type === 'user' && !e.isSidechain && !e.isMeta && task === null) {
      // Skip harness-injected continuations (non-human origin) and tool results.
      if (!(e.origin && e.origin.kind && e.origin.kind !== 'human')) {
        const c = e.message && e.message.content;
        let text = null;
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result')) {
          text = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ') || null;
        }
        if (text && text.trim()) task = firstLine(text.trim(), 80);
      }
    }
  }

  return { tokens, files: files.slice(0, MAX_FILES), task };
}

// Occupancy alone — kept as a named entry point for callers/tests that only
// need the number.
function currentTokens(transcriptPath) {
  return scan(transcriptPath).tokens;
}

// --- per-session fire-once state (re-arms with hysteresis) ---

function stateDir() {
  const dir = process.env.CLAUDE_PLUGIN_DATA;
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      /* unwritable — fall through to tmpdir */
    }
  }
  return os.tmpdir();
}

function statePath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9-]/g, '_');
  return path.join(stateDir(), `brink-${safe}.json`);
}

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(sessionId, state) {
  const p = statePath(sessionId);
  try {
    // The marker is a non-sensitive flag; the guard that matters is refusing to
    // follow a pre-planted symlink at the marker path.
    try {
      if (fs.lstatSync(p).isSymbolicLink()) return;
    } catch (e) {
      if (e.code !== 'ENOENT') return;
    }
    fs.writeFileSync(p, JSON.stringify(state), { mode: 0o600 });
  } catch {
    /* best effort — a lost flag means at most one extra nudge */
  }
}

// Sessions that crash never revisit their marker; sweep brink markers older
// than a week so a persistent data dir can't accumulate them forever.
function gcState() {
  const dir = stateDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const name of names) {
    if (!/^brink-.*\.json$/.test(name)) continue;
    const f = path.join(dir, name);
    try {
      if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
}

// Pure state machine. Fire once at/above `threshold`; stay silent after; re-arm
// only once occupancy falls below `rearm` (< threshold, so a value hovering at
// the line can't flap the nudge on and off every turn).
function decide(tokensNow, notified, threshold, rearm) {
  if (typeof tokensNow !== 'number') return { notify: false, notified };
  if (tokensNow < rearm) return { notify: false, notified: false };
  if (tokensNow >= threshold && !notified) return { notify: true, notified: true };
  return { notify: false, notified };
}

// Build the suggestion. The keep-clause names the live task and files when the
// transcript gave us any, and degrades to a generic list when it didn't.
function nudge(tokensNow, signals) {
  const k = Math.round(tokensNow / 1000);
  const s = signals || {};
  const keep = [s.task ? `the current task (${s.task})` : 'the current task and goal'];
  if (s.files && s.files.length) keep.push(`the files in play (${s.files.join(', ')})`);
  keep.push('the decisions already made');
  keep.push('the exact errors or test output still open');
  const clause = keep.join(', ').replace(/, ([^,]+)$/, ', and $1');
  return (
    `brink: context is ~${k}k tokens and filling. Compact now with an instruction so the ` +
    `summary keeps what matters, e.g.:\n` +
    `/compact Keep ${clause}. Drop resolved exploration, tool dumps, and file listings.`
  );
}

function main() {
  const data = readInput();
  if (setting('DISABLE', '') === '1') return;

  const threshold = settingNum('THRESHOLD', 150000);
  const rearm = Math.round(threshold * 0.8);

  const { tokens, files, task } = scan(data.transcript_path);
  if (tokens == null) return;

  const prev = !!readState(data.session_id).notified;
  const next = decide(tokens, prev, threshold, rearm);
  if (next.notified !== prev) {
    writeState(data.session_id, { notified: next.notified });
    gcState();
  }
  if (next.notify) process.stdout.write(JSON.stringify({ systemMessage: nudge(tokens, { files, task }) }));
}

if (require.main === module) {
  try {
    main();
  } catch {
    /* never break a turn over a nudge */
  }
}

module.exports = { scan, currentTokens, decide, nudge };
