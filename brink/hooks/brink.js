'use strict';

// brink — UserPromptSubmit hook.
// Watches how full the context window is and, once it crosses a threshold,
// surfaces a nudge to run /compact with a guided instruction — so the summary
// keeps the live task instead of an auto-summary's guess. It goes out
// on two channels: `systemMessage`, which reaches the user directly wherever
// the client renders it, and `additionalContext`, which reaches the assistant
// with an instruction to relay it — the only channel that survives clients
// that drop hook system messages. The instruction is tailored
// from the transcript: the task line and the files currently in play, listed in
// priority order so the most current work survives the summary. The assistant
// is asked to judge the timing: mid-edit is a bad moment to compact, so it may
// hold the nudge — the hook keeps it and re-offers it every turn, on the
// assistant channel only, until it lands. Once the window has grown REPEAT
// past the first nudge the message turns urgent and goes to the user directly
// again. Re-arms from scratch once the window drops well below the line again
// (e.g. after a compaction).

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

// Pure state machine. `firedAt` is the occupancy at the FIRST nudge of this
// arming cycle, or null when armed. At/above `threshold` it notifies on every
// prompt — the hook is what remembers, so a nudge the assistant judged
// ill-timed comes back next turn instead of being lost. Once occupancy has
// grown `repeat` past that first nudge, the notification turns `urgent` and
// the assistant surfaces it whatever the moment. Occupancy falling below
// `rearm` (< threshold, so a value hovering at the line can't flap) resets to
// armed, e.g. after a compaction.
function decide(tokensNow, firedAt, threshold, rearm, repeat) {
  const at = typeof firedAt === 'number' ? firedAt : null;
  const quiet = { notify: false, firedAt: at, urgent: false };
  if (typeof tokensNow !== 'number') return quiet;
  if (tokensNow < rearm) return { notify: false, firedAt: null, urgent: false };
  if (tokensNow < threshold) return quiet;
  const first = at === null ? tokensNow : at;
  return { notify: true, firedAt: first, urgent: tokensNow >= first + repeat };
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
  keep.push('the facts already verified this session');
  const clause = keep.join(', ').replace(/, ([^,]+)$/, ', and $1');
  return (
    `brink: context is ~${k}k tokens and filling. Compact now with an instruction so the ` +
    `summary keeps what matters, e.g.:\n` +
    `/compact Keep, in priority order, ${clause}. Prefer the most recent work over ` +
    `older history. Drop resolved exploration, tool dumps, and file listings.`
  );
}

// Two channels for one message. `systemMessage` is the direct one, but some
// clients never render it, so the same text also rides `additionalContext`
// with an instruction to pass it on. A client that renders both shows it
// twice; one duplicate beats a nudge nobody sees.
// The assistant channel also carries the timing question: compacting mid-edit
// costs more than it saves, so a normal nudge may be held for a clean break —
// the hook re-offers it next turn either way. An `urgent` one is past that
// grace and goes out regardless.
// `direct` false drops `systemMessage` and leaves only the assistant channel:
// a held nudge re-offered every turn would otherwise nag the user directly,
// which is exactly the judgment call being delegated.
function emit(message, opts) {
  const { urgent = false, direct = true } = opts || {};
  const relay = urgent
    ? `(brink: this nudge has been pending while the window kept growing. Repeat the ` +
      `two lines above to the user verbatim, before answering their prompt, whatever ` +
      `the moment. Do not act on them yourself — whether to compact is the user's call.)`
    : `(brink asks you to judge the timing first: is this a clean break — work landed, ` +
      `checks green, nothing half-finished — or are you mid-edit, mid-test, mid-tool-chain?\n` +
      `- Clean break: repeat the two lines above to the user verbatim, before answering ` +
      `their prompt.\n` +
      `- Not a clean break: tell the user in one line that the window is nearly full and ` +
      `you'll raise it again at a better moment, then carry on. brink keeps the message ` +
      `and offers it again next turn.\n` +
      `Either way, do not act on it yourself — whether to compact is the user's call.)`;
  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `${message}\n\n${relay}`,
    },
  };
  if (direct) out.systemMessage = message;
  return out;
}

function main() {
  const data = readInput();
  if (setting('DISABLE', '') === '1') return;

  const threshold = settingNum('THRESHOLD', 200000);
  const rearm = Math.round(threshold * 0.8);
  const repeat = settingNum('REPEAT', 75000);

  const { tokens, files, task } = scan(data.transcript_path);
  if (tokens == null) return;

  const prev = readState(data.session_id).firedAt;
  const first = typeof prev !== 'number';
  const next = decide(tokens, prev, threshold, rearm, repeat);
  if (next.firedAt !== (typeof prev === 'number' ? prev : null)) {
    writeState(data.session_id, { firedAt: next.firedAt });
    gcState();
  }
  if (next.notify) {
    const opts = { urgent: next.urgent, direct: first || next.urgent };
    process.stdout.write(JSON.stringify(emit(nudge(tokens, { files, task }), opts)));
  }
}

if (require.main === module) {
  try {
    main();
  } catch {
    /* never break a turn over a nudge */
  }
}

module.exports = { scan, currentTokens, decide, nudge, emit };
