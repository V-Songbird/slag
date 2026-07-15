'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');

/** Run a hook script from hooks/ with JSON stdin; returns spawnSync result. */
function runHook(name, stdinData, env) {
  return spawnSync('node', [path.join(HOOKS_DIR, name)], {
    input: stdinData === undefined ? undefined : JSON.stringify(stdinData),
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, ...(env || {}) },
  });
}

/** Parse hook stdout as JSON, or null when the hook stayed silent. */
function hookOutput(result) {
  const out = (result.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}

/** Unique session id per test so state files never collide across runs. */
let counter = 0;
function freshSession() {
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `plumb-test-${process.pid}-${unique}-${++counter}`;
}

/**
 * Write a minimal transcript for one turn: a real user prompt, one assistant
 * entry carrying the given tool calls (edits + Bash commands), an optional
 * paired tool_result entry, and an optional closing assistant text message.
 * Returns the .jsonl path.
 *
 *   calls:    [{ name, input }]  e.g. { name: 'Edit', input: { file_path: 'a.js' } }
 *   commands: ['npm test', ...] become Bash tool_use entries with no result
 *             (checkOutcome sees them as 'unknown' — same as today's behavior).
 *             An entry may instead be an object to attach a paired tool_result:
 *             { command, result, is_error }. `name` defaults to 'Bash'; pass
 *             { command, name: 'PowerShell', result } for a PowerShell check.
 *   finalText: the turn's closing assistant message
 *   isSidechain: stamp every entry, marking the file as a subagent's own
 *             transcript rather than a main-thread one — see writeSubagentTurn.
 */
function writeTurn({ uuid = 'turn-1', calls = [], commands = [], finalText = '', isSidechain = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumb-t-'));
  const file = path.join(dir, 't.jsonl');
  const entries = [{ type: 'user', uuid, message: { role: 'user', content: 'please implement the thing' } }];
  const content = [];
  const results = [];
  for (const c of calls) content.push({ type: 'tool_use', name: c.name, input: c.input || {}, id: `tu${content.length}` });
  for (const cmd of commands) {
    const isObj = typeof cmd === 'object' && cmd !== null;
    const command = isObj ? cmd.command : cmd;
    const id = `tu${content.length}`;
    content.push({ type: 'tool_use', name: (isObj && cmd.name) || 'Bash', input: { command }, id });
    if (isObj && Object.prototype.hasOwnProperty.call(cmd, 'result')) {
      const block = { type: 'tool_result', tool_use_id: id, content: cmd.result };
      if (Object.prototype.hasOwnProperty.call(cmd, 'is_error')) block.is_error = cmd.is_error;
      results.push(block);
    }
  }
  if (content.length) entries.push({ type: 'assistant', message: { role: 'assistant', content } });
  if (results.length) entries.push({ type: 'user', message: { role: 'user', content: results } });
  if (finalText) {
    entries.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: finalText }] } });
  }
  const lines = entries.map((e) => JSON.stringify(isSidechain ? { ...e, isSidechain: true } : e));
  fs.writeFileSync(file, lines.map((l) => l + '\n').join(''));
  return file;
}

/**
 * A subagent's OWN transcript (what agent_transcript_path points at). Same
 * shape as writeTurn, except every entry carries isSidechain:true — relative
 * to the root session a subagent's whole run is a sidechain, so there is no
 * isRealUserPrompt boundary in the file and the gate treats the whole thing as
 * one turn. Returns the .jsonl path.
 */
function writeSubagentTurn(opts = {}) {
  return writeTurn({ ...opts, isSidechain: true });
}

/** A fresh temp file path (not yet created) for an isolated observation log. */
function freshLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plumb-log-')), 'obs.jsonl');
}

/**
 * Whether a usable git binary exists. Tests that need a real temp repo skip
 * rather than fake-pass when it doesn't. Probed once per process.
 */
let gitAvailable;
function hasGit() {
  if (gitAvailable === undefined) {
    const r = spawnSync('git', ['--version'], { encoding: 'utf-8' });
    gitAvailable = !r.error && r.status === 0;
  }
  return gitAvailable;
}

module.exports = { runHook, hookOutput, freshSession, writeTurn, writeSubagentTurn, freshLog, hasGit, HOOKS_DIR };
