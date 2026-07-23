'use strict';

// brink — UserPromptSubmit hook.
// Watches how full the context window is and, once it crosses a threshold,
// surfaces a ONE-TIME nudge (via the hook's `systemMessage`, straight to the
// user) to run /compact with a guided instruction — so the summary keeps the
// live task instead of an auto-summary's guess. Re-arms only after the window
// drops well below the line again (e.g. after a compaction), so a long session
// gets at most one nudge per fill-up.

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

// Context occupancy ≈ the token count of the most recent main-thread request:
// the last non-sidechain assistant message's usage, summed across every numeric
// *_tokens field (uncached input + cache read + cache write + output). Reads
// only the transcript tail. null when there's no usable usage yet.
function currentTokens(transcriptPath) {
  if (!transcriptPath) return null;
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
    return null;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"usage"') === -1) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // skip a torn/partial line
    }
    if (entry.type !== 'assistant' || entry.isSidechain) continue;
    const usage = entry.message && entry.message.usage;
    if (!usage || typeof usage !== 'object') continue;
    let sum = 0;
    for (const k of Object.keys(usage)) {
      if (/_tokens$/.test(k) && typeof usage[k] === 'number') sum += usage[k];
    }
    return sum;
  }
  return null;
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

function nudge(tokensNow) {
  const k = Math.round(tokensNow / 1000);
  return (
    `brink: context is ~${k}k tokens and filling. Compact now with an instruction so the ` +
    `summary keeps what matters, e.g.:\n` +
    `/compact Keep the current task and goal, the decisions already made, file paths, and the ` +
    `exact errors or test output still in play. Drop resolved exploration, tool dumps, and file listings.`
  );
}

function main() {
  const data = readInput();
  if (setting('DISABLE', '') === '1') return;

  const threshold = settingNum('THRESHOLD', 150000);
  const rearm = Math.round(threshold * 0.8);

  const tokensNow = currentTokens(data.transcript_path);
  if (tokensNow == null) return;

  const prev = !!readState(data.session_id).notified;
  const next = decide(tokensNow, prev, threshold, rearm);
  if (next.notified !== prev) {
    writeState(data.session_id, { notified: next.notified });
    gcState();
  }
  if (next.notify) process.stdout.write(JSON.stringify({ systemMessage: nudge(tokensNow) }));
}

if (require.main === module) {
  try {
    main();
  } catch {
    /* never break a turn over a nudge */
  }
}

module.exports = { currentTokens, decide, nudge };
