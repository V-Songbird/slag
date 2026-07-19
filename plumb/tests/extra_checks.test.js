'use strict';

// The escape hatch for runners CHECK_RE doesn't know: the extra_checks
// setting (comma-separated fragments, matched case-insensitively anywhere in
// the command line) and the wave-off learner — a script-like command seen in
// enough waved-off armed blocks becomes a recognized check per project.
// Learning only ever reduces blocking (auto-demote), never adds a block.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runHook, hookOutput, freshSession, writeTurn, freshLog } = require('./helpers');
const { checkMatcherFor, learnableTokens, CHECK_RE } = require('../hooks/stop-gate');

function readLog(log) {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---- unit: checkMatcherFor ----

describe('unit: checkMatcherFor', () => {
  test('with no extras configured, returns CHECK_RE itself', () => {
    assert.strictEqual(checkMatcherFor(undefined), CHECK_RE);
  });

  test('configured fragments match case-insensitively anywhere in the command', () => {
    process.env.PLUMB_EXTRA_CHECKS = './scripts/Verify.sh, invoke ci';
    try {
      const m = checkMatcherFor('/some/project');
      assert.strictEqual(m.test('bash ./scripts/verify.sh --fast'), true);
      assert.strictEqual(m.test('Invoke CI --stage unit'), true);
      assert.strictEqual(m.test('git status'), false);
      assert.strictEqual(m.test('npm test'), true); // CHECK_RE still applies
    } finally {
      delete process.env.PLUMB_EXTRA_CHECKS;
    }
  });
});

// ---- unit: learnableTokens ----

describe('unit: learnableTokens', () => {
  const bash = (command) => ({ name: 'Bash', input: { command } });

  test('learns relative-path scripts and script-extension files only', () => {
    const calls = [bash('./tools/vcheck --all'), bash('runtests.ps1 -Fast'), bash('git status'), bash('ls -la')];
    assert.deepStrictEqual(learnableTokens(calls, CHECK_RE).sort(), ['./tools/vcheck', 'runtests.ps1']);
  });

  test('never learns from a command the matcher already recognizes', () => {
    assert.deepStrictEqual(learnableTokens([bash('./gradlew test')], CHECK_RE), []);
  });

  test('never learns bare words — that would silently kill the gate', () => {
    for (const cmd of ['git commit -m x', 'ls', 'echo done', 'cargo-fmt check']) {
      assert.deepStrictEqual(learnableTokens([bash(cmd)], CHECK_RE), [], cmd);
    }
  });
});

// ---- integration: the extra_checks setting ----

describe('integration: extra_checks setting', () => {
  test('a configured fragment makes an otherwise-unknown runner count as a check', () => {
    const log = freshLog();
    const input = {
      session_id: freshSession(),
      cwd: 'D:/some/project',
      transcript_path: writeTurn({
        calls: [{ name: 'Edit', input: { file_path: 'src/app.kt' } }],
        commands: ['./tools/vcheck --all'],
        finalText: 'Done — the fix works.',
      }),
      hook_event_name: 'Stop',
    };
    const env = { PLUMB_ARM: '1', PLUMB_LOG: log, PLUMB_EXTRA_CHECKS: 'vcheck' };
    assert.strictEqual(hookOutput(runHook('stop-gate.js', input, env)), null);
    const lines = readLog(log);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].kind, 'check-ran');
  });
});

// ---- integration: the wave-off learner, end to end ----

describe('integration: wave-off learner', () => {
  test('two waved-off blocks teach the project runner; the third turn passes', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumb-learn-'));
    const log = path.join(dataDir, 'obs.jsonl');
    const session = freshSession();
    const cwd = 'D:/some/gradle-ish/project';
    const env = { PLUMB_ARM: '1', CLAUDE_PLUGIN_DATA: dataDir, PLUMB_LOG: log };

    const turn = (uuid) => ({
      session_id: session,
      cwd,
      transcript_path: writeTurn({
        uuid,
        calls: [{ name: 'Edit', input: { file_path: 'src/app.kt' } }],
        commands: ['./tools/vcheck --all'],
        finalText: 'Done — the fix works.',
      }),
      hook_event_name: 'Stop',
    });

    // Turn 1: unrecognized runner → armed block; then the post-block Stop
    // (stop_hook_active) ends with still no recognized check → wave-off #1.
    const t1 = turn('learn-turn-1');
    assert.strictEqual(hookOutput(runHook('stop-gate.js', t1, env)).decision, 'block');
    assert.strictEqual(hookOutput(runHook('stop-gate.js', { ...t1, stop_hook_active: true }, env)), null);

    // Turn 2: same again → wave-off #2 crosses the learn threshold.
    const t2 = turn('learn-turn-2');
    assert.strictEqual(hookOutput(runHook('stop-gate.js', t2, env)).decision, 'block');
    assert.strictEqual(hookOutput(runHook('stop-gate.js', { ...t2, stop_hook_active: true }, env)), null);

    const learned = JSON.parse(fs.readFileSync(path.join(dataDir, 'plumb-learned-checks.json'), 'utf-8'));
    assert.deepStrictEqual(learned[cwd]['./tools/vcheck'], ['learn-turn-1', 'learn-turn-2']);

    // Turn 3: the runner is now a recognized check — no block, check-ran.
    const t3 = turn('learn-turn-3');
    assert.strictEqual(hookOutput(runHook('stop-gate.js', t3, env)), null);
    const lines = readLog(log);
    assert.strictEqual(lines[lines.length - 1].kind, 'check-ran');
  });

  test('a block answered by actually running a check learns nothing', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumb-learn-'));
    const session = freshSession();
    const cwd = 'D:/another/project';
    const env = { PLUMB_ARM: '1', CLAUDE_PLUGIN_DATA: dataDir, PLUMB_LOG: path.join(dataDir, 'obs.jsonl') };

    const blocked = {
      session_id: session,
      cwd,
      transcript_path: writeTurn({
        uuid: 'obeyed-turn',
        calls: [{ name: 'Edit', input: { file_path: 'src/app.js' } }],
        commands: ['./tools/vcheck --all'],
        finalText: 'Done — the fix works.',
      }),
      hook_event_name: 'Stop',
    };
    assert.strictEqual(hookOutput(runHook('stop-gate.js', blocked, env)).decision, 'block');

    // The continuation re-ran a REAL check — the block worked.
    const obeyed = {
      ...blocked,
      stop_hook_active: true,
      transcript_path: writeTurn({
        uuid: 'obeyed-turn',
        calls: [{ name: 'Edit', input: { file_path: 'src/app.js' } }],
        commands: ['./tools/vcheck --all', 'npm test'],
        finalText: 'Verified — tests pass.',
      }),
    };
    assert.strictEqual(hookOutput(runHook('stop-gate.js', obeyed, env)), null);
    assert.strictEqual(fs.existsSync(path.join(dataDir, 'plumb-learned-checks.json')), false);
  });
});
