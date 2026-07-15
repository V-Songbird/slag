'use strict';

// Spec P6 (docs/research/razor-plumb-competitor-intel-2026-07-14.md, Part 6):
// a validation harness can itself be inert. Roadmap 018 audit: stop_gate.test.js
// (base class), phantom_claim.test.js (phantom-claim class), and
// check_outcome.test.js + dispositions.test.js (claimed-over-failure + the
// base class's dormant/armed dispositions) already spawn the REAL stop-gate.js
// as a subprocess for both an armed and a dormant case per class, and already
// assert the observation log's `kind` field and the armed decision — so the
// liveness bar was already met structurally for all three classes before this
// task. The one gap: those armed assertions check `decision` plus a reason
// substring, not the literal stdout bytes, so a wired-but-wrong reason string
// wouldn't necessarily fail them. This file adds one exact full-stdout-JSON
// spawn per class, diffed against the same block-reason function the hook
// itself calls — closing that gap without re-spawning the dormant/log-kind
// coverage that already exists.

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runHook, freshSession, writeTurn, freshLog, hasGit } = require('./helpers');
const { blockReason, phantomBlockReason, checkFailedBlockReason } = require('../hooks/stop-gate');

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('liveness: base class (unverified-completion) — exact armed stdout', () => {
  test('stdout is byte-exact with blockReason([\'src/app.js\'])', () => {
    const input = {
      session_id: freshSession(),
      transcript_path: writeTurn({
        calls: [{ name: 'Edit', input: { file_path: 'src/app.js' } }],
        finalText: 'Done — the fix works.',
      }),
      hook_event_name: 'Stop',
    };
    const r = runHook('stop-gate.js', input, { PLUMB_ARM: '1', PLUMB_LOG: freshLog() });
    assert.strictEqual(r.stdout.trim(), JSON.stringify({ decision: 'block', reason: blockReason(['src/app.js']) }));
  });
});

describe('liveness: phantom-claim — exact armed stdout', () => {
  const skip = hasGit() ? false : 'git binary not available in this environment — cannot build the required clean temp repo, skipping rather than fake-passing';

  test('stdout is byte-exact with phantomBlockReason(claimText)', { skip }, () => {
    const cwd = tmpDir('plumb-live-git-');
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd });
    execFileSync('git', ['config', 'user.name', 'plumb-test'], { cwd });

    const claimText = 'Done — I fixed the auth bug.';
    const input = {
      session_id: freshSession(),
      cwd,
      transcript_path: writeTurn({ calls: [], finalText: claimText }),
      hook_event_name: 'Stop',
    };
    const r = runHook('stop-gate.js', input, { PLUMB_ARM: '1', PLUMB_LOG: freshLog() });
    assert.strictEqual(r.stdout.trim(), JSON.stringify({ decision: 'block', reason: phantomBlockReason(claimText) }));
  });
});

describe('liveness: claimed-over-failure — exact armed stdout', () => {
  test('stdout is byte-exact with checkFailedBlockReason(claimText)', () => {
    const claimText = 'Done — all tests pass now.';
    const input = {
      session_id: freshSession(),
      transcript_path: writeTurn({
        calls: [{ name: 'Edit', input: { file_path: 'src/app.js' } }],
        commands: [{ command: 'npm test', result: '2 failed, 8 passed, 10 total' }],
        finalText: claimText,
      }),
      hook_event_name: 'Stop',
    };
    const r = runHook('stop-gate.js', input, { PLUMB_ARM: '1', PLUMB_LOG: freshLog() });
    assert.strictEqual(r.stdout.trim(), JSON.stringify({ decision: 'block', reason: checkFailedBlockReason(claimText) }));
  });
});

describe('liveness: dormant is exact-silent (all three classes, cross-check)', () => {
  // Already covered per-class in stop_gate.test.js / phantom_claim.test.js /
  // check_outcome.test.js via hookOutput(...) === null; this cross-check pins
  // the literal byte value (empty string) rather than the parsed form, since
  // dormant liveness means "prints nothing," not "prints nothing parseable."
  test('base class', () => {
    const input = {
      session_id: freshSession(),
      transcript_path: writeTurn({ calls: [{ name: 'Edit', input: { file_path: 'src/app.js' } }], finalText: 'Done — the fix works.' }),
      hook_event_name: 'Stop',
    };
    assert.strictEqual(runHook('stop-gate.js', input, { PLUMB_LOG: freshLog() }).stdout, '');
  });

  test('phantom-claim', { skip: hasGit() ? false : 'git binary not available' }, () => {
    const cwd = tmpDir('plumb-live-git-dormant-');
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd });
    execFileSync('git', ['config', 'user.name', 'plumb-test'], { cwd });
    const input = {
      session_id: freshSession(),
      cwd,
      transcript_path: writeTurn({ calls: [], finalText: 'Done — I fixed the auth bug.' }),
      hook_event_name: 'Stop',
    };
    assert.strictEqual(runHook('stop-gate.js', input, { PLUMB_LOG: freshLog() }).stdout, '');
  });

  test('claimed-over-failure', () => {
    const input = {
      session_id: freshSession(),
      transcript_path: writeTurn({
        calls: [{ name: 'Edit', input: { file_path: 'src/app.js' } }],
        commands: [{ command: 'npm test', result: '2 failed, 8 passed, 10 total' }],
        finalText: 'Done — all tests pass now.',
      }),
      hook_event_name: 'Stop',
    };
    assert.strictEqual(runHook('stop-gate.js', input, { PLUMB_LOG: freshLog() }).stdout, '');
  });
});
