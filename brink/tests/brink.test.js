'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { autoCompactWindow, scan, currentTokens, decide, nudge, emit } = require('../hooks/brink.js');

let seq = 0;
const made = [];

// A config dir with no settings.json, so a real one on the machine running the
// suite can never leak an auto-compact window into a test.
const emptyConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-cfg-'));

function configDirWith(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brink-cfg-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  return dir;
}

// autoCompactWindow() reads process.env directly; swap it for one call.
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
function writeTranscript(lines) {
  const p = path.join(os.tmpdir(), `brink-test-${process.pid}-${seq++}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  made.push(p);
  return p;
}
function assistant(usage, extra = {}) {
  return { type: 'assistant', message: { usage, content: [{ type: 'text', text: 'ok' }] }, ...extra };
}
test.after(() => {
  for (const p of made) try { fs.unlinkSync(p); } catch { /* gone */ }
});

describe('autoCompactWindow', () => {
  const noEnv = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined, CLAUDE_CONFIG_DIR: emptyConfigDir };

  test('reads the env override', () => {
    assert.strictEqual(
      withEnv({ ...noEnv, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' }, autoCompactWindow),
      500000,
    );
  });

  test('reads autoCompactWindow from the settings file /autocompact writes', () => {
    assert.strictEqual(
      withEnv({ ...noEnv, CLAUDE_CONFIG_DIR: configDirWith({ autoCompactWindow: 300000 }) }, autoCompactWindow),
      300000,
    );
  });

  test('the env override wins over the saved setting', () => {
    assert.strictEqual(
      withEnv(
        { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000', CLAUDE_CONFIG_DIR: configDirWith({ autoCompactWindow: 900000 }) },
        autoCompactWindow,
      ),
      250000,
    );
  });

  test('null when neither is set', () => {
    assert.strictEqual(withEnv(noEnv, autoCompactWindow), null);
  });

  test('ignores values outside the window /autocompact accepts', () => {
    for (const raw of ['99999', '1000001', 'auto', '', '500k']) {
      assert.strictEqual(withEnv({ ...noEnv, CLAUDE_CODE_AUTO_COMPACT_WINDOW: raw }, autoCompactWindow), null, raw);
    }
  });

  test('survives a missing, unreadable, or non-JSON settings file', () => {
    assert.strictEqual(withEnv({ ...noEnv, CLAUDE_CONFIG_DIR: configDirWith('{ not json') }, autoCompactWindow), null);
    assert.strictEqual(withEnv({ ...noEnv, CLAUDE_CONFIG_DIR: configDirWith({ theme: 'dark' }) }, autoCompactWindow), null);
    assert.strictEqual(
      withEnv({ ...noEnv, CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), `brink-no-cfg-${process.pid}`) }, autoCompactWindow),
      null,
    );
  });
});

describe('currentTokens', () => {
  test('sums every numeric *_tokens field of the last main-thread assistant usage', () => {
    const p = writeTranscript([
      { type: 'user', message: { content: 'hi' } },
      assistant({ input_tokens: 10, cache_read_input_tokens: 100000, cache_creation_input_tokens: 5000, output_tokens: 200 }),
    ]);
    assert.strictEqual(currentTokens(p), 105210);
  });

  test('picks the LAST main-thread assistant, not an earlier one', () => {
    const p = writeTranscript([
      assistant({ input_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: 5 }),
      { type: 'user', message: { content: 'more' } },
      assistant({ input_tokens: 2, cache_read_input_tokens: 90000, cache_creation_input_tokens: 0, output_tokens: 8 }),
    ]);
    assert.strictEqual(currentTokens(p), 90010);
  });

  test('ignores sidechain (subagent) usage that follows the main turn', () => {
    const p = writeTranscript([
      assistant({ input_tokens: 5, cache_read_input_tokens: 120000, cache_creation_input_tokens: 0, output_tokens: 10 }),
      assistant({ input_tokens: 999999, cache_read_input_tokens: 999999, output_tokens: 999999 }, { isSidechain: true }),
    ]);
    assert.strictEqual(currentTokens(p), 120015);
  });

  test('skips torn/partial lines and non-numeric usage fields', () => {
    const p = writeTranscript([
      '{ this is not json',
      assistant({ input_tokens: 7, cache_read_input_tokens: 3000, service_tier: 'standard', output_tokens: 3 }),
    ]);
    assert.strictEqual(currentTokens(p), 3010);
  });

  test('null when the path is missing or empty', () => {
    assert.strictEqual(currentTokens(undefined), null);
    assert.strictEqual(currentTokens(path.join(os.tmpdir(), `brink-nope-${process.pid}.jsonl`)), null);
    assert.strictEqual(currentTokens(writeTranscript([{ type: 'user', message: { content: 'no usage here' } }])), null);
  });
});

describe('scan signals', () => {
  test('pulls tokens, recent file basenames (distinct, newest-first, capped), and the task line', () => {
    const p = writeTranscript([
      { type: 'user', message: { content: 'Fix the failing pricing test\nsecond line ignored' } },
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/pricing.js' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'D:\\repo\\src\\pricing.js' } }, // same basename → de-duped
      ] } },
      assistant({ input_tokens: 10, cache_read_input_tokens: 160000, output_tokens: 30 }),
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Write', input: { file_path: '/repo/tests/pricing.test.js' } },
      ] } },
    ]);
    const s = scan(p);
    assert.strictEqual(s.tokens, 160040);
    assert.deepStrictEqual(s.files, ['pricing.test.js', 'pricing.js']);
    assert.strictEqual(s.task, 'Fix the failing pricing test');
  });

  test('caps the file list at three, newest first', () => {
    const p = writeTranscript([
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: 'a.js' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'b.js' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'c.js' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'd.js' } },
      ] } },
      assistant({ input_tokens: 1, cache_read_input_tokens: 5, output_tokens: 1 }),
    ]);
    assert.deepStrictEqual(scan(p).files, ['a.js', 'b.js', 'c.js']);
  });

  test('ignores sidechain file ops and truncates a long task line', () => {
    const long = 'A'.repeat(200);
    const p = writeTranscript([
      { type: 'user', message: { content: long } },
      { type: 'assistant', isSidechain: true, message: { content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: '/sub/agent.js' } },
      ] } },
      assistant({ input_tokens: 1, cache_read_input_tokens: 5, output_tokens: 1 }),
    ]);
    const s = scan(p);
    assert.deepStrictEqual(s.files, []);
    assert.ok(s.task.length <= 80 && s.task.endsWith('…'));
  });

  test('ignores harness-injected (non-human) user turns when choosing the task', () => {
    const p = writeTranscript([
      { type: 'user', message: { content: 'the real task' } },
      { type: 'user', isMeta: true, message: { content: 'scheduled wakeup' } },
      { type: 'user', origin: { kind: 'task' }, message: { content: 'task notification' } },
      assistant({ input_tokens: 1, cache_read_input_tokens: 5, output_tokens: 1 }),
    ]);
    assert.strictEqual(scan(p).task, 'the real task');
  });

  test('empty signals when there is no transcript', () => {
    assert.deepStrictEqual(scan(undefined), { tokens: null, files: [], task: null });
  });
});

describe('decide', () => {
  const T = 200000;
  const R = 160000;
  const P = 75000;

  test('fires when armed and at/above the threshold', () => {
    assert.deepStrictEqual(decide(200000, null, T, R, P), { notify: true, firedAt: 200000, urgent: false });
    assert.deepStrictEqual(decide(230000, null, T, R, P), { notify: true, firedAt: 230000, urgent: false });
  });

  test('keeps offering a held nudge every turn, anchored to the first one', () => {
    assert.deepStrictEqual(decide(240000, 200000, T, R, P), { notify: true, firedAt: 200000, urgent: false });
    assert.deepStrictEqual(decide(274999, 200000, T, R, P), { notify: true, firedAt: 200000, urgent: false });
  });

  test('turns urgent once the window grows a full repeat step past the first nudge', () => {
    assert.deepStrictEqual(decide(275000, 200000, T, R, P), { notify: true, firedAt: 200000, urgent: true });
    assert.deepStrictEqual(decide(350000, 200000, T, R, P), { notify: true, firedAt: 200000, urgent: true });
  });

  test('a custom repeat step moves the urgency line', () => {
    assert.deepStrictEqual(decide(210000, 200000, T, R, 10000), { notify: true, firedAt: 200000, urgent: true });
  });

  test('does not flap between the re-arm band and the threshold', () => {
    // already nudged, drifting down but still above rearm — no re-arm, no nudge.
    assert.deepStrictEqual(decide(170000, 200000, T, R, P), { notify: false, firedAt: 200000, urgent: false });
  });

  test('re-arms only after occupancy drops below the rearm line', () => {
    assert.deepStrictEqual(decide(159999, 200000, T, R, P), { notify: false, firedAt: null, urgent: false });
    // armed again: a fresh climb past the threshold fires from scratch.
    assert.deepStrictEqual(decide(210000, null, T, R, P), { notify: true, firedAt: 210000, urgent: false });
  });

  test('armed but still climbing below the threshold: silent, stays armed', () => {
    assert.deepStrictEqual(decide(190000, null, T, R, P), { notify: false, firedAt: null, urgent: false });
  });

  test('a null/absent reading changes nothing', () => {
    assert.deepStrictEqual(decide(null, 200000, T, R, P), { notify: false, firedAt: 200000, urgent: false });
    assert.deepStrictEqual(decide(null, null, T, R, P), { notify: false, firedAt: null, urgent: false });
  });
});

describe('nudge', () => {
  test('rounds to k tokens and hands over a pasteable /compact instruction', () => {
    const msg = nudge(156789);
    assert.match(msg, /~157k tokens/);
    assert.match(msg, /\/compact /);
    assert.match(msg, /Drop resolved exploration/);
  });

  test('weaves the live task and files into the keep-clause when given', () => {
    const msg = nudge(160000, { task: 'fix the coupon rounding bug', files: ['pricing.js', 'pricing.test.js'] });
    assert.match(msg, /the current task \(fix the coupon rounding bug\)/);
    assert.match(msg, /the files in play \(pricing\.js, pricing\.test\.js\)/);
    assert.match(msg, /verified this session\. Prefer the most recent/); // oxford "and" joins the clause, sentence then continues
  });

  test('keeps what the session already verified, last in the priority list', () => {
    const msg = nudge(160000);
    assert.match(msg, /still open, and the facts already verified this session\./);
  });

  test('falls back to the generic clause with no signals', () => {
    const msg = nudge(160000, { task: null, files: [] });
    assert.match(msg, /Keep, in priority order, the current task and goal,/);
    assert.doesNotMatch(msg, /files in play/);
  });

  test('tells the summary to favour the most recent work', () => {
    assert.match(nudge(210000), /Prefer the most recent work over older history\./);
  });

  test('keeps the conventions compaction would otherwise drop', () => {
    assert.match(nudge(160000), /the project conventions and rules you have been following/);
  });

  test('reports the share of the window when the window is known', () => {
    assert.match(nudge(150000, { window: 200000 }), /~150k tokens, about 75% of this session's window, and filling/);
  });

  test('reports tokens alone when the window is unknown', () => {
    const msg = nudge(150000, { window: null });
    assert.match(msg, /~150k tokens and filling/);
    assert.doesNotMatch(msg, /of this session's window/);
  });
});

describe('emit', () => {
  test('carries the same text on both channels', () => {
    const out = emit('brink: go compact');
    assert.strictEqual(out.systemMessage, 'brink: go compact');
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /^brink: go compact\n\n/);
    assert.match(out.hookSpecificOutput.additionalContext, /verbatim/);
  });

  test('asks the assistant to judge the timing, and to hold the nudge if it is bad', () => {
    const ctx = emit('brink: go compact').hookSpecificOutput.additionalContext;
    assert.match(ctx, /judge the timing first/);
    assert.match(ctx, /Not a clean break: tell the user in one line/);
    assert.match(ctx, /offers it again next turn/);
  });

  test('an urgent nudge drops the timing question', () => {
    const ctx = emit('brink: go compact', { urgent: true }).hookSpecificOutput.additionalContext;
    assert.match(ctx, /whatever the moment/);
    assert.doesNotMatch(ctx, /judge the timing/);
  });

  test('a re-offer skips the direct channel and rides the assistant one alone', () => {
    const out = emit('brink: go compact', { direct: false });
    assert.strictEqual('systemMessage' in out, false);
    assert.match(out.hookSpecificOutput.additionalContext, /^brink: go compact\n\n/);
  });

  test('a re-offer relays the short form, not the full timing walkthrough again', () => {
    const first = emit('brink: go compact').hookSpecificOutput.additionalContext;
    const again = emit('brink: go compact', { direct: false }).hookSpecificOutput.additionalContext;
    assert.match(again, /the same nudge, still pending/);
    assert.match(again, /verbatim/);
    assert.doesNotMatch(again, /mid-edit, mid-test, mid-tool-chain/);
    assert.ok(again.length < first.length / 2, 'the re-offer should cost a fraction of the first');
  });
});

describe('hook process', () => {
  const hook = path.join(__dirname, '..', 'hooks', 'brink.js');

  function run(transcriptPath, env = {}, session = {}) {
    const childEnv = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: session.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'brink-data-')),
      CLAUDE_CONFIG_DIR: emptyConfigDir,
    };
    delete childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW; // never inherit the runner's own window
    Object.assign(childEnv, env);
    const out = execFileSync(process.execPath, [hook], {
      input: JSON.stringify({
        session_id: session.id || `brink-test-${process.pid}-${seq++}`,
        transcript_path: transcriptPath,
      }),
      env: childEnv,
      encoding: 'utf8',
    });
    return out ? JSON.parse(out) : null;
  }

  const at = (n) => writeTranscript([assistant({ input_tokens: 0, cache_read_input_tokens: n, output_tokens: 0 })]);

  test('emits both channels once over the threshold', () => {
    const p = writeTranscript([
      { type: 'user', message: { content: 'chase the flaky test' } },
      assistant({ input_tokens: 10, cache_read_input_tokens: 210000, output_tokens: 30 }),
    ]);
    const out = run(p);
    assert.match(out.systemMessage, /~210k tokens/);
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /chase the flaky test/);
  });

  test('stays silent below the threshold', () => {
    const p = writeTranscript([assistant({ input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 30 })]);
    assert.strictEqual(run(p), null);
  });

  test('re-offers a held nudge on the assistant channel, then escalates a repeat step later', () => {
    const session = { id: `brink-repeat-${process.pid}`, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'brink-data-')) };
    assert.match(run(at(205000), {}, session).systemMessage, /~205k tokens/);
    const held = run(at(270000), {}, session);
    assert.strictEqual('systemMessage' in held, false);
    assert.match(held.hookSpecificOutput.additionalContext, /~270k tokens/);
    // 205k + 75k crossed: back on the direct channel, and no longer optional.
    const urgent = run(at(285000), {}, session);
    assert.match(urgent.systemMessage, /~285k tokens/);
    assert.match(urgent.hookSpecificOutput.additionalContext, /whatever the moment/);
  });

  test('BRINK_REPEAT sets how far a held nudge runs before it turns urgent', () => {
    const session = { id: `brink-repeat-cfg-${process.pid}`, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'brink-data-')) };
    const env = { BRINK_REPEAT: '10000' };
    assert.match(run(at(205000), env, session).systemMessage, /~205k tokens/);
    assert.match(run(at(216000), env, session).systemMessage, /~216k tokens/);
  });

  test('BRINK_DISABLE=1 silences a reading that would otherwise fire', () => {
    const p = writeTranscript([assistant({ input_tokens: 10, cache_read_input_tokens: 400000, output_tokens: 30 })]);
    assert.strictEqual(run(p, { BRINK_DISABLE: '1' }), null);
  });

  test('with no configured window it falls back to the conservative default', () => {
    assert.strictEqual(run(at(159000)), null);
    assert.match(run(at(161000)).systemMessage, /~161k tokens/);
  });

  test('a configured window moves the line to three quarters of it', () => {
    const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' };
    assert.strictEqual(run(at(149000), env), null);
    assert.match(run(at(151000), env).systemMessage, /~151k tokens, about 76% of this session's window/);
  });

  test('a 1M window pushes the line out instead of nagging from one fifth full', () => {
    const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' };
    assert.strictEqual(run(at(400000), env), null);
    assert.match(run(at(760000), env).systemMessage, /about 76% of this session's window/);
  });

  test('urgency lands before the edge on a small window, not past it', () => {
    // 200k window → nudge at 150k, and half the room that is left is 25k, so a
    // flat 75k step (which would sit at 225k, past the window) gets clamped.
    const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' };
    const session = { id: `brink-clamp-${process.pid}`, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'brink-data-')) };
    assert.match(run(at(151000), env, session).systemMessage, /~151k tokens/);
    const held = run(at(170000), env, session);
    assert.strictEqual('systemMessage' in held, false);
    const urgent = run(at(180000), env, session);
    assert.match(urgent.systemMessage, /~180k tokens/);
    assert.match(urgent.hookSpecificOutput.additionalContext, /whatever the moment/);
  });

  test('BRINK_THRESHOLD still wins over a configured window', () => {
    const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', BRINK_THRESHOLD: '120000' };
    assert.match(run(at(125000), env).systemMessage, /~125k tokens/);
  });
});
